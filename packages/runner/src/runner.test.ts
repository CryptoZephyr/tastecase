import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClaimAttemptResponseSchema, CreateCatalogVersionRequestSchema, CreateTaskVersionRequestSchema,
  NormalizedTraceSchema, RunnerHandshakeRequestSchema, SCHEMA_VERSION, TargetInputSchema, TargetResultSchema, TraceEventSchema,
  UploadTargetResultRequestSchema, checksum, type ClaimAttemptResponse, type TargetAdapter, type TargetResult,
} from '@tastecase/contracts';
import {
  RunnerClient, RunnerError, createLiteLLMAdapter, createConfiguredAdapter, configuredAdapterMetadata,
  OPENROUTER_ADAPTER_METADATA, OPENROUTER_MODEL, runCli, runOnce, validateEndpoint, type Fetch,
} from './index.js';

// All IDs, text and credentials below are synthetic. No environment inheritance/live fetch.
const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const token = `tc_runner_${'x'.repeat(43)}`;
const key = 'synthetic-provider-key';
const env = { TASTECASE_API_ORIGIN: 'https://api.example.test', TASTECASE_RUNNER_TOKEN: token, LITELLM_BASE_URL: 'https://model.example.test/v1', LITELLM_API_KEY: key };
const metadata = { name: 'synthetic-adapter', version: '1' };
const handshake = { schema_version: SCHEMA_VERSION, projectId: id(1), credentialId: id(9), leaseDurationSeconds: 300 };
const success = TargetResultSchema.parse({ schema_version: SCHEMA_VERSION, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'outside-synthetic-catalog', name: 'Outside Synthetic Cafe', reason: 'Fictional preference' }] }, trace: { completeness: 'unavailable', events: [] } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const apiError = (code: string, status: number) => json({ schema_version: SCHEMA_VERSION, error: { code, message: `UNTRUSTED BODY ${token} ${key}` } }, status);
const completion = (content: string, extra: Record<string, unknown> = {}) => json({ choices: [{ message: { content } }], ...extra });

function syntheticClaim(projectId = id(1)): ClaimAttemptResponse {
  const catalogBody = CreateCatalogVersionRequestSchema.parse({ schema_version: SCHEMA_VERSION, id: id(2), label: 'Synthetic catalog', entries: [
    { id: 'synthetic-cafe', name: 'Synthetic Cafe', qlooEntityId: id(5), constraintFacts: { dietaryOptions: ['vegetarian'] } },
    { id: 'synthetic-bistro', name: 'Synthetic Bistro', metadata: { description: 'Ineligible synthetic fact' } },
  ] });
  const taskBody = CreateTaskVersionRequestSchema.parse({ schema_version: SCHEMA_VERSION, id: id(3), catalogVersionId: id(2), label: 'Synthetic task', syntheticBrief: { provenance: 'synthetic', label: 'Fictional lunch', text: 'A made-up guest wants a quiet lunch.' }, syntheticInterests: [{ provenance: 'synthetic', label: 'Fictional interest', text: 'Imaginary pottery outings' }], constraints: { partySize: 2, dietaryRequirements: [], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: ['synthetic-bistro'] } });
  const createdAt = '2026-01-01T00:00:00.000Z';
  return ClaimAttemptResponseSchema.parse({ schema_version: SCHEMA_VERSION, attemptId: id(7), leaseId: id(8), leaseExpiresAt: '2100-01-01T00:00:00.000Z', input: {
    schema_version: SCHEMA_VERSION, projectId,
    catalog: { ...catalogBody, projectId, createdAt, checksum: checksum(catalogBody) },
    task: { ...taskBody, projectId, createdAt, checksum: checksum(taskBody) },
    mappings: [{ schema_version: SCHEMA_VERSION, id: id(4), projectId, catalogVersionId: id(2), catalogEntryId: 'synthetic-cafe', qlooEntityId: id(5), confirmedBy: id(6), createdAt }], eligibleCatalogEntryIds: ['synthetic-cafe'],
  } });
}

interface RequestLog { url: string; init: RequestInit; body: unknown }
function mockApi(options: { claim?: ClaimAttemptResponse | null; upload?: Response; onUpload?: (body: string) => Response | Promise<Response> } = {}) {
  const requests: RequestLog[] = [];
  const fetch: Fetch = async (url, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    requests.push({ url: String(url), init: init ?? {}, body });
    if (String(url).endsWith('/runner/handshake')) return json(handshake);
    if (String(url).endsWith('/runner/claims')) return options.claim === null ? new Response(null, { status: 204 }) : json(options.claim ?? syntheticClaim());
    if (options.onUpload) return options.onUpload(String(init?.body));
    if (options.upload) return options.upload;
    const upload = UploadTargetResultRequestSchema.parse(body);
    return json({ schema_version: SCHEMA_VERSION, attemptId: id(7), status: 'completed', resultChecksum: checksum(upload.result), idempotent: false });
  };
  return { requests, fetch, client: new RunnerClient({ env, fetch }) };
}
function queuedClaim(attemptNumber: number): ClaimAttemptResponse {
  const claim = syntheticClaim();
  return ClaimAttemptResponseSchema.parse({ ...claim, attemptId: id(attemptNumber), leaseId: id(attemptNumber + 100) });
}
function mockQueueApi(claims: ClaimAttemptResponse[]) {
  const requests: RequestLog[] = [];
  let claimIndex = 0;
  const fetch: Fetch = async (url, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    const path = new URL(String(url)).pathname;
    requests.push({ url: String(url), init: init ?? {}, body });
    if (path.endsWith('/runner/handshake')) return json(handshake);
    if (path.endsWith('/runner/claims')) {
      const claim = claims[claimIndex++];
      return claim ? json(claim) : new Response(null, { status: 204 });
    }
    if (path.endsWith('/results')) {
      const upload = UploadTargetResultRequestSchema.parse(body);
      const attemptId = path.split('/').at(-2);
      if (!attemptId) throw new Error('Missing synthetic attempt ID');
      return json({ schema_version: SCHEMA_VERSION, attemptId, status: 'completed', resultChecksum: checksum(upload.result), idempotent: false });
    }
    throw new Error('Unexpected synthetic API request');
  };
  return { requests, fetch, client: new RunnerClient({ env, fetch }) };
}
function adapter(run: TargetAdapter['run'] = async () => success): TargetAdapter { return { ...metadata, run }; }
const context = () => ({ signal: new AbortController().signal });

function syntheticComparisonClaim(): ClaimAttemptResponse {
  const ordinary = syntheticClaim();
  return ClaimAttemptResponseSchema.parse({ ...ordinary, input: { ...ordinary.input, execution: {
    kind: 'comparison', comparisonId: id(80), caseId: id(81), suiteVersionId: id(82),
    suiteChecksum: 'a'.repeat(64), caseChecksum: 'b'.repeat(64), expectationVersionId: id(83),
    expectationChecksum: 'c'.repeat(64), evidenceChecksum: 'd'.repeat(64), role: 'candidate',
    assistantVersion: 'local-release', profileId: 'a', repeat: 0,
  } } });
}

