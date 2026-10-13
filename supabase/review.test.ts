import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import {
  canonicalJson, checksum, computeDiscoveryFacts, CreateDiscoveryJobRequestSchema, discoveryAttemptId,
  PinnedDiscoveryInputSchema, PinnedReviewEvidenceSourceSchema, pinReviewEvidence, PublishSuiteResponseSchema, ReviewCaseResponseSchema,
  ReviewDecisionResponseSchema, SuiteIdentitySchema, SuiteVersionSchema, type ReviewDecisionRequest,
  type PublishSuiteRequest, type ReviewDecisionResponse, type ReviewCaseResponse,
} from '@tastecase/contracts';
import { assertLocalTestDatabase, runMigrations } from '../apps/api/src/migrate.js';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55432/tastecase_test';
assertLocalTestDatabase(connectionString);
const schema_version = '1.0.0' as const;
const policy = { classification: 'approved_policy' as const, automaticFailure: true as const,
  rules: [{ kind: 'recommend_any' as const, profileId: 'a' as const, entryIds: ['one'] },
    { kind: 'avoid' as const, profileId: 'b' as const, entryIds: ['excluded'] },
    { kind: 'order' as const, profileId: 'a' as const, beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true as const }] };
const tables = ['review_cases', 'review_heads', 'review_decisions', 'expectation_versions', 'suites', 'suite_versions', 'suite_version_cases'];
const decideSQL = 'SELECT public.record_review_decision($1,$2,$3,$4) AS value';
const publishSQL = 'SELECT public.publish_suite($1,$2,$3) AS value';
const decision = (expectedRevision = 0, action: 'accept' | 'reject' | 'defer' = 'accept'): ReviewDecisionRequest =>
  ({ schema_version, id: randomUUID(), expectedRevision, action, rationale: 'Synthetic owner review, not an evaluator.' });
function selection(review: ReviewDecisionResponse) {
  assert.ok(review.review.expectationVersion);
  return { caseId: review.head.caseId, expectationVersionId: review.review.expectationVersion.id, expectedReviewRevision: review.review.decision.revision };
}

