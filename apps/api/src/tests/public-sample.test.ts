import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { REST_CONTRACTS, ApiErrorSchema } from '@tastecase/contracts';
import { buildServer } from '../server.js';
import { publicSampleConfig, assertPublicTextSafe } from '../public-sample.js';

const projectId = randomUUID(); const caseId = randomUUID();
test('public sample configuration is absent by default and requires explicit synthetic allowlist', () => {
  assert.equal(publicSampleConfig({}), undefined);
  for (const env of [
    { TASTECASE_PUBLIC_SAMPLE_PROJECT_ID: projectId },
    { TASTECASE_PUBLIC_SAMPLE_PROJECT_ID: projectId, TASTECASE_PUBLIC_SAMPLE_CASE_ID: caseId },
    { TASTECASE_PUBLIC_SAMPLE_PROJECT_ID: projectId, TASTECASE_PUBLIC_SAMPLE_CASE_ID: caseId, TASTECASE_PUBLIC_SAMPLE_INPUTS_SYNTHETIC: 'false' },
    { TASTECASE_PUBLIC_SAMPLE_PROJECT_ID: 'not-a-uuid', TASTECASE_PUBLIC_SAMPLE_CASE_ID: caseId, TASTECASE_PUBLIC_SAMPLE_INPUTS_SYNTHETIC: 'true' },
  ]) assert.throws(() => publicSampleConfig(env));
  assert.deepEqual(publicSampleConfig({ TASTECASE_PUBLIC_SAMPLE_PROJECT_ID: projectId, TASTECASE_PUBLIC_SAMPLE_CASE_ID: caseId, TASTECASE_PUBLIC_SAMPLE_INPUTS_SYNTHETIC: 'true' }), { projectId, caseId, syntheticInputs: true });
  assert.ok(REST_CONTRACTS.some(route => route.method === 'GET' && route.path === '/public/sample' && route.auth === 'public'));
});
test('public text guard fails closed for runtime secrets and known credential formats without exposing them', () => {
  const syntheticSecret = 'synthetic-unit-secret-only';
  assertPublicTextSafe({ text: 'Fictional lunch with recorded evidence.' }, { SYNTHETIC_API_KEY: syntheticSecret });
  for (const text of [syntheticSecret, `tc_runner_${'x'.repeat(43)}`, 'Bearer synthetic-authorization', 'postgresql://synthetic:password@localhost/private', '-----BEGIN PRIVATE KEY-----']) {
    assert.throws(() => assertPublicTextSafe({ text }, { SYNTHETIC_API_KEY: syntheticSecret }), (error: unknown) => error instanceof Error && error.message === 'Recorded public sample is unavailable.');
  }
  assert.throws(() => assertPublicTextSafe({ text: 'x'.repeat(2097152) }, {}));
});
test('unconfigured public reads do not touch database/Auth; selectors and writes never reach owner CRUD', async () => {
  let calls = 0;
  const pool = { connect: async () => { calls++; throw new Error('No sample database configured.'); } } as unknown as Pool;
  const app = buildServer({ pool, auth: { testVerifier: async () => { calls++; throw new Error('Anonymous sample must not authenticate as owner.'); } } });
  try {
    const response = await app.inject('/public/sample'); assert.equal(response.statusCode, 503);
    assert.equal(ApiErrorSchema.parse(response.json()).error.message, 'Recorded public sample is unavailable.');
    assert.equal((await app.inject(`/public/sample?projectId=${projectId}`)).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/public/sample', payload: { caseId } })).statusCode, 404);
    assert.equal((await app.inject(`/public/sample/${caseId}`)).statusCode, 404);
    assert.equal(calls, 0);
  } finally { await app.close(); }
});
test('configured reads use read-only snapshot and server IDs; corrupt/private errors become unavailable', async () => {
  const queries: { sql: string; params: unknown[] | undefined }[] = [];
  const pool = { connect: async () => ({ query: async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes('review_cases')) throw new Error('private SQL/provider error must never be public');
    return { rows: [] };
  }, release: () => {} }) } as unknown as Pool;
  const app = buildServer({ pool, auth: { testVerifier: async () => { throw new Error('Must not invoke Auth.'); } }, publicSample: { projectId, caseId, syntheticInputs: true } });
  try {
    const response = await app.inject('/public/sample'); assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes('private SQL'), false);
    assert.ok(queries.some(query => query.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ'));
    assert.ok(queries.some(query => query.sql === 'SET TRANSACTION READ ONLY'));
    assert.deepEqual(queries.find(query => query.sql.includes('review_cases'))?.params, [projectId, caseId]);
    assert.ok(queries.some(query => query.sql === 'ROLLBACK'));
    assert.equal(queries.some(query => /INSERT|UPDATE|DELETE/.test(query.sql)), false);
  } finally { await app.close(); }
});
