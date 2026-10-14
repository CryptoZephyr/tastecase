import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import {
  SCHEMA_VERSION, checksum, canonicalJson, computeDiscoveryFacts, discoveryAttemptId,
  ProjectSchema, CatalogVersionSchema, TaskVersionSchema, MappingConfirmationSchema,
  MintRunnerCredentialResponseSchema, CreateDiscoveryJobRequestSchema, DiscoveryJobSchema,
  ReviewCaseResponseSchema, ReviewCaseListResponseSchema, ReviewDecisionResponseSchema,
  ReviewHistoryResponseSchema, SuiteIdentitySchema, SuiteListResponseSchema, SuiteVersionSchema,
  SuiteVersionListResponseSchema, PublishSuiteResponseSchema, ApiErrorSchema,
  PublicSampleSchema, type ReviewDecisionRequest, type ReviewDecisionResponse, type PublishSuiteRequest, type MappingConfirmation,
} from '@tastecase/contracts';
import { buildServer } from '../server.js';
import { transaction } from '../db.js';
import { readReviewEvidence } from '../review-store.js';
import { assertLocalTestDatabase, runMigrations } from '../migrate.js';

const databaseUrl = process.env.DATABASE_URL;
const v = { schema_version: SCHEMA_VERSION };
const policy = { classification: 'approved_policy' as const, automaticFailure: true as const,
  rules: [{ kind: 'recommend_any' as const, profileId: 'a' as const, entryIds: ['one'] },
    { kind: 'avoid' as const, profileId: 'b' as const, entryIds: ['excluded'] },
    { kind: 'order' as const, profileId: 'a' as const, beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true as const }] };
const decision = (expectedRevision = 0, action: 'accept' | 'reject' | 'defer' = 'accept'): ReviewDecisionRequest =>
  ({ ...v, id: randomUUID(), expectedRevision, action, rationale: 'Explicit synthetic owner review, not an evaluator.' });
function selection(response: ReviewDecisionResponse) {
  assert.ok(response.review.expectationVersion);
  return { caseId: response.head.caseId, expectationVersionId: response.review.expectationVersion.id, expectedReviewRevision: response.review.decision.revision };
}