for (const release of [undefined, 'wrong-release', 'local-release']) {
  test(`comparison execution requires exact local binding: ${release ?? 'unbound'}`, async () => {
    const claim = syntheticComparisonClaim();
    const api = mockApi({ claim });
    const client = new RunnerClient({ env: { ...env, ...(release ? { TASTECASE_ASSISTANT_VERSION: release } : {}) }, fetch: api.fetch });
    let calls = 0;
    const outcome = await runOnce(client, adapter(async () => { calls++; return success; }));
    assert.equal(outcome.status, release === 'local-release' ? 'completed' : 'failed');
    assert.equal(calls, release === 'local-release' ? 1 : 0);
    assert.deepEqual(api.requests[1].body, { schema_version: SCHEMA_VERSION, ...(release ? { assistantVersion: release } : {}) });
  });
}

test('comparison pinned text containing configured local secrets is rejected, not silently redacted before execution', async () => {
  const claim = syntheticComparisonClaim();
  const secret = 'another-synthetic-credential';
  claim.input.task.syntheticBrief.text = `Synthetic task containing ${secret}`;
  const payload = Object.fromEntries(Object.entries(claim.input.task).filter(([name]) => !['projectId', 'checksum', 'createdAt'].includes(name)));
  claim.input.task.checksum = checksum(payload);
  const api = mockApi({ claim }); let calls = 0;
  const client = new RunnerClient({ env: { ...env, OTHER_SECRET: secret, TASTECASE_ASSISTANT_VERSION: 'local-release' }, fetch: api.fetch });
  const result = await runOnce(client, adapter(async () => { calls++; return success; }));
  assert.deepEqual(result, { status: 'failed', stage: 'claim', code: 'invalid_response' });
  assert.equal(calls, 0);
});

test('bound runner still executes ordinary discovery/foundation work without deriving a model from its label', async () => {
  const api = mockApi();
  const client = new RunnerClient({ env, assistantVersion: 'explicit-local-release', fetch: api.fetch });
  assert.equal((await runOnce(client, adapter())).status, 'completed');
});

test('unsafe or blank assistant version is rejected without making claims', () => {
  for (const assistantVersion of ['', ' release ', key, token, 'release\nlabel']) {
    assert.throws(() => new RunnerClient({ env, assistantVersion }), { code: 'configuration_error' });
  }
});

// API origin and credential boundaries.
for (const url of ['https://api.example.test', 'https://api.example.test:8443/']) {
  test(`HTTPS origin accepted: ${url}`, () => assert.equal(validateEndpoint(url, { originOnly: true }).protocol, 'https:'));
}
for (const url of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://127.0.0.2:3001', 'http://[::1]:3001']) {
  test(`loopback HTTP requires explicit opt-in: ${url}`, () => {
    assert.throws(() => validateEndpoint(url), { code: 'configuration_error' });
    assert.equal(validateEndpoint(url, { allowLoopbackHttp: true }).protocol, 'http:');
  });
}
for (const url of ['http://api.example.test', 'http://localhost.evil.test', 'http://127.0.0.1.evil.test', 'http://0.0.0.0', 'ftp://api.example.test', 'https://user:password@api.example.test', 'https://api.example.test?token=synthetic', 'https://api.example.test#synthetic', 'https://api.example.test?', 'https://api.example.test/#', 'https://api.example.test/path', ' https://api.example.test', 'https://api.example.test\\@evil.test', '/relative']) {
  test(`invalid/credential-bearing origin rejected: ${url}`, () => assert.throws(() => validateEndpoint(url, { originOnly: true, allowLoopbackHttp: true }), { code: 'configuration_error' }));
}

test('configured endpoints reject raw controls instead of URL parser normalisation', () => {
  for (const suffix of ['\u0000', '\u001f', '\u007f']) assert.throws(() => validateEndpoint(`https://api.example.test/${suffix}`), { code: 'configuration_error' });
});

test('known local credentials are rejected in configured endpoint host/path', () => {
  assert.throws(() => new RunnerClient({ env, apiOrigin: `https://${token}.example.test` }), { code: 'configuration_error' });
  assert.throws(() => createLiteLLMAdapter({ env, baseUrl: `https://model.example.test/${key}` }), { code: 'configuration_error' });
  assert.throws(() => createLiteLLMAdapter({ env, baseUrl: `https://model.example.test/${[...key].map(character => `%${character.charCodeAt(0).toString(16)}`).join('')}` }), { code: 'configuration_error' });
});

test('client requires environment runner credential and bounded timeout', () => {
  for (const runnerToken of [undefined, '', 'Bearer synthetic', `${token}\n`]) assert.throws(() => new RunnerClient({ env: { ...env, TASTECASE_RUNNER_TOKEN: runnerToken } }), { code: 'configuration_error' });
  for (const requestTimeoutMs of [0, NaN, 120_001]) assert.throws(() => new RunnerClient({ env, requestTimeoutMs }), { code: 'configuration_error' });
});

test('handshake validates version and sends only adapter metadata with header bearer', async () => {
  const { client, requests } = mockApi();
  assert.deepEqual(await client.handshake({ ...metadata, ...{ providerKey: key } }), handshake);
  assert.deepEqual(RunnerHandshakeRequestSchema.parse(requests[0].body), { schema_version: SCHEMA_VERSION, runner: { name: 'tastecase-local', version: '0.1.0' }, adapter: metadata, supportedSchemaVersions: [SCHEMA_VERSION] });
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), `Bearer ${token}`);
  assert.equal(requests[0].init.redirect, 'manual');
  assert.equal(JSON.stringify(requests[0].body).includes(token) || JSON.stringify(requests[0].body).includes(key), false);
  assert.equal(JSON.stringify(client), '{}');
});

test('credential-shaped adapter metadata is rejected before any API call', async () => {
  const { client, requests } = mockApi();
  await assert.rejects(client.handshake({ name: token, version: '1' }), { code: 'invalid_request' });
  await assert.rejects(client.handshake({ name: key, version: '1' }), { code: 'invalid_request' });
  assert.equal(requests.length, 0);
});

test('handshake version mismatch and unknown response fields fail closed', async () => {
  for (const response of [{ ...handshake, schema_version: '2.0.0' }, { ...handshake, targetUrl: 'https://evil.test' }]) {
    const client = new RunnerClient({ env, fetch: async () => json(response) });
    await assert.rejects(client.handshake(metadata), { code: 'invalid_response' });
    await assert.rejects(client.claim(), { code: 'configuration_error' });
  }
});

test('claim before handshake is rejected', async () => {
  const { client, requests } = mockApi();
  await assert.rejects(client.claim(), { code: 'configuration_error' });
  assert.equal(requests.length, 0);
});

