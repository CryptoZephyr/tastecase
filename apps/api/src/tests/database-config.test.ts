import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { databasePoolConfig } from '../database-config.js';

test('local pool disables TLS; hosted pool verifies certificates without connecting', async () => {
  assert.equal((await databasePoolConfig('postgresql://postgres@127.0.0.1:55432/tastecase_test', '')).ssl, false);
  assert.deepEqual((await databasePoolConfig('postgresql://synthetic@db.example.test/synthetic', '')).ssl, { rejectUnauthorized: true });
});

test('hosted URL overrides cannot disable or replace certificate verification', async () => {
  for (const name of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
    await assert.rejects(databasePoolConfig(`postgresql://synthetic@db.example.test/synthetic?${name}=synthetic`, ''), /URL overrides/);
  }
  await assert.rejects(databasePoolConfig('https://example.test', ''), /PostgreSQL/);
});

test('the verified hosted URL keeps explicit certificate verification without overriding its CA', async () => {
  const config = await databasePoolConfig('postgresql://synthetic@db.example.test/synthetic?sslmode=verify-full', fileURLToPath(new URL('../../../../supabase/certs/prod-ca-2021.crt', import.meta.url)));
  assert.equal(new URL(config.connectionString!).searchParams.has('sslmode'), false);
  assert.ok(typeof config.ssl === 'object' && config.ssl.rejectUnauthorized === true && config.ssl.ca);
  await assert.rejects(databasePoolConfig('postgresql://synthetic@db.example.test/synthetic?sslmode=verify-full&sslmode=disable', ''), /URL overrides/);
});
