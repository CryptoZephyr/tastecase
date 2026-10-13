import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SCHEMA_VERSION, IdSchema, canonicalJson, checksum, CatalogVersionSchema, TaskVersionSchema, TargetInputSchema,
  CreateCatalogVersionRequestSchema, CreateTaskVersionRequestSchema, CreateProjectRequestSchema,
  CreateMappingConfirmationRequestSchema, QueueAttemptRequestSchema, RunnerHandshakeRequestSchema,
  ClaimAttemptRequestSchema, ClaimAttemptResponseSchema, UploadTargetResultRequestSchema,
  MintRunnerCredentialResponseSchema, TargetResultSchema, NormalizedTraceSchema, AttemptSchema, REST_CONTRACTS,
} from './index.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const catalogId = '00000000-0000-4000-8000-000000000002';
const taskId = '00000000-0000-4000-8000-000000000003';
const mappingId = '00000000-0000-4000-8000-000000000004';
const entityId = '00000000-0000-4000-8000-000000000005';
const ownerId = '00000000-0000-4000-8000-000000000006';
const attemptId = '00000000-0000-4000-8000-000000000007';
const leaseId = '00000000-0000-4000-8000-000000000008';
const createdAt = '2026-01-01T00:00:00.000Z';
const catalogPayload = CreateCatalogVersionRequestSchema.parse({
  schema_version: SCHEMA_VERSION, id: catalogId, label: 'Synthetic catalog',
  entries: [{ id: 'synthetic-cafe', name: 'Synthetic Cafe' }, { id: 'synthetic-bistro', name: 'Synthetic Bistro', constraintFacts: { dietaryOptions: ['vegetarian'] } }],
});
const taskPayload = CreateTaskVersionRequestSchema.parse({
  schema_version: SCHEMA_VERSION, id: taskId, label: 'Synthetic task', catalogVersionId: catalogId,
  syntheticBrief: { provenance: 'synthetic', label: 'Fictional lunch', text: 'A made-up guest wants a quiet lunch.' },
  syntheticInterests: [{ provenance: 'synthetic', label: 'Fictional interest', text: 'Imaginary pottery outings' }],
  constraints: { partySize: 2, dietaryRequirements: [], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: [] },
});
const catalog = CatalogVersionSchema.parse({ ...catalogPayload, projectId, createdAt, checksum: checksum(catalogPayload) });
const task = TaskVersionSchema.parse({ ...taskPayload, projectId, createdAt, checksum: checksum(taskPayload) });
const mapping = { schema_version: SCHEMA_VERSION, id: mappingId, projectId, catalogVersionId: catalogId, catalogEntryId: 'synthetic-cafe', qlooEntityId: entityId, confirmedBy: ownerId, createdAt };
const input = TargetInputSchema.parse({ schema_version: SCHEMA_VERSION, projectId, catalog, task, mappings: [mapping], eligibleCatalogEntryIds: ['synthetic-cafe'] });
const result = TargetResultSchema.parse({ schema_version: SCHEMA_VERSION, outcome: 'success', output: { recommendations: [{ name: 'Outside Synthetic Cafe', catalogEntryId: 'outside-catalog' }] }, trace: { completeness: 'unavailable', events: [] } });

