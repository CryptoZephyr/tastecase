import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {
  SCHEMA_VERSION, checksum, canonicalJson, CreateDiscoveryJobRequestSchema, DiscoveryJobSchema,
  DiscoveryJobListResponseSchema, DiscoveryJobDetailResponseSchema, DiscoveryAnchorConfirmationSchema,
  DiscoveryCandidateSchema, DiscoveryEvidenceSchema, ProjectSchema, CatalogVersionSchema, TaskVersionSchema,
  MappingConfirmationSchema, MintRunnerCredentialResponseSchema, ClaimAttemptResponseSchema, AttemptSchema,
  TargetResultSchema, computeDiscoveryFacts, discoveryAttemptId, type DiscoveryJob, type RankingEvidence, type MappingConfirmation,
} from '@tastecase/contracts';
import { buildServer } from '../server.js';
import { transaction } from '../db.js';
import { readDiscoveryDetail, readDiscoveryJob } from '../discovery-store.js';
import { runMigrations } from '../migrate.js';
import { buildBackend } from '../backend.js';
import { parseSelection, type WorkerAdapters } from '@tastecase/worker';
import { RunnerClient } from '../../../../packages/runner/src/client.js';

const databaseUrl = process.env.DATABASE_URL;
test('real PostgreSQL Gate 2 owner API and runner recovery', { skip: databaseUrl ? false : 'DATABASE_URL absent: discovery integration not run' }, async t => {
  if (!databaseUrl) return;
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/tastecase_test') throw new Error('Discovery integration requires the explicit local test DB.');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  const owners = { a: randomUUID(), b: randomUUID() };
  const auth = { testVerifier: async (token: string) => token === 'synthetic-a' ? owners.a : token === 'synthetic-b' ? owners.b : null };
  const app = buildServer({ pool, auth, leaseDurationSeconds: 30 });
  const v = { schema_version: SCHEMA_VERSION };
  const jobIds: string[] = [];
  let runnerCredentialId: string | null = null;
  let base = '';
  async function request(method: 'GET' | 'POST', path: string, payload?: unknown, expected = 200, token = 'synthetic-a') {
    const response = await app.inject({ method, url: path, headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
    assert.equal(response.statusCode, expected, `${method} ${path}: unexpected status; response deliberately not logged`);
    return response;
  }
  const detail = async (job: DiscoveryJob) => DiscoveryJobDetailResponseSchema.parse((await request('GET', `${base}/${job.id}`)).json());
  async function claim(job: DiscoveryJob, seconds = 60) {
    const lease = randomUUID();
    const result = await pool.query('SELECT * FROM public.claim_discovery_job($1,$2,$3)', [lease, seconds, job.projectId]);
    assert.equal(result.rows[0]?.job_id, job.id);
    return lease;
  }
  async function advance(job: DiscoveryJob, lease: string, state: string, checkpoint = 0, evidenceIds: string[] = [], candidateIds: string[] = [], release = false) {
    await pool.query('SELECT * FROM public.advance_discovery_job($1,$2,$3,$4,$5,$6,NULL,0,$7)',
      [job.projectId, job.id, lease, state, checkpoint, JSON.stringify({ evidenceIds, candidateIds }), release]);
  }
  async function put(job: DiscoveryJob, lease: string, data: unknown, id: string = randomUUID(), attemptId: string | null = null) {
    await pool.query('SELECT * FROM public.put_discovery_evidence($1,$2,$3,$4,$5,$6,$7)', [job.projectId, job.id, lease, id, attemptId, JSON.stringify(data), checksum(data)]);
    return id;
  }
  async function reserve(job: DiscoveryJob, lease: string, operation: string, tryNumber = 0, uncertain = false) {
    const id = discoveryAttemptId(job.id, operation, tryNumber);
    await pool.query("SELECT * FROM public.reserve_discovery_attempt($1,$2,$3,$4,'qloo',$5,$6,$7,$8)",
      [job.projectId, job.id, lease, id, operation, tryNumber, checksum(operation), uncertain]);
    return id;
  }
  try {
    await runMigrations(pool, { databaseUrl, localTestBootstrap: true });
    const project = ProjectSchema.parse((await request('POST', '/projects', { ...v, name: 'Synthetic Gate 2 API project' }, 201)).json());
    const other = ProjectSchema.parse((await request('POST', '/projects', { ...v, name: 'Synthetic other owner discovery' }, 201, 'synthetic-b')).json());
    base = `/projects/${project.id}/discovery-jobs`;
    const projectBase = `/projects/${project.id}`;
    const catalog = CatalogVersionSchema.parse((await request('POST', `${projectBase}/catalogs`, { ...v, id: randomUUID(), label: 'Synthetic discovery catalog',
      entries: [{ id: 'one', name: 'Synthetic One' }, { id: 'two', name: 'Synthetic Two' },
        { id: 'unmapped', name: 'Synthetic Unmapped', qlooEntityId: randomUUID() }, { id: 'excluded', name: 'Synthetic Excluded' }] }, 201)).json());
    const task = TaskVersionSchema.parse((await request('POST', `${projectBase}/tasks`, { ...v, id: randomUUID(), label: 'Fictional discovery lunch', catalogVersionId: catalog.id,
      syntheticBrief: { provenance: 'synthetic', label: 'Fictional lunch', text: 'An explicitly fictional lunch.' }, syntheticInterests: [],
      constraints: { partySize: 2, dietaryRequirements: ['vegetarian'], accessibilityRequirements: ['step-free'], requiredCuisines: [], excludedEntryIds: ['excluded'] } }, 201)).json());
    const mappings: MappingConfirmation[] = [];
    for (const catalogEntryId of ['one', 'two']) mappings.push(MappingConfirmationSchema.parse((await request('POST', `${projectBase}/mappings`,
      { ...v, id: randomUUID(), catalogVersionId: catalog.id, catalogEntryId, qlooEntityId: randomUUID() }, 201)).json()));
    const payload = CreateDiscoveryJobRequestSchema.parse({ ...v, id: randomUUID(), catalogVersionId: catalog.id, taskVersionId: task.id,
      mappingConfirmationIds: mappings.map(mapping => mapping.id), eligibleCatalogEntryIds: ['one', 'two', 'unmapped'], assistantVersion: 'synthetic-v1',
      profiles: [{ id: 'a', provenance: 'public_synthetic', label: 'Public A', anchors: [{ id: randomUUID(), label: 'Fictional public music', kind: 'music', confirmedEntityId: randomUUID() }] },
        { id: 'b', provenance: 'public_synthetic', label: 'Public B', anchors: [{ id: randomUUID(), label: 'Fictional public film', kind: 'film' }] }] });
    async function queue(overrides: Partial<typeof payload> = {}) {
      const body = { ...payload, id: randomUUID(), ...overrides };
      const job = DiscoveryJobSchema.parse((await request('POST', base, body, 201)).json());
      jobIds.push(job.id);
      return job;
    }
    const runner = MintRunnerCredentialResponseSchema.parse((await request('POST', `${projectBase}/runner-credentials`, { ...v, label: 'Synthetic discovery runner' }, 201)).json());
    runnerCredentialId = runner.credential.id;
    const targetResult = TargetResultSchema.parse({ ...v, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'one', name: 'Synthetic One' }] }, trace: { completeness: 'partial', events: [] } });
    const runnerRequest = (path: string, body: unknown = v, expected = 200) => request('POST', path, body, expected, runner.token);
    async function schedule(job: DiscoveryJob, lease: string, profile: 'a' | 'b', repeat = 0) {
      const id = discoveryAttemptId(job.id, `target:${profile}:0:${repeat}:full`, 0);
      await pool.query("SELECT * FROM public.schedule_discovery_target($1,$2,$3,$4,$5,$6,$7,$8,0,$9,'full')",
        [project.id, job.id, lease, id, task.id, JSON.stringify(job.input.targetInput), checksum(job.input.targetInput), profile, repeat]);
      return id;
    }

    await t.test('authoritative pinned versions/mappings, strict bounded bodies and conflict-safe queue retries', async () => {
      const job = await queue();
      assert.deepEqual(job.input.targetInput, { ...v, projectId: project.id, catalog, task, mappings, eligibleCatalogEntryIds: payload.eligibleCatalogEntryIds });
      assert.equal(job.counters.qlooAttempts, 0);
      assert.equal(job.input.targetInput.mappings.some(mapping => mapping.catalogEntryId === 'unmapped'), false);
      const [first, second] = await Promise.all([request('POST', base, job.input.request, 201), request('POST', base, job.input.request, 201)]);
      assert.deepEqual(first.json(), second.json());
      const concurrentBody = { ...payload, id: randomUUID() }; jobIds.push(concurrentBody.id);
      const concurrent = await Promise.all([request('POST', base, concurrentBody, 201), request('POST', base, concurrentBody, 201)]);
      assert.deepEqual(concurrent[0].json(), concurrent[1].json());
      await request('POST', `${base}/${concurrentBody.id}/cancel`, v);
      await request('POST', base, { ...job.input.request, assistantVersion: 'changed' }, 409);
      await request('POST', `/projects/${other.id}/discovery-jobs`, job.input.request, 404, 'synthetic-b');
      for (const injection of [{ ownerId: owners.b }, { input: job.input }, { counters: job.counters }, { leaseId: randomUUID() }, { targetUrl: 'https://synthetic.invalid' }]) {
        await request('POST', base, { ...payload, ...injection }, 400);
      }
      await request('POST', base, { ...payload, id: randomUUID(), mappingConfirmationIds: [randomUUID()] }, 404);
      await request('POST', base, { ...payload, id: randomUUID(), eligibleCatalogEntryIds: ['one', 'excluded'] }, 400);
      await request('POST', base, { ...payload, id: randomUUID(), eligibleCatalogEntryIds: ['one', 'outside'] }, 400);
      await request('POST', base, { ...payload, id: randomUUID(), profiles: [{ ...payload.profiles[0], provenance: 'real_history' }, payload.profiles[1]] }, 400);
      assert.equal((await app.inject({ method: 'POST', url: base, headers: { authorization: 'Bearer synthetic-a', 'content-type': 'application/json' }, payload: ' '.repeat(1048577) })).statusCode, 413);
      await request('POST', `${base}/${job.id}/cancel`, v);
      assert.equal(DiscoveryJobSchema.parse((await request('POST', base, job.input.request, 201)).json()).state, 'cancelled');
    });

    await t.test('owner isolation on every discovery read/mutation and bounded stable list windows', async () => {
      const one = await queue(); const two = await queue();
      const list = DiscoveryJobListResponseSchema.parse((await request('GET', `${base}?limit=1`)).json());
      const next = DiscoveryJobListResponseSchema.parse((await request('GET', `${base}?limit=1&offset=1`)).json());
      assert.equal(list.jobs[0]?.id, two.id); assert.equal(next.jobs[0]?.id, one.id);
      for (const query of ['limit=21', 'limit=0', 'limit=1&limit=2', 'offset=10001', 'offset=-1', 'ownerId=a']) await request('GET', `${base}?${query}`, undefined, 400);
      await request('GET', base, undefined, 401, 'unverified');
      for (const path of [base, `${base}/${one.id}`, `${base}/${one.id}/evidence/${randomUUID()}`, `${base}/${one.id}/candidates/${randomUUID()}`]) await request('GET', path, undefined, 404, 'synthetic-b');
      await request('POST', `${base}/${one.id}/cancel`, v, 404, 'synthetic-b');
      await request('POST', `${base}/${one.id}/confirmations`, { ...v, id: randomUUID(), anchorId: payload.profiles[1].anchors[0].id, resolutionId: randomUUID(), entityId: randomUUID() }, 404, 'synthetic-b');
      await request('GET', `${base}/${randomUUID()}`, undefined, 404);
      await request('POST', `${base}/${one.id}/cancel`, { ...v, state: 'queued' }, 400);
      await request('POST', `${base}/${one.id}/cancel`, v); await request('POST', `${base}/${two.id}/cancel`, v);
    });

    await t.test('needs_input requires observed same-anchor choice and resumes only after explicit owner confirmation', async () => {
      const job = await queue(); const lease = await claim(job); const anchor = payload.profiles[1].anchors[0];
      const choices = [{ entityId: randomUUID(), name: 'Fictional Film 1954', kind: 'film' }, { entityId: randomUUID(), name: 'Fictional Film 2001', kind: 'film' }];
      const evidenceId = await put(job, lease, { kind: 'resolve', providerStatus: 'needs_input', anchorId: anchor.id, candidates: choices });
      const resolutionId = randomUUID();
      await pool.query('INSERT INTO public.discovery_anchor_resolutions(id,project_id,job_id,anchor_id,evidence_id,candidates) VALUES($1,$2,$3,$4,$5,$6)', [resolutionId, project.id, job.id, anchor.id, evidenceId, JSON.stringify(choices)]);
      const body = { ...v, id: randomUUID(), anchorId: anchor.id, resolutionId, entityId: choices[0].entityId };
      await request('POST', `${base}/${job.id}/confirmations`, body, 409);
      await advance(job, lease, 'needs_confirmation', 0, [evidenceId], [], true);
      await request('POST', `${base}/${job.id}/confirmations`, { ...body, entityId: randomUUID() }, 400);
      await request('POST', `${base}/${job.id}/confirmations`, { ...body, anchorId: payload.profiles[0].anchors[0].id }, 404);
      await request('POST', `${base}/${job.id}/confirmations`, { ...body, confirmedBy: owners.b }, 400);
      const confirmation = DiscoveryAnchorConfirmationSchema.parse((await request('POST', `${base}/${job.id}/confirmations`, body, 201)).json());
      assert.equal(confirmation.confirmedBy, owners.a);
      const reopened = await detail(job);
      assert.equal(reopened.job.state, 'resolving'); assert.equal(reopened.job.leaseId, null);
      assert.deepEqual(reopened.job.checkpointData.evidenceIds, [evidenceId]);
      assert.equal(reopened.confirmations.length, 2);
      assert.deepEqual((await request('POST', `${base}/${job.id}/confirmations`, body, 201)).json(), confirmation);
      await request('POST', `${base}/${job.id}/confirmations`, { ...body, entityId: choices[1].entityId }, 409);
      await request('POST', `${base}/${job.id}/confirmations`, { ...body, id: randomUUID() }, 409);
      await request('POST', `${base}/${job.id}/cancel`, v);
    });

    await t.test('single resolved public anchors still require and accept explicit owner confirmation', async () => {
      for (const status of ['ok', 'partial'] as const) {
        const job = await queue(); const lease = await claim(job); const anchor = payload.profiles[1].anchors[0];
        const choices = [{ entityId: randomUUID(), name: 'Synthetic resolved film', kind: 'film' }];
        const evidenceId = await put(job, lease, { kind: 'resolve', providerStatus: status, anchorId: anchor.id, candidates: choices });
        const resolutionId = randomUUID();
        await pool.query('INSERT INTO public.discovery_anchor_resolutions(id,project_id,job_id,anchor_id,evidence_id,candidates) VALUES($1,$2,$3,$4,$5,$6)', [resolutionId, project.id, job.id, anchor.id, evidenceId, JSON.stringify(choices)]);
        await advance(job, lease, 'needs_confirmation', 0, [evidenceId], [], true);
        await request('POST', `${base}/${job.id}/confirmations`, { ...v, id: randomUUID(), anchorId: anchor.id, resolutionId, entityId: choices[0].entityId }, 201);
        assert.equal((await detail(job)).job.state, 'resolving');
        await request('POST', `${base}/${job.id}/cancel`, v);
      }
    });

    await t.test('saved advisory evidence/cases reopen through a fresh API and real loopback HTTP', async () => {
      const job = await queue(); const lease = await claim(job); const rankIds: [string, string] = [randomUUID(), randomUUID()];
      const ranks: RankingEvidence[] = ['a', 'b'].map((profile, index) => ({ kind: 'rank', providerStatus: 'partial', profileId: profile === 'a' ? 'a' : 'b', scope: 'full',
        requestedEntryIds: ['one', 'two'], orderedEntryIds: index === 0 ? ['one', 'two'] : ['two', 'one'], missingEntryIds: [], unmappedEntryIds: ['unmapped'],
        mappingConfirmationIds: mappings.map(mapping => mapping.id), anchorConfirmationIds: [] }));
      const a = ranks[0]; const b = ranks[1]; assert.ok(a && b);
      await put(job, lease, a, rankIds[0]); await put(job, lease, b, rankIds[1]);
      const facts = computeDiscoveryFacts(job.id, rankIds, a, b); const factsId = await put(job, lease, facts);
      const contrast = facts.contrasts[0]; assert.ok(contrast);
      const candidateId = randomUUID();
      const content = { contrast, briefs: { a: task.syntheticBrief, b: task.syntheticBrief, constraints: task.constraints, eligibleCatalogEntryIds: payload.eligibleCatalogEntryIds },
        evidenceIds: [...rankIds, factsId], targetAttemptIds: [], proposedExpectation: { classification: 'advisory', automaticFailure: false, humanReviewRequired: true,
          contrastId: contrast.id, rationale: 'An observed synthetic order reversal, not a taste failure.' }, limitations: ['Aggregate evidence only. Incomplete traces cannot prove missing tools.'] };
      await pool.query('SELECT * FROM public.put_discovery_candidate($1,$2,$3,$4,$5,$6)', [project.id, job.id, lease, candidateId, JSON.stringify(content), checksum(content)]);
      await advance(job, lease, 'awaiting_review', 6, [...rankIds, factsId], [candidateId], true);
      const before = await detail(job);
      const serviceRead = await transaction(pool, async client => {
        await client.query('SET LOCAL ROLE service_role');
        assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
        return readDiscoveryDetail(client, project.id, job.id);
      }, undefined, true);
      assert.deepEqual(serviceRead, before);
      assert.deepEqual(before.candidates[0]?.content.briefs.constraints, task.constraints);
      assert.deepEqual(before.evidence[0]?.data.kind, 'rank');
      assert.equal(DiscoveryEvidenceSchema.parse((await request('GET', `${base}/${job.id}/evidence/${factsId}`)).json()).checksum, checksum(facts));
      assert.equal(DiscoveryCandidateSchema.parse((await request('GET', `${base}/${job.id}/candidates/${candidateId}`)).json()).checksum, checksum(content));
      await request('GET', `${base}/${jobIds[0]}/candidates/${candidateId}`, undefined, 404);
      await request('GET', `${base}/${job.id}/evidence/${factsId}`, undefined, 404, 'synthetic-b');
      assert.equal(DiscoveryJobSchema.parse((await request('POST', `${base}/${job.id}/cancel`, v)).json()).state, 'awaiting_review');
      const reopened = buildServer({ pool, auth });
      try {
        const address = await reopened.listen({ host: '127.0.0.1', port: 0 });
        const response = await fetch(`${address}${base}/${job.id}`, { headers: { authorization: 'Bearer synthetic-a' }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(DiscoveryJobDetailResponseSchema.parse(await response.json()), before);
      } finally { await reopened.close(); }
    });

    await t.test('detail snapshot stays coherent during a concurrent cancellation without blocking writes', async () => {
      const job = await queue();
      await transaction(pool, async client => {
        const before = await readDiscoveryJob(client, project.id, job.id);
        await request('POST', `${base}/${job.id}/cancel`, v);
        assert.deepEqual(await readDiscoveryJob(client, project.id, job.id), before);
      }, undefined, true);
      assert.equal((await detail(job)).job.state, 'cancelled');
    });

    await t.test('restart retains accepted ranks, flagged backoff, auth failures and interrupted/uncertain reservations', async () => {
      const job = await queue({ budgets: { ...payload.budgets, qlooAttempts: 5 } }); let lease = await claim(job);
      const accepted = await reserve(job, lease, 'accepted-rank');
      await pool.query('SELECT * FROM public.dispatch_discovery_attempt($1,$2,$3,$4)', [project.id, job.id, lease, accepted]);
      const rank: RankingEvidence = { kind: 'rank', providerStatus: 'partial', profileId: 'a', scope: 'full', requestedEntryIds: ['one', 'two'], orderedEntryIds: ['one'],
        missingEntryIds: ['two'], unmappedEntryIds: ['unmapped'], mappingConfirmationIds: mappings.map(mapping => mapping.id), anchorConfirmationIds: [] };
      const evidenceId = await put(job, lease, rank, randomUUID(), accepted);
      await pool.query("SELECT * FROM public.finish_discovery_attempt($1,$2,$3,$4,'accepted')", [project.id, job.id, lease, accepted]);
      const backoff = await reserve(job, lease, 'rate-limit');
      await pool.query('SELECT * FROM public.dispatch_discovery_attempt($1,$2,$3,$4)', [project.id, job.id, lease, backoff]);
      await pool.query("SELECT * FROM public.finish_discovery_attempt($1,$2,$3,$4,'error',true,'transient','RATE_LIMIT',1)", [project.id, job.id, lease, backoff]);
      const authId = await reserve(job, lease, 'auth');
      await pool.query('SELECT * FROM public.dispatch_discovery_attempt($1,$2,$3,$4)', [project.id, job.id, lease, authId]);
      await pool.query("SELECT * FROM public.finish_discovery_attempt($1,$2,$3,$4,'error',false,'auth','AUTH')", [project.id, job.id, lease, authId]);
      const interrupted = await reserve(job, lease, 'never-dispatched'); const uncertain = await reserve(job, lease, 'lost-dispatch');
      await pool.query('SELECT * FROM public.dispatch_discovery_attempt($1,$2,$3,$4)', [project.id, job.id, lease, uncertain]);
      await advance(job, lease, 'ranking', 1, [evidenceId]);
      await pool.query('SELECT * FROM public.renew_discovery_lease($1,$2,$3,1)', [project.id, job.id, lease]);
      await delay(1100); const oldLease = lease; lease = await claim(job);
      const snapshot = await transaction(pool, client => readDiscoveryDetail(client, project.id, job.id));
      assert.equal(snapshot.job.counters.qlooAttempts, 5); assert.deepEqual(snapshot.job.checkpointData.evidenceIds, [evidenceId]);
      const statuses = new Map(snapshot.providerAttempts.map(attempt => [attempt.id, attempt]));
      assert.equal(statuses.get(accepted)?.status, 'accepted'); assert.equal(statuses.get(interrupted)?.status, 'interrupted');
      assert.equal(statuses.get(uncertain)?.status, 'uncertain'); assert.equal(statuses.get(authId)?.retryable, false);
      assert.ok(statuses.get(backoff)?.nextDispatchAt);
      await assert.rejects(reserve(job, lease, 'auth', 1));
      await assert.rejects(reserve(job, lease, 'rate-limit', 1)); // budget was not reset
      await assert.rejects(pool.query("SELECT * FROM public.finish_discovery_attempt($1,$2,$3,$4,'accepted')", [project.id, job.id, oldLease, uncertain]));
      await request('POST', `${base}/${job.id}/cancel`, v);
    });

    await t.test('runner cancellation stops unsent/reclaims but accepted in-flight results remain inspectable', async () => {
      const job = await queue(); const lease = await claim(job); const sent = await schedule(job, lease, 'a'); const unsent = await schedule(job, lease, 'b');
      await schedule(job, lease, 'a');
      assert.equal((await detail(job)).job.counters.targetAttempts, 2);
      const active = ClaimAttemptResponseSchema.parse((await runnerRequest('/runner/claims')).json()); assert.equal(active.attemptId, sent);
      await request('POST', `${base}/${job.id}/cancel`, v); await request('POST', `${base}/${job.id}/cancel`, v);
      await runnerRequest('/runner/claims', v, 204);
      const upload = { ...v, leaseId: active.leaseId, result: targetResult };
      await runnerRequest(`/runner/attempts/${sent}/results`, upload);
      await runnerRequest(`/runner/attempts/${sent}/results`, upload);
      await runnerRequest(`/runner/attempts/${sent}/results`, { ...upload, result: { ...targetResult, outcome: 'success', output: { recommendations: [] } } }, 409);
      const saved = await detail(job); assert.ok(saved.attempts.every(attempt => attempt.cancelled));
      assert.equal(saved.attempts.find(attempt => attempt.attemptId === sent)?.dispatchCount, 1);
      assert.equal(saved.attempts.find(attempt => attempt.attemptId === unsent)?.status, 'queued');
      assert.equal(AttemptSchema.parse((await request('GET', `${projectBase}/attempts/${sent}`)).json()).result?.trace.completeness, 'partial');
      await assert.rejects(schedule(job, lease, 'a', 1));
    });

    await t.test('concurrent discovery runner claims stay atomic and expired dispatch reclaims spend budget', async () => {
      const job = await queue({ budgets: { ...payload.budgets, targetAttempts: 2 } }); const lease = await claim(job); const id = await schedule(job, lease, 'a');
      await pool.query("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [id, randomUUID(), runner.credential.id]);
      await delay(1100);
      const responses = await Promise.all([app.inject({ method: 'POST', url: '/runner/claims', headers: { authorization: `Bearer ${runner.token}` }, payload: v }),
        app.inject({ method: 'POST', url: '/runner/claims', headers: { authorization: `Bearer ${runner.token}` }, payload: v })]);
      assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 204]);
      const winning = responses.find(response => response.statusCode === 200); assert.ok(winning);
      const active = ClaimAttemptResponseSchema.parse(winning.json());
      const saved = await detail(job); assert.equal(saved.job.counters.targetAttempts, 2);
      assert.equal(saved.attempts[0]?.dispatchCount, 2); assert.equal(saved.attempts[0]?.uncertainDispatches, 1);
      await runnerRequest(`/runner/attempts/${id}/results`, { ...v, leaseId: active.leaseId, result: targetResult });
      await request('POST', `${base}/${job.id}/cancel`, v);
    });

    await t.test('deadline/terminal discovery work is skipped without starving ordinary runner work', async () => {
      const job = await queue(); const lease = await claim(job); await schedule(job, lease, 'a');
      await advance(job, lease, 'no_useful_contrast', 2, [], [], true);
      await runnerRequest('/runner/claims', v, 204);
      assert.equal((await detail(job)).job.state, 'no_useful_contrast');
      // Old immutable clock fixtures exercise deadline filtering without editing or resetting history.
      const expiredId = randomUUID(); jobIds.push(expiredId);
      const expiredInput = { ...job.input, request: { ...job.input.request, id: expiredId, budgets: { ...job.input.request.budgets, deadlineSeconds: 30 } } };
      await pool.query(`WITH timing AS (SELECT clock_timestamp()-interval '31 seconds' AS now)
        INSERT INTO public.discovery_jobs(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at,deadline_at)
        SELECT $1,$2,$3,$4,$5,$6,now,now+interval '30 seconds' FROM timing`, [expiredId, project.id, catalog.id, task.id, JSON.stringify(expiredInput), checksum(expiredInput)]);
      const expiredAttemptId = randomUUID();
      await pool.query('INSERT INTO public.target_attempts(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum) VALUES($1,$2,$3,$4,$5,$6)', [expiredAttemptId, project.id, catalog.id, task.id, JSON.stringify(job.input.targetInput), checksum(job.input.targetInput)]);
      await pool.query("INSERT INTO public.discovery_job_targets(attempt_id,project_id,job_id,catalog_version_id,profile_id,round,repeat,variant) VALUES($1,$2,$3,$4,'a',0,0,'full')", [expiredAttemptId, project.id, expiredId, catalog.id]);
      await runnerRequest('/runner/claims', v, 204);
      const ordinary = AttemptSchema.parse((await request('POST', `${projectBase}/attempts`, { ...v, id: randomUUID(), catalogVersionId: catalog.id, taskVersionId: task.id,
        mappingConfirmationIds: payload.mappingConfirmationIds, eligibleCatalogEntryIds: payload.eligibleCatalogEntryIds }, 201)).json());
      const active = ClaimAttemptResponseSchema.parse((await runnerRequest('/runner/claims')).json()); assert.equal(active.attemptId, ordinary.id);
      await runnerRequest(`/runner/attempts/${ordinary.id}/results`, { ...v, leaseId: active.leaseId, result: targetResult });
      assert.equal(canonicalJson((await transaction(pool, client => readDiscoveryJob(client, project.id, expiredId))).input), canonicalJson(expiredInput));
    });
    await t.test('one persistent API/worker process resumes checkpoints and receives authorised HTTP runner results', async () => {
      const job = await queue({ repeatCount: 1, reducePair: false, profiles: [payload.profiles[0], {
        ...payload.profiles[1], anchors: payload.profiles[1].anchors.map(anchor => ({ ...anchor, confirmedEntityId: randomUUID() })),
      }] });
      let ranks = 0; let decisions = 0;
      const adapters: WorkerAdapters = {
        qloo: () => ({ resolve: async () => { throw new Error('All fixture anchors confirmed.'); }, close: async () => {},
          rank: async rank => {
            ranks++;
            const ordered = rank.options.map(option => option.entryId);
            if (rank.profileId === 'b') ordered.reverse();
            return { kind: 'rank', providerStatus: 'ok', profileId: rank.profileId, scope: rank.scope,
              requestedEntryIds: rank.options.map(option => option.entryId), orderedEntryIds: ordered, missingEntryIds: [],
              unmappedEntryIds: rank.unmappedEntryIds, mappingConfirmationIds: rank.options.map(option => option.confirmationId),
              anchorConfirmationIds: rank.anchors.map(anchor => anchor.confirmationId) };
          },
        }),
        decision: { select: async facts => { decisions++; return parseSelection({ selectedContrastId: facts.contrasts[0]?.id ?? null }, facts); } },
      };
      const makeBackend = () => buildBackend({ pool, auth, adapters, workerOptions: { projectId: project.id, pollMilliseconds: 25, heartbeatMilliseconds: 25 } });
      const waitFor = async (state: string) => {
        for (let i = 0; i < 200; i++) { const saved = await detail(job); if (saved.job.state === state && saved.job.leaseId === null) return saved; await delay(25); }
        throw new Error('Synthetic backend checkpoint not reached.');
      };
      const first = makeBackend();
      await first.app.listen({ host: '127.0.0.1', port: 0 });
      void first.startWorker();
      let saved: Awaited<ReturnType<typeof detail>>;
      try { saved = await waitFor('waiting_runner'); } finally { await first.app.close(); }
      const attemptIds = saved.attempts.map(attempt => attempt.attemptId).sort();
      assert.equal(attemptIds.length, 2);
      const second = makeBackend();
      try {
        const origin = await second.app.listen({ host: '127.0.0.1', port: 0 });
        void second.startWorker();
        assert.equal((await second.app.inject('/ready')).statusCode, 200);
        const client = new RunnerClient({ apiOrigin: origin, allowLoopbackHttp: true, env: { TASTECASE_RUNNER_TOKEN: runner.token } });
        await client.handshake({ name: 'explicit-synthetic-integration-adapter', version: '1' });
        for (let i = 0; i < 2; i++) {
          const work = await client.claim(); assert.ok(work); assert.ok(attemptIds.includes(work.attemptId));
          assert.deepEqual(work.input.task.constraints, job.input.targetInput.task.constraints);
          assert.deepEqual(work.input.eligibleCatalogEntryIds, job.input.targetInput.eligibleCatalogEntryIds);
          await client.uploadResult(work, targetResult);
        }
        assert.equal(await client.claim(), null);
        await pool.query('UPDATE public.discovery_job_state SET available_at=clock_timestamp(),revision=revision+1 WHERE job_id=$1', [job.id]);
        saved = await waitFor('partial'); // The intentional unmapped option remains unavailable.
        assert.deepEqual(saved.attempts.map(attempt => attempt.attemptId).sort(), attemptIds);
        assert.deepEqual(saved.job.counters, { qlooAttempts: 2, modelDecisions: 1, targetAttempts: 2, rounds: 1 });
        assert.equal(ranks, 2); assert.equal(decisions, 1);
        assert.equal(saved.candidates.length, 1);
        assert.equal(saved.candidates[0].content.proposedExpectation.automaticFailure, false);
        await request('GET', `${base}/${job.id}/candidates/${saved.candidates[0].id}`, undefined, 404, 'synthetic-b');
      } finally { await second.app.close(); }
      const reopened = buildServer({ pool, auth });
      try {
        const response = await reopened.inject({ url: `${base}/${job.id}`, headers: { authorization: 'Bearer synthetic-a' } });
        assert.deepEqual(DiscoveryJobDetailResponseSchema.parse(response.json()).candidates, saved.candidates);
      } finally { await reopened.close(); }
    });
  } finally {
    // Stop only this test's unique fixtures. Immutable synthetic history remains, never deleted.
    try {
      for (const jobId of jobIds) await pool.query('SELECT public.cancel_discovery_job(project_id,id) FROM public.discovery_jobs WHERE id=$1', [jobId]);
      if (runnerCredentialId) await pool.query('UPDATE public.runner_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [runnerCredentialId]);
    } finally { await app.close(); await pool.end(); }
  }
});
