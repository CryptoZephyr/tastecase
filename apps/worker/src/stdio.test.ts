import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openOfficialSession } from './stdio.js';
import { validateTools } from './qloo.js';

test('the pinned ESM-only harness starts and exposes compatible tools without a provider call', async () => {
  const previous = process.env.QLOO_API_KEY;
  process.env.QLOO_API_KEY = 'synthetic-tool-schema-check-no-provider-calls';
  const session = await openOfficialSession({ signal: AbortSignal.timeout(20000), outputBytes: 128000 });
  try {
    const declaration = await session.listTools(AbortSignal.timeout(10000));
    validateTools(declaration);
    assert.ok(declaration);
  } finally {
    await session.close();
    if (previous === undefined) delete process.env.QLOO_API_KEY;
    else process.env.QLOO_API_KEY = previous;
  }
});
