// @vitest-environment node
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checksum, computeDiscoveryFacts, deriveSyntheticFullProfileInput, discoveryAttemptId, SCHEMA_VERSION } from '@tastecase/contracts';
import { buildServer } from '../../../../api/src/server';
import { assertLocalTestDatabase, runMigrations } from '../../../../api/src/migrate';
import { loadComparisonSuite, pinnedCaseEvidence } from '@/lib/view/comparison-evidence';
import { loadOwnerHistory } from '@/lib/view/owner-history';
import { loadProjectFacts, setupSteps } from '@/lib/view/project-facts';
import { createHttpApi, type HttpAuth } from './http';
import { proxyRequest } from './proxy';
import { ok, type ApiResult } from './result';
import type { CreateComparisonRequest, CreateDiscoveryJobRequest, DiscoveryJob, MintRunnerCredentialResponse, Project, PublishSuiteResponse, ReviewCaseResponse, ReviewDecisionResponse, SuiteIdentity } from './types';
import type { TasteCaseApi } from './port';

// Actual local database + backend receipts, with explicitly simulated provider evidence.
// This does NOT provision a product sample or exercise real Supabase/provider accounts.
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55432/tastecase_test';
assertLocalTestDatabase(databaseUrl);
const database = new URL(databaseUrl);
if (!process.env.CI && (database.hostname !== '127.0.0.1' || database.port !== '55432' || database.pathname !== '/tastecase_test')) throw new Error('Wiring tests require the guarded loopback test database.');
const v = { schema_version: SCHEMA_VERSION };
function receipt<T>(result: ApiResult<T>): T {
  expect(result.ok, 'A backend receipt is required; never log private response bodies.').toBe(true);
  if (!result.ok) throw new Error('Backend receipt unavailable.');
  return result.data;
}