async function fixture(client: pg.Client, projectId = randomUUID(), ownerId = randomUUID()) {
  const jobId = randomUUID(); const catalogId = randomUUID(); const taskId = randomUUID(); const candidateId = randomUUID(); const credentialId = randomUUID();
  const createdAt = new Date().toISOString();
  const catalog = { schema_version, id: catalogId, label: 'Synthetic Gate 3 SQL catalog', entries: ['one', 'two', 'missing', 'unmapped', 'excluded'].map(id => ({ id, name: `Synthetic ${id}` })) };
  const task = { schema_version, id: taskId, label: 'Synthetic Gate 3 task', catalogVersionId: catalogId,
    syntheticBrief: { provenance: 'synthetic' as const, label: 'Fictional lunch', text: 'An explicitly fictional lunch.' }, syntheticInterests: [],
    constraints: { partySize: 2, dietaryRequirements: ['vegetarian'], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: ['excluded'] } };
  const mappings = ['one', 'two', 'missing'].map(catalogEntryId => ({ schema_version, id: randomUUID(), projectId, catalogVersionId: catalogId, catalogEntryId, qlooEntityId: randomUUID(), confirmedBy: ownerId, createdAt }));
  const request = CreateDiscoveryJobRequestSchema.parse({ schema_version, id: jobId, catalogVersionId: catalogId, taskVersionId: taskId,
    mappingConfirmationIds: mappings.map(row => row.id), eligibleCatalogEntryIds: ['one', 'two', 'missing', 'unmapped'], assistantVersion: 'synthetic-review-v1',
    profiles: ['a', 'b'].map(id => ({ id, label: `Synthetic ${id}`, provenance: 'public_synthetic', anchors: [{ id: randomUUID(), kind: 'film', label: 'Public concept', confirmedEntityId: randomUUID() }] })) });
  const input = PinnedDiscoveryInputSchema.parse({ schema_version, request, targetInput: { schema_version, projectId,
    catalog: { ...catalog, projectId, checksum: checksum(catalog), createdAt }, task: { ...task, projectId, checksum: checksum(task), createdAt }, mappings, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds } });
  await client.query('INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [projectId, ownerId, 'Synthetic Gate 3 SQL owner']);
  await client.query('INSERT INTO public.catalog_versions(id,project_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5)', [catalogId, projectId, JSON.stringify(catalog), checksum(catalog), createdAt]);
  await client.query('INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)', [taskId, projectId, catalogId, JSON.stringify(task), checksum(task), createdAt]);
  for (const mapping of mappings) await client.query('INSERT INTO public.mapping_confirmations(id,project_id,catalog_version_id,catalog_entry_id,qloo_entity_id,confirmed_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [mapping.id, projectId, catalogId, mapping.catalogEntryId, mapping.qlooEntityId, ownerId, createdAt]);
  await client.query('INSERT INTO public.runner_credentials(id,project_id,label,token_hash) VALUES($1,$2,$3,$4)', [credentialId, projectId, 'Synthetic local fixture', checksum(randomUUID())]);
  await client.query("INSERT INTO public.discovery_jobs(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '900 seconds')", [jobId, projectId, catalogId, taskId, JSON.stringify(input), checksum(input), createdAt]);
  const confirmations = (await client.query('SELECT id,anchor_id FROM public.discovery_anchor_confirmations WHERE job_id=$1', [jobId])).rows as { id: string; anchor_id: string }[];
  const rankIds: [string, string] = [randomUUID(), randomUUID()];
  const ranks = (['a', 'b'] as const).map(profileId => ({ kind: 'rank' as const, profileId, scope: 'full' as const, providerStatus: profileId === 'a' ? 'ok' as const : 'partial' as const,
    requestedEntryIds: ['one', 'two', 'missing'], orderedEntryIds: profileId === 'a' ? ['one', 'two'] : ['two', 'one'], missingEntryIds: ['missing'], unmappedEntryIds: ['unmapped'],
    mappingConfirmationIds: mappings.map(row => row.id), anchorConfirmationIds: confirmations.filter(c => request.profiles.find(p => p.id === profileId)?.anchors.some(a => a.id === c.anchor_id)).map(c => c.id) }));
  const [a, b] = ranks; assert.ok(a && b);
  const facts = computeDiscoveryFacts(jobId, rankIds, a, b); const factId = randomUUID();
  for (const [index, data] of [...ranks, facts].entries()) await client.query('INSERT INTO public.discovery_tool_evidence(id,project_id,job_id,data,checksum,captured_at) VALUES($1,$2,$3,$4,$5,$6)', [rankIds[index] ?? factId, projectId, jobId, JSON.stringify(data), checksum(data), createdAt]);
  const briefs = { a: { ...task.syntheticBrief, text: 'Synthetic profile a.' }, b: { ...task.syntheticBrief, text: 'Synthetic profile b.' }, constraints: task.constraints, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds };
  const targets: string[] = [];
  for (const profileId of ['a', 'b'] as const) {
    const targetTask = { ...task, id: discoveryAttemptId(jobId, `task:${profileId}:full`, 0), syntheticBrief: briefs[profileId] };
    const targetInput = { ...input.targetInput, task: { ...targetTask, projectId, checksum: checksum(targetTask), createdAt } };
    const id = discoveryAttemptId(jobId, `target:${profileId}:0:0:full`, 0); targets.push(id);
    await client.query('INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)', [targetTask.id, projectId, catalogId, JSON.stringify(targetTask), checksum(targetTask), createdAt]);
    await client.query('INSERT INTO public.target_attempts(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, projectId, catalogId, targetTask.id, JSON.stringify(targetInput), checksum(targetInput), createdAt]);
    await client.query("INSERT INTO public.discovery_job_targets(attempt_id,project_id,job_id,catalog_version_id,profile_id,round,repeat,variant) VALUES($1,$2,$3,$4,$5,0,0,'full')", [id, projectId, jobId, catalogId, profileId]);
  }
  await client.query('UPDATE public.discovery_job_state SET target_attempts=2,revision=revision+1 WHERE job_id=$1', [jobId]);
  await client.query("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [targets[0], randomUUID(), credentialId]);
  const targetResult = { schema_version, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'one', name: 'Synthetic One' }] }, trace: { completeness: 'partial', events: [] } };
  await client.query("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1", [targets[0], JSON.stringify(targetResult), checksum(targetResult)]);
  // Lease the second target before ending discovery. A late upload is still valid,
  // but this missing result must remain missing in the first approved snapshot.
  await client.query("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [targets[1], randomUUID(), credentialId]);
  const contrast = facts.contrasts[0]; assert.ok(contrast);
  const candidate = { contrast, briefs, evidenceIds: [...rankIds, factId], targetAttemptIds: targets,
    proposedExpectation: { classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: contrast.id, rationale: 'Order reversal remains advisory.' }, limitations: ['Explicitly synthetic local SQL fixture.'] };
  await client.query('INSERT INTO public.discovery_candidates(id,project_id,job_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)', [candidateId, projectId, jobId, JSON.stringify(candidate), checksum(candidate), createdAt]);
  await client.query("UPDATE public.discovery_job_state SET state='partial',checkpoint=6,checkpoint_data=$2,revision=revision+1,reason='Synthetic missing result.' WHERE job_id=$1", [jobId, JSON.stringify({ evidenceIds: [...rankIds, factId], candidateIds: [candidateId] })]);
  const caseRequest = { schema_version, id: randomUUID(), jobId, candidateId };
  const reviewCase = ReviewCaseResponseSchema.parse((await client.query('SELECT public.create_review_case($1,$2,$3) AS value', [projectId, ownerId, JSON.stringify(caseRequest)])).rows[0].value);
  const suiteRequest = { schema_version, id: randomUUID(), name: 'Synthetic immutable release suite' };
  const suite = SuiteIdentitySchema.parse((await client.query('SELECT public.create_suite($1,$2,$3) AS value', [projectId, ownerId, JSON.stringify(suiteRequest)])).rows[0].value);
  return { projectId, ownerId, jobId, catalogId, candidateId, credentialId, targets, targetResult, input, facts, candidate, caseRequest, reviewCase, suite, suiteRequest };
}

test('Gate 3 SQL: owner review, immutable pins, atomic suites and concurrency', async t => {
  const client = new pg.Client({ connectionString }); await client.connect();
  let serial = 0;
  async function fails(sql: string, params: unknown[] = [], code = '23514') {
    const savepoint = `review_${serial++}`; await client.query(`SAVEPOINT ${savepoint}`);
    try { await assert.rejects(client.query(sql, params), (e: unknown) => e instanceof Error && 'code' in e && e.code === code); }
    finally { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await client.query(`RELEASE SAVEPOINT ${savepoint}`); }
  }
  try {
    // Reapply only the owned repeat-safe SQL. Earlier foundation/discovery
    // migrations are installed by the normal ledger runner, never rewritten.
    const pool = new pg.Pool({ connectionString, max: 1 });
    try { await runMigrations(pool, { localTestBootstrap: true, databaseUrl: connectionString }); } finally { await pool.end(); }
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tastecase:migrations'))");
    await client.query(await readFile(new URL('./migrations/202610130004_review_suites.sql', import.meta.url), 'utf8'));
    await client.query(await readFile(new URL('./migrations/202610130004_review_suites.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
    await client.query('BEGIN');
    const f = await fixture(client); const other = await fixture(client); const sibling = await fixture(client, f.projectId, f.ownerId);
    const review = async (body: ReviewDecisionRequest, row: ReviewCaseResponse = f.reviewCase) => ReviewDecisionResponseSchema.parse((await client.query(decideSQL, [f.projectId, f.ownerId, row.case.id, JSON.stringify(body)])).rows[0].value);
    const publish = async (body: PublishSuiteRequest) => PublishSuiteResponseSchema.parse((await client.query(publishSQL, [f.projectId, f.ownerId, JSON.stringify(body)])).rows[0].value);
    const publication = (reviews: ReviewDecisionResponse[], expectedVersion = 0): PublishSuiteRequest => ({ schema_version, id: randomUUID(), suiteId: f.suite.id, expectedVersion, cases: reviews.map(selection) });

    await t.test('canonical checksum and deterministic IDs match real shared contracts', async () => {
      await client.query('SET LOCAL extra_float_digits = -15');
      for (const value of [{ z: 'line\nquote"slash\\', a: [null, true, 1.25, 0, -0] }, { '\uffff': 1, '😀': 2, a: 3 }, [1e-7, 1e-6, 1e20, 1e21, 9007199254740991, 0.00000125, 155293908668682000, 530034110648557600, 238383623538538800, Number.MIN_VALUE, Number.MAX_VALUE, -Number.MIN_VALUE]]) {
        const row = (await client.query('SELECT public.canonical_json($1) AS text,public.tastecase_json_checksum($1) AS checksum', [JSON.stringify(value)])).rows[0];
        assert.equal(row.text, canonicalJson(value)); assert.equal(row.checksum, checksum(value));
      }
      let seed = 42;
      const samples = Array.from({ length: 1000 }, () => {
        seed = (1664525 * seed + 1013904223) >>> 0; const significand = seed / 4294967296;
        seed = (1664525 * seed + 1013904223) >>> 0; return significand * 10 ** (seed % 640 - 330) * (seed % 3 ? -1 : 1);
      }).filter(Number.isFinite);
      assert.equal((await client.query('SELECT public.canonical_json($1) AS value', [JSON.stringify(samples)])).rows[0].value, canonicalJson(samples));
      assert.equal((await client.query("SELECT public.tastecase_review_id($1,'approved-expectation') AS id", [f.caseRequest.id])).rows[0].id, discoveryAttemptId(f.caseRequest.id, 'approved-expectation', 0));
    });
    await t.test('two-owner FORCE RLS, anon denial and all mutation privileges revoked', async () => {
      await client.query('SET LOCAL ROLE authenticated'); await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [f.ownerId]);
      assert.equal((await client.query('SELECT id FROM public.review_cases WHERE project_id=$1', [f.projectId])).rowCount, 2);
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [other.ownerId]);
      for (const table of tables) {
        assert.equal((await client.query(`SELECT project_id FROM public.${table} WHERE project_id=$1`, [f.projectId])).rowCount, 0);
        await fails(`UPDATE public.${table} SET project_id=project_id WHERE project_id=$1`, [f.projectId], '42501');
        await fails(`DELETE FROM public.${table} WHERE project_id=$1`, [f.projectId], '42501');
      }
      for (const role of ['authenticated', 'anon']) {
        await client.query(`SET LOCAL ROLE ${role}`);
        await fails(decideSQL, [f.projectId, f.ownerId, f.reviewCase.case.id, JSON.stringify(decision())], '42501');
        await fails(publishSQL, [f.projectId, f.ownerId, JSON.stringify(publication([]))], '42501');
        await fails('SELECT public.create_review_case($1,$2,$3)', [f.projectId, f.ownerId, JSON.stringify(f.caseRequest)], '42501');
        await fails('SELECT public.create_suite($1,$2,$3)', [f.projectId, f.ownerId, JSON.stringify(f.suiteRequest)], '42501');
        await fails("SELECT public.tastecase_review_source($1,$2,$3,clock_timestamp())", [f.projectId, f.jobId, f.candidateId], '42501');
      }
      await fails('SELECT * FROM public.review_cases', [], '42501'); await client.query('RESET ROLE');
      const forced = (await client.query('SELECT count(*)::int AS count FROM pg_class WHERE relname=ANY($1) AND relrowsecurity AND relforcerowsecurity', [tables])).rows[0].count;
      assert.equal(forced, tables.length);
      await client.query('SET LOCAL ROLE service_role');
      await fails('INSERT INTO public.suites(id,project_id,name,created_at) VALUES($1,$2,\'forged\',now())', [randomUUID(), f.projectId], '42501');
      await fails(decideSQL, [f.projectId, other.ownerId, f.reviewCase.case.id, JSON.stringify(decision())], '42501');
      await client.query('RESET ROLE');
    });
    await t.test('cases pin existing candidate and retries cannot change ID, project, job or checksum', async () => {
      const retry = ReviewCaseResponseSchema.parse((await client.query('SELECT public.create_review_case($1,$2,$3) AS value', [f.projectId, f.ownerId, JSON.stringify(f.caseRequest)])).rows[0].value);
      assert.deepEqual(retry, f.reviewCase);
      for (const body of [{ ...f.caseRequest, candidateChecksum: '0'.repeat(64) }, { ...f.caseRequest, ownerId: f.ownerId }]) await fails('SELECT public.create_review_case($1,$2,$3)', [f.projectId, f.ownerId, JSON.stringify(body)]);
      for (const body of [{ ...f.caseRequest, jobId: other.jobId }, { ...f.caseRequest, jobId: sibling.jobId }, { ...f.caseRequest, candidateId: sibling.candidateId }]) await fails('SELECT public.create_review_case($1,$2,$3)', [f.projectId, f.ownerId, JSON.stringify(body)], '23503');
      await fails('SELECT public.create_review_case($1,$2,$3)', [f.projectId, f.ownerId, JSON.stringify({ ...sibling.caseRequest, id: f.caseRequest.id })], '23505');
      await fails('SELECT public.create_suite($1,$2,$3)', [f.projectId, f.ownerId, JSON.stringify({ ...f.suiteRequest, name: 'Changed name' })], '23505');
    });
    await t.test('request differences, forgery, unavailable and unsupported rules are rejected by privileged RPC', async () => {
      for (const body of [{ ...decision(), rationale: '' }, { ...decision(), rationale: 'x'.repeat(2001) }, { ...decision(), expectedRevision: -1 }, { ...decision(), expectedRevision: 0.5 },
        { ...decision(), action: 'edit' }, { ...decision(), expectation: policy }, { ...decision(0, 'reject'), expectation: policy }, { ...decision(0, 'defer'), expectation: policy },
        { ...decision(), checksum: '0'.repeat(64) }, { ...decision(), evidence: {} }, { ...decision(), unexpected: 'x'.repeat(65536) }, { ...decision(), reviewedBy: other.ownerId }, { ...decision(), action: 'unknown' }]) {
        await fails(decideSQL, [f.projectId, f.ownerId, f.reviewCase.case.id, JSON.stringify(body)]);
      }
      const invalid = [
        { classification: 'unavailable', automaticFailure: false, reason: 'No evidence.' },
        { classification: 'advisory', automaticFailure: true, humanReviewRequired: true, contrastId: f.candidate.contrast.id, rationale: 'Automatic taste.' },
        { ...policy, rules: [{ kind: 'expression', code: 'return true' }] },
        { ...policy, rules: [{ kind: 'recommend_any', profileId: 'c', entryIds: ['one'] }] },
        { ...policy, rules: [{ kind: 'recommend_any', profileId: 'a', entryIds: ['outside'] }] },
        { ...policy, rules: [{ kind: 'recommend_any', profileId: 'a', entryIds: ['excluded'] }] },
        { ...policy, rules: [{ kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: false }] },
        { ...policy, rules: [{ kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'one', whenBothPresent: true }] },
        { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'allowed_ids', entryIds: ['one'] }] },
        { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'exclusions', entryIds: ['one'] }] },
        { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'output_schema', url: 'https://synthetic.invalid' }] },
        { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'tool_not_called' }] },
      ];
      for (const expectation of invalid) await fails(decideSQL, [f.projectId, f.ownerId, f.reviewCase.case.id, JSON.stringify({ ...decision(), action: 'edit', expectation })]);
      assert.equal((await client.query('SELECT revision::int FROM public.review_heads WHERE case_id=$1', [f.caseRequest.id])).rows[0].revision, 0);
    });
    await t.test('unreviewed publication and forged persisted evidence/contrasts fail without trusting backend', async () => {
      await fails(publishSQL, [f.projectId, f.ownerId, JSON.stringify({ schema_version, id: randomUUID(), suiteId: f.suite.id, expectedVersion: 0, rationale: 'Explicit owner selection.', cases: [{ caseId: f.caseRequest.id, expectationVersionId: randomUUID(), expectedReviewRevision: 0 }] })]);
      await client.query('INSERT INTO public.discovery_tool_evidence(id,project_id,job_id,data,checksum) VALUES($1,$2,$3,$4,$5)', [randomUUID(), other.projectId, other.jobId, JSON.stringify(other.facts), '0'.repeat(64)]);
      await fails(decideSQL, [other.projectId, other.ownerId, other.caseRequest.id, JSON.stringify(decision())]);
      const candidateId = randomUUID(); const unsupported = { ...sibling.candidate, contrast: { ...sibling.candidate.contrast, id: randomUUID() } };
      await fails('INSERT INTO public.discovery_candidates(id,project_id,job_id,content,checksum) VALUES($1,$2,$3,$4,$5)', [candidateId, f.projectId, sibling.jobId, JSON.stringify(unsupported), checksum(unsupported)]);
      const invalidResult = await fixture(client);
      await client.query(`UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1`, [invalidResult.targets[1], JSON.stringify(invalidResult.targetResult), '0'.repeat(64)]);
      await fails(decideSQL, [invalidResult.projectId, invalidResult.ownerId, invalidResult.caseRequest.id, JSON.stringify(decision())]);
      assert.equal((await client.query('SELECT current_version::int FROM public.suites WHERE id=$1', [f.suite.id])).rows[0].current_version, 0);
    });
    const acceptRequest = decision(); let accepted: ReviewDecisionResponse; let edited: ReviewDecisionResponse;
    await t.test('accept saves immutable advisory evidence with missing coverage, partial traces and valid checksums', async () => {
      await client.query('SET LOCAL ROLE service_role'); accepted = await review(acceptRequest); await client.query('RESET ROLE');
      assert.equal(accepted.head.revision, 1); assert.equal(accepted.idempotent, false);
      assert.deepEqual(accepted.review.expectationVersion?.expectation, f.candidate.proposedExpectation);
      const evidence = accepted.review.decision.evidence;
      assert.deepEqual(pinReviewEvidence(PinnedReviewEvidenceSourceSchema.parse(Object.fromEntries(Object.entries(evidence).filter(([key]) => !['coverage', 'limitations', 'checksum'].includes(key))))), evidence);
      assert.deepEqual(evidence.coverage.missingEntryIds, ['missing']); assert.deepEqual(evidence.coverage.unmappedEntryIds, ['unmapped']);
      assert.equal(evidence.coverage.completedFullAttempts, 1); assert.deepEqual(evidence.coverage.unfinishedAttemptIds, [f.targets[1]]);
      assert.deepEqual(evidence.coverage.partialTraceAttemptIds, [f.targets[0]]);
      assert.equal(evidence.candidate.content.proposedExpectation.humanReviewRequired, true);
    });
    await t.test('edit creates an explicit policy version and stale CAS conflicts; old same-ID retry survives newer review', async () => {
      const request: ReviewDecisionRequest = { ...decision(1), action: 'edit', expectation: policy };
      edited = await review(request);
      assert.notEqual(edited.review.expectationVersion?.id, accepted.review.expectationVersion?.id);
      assert.deepEqual(edited.review.expectationVersion?.expectation, policy);
      assert.deepEqual((await review(acceptRequest)).review, accepted.review); assert.equal((await review(acceptRequest)).head.revision, 2);
      await fails(decideSQL, [f.projectId, f.ownerId, f.caseRequest.id, JSON.stringify(decision(1))], '40001');
      await fails(decideSQL, [f.projectId, f.ownerId, f.caseRequest.id, JSON.stringify({ ...acceptRequest, rationale: 'Different reason' })], '23505');
      await fails(decideSQL, [f.projectId, f.ownerId, sibling.caseRequest.id, JSON.stringify(acceptRequest)], '23505');
    });
    let siblingReview: ReviewDecisionResponse; let originalPublication: PublishSuiteRequest; let originalSnapshot: ReturnType<typeof SuiteVersionSchema.parse>;
    await t.test('multi-case publication explicitly selects current approved versions and is all-or-nothing', async () => {
      siblingReview = await review(decision(), sibling.reviewCase);
      for (const body of [publication([accepted]), { ...publication([edited]), cases: [selection(edited), { ...selection(siblingReview), expectedReviewRevision: 2 }] },
        { ...publication([edited]), cases: [selection(edited), { ...selection(siblingReview), expectationVersionId: edited.review.expectationVersion?.id }] }]) {
        await fails(publishSQL, [f.projectId, f.ownerId, JSON.stringify(body)], body.cases[1]?.expectationVersionId === edited.review.expectationVersion?.id ? '23514' : '40001');
      }
      assert.equal((await client.query('SELECT current_version::int FROM public.suites WHERE id=$1', [f.suite.id])).rows[0].current_version, 0);
      assert.equal((await client.query('SELECT id FROM public.suite_versions WHERE suite_id=$1', [f.suite.id])).rowCount, 0);
      originalPublication = publication([edited, siblingReview]);
      for (const invalid of [{ ...originalPublication, cases: [] }, { ...originalPublication, cases: [selection(edited), selection(edited)] }, { ...originalPublication, cases: Array.from({ length: 51 }, () => selection(edited)) }, { ...originalPublication, evidence: {} }, { ...originalPublication, publishedBy: other.ownerId }]) await fails(publishSQL, [f.projectId, f.ownerId, JSON.stringify(invalid)]);
      originalSnapshot = (await publish(originalPublication)).suite;
      assert.equal(originalSnapshot.version, 1); assert.equal(originalSnapshot.cases.length, 2);
      assert.equal(originalSnapshot.cases[1]?.review.expectationVersion?.expectation.classification, 'advisory');
      assert.equal(originalSnapshot.cases[1]?.review.expectationVersion?.expectation.automaticFailure, false);
      assert.equal((await publish(originalPublication)).idempotent, true);
    });
    await t.test('reject/defer invalidate current publication only; old suite reopens unchanged after late results', async () => {
      await review(decision(2, 'reject')); await review(decision(1, 'defer'), sibling.reviewCase);
      for (const approval of [edited, siblingReview]) await fails(publishSQL, [f.projectId, f.ownerId, JSON.stringify(publication([approval], 1))], '40001');
      await client.query("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1", [f.targets[1], JSON.stringify({ ...f.targetResult, trace: { completeness: 'unavailable', events: [] } }), checksum({ ...f.targetResult, trace: { completeness: 'unavailable', events: [] } })]);
      const read = SuiteVersionSchema.parse((await client.query('SELECT snapshot FROM public.suite_versions WHERE id=$1', [originalPublication.id])).rows[0].snapshot);
      assert.deepEqual(read, originalSnapshot); assert.equal(read.cases[0]?.review.decision.evidence.targets[1]?.attempt.result, null);
      assert.deepEqual((await publish(originalPublication)).suite, originalSnapshot);
      const newReview = await review(decision(3)); assert.equal(newReview.review.decision.evidence.coverage.completedFullAttempts, 2);
      assert.deepEqual(newReview.review.decision.evidence.coverage.unavailableTraceAttemptIds, [f.targets[1]]);
      const next = await publish(publication([newReview], 1)); assert.equal(next.suite.version, 2);
      assert.deepEqual((await publish(originalPublication)).suite, originalSnapshot);
      await fails(publishSQL, [f.projectId, f.ownerId, JSON.stringify({ ...originalPublication, cases: [selection(newReview)] })], '23505');
      await fails(publishSQL, [f.projectId, f.ownerId, JSON.stringify(publication([newReview], 1))], '40001');
    });
    await t.test('mechanical objective expectation uses only supported checks; immutable histories resist tampering', async () => {
      const objective: ReviewDecisionRequest = { ...decision(4), action: 'edit', expectation: { classification: 'objective_contract', automaticFailure: true, profiles: ['a', 'b'], rules: [{ kind: 'output_schema' }, { kind: 'allowed_ids', entryIds: f.input.targetInput.eligibleCatalogEntryIds }, { kind: 'exclusions', entryIds: ['excluded'] }] } };
      const approved = await review(objective); assert.equal(approved.head.revision, 5);
      for (const table of ['review_cases', 'review_decisions', 'expectation_versions', 'suite_versions', 'suite_version_cases']) {
        await fails(`UPDATE public.${table} SET project_id=project_id WHERE project_id=$1`, [f.projectId]);
        await fails(`DELETE FROM public.${table} WHERE project_id=$1`, [f.projectId]);
      }
      await fails('UPDATE public.discovery_candidates SET content=content WHERE id=$1', [f.candidateId]);
      await fails('DELETE FROM public.discovery_candidates WHERE id=$1', [f.candidateId]);
      await fails('UPDATE public.review_heads SET revision=revision+1 WHERE case_id=$1', [f.caseRequest.id]);
      await fails('UPDATE public.suites SET current_version=current_version+1 WHERE id=$1', [f.suite.id]);
    });
    await t.test('composite histories and target/evidence associations refuse cross-project and cross-job links', async () => {
      await fails('INSERT INTO public.discovery_candidate_evidence(project_id,job_id,candidate_id,evidence_id) VALUES($1,$2,$3,$4)', [f.projectId, f.jobId, f.candidateId, sibling.candidate.evidenceIds[0]], '23503');
      await fails('INSERT INTO public.discovery_candidate_targets(project_id,job_id,candidate_id,attempt_id) VALUES($1,$2,$3,$4)', [f.projectId, f.jobId, f.candidateId, other.targets[0]], '23503');
      await fails('INSERT INTO public.review_cases(id,project_id,job_id,candidate_id,candidate_checksum,created_at,case_json) VALUES($1,$2,$3,$4,$5,now(),$6)', [randomUUID(), f.projectId, other.jobId, other.candidateId, checksum(other.candidate), JSON.stringify({ ...other.reviewCase.case, id: randomUUID(), projectId: f.projectId })], '23514');
      await fails('INSERT INTO public.suite_version_cases(project_id,suite_id,suite_version_id,ordinal,case_id,review_decision_id,review_revision,expectation_version_id) VALUES($1,$2,$3,4,$4,$5,$6,$7)', [other.projectId, f.suite.id, originalPublication.id, other.caseRequest.id, edited.review.decision.id, edited.head.revision, edited.review.expectationVersion?.id], '23503');
      await fails(publishSQL, [f.projectId, f.ownerId, JSON.stringify({ ...publication([edited], 2), cases: [{ caseId: other.caseRequest.id, expectationVersionId: randomUUID(), expectedReviewRevision: 1 }] })], '23503');
    });
    await client.query('COMMIT');

    await t.test('review uses one MVCC snapshot without waiting on a concurrent target upload', async () => {
      const fresh = await fixture(client);
      const uploader = new pg.Client({ connectionString }); const reviewer = new pg.Client({ connectionString, query_timeout: 1500 });
      await Promise.all([uploader.connect(), reviewer.connect()]);
      try {
        await uploader.query('BEGIN');
        await uploader.query(`UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1`, [fresh.targets[1], JSON.stringify(fresh.targetResult), checksum(fresh.targetResult)]);
        const before = ReviewDecisionResponseSchema.parse((await reviewer.query(decideSQL, [fresh.projectId, fresh.ownerId, fresh.caseRequest.id, JSON.stringify(decision())])).rows[0].value);
        assert.equal(before.review.decision.evidence.targets.find(t => t.attempt.id === fresh.targets[1])?.attempt.result, null);
        await uploader.query('COMMIT');
        const after = ReviewDecisionResponseSchema.parse((await reviewer.query(decideSQL, [fresh.projectId, fresh.ownerId, fresh.caseRequest.id, JSON.stringify(decision(1))])).rows[0].value);
        assert.equal(after.review.decision.evidence.coverage.completedFullAttempts, 2);
        assert.deepEqual((await client.query('SELECT receipt FROM public.review_decisions WHERE id=$1', [before.review.decision.id])).rows[0].receipt, before.review.decision);
      } finally { await uploader.query('ROLLBACK'); await Promise.all([uploader.end(), reviewer.end()]); }
    });
    await t.test('true concurrent reviews: one CAS writer wins; identical same-ID retries advance once', async () => {
      const fresh = await fixture(client);
      async function simultaneous(requests: ReviewDecisionRequest[]) {
        const clients = await Promise.all(requests.map(async () => { const c = new pg.Client({ connectionString }); await c.connect(); await c.query("SET statement_timeout='10s'; SET lock_timeout='3s'"); return c; }));
        try {
          const results = await Promise.allSettled(clients.map((c, index) => c.query(decideSQL, [fresh.projectId, fresh.ownerId, fresh.caseRequest.id, JSON.stringify(requests[index])])));
          return results;
        } finally { await Promise.all(clients.map(c => c.end())); }
      }
      const results = await simultaneous([decision(), decision()]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const failed = results.find(r => r.status === 'rejected'); assert.ok(failed?.status === 'rejected'); assert.equal((failed.reason as { code: string }).code, '40001');
      const retry = decision(1); const identical = await simultaneous([retry, retry]); assert.ok(identical.every(r => r.status === 'fulfilled'));
      assert.equal((await client.query('SELECT revision::int FROM public.review_heads WHERE case_id=$1', [fresh.caseRequest.id])).rows[0].revision, 2);
      assert.equal((await client.query('SELECT id FROM public.review_decisions WHERE case_id=$1', [fresh.caseRequest.id])).rowCount, 2);
    });
    await t.test('true concurrent suite version publication and overlapping reversed case selections are conflict-safe', async () => {
      const fresh = await fixture(client); const second = await fixture(client, fresh.projectId, fresh.ownerId);
      const reviews = await Promise.all([fresh, second].map(async f => ReviewDecisionResponseSchema.parse((await client.query(decideSQL, [f.projectId, f.ownerId, f.caseRequest.id, JSON.stringify(decision())])).rows[0].value)));
      const body: PublishSuiteRequest = { schema_version, id: randomUUID(), suiteId: fresh.suite.id, expectedVersion: 0, cases: reviews.map(selection) };
      const clients = await Promise.all([0, 1].map(async () => { const c = new pg.Client({ connectionString }); await c.connect(); await c.query("SET statement_timeout='10s'; SET lock_timeout='3s'"); return c; }));
      try {
        const results = await Promise.allSettled(clients.map((c, i) => c.query(publishSQL, [fresh.projectId, fresh.ownerId, JSON.stringify({ ...body, id: i === 0 ? body.id : randomUUID() })])));
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        const failure = results.find(r => r.status === 'rejected'); assert.ok(failure?.status === 'rejected'); assert.equal((failure.reason as { code: string }).code, '40001');
        const same: PublishSuiteRequest = { ...body, id: randomUUID(), expectedVersion: 1 };
        const retries = await Promise.all(clients.map(c => c.query(publishSQL, [fresh.projectId, fresh.ownerId, JSON.stringify(same)])));
        assert.deepEqual(retries[0]?.rows[0].value.suite, retries[1]?.rows[0].value.suite);
        assert.equal((await client.query('SELECT current_version::int FROM public.suites WHERE id=$1', [fresh.suite.id])).rows[0].current_version, 2);
        const overlap = await Promise.all(clients.map((c, i) => c.query(publishSQL, [fresh.projectId, fresh.ownerId, JSON.stringify({ ...body, id: randomUUID(), suiteId: i === 0 ? fresh.suite.id : second.suite.id, expectedVersion: i === 0 ? 2 : 0, cases: i === 0 ? body.cases : [...body.cases].reverse() })])));
        assert.equal(overlap.length, 2);
      } finally { await Promise.all(clients.map(c => c.end())); }
    });
  } finally {
    await client.query('ROLLBACK'); await client.end();
  }
});

test('Gate 3 migration ledger is local-only and repeat-safe', async () => {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await runMigrations(pool, { databaseUrl: connectionString });
    assert.deepEqual(await runMigrations(pool, { databaseUrl: connectionString }), []);
  } finally { await pool.end(); }
});
