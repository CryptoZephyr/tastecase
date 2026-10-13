import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import {
  SCHEMA_VERSION, checksum, canonicalJson, computeDiscoveryFacts,
  ProjectSchema, CatalogVersionSchema, TaskVersionSchema, MappingConfirmationSchema,
  MintRunnerCredentialResponseSchema, CreateDiscoveryJobRequestSchema, DiscoveryJobSchema,
  ReviewCaseResponseSchema, ReviewDecisionResponseSchema, SuiteIdentitySchema, PublishSuiteResponseSchema,
  ComparisonCreateResponseSchema, ComparisonDetailResponseSchema, ComparisonListResponseSchema,
  ComparisonFinalizeResponseSchema, validatePortableTestPack, validateComparisonReportAgainstPlan,
  prepareComparisonPlan, ApiErrorSchema,
  type ApprovedExpectation, type CreateComparisonRequest, type ComparisonPlan, type TargetAdapter, type TargetResult,
  type MappingConfirmation, type ClaimAttemptResponse,
} from '@tastecase/contracts';
import { RunnerClient, runOnce, replayComparisonRole } from '@tastecase/runner';
import { buildServer } from '../server.js';
import { assertLocalTestDatabase, runMigrations } from '../migrate.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55432/tastecase_test';
assertLocalTestDatabase(databaseUrl);
const v = { schema_version: SCHEMA_VERSION };
const objective: ApprovedExpectation = { classification: 'objective_contract', automaticFailure: true,
  profiles: ['a', 'b'], rules: [{ kind: 'output_schema' }, { kind: 'allowed_ids', entryIds: ['one', 'two'] }, { kind: 'exclusions', entryIds: ['excluded'] }] };
const policy: ApprovedExpectation = { classification: 'approved_policy', automaticFailure: true,
  rules: [{ kind: 'recommend_any', profileId: 'a', entryIds: ['one'] },
    { kind: 'order', profileId: 'b', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true }] };
const success = (ids: (string | undefined)[] = ['one']): TargetResult => ({ ...v, outcome: 'success',
  output: { recommendations: ids.map(id => ({ ...(id === undefined ? {} : { catalogEntryId: id }), name: 'Raw synthetic target name', reason: 'Raw synthetic reason' })) },
  trace: { completeness: 'partial', events: [] } });
const unavailable: TargetResult = { ...v, outcome: 'provider_unavailable', error: { code: 'synthetic_unavailable', message: 'Raw synthetic provider diagnostic' }, retryable: false, trace: { completeness: 'unavailable', events: [] } };
const malformed: TargetResult = { ...v, outcome: 'malformed_output', rawText: 'Raw synthetic malformed text', error: { code: 'synthetic_malformed', message: 'Raw synthetic diagnostic' }, trace: { completeness: 'partial', events: [] } };

test('Gate 4 readiness requires every comparison table/RPC while health stays process-only', async () => {
  const queries: string[] = [];
  let missing: string | undefined;
  const schemaPool = { connect: async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      if (missing && sql.includes(missing)) throw new Error('Synthetic missing comparison migration.');
    },
    release: () => {},
  }) } as unknown as pg.Pool;
  const app = buildServer({ pool: schemaPool, auth: { testVerifier: async () => null } });
  const tables = ['comparison_runs', 'comparison_state', 'comparison_cases', 'comparison_targets', 'comparison_dispatches', 'comparison_cancellations', 'comparison_reports', 'comparison_artifacts'];
  const RPCs = ['create_comparison', 'get_comparison', 'list_comparisons', 'cancel_comparison', 'comparison_target_claimable', 'reserve_comparison_dispatch', 'finalize_comparison', 'export_comparison_artifact'];
  try {
    assert.equal((await app.inject('/ready')).statusCode, 200);
    for (const name of [...tables, ...RPCs]) {
      assert.ok(queries.some(sql => sql.includes(`public.${name}`)));
      missing = `public.${name}`;
      assert.equal((await app.inject('/ready')).statusCode, 503);
      assert.equal((await app.inject('/health')).statusCode, 200);
    }
  } finally { await app.close(); }
});