for (const [name, value] of [
  ['undefined', undefined], ['NaN', NaN], ['Infinity', Infinity], ['Date', new Date()], ['BigInt', 1n],
  ['function', () => 1], ['sparse array', new Array(2)], ['symbol keys', { [Symbol('x')]: 1 }],
  ['getter', { get x() { return 1; } }], ['nested undefined', { x: undefined }],
  ['array symbol', Object.assign([1], { [Symbol('hidden')]: 2 })],
  ['array getter', Object.defineProperty([1], '0', { get: () => 1 })],
  ['array hidden property', Object.defineProperty([1], 'hidden', { value: 2 })],
  ['object hidden property', Object.defineProperty({}, 'hidden', { value: 2 })],
] as const) {
  test(`canonical JSON rejects ${name}`, () => assert.throws(() => canonicalJson(value), TypeError));
}
test('canonical JSON rejects cycles but allows repeated non-cyclic values', () => {
  const cycle: { child?: unknown } = {};
  cycle.child = cycle;
  assert.throws(() => canonicalJson(cycle), /cycles/);
  assert.equal(canonicalJson({ a: cycle.child = { x: 1 }, b: cycle.child }), '{"a":{"x":1},"b":{"x":1}}');
});
test('canonical JSON sorts keys recursively and preserves ordered arrays, escaping and scalars', () => {
  assert.equal(canonicalJson({ z: [false, null, -0, 'a\nb'], a: { y: 2, b: 1 } }), '{"a":{"b":1,"y":2},"z":[false,null,0,"a\\nb"]}');
});
test('checksums match a fixed SHA256 vector and are independent of object insertion order', () => {
  assert.equal(checksum({ b: 2, a: 1 }), '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  assert.equal(checksum({ b: 2, a: 1 }), checksum({ a: 1, b: 2 }));
  assert.notEqual(checksum([1, 2]), checksum([2, 1]));
});
test('version rows verify checksums of the validated create payload, not server metadata', () => {
  assert.equal(CatalogVersionSchema.safeParse({ ...catalog, projectId: ownerId }).success, true);
  assert.equal(CatalogVersionSchema.safeParse({ ...catalog, label: 'Changed label' }).success, false);
  assert.equal(TaskVersionSchema.safeParse({ ...task, constraints: { ...task.constraints, partySize: 3 } }).success, false);
});
test('catalog requires unique stable entry IDs and accepts absent unknown facts', () => {
  assert.equal(CreateCatalogVersionRequestSchema.safeParse(catalogPayload).success, true);
  assert.equal(catalog.entries[0].constraintFacts, undefined);
  assert.equal(CreateCatalogVersionRequestSchema.safeParse({ ...catalogPayload, entries: [catalogPayload.entries[0], catalogPayload.entries[0]] }).success, false);
  assert.equal(CreateCatalogVersionRequestSchema.safeParse({ ...catalogPayload, entries: [{ id: '', name: 'Synthetic' }] }).success, false);
  assert.equal(CreateCatalogVersionRequestSchema.safeParse({ ...catalogPayload, entries: [{ id: 'a', name: 'Synthetic', qlooEntityId: 'not-a-uuid' }] }).success, false);
});
test('synthetic provenance is mandatory and practical constraints cannot be omitted or invented', () => {
  assert.equal(CreateTaskVersionRequestSchema.safeParse({ ...taskPayload, syntheticBrief: { label: 'Real guest', text: 'History' } }).success, false);
  assert.equal(CreateTaskVersionRequestSchema.safeParse({ ...taskPayload, constraints: { partySize: 2 } }).success, false);
  assert.equal(CreateTaskVersionRequestSchema.safeParse({ ...taskPayload, constraints: { ...taskPayload.constraints, tasteFailure: true } }).success, false);
});
test('mapping confirmation is explicit and all record IDs are normalised UUIDs', () => {
  assert.equal(IdSchema.parse('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(CreateMappingConfirmationRequestSchema.safeParse({ schema_version: SCHEMA_VERSION, id: mappingId, catalogVersionId: catalogId, catalogEntryId: 'synthetic-cafe', qlooEntityId: entityId }).success, true);
  assert.equal(CreateMappingConfirmationRequestSchema.safeParse({ ...mapping, id: 'entry-id' }).success, false);
  assert.equal(CreateProjectRequestSchema.safeParse({ schema_version: '2.0.0', name: 'Synthetic' }).success, false);
});
for (const [name, invalid] of [
  ['cross-project catalog', { ...input, catalog: { ...catalog, projectId: ownerId } }],
  ['cross-project task', { ...input, task: { ...task, projectId: ownerId } }],
  ['cross-project mapping', { ...input, mappings: [{ ...mapping, projectId: ownerId }] }],
  ['wrong catalog mapping', { ...input, mappings: [{ ...mapping, catalogVersionId: ownerId }] }],
  ['unknown mapping entry', { ...input, mappings: [{ ...mapping, catalogEntryId: 'missing' }] }],
  ['duplicate mapping', { ...input, mappings: [mapping, mapping] }],
  ['outside eligible ID', { ...input, eligibleCatalogEntryIds: ['outside-catalog'] }],
  ['duplicate eligible IDs', { ...input, eligibleCatalogEntryIds: ['synthetic-cafe', 'synthetic-cafe'] }],
] as const) {
  test(`pinned TargetInput rejects ${name}`, () => assert.equal(TargetInputSchema.safeParse(invalid).success, false));
}
test('pinned input rejects mismatched task catalog and excluded/unknown entries even with valid checksums', () => {
  for (const payload of [
    { ...taskPayload, catalogVersionId: ownerId },
    { ...taskPayload, constraints: { ...taskPayload.constraints, excludedEntryIds: ['synthetic-cafe'] } },
    { ...taskPayload, constraints: { ...taskPayload.constraints, excludedEntryIds: ['unknown'] } },
  ]) {
    assert.equal(TargetInputSchema.safeParse({ ...input, task: { ...payload, projectId, createdAt, checksum: checksum(payload) } }).success, false);
  }
});
test('queue input rejects duplicate mapping IDs and extra caller-owned fields', () => {
  const request = { schema_version: SCHEMA_VERSION, id: attemptId, catalogVersionId: catalogId, taskVersionId: taskId, mappingConfirmationIds: [mappingId], eligibleCatalogEntryIds: ['synthetic-cafe'] };
  assert.equal(QueueAttemptRequestSchema.safeParse(request).success, true);
  assert.equal(QueueAttemptRequestSchema.safeParse({ ...request, mappingConfirmationIds: [mappingId, mappingId] }).success, false);
  assert.equal(QueueAttemptRequestSchema.safeParse({ ...request, projectId: ownerId }).success, false);
});
test('target output outside the eligible catalog is retained, not discarded', () => {
  assert.equal(result.outcome, 'success');
  if (result.outcome === 'success') assert.equal(result.output.recommendations[0].catalogEntryId, 'outside-catalog');
});
test('malformed output and unavailable provider are distinct valid results', () => {
  const trace = { completeness: 'partial', events: [{ kind: 'target_started' }] };
  const error = { code: 'synthetic_error', message: 'Synthetic failure' };
  assert.equal(TargetResultSchema.parse({ schema_version: SCHEMA_VERSION, outcome: 'malformed_output', rawText: '{', error, trace }).outcome, 'malformed_output');
  assert.equal(TargetResultSchema.parse({ schema_version: SCHEMA_VERSION, outcome: 'provider_unavailable', error, retryable: true, trace }).outcome, 'provider_unavailable');
  assert.equal(TargetResultSchema.safeParse({ schema_version: SCHEMA_VERSION, outcome: 'provider_unavailable', output: {}, trace }).success, false);
});
test('trace completeness is mandatory and credential/header/body fields are rejected', () => {
  assert.equal(NormalizedTraceSchema.safeParse({ events: [] }).success, false);
  assert.equal(NormalizedTraceSchema.safeParse({ completeness: 'unavailable', events: [{ kind: 'tool_call' }] }).success, false);
  for (const field of ['headers', 'authorization', 'credentials', 'arguments', 'requestBody', 'responseBody']) {
    assert.equal(NormalizedTraceSchema.safeParse({ completeness: 'complete', events: [{ kind: 'tool_call', [field]: 'synthetic' }] }).success, false);
  }
});
test('runner handshake/claim/upload cannot choose project, target URL or arbitrary code', () => {
  const handshake = { schema_version: SCHEMA_VERSION, runner: { name: 'local', version: '1' }, adapter: { name: 'fixture', version: '1' }, supportedSchemaVersions: [SCHEMA_VERSION] };
  assert.equal(RunnerHandshakeRequestSchema.safeParse(handshake).success, true);
  for (const extra of [{ projectId }, { targetUrl: 'https://example.invalid' }, { code: 'synthetic' }]) {
    assert.equal(RunnerHandshakeRequestSchema.safeParse({ ...handshake, ...extra }).success, false);
    assert.equal(ClaimAttemptRequestSchema.safeParse({ schema_version: SCHEMA_VERSION, ...extra }).success, false);
    assert.equal(UploadTargetResultRequestSchema.safeParse({ schema_version: SCHEMA_VERSION, leaseId, result, ...extra }).success, false);
  }
  assert.equal(UploadTargetResultRequestSchema.safeParse({ schema_version: SCHEMA_VERSION, result }).success, false);
});
test('claim response pins stable attempt plus lease identity and resolved input', () => {
  assert.equal(ClaimAttemptResponseSchema.safeParse({ schema_version: SCHEMA_VERSION, attemptId, leaseId, leaseExpiresAt: createdAt, input }).success, true);
  assert.equal(ClaimAttemptResponseSchema.safeParse({ schema_version: SCHEMA_VERSION, attemptId, input }).success, false);
});
test('minted credentials have one-time token response and metadata has no token hash', () => {
  const response = { schema_version: SCHEMA_VERSION, token: `tc_runner_${'a'.repeat(43)}`, credential: { schema_version: SCHEMA_VERSION, id: ownerId, projectId, label: 'Synthetic local runner', createdAt, revokedAt: null } };
  assert.equal(MintRunnerCredentialResponseSchema.safeParse(response).success, true);
  assert.equal(MintRunnerCredentialResponseSchema.safeParse({ ...response, credential: { ...response.credential, tokenHash: 'a'.repeat(64) } }).success, false);
});
test('attempt state verifies result/input hashes and cannot confuse missing result with completion', () => {
  const attempt = { schema_version: SCHEMA_VERSION, id: attemptId, projectId, catalogVersionId: catalogId, taskVersionId: taskId, mappingConfirmationIds: [mappingId], status: 'queued', input, inputChecksum: checksum(input), leaseId: null, leaseCredentialId: null, leaseExpiresAt: null, result: null, resultChecksum: null, createdAt, completedAt: null };
  assert.equal(AttemptSchema.safeParse(attempt).success, true);
  assert.equal(AttemptSchema.safeParse({ ...attempt, status: 'completed' }).success, false);
  const completed = { ...attempt, status: 'completed', leaseId, leaseCredentialId: ownerId, leaseExpiresAt: createdAt, result, resultChecksum: checksum(result), completedAt: createdAt };
  assert.equal(AttemptSchema.safeParse(completed).success, true);
  assert.equal(AttemptSchema.safeParse({ ...completed, resultChecksum: '0'.repeat(64) }).success, false);
  assert.equal(AttemptSchema.safeParse({ ...attempt, mappingConfirmationIds: [] }).success, false);
});
test('REST contract contains project-bound owner reads, one-time mint/revoke and 204 no-work claim', () => {
  assert.equal(new Set(REST_CONTRACTS.map(route => `${route.method} ${route.path}`)).size, REST_CONTRACTS.length);
  assert.equal(REST_CONTRACTS.find(route => route.path === '/runner/claims')?.emptyStatus, 204);
  assert.equal(REST_CONTRACTS.filter(route => route.auth === 'runner').length, 3);
});
