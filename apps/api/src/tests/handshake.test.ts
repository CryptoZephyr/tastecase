import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { SCHEMA_VERSION, MintRunnerCredentialResponseSchema, RunnerCredentialListResponseSchema, RunnerHandshakeResponseSchema } from '@tastecase/contracts';
import { buildServer } from '../server.js';
import { assertLocalTestDatabase, loadMigrations, runMigrations } from '../migrate.js';

const databaseUrl = process.env.DATABASE_URL;
const v = { schema_version: SCHEMA_VERSION };
const handshake = { ...v, runner: { name: 'Synthetic runner', version: '1' }, adapter: { name: 'Synthetic adapter', version: '1' }, supportedSchemaVersions: [SCHEMA_VERSION] };

test('verified runner receipts are owner-scoped, repeat-safe, revocation-fenced and not credential existence', { skip: !databaseUrl }, async t => {
  if (!databaseUrl) return;
  assertLocalTestDatabase(databaseUrl);
  const url = new URL(databaseUrl);
  assert.ok(url.port === '55432' || (process.env.CI === 'true' && url.port === '5432'));
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const owner = randomUUID(); const other = randomUUID();
  const app = buildServer({ pool, auth: { testVerifier: async token => token === 'synthetic-owner' ? owner : token === 'synthetic-other' ? other : null } });
  const request = (method: 'GET' | 'POST', path: string, token: string, payload?: unknown) => app.inject({ method, url: path,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload: JSON.stringify(payload) } : {}) });
  try {
    await runMigrations(pool, { databaseUrl, localTestBootstrap: true });
    const project = (await request('POST', '/projects', 'synthetic-owner', { ...v, name: 'Synthetic handshake test' })).json();
    const base = `/projects/${project.id}`;
    const mint = MintRunnerCredentialResponseSchema.parse((await request('POST', `${base}/runner-credentials`, 'synthetic-owner', { ...v, label: 'Synthetic runner' })).json());
    const list = async () => RunnerCredentialListResponseSchema.parse((await request('GET', `${base}/runner-credentials`, 'synthetic-owner')).json());
    assert.equal(mint.credential.lastHandshakeAt, null);
    assert.equal((await list()).credentials[0].lastHandshakeAt, null);
    assert.equal((await request('POST', '/runner/handshake', mint.token, { ...handshake, projectId: project.id })).statusCode, 400);
    assert.equal((await list()).credentials[0].lastHandshakeAt, null);
    const responses = await Promise.all(Array.from({ length: 3 }, () => request('POST', '/runner/handshake', mint.token, handshake)));
    const receipts = responses.map(response => { assert.equal(response.statusCode, 200); return RunnerHandshakeResponseSchema.parse(response.json()); });
    const row = (await pool.query('SELECT * FROM public.runner_handshakes WHERE credential_id=$1', [mint.credential.id])).rows[0];
    assert.equal((await list()).credentials[0].lastHandshakeAt, row.last_verified_at.toISOString());
    assert.equal(row.first_verified_at.toISOString(), receipts.map(r => r.verifiedAt!).sort()[0]);
    assert.ok(row.last_verified_at >= row.first_verified_at);
    assert.equal((await request('POST', '/runner/handshake', mint.token, { ...handshake, supportedSchemaVersions: ['0.0.0'] })).statusCode, 400);
    assert.equal((await list()).credentials[0].lastHandshakeAt, row.last_verified_at.toISOString());
    assert.equal((await request('GET', `${base}/runner-credentials`, 'synthetic-other')).statusCode, 404);
    const publicList = await request('GET', `${base}/runner-credentials`, 'synthetic-owner');
    for (const forbidden of [mint.token, 'token_hash', 'runner:']) assert.equal(publicList.body.includes(forbidden), false);

    await t.test('migration repeat safety, forced RLS, owner-only reads and no direct receipt forgery', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const migration = (await loadMigrations()).find(m => m.name === '202610140001_runner_handshakes.sql'); assert.ok(migration);
        await client.query(migration.sql); await client.query(migration.sql);
        assert.deepEqual((await client.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.runner_handshakes'::regclass")).rows[0], { relrowsecurity: true, relforcerowsecurity: true });
        assert.equal((await client.query('SELECT first_verified_at FROM public.runner_handshakes WHERE credential_id=$1', [mint.credential.id])).rows[0].first_verified_at.toISOString(), row.first_verified_at.toISOString());
        await client.query('SET LOCAL ROLE authenticated');
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
        assert.equal((await client.query('SELECT credential_id FROM public.runner_handshakes WHERE credential_id=$1', [mint.credential.id])).rowCount, 1);
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [other]);
        assert.equal((await client.query('SELECT credential_id FROM public.runner_handshakes WHERE credential_id=$1', [mint.credential.id])).rowCount, 0);
        await client.query('SAVEPOINT denied');
        await assert.rejects(client.query('UPDATE public.runner_handshakes SET last_verified_at=now()'), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '42501');
        await client.query('ROLLBACK TO SAVEPOINT denied');
        await client.query('SET LOCAL ROLE anon');
        await assert.rejects(client.query('SELECT * FROM public.runner_handshakes'), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '42501');
      } finally { await client.query('ROLLBACK'); client.release(); }
    });

    // History survives revocation, but no fresh receipt (or online claim) can be created.
    assert.equal((await request('POST', `${base}/runner-credentials/${mint.credential.id}/revoke`, 'synthetic-owner', v)).statusCode, 200);
    assert.equal((await request('POST', '/runner/handshake', mint.token, handshake)).statusCode, 401);
    assert.equal((await list()).credentials[0].lastHandshakeAt, row.last_verified_at.toISOString());
    await assert.rejects(pool.query('UPDATE public.runner_handshakes SET last_verified_at=now() WHERE credential_id=$1', [mint.credential.id]));
  } finally { await app.close(); await pool.end(); }
});