test('Gate 4 actual owner API, loopback two-version runner and offline replay', async t => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  const owners = { a: randomUUID(), b: randomUUID() };
  const auth = { testVerifier: async (token: string) => token === 'synthetic-a' ? owners.a : token === 'synthetic-b' ? owners.b : null };
  const app = buildServer({ pool, auth, leaseDurationSeconds: 30 });
  const credentialIds: string[] = [];
  async function request(method: 'GET' | 'POST', path: string, payload?: unknown, expected = 200, token = 'synthetic-a') {
    const response = await app.inject({ method, url: path, headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
    assert.equal(response.statusCode, expected, `${method} ${path}: unexpected status; response deliberately not logged`);
    assert.equal(response.headers['cache-control'], 'no-store');
    if (expected >= 400) {
      ApiErrorSchema.parse(response.json());
      for (const unsafe of ['PL/pgSQL', 'SELECT ', 'Raw synthetic', 'token_hash']) assert.equal(response.body.includes(unsafe), false);
    }
    return response;
  }
  try {
    await runMigrations(pool, { databaseUrl, localTestBootstrap: true });
    const project = ProjectSchema.parse((await request('POST', '/projects', { ...v, name: 'Synthetic Gate 4 API owner' }, 201)).json());
    const other = ProjectSchema.parse((await request('POST', '/projects', { ...v, name: 'Synthetic Gate 4 other owner' }, 201, 'synthetic-b')).json());
    const base = `/projects/${project.id}`;
    const comparisons = `${base}/comparisons`;
    const runner = MintRunnerCredentialResponseSchema.parse((await request('POST', `${base}/runner-credentials`, { ...v, label: 'Explicit synthetic Gate 4 runner' }, 201)).json());
    const foreignRunner = MintRunnerCredentialResponseSchema.parse((await request('POST', `/projects/${other.id}/runner-credentials`, { ...v, label: 'Foreign synthetic runner' }, 201, 'synthetic-b')).json());
    credentialIds.push(runner.credential.id, foreignRunner.credential.id);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = (assistantVersion?: string, token = runner.token) => new RunnerClient({ apiOrigin: origin, allowLoopbackHttp: true,
      env: { TASTECASE_RUNNER_TOKEN: token }, ...(assistantVersion === undefined ? {} : { assistantVersion }) });
    async function claim(release?: string, token = runner.token) {
      const local = client(release, token);
      await local.handshake({ name: 'explicit-synthetic-deterministic-adapter', version: '1' });
      return local.claim();
    }
    async function upload(lease: ClaimAttemptResponse, result: TargetResult) {
      const local = client(lease.input.execution?.assistantVersion);
      await local.handshake({ name: 'explicit-synthetic-deterministic-adapter', version: '1' });
      return local.uploadResult(lease, result);
    }
    const adapter = (release: string, result: (input: ComparisonPlan['slots'][number]['input']) => TargetResult): TargetAdapter => ({
      name: 'explicit-synthetic-deterministic-adapter', version: '1',
      run: async input => { assert.equal(input.execution?.assistantVersion, release); return result(input); },
    });

    async function fixture(expectation: ApprovedExpectation | null = objective, repeatCount = 3, label = 'Synthetic public catalog') {
      const catalog = CatalogVersionSchema.parse((await request('POST', `${base}/catalogs`, { ...v, id: randomUUID(), label,
        entries: ['one', 'two', 'excluded'].map(id => ({ id, name: `Synthetic ${id}` })) }, 201)).json());
      const task = TaskVersionSchema.parse((await request('POST', `${base}/tasks`, { ...v, id: randomUUID(), label: 'Synthetic task', catalogVersionId: catalog.id,
        syntheticBrief: { provenance: 'synthetic', label: 'Fictional lunch', text: 'Explicitly fictional dining brief.' }, syntheticInterests: [],
        constraints: { partySize: 2, dietaryRequirements: ['vegetarian'], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: ['excluded'] } }, 201)).json());
      const mappings: MappingConfirmation[] = [];
      for (const catalogEntryId of ['one', 'two']) mappings.push(MappingConfirmationSchema.parse((await request('POST', `${base}/mappings`,
        { ...v, id: randomUUID(), catalogVersionId: catalog.id, catalogEntryId, qlooEntityId: randomUUID() }, 201)).json()));
      const jobRequest = CreateDiscoveryJobRequestSchema.parse({ ...v, id: randomUUID(), catalogVersionId: catalog.id, taskVersionId: task.id,
        mappingConfirmationIds: mappings.map(row => row.id), eligibleCatalogEntryIds: ['one', 'two'], repeatCount, assistantVersion: 'discovery-is-not-a-comparison-baseline',
        profiles: ['a', 'b'].map(id => ({ id, label: `Synthetic ${id}`, provenance: 'public_synthetic', anchors: [{ id: randomUUID(), kind: 'film', label: `Public synthetic ${id}`, confirmedEntityId: randomUUID() }] })) });
      const job = DiscoveryJobSchema.parse((await request('POST', `${base}/discovery-jobs`, jobRequest, 201)).json());
      const confirmations = (await pool.query<{ id: string; anchor_id: string }>('SELECT id,anchor_id FROM public.discovery_anchor_confirmations WHERE project_id=$1 AND job_id=$2', [project.id, job.id])).rows;
      const rankIds: [string, string] = [randomUUID(), randomUUID()];
      const ranks = (['a', 'b'] as const).map(profileId => ({ kind: 'rank' as const, profileId, scope: 'full' as const, providerStatus: 'partial' as const,
        requestedEntryIds: ['one', 'two'], orderedEntryIds: profileId === 'a' ? ['one', 'two'] : ['two', 'one'], missingEntryIds: [], unmappedEntryIds: [],
        mappingConfirmationIds: mappings.map(row => row.id), anchorConfirmationIds: confirmations.filter(c => jobRequest.profiles.find(p => p.id === profileId)?.anchors.some(a => a.id === c.anchor_id)).map(c => c.id) }));
      const [a, b] = ranks; assert.ok(a && b);
      const facts = computeDiscoveryFacts(job.id, rankIds, a, b); const factId = randomUUID();
      for (const [index, data] of [...ranks, facts].entries()) await pool.query('INSERT INTO public.discovery_tool_evidence(id,project_id,job_id,data,checksum,captured_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())',
        [rankIds[index] ?? factId, project.id, job.id, JSON.stringify(data), checksum(data)]);
      const contrast = facts.contrasts[0]; assert.ok(contrast);
      const candidate = { contrast, briefs: { a: { ...task.syntheticBrief, text: 'Synthetic full profile a, unchanged constraints.' }, b: { ...task.syntheticBrief, text: 'Synthetic full profile b, unchanged constraints.' }, constraints: task.constraints, eligibleCatalogEntryIds: ['one', 'two'] },
        evidenceIds: [...rankIds, factId], targetAttemptIds: [], proposedExpectation: { classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: contrast.id, rationale: 'Synthetic public contrast, advisory only.' }, limitations: ['Synthetic fixture without discovery outputs or live Qloo calls.'] };
      const candidateId = randomUUID();
      await pool.query('INSERT INTO public.discovery_candidates(id,project_id,job_id,content,checksum) VALUES($1,$2,$3,$4,$5)', [candidateId, project.id, job.id, JSON.stringify(candidate), checksum(candidate)]);
      await pool.query("UPDATE public.discovery_job_state SET state='partial',checkpoint=6,checkpoint_data=$2,revision=revision+1,reason='Synthetic missing discovery execution.' WHERE job_id=$1", [job.id, JSON.stringify({ evidenceIds: [...rankIds, factId], candidateIds: [candidateId] })]);
      const reviewCase = ReviewCaseResponseSchema.parse((await request('POST', `${base}/cases`, { ...v, id: randomUUID(), jobId: job.id, candidateId }, 201)).json());
      const review = ReviewDecisionResponseSchema.parse((await request('POST', `${base}/cases/${reviewCase.case.id}/reviews`, { ...v, id: randomUUID(), expectedRevision: 0,
        action: expectation ? 'edit' : 'accept', ...(expectation ? { expectation } : {}), rationale: 'Explicit synthetic owner approval of this scoped rule only.' }, 201)).json());
      assert.ok(review.review.expectationVersion);
      const suite = SuiteIdentitySchema.parse((await request('POST', `${base}/suites`, { ...v, id: randomUUID(), name: 'Synthetic immutable release suite' }, 201)).json());
      const publication = PublishSuiteResponseSchema.parse((await request('POST', `${base}/suites/${suite.id}/versions`, { ...v, id: randomUUID(), suiteId: suite.id, expectedVersion: 0,
        cases: [{ caseId: reviewCase.case.id, expectationVersionId: review.review.expectationVersion.id, expectedReviewRevision: 1 }] }, 201)).json());
      function body(overrides: Partial<CreateComparisonRequest> = {}): CreateComparisonRequest {
        const id = randomUUID();
        return { ...v, id, suiteVersionId: publication.suite.id, baselineVersion: `synthetic-baseline-${id}`, candidateVersion: `synthetic-candidate-${id}`,
          caseIds: [reviewCase.case.id], deadlineAt: new Date(Date.now() + 300_000).toISOString(), dispatchBudget: repeatCount * 4 + 1, reclaimBudget: 1, ...overrides };
      }
      return { catalog, task, job, publication, reviewCase, body };
    }
    const f = await fixture();
    const create = async (body: CreateComparisonRequest) => ComparisonCreateResponseSchema.parse((await request('POST', comparisons, body, 201)).json());
    const detail = async (id: string) => ComparisonDetailResponseSchema.parse((await request('GET', `${comparisons}/${id}`)).json());
    const finalize = async (id: string, allowPartial = false, receiptId: string = randomUUID()) => ComparisonFinalizeResponseSchema.parse((await request('POST', `${comparisons}/${id}/finalize`, { ...v, id: receiptId, allowPartial }, 201)).json());
    const pack = async (id: string) => validatePortableTestPack((await request('GET', `${comparisons}/${id}/pack`)).json());
    const body = f.body(); const first = await create(body); const plan = first.comparison.plan; const path = `${comparisons}/${plan.id}`;

    await t.test('owner/runner isolation across every comparison route and forbidden artifact mutations', async () => {
      const reads = [comparisons, path, `${path}/pack`, `${path}/report`, `${path}/report.txt`];
      const writes = [[comparisons, body], [`${path}/cancel`, { ...v, id: randomUUID() }], [`${path}/finalize`, { ...v, id: randomUUID(), allowPartial: true }]] as const;
      for (const token of ['synthetic-b', runner.token, foreignRunner.token, 'unverified']) {
        const denied = token === 'synthetic-b' ? 404 : 401;
        for (const url of reads) await request('GET', url, undefined, denied, token);
        for (const [url, payload] of writes) await request('POST', url, payload, denied, token);
      }
      const foreignBase = `/projects/${other.id}/comparisons`;
      for (const suffix of ['', '/pack', '/report', '/report.txt']) await request('GET', `${foreignBase}/${plan.id}${suffix}`, undefined, 404, 'synthetic-b');
      await request('POST', foreignBase, f.body(), 404, 'synthetic-b');
      await request('POST', foreignBase, body, 409, 'synthetic-b');
      for (const suffix of ['cancel', 'finalize']) await request('POST', `${foreignBase}/${plan.id}/${suffix}`, { ...v, id: randomUUID(), ...(suffix === 'finalize' ? { allowPartial: true } : {}) }, 404, 'synthetic-b');
      for (const suffix of ['pack', 'report', 'report.txt', 'reopen']) await request('POST', `${path}/${suffix}`, {}, 404);
      await request('GET', `${comparisons}/${randomUUID()}`, undefined, 404);
      await request('GET', `${path}/report`, undefined, 404);
      await request('GET', `${path}/report.txt`, undefined, 404);
      assert.equal(await claim(body.baselineVersion, foreignRunner.token), null);
      await request('POST', `/runner/attempts/${plan.slots[0].attemptId}/results`, { ...v, leaseId: randomUUID(), result: success() }, 404, foreignRunner.token);
    });
    await t.test('strict bounded selection, immutable creation retries, exact suite and slot checksums', async () => {
      assert.deepEqual(plan, prepareComparisonPlan({ request: body, suite: f.publication.suite, projectId: project.id, createdAt: plan.createdAt }));
      assert.equal(plan.slots.length, 12);
      assert.equal(f.publication.suite.cases[0].review.decision.evidence.targets.length, 0);
      for (const slot of plan.slots) {
        assert.equal(checksum(slot.input), slot.inputChecksum);
        assert.equal(slot.execution.suiteChecksum, f.publication.suite.checksum);
        assert.equal(slot.input.task.syntheticBrief.text, `Synthetic full profile ${slot.execution.profileId}, unchanged constraints.`);
        assert.deepEqual(slot.input.task.constraints, f.task.constraints);
      }
      assert.deepEqual((await create(body)).comparison, first.comparison);
      assert.equal((await create(body)).idempotent, true);
      await request('POST', comparisons, { ...body, candidateVersion: 'different-release' }, 409);
      for (const invalid of [{ ...body, id: randomUUID(), caseIds: [] }, { ...body, id: randomUUID(), caseIds: [f.reviewCase.case.id, f.reviewCase.case.id] },
        { ...body, baselineVersion: body.candidateVersion }, { ...body, id: randomUUID(), dispatchBudget: 4 }, { ...body, id: randomUUID(), dispatchBudget: 14 },
        { ...body, id: randomUUID(), deadlineAt: new Date(Date.now() - 1000).toISOString() }, { ...body, id: randomUUID(), deadlineAt: new Date(Date.now() + 3601_000).toISOString() },
        { ...body, id: randomUUID(), caseIds: Array.from({ length: 11 }, () => randomUUID()) }, { ...body, plan }, { ...body, source: f.publication.suite },
        { ...body, mappingConfirmationIds: [] }, { ...body, latest: true }, { ...body, report: {} }]) await request('POST', comparisons, invalid, 400);
      await request('POST', comparisons, f.body({ suiteVersionId: randomUUID() }), 404);
      await request('POST', comparisons, f.body({ caseIds: [randomUUID()] }), 404);
      await request('POST', comparisons, ' '.repeat(65537), 413);
      for (const query of ['limit=0', 'limit=21', 'offset=-1', 'offset=10001', 'limit=1&extra=1', 'limit=1&limit=2']) await request('GET', `${comparisons}?${query}`, undefined, 400);
      const list = ComparisonListResponseSchema.parse((await request('GET', `${comparisons}?limit=1&offset=0`)).json());
      assert.equal(list.comparisons.length, 1); assert.equal('plan' in list.comparisons[0], false);
      assert.equal(ComparisonListResponseSchema.parse((await request('GET', `${comparisons}?limit=1&offset=1`)).json()).comparisons.length, 0);
      assert.equal((await pool.query('SELECT count(*) FROM public.comparison_targets WHERE comparison_id=$1', [plan.id])).rows[0].count, '12');
    });
    await t.test('exact local release binding, two fresh full-profile runs and mixed/unavailable mechanical outcomes', async () => {
      assert.equal(await claim(), null);
      assert.equal(await claim('unrelated-release'), null);
      assert.equal((await detail(plan.id)).comparison.progress.dispatches, 0);
      for (const role of ['baseline', 'candidate'] as const) {
        const release = role === 'baseline' ? body.baselineVersion : body.candidateVersion;
        const target = adapter(release, input => {
          if (role === 'baseline') return success(input.execution?.profileId === 'a' ? ['one', 'two'] : ['two', 'one']);
          if (input.execution?.profileId === 'a') return input.execution.repeat === 0 ? success(['two']) : input.execution.repeat === 1 ? malformed : unavailable;
          return input.execution?.repeat === 0 ? success([undefined]) : input.execution?.repeat === 1 ? success(['outside']) : success(['two', 'one']);
        });
        const outcomes = [];
        for (let i = 0; i < 6; i++) outcomes.push(await runOnce(client(release), target));
        assert.ok(outcomes.every(row => row.status === 'completed'));
        assert.equal(new Set(outcomes.map(row => row.status === 'completed' ? row.attemptId : '')).size, 6);
        assert.equal((await runOnce(client(release), target)).status, 'no_work');
      }
      const live = await detail(plan.id);
      assert.equal(live.comparison.progress.completed, 12); assert.equal(live.comparison.progress.dispatches, 12);
      assert.ok(live.associations.every(row => row.dispatchCount === 1));
      assert.deepEqual((await create(body)).comparison, first.comparison);
      const report = (await finalize(plan.id)).report;
      validateComparisonReportAgainstPlan(report, plan);
      assert.equal(report.completion, 'complete');
      const a = report.repeats.filter(row => row.role === 'candidate' && row.profileId === 'a');
      assert.deepEqual(a.map(row => row.outcome), ['pass', 'fail', 'unavailable']);
      assert.deepEqual(a[1].rules.map(row => row.outcome), ['fail', 'unavailable', 'unavailable']);
      assert.ok(a[2].rules.every(row => row.outcome === 'unavailable'));
      const b = report.repeats.filter(row => row.role === 'candidate' && row.profileId === 'b');
      assert.equal(b[0].outcome, 'unavailable'); assert.equal(b[1].outcome, 'fail');
      assert.ok(report.summaries.some(row => row.outcome === 'mixed' && row.disagreement));
      assert.ok(report.behaviorChanges.some(row => row.status === 'changed'));
      assert.ok(report.behaviorChanges.some(row => row.status === 'unchanged'));
      assert.ok(report.behaviorChanges.some(row => row.status === 'unavailable'));
      const retry = await finalize(plan.id, false, report.id);
      assert.equal(retry.idempotent, true); assert.deepEqual(retry.report, report);
      await request('POST', `${path}/finalize`, { ...v, id: report.id, allowPartial: true }, 409);
      await request('POST', `${path}/finalize`, { ...v, id: randomUUID(), allowPartial: false }, 409);
      await request('POST', `${path}/finalize`, { ...v, id: report.id, allowPartial: false, report }, 400);
      await request('POST', `${path}/cancel`, { ...v, id: randomUUID() }, 409);
    });
    await t.test('private read-only exports, frozen checksums, safe readable report and actual offline replay', async () => {
      const exported = await pack(plan.id);
      assert.deepEqual(await pack(plan.id), exported);
      const response = await fetch(`${origin}${path}/pack`, { headers: { authorization: 'Bearer synthetic-a' } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const downloaded: unknown = await response.json();
      assert.equal(validatePortableTestPack(downloaded).checksum, exported.checksum);
      const reportResponse = await request('GET', `${path}/report`);
      const report = validateComparisonReportAgainstPlan(reportResponse.json(), plan);
      const readable = await request('GET', `${path}/report.txt`);
      assert.ok(readable.headers['content-type']?.startsWith('text/plain'));
      assert.ok(readable.body.includes(report.checksum)); assert.ok(readable.body.includes('not proof of improved taste'));
      const all = canonicalJson({ pack: exported, report });
      for (const forbidden of ['rawText', 'validationErrors', 'Raw synthetic', 'providerAttempts', 'orderedEntryIds', 'events', 'token_hash', 'tc_runner_', 'sourceCode']) assert.equal(all.includes(forbidden), false);
      assert.ok(exported.plan.cases[0].evidenceReferences.every(row => row.checksum.length === 64 && row.providerStatus !== undefined));
      let calls = 0;
      const synthetic = adapter(body.baselineVersion, () => { calls++; return success(); });
      const replay = await replayComparisonRole({ pack: downloaded, role: 'baseline', assistantVersion: body.baselineVersion, adapter: synthetic, env: {}, expectedChecksum: exported.checksum });
      assert.equal(calls, 6); assert.equal(replay.comparisonReport.completion, 'partial');
      assert.equal(replay.comparisonReport.progress.completed, 6);
      assert.equal(canonicalJson(replay).includes('Raw synthetic'), false);
      for (const bad of [{ ...exported, checksum: '0'.repeat(64) }, { ...exported, pack_version: 'future' },
        { ...exported, plan: { ...exported.plan, slots: [] } }, { ...exported, rawProvider: {} }]) {
        await assert.rejects(replayComparisonRole({ pack: bad, role: 'baseline', assistantVersion: body.baselineVersion, adapter: synthetic, env: {} }));
      }
      await assert.rejects(replayComparisonRole({ pack: downloaded, role: 'baseline', assistantVersion: 'unbound', adapter: synthetic, env: {} }));
      assert.equal(calls, 6);
      await request('POST', `${base}/cases/${f.reviewCase.case.id}/reviews`, { ...v, id: randomUUID(), expectedRevision: 1, action: 'reject', rationale: 'Subsequent synthetic review must not rewrite history.' }, 201);
      assert.deepEqual(await pack(plan.id), exported);
      assert.deepEqual((await request('GET', `${path}/report`)).json(), report);
      const reopened = buildServer({ pool, auth });
      try {
        const reopenedResponse = await reopened.inject({ url: path, headers: { authorization: 'Bearer synthetic-a' } });
        assert.equal(reopenedResponse.statusCode, 200);
        assert.deepEqual(ComparisonDetailResponseSchema.parse(reopenedResponse.json()).comparison.finalReport, report);
        assert.equal((await reopened.inject({ url: `${path}/pack`, headers: { authorization: 'Bearer synthetic-a' } })).json().checksum, exported.checksum);
      } finally { await reopened.close(); }
    });
    await t.test('cancel preserves dispatched uploads; partial finalize waits honestly and immutable receipts stay historical', async () => {
      const req = f.body(); const run = await create(req); const url = `${comparisons}/${req.id}`;
      const originalPack = await pack(req.id);
      const lease = await claim(req.baselineVersion); assert.ok(lease);
      await request('POST', `${url}/finalize`, { ...v, id: randomUUID(), allowPartial: false }, 409);
      const cancelId = randomUUID();
      const receipt = ComparisonCreateResponseSchema.parse((await request('POST', `${url}/cancel`, { ...v, id: cancelId })).json());
      assert.equal(receipt.comparison.state, 'cancelled');
      assert.equal(await claim(req.baselineVersion), null);
      const partial = (await finalize(req.id, true)).report;
      assert.equal(partial.completion, 'partial'); assert.equal(partial.stopReason, 'cancelled');
      assert.ok(partial.repeats.every(row => row.outcome === 'unavailable'));
      await upload(lease, success());
      assert.equal((await detail(req.id)).comparison.progress.completed, 1);
      assert.deepEqual((await request('GET', `${url}/report`)).json(), partial);
      assert.deepEqual(ComparisonCreateResponseSchema.parse((await request('POST', `${url}/cancel`, { ...v, id: cancelId })).json()).comparison, receipt.comparison);
      assert.deepEqual((await create(req)).comparison, run.comparison);
      await request('POST', `${path}/cancel`, { ...v, id: cancelId }, 409);
      assert.deepEqual(await pack(req.id), originalPack);
    });
    await t.test('policy unavailable is never failure; order applies only with both IDs; advisory stays nonautomatic', async () => {
      for (const expectation of [policy, null]) {
        const fixtureRow = await fixture(expectation, 1);
        const req = fixtureRow.body(); await create(req);
        for (const role of ['baseline', 'candidate'] as const) {
          const release = role === 'baseline' ? req.baselineVersion : req.candidateVersion;
          const target = adapter(release, input => role === 'candidate' && input.execution?.profileId === 'a' ? unavailable : success(['one']));
          for (let i = 0; i < 2; i++) assert.equal((await runOnce(client(release), target)).status, 'completed');
        }
        const report = (await finalize(req.id)).report;
        if (expectation) {
          assert.equal(report.repeats.find(row => row.role === 'candidate' && row.profileId === 'a')?.outcome, 'unavailable');
          assert.equal(report.repeats.find(row => row.role === 'candidate' && row.profileId === 'b')?.outcome, 'not_applicable');
          assert.ok(report.repeats.some(row => row.rules.some(rule => rule.reason === 'both_ids_not_present')));
        } else assert.ok(report.repeats.every(row => row.outcome === 'advisory' && row.rules.every(rule => !rule.automaticFailure)));
      }
    });
    await t.test('persisted reclaim charges/uncertainty and atomic concurrent claims obey budget and exact lease fences', async () => {
      const small = await fixture(objective, 1);
      const req = small.body(); const run = await create(req); const slot = run.comparison.plan.slots[0]; const stale = randomUUID();
      await pool.query('SELECT public.reserve_comparison_dispatch($1,$2,$3,$4,1,$5)', [project.id, slot.attemptId, stale, runner.credential.id, req.baselineVersion]);
      await delay(1100);
      const claims = await Promise.all([claim(req.baselineVersion), claim(req.baselineVersion)]);
      assert.ok(claims.every(Boolean)); assert.notEqual(claims[0]?.attemptId, claims[1]?.attemptId);
      const reclaimed = claims.find(row => row?.attemptId === slot.attemptId); assert.ok(reclaimed);
      assert.notEqual(reclaimed.leaseId, stale);
      await request('POST', `/runner/attempts/${slot.attemptId}/results`, { ...v, leaseId: stale, result: success() }, 409, runner.token);
      for (const claim of claims) { assert.ok(claim); await upload(claim, success()); }
      for (let i = 0; i < 2; i++) assert.equal((await runOnce(client(req.candidateVersion), adapter(req.candidateVersion, () => success()))).status, 'completed');
      assert.equal(await claim(req.baselineVersion), null);
      const progress = (await detail(req.id)).comparison.progress;
      assert.equal(progress.dispatches, 5); assert.equal(progress.reclaims, 1); assert.equal(progress.uncertainDispatches, 1);
      const report = (await finalize(req.id)).report; assert.ok(report.limitations.includes('uncertain_dispatch'));
      const bounded = small.body({ dispatchBudget: 4, reclaimBudget: 0 }); const fixed = await create(bounded);
      await pool.query('SELECT public.reserve_comparison_dispatch($1,$2,$3,$4,1,$5)', [project.id, fixed.comparison.plan.slots[0].attemptId, randomUUID(), runner.credential.id, bounded.baselineVersion]);
      await delay(1100);
      assert.equal((await runOnce(client(bounded.baselineVersion), adapter(bounded.baselineVersion, () => success()))).status, 'completed');
      for (let i = 0; i < 2; i++) assert.equal((await runOnce(client(bounded.candidateVersion), adapter(bounded.candidateVersion, () => success()))).status, 'completed');
      assert.equal(await claim(bounded.baselineVersion), null);
      assert.equal((await detail(bounded.id)).comparison.state, 'budget_exhausted');
      const partial = (await finalize(bounded.id, true)).report;
      assert.equal(partial.progress.completed, 3); assert.equal(partial.progress.dispatches, 4); assert.equal(partial.stopReason, 'budget_exhausted');
    });
    await t.test('deadline stops claims without charging, while late dispatched execution remains structural evidence', async () => {
      const req = f.body({ deadlineAt: new Date(Date.now() + 2000).toISOString() }); await create(req);
      await delay(2100);
      assert.equal(await claim(req.baselineVersion), null);
      const live = await detail(req.id); assert.equal(live.comparison.state, 'deadline_exceeded'); assert.equal(live.comparison.progress.dispatches, 0);
      const report = (await finalize(req.id, true)).report; assert.equal(report.stopReason, 'deadline_exceeded');
      assert.ok(report.repeats.every(row => row.result.outcome === 'pending'));
      const inFlight = f.body({ deadlineAt: new Date(Date.now() + 2000).toISOString() }); await create(inFlight);
      const accepted = await claim(inFlight.baselineVersion); assert.ok(accepted);
      await delay(2100);
      assert.equal(await claim(inFlight.candidateVersion), null);
      await upload(accepted, success());
      const late = (await finalize(inFlight.id, true)).report;
      assert.equal(late.stopReason, 'deadline_exceeded'); assert.equal(late.progress.dispatches, 1);
      assert.equal(late.repeats.find(row => row.attemptId === accepted.attemptId)?.result.outcome, 'success');
    });
    await t.test('runtime-known required secrets reject creation/export without redaction or committing artifacts', async () => {
      const marker = 'synthetic-runtime-credential-marker-4';
      const unsafe = await fixture(objective, 1, marker);
      const req = unsafe.body();
      const prior = process.env.TASTECASE_GATE4_TEST_SECRET;
      process.env.TASTECASE_GATE4_TEST_SECRET = marker;
      try {
        await request('POST', comparisons, req, 409);
        assert.equal((await pool.query('SELECT count(*) FROM public.comparison_runs WHERE id=$1', [req.id])).rows[0].count, '0');
        // Previously safe pinned input becomes unsafe under current runtime secret knowledge.
        process.env.TASTECASE_GATE4_TEST_SECRET = 'different-synthetic-marker';
        await create(req);
        process.env.TASTECASE_GATE4_TEST_SECRET = marker;
        const failure = await request('GET', `${comparisons}/${req.id}/pack`, undefined, 409);
        assert.equal(failure.body.includes(marker), false);
        assert.equal((await pool.query("SELECT count(*) FROM public.comparison_artifacts WHERE comparison_id=$1 AND kind='pack'", [req.id])).rows[0].count, '1');
      } finally { if (prior === undefined) delete process.env.TASTECASE_GATE4_TEST_SECRET; else process.env.TASTECASE_GATE4_TEST_SECRET = prior; }
      await finalize(req.id, true);
    });
    await t.test('corrupt stored RPC artifacts and recomputed verdict tampering are safe conflicts and roll back mutations', async () => {
      let fault: 'pack' | 'finalize' | 'reserve' | 'busy' | null = 'pack';
      // Fault injection alters only returned data, not immutable rows, triggers or fixtures.
      const faultPool = { connect: async () => {
        const actual = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (fault === 'reserve' && sql.startsWith('SELECT public.reserve_comparison_dispatch')) return { rows: [{ value: false }] };
            if (fault === 'busy' && sql.startsWith('SELECT public.reserve_comparison_dispatch')) throw Object.assign(new Error('Synthetic private SQL diagnostic'), { code: '55P03' });
            const result = await actual.query<{ value: unknown }>(sql, values);
            const row = result.rows?.[0];
            if (row && fault === 'pack' && sql.startsWith('SELECT public.export_comparison_artifact') && values?.[3] === 'pack') {
              row.value = { ...validatePortableTestPack(row.value), checksum: '0'.repeat(64) };
            }
            if (row && fault === 'finalize' && sql.startsWith('SELECT public.finalize_comparison')) {
              const response = ComparisonFinalizeResponseSchema.parse(row.value);
              const { checksum: _checksum, ...content } = response.report; void _checksum;
              const forged = { ...content, repeats: content.repeats.map((repeat, i) => i === 0 ? { ...repeat, outcome: 'pass' } : repeat) };
              row.value = { ...response, report: { ...forged, checksum: checksum(forged) } };
            }
            return result;
          },
          release: () => actual.release(),
        };
      } } as unknown as pg.Pool;
      const faulty = buildServer({ pool: faultPool, auth, leaseDurationSeconds: 30 });
      async function rejected(method: 'GET' | 'POST', url: string, payload?: unknown, token = 'synthetic-a', expected = 409) {
        const response = await faulty.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload: JSON.stringify(payload) } : {}) });
        assert.equal(response.statusCode, expected);
        if (expected !== 204) {
          ApiErrorSchema.parse(response.json());
          assert.equal(response.body.includes('Synthetic private SQL diagnostic'), false);
        }
        return response;
      }
      const req = f.body();
      try {
        await rejected('POST', comparisons, req);
        assert.equal((await pool.query('SELECT count(*) FROM public.comparison_runs WHERE id=$1', [req.id])).rows[0].count, '0');
        fault = null; await create(req);
        fault = 'pack'; await rejected('GET', `${comparisons}/${req.id}/pack`);
        fault = 'finalize'; await rejected('POST', `${comparisons}/${req.id}/finalize`, { ...v, id: randomUUID(), allowPartial: true });
        assert.equal((await pool.query('SELECT count(*) FROM public.comparison_reports WHERE comparison_id=$1', [req.id])).rows[0].count, '0');
        assert.equal((await detail(req.id)).comparison.state, 'queued');
        // A reservation can lose a cancellation/budget race without delivering work or a charge.
        fault = 'reserve';
        await rejected('POST', '/runner/claims', { ...v, assistantVersion: req.baselineVersion }, runner.token, 204);
        assert.equal((await detail(req.id)).comparison.progress.dispatches, 0);
        fault = 'busy';
        await rejected('POST', '/runner/claims', { ...v, assistantVersion: req.baselineVersion }, runner.token, 503);
        assert.equal((await detail(req.id)).comparison.progress.dispatches, 0);
      } finally { await faulty.close(); }
      await finalize(req.id, true);
    });
    await t.test('same caller ID creation/finalization races return one immutable receipt and advance only once', async () => {
      const req = f.body();
      const creates = await Promise.all([create(req), create(req)]);
      assert.deepEqual(creates[0].comparison, creates[1].comparison);
      assert.deepEqual(creates.map(row => row.idempotent).sort(), [false, true]);
      assert.equal((await pool.query('SELECT count(*) FROM public.comparison_targets WHERE comparison_id=$1', [req.id])).rows[0].count, '12');
      const receiptId = randomUUID();
      const finals = await Promise.all([finalize(req.id, true, receiptId), finalize(req.id, true, receiptId)]);
      assert.deepEqual(finals[0].report, finals[1].report);
      assert.deepEqual(finals.map(row => row.idempotent).sort(), [false, true]);
      assert.equal((await pool.query('SELECT count(*) FROM public.comparison_reports WHERE comparison_id=$1', [req.id])).rows[0].count, '1');
      assert.deepEqual(await pack(req.id), await pack(req.id));
    });
    await t.test('unbound legacy foundation work remains claimable and no comparison slot is stolen', async () => {
      const id = randomUUID();
      await request('POST', `${base}/attempts`, { ...v, id, catalogVersionId: f.catalog.id, taskVersionId: f.task.id,
        mappingConfirmationIds: [], eligibleCatalogEntryIds: ['one', 'two'] }, 201);
      const lease = await claim(); assert.ok(lease); assert.equal(lease.attemptId, id); assert.equal(lease.input.execution, undefined);
      await upload(lease, success());
      assert.equal(await claim(), null);
      assert.equal((await app.inject('/ready')).statusCode, 200);
    });
  } finally {
    // Unique committed synthetic history stays intact; revoke credentials, never reset/delete fixtures.
    for (const id of credentialIds) await pool.query('UPDATE public.runner_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [id]);
    await app.close(); await pool.end();
  }
});