test('204 is no work; adapter is never called', async () => {
  const { client, requests } = mockApi({ claim: null });
  let calls = 0;
  assert.deepEqual(await runOnce(client, adapter(async () => { calls++; return success; })), { status: 'no_work' });
  assert.equal(calls, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, { schema_version: SCHEMA_VERSION });
});

test('JSON null/empty response is not no-work', async () => {
  for (const response of [json(null), new Response(''), json({})]) {
    const client = new RunnerClient({ env, fetch: async url => String(url).endsWith('handshake') ? json(handshake) : response });
    await client.handshake(metadata);
    await assert.rejects(client.claim(), { code: 'invalid_response' });
  }
});

test('cross-project claim is rejected before invoking target', async () => {
  const { client, requests } = mockApi({ claim: syntheticClaim(id(99)) });
  let calls = 0;
  assert.deepEqual(await runOnce(client, adapter(async () => { calls++; return success; })), { status: 'failed', stage: 'claim', code: 'project_mismatch' });
  assert.equal(calls, 0);
  assert.equal(requests.length, 2);
});

test('invalid claim input checksums, eligibility and extra target code are rejected', async () => {
  const claim = syntheticClaim();
  const badInputs = [
    { ...claim.input, catalog: { ...claim.input.catalog, checksum: '0'.repeat(64) } },
    { ...claim.input, eligibleCatalogEntryIds: ['synthetic-cafe', 'synthetic-cafe'] },
    { ...claim.input, task: { ...claim.input.task, projectId: id(99) } },
    { ...claim.input, targetCode: 'not-authorised' },
  ];
  for (const input of badInputs) {
    const client = new RunnerClient({ env, fetch: async url => String(url).endsWith('handshake') ? json(handshake) : json({ ...claim, input }) });
    await client.handshake(metadata);
    await assert.rejects(client.claim(), { code: 'invalid_response' });
  }
});

test('run-once validates pinned input and uploads exact attempt/lease/result without taste failure', async () => {
  const { client, requests } = mockApi();
  let calls = 0;
  const outcome = await runOnce(client, adapter(async (input, ctx) => {
    assert.deepEqual(TargetInputSchema.parse(input), syntheticClaim().input);
    assert.ok(ctx.signal instanceof AbortSignal);
    calls++;
    return success;
  }));
  assert.equal(outcome.status, 'completed');
  assert.equal(calls, 1);
  assert.equal(requests[2].url, `https://api.example.test/runner/attempts/${id(7)}/results`);
  assert.deepEqual(requests[2].body, { schema_version: SCHEMA_VERSION, leaseId: id(8), result: success });
});

test('upload acknowledgement must match attempt identity and canonical result checksum', async () => {
  for (const response of [
    { schema_version: SCHEMA_VERSION, attemptId: id(99), status: 'completed', resultChecksum: checksum(success), idempotent: false },
    { schema_version: SCHEMA_VERSION, attemptId: id(7), status: 'completed', resultChecksum: '0'.repeat(64), idempotent: false },
  ]) {
    const { client } = mockApi({ upload: json(response) });
    await client.handshake(metadata);
    await assert.rejects(client.uploadResult(syntheticClaim(), success), { code: 'invalid_response' });
  }
});

test('cross-project upload and invalid adapter result are not serialized', async () => {
  const { client, requests } = mockApi();
  await client.handshake(metadata);
  await assert.rejects(client.uploadResult(syntheticClaim(id(99)), success), { code: 'invalid_request' });
  await assert.rejects(client.uploadResult(syntheticClaim(), { ...success, ...{ providerKey: key } }), { code: 'adapter_invalid_result' });
  assert.equal(requests.length, 1);
});

test('runner and provider credentials reflected in target text are redacted before upload', async () => {
  const { client, requests } = mockApi();
  const result = TargetResultSchema.parse({ schema_version: SCHEMA_VERSION, outcome: 'malformed_output', rawText: `bad ${token} ${key}`, error: { code: 'bad_output', message: `bad ${key}` }, trace: { completeness: 'unavailable', events: [] } });
  const outcome = await runOnce(client, adapter(async () => result));
  assert.equal(outcome.status, 'completed');
  for (const value of [JSON.stringify(outcome), JSON.stringify(requests.map(request => request.body))]) assert.equal(value.includes(token) || value.includes(key), false);
  assert.match(JSON.stringify(requests[2].body), /REDACTED/);
});

test('ambiguous upload returns local pending payload; explicit retry reuses identical body/lease without recomputation', async () => {
  let uploadCalls = 0;
  let targetCalls = 0;
  const bodies: string[] = [];
  const { client } = mockApi({ onUpload: async body => {
    uploadCalls++;
    bodies.push(body);
    if (uploadCalls === 1) throw new Error(`synthetic network failure ${token}`);
    const payload = UploadTargetResultRequestSchema.parse(JSON.parse(body));
    return json({ schema_version: SCHEMA_VERSION, attemptId: id(7), status: 'completed', resultChecksum: checksum(payload.result), idempotent: true });
  } });
  const outcome = await runOnce(client, adapter(async () => { targetCalls++; return success; }));
  assert.equal(outcome.status, 'unavailable');
  assert.equal(uploadCalls, 1);
  if (outcome.status !== 'unavailable' || !outcome.pendingUpload) throw new Error('Expected pending local upload');
  assert.equal((await client.uploadResult(outcome.pendingUpload.claim, outcome.pendingUpload.result)).idempotent, true);
  assert.equal(targetCalls, 1);
  assert.equal(bodies[0], bodies[1]);
});

for (const stage of ['handshake', 'claim', 'upload'] as const) {
  test(`revoked credential at ${stage} is a clear status and does not retry`, async () => {
    let targetCalls = 0;
    let requests = 0;
    const fetch: Fetch = async (url, init) => {
      requests++;
      if (String(url).endsWith('handshake')) return stage === 'handshake' ? apiError('credential_revoked', 401) : json(handshake);
      if (String(url).endsWith('claims')) return stage === 'claim' ? apiError('credential_revoked', 401) : json(syntheticClaim());
      assert.equal(UploadTargetResultRequestSchema.parse(JSON.parse(String(init?.body))).leaseId, id(8));
      return apiError('credential_revoked', 401);
    };
    const client = new RunnerClient({ env, fetch });
    const outcome = await runOnce(client, adapter(async () => { targetCalls++; return success; }));
    assert.deepEqual(outcome, { status: 'credential_revoked', stage });
    assert.equal(targetCalls, stage === 'upload' ? 1 : 0);
    assert.equal(requests, stage === 'handshake' ? 1 : stage === 'claim' ? 2 : 3);
    await assert.rejects(client.claim(), { code: 'configuration_error' });
  });
}

