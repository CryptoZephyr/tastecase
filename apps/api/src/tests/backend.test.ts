import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { buildBackend } from '../backend.js';
import { buildServer } from '../server.js';

const adapters = {
  qloo: () => { throw new Error('No provider calls allowed in lifecycle tests.'); },
  decision: { select: async () => { throw new Error('No model calls allowed.'); } },
};
const pool = { query: async () => { throw new Error('No database configured.'); } } as unknown as Pool;

test('persistent backend owns one injected worker and aborts it before closing', async () => {
  let starts = 0;
  let stopped = false;
  const backend = buildBackend({ pool, auth: { testVerifier: async () => null }, adapters,
    workerLoop: async (_store, actualAdapters, signal) => {
      starts++;
      assert.equal(actualAdapters, adapters);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
    },
  });
  await backend.app.ready();
  const first = backend.startWorker();
  assert.equal(backend.startWorker(), first);
  await Promise.resolve();
  assert.equal((await backend.app.inject('/health')).statusCode, 200);
  await backend.app.close();
  await first;
  assert.equal(starts, 1);
  assert.equal(stopped, true);
  assert.throws(() => backend.startWorker(), /closed/);
});

test('worker failure makes readiness unavailable while health remains process-only', async () => {
  const backend = buildBackend({ pool, auth: { testVerifier: async () => null }, adapters,
    workerLoop: async () => { throw new Error('Synthetic persistence interruption.'); },
  });
  try {
    await assert.rejects(backend.startWorker(), /interruption/);
    assert.equal((await backend.app.inject('/ready')).statusCode, 503);
    assert.equal((await backend.app.inject('/health')).statusCode, 200);
  } finally { await backend.app.close(); }
});

test('readiness requires review tables and publication RPCs', async () => {
  const queries: string[] = [];
  let missing: string | undefined;
  const schemaPool = { connect: async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      if (missing && sql.includes(missing)) throw new Error('Synthetic missing migration.');
    },
    release: () => {},
  }) } as unknown as Pool;
  const app = buildServer({ pool: schemaPool, auth: { testVerifier: async () => null } });
  try {
    assert.equal((await app.inject('/ready')).statusCode, 200);
    for (const relation of ['review_cases', 'review_heads', 'review_decisions', 'expectation_versions', 'suites', 'suite_versions', 'suite_version_cases']) {
      assert.ok(queries.some(sql => sql.includes(`public.${relation}`)));
    }
    for (const absent of ['public.review_cases', 'public.record_review_decision', 'public.publish_suite']) {
      missing = absent;
      assert.equal((await app.inject('/ready')).statusCode, 503);
      assert.equal((await app.inject('/health')).statusCode, 200);
    }
  } finally { await app.close(); }
});
