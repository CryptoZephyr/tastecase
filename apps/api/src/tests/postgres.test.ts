import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg, { type PoolClient } from 'pg';
import {
  SCHEMA_VERSION, checksum, ApiErrorSchema, ProjectSchema, ProjectListResponseSchema,
  CatalogVersionSchema, CatalogVersionListResponseSchema, TaskVersionSchema, TaskVersionListResponseSchema,
  MappingConfirmationSchema, MappingConfirmationListResponseSchema, RunnerCredentialListResponseSchema,
  MintRunnerCredentialResponseSchema, RunnerHandshakeResponseSchema, ClaimAttemptResponseSchema,
  UploadTargetResultResponseSchema, AttemptSchema, AttemptListResponseSchema, TargetResultSchema,
  type CreateTaskVersionRequest,
} from '@tastecase/contracts';
import { buildServer } from '../server.js';
import { transaction } from '../db.js';
import { applyMigrations, bootstrapLocalTest, loadMigrations, runMigrations } from '../migrate.js';

const databaseUrl = process.env.DATABASE_URL;

test('real PostgreSQL Gate 1 API and database integration', { skip: databaseUrl ? false : 'DATABASE_URL absent: real PostgreSQL integration not run' }, async t => {
  if (!databaseUrl) return;
  const url = new URL(databaseUrl);
  if (!process.env.CI && (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/tastecase_test')) throw new Error('Integration tests require the local tastecase_test database (or a CI test DATABASE_URL).');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const app = buildServer({ pool, leaseDurationSeconds: 30, auth: { testVerifier: async token => token === 'synthetic-owner-a' ? ownerA : token === 'synthetic-owner-b' ? ownerB : null } });
  const v = { schema_version: SCHEMA_VERSION };
  // Migrations and unique synthetic history are committed for actual multi-connection concurrency.
  // No resets/deletes/disabled guards, unrelated rows or auth definitions are touched.
  async function request(method: 'GET' | 'POST', path: string, payload: unknown, token: string, expected = 200) {
    const response = await app.inject({ method, url: path, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }), headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) } });
    assert.equal(response.statusCode, expected, `${method} ${path}: unexpected HTTP status (response deliberately not logged)`);
    if (expected >= 400) ApiErrorSchema.parse(response.json());
    return response;
  }
  const a = (method: 'GET' | 'POST', path: string, payload?: unknown, expected = 200) => request(method, path, payload, 'synthetic-owner-a', expected);
  const b = (method: 'GET' | 'POST', path: string, payload?: unknown, expected = 200) => request(method, path, payload, 'synthetic-owner-b', expected);
  async function sqlFailure(client: PoolClient, sql: string, params: unknown[], code: string) {
    await client.query('SAVEPOINT expected_failure');
    try {
      await assert.rejects(client.query(sql, params), (error: unknown) => error instanceof Error && 'code' in error && error.code === code);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT expected_failure');
      await client.query('RELEASE SAVEPOINT expected_failure');
    }
  }
  try {
    const setup = await pool.connect();
    try {
      await setup.query('BEGIN');
      await setup.query("SELECT pg_advisory_xact_lock(hashtext('tastecase:migrations'))");
      // Explicit opt-in on the already safety-checked local/CI test database only.
      await bootstrapLocalTest(setup);
      await applyMigrations(setup, await loadMigrations());
      await setup.query('COMMIT');
    } catch (error) { await setup.query('ROLLBACK'); throw error; } finally { setup.release(); }

    await t.test('migration ledger skips applied DDL, verifies hashes and rolls failures back', async () => {
      assert.deepEqual(await runMigrations(pool), []);
      if (!process.env.CI) assert.deepEqual(await runMigrations(pool, { databaseUrl, localTestBootstrap: true }), []);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const migrations = await loadMigrations();
        const before = (await client.query("SELECT pg_get_functiondef('auth.uid()'::regprocedure) AS definition")).rows[0].definition;
        await assert.rejects(applyMigrations(client, migrations.map(migration => ({ ...migration, sql: `${migration.sql}\n-- changed` }))), /checksum changed/);
        await client.query('SAVEPOINT failed_migration');
        const name = '999999999999_synthetic_failure.sql';
        const table = `synthetic_migration_${randomUUID().replaceAll('-', '')}`;
        await assert.rejects(applyMigrations(client, [...migrations, { name, sql: `CREATE TABLE public.${table}(id integer); SELECT synthetic_missing_function();` }]));
        await client.query('ROLLBACK TO SAVEPOINT failed_migration');
        assert.equal((await client.query('SELECT name FROM public.tastecase_schema_migrations WHERE name=$1', [name])).rowCount, 0);
        assert.equal((await client.query('SELECT to_regclass($1) AS table_name', [`public.${table}`])).rows[0].table_name, null);
        assert.equal((await client.query("SELECT pg_get_functiondef('auth.uid()'::regprocedure) AS definition")).rows[0].definition, before);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });

    await t.test('aborted work rolls back before commit and transactions have SQL/time lock bounds', async () => {
      const id = randomUUID();
      const controller = new AbortController();
      await assert.rejects(transaction(pool, async client => {
        assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '5s');
        assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout, '3s');
        await client.query('INSERT INTO public.projects(id,owner_id,name) VALUES ($1,$2,$3)', [id, ownerA, 'Synthetic cancelled project']);
        controller.abort(new Error('Synthetic request cancellation'));
      }, controller.signal), /Synthetic request cancellation/);
      assert.equal((await pool.query('SELECT id FROM public.projects WHERE id=$1', [id])).rowCount, 0);
    });

    const projectA = ProjectSchema.parse((await a('POST', '/projects', { ...v, name: 'Synthetic API project A' }, 201)).json());
    const projectB = ProjectSchema.parse((await b('POST', '/projects', { ...v, name: 'Synthetic API project B' }, 201)).json());
    const baseA = `/projects/${projectA.id}`;
    const baseB = `/projects/${projectB.id}`;
    const catalogPayloadA = { ...v, id: randomUUID(), label: 'Synthetic catalog A', entries: [{ id: 'synthetic-one', name: 'Synthetic Cafe', qlooEntityId: randomUUID() }, { id: 'synthetic-two', name: 'Synthetic Bistro' }] };
    const catalogA = CatalogVersionSchema.parse((await a('POST', `${baseA}/catalogs`, catalogPayloadA, 201)).json());
    const catalogB = CatalogVersionSchema.parse((await b('POST', `${baseB}/catalogs`, { ...catalogPayloadA, id: randomUUID(), label: 'Synthetic catalog B' }, 201)).json());
    const taskPayloadA: CreateTaskVersionRequest = {
      ...v, id: randomUUID(), label: 'Synthetic fictional lunch', catalogVersionId: catalogA.id,
      syntheticBrief: { provenance: 'synthetic', label: 'Fictional brief', text: 'An imaginary guest wants lunch.' }, syntheticInterests: [],
      constraints: { partySize: 2, dietaryRequirements: [], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: ['synthetic-two'] },
    };
    const taskA = TaskVersionSchema.parse((await a('POST', `${baseA}/tasks`, taskPayloadA, 201)).json());
    const taskB = TaskVersionSchema.parse((await b('POST', `${baseB}/tasks`, { ...taskPayloadA, id: randomUUID(), catalogVersionId: catalogB.id }, 201)).json());
    const mappingPayloadA = { ...v, id: randomUUID(), catalogVersionId: catalogA.id, catalogEntryId: 'synthetic-one', qlooEntityId: randomUUID() };
    const mappingA = MappingConfirmationSchema.parse((await a('POST', `${baseA}/mappings`, mappingPayloadA, 201)).json());
    const mappingB = MappingConfirmationSchema.parse((await b('POST', `${baseB}/mappings`, { ...mappingPayloadA, id: randomUUID(), catalogVersionId: catalogB.id }, 201)).json());
    const mintedA = MintRunnerCredentialResponseSchema.parse((await a('POST', `${baseA}/runner-credentials`, { ...v, label: 'Synthetic local runner' }, 201)).json());
    const mintedOtherA = MintRunnerCredentialResponseSchema.parse((await a('POST', `${baseA}/runner-credentials`, { ...v, label: 'Synthetic second runner' }, 201)).json());
    const mintedB = MintRunnerCredentialResponseSchema.parse((await b('POST', `${baseB}/runner-credentials`, { ...v, label: 'Synthetic project B runner' }, 201)).json());
    const runnerA = (path: string, payload: unknown = v, expected = 200) => request('POST', path, payload, mintedA.token, expected);
    const queuePayload = (id = randomUUID()) => ({ ...v, id, catalogVersionId: catalogA.id, taskVersionId: taskA.id, mappingConfirmationIds: [mappingA.id], eligibleCatalogEntryIds: ['synthetic-one'] });
    const queue = async () => AttemptSchema.parse((await a('POST', `${baseA}/attempts`, queuePayload(), 201)).json());
    const syntheticResult = TargetResultSchema.parse({ ...v, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'outside-synthetic-catalog', name: 'Outside Synthetic Cafe' }] }, trace: { completeness: 'unavailable', events: [] } });
    const attemptB = AttemptSchema.parse((await b('POST', `${baseB}/attempts`, { ...v, id: randomUUID(), catalogVersionId: catalogB.id, taskVersionId: taskB.id, mappingConfirmationIds: [mappingB.id], eligibleCatalogEntryIds: ['synthetic-one'] }, 201)).json());

    await t.test('owner A/B isolation, no owner-header trust and strict request validation', async () => {
      assert.equal(projectA.ownerId, ownerA);
      const list = ProjectListResponseSchema.parse((await a('GET', '/projects')).json());
      assert.ok(list.projects.some(project => project.id === projectA.id));
      assert.ok(!list.projects.some(project => project.id === projectB.id));
      await b('GET', baseA, undefined, 404);
      for (const route of ['catalogs', 'tasks', 'mappings', 'runner-credentials', 'attempts']) await b('GET', `${baseA}/${route}`, undefined, 404);
      await b('POST', `${baseA}/runner-credentials/${mintedA.credential.id}/revoke`, v, 404);
      await a('GET', `${baseA}/catalogs/${catalogB.id}`, undefined, 404);
      await a('GET', `${baseA}/tasks/${taskB.id}`, undefined, 404);
      await a('GET', `${baseA}/mappings/${mappingB.id}`, undefined, 404);
      await a('POST', '/projects', { ...v, name: 'Synthetic invalid', ownerId: ownerB }, 400);
      await a('POST', `${baseA}/catalogs`, { ...catalogPayloadA, targetUrl: 'https://synthetic.invalid' }, 400);
      await a('POST', `${baseA}/tasks`, { ...taskPayloadA, sourceCode: 'synthetic forbidden' }, 400);
      await a('POST', `${baseA}/tasks`, { ...taskPayloadA, id: randomUUID(), catalogVersionId: catalogB.id }, 404);
      await a('POST', `${baseA}/tasks`, { ...taskPayloadA, id: randomUUID(), constraints: { ...taskPayloadA.constraints, excludedEntryIds: ['unknown'] } }, 400);
      await a('POST', `${baseA}/mappings`, { ...mappingPayloadA, id: randomUUID(), catalogVersionId: catalogB.id }, 404);
      await a('GET', '/projects/not-a-uuid', undefined, 400);
      const headerOnly = await app.inject({ method: 'GET', url: '/projects', headers: { 'x-owner-id': ownerA } });
      assert.equal(headerOnly.statusCode, 401);
    });

    await t.test('versions and explicit mapping confirmations are immutable, scoped and duplicate-aware', async () => {
      assert.equal(checksum(catalogPayloadA), catalogA.checksum);
      assert.equal(checksum(taskPayloadA), taskA.checksum);
      assert.equal(mappingA.confirmedBy, ownerA);
      await a('POST', `${baseA}/catalogs`, catalogPayloadA, 201);
      await a('POST', `${baseA}/catalogs`, { ...catalogPayloadA, label: 'Synthetic collision' }, 409);
      await b('POST', `${baseB}/catalogs`, catalogPayloadA, 409);
      await a('POST', `${baseA}/tasks`, taskPayloadA, 201);
      await a('POST', `${baseA}/tasks`, { ...taskPayloadA, label: 'Synthetic collision' }, 409);
      await a('POST', `${baseA}/mappings`, mappingPayloadA, 201);
      await a('POST', `${baseA}/mappings`, { ...mappingPayloadA, qlooEntityId: randomUUID() }, 409);
      await a('POST', `${baseA}/mappings`, { ...mappingPayloadA, id: randomUUID() }, 409);
      assert.deepEqual(ProjectSchema.parse((await a('GET', baseA)).json()), projectA);
      assert.deepEqual(CatalogVersionSchema.parse((await a('GET', `${baseA}/catalogs/${catalogA.id}`)).json()), catalogA);
      assert.deepEqual(TaskVersionSchema.parse((await a('GET', `${baseA}/tasks/${taskA.id}`)).json()), taskA);
      assert.deepEqual(MappingConfirmationSchema.parse((await a('GET', `${baseA}/mappings/${mappingA.id}`)).json()), mappingA);
      CatalogVersionListResponseSchema.parse((await a('GET', `${baseA}/catalogs`)).json());
      TaskVersionListResponseSchema.parse((await a('GET', `${baseA}/tasks`)).json());
      MappingConfirmationListResponseSchema.parse((await a('GET', `${baseA}/mappings`)).json());
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [table, id] of [['catalog_versions', catalogA.id], ['task_versions', taskA.id], ['mapping_confirmations', mappingA.id]]) {
          await sqlFailure(client, `UPDATE public.${table} SET created_at=created_at WHERE id=$1`, [id], '23514');
        }
        const id = randomUUID();
        const content = { ...taskPayloadA, id, constraints: { ...taskPayloadA.constraints, excludedEntryIds: [] } };
        await sqlFailure(client, 'INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum) VALUES ($1,$2,$3,$4,$5)', [id, projectB.id, catalogA.id, JSON.stringify(content), checksum(content)], '23503');
        await sqlFailure(client, 'INSERT INTO public.mapping_confirmations(id,project_id,catalog_version_id,catalog_entry_id,qloo_entity_id,confirmed_by) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), projectB.id, catalogA.id, 'synthetic-one', randomUUID(), ownerB], '23514');
      } finally { await client.query('ROLLBACK'); client.release(); }
    });

    await t.test('credential mint is one-time, 256-bit, SHA256-scoped and absent from reads', async () => {
      assert.ok(/^tc_runner_[A-Za-z0-9_-]{43}$/.test(mintedA.token));
      assert.equal(Buffer.from(mintedA.token.slice('tc_runner_'.length), 'base64url').length, 32);
      assert.ok(mintedA.token !== mintedOtherA.token);
      const stored = await pool.query<{ token_hash: string }>('SELECT token_hash FROM public.runner_credentials WHERE id=$1', [mintedA.credential.id]);
      assert.ok(stored.rows[0].token_hash === createHash('sha256').update(mintedA.token).digest('hex'));
      const response = await a('GET', `${baseA}/runner-credentials`);
      RunnerCredentialListResponseSchema.parse(response.json());
      assert.ok(!response.body.includes(mintedA.token) && !response.body.includes('token_hash'));
      const ready = await app.inject({ method: 'GET', url: '/ready' });
      assert.equal(ready.statusCode, 200);
      assert.deepEqual(ready.json(), { status: 'ready' });
    });

    await t.test('handshake checks current credentials, schema compatibility and forbidden scope fields', async () => {
      const handshake = { ...v, runner: { name: 'synthetic-local', version: '1' }, adapter: { name: 'synthetic-fixture', version: '1' }, supportedSchemaVersions: [SCHEMA_VERSION] };
      const response = RunnerHandshakeResponseSchema.parse((await runnerA('/runner/handshake', handshake)).json());
      assert.equal(response.projectId, projectA.id);
      assert.equal(response.credentialId, mintedA.credential.id);
      assert.equal(response.leaseDurationSeconds, 30);
      await runnerA('/runner/handshake', { ...handshake, schema_version: '0.0.0' }, 400);
      await runnerA('/runner/handshake', { ...handshake, supportedSchemaVersions: ['0.0.0'] }, 400);
      await runnerA('/runner/claims', { ...v, projectId: projectB.id }, 400);
      await request('POST', '/runner/claims', v, 'tc_runner_' + 'x'.repeat(43), 401);
      const claimB = ClaimAttemptResponseSchema.parse((await request('POST', '/runner/claims', v, mintedB.token)).json());
      assert.equal(claimB.attemptId, attemptB.id);
      assert.equal(claimB.input.projectId, projectB.id);
      await runnerA(`/runner/attempts/${attemptB.id}/results`, { ...v, leaseId: claimB.leaseId, result: syntheticResult }, 404);
      await request('POST', `/runner/attempts/${attemptB.id}/results`, { ...v, leaseId: claimB.leaseId, result: syntheticResult }, mintedB.token);
    });

    let completedAttemptId = '';
    let completedLeaseId = '';
    await t.test('queue pins full records, rejects cross-project references and conflicting attempt IDs', async () => {
      const payload = queuePayload();
      const attempt = AttemptSchema.parse((await a('POST', `${baseA}/attempts`, payload, 201)).json());
      completedAttemptId = attempt.id;
      assert.deepEqual(attempt.input.catalog, catalogA);
      assert.deepEqual(attempt.input.task, taskA);
      assert.deepEqual(attempt.input.mappings, [mappingA]);
      assert.equal(attempt.inputChecksum, checksum(attempt.input));
      assert.equal(attempt.status, 'queued');
      await a('POST', `${baseA}/attempts`, payload, 201);
      await a('POST', `${baseA}/attempts`, { ...payload, eligibleCatalogEntryIds: [] }, 409);
      await a('POST', `${baseA}/attempts`, { ...queuePayload(), taskVersionId: taskB.id }, 404);
      await a('POST', `${baseA}/attempts`, { ...queuePayload(), catalogVersionId: catalogB.id }, 404);
      await a('POST', `${baseA}/attempts`, { ...queuePayload(), mappingConfirmationIds: [mappingB.id] }, 404);
      await a('POST', `${baseA}/attempts`, { ...queuePayload(), mappingConfirmationIds: [mappingA.id, mappingA.id] }, 400);
      await a('POST', `${baseA}/attempts`, { ...queuePayload(), eligibleCatalogEntryIds: ['synthetic-two'] }, 400);
      await b('GET', `${baseA}/attempts/${attempt.id}`, undefined, 404);
      const claim = ClaimAttemptResponseSchema.parse((await runnerA('/runner/claims')).json());
      completedLeaseId = claim.leaseId;
      assert.equal(claim.attemptId, attempt.id);
      assert.deepEqual(claim.input, attempt.input);
      assert.ok(new Date(claim.leaseExpiresAt).getTime() <= Date.now() + 30000);
    });

    await t.test('exact duplicate result uploads are idempotent, conflicts/stale/wrong credentials fail', async () => {
      const path = `/runner/attempts/${completedAttemptId}/results`;
      const payload = { ...v, leaseId: completedLeaseId, result: syntheticResult };
      await request('POST', path, payload, mintedB.token, 404);
      await request('POST', path, payload, mintedOtherA.token, 409);
      await runnerA(path, { ...payload, leaseId: randomUUID() }, 409);
      await runnerA(path, { ...payload, projectId: projectA.id }, 400);
      await runnerA(path, { ...payload, result: { ...v, outcome: 'success', output: { recommendations: [] } } }, 400);
      const first = UploadTargetResultResponseSchema.parse((await runnerA(path, payload)).json());
      assert.equal(first.idempotent, false);
      assert.equal(first.resultChecksum, checksum(syntheticResult));
      // A differently ordered object hashes identically: canonical JSON, not wire bytes/jsonb text.
      const reordered = { trace: syntheticResult.trace, output: { recommendations: [{ name: 'Outside Synthetic Cafe', catalogEntryId: 'outside-synthetic-catalog' }] }, outcome: 'success', schema_version: SCHEMA_VERSION };
      const repeat = UploadTargetResultResponseSchema.parse((await runnerA(path, { ...payload, result: reordered })).json());
      assert.equal(repeat.idempotent, true);
      assert.equal(repeat.resultChecksum, first.resultChecksum);
      await runnerA(path, { ...payload, result: { ...syntheticResult, output: { recommendations: [] } } }, 409);
      const stored = AttemptSchema.parse((await a('GET', `${baseA}/attempts/${completedAttemptId}`)).json());
      assert.deepEqual(stored.result, syntheticResult);
      AttemptListResponseSchema.parse((await a('GET', `${baseA}/attempts`)).json());
    });

    await t.test('actual parallel connections cannot double claim; SKIP LOCKED skips held rows', async () => {
      const first = await queue();
      const lock = await pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT id FROM public.target_attempts WHERE id=$1 FOR UPDATE', [first.id]);
        const second = await queue();
        const responses = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: 'POST', url: '/runner/claims', payload: v, headers: { authorization: `Bearer ${mintedA.token}` } })));
        assert.equal(responses.filter(response => response.statusCode === 200).length, 1);
        assert.equal(responses.filter(response => response.statusCode === 204 && response.body === '').length, 19);
        const claimed = responses.find(response => response.statusCode === 200);
        assert.ok(claimed);
        const claim = ClaimAttemptResponseSchema.parse(claimed.json());
        assert.equal(claim.attemptId, second.id);
        const uploads = await Promise.all(Array.from({ length: 10 }, () => runnerA(`/runner/attempts/${claim.attemptId}/results`, { ...v, leaseId: claim.leaseId, result: syntheticResult })));
        const uploaded = uploads.map(response => UploadTargetResultResponseSchema.parse(response.json()));
        assert.equal(uploaded.filter(result => !result.idempotent).length, 1);
        assert.equal(uploaded.filter(result => result.idempotent).length, 9);
      } finally { await lock.query('ROLLBACK'); lock.release(); }
      const claim = ClaimAttemptResponseSchema.parse((await runnerA('/runner/claims')).json());
      assert.equal(claim.attemptId, first.id);
      await runnerA(`/runner/attempts/${claim.attemptId}/results`, { ...v, leaseId: claim.leaseId, result: syntheticResult });
    });

    await t.test('malformed output, provider unavailable and incomplete trace remain distinct records', async () => {
      for (const result of [
        { ...v, outcome: 'malformed_output', rawText: '{', error: { code: 'synthetic_parse', message: 'Synthetic invalid JSON' }, trace: { completeness: 'partial', events: [{ kind: 'target_started' }] } },
        { ...v, outcome: 'provider_unavailable', retryable: true, error: { code: 'synthetic_unavailable', message: 'Synthetic provider unavailable' }, trace: { completeness: 'unavailable', events: [] } },
      ]) {
        const attempt = await queue();
        const claim = ClaimAttemptResponseSchema.parse((await runnerA('/runner/claims')).json());
        await runnerA(`/runner/attempts/${attempt.id}/results`, { ...v, leaseId: claim.leaseId, result });
        const stored = AttemptSchema.parse((await a('GET', `${baseA}/attempts/${attempt.id}`)).json());
        assert.deepEqual(stored.result, result);
        assert.equal(stored.status, 'completed');
        assert.ok(!('failureClassification' in stored));
      }
    });

    await t.test('authenticated-role RLS, immutable pinned state and database cross-project FKs', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE authenticated');
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ownerA]);
        assert.equal((await client.query('SELECT id FROM public.projects WHERE id=$1', [projectA.id])).rowCount, 1);
        assert.equal((await client.query('SELECT id FROM public.projects WHERE id=$1', [projectB.id])).rowCount, 0);
        for (const table of ['catalog_versions', 'task_versions', 'mapping_confirmations', 'target_attempts', 'target_attempt_mappings']) assert.equal((await client.query(`SELECT project_id FROM public.${table} WHERE project_id=$1`, [projectB.id])).rowCount, 0);
        assert.equal((await client.query('SELECT id FROM public.runner_credentials WHERE project_id=$1', [projectB.id])).rowCount, 0);
        await sqlFailure(client, 'SELECT token_hash FROM public.runner_credentials', [], '42501');
        await sqlFailure(client, 'SELECT name FROM public.tastecase_schema_migrations', [], '42501');
        await sqlFailure(client, "UPDATE public.target_attempts SET status='queued' WHERE id=$1", [completedAttemptId], '42501');
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ownerB]);
        assert.equal((await client.query('SELECT id FROM public.target_attempts WHERE id=$1', [completedAttemptId])).rowCount, 0);
        assert.equal((await client.query('SELECT id FROM public.target_attempts WHERE id=$1', [attemptB.id])).rowCount, 1);
        await client.query('RESET ROLE');
        await sqlFailure(client, 'UPDATE public.target_attempts SET input_checksum=$2 WHERE id=$1', [completedAttemptId, '0'.repeat(64)], '23514');
        await sqlFailure(client, 'INSERT INTO public.target_attempt_mappings(project_id,attempt_id,catalog_version_id,mapping_confirmation_id) VALUES ($1,$2,$3,$4)', [projectB.id, completedAttemptId, catalogA.id, mappingB.id], '23503');
        const record = AttemptSchema.parse((await a('GET', `${baseA}/attempts/${completedAttemptId}`)).json());
        await sqlFailure(client, 'INSERT INTO public.target_attempts(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), projectB.id, catalogA.id, taskA.id, JSON.stringify(record.input), record.inputChecksum], '23503');
      } finally { await client.query('ROLLBACK'); client.release(); }
    });

    await t.test('expired leases reject uploads/retries and reclaim issues a fresh identity', async () => {
      const attempt = await queue();
      const oldClaim = ClaimAttemptResponseSchema.parse((await runnerA('/runner/claims')).json());
      // Real expiry, not trigger disabling or an injected production clock/bypass.
      await delay(Math.max(0, new Date(oldClaim.leaseExpiresAt).getTime() - Date.now()) + 30);
      const path = `/runner/attempts/${attempt.id}/results`;
      const expired = await runnerA(path, { ...v, leaseId: oldClaim.leaseId, result: syntheticResult }, 409);
      assert.equal(ApiErrorSchema.parse(expired.json()).error.code, 'lease_expired');
      const expiredRetry = await runnerA(`/runner/attempts/${completedAttemptId}/results`, { ...v, leaseId: completedLeaseId, result: syntheticResult }, 409);
      assert.equal(ApiErrorSchema.parse(expiredRetry.json()).error.code, 'lease_expired');
      const fresh = ClaimAttemptResponseSchema.parse((await runnerA('/runner/claims')).json());
      assert.equal(fresh.attemptId, attempt.id);
      assert.notEqual(fresh.leaseId, oldClaim.leaseId);
      await runnerA(path, { ...v, leaseId: oldClaim.leaseId, result: syntheticResult }, 409);
      await runnerA(path, { ...v, leaseId: fresh.leaseId, result: syntheticResult });
    });

    await t.test('revocation serialises with credential locks and blocks claims, handshake and duplicate uploads', async () => {
      const attempt = await queue();
      const claim = ClaimAttemptResponseSchema.parse((await runnerA('/runner/claims')).json());
      const path = `/runner/attempts/${attempt.id}/results`;
      const upload = { ...v, leaseId: claim.leaseId, result: syntheticResult };
      await runnerA(path, upload);
      const pending = await queue();
      const pendingClaim = ClaimAttemptResponseSchema.parse((await runnerA('/runner/claims')).json());
      const lock = await pool.connect();
      let revoked = false;
      let revoke: ReturnType<typeof a>;
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT id FROM public.runner_credentials WHERE id=$1 FOR SHARE', [mintedA.credential.id]);
        revoke = a('POST', `${baseA}/runner-credentials/${mintedA.credential.id}/revoke`, v).then(response => { revoked = true; return response; });
        await delay(50);
        assert.equal(revoked, false);
      } finally { await lock.query('ROLLBACK'); lock.release(); }
      const revokedResponse = await revoke;
      assert.ok(!revokedResponse.body.includes(mintedA.token) && !revokedResponse.body.includes('token_hash'));
      const retry = await runnerA(path, upload, 401);
      assert.equal(ApiErrorSchema.parse(retry.json()).error.code, 'credential_revoked');
      await runnerA(`/runner/attempts/${pending.id}/results`, { ...v, leaseId: pendingClaim.leaseId, result: syntheticResult }, 401);
      await runnerA('/runner/claims', v, 401);
      await runnerA('/runner/handshake', { ...v, runner: { name: 'synthetic', version: '1' }, adapter: { name: 'synthetic', version: '1' }, supportedSchemaVersions: [SCHEMA_VERSION] }, 401);
      // Fresh queued work also cannot be claimed by the revoked runner.
      await queue();
      await runnerA('/runner/claims', v, 401);
      const activeClaim = ClaimAttemptResponseSchema.parse((await request('POST', '/runner/claims', v, mintedOtherA.token)).json());
      await request('POST', `/runner/attempts/${activeClaim.attemptId}/results`, { ...v, leaseId: activeClaim.leaseId, result: syntheticResult }, mintedOtherA.token);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await sqlFailure(client, 'UPDATE public.runner_credentials SET revoked_at=NULL WHERE id=$1', [mintedA.credential.id], '23514');
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
  } finally {
    await app.close();
    await pool.end();
  }
});