test('unauthorized and server unavailable errors never surface remote body', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [503, 'unavailable']] as const) {
    const client = new RunnerClient({ env, fetch: async () => new Response(`UNTRUSTED ${token} ${key}`, { status }) });
    const outcome = await runOnce(client, adapter());
    assert.equal(outcome.status, expected);
    assert.equal(JSON.stringify(outcome).includes(token) || JSON.stringify(outcome).includes(key), false);
  }
});

for (const status of [301, 302, 307, 308]) {
  test(`API redirect ${status} never forwards credentials`, async () => {
    let calls = 0;
    const client = new RunnerClient({ env, fetch: async (_, init) => {
      calls++;
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status, headers: { location: `https://evil.test/${token}` } });
    } });
    await assert.rejects(client.handshake(metadata), { code: 'redirect_rejected' });
    assert.equal(calls, 1);
  });
}

test('already-followed redirect response is rejected even when fetch was injected', async () => {
  const response = json(handshake);
  Object.defineProperty(response, 'redirected', { value: true });
  const client = new RunnerClient({ env, fetch: async () => response });
  await assert.rejects(client.handshake(metadata), { code: 'redirect_rejected' });
});

test('network timeout bounds a fetch implementation that ignores AbortSignal', async () => {
  let seenSignal: AbortSignal | undefined;
  const client = new RunnerClient({ env, requestTimeoutMs: 10, fetch: async (_, init) => {
    seenSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => undefined);
  } });
  await assert.rejects(client.handshake(metadata), { code: 'timeout' });
  assert.equal(seenSignal?.aborted, true);
});

test('network deadline also bounds response body streaming and cancels the reader', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }));
  const client = new RunnerClient({ env, requestTimeoutMs: 10, fetch: async () => response });
  await assert.rejects(client.handshake(metadata), { code: 'timeout' });
  assert.equal(cancelled, true);
});

test('oversized declared/streamed API bodies fail closed', async () => {
  for (const response of [new Response('{}', { headers: { 'content-length': String(17 * 1024 * 1024) } }), new Response(new Uint8Array(17 * 1024 * 1024))]) {
    const client = new RunnerClient({ env, fetch: async () => response });
    await assert.rejects(client.handshake(metadata), { code: 'invalid_response' });
  }
});

test('external abort before run prevents all network and target calls', async () => {
  const { client, requests } = mockApi();
  const signal = AbortSignal.abort();
  assert.deepEqual(await runOnce(client, adapter(), { signal }), { status: 'failed', stage: 'handshake', code: 'aborted' });
  assert.equal(requests.length, 0);
});

test('expired lease or insufficient upload reserve prevents target calls', async () => {
  for (const leaseExpiresAt of ['2000-01-01T00:00:00.000Z', new Date(Date.now() + 1000).toISOString()]) {
    let calls = 0;
    const { client, requests } = mockApi({ claim: { ...syntheticClaim(), leaseExpiresAt } });
    assert.deepEqual(await runOnce(client, adapter(async () => { calls++; return success; })), { status: 'lease_expired', stage: 'target' });
    assert.equal(calls, 0);
    assert.equal(requests.length, 2);
  }
});

test('deadline aborts non-cooperative adapter and uploads unavailable evidence, not a taste failure', async () => {
  const { client, requests } = mockApi();
  let targetSignal: AbortSignal | undefined;
  const outcome = await runOnce(client, adapter(async (_, ctx) => { targetSignal = ctx.signal; return new Promise<TargetResult>(() => undefined); }), { targetTimeoutMs: 10 });
  assert.equal(outcome.status, 'completed');
  assert.equal(targetSignal?.aborted, true);
  const payload = UploadTargetResultRequestSchema.parse(requests[2].body);
  assert.equal(payload.result.outcome, 'provider_unavailable');
  assert.deepEqual(payload.result.trace, { completeness: 'unavailable', events: [] });
});

test('unexpected adapter exception is safe provider-unavailable, invalid returned result is rejected', async () => {
  const { client, requests } = mockApi();
  const outcome = await runOnce(client, adapter(async () => { throw new Error(`${token} ${key}`); }));
  assert.equal(outcome.status, 'completed');
  assert.equal(UploadTargetResultRequestSchema.parse(requests[2].body).result.outcome, 'provider_unavailable');
  assert.equal(JSON.stringify(outcome).includes(token) || JSON.stringify(outcome).includes(key), false);
  const second = mockApi();
  // Runtime validation also protects JavaScript adapters that violate the TypeScript interface.
  assert.deepEqual(await runOnce(second.client, adapter(async () => ({ ...success, schema_version: 'wrong' } as unknown as TargetResult))), { status: 'failed', stage: 'target', code: 'adapter_invalid_result' });
  assert.equal(second.requests.length, 2);
});

test('lease expiry during local execution is not uploaded', async () => {
  let now = Date.parse('2099-12-31T23:59:00.000Z');
  const { client, requests } = mockApi();
  const outcome = await runOnce(client, adapter(async () => { now += 61_000; return success; }), { now: () => now });
  assert.deepEqual(outcome, { status: 'lease_expired', stage: 'upload' });
  assert.equal(requests.length, 2);
});

test('server lease-expired/conflicting upload responses are explicit', async () => {
  for (const [code, status] of [['lease_expired', 'lease_expired'], ['conflict', 'failed']] as const) {
    const { client } = mockApi({ upload: apiError(code, 409) });
    const outcome = await runOnce(client, adapter());
    assert.equal(outcome.status, status);
    assert.equal('stage' in outcome && outcome.stage, 'upload');
  }
});

// Real LiteLLM request construction and completion parsing with synthetic injected fetch only.
test('LiteLLM default nova-micro sends only synthetic task and eligible facts, not private identity/mappings/secrets', async () => {
  let seenUrl = '';
  let seenInit: RequestInit = {};
  const local = createLiteLLMAdapter({ env, fetch: async (url, init) => {
    seenUrl = String(url); seenInit = init ?? {};
    return completion(JSON.stringify({ recommendations: [{ catalogEntryId: 'synthetic-cafe', name: 'Synthetic Cafe', reason: 'Synthetic explanation' }] }), { id: 'synthetic-account-id', usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20, account: key } });
  } });
  const response = await local.runWithUsage(syntheticClaim().input, context());
  assert.equal(seenUrl, 'https://model.example.test/v1/chat/completions');
  assert.equal(new Headers(seenInit.headers).get('authorization'), `Bearer ${key}`);
  assert.equal(seenInit.redirect, 'manual');
  const request = JSON.parse(String(seenInit.body)) as { model: string; messages: { role: string; content: string }[] };
  assert.equal(request.model, 'nova-micro');
  const task = JSON.parse(request.messages[1].content) as { eligibleCatalog: unknown[]; constraints: Record<string, unknown> };
  assert.deepEqual(task.eligibleCatalog, [{ id: 'synthetic-cafe', name: 'Synthetic Cafe', constraintFacts: { dietaryOptions: ['vegetarian'] } }]);
  for (const forbidden of [token, key, id(1), id(2), id(3), id(4), id(5), id(6), 'Ineligible synthetic fact', 'synthetic-bistro']) assert.equal(String(seenInit.body).includes(forbidden), false);
  assert.equal('excludedEntryIds' in task.constraints, false);
  assert.equal(response.result.outcome, 'success');
  assert.deepEqual(response.usage, { promptTokens: 13, completionTokens: 7, totalTokens: 20 });
  assert.equal(response.result.trace.completeness, 'partial');
  assert.equal(response.result.trace.events.length, 1);
  assert.equal(JSON.stringify(response).includes(key) || JSON.stringify(local).includes(key), false);
});

