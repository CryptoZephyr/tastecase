import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createSupabaseOwnerVerifier, bearerToken } from '../auth.js';
import { buildServer, requestSignal } from '../server.js';
import { safeError } from '../errors.js';
import { assertLocalTestDatabase } from '../migrate.js';
import { ApiErrorSchema } from '@tastecase/contracts';

const syntheticToken = 'synthetic.bearer.token';

test('Supabase auth calls the fixed user endpoint with both required headers', async () => {
  const id = randomUUID();
  let calls = 0;
  const verify = createSupabaseOwnerVerifier({
    supabaseUrl: 'https://synthetic-auth.invalid', supabaseAnonKey: 'synthetic-anon-key',
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), 'https://synthetic-auth.invalid/auth/v1/user');
      assert.deepEqual(init?.headers, { apikey: 'synthetic-anon-key', Authorization: `Bearer ${syntheticToken}` });
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ id }));
    },
  });
  assert.equal(await verify(syntheticToken), id);
  assert.equal(calls, 1);
});

test('Supabase auth denies decoded-only JWTs, errors, malformed users and oversized responses', async () => {
  for (const response of [
    () => new Response('{"id":"not-a-uuid"}'),
    () => new Response('not json'),
    () => new Response('{"sub":"untrusted"}'),
    () => new Response('private provider details', { status: 401 }),
    () => new Response('x'.repeat(16385)),
  ]) {
    const verify = createSupabaseOwnerVerifier({ supabaseUrl: 'https://synthetic-auth.invalid', supabaseAnonKey: 'synthetic-anon-key', fetch: async () => response() });
    assert.equal(await verify(syntheticToken), null);
  }
  const verify = createSupabaseOwnerVerifier({ supabaseUrl: 'https://synthetic-auth.invalid', supabaseAnonKey: 'synthetic-anon-key', fetch: async () => { throw new Error('private upstream body'); } });
  assert.equal(await verify(syntheticToken), null);
});

test('bearer and configuration reject unsafe or absent credentials', () => {
  for (const header of [undefined, '', 'Basic abc', 'Bearer abc extra', 'Bearer abc\n', `Bearer ${'x'.repeat(4097)}`]) assert.throws(() => bearerToken(header));
  assert.equal(bearerToken('bearer synthetic-token'), 'synthetic-token');
  for (const url of ['http://remote.invalid', 'https://user:password@synthetic.invalid', 'https://synthetic.invalid/path', 'https://synthetic.invalid?key=value']) assert.throws(() => createSupabaseOwnerVerifier({ supabaseUrl: url, supabaseAnonKey: 'synthetic-key' }));
  assert.throws(() => assertLocalTestDatabase('postgresql://postgres@remote.invalid/tastecase_test'));
  assert.throws(() => assertLocalTestDatabase('postgresql://postgres@127.0.0.1/production'));
});

test('production construction rejects test authentication and out-of-bounds leases', async () => {
  const pool = new pg.Pool();
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => buildServer({ pool, auth: { testVerifier: async () => randomUUID() } }), /forbidden in production/);
    for (const seconds of [0, 29, 901, 30.5, Number.NaN]) assert.throws(() => buildServer({ pool, auth: { supabaseUrl: 'https://synthetic.invalid', supabaseAnonKey: 'synthetic-key' }, leaseDurationSeconds: seconds }));
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    await pool.end();
  }
});

test('safe errors never expose database messages or unknown internal details', () => {
  assert.equal(safeError({ code: '23505', message: 'private SQL and connection details' }).status, 409);
  assert.equal(safeError({ code: '23503', message: 'private SQL' }).status, 404);
  assert.equal(safeError(new Error('private-secret-marker')).status, 500);
  assert.ok(!JSON.stringify(safeError(new Error('private-secret-marker'))).includes('private-secret-marker'));
});

test('handler deadline aborts the request and returns only a structured safe error', async () => {
  const pool = new pg.Pool();
  const app = buildServer({ pool, auth: { testVerifier: async () => null }, handlerTimeoutMs: 10 });
  app.get('/synthetic-timeout', async request => {
    await delay(40);
    assert.ok(requestSignal(request).aborted);
    return { ignored: true };
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/synthetic-timeout' });
    assert.equal(response.statusCode, 503);
    assert.equal(ApiErrorSchema.parse(response.json()).error.code, 'internal_error');
    assert.ok(!response.body.includes('FST_ERR') && !response.body.includes('stack'));
    await delay(50);
  } finally { await app.close(); await pool.end(); }
});

test('real HTTP body completion does not cancel asynchronous request work', async () => {
  const pool = new pg.Pool();
  const app = buildServer({ pool, auth: { testVerifier: async () => null } });
  app.post('/synthetic-http', async request => {
    await delay(15);
    assert.equal(requestSignal(request).aborted, false);
    return { synthetic: true };
  });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(origin + '/synthetic-http', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { synthetic: true });
  } finally { await app.close(); await pool.end(); }
});

test('inject health/readiness, auth and body limits are safe without a database', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://postgres@127.0.0.1:1/tastecase_test', connectionTimeoutMillis: 100, max: 1 });
  const app = buildServer({ pool, auth: { testVerifier: async token => token === 'synthetic-verified' ? randomUUID() : null } });
  try {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(health.json(), { status: 'ok' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), { status: 'unavailable' });
    const ownerHeader = await app.inject({ method: 'GET', url: '/projects', headers: { 'x-owner-id': randomUUID() } });
    assert.equal(ownerHeader.statusCode, 401);
    const decoded = await app.inject({ method: 'GET', url: '/projects', headers: { authorization: `Bearer ${syntheticToken}` } });
    assert.equal(decoded.statusCode, 401);
    const failedDatabase = await app.inject({ method: 'GET', url: '/projects', headers: { authorization: 'Bearer synthetic-verified' } });
    assert.equal(failedDatabase.statusCode, 500);
    assert.ok(!failedDatabase.body.includes('ECONNREFUSED') && !failedDatabase.body.includes('127.0.0.1'));
    const oversized = await app.inject({ method: 'POST', url: '/projects', payload: 'x'.repeat(1048577), headers: { 'content-type': 'application/json' } });
    assert.equal(oversized.statusCode, 413);
    const invalidJson = await app.inject({ method: 'POST', url: '/projects', payload: '{', headers: { 'content-type': 'application/json' } });
    assert.equal(invalidJson.statusCode, 400);
    assert.ok(!invalidJson.body.includes('SyntaxError'));
    const missing = await app.inject({ method: 'GET', url: '/no-such-route' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.headers['cache-control'], 'no-store');
  } finally { await app.close(); await pool.end(); }
});