describe('local backend → bounded proxy → production HTTP port', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  const owner = randomUUID(), other = randomUUID();
  const auth = { testVerifier: async (token: string) => token === 'synthetic-owner' ? owner : token === 'synthetic-other' ? other : null };
  const app = buildServer({ pool, auth });
  const upstreams: string[] = [];
  let origin: string;
  let api: TasteCaseApi;
  let project: Project;
  let runner: MintRunnerCredentialResponse;
  let job: DiscoveryJob;
  let reviewCase: ReviewCaseResponse;
  let approved: ReviewDecisionResponse;
  let suite: SuiteIdentity;
  let published: PublishSuiteResponse;
  let comparison: CreateComparisonRequest;
  let loseNextResponse = false;
  let lostReceiptStatus: number | undefined;
  const driver = (token = 'synthetic-owner'): HttpAuth => ({
    auth: {
      getSession: async () => ok({ userId: token === 'synthetic-owner' ? owner : other, email: null, expiresAt: null }),
      signInWithPassword: async () => { throw new Error('No real authentication in this local test.'); },
      completeAuthLink: async () => { throw new Error('No real authentication in this local test.'); },
      signOut: async () => ok(null),
    },
    authorization: vi.fn(async () => ok({ token, ownerId: token === 'synthetic-owner' ? owner : other })),
    epoch: () => 0, invalidate: vi.fn(),
  });
  const upstream: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(origin); // No arbitrary URL or live-provider dispatch.
    upstreams.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    return fetch(url, init);
  };
  const webFetch: typeof fetch = async (input, init) => {
    const result = await proxyRequest(new Request(`http://127.0.0.1:3100${String(input)}`, init), origin, upstream);
    if (loseNextResponse) {
      loseNextResponse = false;
      lostReceiptStatus = result.status;
      throw new Error('Simulated lost response after database commit.');
    }
    return result;
  };
  beforeAll(async () => {
    await runMigrations(pool, { databaseUrl, localTestBootstrap: true });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    api = createHttpApi(driver(), webFetch);
    project = receipt(await api.projects.create({ ...v, name: 'Fixture cross-layer private project' }));
    runner = receipt(await api.runnerCredentials.mint(project.id, 'Fixture local runner'));
  }, 20000);
  afterAll(async () => {
    try {
      if (job) await api.discovery.cancel(project.id, job.id);
      if (runner) await api.runnerCredentials.revoke(project.id, runner.credential.id);
    } finally { await app.close(); await pool.end(); }
  });

  it('keeps exact immutable catalog/task/mapping receipts across lost responses and conflicts', async () => {
    const body = { ...v, id: randomUUID(), label: 'Fixture dining catalog', entries: ['one', 'two'].map(id => ({ id, name: `Fixture restaurant ${id}` })) };
    loseNextResponse = true;
    expect(await api.catalogs.create(project.id, body)).toMatchObject({ ok: false, error: { kind: 'network' } });
    expect(lostReceiptStatus, 'Lose only a committed backend success receipt.').toBe(201);
    const catalog = receipt(await api.catalogs.create(project.id, body));
    expect(catalog.id).toBe(body.id);
    expect(receipt(await api.catalogs.get(project.id, body.id))).toEqual(catalog);
    expect(await api.catalogs.create(project.id, { ...body, label: 'Fixture changed body' })).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect((await pool.query('SELECT count(*)::int AS count FROM public.catalog_versions WHERE id=$1', [body.id])).rows[0].count).toBe(1);
    const task = receipt(await api.tasks.create(project.id, { ...v, id: randomUUID(), label: 'Fixture dining task', catalogVersionId: catalog.id,
      syntheticBrief: { provenance: 'synthetic', label: 'Fixture fictional diner', text: 'An explicitly fictional dining request.' }, syntheticInterests: [],
      constraints: { partySize: 2, dietaryRequirements: [], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: [] } }));
    const mappings = [];
    for (const catalogEntryId of ['one', 'two']) mappings.push(receipt(await api.mappings.create(project.id, { ...v, id: randomUUID(), catalogVersionId: catalog.id, catalogEntryId, qlooEntityId: randomUUID() })));
    expect(receipt(await api.tasks.get(project.id, task.id))).toEqual(task);
    expect(receipt(await api.mappings.get(project.id, mappings[0].id))).toEqual(mappings[0]);
    const profile = (id: 'a' | 'b'): CreateDiscoveryJobRequest['profiles'][number] => ({ id, label: `Fixture profile ${id}`, provenance: 'public_synthetic',
      anchors: [{ id: randomUUID(), kind: 'film', label: `Fixture public interest ${id}`, confirmedEntityId: randomUUID() }] });
    job = receipt(await api.discovery.create(project.id, { ...v, id: randomUUID(), catalogVersionId: catalog.id, taskVersionId: task.id,
      mappingConfirmationIds: mappings.map(row => row.id), eligibleCatalogEntryIds: ['one', 'two'], assistantVersion: 'Fixture discovery release', repeatCount: 1, reducePair: false,
      budgets: { qlooAttempts: 8, modelDecisions: 2, targetAttempts: 6, rounds: 3, deadlineSeconds: 900, outputBytes: 64000, retriesPerOperation: 1 },
      profiles: [profile('a'), profile('b')] }));
    expect(receipt(await api.discovery.get(project.id, job.id)).job.inputChecksum).toBe(job.inputChecksum);
  });

  it('requires an actual handshake receipt, not token issuance, and retains only historical status after revocation', async () => {
    expect(runner.credential.lastHandshakeAt).toBeNull();
    expect(setupSteps(receipt(await loadProjectFacts(api, project.id)))[0].done).toBe(false);
    // Runner operations bypass the browser proxy and stay owner-local.
    const response = await fetch(`${origin}/runner/handshake`, { method: 'POST', headers: { authorization: `Bearer ${runner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...v, runner: { name: 'Fixture runner', version: '1' }, adapter: { name: 'Fixture adapter', version: '1' }, supportedSchemaVersions: [SCHEMA_VERSION] }) });
    expect(response.status).toBe(200);
    const handshake = await response.json();
    const credentials = receipt(await api.runnerCredentials.list(project.id));
    expect(credentials[0].lastHandshakeAt).toBe(handshake.verifiedAt);
    expect(setupSteps(receipt(await loadProjectFacts(api, project.id)))[0]).toMatchObject({ done: true, detail: expect.stringContaining('offline or unknown') });
    expect(JSON.stringify(credentials)).not.toContain(runner.token);
  });

  it('preserves advisory evidence, review/publication receipts and exact comparison retries through every envelope', async () => {
    const rankIds: [string, string] = [randomUUID(), randomUUID()];
    const confirmations = receipt(await api.discovery.get(project.id, job.id)).confirmations;
    const ranks = (['a', 'b'] as const).map(profileId => ({ kind: 'rank' as const, profileId, scope: 'full' as const, providerStatus: 'partial' as const,
      requestedEntryIds: ['one', 'two'], orderedEntryIds: profileId === 'a' ? ['one', 'two'] : ['two', 'one'], missingEntryIds: [], unmappedEntryIds: [],
      mappingConfirmationIds: job.input.request.mappingConfirmationIds,
      anchorConfirmationIds: confirmations.filter(row => job.input.request.profiles.find(p => p.id === profileId)?.anchors.some(anchor => anchor.id === row.anchorId)).map(row => row.id) }));
    const facts = computeDiscoveryFacts(job.id, rankIds, ranks[0], ranks[1]);
    const factId = randomUUID();
    for (const [index, data] of [...ranks, facts].entries()) {
      const attemptId = index < 2 ? randomUUID() : null;
      // Explicit simulated persisted receipts; never genuine Qloo results or product sample provisioning.
      if (attemptId) await pool.query(`INSERT INTO public.discovery_provider_attempts(id,project_id,job_id,kind,operation_key,try_number,request_checksum,reserved_lease_id,status,dispatched_at,finished_at)
        VALUES($1,$2,$3,'qloo',$4,0,$5,$6,'accepted',clock_timestamp(),clock_timestamp())`, [attemptId, project.id, job.id, `Fixture rank ${index}`, checksum(data), randomUUID()]);
      await pool.query('INSERT INTO public.discovery_tool_evidence(id,project_id,job_id,data,checksum,captured_at,attempt_id) VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6)',
        [rankIds[index] ?? factId, project.id, job.id, JSON.stringify(data), checksum(data), attemptId]);
    }
    const brief = { ...job.input.targetInput.task.syntheticBrief, text: 'Fixture profile a dining request.' };
    const targetInput = deriveSyntheticFullProfileInput({ jobId: job.id, projectId: project.id, createdAt: job.createdAt,
      targetInput: job.input.targetInput, profile: job.input.request.profiles[0], brief });
    const task = targetInput.task;
    const { projectId: _projectId, checksum: taskChecksum, createdAt: taskCreatedAt, ...taskContent } = task;
    void _projectId;
    await pool.query('INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [task.id, project.id, task.catalogVersionId, JSON.stringify(taskContent), taskChecksum, taskCreatedAt]);
    const targetId = discoveryAttemptId(job.id, 'target:a:0:0:full', 0), leaseId = randomUUID();
    await pool.query('INSERT INTO public.target_attempts(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum) VALUES($1,$2,$3,$4,$5,$6)',
      [targetId, project.id, task.catalogVersionId, task.id, JSON.stringify(targetInput), checksum(targetInput)]);
    await pool.query("INSERT INTO public.discovery_job_targets(attempt_id,project_id,job_id,catalog_version_id,profile_id,round,repeat,variant) VALUES($1,$2,$3,$4,'a',0,0,'full')", [targetId, project.id, job.id, task.catalogVersionId]);
    await pool.query("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [targetId, leaseId, runner.credential.id]);
    expect((await fetch(`${origin}/runner/attempts/${targetId}/results`, { method: 'POST', headers: { authorization: `Bearer ${runner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...v, leaseId, result: { ...v, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'one', name: 'Fixture one' }] }, trace: { completeness: 'partial', events: [] } } }) })).status).toBe(200);
    const candidate = { contrast: facts.contrasts[0], briefs: { a: brief, b: { ...brief, text: 'Fixture profile b dining request.' }, constraints: task.constraints, eligibleCatalogEntryIds: ['one', 'two'] },
      evidenceIds: [...rankIds, factId], targetAttemptIds: [targetId], proposedExpectation: { classification: 'advisory', automaticFailure: false, humanReviewRequired: true,
        contrastId: facts.contrasts[0].id, rationale: 'Fixture advisory reversal, never a correctness verdict.' }, limitations: ['Explicit simulated execution; no live providers.'] };
    const candidateId = randomUUID();
    await pool.query('INSERT INTO public.discovery_candidates(id,project_id,job_id,content,checksum) VALUES($1,$2,$3,$4,$5)', [candidateId, project.id, job.id, JSON.stringify(candidate), checksum(candidate)]);
    await pool.query("UPDATE public.discovery_job_state SET state='partial',checkpoint=6,checkpoint_data=$2,target_attempts=1,revision=revision+1 WHERE job_id=$1", [job.id, JSON.stringify({ evidenceIds: [...rankIds, factId], candidateIds: [candidateId] })]);
    reviewCase = receipt(await api.cases.create(project.id, { ...v, id: randomUUID(), jobId: job.id, candidateId }));
    expect(receipt(await api.discovery.getEvidence(project.id, job.id, rankIds[0])).checksum).toBe(checksum(ranks[0]));
    expect(receipt(await api.discovery.getCandidate(project.id, job.id, candidateId)).content).toEqual(candidate);
    expect(receipt(await api.attempts.get(project.id, targetId)).result?.outcome).toBe('success');
    const reviewRequest = { ...v, id: randomUUID(), expectedRevision: 0, action: 'accept' as const, rationale: 'Fixture owner approved advisory only.' };
    loseNextResponse = true;
    expect(await api.cases.review(project.id, reviewCase.case.id, reviewRequest)).toMatchObject({ ok: false, error: { kind: 'network' } });
    expect(lostReceiptStatus).toBe(201);
    approved = receipt(await api.cases.review(project.id, reviewCase.case.id, reviewRequest));
    expect(approved.idempotent).toBe(true);
    expect(approved.review.expectationVersion?.expectation).toMatchObject({ classification: 'advisory', automaticFailure: false });
    expect(approved.review.decision.evidence.targets[0].attempt.result?.trace.completeness).toBe('partial');
    suite = receipt(await api.suites.create(project.id, { ...v, id: randomUUID(), name: 'Fixture immutable suite' }));
    const publication = { ...v, id: randomUUID(), suiteId: suite.id, expectedVersion: 0, cases: [{ caseId: reviewCase.case.id, expectationVersionId: approved.review.expectationVersion!.id, expectedReviewRevision: 1 }] };
    published = receipt(await api.suites.publish(project.id, suite.id, publication));
    expect(receipt(await api.suites.publish(project.id, suite.id, publication))).toEqual({ ...published, idempotent: true });
    comparison = { ...v, id: randomUUID(), suiteVersionId: published.suite.id, baselineVersion: 'Fixture baseline $(not-a-command)', candidateVersion: 'Fixture candidate exact v2',
      caseIds: [reviewCase.case.id], deadlineAt: new Date(Date.now() + 300000).toISOString(), dispatchBudget: 4, reclaimBudget: 0 };
    loseNextResponse = true;
    expect(await api.comparisons.create(project.id, comparison)).toMatchObject({ ok: false, error: { kind: 'network' } });
    expect(lostReceiptStatus).toBe(201);
    const created = receipt(await api.comparisons.create(project.id, comparison));
    expect(created.idempotent).toBe(true);
    expect(created.comparison.plan.request).toEqual(comparison);
    expect(await api.comparisons.create(project.id, { ...comparison, candidateVersion: 'Fixture changed label' })).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(receipt(await api.comparisons.pack(project.id, comparison.id)).plan).toEqual(created.comparison.plan);
    const finalized = receipt(await api.comparisons.finalize(project.id, comparison.id, { ...v, id: randomUUID(), allowPartial: true }));
    expect(finalized.report.completion).toBe('partial');
    expect(receipt(await api.comparisons.report(project.id, comparison.id))).toEqual(finalized.report);
    expect(receipt(await api.comparisons.readableReport(project.id, comparison.id))).toContain(comparison.candidateVersion);
    expect(receipt(await api.comparisons.get(project.id, comparison.id)).comparison.plan.checksum).toBe(created.comparison.plan.checksum);
  }, 30000);

  it('reads older history and exact frozen evidence after newer publications and a rejected current review', async () => {
    for (let version = 1; version <= 20; version++) receipt(await api.suites.publish(project.id, suite.id, { ...v, id: randomUUID(), suiteId: suite.id, expectedVersion: version,
      cases: [{ caseId: reviewCase.case.id, expectationVersionId: approved.review.expectationVersion!.id, expectedReviewRevision: 1 }] }));
    const versions = receipt(await loadOwnerHistory(window => api.suites.versions(project.id, suite.id, window)));
    expect(versions).toHaveLength(21);
    expect(versions.at(-1)).toEqual(published.suite);
    expect(receipt(await api.suites.version(project.id, suite.id, published.suite.id))).toEqual(published.suite);
    receipt(await api.cases.review(project.id, reviewCase.case.id, { ...v, id: randomUUID(), expectedRevision: 1, action: 'reject', rationale: 'Fixture later rejection cannot rewrite snapshots.' }));
    const history = receipt(await api.cases.history(project.id, reviewCase.case.id, { limit: 1, offset: 1 }));
    expect(history[0]).toEqual(approved.review);
    const plan = receipt(await api.comparisons.get(project.id, comparison.id)).comparison.plan;
    const start = upstreams.length;
    const frozen = receipt(await loadComparisonSuite(api, project.id, plan));
    expect(frozen).toEqual(published.suite);
    expect(pinnedCaseEvidence(frozen, plan.cases[0])).toEqual(approved.review.decision.evidence);
    expect(upstreams.slice(start).some(path => /discovery|cases/.test(path))).toBe(false);
    expect(await api.suites.version(project.id, suite.id, randomUUID())).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  }, 30000);

  it('keeps anonymous unavailable sample and private cross-owner errors separate, never empty success', async () => {
    const otherApi = createHttpApi(driver('synthetic-other'), webFetch);
    for (const result of [await otherApi.projects.get(project.id), await otherApi.cases.get(project.id, reviewCase.case.id), await otherApi.suites.version(project.id, suite.id, published.suite.id), await otherApi.comparisons.report(project.id, comparison.id)]) {
      expect(result).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    }
    const anonymous = driver();
    anonymous.authorization = vi.fn(async () => { throw new Error('Public sample must not access owner Auth.'); });
    expect(await createHttpApi(anonymous, webFetch).sample.getPublicSample()).toMatchObject({ ok: false, error: { kind: 'busy', message: 'Recorded public sample is unavailable.' } });
    expect(anonymous.authorization).not.toHaveBeenCalled();
    const before = upstreams.length;
    expect((await proxyRequest(new Request('http://127.0.0.1:3100/api/tastecase/public/sample?projectId=private'), origin, upstream)).status).toBe(400);
    expect(upstreams).toHaveLength(before);
  });

  it('passes an actual persisted public projection through the proxy without leases, owner identifiers or pinned private review evidence', async () => {
    const sampleServer = buildServer({ pool, auth: { testVerifier: async () => { throw new Error('Anonymous sample must not authenticate.'); } }, publicSample: { projectId: project.id, caseId: reviewCase.case.id, syntheticInputs: true } });
    try {
      const sampleOrigin = await sampleServer.listen({ host: '127.0.0.1', port: 0 });
      const sampleApi = createHttpApi(driver(), (input, init) => proxyRequest(new Request(`http://127.0.0.1:3100${String(input)}`, init), sampleOrigin, async (url, options) => {
        expect(new URL(String(url)).origin).toBe(sampleOrigin);
        expect(new Headers(options?.headers).has('authorization')).toBe(false);
        return fetch(url, options);
      }));
      const sample = receipt(await sampleApi.sample.getPublicSample());
      expect(sample.provenance).toBe('recorded');
      expect(sample.inputs).toBe('synthetic');
      expect(sample.capturedAt).toBe(sample.caseResponse.currentReview ? receipt(await api.cases.get(project.id, reviewCase.case.id)).currentReview!.decision.evidence.capturedAt : 'missing');
      const serialized = JSON.stringify(sample);
      for (const key of ['leaseId', 'leaseCredentialId', 'leaseExpiresAt', 'confirmedBy', 'reviewedBy', 'requestChecksum']) expect(serialized).not.toContain(`"${key}"`);
      expect(serialized).not.toContain(runner.token);
      expect(sample.caseResponse.currentReview!.decision).not.toHaveProperty('evidence');
      const revoked = receipt(await api.runnerCredentials.revoke(project.id, runner.credential.id));
      expect(revoked.lastHandshakeAt).not.toBeNull();
      expect(setupSteps(receipt(await loadProjectFacts(api, project.id)))[0].done).toBe(false);
    } finally { await sampleServer.close(); }
  });
});