test('LiteLLM custom model and unknown/name-only recommendations retain actual order and do not invent IDs', async () => {
  const output = { recommendations: [{ name: 'Synthetic Name Only' }, { catalogEntryId: 'outside-synthetic', name: 'Outside Synthetic Restaurant' }, { catalogEntryId: 'synthetic-cafe', name: 'Synthetic Cafe', reason: 'Synthetic explanation' }], text: 'Synthetic ranking explanation' };
  const local = createLiteLLMAdapter({ env: { ...env, LITELLM_MODEL: 'owner-selected-model' }, fetch: async (_, init) => {
    assert.equal((JSON.parse(String(init?.body)) as { model: string }).model, 'owner-selected-model');
    return completion(JSON.stringify(output));
  } });
  const result = await local.run(syntheticClaim().input, context());
  assert.equal(result.outcome, 'success');
  if (result.outcome !== 'success') throw new Error('Expected success');
  assert.deepEqual(result.output, output);
});

for (const content of ['{', '```json\n{"recommendations":[]}\n```', '{"recommendations":[{"catalogEntryId":"synthetic-cafe"}]}', '{"recommendations":[],"targetUrl":"https://evil.test"}']) {
  test(`invalid actual target output preserved separately: ${content.slice(0, 30)}`, async () => {
    const local = createLiteLLMAdapter({ env, fetch: async () => completion(content) });
    const result = await local.run(syntheticClaim().input, context());
    assert.equal(result.outcome, 'malformed_output');
    if (result.outcome !== 'malformed_output') throw new Error('Expected malformed output');
    assert.equal(result.rawText, content);
    assert.equal(result.trace.completeness, 'partial');
  });
}

test('malformed output redacts local credentials and bounds raw target text', async () => {
  const local = createLiteLLMAdapter({ env, fetch: async () => completion(`bad ${token} ${key} ${'x'.repeat(64_000)}`) });
  const result = await local.run(syntheticClaim().input, context());
  assert.equal(result.outcome, 'malformed_output');
  if (result.outcome !== 'malformed_output') throw new Error('Expected malformed output');
  assert.equal(result.rawText.length, 64_000);
  assert.equal(result.error.code, 'invalid_target_output_truncated');
  assert.equal(JSON.stringify(result).includes(token) || JSON.stringify(result).includes(key), false);
});

test('valid output reflected keys are redacted too; no trace claims model internals', async () => {
  const local = createLiteLLMAdapter({ env, fetch: async () => completion(JSON.stringify({ recommendations: [{ name: 'Synthetic Cafe', reason: `${token} ${key}` }] })) });
  const result = await local.run(syntheticClaim().input, context());
  assert.equal(result.outcome, 'success');
  assert.equal(JSON.stringify(result).includes(token) || JSON.stringify(result).includes(key), false);
  assert.equal(result.trace.completeness, 'partial');
  assert.ok(result.trace.events.every(event => ['target_started', 'target_completed'].includes(event.kind)));
});

test('escaped provider credentials are redacted in parsed and malformed target output', async () => {
  const localKey = 'synthetic\\quoted"key';
  const escaped = JSON.stringify(localKey).slice(1, -1);
  const unicode = [...localKey].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  for (const content of [JSON.stringify({ recommendations: [{ name: 'Synthetic Cafe', reason: localKey }] }), `{"recommendations":[{"name":"Synthetic Cafe","reason":"${unicode}"}]}`, `bad ${escaped}`]) {
    const local = createLiteLLMAdapter({ env: { ...env, LITELLM_API_KEY: localKey }, fetch: async () => completion(content) });
    const result = await local.run(syntheticClaim().input, context());
    const text = result.outcome === 'success' ? result.output.recommendations[0].reason : result.outcome === 'malformed_output' ? result.rawText : undefined;
    assert.ok(text);
    assert.equal(text.includes(localKey) || text.includes(escaped), false);
    assert.match(text, /REDACTED/);
  }
});

for (const [status, code, retryable] of [[401, 'provider_authentication_failed', false], [429, 'provider_rate_limited', true], [503, 'provider_http_error', true]] as const) {
  test(`provider HTTP ${status} is unavailable, not malformed output; no retry/raw HTTP body`, async () => {
    let calls = 0;
    const local = createLiteLLMAdapter({ env, fetch: async () => { calls++; return new Response(`UNTRUSTED BODY ${key} ${token}`, { status }); } });
    const result = await local.run(syntheticClaim().input, context());
    assert.equal(result.outcome, 'provider_unavailable');
    if (result.outcome !== 'provider_unavailable') throw new Error('Expected provider unavailable');
    assert.equal(result.error.code, code);
    assert.equal(result.retryable, retryable);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(key) || JSON.stringify(result).includes(token) || JSON.stringify(result).includes('UNTRUSTED BODY'), false);
  });
}

test('provider redirect is rejected without forwarding key', async () => {
  let calls = 0;
  const local = createLiteLLMAdapter({ env, fetch: async (_, init) => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 307, headers: { location: 'https://evil.test' } });
  } });
  const result = await local.run(syntheticClaim().input, context());
  assert.equal(result.outcome, 'provider_unavailable');
  if (result.outcome !== 'provider_unavailable') throw new Error('Expected provider unavailable');
  assert.equal(result.error.code, 'provider_redirect_rejected');
  assert.equal(result.retryable, false);
  assert.equal(calls, 1);
});

test('provider network failure and deadline produce distinct safe unavailable results without retries', async () => {
  for (const timeout of [false, true]) {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const local = createLiteLLMAdapter({ env, providerTimeoutMs: 10, fetch: async (_, init) => {
      calls++; signal = init?.signal ?? undefined;
      if (timeout) return new Promise<Response>(() => undefined);
      throw new Error(`sensitive ${key}`);
    } });
    const result = await local.run(syntheticClaim().input, context());
    assert.equal(result.outcome, 'provider_unavailable');
    if (result.outcome !== 'provider_unavailable') throw new Error('Expected provider unavailable');
    assert.equal(result.error.code, timeout ? 'provider_timeout' : 'provider_network_unavailable');
    assert.equal(calls, 1);
    assert.equal(signal?.aborted, true);
    assert.equal(JSON.stringify(result).includes(key), false);
  }
});