test('real PostgreSQL Gate 3 owner API: review, immutable suites and recovery', { skip: databaseUrl ? false : 'DATABASE_URL absent: review integration not run' }, async t => {
  if (!databaseUrl) return;
  assertLocalTestDatabase(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  const owners = { a: randomUUID(), b: randomUUID() };
  const auth = { testVerifier: async (token: string) => token === 'synthetic-a' ? owners.a : token === 'synthetic-b' ? owners.b : null };
  const app = buildServer({ pool, auth });
  async function request(method: 'GET' | 'POST', path: string, payload?: unknown, expected = 200, token = 'synthetic-a') {
    const response = await app.inject({ method, url: path, headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload) }) });
    assert.equal(response.statusCode, expected, `${method} ${path}: unexpected status; response deliberately not logged`);
    if (expected >= 400) {
      const failure = ApiErrorSchema.parse(response.json());
      assert.equal(failure.error.code, expected === 409 ? 'conflict' : expected === 404 ? 'not_found' : expected === 401 ? 'unauthorized' : 'invalid_request');
      assert.equal(response.body.includes('PL/pgSQL'), false);
      assert.equal(response.body.includes('SELECT '), false);
    }
    assert.equal(response.headers['cache-control'], 'no-store');
    return response;
  }
  const jobIds: string[] = [];
  const credentialIds: string[] = [];
  try {
    await runMigrations(pool, { databaseUrl, localTestBootstrap: true });
    const project = ProjectSchema.parse((await request('POST', '/projects', { ...v, name: 'Synthetic Gate 3 API owner' }, 201)).json());
    const other = ProjectSchema.parse((await request('POST', '/projects', { ...v, name: 'Synthetic Gate 3 other owner' }, 201, 'synthetic-b')).json());
    const base = `/projects/${project.id}`;
    const runner = MintRunnerCredentialResponseSchema.parse((await request('POST', `${base}/runner-credentials`, { ...v, label: 'Synthetic Gate 3 runner' }, 201)).json());
    credentialIds.push(runner.credential.id);

    async function fixture(projectId = project.id, token = 'synthetic-a', recorded = false) {
      const prefix = `/projects/${projectId}`;
      const catalog = CatalogVersionSchema.parse((await request('POST', `${prefix}/catalogs`, { ...v, id: randomUUID(), label: 'Synthetic review catalog',
        entries: ['one', 'two', 'missing', 'unmapped', 'excluded'].map(id => ({ id, name: `Synthetic ${id}` })) }, 201, token)).json());
      const taskRequest = { ...v, id: randomUUID(), label: 'Synthetic review task', catalogVersionId: catalog.id,
        syntheticBrief: { provenance: 'synthetic' as const, label: 'Fictional lunch', text: 'An explicitly fictional lunch.' }, syntheticInterests: [],
        constraints: { partySize: 2, dietaryRequirements: ['vegetarian'], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: ['excluded'] } };
      const task = TaskVersionSchema.parse((await request('POST', `${prefix}/tasks`, taskRequest, 201, token)).json());
      const mappings: MappingConfirmation[] = [];
      for (const catalogEntryId of ['one', 'two', 'missing']) mappings.push(MappingConfirmationSchema.parse((await request('POST', `${prefix}/mappings`,
        { ...v, id: randomUUID(), catalogVersionId: catalog.id, catalogEntryId, qlooEntityId: randomUUID() }, 201, token)).json()));
      const jobRequest = CreateDiscoveryJobRequestSchema.parse({ ...v, id: randomUUID(), catalogVersionId: catalog.id, taskVersionId: task.id,
        mappingConfirmationIds: mappings.map(row => row.id), eligibleCatalogEntryIds: ['one', 'two', 'missing', 'unmapped'], assistantVersion: 'synthetic-review-v1', repeatCount: 1,
        profiles: ['a', 'b'].map(id => ({ id, label: `Synthetic ${id}`, provenance: 'public_synthetic', anchors: [{ id: randomUUID(), kind: 'film', label: 'Public synthetic concept', confirmedEntityId: randomUUID() }] })) });
      const job = DiscoveryJobSchema.parse((await request('POST', `${prefix}/discovery-jobs`, jobRequest, 201, token)).json());
      jobIds.push(job.id);
      const confirmations = (await pool.query<{ id: string; anchor_id: string }>('SELECT id,anchor_id FROM public.discovery_anchor_confirmations WHERE project_id=$1 AND job_id=$2', [projectId, job.id])).rows;
      const rankIds: [string, string] = [randomUUID(), randomUUID()];
      const ranks = (['a', 'b'] as const).map(profileId => ({ kind: 'rank' as const, profileId, scope: 'full' as const,
        providerStatus: profileId === 'a' ? 'ok' as const : 'partial' as const, requestedEntryIds: ['one', 'two', 'missing'],
        orderedEntryIds: profileId === 'a' ? ['one', 'two'] : ['two', 'one'], missingEntryIds: ['missing'], unmappedEntryIds: ['unmapped'],
        mappingConfirmationIds: mappings.map(row => row.id), anchorConfirmationIds: confirmations.filter(c => jobRequest.profiles.find(p => p.id === profileId)?.anchors.some(a => a.id === c.anchor_id)).map(c => c.id) }));
      const [a, b] = ranks; assert.ok(a && b);
      const facts = computeDiscoveryFacts(job.id, rankIds, a, b); const factId = randomUUID();
      const createdAt = new Date().toISOString();
      for (const [index, source] of [...ranks, facts].entries()) {
        // Test-only simulated persisted execution receipts, never configured as a product sample.
        const attemptId = recorded && index < 2 ? randomUUID() : null;
        if (attemptId) await pool.query(`INSERT INTO public.discovery_provider_attempts(id,project_id,job_id,kind,operation_key,try_number,request_checksum,reserved_lease_id,status,dispatched_at,finished_at,error_code)
          VALUES($1,$2,$3,'qloo',$4,0,$5,$6,'accepted',$7,$7,'private-provider-debug')`,
        [attemptId, projectId, job.id, `Synthetic rank ${index}`, checksum(source), randomUUID(), createdAt]);
        const data = recorded && source.kind === 'rank' ? { ...source, error: { code: 'private-provider-debug', category: 'unavailable', retryable: false } } : source;
        await pool.query('INSERT INTO public.discovery_tool_evidence(id,project_id,job_id,data,checksum,captured_at,attempt_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [rankIds[index] ?? factId, projectId, job.id, JSON.stringify(data), checksum(data), createdAt, attemptId]);
      }
      const briefs = { a: { ...task.syntheticBrief, text: 'Synthetic profile a.' }, b: { ...task.syntheticBrief, text: 'Synthetic profile b.' }, constraints: task.constraints, eligibleCatalogEntryIds: jobRequest.eligibleCatalogEntryIds };
      const targets: { id: string; leaseId: string }[] = [];
      for (const profileId of ['a', 'b'] as const) {
        const targetTask = { ...taskRequest, id: discoveryAttemptId(job.id, `task:${profileId}:full`, 0), syntheticBrief: briefs[profileId] };
        const targetInput = { ...job.input.targetInput, task: { ...targetTask, projectId, checksum: checksum(targetTask), createdAt } };
        const id = discoveryAttemptId(job.id, `target:${profileId}:0:0:full`, 0); const leaseId = randomUUID(); targets.push({ id, leaseId });
        await pool.query('INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)', [targetTask.id, projectId, catalog.id, JSON.stringify(targetTask), checksum(targetTask), createdAt]);
        await pool.query('INSERT INTO public.target_attempts(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, projectId, catalog.id, targetTask.id, JSON.stringify(targetInput), checksum(targetInput), createdAt]);
        await pool.query("INSERT INTO public.discovery_job_targets(attempt_id,project_id,job_id,catalog_version_id,profile_id,round,repeat,variant) VALUES($1,$2,$3,$4,$5,0,0,'full')", [id, projectId, job.id, catalog.id, profileId]);
        // Foreign owner fixtures do not need a runner lease or result.
        if (projectId === project.id) await pool.query("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1", [id, leaseId, runner.credential.id]);
      }
      await pool.query('UPDATE public.discovery_job_state SET target_attempts=2,revision=revision+1 WHERE job_id=$1', [job.id]);
      const targetResult = { ...v, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'one', name: 'Synthetic One' }] }, trace: { completeness: 'partial', events: [] } };
      if (projectId === project.id) await request('POST', `/runner/attempts/${targets[0].id}/results`, { ...v, leaseId: targets[0].leaseId, result: targetResult }, 200, runner.token);
      const contrast = facts.contrasts[0]; assert.ok(contrast);
      const candidate = { contrast, briefs, evidenceIds: [...rankIds, factId], targetAttemptIds: targets.map(row => row.id),
        proposedExpectation: { classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: contrast.id, rationale: 'Synthetic ranking reversal is advisory.' },
        limitations: ['Explicitly synthetic API fixture, not real provider evidence.'] };
      const candidateId = randomUUID();
      await pool.query('INSERT INTO public.discovery_candidates(id,project_id,job_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)', [candidateId, projectId, job.id, JSON.stringify(candidate), checksum(candidate), createdAt]);
      await pool.query("UPDATE public.discovery_job_state SET state='partial',checkpoint=6,checkpoint_data=$2,revision=revision+1,reason='Synthetic missing result.' WHERE job_id=$1", [job.id, JSON.stringify({ evidenceIds: [...rankIds, factId], candidateIds: [candidateId] })]);
      const caseRequest = { ...v, id: randomUUID(), jobId: job.id, candidateId };
      const before = (await pool.query('SELECT row_to_json(s) AS state FROM public.discovery_job_state s WHERE job_id=$1', [job.id])).rows[0].state;
      const reviewCase = ReviewCaseResponseSchema.parse((await request('POST', `${prefix}/cases`, caseRequest, 201, token)).json());
      assert.deepEqual((await pool.query('SELECT row_to_json(s) AS state FROM public.discovery_job_state s WHERE job_id=$1', [job.id])).rows[0].state, before);
      return { caseRequest, reviewCase, job, candidate, targets, targetResult };
    }
    const first = await fixture(); const sibling = await fixture(); const unreviewed = await fixture(); const foreign = await fixture(other.id, 'synthetic-b');
    const suiteRequest = { ...v, id: randomUUID(), name: 'Synthetic immutable suite' };
    const suite = SuiteIdentitySchema.parse((await request('POST', `${base}/suites`, suiteRequest, 201)).json());
    const cases = `${base}/cases`; const suites = `${base}/suites`; const reviews = `${cases}/${first.reviewCase.case.id}/reviews`; const versions = `${suites}/${suite.id}/versions`;
    const acceptRequest = decision();
    let accepted: ReviewDecisionResponse; let siblingAccepted: ReviewDecisionResponse; let edited: ReviewDecisionResponse;
    let snapshot: ReturnType<typeof SuiteVersionSchema.parse>; let publication: PublishSuiteRequest;
    const review = async (body: ReviewDecisionRequest, caseId = first.reviewCase.case.id) => ReviewDecisionResponseSchema.parse((await request('POST', `${cases}/${caseId}/reviews`, body, 201)).json());
    const publish = async (body: PublishSuiteRequest) => PublishSuiteResponseSchema.parse((await request('POST', versions, body, 201)).json());
    const caseRead = async () => ReviewCaseResponseSchema.parse((await request('GET', `${cases}/${first.reviewCase.case.id}`)).json());

    await t.test('owner and runner isolation on every review/suite read and mutation', async () => {
      const reads = [cases, `${cases}/${first.reviewCase.case.id}`, reviews, suites, `${suites}/${suite.id}`, versions, `${versions}/${randomUUID()}`];
      const writes = [
        [cases, first.caseRequest], [reviews, decision()], [suites, suiteRequest],
        [versions, { ...v, id: randomUUID(), suiteId: suite.id, expectedVersion: 0, cases: [{ caseId: first.reviewCase.case.id, expectationVersionId: randomUUID(), expectedReviewRevision: 1 }] }],
      ] as const;
      for (const path of reads) {
        await request('GET', path, undefined, 404, 'synthetic-b');
        await request('GET', path, undefined, 401, runner.token);
        await request('GET', path, undefined, 401, 'unverified');
      }
      for (const [path, body] of writes) {
        await request('POST', path, body, 404, 'synthetic-b');
        await request('POST', path, body, 401, runner.token);
        await request('POST', path, body, 401, 'unverified');
      }
      await request('GET', `/runner/cases/${first.reviewCase.case.id}`, undefined, 404, runner.token);
      await request('POST', '/runner/reviews', decision(), 404, runner.token);
      await request('GET', `${cases}/${foreign.reviewCase.case.id}`, undefined, 404);
      await request('GET', `${cases}/${randomUUID()}`, undefined, 404);
      await request('POST', `${cases}/${randomUUID()}/reviews`, decision(), 404);
      await request('GET', `${cases}/${randomUUID()}/reviews`, undefined, 404);
      await request('GET', `${suites}/${randomUUID()}`, undefined, 404);
      await request('GET', `${suites}/${randomUUID()}/versions`, undefined, 404);
      const noAuth = await app.inject({ method: 'POST', url: reviews, payload: decision() }); assert.equal(noAuth.statusCode, 401);
      const lowerCaseBearer = await app.inject({ method: 'POST', url: reviews, headers: { authorization: `bearer ${runner.token}` }, payload: decision() });
      assert.equal(lowerCaseBearer.statusCode, 401);
    });
    await t.test('case idempotence, immutable candidate identity and no discovery mutation', async () => {
      assert.deepEqual(ReviewCaseResponseSchema.parse((await request('POST', cases, first.caseRequest, 201)).json()), first.reviewCase);
      await request('POST', cases, { ...first.caseRequest, id: randomUUID() }, 409);
      await request('POST', cases, { ...sibling.caseRequest, id: first.caseRequest.id }, 409);
      await request('POST', cases, { ...first.caseRequest, jobId: sibling.job.id }, 404);
      await request('POST', cases, { ...first.caseRequest, candidateId: foreign.caseRequest.candidateId }, 404);
      for (const injection of [{ candidateChecksum: checksum(first.candidate) }, { ownerId: owners.a }, { evidence: {} }, { projectId: project.id }]) await request('POST', cases, { ...first.caseRequest, ...injection }, 400);
      assert.deepEqual(SuiteIdentitySchema.parse((await request('POST', suites, suiteRequest, 201)).json()), suite);
      await request('POST', suites, { ...suiteRequest, name: 'Different identity' }, 409);
      const live = await transaction(pool, client => readReviewEvidence(client, project.id, first.caseRequest.id), undefined, true);
      assert.equal(live.coverage.completedFullAttempts, 1); assert.deepEqual(live.coverage.unfinishedAttemptIds, [first.targets[1].id]);
      assert.deepEqual(live.coverage.partialTraceAttemptIds, [first.targets[0].id]);
      const invalidCandidateId = randomUUID();
      const invalidCandidate = { ...first.candidate, limitations: ['Intentionally invalid checksum API rejection fixture.'] };
      await pool.query('INSERT INTO public.discovery_candidates(id,project_id,job_id,content,checksum) VALUES($1,$2,$3,$4,$5)',
        [invalidCandidateId, project.id, first.job.id, JSON.stringify(invalidCandidate), '0'.repeat(64)]);
      await request('POST', cases, { ...first.caseRequest, id: randomUUID(), candidateId: invalidCandidateId }, 409);
    });
    await t.test('strict rationale, classes, allowlisted rules, scoped IDs and unforgeable evidence', async () => {
      for (const body of [{ ...decision(), rationale: '' }, { ...decision(), rationale: '   ' }, { ...decision(), rationale: 'x'.repeat(2001) },
        { ...decision(), expectedRevision: -1 }, { ...decision(), expectedRevision: 0.5 }, { ...decision(), action: 'edit' },
        { ...decision(), expectation: policy }, { ...decision(), checksum: '0'.repeat(64) }, { ...decision(), reviewedBy: owners.b }, { ...decision(), evidence: {} },
        { ...decision(), action: 'edit', expectation: { classification: 'unavailable', automaticFailure: false, reason: 'No evidence' } },
        { ...decision(), action: 'edit', expectation: { ...policy, rules: [{ kind: 'expression', code: 'return true' }] } },
        { ...decision(), action: 'edit', expectation: { ...policy, rules: [{ kind: 'recommend_any', profileId: 'c', entryIds: ['one'] }] } },
        { ...decision(), action: 'edit', expectation: { ...policy, rules: [{ kind: 'recommend_any', profileId: 'a', entryIds: ['outside'] }] } },
        { ...decision(), action: 'edit', expectation: { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'allowed_ids', entryIds: ['one'] }] } },
        { ...decision(), action: 'edit', expectation: { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'exclusions', entryIds: ['one'] }] } },
        { ...decision(), action: 'edit', expectation: { ...first.candidate.proposedExpectation, contrastId: randomUUID() } }]) await request('POST', reviews, body, 400);
      const oversized = await app.inject({ method: 'POST', url: reviews, headers: { authorization: 'Bearer synthetic-a', 'content-type': 'application/json' }, payload: ' '.repeat(65537) });
      assert.equal(oversized.statusCode, 413);
      await request('POST', reviews, ' '.repeat(65537), 413);
      assert.equal((await caseRead()).head.revision, 0);
    });
    await t.test('public sample is allowlisted, read-only, recorded, sanitized and separate from owner routes', async () => {
      const simulated = await fixture(project.id, 'synthetic-a', true);
      const receipt = ReviewDecisionResponseSchema.parse((await request('POST', `${cases}/${simulated.caseRequest.id}/reviews`, decision(), 201)).json());
      const sampleApp = buildServer({ pool, auth, publicSample: { projectId: project.id, caseId: simulated.caseRequest.id, syntheticInputs: true } });
      const missingApp = buildServer({ pool, auth, publicSample: { projectId: other.id, caseId: simulated.caseRequest.id, syntheticInputs: true } });
      const unrecordedApp = buildServer({ pool, auth, publicSample: { projectId: project.id, caseId: unreviewed.caseRequest.id, syntheticInputs: true } });
      try {
        const before = (await pool.query('SELECT row_to_json(s) AS state FROM public.discovery_job_state s WHERE job_id=$1', [simulated.job.id])).rows[0].state;
        const response = await sampleApp.inject('/public/sample'); assert.equal(response.statusCode, 200);
        const sample = PublicSampleSchema.parse(response.json());
        assert.equal(sample.provenance, 'recorded'); assert.equal(sample.inputs, 'synthetic');
        assert.equal(sample.capturedAt, receipt.review.decision.evidence.capturedAt);
        assert.deepEqual(sample.job.evidence.map(row => row.capturedAt), receipt.review.decision.evidence.evidence.map(row => row.capturedAt));
        assert.equal(sample.caseResponse.case.id, simulated.caseRequest.id);
        assert.equal(sample.caseResponse.candidate.content.proposedExpectation.automaticFailure, false);
        assert.equal(sample.caseResponse.currentReview?.decision.id, receipt.review.decision.id);
        for (const forbidden of ['leaseCredentialId', 'leaseId', 'leaseExpiresAt', 'reservedLeaseId', 'token_hash', runner.token, 'private-provider-debug', owners.a, 'confirmedBy', 'reviewedBy']) assert.equal(response.body.includes(forbidden), false);
        assert.equal(response.headers['cache-control'], 'no-store');
        const repeat = await sampleApp.inject({ url: '/public/sample', headers: { authorization: 'Bearer synthetic-b' } });
        assert.equal(repeat.statusCode, 200); assert.deepEqual(repeat.json(), response.json());
        assert.deepEqual((await pool.query('SELECT row_to_json(s) AS state FROM public.discovery_job_state s WHERE job_id=$1', [simulated.job.id])).rows[0].state, before);
        assert.equal((await sampleApp.inject(`/public/sample?caseId=${foreign.caseRequest.id}`)).statusCode, 400);
        assert.equal((await sampleApp.inject({ method: 'POST', url: '/public/sample', payload: decision() })).statusCode, 404);
        assert.equal((await sampleApp.inject(`${cases}/${simulated.caseRequest.id}`)).statusCode, 401);
        assert.equal((await missingApp.inject('/public/sample')).statusCode, 503);
        assert.equal((await unrecordedApp.inject('/public/sample')).statusCode, 503);
        assert.equal((await app.inject('/public/sample')).statusCode, 503);
      } finally { await sampleApp.close(); await missingApp.close(); await unrecordedApp.close(); }
    });

    await t.test('accept preserves advisory proposal and pins actual partial/missing results without changing discovery', async () => {
      const before = (await pool.query('SELECT row_to_json(s) AS state FROM public.discovery_job_state s WHERE job_id=$1', [first.job.id])).rows[0].state;
      accepted = await review(acceptRequest); siblingAccepted = await review(decision(), sibling.caseRequest.id);
      assert.equal(accepted.idempotent, false); assert.equal(accepted.head.revision, 1);
      assert.deepEqual(accepted.review.expectationVersion?.expectation, first.candidate.proposedExpectation);
      assert.equal(accepted.review.decision.reviewedBy, owners.a);
      const evidence = accepted.review.decision.evidence;
      assert.equal(evidence.coverage.completedFullAttempts, 1); assert.equal(evidence.coverage.capturedFullAttempts, 2);
      assert.equal(evidence.coverage.intendedFullAttempts, 2); assert.deepEqual(evidence.coverage.missingEntryIds, ['missing']);
      assert.deepEqual(evidence.coverage.unmappedEntryIds, ['unmapped']); assert.deepEqual(evidence.coverage.partialTraceAttemptIds, [first.targets[0].id]);
      assert.deepEqual(evidence.coverage.unfinishedAttemptIds, [first.targets[1].id]); assert.equal(evidence.targets[1].attempt.result, null);
      assert.equal(evidence.candidate.checksum, checksum(first.candidate)); assert.equal(evidence.targets[0].attempt.resultChecksum, checksum(first.targetResult));
      assert.equal(evidence.limitations.some(text => text.includes('cannot prove')), true);
      assert.deepEqual((await pool.query('SELECT row_to_json(s) AS state FROM public.discovery_job_state s WHERE job_id=$1', [first.job.id])).rows[0].state, before);
      const current = await caseRead(); assert.deepEqual(current.currentReview, accepted.review);
      assert.deepEqual(current.candidate.content, first.candidate); assert.equal(current.candidate.content.proposedExpectation.humanReviewRequired, true);
      await request('POST', reviews, { ...decision(), expectedRevision: 0 }, 409);
      await request('POST', reviews, { ...acceptRequest, rationale: 'Different immutable request' }, 409);
      await request('POST', `${cases}/${sibling.caseRequest.id}/reviews`, acceptRequest, 409);
    });
    await t.test('whole-list publication eligibility is atomic; multi-case snapshots have original immutable pins', async () => {
      publication = { ...v, id: randomUUID(), suiteId: suite.id, expectedVersion: 0, cases: [selection(accepted), selection(siblingAccepted)] };
      await request('POST', versions, { ...publication, cases: [...publication.cases, { caseId: unreviewed.caseRequest.id, expectationVersionId: randomUUID(), expectedReviewRevision: 1 }] }, 409);
      await request('POST', versions, { ...publication, cases: [...publication.cases, { caseId: foreign.caseRequest.id, expectationVersionId: randomUUID(), expectedReviewRevision: 1 }] }, 404);
      await request('POST', versions, { ...publication, cases: [publication.cases[0], publication.cases[0]] }, 400);
      await request('POST', versions, { ...publication, cases: [] }, 400);
      await request('POST', versions, { ...publication, cases: Array.from({ length: 51 }, () => ({ caseId: randomUUID(), expectationVersionId: randomUUID(), expectedReviewRevision: 1 })) }, 400);
      await request('POST', versions, { ...publication, checksum: '0'.repeat(64) }, 400);
      await request('POST', versions, { ...publication, suiteId: randomUUID() }, 400);
      assert.equal(SuiteIdentitySchema.parse((await request('GET', `${suites}/${suite.id}`)).json()).currentVersion, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.suite_versions WHERE suite_id=$1', [suite.id])).rows[0].n, 0);
      const published = await publish(publication); snapshot = published.suite;
      assert.equal(published.idempotent, false); assert.equal(snapshot.version, 1); assert.equal(snapshot.cases.length, 2);
      assert.deepEqual(snapshot.cases[0].review, accepted.review); assert.deepEqual(snapshot.cases[1].review, siblingAccepted.review);
      assert.deepEqual(SuiteVersionSchema.parse((await request('GET', `${versions}/${snapshot.id}`)).json()), snapshot);
      await request('POST', versions, { ...publication, cases: [selection(siblingAccepted), selection(accepted)] }, 409);
      await request('POST', versions, { ...publication, id: randomUUID() }, 409);
      await request('GET', `${versions}/${randomUUID()}`, undefined, 404);
    });
    await t.test('edit creates immutable objective/policy versions; reject/defer invalidate only current publication eligibility', async () => {
      const objective: ReviewDecisionRequest = { ...v, id: randomUUID(), expectedRevision: 1, action: 'edit', rationale: 'Explicit mechanical output contract.',
        expectation: { classification: 'objective_contract', automaticFailure: true, profiles: ['a', 'b'], rules: [{ kind: 'output_schema' },
          { kind: 'allowed_ids', entryIds: ['one', 'two', 'missing', 'unmapped'] }, { kind: 'exclusions', entryIds: ['excluded'] }] } };
      const mechanical = await review(objective);
      assert.equal(mechanical.review.expectationVersion?.expectation.classification, 'objective_contract');
      assert.notEqual(mechanical.review.expectationVersion?.id, accepted.review.expectationVersion?.id);
      const editRequest: ReviewDecisionRequest = { ...v, id: randomUUID(), expectedRevision: 2, action: 'edit', rationale: 'Human-selected scoped recommendation policy.', expectation: policy };
      edited = await review(editRequest);
      assert.deepEqual(edited.review.expectationVersion?.expectation, policy); assert.equal(edited.head.revision, 3);
      assert.equal((await review(acceptRequest)).idempotent, true);
      assert.deepEqual((await review(acceptRequest)).review, accepted.review);
      assert.deepEqual((await review(objective)).review, mechanical.review);
      await request('POST', versions, { ...publication, id: randomUUID(), expectedVersion: 1 }, 409);
      const reject = await review(decision(3, 'reject')); assert.equal(reject.head.approvedExpectationVersionId, null); assert.equal(reject.review.expectationVersion, null);
      await request('POST', versions, { ...publication, id: randomUUID(), expectedVersion: 1, cases: [selection(edited)] }, 409);
      const defer = await review(decision(4, 'defer')); assert.equal(defer.head.status, 'deferred');
      await request('POST', versions, { ...publication, id: randomUUID(), expectedVersion: 1, cases: [selection(edited)] }, 409);
      edited = await review({ ...editRequest, id: randomUUID(), expectedRevision: 5 });
      assert.equal(edited.head.revision, 6);
      assert.deepEqual((await request('GET', `${versions}/${snapshot.id}`)).json(), snapshot);
      assert.deepEqual((await publish(publication)).suite, snapshot); assert.equal((await publish(publication)).idempotent, true);
      assert.equal(SuiteIdentitySchema.parse((await request('GET', `${suites}/${suite.id}`)).json()).currentVersion, 1);
    });
    await t.test('late runner results and repeated API startups cannot rewrite review history or published checksum', async () => {
      const lateResult = { ...first.targetResult, trace: { completeness: 'unavailable', events: [] } };
      await request('POST', `/runner/attempts/${first.targets[1].id}/results`, { ...v, leaseId: first.targets[1].leaseId, result: lateResult }, 200, runner.token);
      const latest = await review({ ...v, id: randomUUID(), expectedRevision: 6, action: 'edit', rationale: 'Capture later result explicitly in a new version.', expectation: policy }); edited = latest;
      assert.deepEqual(latest.review.decision.evidence.coverage.unavailableTraceAttemptIds, [first.targets[1].id]);
      assert.equal(latest.review.decision.evidence.coverage.completedFullAttempts, 2);
      assert.notEqual(latest.review.decision.evidence.checksum, accepted.review.decision.evidence.checksum);
      const retry = await review(acceptRequest); assert.deepEqual(retry.review, accepted.review); assert.equal(retry.head.revision, 7);
      const history = ReviewHistoryResponseSchema.parse((await request('GET', reviews)).json()); assert.deepEqual(history.reviews.at(-1), accepted.review);
      const secondPublication = { ...publication, id: randomUUID(), expectedVersion: 1, cases: [selection(latest), selection(siblingAccepted)] };
      assert.equal((await publish(secondPublication)).suite.version, 2);
      for (let i = 0; i < 2; i++) {
        const fresh = buildServer({ pool, auth });
        try {
          const origin = await fresh.listen({ host: '127.0.0.1', port: 0 });
          const response = await fetch(`${origin}${versions}/${snapshot.id}`, { headers: { authorization: 'Bearer synthetic-a' } });
          assert.equal(response.status, 200); assert.deepEqual(SuiteVersionSchema.parse(await response.json()), snapshot);
          const replay = await fetch(`${origin}${versions}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-a', 'content-type': 'application/json' }, body: JSON.stringify(publication) });
          assert.equal(replay.status, 201); const receipt = PublishSuiteResponseSchema.parse(await replay.json()); assert.deepEqual(receipt.suite, snapshot); assert.equal(receipt.idempotent, true);
          const read = await fetch(`${origin}${reviews}`, { headers: { authorization: 'Bearer synthetic-a' } }); assert.equal(read.status, 200);
          assert.deepEqual(ReviewHistoryResponseSchema.parse(await read.json()).reviews.at(-1), accepted.review);
        } finally { await fresh.close(); }
      }
      assert.equal(canonicalJson((await publish(publication)).suite), canonicalJson(snapshot));
    });
    await t.test('concurrent review and publication writers conflict visibly without advancing twice', async () => {
      const payloads = [decision(7, 'reject'), decision(7, 'defer')];
      const results = await Promise.all(payloads.map(payload => app.inject({ method: 'POST', url: reviews, headers: { authorization: 'Bearer synthetic-a' }, payload })));
      assert.deepEqual(results.map(response => response.statusCode).sort(), [201, 409]); assert.equal((await caseRead()).head.revision, 8);
      edited = await review({ ...v, id: randomUUID(), expectedRevision: 8, action: 'edit', rationale: 'Restore human-selected eligibility.', expectation: policy });
      const body = { ...publication, expectedVersion: 2, cases: [selection(edited), selection(siblingAccepted)] };
      const publications = await Promise.all([randomUUID(), randomUUID()].map(id => app.inject({ method: 'POST', url: versions, headers: { authorization: 'Bearer synthetic-a' }, payload: { ...body, id } })));
      assert.deepEqual(publications.map(response => response.statusCode).sort(), [201, 409]);
      assert.equal(SuiteIdentitySchema.parse((await request('GET', `${suites}/${suite.id}`)).json()).currentVersion, 3);
      const duplicateRequest = { ...v, id: randomUUID(), expectedRevision: 9, action: 'edit' as const, rationale: 'Same ID concurrent retry.', expectation: policy };
      const duplicates = await Promise.all([review(duplicateRequest), review(duplicateRequest)]);
      assert.deepEqual(duplicates[0].review, duplicates[1].review); assert.equal(duplicates.filter(response => response.idempotent).length, 1);
      edited = duplicates[0];
      const duplicatePublication: PublishSuiteRequest = { ...v, id: randomUUID(), suiteId: suite.id, expectedVersion: 3,
        cases: [selection(edited), selection(siblingAccepted)] };
      const published = await Promise.all([publish(duplicatePublication), publish(duplicatePublication)]);
      assert.deepEqual(published[0].suite, published[1].suite); assert.equal(published.filter(response => response.idempotent).length, 1);
      assert.equal(SuiteIdentitySchema.parse((await request('GET', `${suites}/${suite.id}`)).json()).currentVersion, 4);
    });
    await t.test('bounded coherent list/history windows and strict duplicate/unknown query rejection', async () => {
      const newestSuite = SuiteIdentitySchema.parse((await request('POST', suites, { ...v, id: randomUUID(), name: 'Synthetic second suite' }, 201)).json());
      assert.equal(SuiteListResponseSchema.parse((await request('GET', `${suites}?limit=1`)).json()).suites[0]?.id, newestSuite.id);
      assert.equal(SuiteListResponseSchema.parse((await request('GET', `${suites}?limit=1&offset=1`)).json()).suites[0]?.id, suite.id);
      const page = ReviewCaseListResponseSchema.parse((await request('GET', `${cases}?limit=1`)).json());
      const next = ReviewCaseListResponseSchema.parse((await request('GET', `${cases}?limit=1&offset=1`)).json());
      assert.equal(page.cases.length, 1); assert.equal(next.cases.length, 1); assert.notEqual(page.cases[0].case.id, next.cases[0].case.id);
      const history = ReviewHistoryResponseSchema.parse((await request('GET', `${reviews}?limit=1`)).json()); assert.deepEqual(history.reviews[0], edited.review);
      const previous = ReviewHistoryResponseSchema.parse((await request('GET', `${reviews}?limit=1&offset=1`)).json()); assert.equal(previous.reviews[0].decision.revision, 9);
      assert.equal(SuiteVersionListResponseSchema.parse((await request('GET', `${versions}?limit=1`)).json()).versions[0]?.version, 4);
      assert.equal(SuiteVersionListResponseSchema.parse((await request('GET', `${versions}?limit=1&offset=1`)).json()).versions[0]?.version, 3);
      for (const path of [cases, suites, reviews, versions]) {
        for (const query of ['limit=0', 'limit=21', 'limit=1&limit=1', 'offset=0&offset=0', 'offset=10001', 'offset=-1', 'offset=1.5', 'limit=01', 'ownerId=a']) await request('GET', `${path}?${query}`, undefined, 400);
        const empty = await request('GET', `${path}?limit=20&offset=10000`); assert.equal(empty.statusCode, 200);
      }
    });
    await t.test('actual loopback HTTP approval, suite creation/publication and reopen after rejection', async () => {
      const fresh = buildServer({ pool, auth });
      const httpSuiteRequest = { ...v, id: randomUUID(), name: 'Synthetic actual HTTP lifecycle suite' };
      const httpDecision = decision();
      const caseId = unreviewed.caseRequest.id;
      let httpSnapshot: ReturnType<typeof SuiteVersionSchema.parse>;
      let httpPublication: PublishSuiteRequest;
      try {
        const origin = await fresh.listen({ host: '127.0.0.1', port: 0 });
        const headers = { authorization: 'Bearer synthetic-a', 'content-type': 'application/json' };
        const saveReview = await fetch(`${origin}${cases}/${caseId}/reviews`, { method: 'POST', headers, body: JSON.stringify(httpDecision) });
        assert.equal(saveReview.status, 201); const approved = ReviewDecisionResponseSchema.parse(await saveReview.json());
        const create = await fetch(`${origin}${suites}`, { method: 'POST', headers, body: JSON.stringify(httpSuiteRequest) });
        assert.equal(create.status, 201); const identity = SuiteIdentitySchema.parse(await create.json());
        httpPublication = { ...v, id: randomUUID(), suiteId: identity.id, expectedVersion: 0, cases: [selection(approved)] };
        const publish = await fetch(`${origin}${suites}/${identity.id}/versions`, { method: 'POST', headers, body: JSON.stringify(httpPublication) });
        assert.equal(publish.status, 201); httpSnapshot = PublishSuiteResponseSchema.parse(await publish.json()).suite;
        assert.deepEqual(httpSnapshot.cases[0].review, approved.review);
        const reject = await fetch(`${origin}${cases}/${caseId}/reviews`, { method: 'POST', headers, body: JSON.stringify(decision(1, 'reject')) });
        assert.equal(reject.status, 201); assert.equal(ReviewDecisionResponseSchema.parse(await reject.json()).head.status, 'rejected');
      } finally { await fresh.close(); }
      const reopened = buildServer({ pool, auth });
      try {
        const origin = await reopened.listen({ host: '127.0.0.1', port: 0 });
        const headers = { authorization: 'Bearer synthetic-a', 'content-type': 'application/json' };
        const read = await fetch(`${origin}${suites}/${httpSnapshot.suiteId}/versions/${httpSnapshot.id}`, { headers });
        assert.equal(read.status, 200); assert.deepEqual(SuiteVersionSchema.parse(await read.json()), httpSnapshot);
        const retry = await fetch(`${origin}${suites}/${httpSnapshot.suiteId}/versions`, { method: 'POST', headers, body: JSON.stringify(httpPublication) });
        assert.equal(retry.status, 201); const saved = PublishSuiteResponseSchema.parse(await retry.json()); assert.deepEqual(saved.suite, httpSnapshot); assert.equal(saved.idempotent, true);
        const reviewRetry = await fetch(`${origin}${cases}/${caseId}/reviews`, { method: 'POST', headers, body: JSON.stringify(httpDecision) });
        assert.equal(reviewRetry.status, 201); const original = ReviewDecisionResponseSchema.parse(await reviewRetry.json());
        assert.deepEqual(original.review, httpSnapshot.cases[0].review); assert.equal(original.head.status, 'rejected');
      } finally { await reopened.close(); }
    });
  } finally {
    // Stop only these unique test fixtures; retain immutable history and never delete/reset anything.
    try {
      for (const id of jobIds) await pool.query('SELECT public.cancel_discovery_job(project_id,id) FROM public.discovery_jobs WHERE id=$1', [id]);
      for (const id of credentialIds) await pool.query('UPDATE public.runner_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [id]);
    } finally { await app.close(); await pool.end(); }
  }
});
