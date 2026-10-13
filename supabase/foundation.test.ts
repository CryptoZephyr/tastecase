import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import {
  SCHEMA_VERSION, checksum, CreateCatalogVersionRequestSchema, CreateTaskVersionRequestSchema,
  TargetInputSchema, TargetResultSchema,
} from '@tastecase/contracts';

// Run after building contracts: node --import tsx --test supabase/foundation.test.ts
// The full suite (including bootstrap/migrations/storage simulation) rolls back.
const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55432/tastecase_test';
const url = new URL(connectionString);
if (!process.env.CI && (url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/tastecase_test')) {
  throw new Error('Database tests require the parent-owned local test cluster (or CI DATABASE_URL)');
}

test('Gate 1 database invariants in a rollback-only transaction', async t => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  let savepoint = 0;
  async function fails(sql: string, params: unknown[] = [], code = '23514') {
    const name = `tastecase_test_${savepoint++}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      await assert.rejects(client.query(sql, params), (error: unknown) => error instanceof Error && 'code' in error && error.code === code);
    } finally {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
    }
  }
  const owner = randomUUID();
  const otherOwner = randomUUID();
  const project = randomUUID();
  const otherProject = randomUUID();
  const catalogId = randomUUID();
  const taskId = randomUUID();
  const mappingId = randomUUID();
  const qlooId = randomUUID(); // Explicitly synthetic fixture; no Qloo API call/data.
  const credentialId = randomUUID();
  const otherCredentialId = randomUUID();
  const attemptId = randomUUID();
  let leaseId = randomUUID();
  const createdAt = new Date().toISOString();
  const catalogPayload = CreateCatalogVersionRequestSchema.parse({ schema_version: SCHEMA_VERSION, id: catalogId, label: 'Synthetic SQL catalog', entries: [{ id: 'synthetic-one', name: 'Synthetic Restaurant' }] });
  const taskPayload = CreateTaskVersionRequestSchema.parse({
    schema_version: SCHEMA_VERSION, id: taskId, label: 'Synthetic SQL task', catalogVersionId: catalogId,
    syntheticBrief: { provenance: 'synthetic', label: 'Fictional trip', text: 'A made-up guest wants lunch.' }, syntheticInterests: [],
    constraints: { partySize: 2, dietaryRequirements: [], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: [] },
  });
  const catalog = { ...catalogPayload, projectId: project, createdAt, checksum: checksum(catalogPayload) };
  const task = { ...taskPayload, projectId: project, createdAt, checksum: checksum(taskPayload) };
  const mapping = { schema_version: SCHEMA_VERSION, id: mappingId, projectId: project, catalogVersionId: catalogId, catalogEntryId: 'synthetic-one', qlooEntityId: qlooId, confirmedBy: owner, createdAt };
  const input = TargetInputSchema.parse({ schema_version: SCHEMA_VERSION, projectId: project, catalog, task, mappings: [mapping], eligibleCatalogEntryIds: ['synthetic-one'] });
  const result = TargetResultSchema.parse({ schema_version: SCHEMA_VERSION, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'outside-synthetic', name: 'Outside Synthetic Restaurant' }] }, trace: { completeness: 'unavailable', events: [] } });
  const insertAttempt = 'INSERT INTO public.target_attempts(id, project_id, catalog_version_id, task_version_id, pinned_input, input_checksum) VALUES ($1,$2,$3,$4,$5,$6)';
  const attemptParams = (id = attemptId, payload: unknown = input, projectId = project) => [id, projectId, catalogId, taskId, JSON.stringify(payload), checksum(payload)];
  const claim = (id: string, lease: string, credential = credentialId) => client.query("UPDATE public.target_attempts SET status='leased', lease_id=$2, lease_credential_id=$3, lease_expires_at=clock_timestamp() + interval '5 minutes' WHERE id=$1", [id, lease, credential]);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL tastecase.local_test = 'on'");
    await client.query(await readFile(new URL('./local-test-bootstrap.sql', import.meta.url), 'utf8'));
    const authBefore = await client.query("SELECT pg_get_functiondef('auth.uid()'::regprocedure) AS definition");
    const migration = await readFile(new URL('./migrations/202610130001_gate1_foundation.sql', import.meta.url), 'utf8');
    await client.query(migration);
    await client.query(migration);
    await t.test('migration is repeat-safe and does not replace auth.uid()', async () => {
      assert.equal((await client.query("SELECT pg_get_functiondef('auth.uid()'::regprocedure) AS definition")).rows[0].definition, authBefore.rows[0].definition);
    });
    await client.query('INSERT INTO public.projects(id, owner_id, name) VALUES ($1,$2,$3),($4,$5,$6)', [project, owner, 'Synthetic project', otherProject, otherOwner, 'Other synthetic project']);
    await client.query('INSERT INTO public.catalog_versions(id, project_id, content, checksum, created_at) VALUES ($1,$2,$3,$4,$5)', [catalogId, project, JSON.stringify(catalogPayload), catalog.checksum, createdAt]);
    await client.query('INSERT INTO public.task_versions(id, project_id, catalog_version_id, content, checksum, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [taskId, project, catalogId, JSON.stringify(taskPayload), task.checksum, createdAt]);
    await client.query('INSERT INTO public.mapping_confirmations(id, project_id, catalog_version_id, catalog_entry_id, qloo_entity_id, confirmed_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [mappingId, project, catalogId, 'synthetic-one', qlooId, owner, createdAt]);
    await client.query('INSERT INTO public.runner_credentials(id, project_id, label, token_hash) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)', [credentialId, project, 'Synthetic runner', checksum(randomUUID()), otherCredentialId, otherProject, 'Other synthetic runner', checksum(randomUUID())]);
    await t.test('catalog entry uniqueness and record uniqueness are enforced', async () => {
      await fails('INSERT INTO public.catalog_versions(id, project_id, content, checksum) VALUES ($1,$2,$3,$4)', [catalogId, project, JSON.stringify(catalogPayload), catalog.checksum], '23505');
      const id = randomUUID();
      const duplicate = { ...catalogPayload, id, entries: [catalogPayload.entries[0], catalogPayload.entries[0]] };
      await fails('INSERT INTO public.catalog_versions(id, project_id, content, checksum) VALUES ($1,$2,$3,$4)', [id, project, JSON.stringify(duplicate), checksum(duplicate)]);
      const nullIdentity = { ...catalogPayload, id: null };
      await fails('INSERT INTO public.catalog_versions(id, project_id, content, checksum) VALUES ($1,$2,$3,$4)', [randomUUID(), project, JSON.stringify(nullIdentity), checksum(nullIdentity)]);
    });
    await t.test('version and mapping updates/deletes are rejected even for privileged connection', async () => {
      for (const [table, id] of [['catalog_versions', catalogId], ['task_versions', taskId], ['mapping_confirmations', mappingId]]) {
        await fails(`UPDATE public.${table} SET created_at=created_at WHERE id=$1`, [id]);
        await fails(`DELETE FROM public.${table} WHERE id=$1`, [id]);
      }
    });
    await t.test('task composite FK blocks another project catalog', async () => {
      const id = randomUUID();
      const content = { ...taskPayload, id };
      await fails('INSERT INTO public.task_versions(id, project_id, catalog_version_id, content, checksum) VALUES ($1,$2,$3,$4,$5)', [id, otherProject, catalogId, JSON.stringify(content), checksum(content)], '23503');
    });
    await t.test('mapping entry existence, owner confirmation, uniqueness and project boundaries are enforced', async () => {
      const sql = 'INSERT INTO public.mapping_confirmations(id, project_id, catalog_version_id, catalog_entry_id, qloo_entity_id, confirmed_by) VALUES ($1,$2,$3,$4,$5,$6)';
      await fails(sql, [randomUUID(), project, catalogId, 'unknown-entry', qlooId, owner]);
      await fails(sql, [randomUUID(), otherProject, catalogId, 'synthetic-one', qlooId, otherOwner]);
      await fails(sql, [randomUUID(), project, catalogId, 'synthetic-one', qlooId, otherOwner]);
      await fails(sql, [randomUUID(), project, catalogId, 'synthetic-one', qlooId, owner], '23505');
    });
    await client.query(insertAttempt, attemptParams());
    await t.test('mapping edges are materialised and cannot reference cross-project versions', async () => {
      assert.equal((await client.query('SELECT mapping_confirmation_id FROM public.target_attempt_mappings WHERE attempt_id=$1', [attemptId])).rows[0].mapping_confirmation_id, mappingId);
      await fails('INSERT INTO public.target_attempt_mappings(project_id, attempt_id, catalog_version_id, mapping_confirmation_id) VALUES ($1,$2,$3,$4)', [otherProject, attemptId, catalogId, randomUUID()], '23503');
    });
    await t.test('pinned attempt versions/mappings and catalog eligibility cannot drift', async () => {
      await fails(insertAttempt, attemptParams(randomUUID(), { ...input, projectId: otherProject }));
      await fails(insertAttempt, attemptParams(randomUUID(), input, otherProject), '23503');
      await fails(insertAttempt, attemptParams(randomUUID(), { ...input, task: { ...task, constraints: { ...task.constraints, partySize: 3 } } }));
      await fails(insertAttempt, attemptParams(randomUUID(), { ...input, mappings: [{ ...mapping, projectId: otherProject }] }), '23503');
      await fails(insertAttempt, attemptParams(randomUUID(), { ...input, mappings: [mapping, mapping] }), '23505');
      await fails(insertAttempt, attemptParams(randomUUID(), { ...input, eligibleCatalogEntryIds: ['unknown-entry'] }));
      await fails('UPDATE public.target_attempts SET input_checksum=$2 WHERE id=$1', [attemptId, '0'.repeat(64)]);
    });
    await t.test('authenticated RLS reveals only the owned project and never token hashes', async () => {
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
      assert.deepEqual((await client.query('SELECT id FROM public.projects WHERE id IN ($1,$2)', [project, otherProject])).rows.map(row => row.id), [project]);
      assert.equal((await client.query('SELECT id FROM public.catalog_versions WHERE project_id=$1', [otherProject])).rowCount, 0);
      assert.equal((await client.query('SELECT id FROM public.target_attempts WHERE id=$1', [attemptId])).rowCount, 1);
      assert.equal((await client.query('SELECT id FROM public.runner_credentials WHERE id=$1', [credentialId])).rowCount, 1);
      await fails('SELECT token_hash FROM public.runner_credentials', [], '42501');
      await fails("UPDATE public.target_attempts SET status='leased' WHERE id=$1", [attemptId], '42501');
      await fails('INSERT INTO public.runner_credentials(id, project_id, label, token_hash) VALUES ($1,$2,$3,$4)', [randomUUID(), project, 'Denied synthetic runner', checksum(randomUUID())], '42501');
      await fails('INSERT INTO public.projects(id,owner_id,name) VALUES ($1,$2,$3)', [randomUUID(), otherOwner, 'Forbidden synthetic project'], '42501');
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [otherOwner]);
      assert.equal((await client.query('SELECT id FROM public.target_attempts WHERE id=$1', [attemptId])).rowCount, 0);
      for (const table of ['catalog_versions', 'task_versions', 'mapping_confirmations', 'runner_credentials', 'target_attempt_mappings']) {
        assert.equal((await client.query(`SELECT project_id FROM public.${table} WHERE project_id=$1`, [project])).rowCount, 0);
      }
      await client.query('SET LOCAL ROLE anon');
      await fails('SELECT * FROM public.projects', [], '42501');
      await client.query('RESET ROLE');
      assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_class WHERE oid IN ('public.projects'::regclass,'public.catalog_versions'::regclass,'public.task_versions'::regclass,'public.mapping_confirmations'::regclass,'public.runner_credentials'::regclass,'public.target_attempts'::regclass,'public.target_attempt_mappings'::regclass) AND relrowsecurity AND relforcerowsecurity")).rows[0].count, 7);
    });
    await t.test('leases reject cross-project credentials, active replacement, stale expiry and unleased results', async () => {
      await fails("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [attemptId, leaseId, otherCredentialId]);
      await fails("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=now() WHERE id=$1", [attemptId, JSON.stringify(result), checksum(result)]);
      await claim(attemptId, leaseId);
      const missingTrace = { schema_version: SCHEMA_VERSION, outcome: 'success', output: { recommendations: [] } };
      await fails("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=now() WHERE id=$1", [attemptId, JSON.stringify(missingTrace), checksum(missingTrace)]);
      await fails("UPDATE public.target_attempts SET lease_id=$2 WHERE id=$1", [attemptId, randomUUID()]);
      await fails("UPDATE public.target_attempts SET status='completed',lease_id=$2,result=$3,result_checksum=$4,completed_at=now() WHERE id=$1", [attemptId, randomUUID(), JSON.stringify(result), checksum(result)]);
    });
    await t.test('completed results retain outside-catalog output, accept identical no-op and reject collisions', async () => {
      await client.query("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1", [attemptId, JSON.stringify(result), checksum(result)]);
      assert.equal((await client.query('SELECT result FROM public.target_attempts WHERE id=$1', [attemptId])).rows[0].result.output.recommendations[0].catalogEntryId, 'outside-synthetic');
      await client.query('UPDATE public.target_attempts SET result=result WHERE id=$1', [attemptId]);
      await fails('UPDATE public.target_attempts SET result_checksum=$2 WHERE id=$1', [attemptId, '0'.repeat(64)], '23505');
      await fails('DELETE FROM public.target_attempts WHERE id=$1', [attemptId]);
    });
    await t.test('expired lease can be reclaimed with fresh lease ID, not uploaded', async () => {
      const id = randomUUID();
      await client.query(insertAttempt, attemptParams(id));
      await claim(id, randomUUID());
      // Test-only time travel without changing production guard function or any unrelated rows.
      await client.query('SAVEPOINT expiry_fixture');
      await client.query('ALTER TABLE public.target_attempts DISABLE TRIGGER tastecase_guard_attempt');
      await client.query("UPDATE public.target_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
      await client.query('ALTER TABLE public.target_attempts ENABLE TRIGGER tastecase_guard_attempt');
      await fails("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1", [id, JSON.stringify(result), checksum(result)]);
      leaseId = randomUUID();
      await claim(id, leaseId);
      assert.equal((await client.query('SELECT lease_id FROM public.target_attempts WHERE id=$1', [id])).rows[0].lease_id, leaseId);
      await client.query('RELEASE SAVEPOINT expiry_fixture');
    });
    await t.test('revocation stops fresh claims/uploads and cannot be undone', async () => {
      const id = randomUUID();
      await client.query(insertAttempt, attemptParams(id));
      await claim(id, randomUUID());
      await client.query('UPDATE public.runner_credentials SET revoked_at=clock_timestamp() WHERE id=$1', [credentialId]);
      await fails('UPDATE public.runner_credentials SET revoked_at=NULL WHERE id=$1', [credentialId]);
      await fails("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1", [id, JSON.stringify(result), checksum(result)]);
      const queuedId = randomUUID();
      await client.query(insertAttempt, attemptParams(queuedId));
      await fails("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [queuedId, randomUUID(), credentialId]);
    });
    await t.test('private storage policy branch is exercised only in an isolated transactional fixture', async () => {
      const existing = await client.query("SELECT to_regclass('storage.objects') AS objects, to_regnamespace('storage') AS schema");
      if (existing.rows[0].schema !== null) {
        t.diagnostic('Existing storage schema left untouched; synthetic branch test not run in this environment.');
        return;
      }
      await client.query(`CREATE SCHEMA storage;
        CREATE TABLE storage.buckets(id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL, file_size_limit bigint, allowed_mime_types text[]);
        CREATE TABLE storage.objects(id uuid PRIMARY KEY, bucket_id text NOT NULL REFERENCES storage.buckets(id), name text NOT NULL, UNIQUE(bucket_id,name));
        ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
        ALTER TABLE storage.objects FORCE ROW LEVEL SECURITY;
        GRANT USAGE ON SCHEMA storage TO authenticated, anon;
        GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
        GRANT SELECT ON storage.objects TO anon;
        CREATE POLICY unrelated_broad_access ON storage.objects FOR ALL TO authenticated USING (true) WITH CHECK (true);
        CREATE POLICY unrelated_anon_access ON storage.objects FOR SELECT TO anon USING (true);`);
      await client.query(migration);
      await client.query(migration);
      await client.query("INSERT INTO storage.buckets(id,name,public) VALUES ('synthetic-other','synthetic-other',true)");
      const unrelatedObjectId = randomUUID();
      await client.query("INSERT INTO storage.objects(id,bucket_id,name) VALUES ($1,'synthetic-other','synthetic-public.json')", [unrelatedObjectId]);
      const bucket = (await client.query("SELECT public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id='tastecase-private'")).rows[0];
      assert.equal(bucket.public, false);
      assert.equal(Number(bucket.file_size_limit), 1048576);
      assert.deepEqual(bucket.allowed_mime_types, ['application/json']);
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
      const objectId = randomUUID();
      await client.query("INSERT INTO storage.objects(id,bucket_id,name) VALUES ($1,'tastecase-private',$2)", [objectId, `${project}/synthetic.json`]);
      await fails("INSERT INTO storage.objects(id,bucket_id,name) VALUES ($1,'tastecase-private',$2)", [randomUUID(), `${otherProject}/synthetic.json`], '42501');
      await fails("INSERT INTO storage.objects(id,bucket_id,name) VALUES ($1,'tastecase-private',$2)", [randomUUID(), `${project}/synthetic.json`], '23505');
      await fails("INSERT INTO storage.objects(id,bucket_id,name) VALUES ($1,'tastecase-private',$2)", [randomUUID(), project], '42501');
      assert.equal((await client.query('UPDATE storage.objects SET name=$2 WHERE id=$1', [objectId, `${project}/replacement.json`])).rowCount, 0);
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [otherOwner]);
      assert.equal((await client.query('SELECT * FROM storage.objects WHERE id=$1', [objectId])).rowCount, 0);
      assert.equal((await client.query('DELETE FROM storage.objects WHERE id=$1', [objectId])).rowCount, 0);
      await client.query('SET LOCAL ROLE anon');
      assert.equal((await client.query('SELECT * FROM storage.objects WHERE id=$1', [objectId])).rowCount, 0);
      assert.equal((await client.query('SELECT * FROM storage.objects WHERE id=$1', [unrelatedObjectId])).rowCount, 1);
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
      assert.equal((await client.query('DELETE FROM storage.objects WHERE id=$1', [objectId])).rowCount, 1);
      await client.query('RESET ROLE');
    });
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