test('aborted provider signal prevents request and returns explicit unavailable evidence', async () => {
  let calls = 0;
  const local = createLiteLLMAdapter({ env, fetch: async () => { calls++; return completion('{}'); } });
  const result = await local.run(syntheticClaim().input, { signal: AbortSignal.abort() });
  assert.equal(result.outcome, 'provider_unavailable');
  if (result.outcome !== 'provider_unavailable') throw new Error('Expected provider unavailable');
  assert.equal(result.error.code, 'provider_cancelled');
  assert.equal(result.retryable, false);
  assert.equal(calls, 0);
});

test('invalid/missing provider completion envelope is not invented output or preserved account data', async () => {
  for (const response of [json({ choices: [], account: key }), json({ choices: [{ message: { content: null, tool_calls: [{ arguments: key }] } }] }), new Response('not JSON'), new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } })]) {
    const local = createLiteLLMAdapter({ env, fetch: async () => response });
    const result = await local.run(syntheticClaim().input, context());
    assert.equal(result.outcome, 'provider_unavailable');
    assert.equal(JSON.stringify(result).includes(key), false);
  }
});

test('usage exposes only available nonnegative safe integer counters locally', async () => {
  const local = createLiteLLMAdapter({ env, fetch: async () => completion('{"recommendations":[]}', { usage: { prompt_tokens: -1, completion_tokens: 1.5, total_tokens: 9, accountId: key } }) });
  assert.deepEqual((await local.runWithUsage(syntheticClaim().input, context())).usage, { totalTokens: 9 });
});

test('invalid provider configuration/input fails before calls; configured loopback is explicit', async () => {
  for (const options of [
    { env: { ...env, LITELLM_API_KEY: undefined } }, { env: { ...env, LITELLM_API_KEY: 'invalid\nkey' } },
    { env, baseUrl: 'http://model.example.test' }, { env, baseUrl: 'https://user:password@model.example.test/v1' },
    { env, baseUrl: 'https://model.example.test/v1?key=synthetic' }, { env, model: key },
  ]) assert.throws(() => createLiteLLMAdapter(options), { code: 'configuration_error' });
  let calls = 0;
  const local = createLiteLLMAdapter({ env, baseUrl: 'http://127.0.0.1:4001/v1', allowLoopbackHttp: true, fetch: async url => { calls++; assert.equal(String(url), 'http://127.0.0.1:4001/v1/chat/completions'); return completion('{"recommendations":[]}'); } });
  await assert.rejects(local.run({ ...syntheticClaim().input, ...{ targetUrl: 'https://evil.test' } }, context()), { code: 'invalid_request' });
  assert.equal(calls, 0);
  assert.equal((await local.run(syntheticClaim().input, context())).outcome, 'success');
});

// CLI metadata only, no live provider invocation.
test('CLI handshake requires no provider key and outputs metadata only', async () => {
  const lines: string[] = [];
  const { fetch, requests } = mockApi();
  assert.equal(await runCli(['handshake'], { env: { ...env, LITELLM_API_KEY: undefined }, fetch, write: line => lines.push(line) }), 0);
  assert.equal(requests.length, 1);
  assert.deepEqual((requests[0].body as {adapter:unknown}).adapter,OPENROUTER_ADAPTER_METADATA);
  assert.equal((JSON.parse(lines[0]) as { status: string }).status, 'ready');
  assert.equal(lines.join('\n').includes(token) || lines.join('\n').includes(key), false);
});

