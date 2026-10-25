import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { startCanonicalMcpServer, QlooWorkflowExecutionError } from '@qloo/qloo-harness';
import { QLOO_TAG_TYPES, QlooHttpDiagnosticsSchema } from '@tastecase/contracts';
import { BoundedQlooClient, minimumDispatchGapMs, retryAfterSeconds } from './qloo-http.js';
import { boundedMcpOptions } from './qloo-mcp.js';
import { normalizeRank, normalizeResolution, QLOO_HOST, validateTools } from './qloo.js';
import type { RankRequest } from './types.js';

const key = 'Fixture-offline-qloo-credential';
const options = Array.from({ length: 7 }, () => randomUUID());
const anchor = randomUUID();
const entity = (id: string) => ({ entity_id: id, name: `Fixture ${id}`, types: [id === anchor ? 'urn:entity:artist' : 'urn:entity:place'] });
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
function fixtureRequest(override?: (url: URL) => Response | undefined) {
  const calls: URL[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(url.origin, QLOO_HOST); assert.equal(init?.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('X-Api-Key'), key); assert.equal(init.body, undefined);
    assert.ok(!url.href.includes(key));
    const response = override?.(url); if (response) return response;
    if (url.pathname === '/entities') return json({ results: { entities: url.searchParams.get('entity_ids')!.split(',').map(entity) } });
    if (url.pathname === '/search') return json({ results: { entities: [entity(anchor)] } });
    assert.equal(url.pathname, '/v2/insights');
    assert.equal(url.searchParams.get('filter.type'), 'urn:entity:place');
    return json({ results: { entities: url.searchParams.get('filter.results.entities')!.split(',').map(entity) } });
  };
  return { calls, request };
}
function mcp(request: typeof fetch) {
  const input = new PassThrough(); let id = 0;
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  const server = startCanonicalMcpServer({ input, ...boundedMcpOptions(key, request, text => {
    const response = JSON.parse(text) as { id: number; result: Record<string, unknown> };
    const resolve = waiting.get(response.id); assert.ok(resolve); waiting.delete(response.id); resolve(response.result);
  }) });
  return { call(method: string, params: unknown) {
    return new Promise<Record<string, unknown>>(resolve => { const next = ++id; waiting.set(next, resolve); input.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`); });
  }, close() { server.close(); input.destroy(); } };
}
function rankRequest(): RankRequest {
  return { profileId: 'a', scope: 'full', options: options.map((entityId, index) => ({ entityId, entryId: `fixture-${index}`, confirmationId: randomUUID() })),
    anchors: [{ entityId: anchor, confirmationId: randomUUID() }], unmappedEntryIds: [] };
}
function normalized(result: Record<string, unknown>, request = rankRequest()) {
  const meta = result._meta as { tastecaseHttp: unknown; tastecaseEntityTags: unknown };
  const http = QlooHttpDiagnosticsSchema.parse(meta.tastecaseHttp);
  return normalizeRank({ ...(result.structuredContent as Record<string, unknown>), http, entityTags: meta.tastecaseEntityTags }, request, 64000);
}

test('official canonical MCP batches eight cold ID checks into one documented request, then ranks', async () => {
  const fixture = fixtureRequest(); const server = mcp(fixture.request);
  try {
    validateTools(await server.call('tools/list', {}));
    assert.equal(fixture.calls.length, 0);
    const result = await server.call('tools/call', { name: 'qloo_rank', arguments: { options, option_type: 'place', signals: [anchor] } });
    const rank = normalized(result);
    assert.equal(rank.providerStatus, 'ok'); assert.equal(rank.orderedEntryIds.length, 7);
    assert.deepEqual(fixture.calls.map(url => url.pathname), ['/entities', '/v2/insights']);
    assert.equal(fixture.calls[1]?.searchParams.get('feature.explainability'), 'true');
    assert.equal(fixture.calls[0]?.searchParams.has('feature.explainability'), false);
    assert.deepEqual(new Set(fixture.calls[0]!.searchParams.get('entity_ids')!.split(',')), new Set([...options, anchor]));
    const tags = (result._meta as { tastecaseEntityTags: unknown[] }).tastecaseEntityTags;
    assert.equal(tags.length, options.length + 1); assert.ok(tags.every(row => (row as { tags: unknown[] }).tags.length === 0));
    assert.deepEqual(rank.http, { maxAttempts: 2, attempts: 2, cacheHits: 0, requests: [
      { endpoint: '/entities', status: 200, retryAfterSeconds: null }, { endpoint: '/v2/insights', status: 200, retryAfterSeconds: null },
    ] });
    const repeatedResult = await server.call('tools/call', { name: 'qloo_rank', arguments: { options, option_type: 'place', signals: [anchor] } });
    const repeat = normalized(repeatedResult);
    assert.equal(repeat.http?.attempts, 1); assert.equal(fixture.calls.length, 3);
    assert.deepEqual((repeatedResult._meta as { tastecaseEntityTags: unknown[] }).tastecaseEntityTags, tags);
  } finally { server.close(); }
});

test('entity tags are filtered, normalised, deduplicated, capped and retained on cache hits', async () => {
  const target = options[0]!; const rawTags = [
    { type: QLOO_TAG_TYPES[0], name: '  Sushi  ', tag_id: 'fixture-one', value: 'Fixture value' },
    { type: QLOO_TAG_TYPES[1], name: 'sUsHi' },
    { type: 'urn:tag:unknown', name: 'Unknown type' },
    { type: QLOO_TAG_TYPES[2], name: 'x'.repeat(81) },
    ...Array.from({ length: 13 }, (_, index) => ({ type: QLOO_TAG_TYPES[index % QLOO_TAG_TYPES.length], name: `Tag ${index}` })),
  ];
  const fixture = fixtureRequest(url => url.pathname === '/entities'
    ? json({ results: { entities: [{ ...entity(target), tags: rawTags }] } })
    : undefined);
  const client = new BoundedQlooClient(key, fixture.request);
  const cold = await client.run('rank', () => client.entities([target]));
  const expected = [{ entityId: target, tags: [
    { type: QLOO_TAG_TYPES[0], name: 'Sushi' },
    ...Array.from({ length: 11 }, (_, index) => ({ type: QLOO_TAG_TYPES[index % QLOO_TAG_TYPES.length], name: `Tag ${index}` })),
  ] }];
  assert.deepEqual(cold.entityTags, expected);
  const warm = await client.run('rank', () => client.entities([target]));
  assert.deepEqual(warm.entityTags, expected);
  assert.equal(warm.http.cacheHits, 1); assert.equal(fixture.calls.length, 1);
});

test('a named describe still searches and validates details through the official resolver', async () => {
  const fixture = fixtureRequest(); const server = mcp(fixture.request);
  try {
    const result = await server.call('tools/call', { name: 'qloo_describe', arguments: { entity: `Fixture ${anchor}`, type: 'artist' } });
    const raw = result.structuredContent as Record<string, unknown>;
    const resolution = normalizeResolution({ ...raw, http: (result._meta as { tastecaseHttp: unknown }).tastecaseHttp }, { id: randomUUID(), kind: 'music', label: `Fixture ${anchor}` }, 64000);
    assert.equal(resolution.providerStatus, 'ok'); assert.equal(resolution.candidates[0]?.entityId, anchor);
    assert.deepEqual(fixture.calls.map(url => url.pathname), ['/search', '/entities']);
    assert.ok(fixture.calls.every(url => !url.searchParams.has('feature.explainability')));
  } finally { server.close(); }
});

test('429 stops at either endpoint without a hidden retry or shortening a 120-second Retry-After', { timeout: 5000 }, async () => {
  for (const endpoint of ['/entities', '/v2/insights']) {
    const fixture = fixtureRequest(url => url.pathname === endpoint ? json({ message: key, raw: 'Fixture private provider diagnostic' }, { status: 429, headers: { 'Retry-After': '120', 'X-Request-Id': key } }) : undefined);
    const server = mcp(fixture.request);
    try {
      const result = await server.call('tools/call', { name: 'qloo_rank', arguments: { options, option_type: 'place', signals: [anchor] } });
      const rank = normalized(result);
      assert.deepEqual(rank.error, { code: 'QLOO_RATE_LIMIT', category: 'transient', retryable: false });
      assert.equal(rank.http?.attempts, endpoint === '/entities' ? 1 : 2);
      assert.deepEqual(rank.http?.requests.at(-1), { endpoint, status: 429, retryAfterSeconds: 120 });
      assert.equal(fixture.calls.filter(url => url.pathname === endpoint).length, 1);
      assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(result).includes('Fixture private provider diagnostic'));
    } finally { server.close(); }
  }
});

test('HTTP errors remain distinct and a provider wait never enters the shorter worker retry path', async () => {
  for (const [status, header, code, retryable] of [[401, null, 'QLOO_AUTH', false], [403, null, 'QLOO_AUTH', false],
    [400, null, 'QLOO_CONTRACT', false], [503, null, 'QLOO_UPSTREAM', true], [503, '600', 'QLOO_UPSTREAM', false],
    [429, 'Fixture invalid retry header', 'QLOO_RATE_LIMIT', false]] as const) {
    const fixture = fixtureRequest(() => json({}, { status, headers: header === null ? {} : { 'Retry-After': header } })); const server = mcp(fixture.request);
    try {
      const rank = normalized(await server.call('tools/call', { name: 'qloo_rank', arguments: { options, option_type: 'place', signals: [anchor] } }));
      assert.equal(rank.error?.code, code); assert.equal(rank.error?.retryable, retryable); assert.equal(fixture.calls.length, 1);
    } finally { server.close(); }
  }
});

test('malformed, oversized, duplicate, outside-ID and credential-echo output never becomes cached evidence', async () => {
  for (const reply of [() => new Response('{Fixture malformed'), () => new Response('x'.repeat(5 * 1024 * 1024 + 1)),
    () => json({ results: { entities: [entity(anchor), entity(anchor)] } }),
    () => json({ results: { entities: [entity(randomUUID())] } }),
    () => json({ results: { entities: [entity(anchor)] }, reason: key })]) {
    const fixture = fixtureRequest(reply); const server = mcp(fixture.request);
    try {
      const rank = normalized(await server.call('tools/call', { name: 'qloo_rank', arguments: { options, option_type: 'place', signals: [anchor] } }));
      assert.equal(rank.providerStatus, 'error'); assert.equal(rank.error?.code, 'QLOO_CONTRACT'); assert.equal(fixture.calls.length, 1);
      assert.ok(!JSON.stringify(rank).includes(key));
    } finally { server.close(); }
  }
});

test('missing IDs remain unavailable and cannot cause an Insights call or a negative preference', async () => {
  const fixture = fixtureRequest(() => json({ results: { entities: [] } })); const server = mcp(fixture.request);
  try {
    const rank = normalized(await server.call('tools/call', { name: 'qloo_rank', arguments: { options, option_type: 'place', signals: [anchor] } }));
    assert.equal(rank.providerStatus, 'needs_input'); assert.deepEqual(rank.orderedEntryIds, []); assert.equal(rank.missingEntryIds.length, 7);
    assert.equal(fixture.calls.length, 1);
  } finally { server.close(); }
});

test('the HTTP ceiling rejects a third dispatch before fetch, while network failures remain single charged attempts', async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return json({ results: {} }); };
  const client = new BoundedQlooClient(key, request);
  assert.ok(!JSON.stringify(client).includes(key));
  await assert.rejects(client.run('rank', async () => { for (let index = 0; index < 3; index++) await client.insights({}); }),
    (error: unknown) => error instanceof QlooWorkflowExecutionError && error.code === 'QLOO_CONTRACT');
  assert.equal(calls, 2);
  const server = mcp(async () => { calls++; throw new Error(key); });
  try {
    const rank = normalized(await server.call('tools/call', { name: 'qloo_rank', arguments: { options, option_type: 'place', signals: [anchor] } }));
    assert.equal(rank.error?.code, 'QLOO_CONNECT'); assert.equal(rank.error?.retryable, false);
    assert.deepEqual(rank.http?.requests, [{ endpoint: '/entities', status: null, retryAfterSeconds: null }]);
    assert.equal(calls, 3); assert.ok(!JSON.stringify(rank).includes(key));
  } finally { server.close(); }
});

test('cache is private to one client, expires and never caches omissions', async () => {
  let now = 0; const fixture = fixtureRequest(); const client = new BoundedQlooClient(key, fixture.request, () => now);
  const lookup = () => client.run('rank', () => client.entities([anchor]));
  assert.equal((await lookup()).http.attempts, 1);
  const hit = await lookup(); assert.equal(hit.http.attempts, 0); assert.equal(hit.http.cacheHits, 1);
  now = 15 * 60 * 1000;
  assert.equal((await lookup()).http.attempts, 1);
  const other = new BoundedQlooClient(key, fixture.request);
  assert.equal((await other.run('rank', () => other.entities([anchor]))).http.attempts, 1);
  const omitted = fixtureRequest(() => json({ results: { entities: [] } })); const missing = new BoundedQlooClient(key, omitted.request);
  for (let index = 0; index < 2; index++) assert.equal((await missing.run('rank', () => missing.entities([anchor]))).http.attempts, 1);
});

test('cancellation stops before dispatch or aborts one in-flight request without a retry', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const client = new BoundedQlooClient(key, async () => { calls++; throw new Error('Fixture network forbidden'); });
  await assert.rejects(client.run('rank', () => client.insights({}), controller.signal)); assert.equal(calls, 0);
  const running = new AbortController();
  const delayed = new BoundedQlooClient(key, async (_input, init) => {
    calls++; return new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error(key)), { once: true }); running.abort(); });
  });
  await assert.rejects(delayed.run('rank', () => delayed.insights({}), running.signal), (error: unknown) => error instanceof QlooWorkflowExecutionError && error.code === 'CANCELLED');
  assert.equal(calls, 1);
});

test('dispatches stay at least 250ms apart across workflows; cancelled waits charge no attempt', async () => {
  let now = 1000; const starts: number[] = []; const waits: number[] = [];
  const pause = async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); waits.push(ms); now += ms; };
  const client = new BoundedQlooClient(key, async () => { starts.push(now); now += 40; return json({ results: {} }); }, () => now, pause);
  await client.run('rank', async () => { await client.insights({}); await client.insights({}); });
  await client.run('rank', () => client.insights({}));
  assert.deepEqual(starts, [1000, 1250, 1500]); assert.deepEqual(waits, [210, 210]);
  assert.ok(starts.every((start, index) => index === 0 || start - starts[index - 1] >= minimumDispatchGapMs));
  now += 1000; await client.run('rank', () => client.insights({})); assert.equal(waits.length, 2);
  const controller = new AbortController(); let calls = 0;
  const cancelled = new BoundedQlooClient(key, async () => { calls++; return json({ results: {} }); }, () => now,
    async (_ms, signal) => { controller.abort(); signal.throwIfAborted(); });
  const first = await cancelled.run('rank', () => cancelled.insights({}));
  assert.equal(first.http.attempts, 1);
  await assert.rejects(cancelled.run('rank', () => cancelled.insights({}), controller.signal),
    (error: unknown) => error instanceof QlooWorkflowExecutionError && error.code === 'CANCELLED');
  assert.equal(calls, 1);
});

test('only finite numeric delays, bounded counts and allowlisted endpoint paths can be serialized', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  assert.equal(retryAfterSeconds('120', now), 120); assert.equal(retryAfterSeconds('Sat, 17 Oct 2026 12:02:00 GMT', now), 120);
  for (const value of ['-1', '1.5', key, '99999999999999999999999999', 'Infinity', '120 seconds']) assert.equal(retryAfterSeconds(value, now), null);
  const http = { maxAttempts: 2, attempts: 1, cacheHits: 0, requests: [{ endpoint: '/entities', status: 429, retryAfterSeconds: 120 }] };
  for (const extra of [{ body: key }, { headers: { 'X-Api-Key': key } }, { requestId: key }, { attempts: 3 }, { attempts: 0 }, { maxAttempts: 3 }]) assert.equal(QlooHttpDiagnosticsSchema.safeParse({ ...http, ...extra }).success, false);
  assert.equal(QlooHttpDiagnosticsSchema.safeParse({ ...http, requests: [{ ...http.requests[0], endpoint: `${QLOO_HOST}/entities?key=${key}` }] }).success, false);
});