test('default configured adapter pins the free model and ignores legacy provider environment', async () => {
  let calls=0;
  const local=createConfiguredAdapter({env:{...env,OPENROUTER_API_KEY:key,LITELLM_MODEL:'paid-model'},fetch:async(url,init)=>{
    calls++;assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${key}`);
    assert.equal(init?.redirect,'manual');
    const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
    assert.equal(body.model,OPENROUTER_MODEL);
    assert.deepEqual(body.provider,{allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0,request:0}});
    assert.deepEqual(body.reasoning,{enabled:false,exclude:true});assert.deepEqual(body.response_format,{type:'json_object'});
    assert.equal(body.max_tokens,4096);assert.equal(body.temperature,0);
    for (const secret of [key,token,id(1),id(2),'Ineligible synthetic fact','synthetic-bistro']) assert.equal(String(init?.body).includes(secret),false);
    return completion('{"recommendations":[{"catalogEntryId":"synthetic-cafe","name":"Synthetic Cafe"}]}');
  }});
  assert.equal(local.name,OPENROUTER_ADAPTER_METADATA.name);
  const result=await local.run(syntheticClaim().input,context());
  assert.equal(result.outcome,'success');assert.equal(result.trace.completeness,'partial');assert.equal(calls,1);
});

test('OpenRouter requires its own key; legacy adapter is explicit and never an automatic fallback', async () => {
  assert.throws(()=>createConfiguredAdapter({env}),{code:'configuration_error'});
  assert.throws(()=>createConfiguredAdapter({env:{...env,OPENROUTER_API_KEY:'invalid\nkey'}}),{code:'configuration_error'});
  assert.throws(()=>createConfiguredAdapter({env:{...env,OPENROUTER_API_KEY:key},model:'paid-model'}),{code:'configuration_error'});
  assert.throws(()=>createConfiguredAdapter({env:{...env,OPENROUTER_API_KEY:key},baseUrl:'https://other.example/v1'}),{code:'configuration_error'});
  assert.throws(()=>configuredAdapterMetadata({TASTECASE_MODEL_PROVIDER:'unknown'}),{code:'configuration_error'});
  const legacy=createConfiguredAdapter({env:{...env,TASTECASE_MODEL_PROVIDER:'litellm'},fetch:async url=>{
    assert.equal(String(url),'https://model.example.test/v1/chat/completions');return completion('{"recommendations":[]}');
  }});
  assert.equal(legacy.name,'litellm-openai');assert.equal((await legacy.run(syntheticClaim().input,context())).outcome,'success');
});

test('OpenRouter failures are one dispatch with safe auth, rate-limit and malformed-output states', async () => {
  for (const status of [401,402,403,429,500]) {
    let calls=0;
    const local=createConfiguredAdapter({env:{...env,OPENROUTER_API_KEY:key},fetch:async()=>{calls++;return new Response(`${key} ${token}`,{status});}});
    const result=await local.run(syntheticClaim().input,context());
    assert.equal(result.outcome,'provider_unavailable');assert.equal(calls,1);
    assert.equal(JSON.stringify(result).includes(key)||JSON.stringify(result).includes(token),false);
    if (result.outcome==='provider_unavailable') assert.equal(result.error.code,status===401||status===403?'provider_authentication_failed':status===429?'provider_rate_limited':'provider_http_error');
  }
  const local=createConfiguredAdapter({env:{...env,OPENROUTER_API_KEY:key},fetch:async()=>completion(`invalid ${key} ${token}`)});
  const result=await local.run(syntheticClaim().input,context());
  assert.equal(result.outcome,'malformed_output');assert.equal(JSON.stringify(result).includes(key)||JSON.stringify(result).includes(token),false);
});

test('trace contracts accept several target completion events in one result', () => {
  const events = [
    { kind: 'target_completed', name: metadata.name, timestamp: '2026-01-01T00:00:00.000Z', durationMs: 10, status: 'unavailable' },
    { kind: 'target_completed', name: metadata.name, timestamp: '2026-01-01T00:00:01.000Z', durationMs: 20, status: 'ok' },
  ] as const;
  assert.equal(TraceEventSchema.safeParse(events[0]).success, true);
  assert.equal(NormalizedTraceSchema.safeParse({ completeness: 'partial', events }).success, true);
  assert.equal(TargetResultSchema.safeParse({ ...success, trace: { completeness: 'partial', events } }).success, true);
});

test('provider retry records each HTTP dispatch and reuses the exact request body', async () => {
  const bodies: string[] = [];
  let calls = 0;
  const local = createLiteLLMAdapter({
    env, providerRetries: 1, sleep: async () => {},
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      calls++;
      return calls === 1 ? new Response(null, { status: 429 }) : completion('{"recommendations":[]}');
    },
  });
  const result = await local.run(syntheticClaim().input, context());
  assert.equal(result.outcome, 'success');
  assert.equal(calls, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(result.trace.events.map(event => [event.kind, event.status]), [['target_completed', 'unavailable'], ['target_completed', 'ok']]);
  assert.equal(result.trace.events.length, 2);
});

test('Retry-After is honored in seconds and capped at ten seconds', async () => {
  const waits: number[] = [];
  let calls = 0;
  const local = createLiteLLMAdapter({
    env, providerRetries: 1, sleep: async milliseconds => { waits.push(milliseconds); },
    fetch: async () => ++calls === 1
      ? new Response(null, { status: 503, headers: { 'Retry-After': '30' } })
      : completion('{"recommendations":[]}'),
  });
  assert.equal((await local.run(syntheticClaim().input, context())).outcome, 'success');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [10_000]);
});

test('missing Retry-After uses two seconds then five seconds', async () => {
  const waits: number[] = [];
  let calls = 0;
  const local = createLiteLLMAdapter({
    env, providerRetries: 2, sleep: async milliseconds => { waits.push(milliseconds); },
    fetch: async () => {
      calls++;
      return calls < 3 ? new Response(null, { status: calls === 1 ? 502 : 504 }) : completion('{"recommendations":[]}');
    },
  });
  assert.equal((await local.run(syntheticClaim().input, context())).outcome, 'success');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2_000, 5_000]);
});

test('provider retries are opt-in and other HTTP statuses are never retried', async () => {
  const noRetryWaits: number[] = [];
  let noRetryCalls = 0;
  const rateLimited = createLiteLLMAdapter({ env, fetch: async () => { noRetryCalls++; return new Response(null, { status: 429 }); }, sleep: async ms => { noRetryWaits.push(ms); } });
  assert.equal((await rateLimited.run(syntheticClaim().input, context())).outcome, 'provider_unavailable');
  assert.equal(noRetryCalls, 1);
  assert.deepEqual(noRetryWaits, []);
  for (const status of [401, 402, 403, 418, 500, 501, 505]) {
    let calls = 0;
    const local = createLiteLLMAdapter({ env, providerRetries: 2, fetch: async () => { calls++; return new Response(null, { status }); }, sleep: async () => {} });
    assert.equal((await local.run(syntheticClaim().input, context())).outcome, 'provider_unavailable');
    assert.equal(calls, 1);
  }
});

test('network errors and redirects are never retried', async () => {
  for (const response of ['network', 'redirect'] as const) {
    let calls = 0;
    const local = createLiteLLMAdapter({
      env, providerRetries: 2, sleep: async () => {},
      fetch: async () => {
        calls++;
        if (response === 'network') throw new TypeError('Synthetic network failure');
        return new Response(null, { status: 302, headers: { Location: 'https://redirect.example.test' } });
      },
    });
    assert.equal((await local.run(syntheticClaim().input, context())).outcome, 'provider_unavailable');
    assert.equal(calls, 1);
  }
});

test('timeouts are not retried and retries stop when the delay plus margin misses the deadline', async () => {
  let timeoutCalls = 0;
  const timeout = createLiteLLMAdapter({
    env, providerRetries: 2, providerTimeoutMs: 10,
    fetch: async () => { timeoutCalls++; return new Promise<Response>(() => {}); },
    sleep: async () => { throw new Error('Timeout must not sleep'); },
  });
  const timedOut = await timeout.run(syntheticClaim().input, context());
  assert.equal(timedOut.outcome, 'provider_unavailable');
  assert.equal(timeoutCalls, 1);
  if (timedOut.outcome === 'provider_unavailable') assert.equal(timedOut.error.code, 'provider_timeout');

  let deadlineCalls = 0;
  const waits: number[] = [];
  const deadline = createLiteLLMAdapter({
    env, providerRetries: 1, providerTimeoutMs: 2_500,
    fetch: async () => { deadlineCalls++; return new Response(null, { status: 429 }); },
    sleep: async milliseconds => { waits.push(milliseconds); },
  });
  assert.equal((await deadline.run(syntheticClaim().input, context())).outcome, 'provider_unavailable');
  assert.equal(deadlineCalls, 1);
  assert.deepEqual(waits, []);
});

test('invalid envelopes and malformed output are not retried', async () => {
  for (const response of [json({ choices: [] }), completion('not JSON')]) {
    let calls = 0;
    const local = createLiteLLMAdapter({ env, providerRetries: 2, fetch: async () => { calls++; return response; }, sleep: async () => {} });
    await local.run(syntheticClaim().input, context());
    assert.equal(calls, 1);
  }
});

test('provider retries reject values outside zero through two', () => {
  for (const providerRetries of [-1, 3, 1.5, NaN]) {
    assert.throws(() => createLiteLLMAdapter({ env, providerRetries }), { code: 'configuration_error' });
  }
});

test('CLI run-once uses the default OpenRouter adapter for claim, dispatch and upload', async () => {
  const api=mockApi();const lines:string[]=[];let modelCalls=0;const bodies:string[]=[];
  const fetch:Fetch=async(url,init)=>{
    if(String(url).startsWith('https://openrouter.ai/')){modelCalls++;bodies.push(String(init?.body));return modelCalls===1?new Response(null,{status:503}):completion('{"recommendations":[{"catalogEntryId":"synthetic-cafe","name":"Synthetic Cafe"}]}');}
    return api.fetch(url,init);
  };
  assert.equal(await runCli(['run-once','--provider-retries','1'],{env:{...env,OPENROUTER_API_KEY:key},fetch,write:line=>lines.push(line)}),0);
  assert.equal(modelCalls,2);assert.equal(bodies[0],bodies[1]);assert.equal(api.requests.length,3);
  assert.equal(JSON.parse(lines[0]).outcome,'success');
  assert.equal(lines.join('').includes(key)||lines.join('').includes(token),false);
});

test('CLI run-once prints no target/raw text or pending result and returns no-work/completed exits', async () => {
  for (const claim of [null, syntheticClaim()]) {
    const lines: string[] = [];
    const { fetch } = mockApi({ claim });
    assert.equal(await runCli(['run-once', '--request-timeout-ms', '100', '--target-timeout-ms', '100'], { env, fetch, adapter: adapter(), write: line => lines.push(line) }), 0);
    assert.equal((JSON.parse(lines[0]) as { status: string }).status, claim ? 'completed' : 'no_work');
    for (const forbidden of [token, key, 'Fictional preference', 'Outside Synthetic Cafe']) assert.equal(lines.join('\n').includes(forbidden), false);
  }
});

test('CLI run drains uploaded outcomes through a target timeout and reports all outcome counts', async () => {
  const api = mockQueueApi([queuedClaim(21), queuedClaim(22), queuedClaim(23)]);
  const lines: string[] = [];
  const malformedResult = TargetResultSchema.parse({
    schema_version: SCHEMA_VERSION, outcome: 'malformed_output', rawText: 'PRIVATE_TARGET_TEXT',
    error: { code: 'invalid_target_output', message: 'Invalid synthetic output.' }, trace: { completeness: 'partial', events: [] },
  });
  let adapterCalls = 0;
  const local = adapter(async () => {
    adapterCalls++;
    if (adapterCalls === 2) return new Promise<TargetResult>(() => {});
    return adapterCalls === 3 ? malformedResult : success;
  });
  const code = await runCli(['run', '--target-timeout-ms', '15'], { env, fetch: api.fetch, adapter: local, write: line => lines.push(line) });
  assert.equal(code, 4);
  assert.equal(adapterCalls, 3);
  assert.equal(api.requests.filter(request => request.url.endsWith('/results')).length, 3);
  assert.equal(lines.length, 4);
  const summary = JSON.parse(lines[3] ?? '') as { status: string; attempts: number; outcomes: Record<string, number> };
  assert.deepEqual(summary, { status: 'drained', attempts: 3, outcomes: { success: 1, malformed_output: 1, provider_unavailable: 1 } });
  for (const line of lines.slice(0, 3)) assert.equal((JSON.parse(line) as { status: string }).status, 'completed');
  assert.equal(lines.join('\n').includes('pendingUpload') || lines.join('\n').includes('PRIVATE_TARGET_TEXT'), false);
});

test('CLI run stops on revoked credentials with exit 3', async () => {
  const lines: string[] = [];
  const code = await runCli(['run'], { env, fetch: async () => apiError('credential_revoked', 401), adapter: adapter(), write: line => lines.push(line) });
  assert.equal(code, 3);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), { status: 'credential_revoked', attempts: 0, outcomes: { success: 0, malformed_output: 0, provider_unavailable: 0 } });
});

test('CLI run stops at max attempts with exit 6', async () => {
  const api = mockQueueApi([queuedClaim(31), queuedClaim(32)]);
  const lines: string[] = [];
  const code = await runCli(['run', '--max-attempts', '2'], { env, fetch: api.fetch, adapter: adapter(), write: line => lines.push(line) });
  assert.equal(code, 6);
  assert.deepEqual(JSON.parse(lines.at(-1) ?? ''), { status: 'attempt_limit', attempts: 2, outcomes: { success: 2, malformed_output: 0, provider_unavailable: 0 } });
  assert.equal(api.requests.filter(request => request.url.endsWith('/runner/claims')).length, 2);
});

test('CLI run observes abort between uploaded attempts', async () => {
  const api = mockQueueApi([queuedClaim(41), queuedClaim(42)]);
  const controller = new AbortController();
  const lines: string[] = [];
  const code = await runCli(['run'], {
    env, fetch: api.fetch, adapter: adapter(), signal: controller.signal,
    write: line => {
      lines.push(line);
      if ((JSON.parse(line) as { status?: string }).status === 'completed') controller.abort();
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(lines.at(-1) ?? ''), { status: 'failed', attempts: 1, outcomes: { success: 1, malformed_output: 0, provider_unavailable: 0 } });
  assert.equal(api.requests.filter(request => request.url.endsWith('/runner/claims')).length, 1);
});

test('CLI run exits zero after an immediate no-work claim', async () => {
  const api = mockQueueApi([]);
  const lines: string[] = [];
  assert.equal(await runCli(['run'], { env, fetch: api.fetch, adapter: adapter(), write: line => lines.push(line) }), 0);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), { status: 'drained', attempts: 0, outcomes: { success: 0, malformed_output: 0, provider_unavailable: 0 } });
  assert.equal(lines.length, 1);
});

test('CLI provider retry and max-attempt arguments are command-scoped and bounded', async () => {
  const cases = [
    ['run-once', '--provider-retries', '3'],
    ['run', '--provider-retries', '3'],
    ['replay', '--provider-retries', '3'],
    ['handshake', '--provider-retries', '1'],
    ['run-once', '--max-attempts', '2'],
    ['replay', '--max-attempts', '2'],
    ['handshake', '--max-attempts', '2'],
    ['run', '--max-attempts', '0'],
    ['run', '--max-attempts', '121'],
  ];
  for (const args of cases) assert.equal(await runCli(args, { env, write: () => {} }), 1);
});

test('CLI revocation/unavailability are clear exit statuses without raw errors', async () => {
  for (const [response, exit] of [[apiError('credential_revoked', 401), 3], [apiError('internal_error', 503), 4]] as const) {
    const lines: string[] = [];
    assert.equal(await runCli(['handshake'], { env, fetch: async () => response, write: line => lines.push(line) }), exit);
    assert.equal(lines.join('\n').includes(token) || lines.join('\n').includes(key), false);
  }
});

test('CLI rejects unexpected/secret-bearing arguments without echo, help documents environment', async () => {
  for (const args of [[], ['watch'], ['run-once', '--token', token], ['run-once', '--target-timeout-ms', '0'], ['handshake', '--target-timeout-ms', '2'], ['handshake', '--allow-loopback-http', '--allow-loopback-http']]) {
    const lines: string[] = [];
    assert.equal(await runCli(args, { env, write: line => lines.push(line) }), 1);
    assert.equal(lines.join('\n').includes(token), false);
  }
  const lines: string[] = [];
  assert.equal(await runCli(['--help'], { write: line => lines.push(line) }), 0);
  assert.match(lines[0], /nova-micro/);
  assert.match(lines[0], /LITELLM_API_KEY/);
  assert.match(lines[0], /OPENROUTER_API_KEY/);
  assert.ok(new RunnerError('invalid_response', 'Synthetic safe error') instanceof Error);
});
