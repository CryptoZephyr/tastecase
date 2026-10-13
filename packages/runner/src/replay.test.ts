import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  COMPARISON_LIMITS, CreateDiscoveryJobRequestSchema, DiscoveryCandidateSchema, DiscoveryEvidenceSchema,
  DiscoveryJobSchema, PinnedDiscoveryInputSchema, SuiteIdentitySchema, checksum, computeDiscoveryFacts,
  pinReviewEvidence, prepareReviewCase, prepareReviewDecision, prepareSuitePublication, prepareComparisonPlan,
  buildPortableTestPack, validateReplayReport, type ApprovedExpectation, type TargetAdapter, type TargetResult,
  type PortableTestPack,
} from '@tastecase/contracts';
import { createLiteLLMAdapter, readReplayPackFile, replayComparisonFile, replayComparisonRole, runCli, validateReplayPack } from './index.js';

const schema_version = '1.0.0' as const;
const createdAt = '2026-10-13T12:00:00.000Z';
const deadlineAt = '2026-10-13T12:30:00.000Z';
const env = { LITELLM_API_KEY: 'local-synthetic-provider-key', OTHER_SECRET: 'local-synthetic-extra-secret' };
const policy: ApprovedExpectation = { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'recommend_any', profileId: 'a', entryIds: ['one'] }] };
const objective: ApprovedExpectation = { classification: 'objective_contract', automaticFailure: true, profiles: ['a', 'b'], rules: [{ kind: 'output_schema' }] };
const success = (ids: (string | null)[] = ['one']): TargetResult => ({ schema_version, outcome: 'success',
  output: { text: 'PRIVATE_OUTPUT_TEXT', recommendations: ids.map(id => ({ ...(id === null ? {} : { catalogEntryId: id }), name: 'PRIVATE_NAME', reason: 'PRIVATE_REASON' })) },
  trace: { completeness: 'partial', events: [{ kind: 'tool_call', name: 'PRIVATE_EVENT' }] } });
const malformed: TargetResult = { schema_version, outcome: 'malformed_output', rawText: 'PRIVATE_RAW_TEXT', error: { code: 'invalid', message: 'PRIVATE_ERROR' }, trace: { completeness: 'partial', events: [] } };
const unavailable: TargetResult = { schema_version, outcome: 'provider_unavailable', retryable: true, error: { code: 'down', message: 'PRIVATE_PROVIDER_ERROR' }, trace: { completeness: 'unavailable', events: [] } };
const adapter = (run: TargetAdapter['run'] = async () => success()): TargetAdapter => ({ name: 'synthetic-local-adapter', version: '1', run });

/** Real published suite -> plan -> exported API pack, with intentionally unfinished discovery. */
function fixture(expectation: ApprovedExpectation = policy, repeatCount = 3, briefText = 'Full synthetic profile brief.'): PortableTestPack {
  const projectId = randomUUID(); const ownerId = randomUUID(); const jobId = randomUUID(); const catalogId = randomUUID(); const taskId = randomUUID();
  const catalogPayload = { schema_version, id: catalogId, label: 'Synthetic catalog', entries: ['one', 'two', 'excluded'].map(id => ({ id, name: `Synthetic ${id}`, constraintFacts: { dietaryOptions: ['vegetarian'] } })) };
  const brief = { provenance: 'synthetic' as const, label: 'Fictional lunch', text: 'A fictional lunch.' };
  const constraints = { partySize: 2, dietaryRequirements: ['vegetarian'], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: ['excluded'] };
  const taskPayload = { schema_version, id: taskId, label: 'Original task', catalogVersionId: catalogId, syntheticBrief: brief, syntheticInterests: [], constraints };
  const mappings = ['one', 'two'].map(catalogEntryId => ({ schema_version, id: randomUUID(), projectId, catalogVersionId: catalogId, catalogEntryId, qlooEntityId: randomUUID(), confirmedBy: ownerId, createdAt }));
  const request = CreateDiscoveryJobRequestSchema.parse({ schema_version, id: jobId, catalogVersionId: catalogId, taskVersionId: taskId,
    mappingConfirmationIds: mappings.map(row => row.id), eligibleCatalogEntryIds: ['one', 'two'], assistantVersion: 'discovery-release', repeatCount,
    profiles: ['a', 'b'].map(id => ({ id, provenance: 'public_synthetic', label: `Profile ${id}`, anchors: [{ id: randomUUID(), kind: 'film', label: `Public film ${id}` }] })) });
  const input = PinnedDiscoveryInputSchema.parse({ schema_version, request, targetInput: { schema_version, projectId,
    catalog: { ...catalogPayload, projectId, checksum: checksum(catalogPayload), createdAt }, task: { ...taskPayload, projectId, checksum: checksum(taskPayload), createdAt }, mappings, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds } });
  const confirmations = request.profiles.flatMap(profile => profile.anchors.map(anchor => ({ schema_version, id: randomUUID(), projectId, jobId, anchorId: anchor.id, resolutionId: null, entityId: randomUUID(), confirmedBy: ownerId, createdAt })));
  const rankIds: [string, string] = [randomUUID(), randomUUID()];
  const ranks = request.profiles.map(profile => ({ kind: 'rank' as const, providerStatus: 'partial' as const, profileId: profile.id, scope: 'full' as const,
    requestedEntryIds: ['one', 'two'], orderedEntryIds: profile.id === 'a' ? ['one', 'two'] : ['two', 'one'], missingEntryIds: [], unmappedEntryIds: [],
    mappingConfirmationIds: mappings.map(row => row.id), anchorConfirmationIds: confirmations.filter(row => profile.anchors.some(anchor => anchor.id === row.anchorId)).map(row => row.id) }));
  const [a, b] = ranks; assert.ok(a && b);
  const facts = computeDiscoveryFacts(jobId, rankIds, a, b); const contrast = facts.contrasts[0]; assert.ok(contrast);
  const evidence = [a, b, facts].map((data, i) => DiscoveryEvidenceSchema.parse({ schema_version, id: rankIds[i] ?? randomUUID(), projectId, jobId, attemptId: null, data, checksum: checksum(data), capturedAt: createdAt }));
  const content = { contrast, briefs: { a: { ...brief, text: `a ${briefText}` }, b: { ...brief, text: `b ${briefText}` }, constraints, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds }, evidenceIds: evidence.map(row => row.id), targetAttemptIds: [],
    proposedExpectation: { classification: 'advisory' as const, automaticFailure: false as const, humanReviewRequired: true as const, contrastId: contrast.id, rationale: 'Review this contrast.' }, limitations: ['Unfinished discovery.'] };
  const candidate = DiscoveryCandidateSchema.parse({ schema_version, id: randomUUID(), projectId, jobId, content, checksum: checksum(content), createdAt });
  const job = DiscoveryJobSchema.parse({ schema_version, id: jobId, projectId, input, inputChecksum: checksum(input), state: 'partial', checkpoint: 'saved', checkpointData: { evidenceIds: evidence.map(row => row.id), candidateIds: [candidate.id] },
    counters: { qlooAttempts: 0, modelDecisions: 0, targetAttempts: 0, rounds: 1 }, revision: 3, leaseId: null, leaseExpiresAt: null, availableAt: createdAt, deadlineAt, createdAt, cancelledAt: null, reason: 'No discovery targets completed.' });
  const pinned = pinReviewEvidence({ schema_version, projectId, jobId, candidate, job, evidence, targets: [], confirmations, resolutions: [], providerAttempts: [], capturedAt: createdAt });
  const initial = prepareReviewCase({ request: { schema_version, id: randomUUID(), jobId, candidateId: candidate.id }, projectId, candidate, createdAt });
  const approved = prepareReviewDecision({ request: { schema_version, id: randomUUID(), expectedRevision: 0, action: 'edit', expectation: expectation.classification === 'advisory' ? content.proposedExpectation : expectation, rationale: 'Owner approved scoped rule.' }, reviewCase: initial.case, head: initial.head, evidence: pinned, ownerId, createdAt });
  const version = approved.record.expectationVersion; assert.ok(version);
  const suite = SuiteIdentitySchema.parse({ schema_version, id: randomUUID(), projectId, name: 'Release suite', currentVersion: 0, createdAt });
  const snapshot = prepareSuitePublication({ request: { schema_version, id: randomUUID(), suiteId: suite.id, expectedVersion: 0, cases: [{ caseId: initial.case.id, expectationVersionId: version.id, expectedReviewRevision: approved.head.revision }] }, suite, selections: [{ case: initial.case, head: approved.head, review: approved.record }], ownerId, createdAt });
  return buildPortableTestPack(prepareComparisonPlan({ request: { schema_version, id: randomUUID(), suiteVersionId: snapshot.id, baselineVersion: 'release-before', candidateVersion: 'release-after', caseIds: [initial.case.id], deadlineAt, dispatchBudget: repeatCount * 4 + 2, reclaimBudget: 2 }, suite: snapshot, projectId, createdAt }));
}
const replay = (pack: PortableTestPack, run: TargetAdapter['run'] = async () => success(), extra: Partial<Parameters<typeof replayComparisonRole>[0]> = {}) => replayComparisonRole({ pack, role: 'candidate', assistantVersion: 'release-after', adapter: adapter(run), env, ...extra });
function rehash<T extends { checksum: string }>(row: T): T { return { ...row, checksum: checksum(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'checksum'))) }; }

async function packFile(pack = fixture()) {
  const dir = await mkdtemp(join(tmpdir(), 'tastecase-runner-replay-'));
  const path = join(dir, 'pack.json'); await writeFile(path, JSON.stringify(pack));
  return { pack, dir, path };
}

test('exported API helper pack round-trips and replays only the chosen role full-profile repeats', async () => {
  const { pack, path } = await packFile(); const loaded = await readReplayPackFile(path, { env, expectedChecksum: pack.checksum });
  assert.deepEqual(loaded, pack);
  const seen: string[] = [];
  const report = await replay(loaded, async input => { seen.push(`${input.execution?.role}:${input.execution?.profileId}:${input.execution?.repeat}`); assert.equal(input.execution?.assistantVersion, 'release-after'); return success(); });
  assert.deepEqual(seen, ['candidate:a:0', 'candidate:a:1', 'candidate:a:2', 'candidate:b:0', 'candidate:b:1', 'candidate:b:2']);
  assert.deepEqual(validateReplayReport(report, pack), report);
  assert.equal(report.comparisonReport.progress.completed, 6);
  assert.equal(report.comparisonReport.completion, 'partial');
  assert.ok(report.comparisonReport.repeats.filter(row => row.role === 'baseline').every(row => row.result.outcome === 'pending' && row.dispatchCount === 0));
  const text = JSON.stringify(report);
  for (const field of ['PRIVATE_OUTPUT_TEXT', 'PRIVATE_NAME', 'PRIVATE_REASON', 'PRIVATE_EVENT', 'rawText', 'runnerToken', 'qlooEntityIds', '"events"']) assert.equal(text.includes(field), false);
  assert.ok(report.comparisonReport.limitations.includes('incomplete_traces'));
});

test('baseline binding is explicit and does not execute the candidate', async () => {
  let calls = 0; const report = await replay(fixture(), async input => { assert.equal(input.execution?.role, 'baseline'); calls++; return success(); }, { role: 'baseline', assistantVersion: 'release-before' });
  assert.equal(calls, 6); assert.equal(report.comparisonReport.progress.dispatches, 6);
});

for (const assistantVersion of ['', 'wrong-release', 'release-before', ' release-after ', env.LITELLM_API_KEY]) test(`offline wrong or missing release binding rejects before adapter: ${assistantVersion || 'missing'}`, async () => {
  let calls = 0;
  await assert.rejects(replay(fixture(), async () => { calls++; return success(); }, { assistantVersion }), { code: 'configuration_error' });
  assert.equal(calls, 0);
});

const mutations: [string, (pack: PortableTestPack) => unknown][] = [
  ['checksum', pack => ({ ...pack, checksum: '0'.repeat(64) })],
  ['unknown schema', pack => rehash({ ...pack, schema_version: '2.0.0' })],
  ['unknown pack version', pack => rehash({ ...pack, pack_version: 'tastecase-test-pack/999' })],
  ['target compatibility', pack => rehash({ ...pack, target_output_contract: 'unknown' })],
  ['unknown projection', pack => rehash({ ...pack, rawQloo: { score: 0.9 } })],
  ['count', pack => rehash({ ...pack, plan: rehash({ ...pack.plan, slots: Array.from({ length: 121 }, () => pack.plan.slots[0]) }) })],
  ['missing slot', pack => rehash({ ...pack, plan: rehash({ ...pack.plan, slots: pack.plan.slots.slice(1) }) })],
  ['unknown rule', pack => {
    const row = pack.plan.cases[0]; assert.ok(row);
    return rehash({ ...pack, plan: rehash({ ...pack.plan, cases: [rehash({ ...row, expectation: { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'tool_not_called', profileId: 'a' }] } })] }) });
  }],
  ['context mismatch', pack => {
    const slot = pack.plan.slots[0]; assert.ok(slot);
    const execution = { ...slot.execution, evidenceChecksum: '0'.repeat(64) }; const input = { ...slot.input, execution };
    return rehash({ ...pack, plan: rehash({ ...pack.plan, slots: [{ ...slot, execution, input, inputChecksum: checksum(input) }, ...pack.plan.slots.slice(1)] }) });
  }],
  ['rule graph references unknown catalog identity', pack => {
    const row = pack.plan.cases[0]; assert.ok(row);
    return rehash({ ...pack, plan: rehash({ ...pack.plan, cases: [rehash({ ...row, expectation: { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'recommend_any', profileId: 'a', entryIds: ['not-in-catalog'] }] } })] }) });
  }],
  ['more than ten cases', pack => rehash({ ...pack, plan: rehash({ ...pack.plan, cases: Array.from({ length: 11 }, () => pack.plan.cases[0]) }) })],
  ['unsafe extra code', pack => rehash({ ...pack, module: 'file:///malicious.js' })],
];
for (const [name, mutate] of mutations) test(`full-pack ${name} tampering causes zero calls even for unselected baseline`, async () => {
  let calls = 0;
  await assert.rejects(replayComparisonRole({ pack: mutate(fixture()), role: 'candidate', assistantVersion: 'release-after', env, adapter: adapter(async () => { calls++; return success(); }) }), { code: 'invalid_request' });
  assert.equal(calls, 0);
});

test('replay rejects oversized byte input, trusted checksum mismatch, unsafe pinned text and URLs without dispatch', async () => {
  const pack = fixture(); let calls = 0;
  await assert.rejects(replay(pack, async () => { calls++; return success(); }, { expectedChecksum: '0'.repeat(64) }), { code: 'invalid_request' });
  for (const value of [env.LITELLM_API_KEY, env.OTHER_SECRET]) {
    const unsafe = fixture(policy, 3, value);
    await assert.rejects(replay(unsafe, async () => { calls++; return success(); }), { code: 'invalid_request' });
  }
  assert.throws(() => fixture(policy, 3, 'https://artifact.example.test/path'), /Unsafe|credential|portable/i);
  const { path } = await packFile(pack);
  await writeFile(path, ' '.repeat(COMPARISON_LIMITS.packBytes + 1));
  await assert.rejects(readReplayPackFile(path, { env }), { code: 'invalid_request' });
  assert.equal(calls, 0);
});

test('known secret detection rejects required catalog IDs as well as brief text without rehashing/redaction', () => {
  assert.throws(() => validateReplayPack(fixture(), { env: { SOME_API_KEY: 'one' } }), { code: 'invalid_request' });
  assert.throws(() => fixture(policy, 3, 'api_key=credential-placeholder'), /Unsafe|credential|portable/i);
});

test('mixed per-repeat outcomes and behavior disagreement are preserved, not averaged into taste quality', async () => {
  const report = await replay(fixture(), async input => input.execution?.repeat === 1 ? success(['two']) : success(['one']));
  const a = report.comparisonReport.summaries.find(row => row.role === 'candidate' && row.profileId === 'a'); assert.ok(a);
  assert.deepEqual(a.outcomes, ['pass', 'fail', 'pass']); assert.equal(a.outcome, 'mixed'); assert.equal(a.disagreement, true); assert.equal(a.behaviorDisagreement, true);
  assert.ok(report.comparisonReport.behaviorChanges.every(row => row.status === 'unavailable'));
  assert.ok(report.comparisonReport.limitations.includes('scoped_policy_only'));
});

for (const [name, result, expected] of [['provider unavailable', unavailable, 'unavailable'], ['malformed policy execution', malformed, 'unavailable'], ['missing identity', success([null]), 'unavailable']] as const) test(`${name} is never invented policy failure/pass`, async () => {
  const report = await replay(fixture(), async () => result);
  assert.ok(report.comparisonReport.repeats.filter(row => row.role === 'candidate' && row.profileId === 'a').every(row => row.outcome === expected));
  for (const secret of ['PRIVATE_RAW_TEXT', 'PRIVATE_ERROR', 'PRIVATE_PROVIDER_ERROR']) assert.equal(JSON.stringify(report).includes(secret), false);
});

test('only explicit malformed output can fail output_schema; invalid adapter envelope is unavailable', async () => {
  const report = await replay(fixture(objective), async input => input.execution?.repeat === 0 ? malformed : input.execution?.repeat === 1 ? unavailable : success());
  assert.deepEqual(report.comparisonReport.repeats.filter(row => row.role === 'candidate' && row.profileId === 'a').map(row => row.outcome), ['fail', 'unavailable', 'pass']);
  const invalid = await replay(fixture(objective), async () => ({ arbitrary: 'bad' }) as unknown as TargetResult);
  assert.ok(invalid.comparisonReport.repeats.filter(row => row.role === 'candidate').every(row => row.outcome === 'unavailable'));
});

test('advisory always remains non-automatic, including unavailable execution and incomplete traces', async () => {
  const pack = fixture({ classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: randomUUID(), rationale: 'Advisory contrast.' });
  const report = await replay(pack, async input => input.execution?.repeat === 1 ? unavailable : success(['two']));
  assert.ok(report.comparisonReport.repeats.filter(row => row.role === 'candidate').every(row => row.outcome === 'advisory' && row.rules.every(rule => !rule.automaticFailure)));
  assert.ok(report.comparisonReport.limitations.includes('incomplete_traces'));
});

test('order rules apply only when both known IDs are present', async () => {
  const pack = fixture({ classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true }] });
  const report = await replay(pack, async input => input.execution?.repeat === 0 ? success(['one']) : input.execution?.repeat === 1 ? success(['unknown']) : success(['two', 'one']));
  assert.deepEqual(report.comparisonReport.repeats.filter(row => row.role === 'candidate' && row.profileId === 'a').map(row => row.outcome), ['not_applicable', 'unavailable', 'fail']);
});

test('configured local secret echoes cannot leak via IDs, output, malformed text, error messages or traces', async () => {
  const report = await replay(fixture(), async input => input.execution?.repeat === 0 ? success([env.OTHER_SECRET]) : input.execution?.repeat === 1 ? { ...malformed, rawText: env.LITELLM_API_KEY } : {
    schema_version, outcome: 'success', output: { text: env.OTHER_SECRET, recommendations: [{ catalogEntryId: 'one', name: env.LITELLM_API_KEY, reason: env.OTHER_SECRET }] },
    trace: { completeness: 'partial', events: [{ kind: 'tool_call', name: env.OTHER_SECRET }] },
  });
  const text = JSON.stringify(report);
  assert.equal(text.includes(env.LITELLM_API_KEY) || text.includes(env.OTHER_SECRET), false);
  assert.equal(report.comparisonReport.repeats.find(row => row.role === 'candidate' && row.repeat === 0)?.result.outcome, 'provider_unavailable');
});

test('pre-abort dispatches zero calls and returns an honest cancelled partial report', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const report = await replay(fixture(), async () => { calls++; return success(); }, { signal: controller.signal });
  assert.equal(calls, 0); assert.equal(report.comparisonReport.stopReason, 'cancelled'); assert.equal(report.comparisonReport.progress.dispatches, 0);
});

test('abort while awaiting uncooperative adapter stops new dispatch and records uncertainty', async () => {
  const controller = new AbortController(); let calls = 0;
  const report = await replay(fixture(), async () => { calls++; controller.abort(); return new Promise(() => {}); }, { signal: controller.signal });
  assert.equal(calls, 1); assert.equal(report.comparisonReport.progress.uncertainDispatches, 1); assert.equal(report.comparisonReport.progress.completed, 0);
  assert.equal(report.comparisonReport.stopReason, 'cancelled'); assert.ok(report.comparisonReport.limitations.includes('uncertain_dispatch'));
});

test('per-target timeouts are execution-unavailable without retries, full replay deadline stops scheduling', async () => {
  let calls = 0;
  const report = await replay(fixture(objective, 1), async () => { calls++; return new Promise(() => {}); }, { targetTimeoutMs: 5 });
  assert.equal(calls, 2); assert.equal(report.comparisonReport.progress.dispatches, 2); assert.equal(report.comparisonReport.progress.uncertainDispatches, 2);
  assert.ok(report.comparisonReport.repeats.filter(row => row.role === 'candidate').every(row => row.outcome === 'unavailable'));
  calls = 0;
  const bounded = await replay(fixture(), async () => { calls++; return new Promise(() => {}); }, { replayTimeoutMs: 5 });
  assert.equal(calls, 1); assert.equal(bounded.comparisonReport.stopReason, 'deadline_exceeded'); assert.equal(bounded.comparisonReport.progress.uncertainDispatches, 1);
});

test('invalid local budget/report identity configuration fails before any dispatch', async () => {
  const pack = fixture(); let calls = 0; const reportId = randomUUID();
  for (const extra of [{ targetTimeoutMs: 0 }, { replayTimeoutMs: 3_600_001 }, { reportId: 'not-a-uuid' }, { reportId, env: { ...env, LOCAL_SECRET: reportId } }]) {
    await assert.rejects(replay(pack, async () => { calls++; return success(); }, extra), { code: 'configuration_error' });
  }
  assert.equal(calls, 0);
});

test('replay CLI advisory and pre-abort exits are explicit without pretending both versions completed', async () => {
  const { path } = await packFile(fixture({ classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: randomUUID(), rationale: 'Advisory contrast.' }));
  const cliEnv = { ...env, TASTECASE_ASSISTANT_VERSION: 'release-after' }; let calls = 0;
  const local = adapter(async () => { calls++; return success(); });
  assert.equal(await runCli(['replay', '--pack', path, '--role', 'candidate'], { env: cliEnv, adapter: local, write: () => {} }), 0);
  const controller = new AbortController(); controller.abort();
  assert.equal(await runCli(['replay', '--pack', path, '--role', 'candidate'], { env: cliEnv, adapter: local, signal: controller.signal, write: () => {} }), 1);
  assert.equal(calls, 6);
});

test('adapter input mutations cannot rewrite pinned plan or later repeats', async () => {
  const pack = fixture(); const original = JSON.stringify(pack);
  await replay(pack, async input => { input.task.syntheticBrief.text = 'Mutated local adapter copy'; input.execution = undefined; return success(); });
  assert.equal(JSON.stringify(pack), original);
});

test('safe file output is private, checksumed and refuses existing, source and symlink paths before target', async () => {
  const { pack, dir, path } = await packFile(); const reportPath = join(dir, 'report.json'); let calls = 0;
  const options = { packPath: path, role: 'candidate' as const, assistantVersion: 'release-after', env, adapter: adapter(async () => { calls++; return success(); }) };
  const report = await replayComparisonFile({ ...options, reportPath });
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report); assert.equal((await stat(reportPath)).mode & 0o777, 0o600); assert.equal(calls, 6);
  for (const existing of [reportPath, path]) await assert.rejects(replayComparisonFile({ ...options, reportPath: existing }), { code: 'conflict' });
  const link = join(dir, 'link.json'); await symlink(path, link);
  await assert.rejects(replayComparisonFile({ ...options, reportPath: link }), { code: 'conflict' });
  await assert.rejects(readReplayPackFile(link, { env }), { code: 'invalid_request' });
  assert.equal(calls, 6); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), pack);
});

test('strict local file paths, invalid UTF8 and unknown JSON fail safely with zero calls', async () => {
  const { path } = await packFile();
  for (const bad of ['https://remote.example.test/pack', 'file:///tmp/pack', '']) await assert.rejects(readReplayPackFile(bad, { env }), { code: 'configuration_error' });
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readReplayPackFile(path, { env }), { code: 'invalid_request' });
  await writeFile(path, '{invalid'); await assert.rejects(readReplayPackFile(path, { env }), { code: 'invalid_request' });
});

test('replay CLI needs neither API origin nor owner/runner token and emits metadata report to console/file', async () => {
  const { pack, dir, path } = await packFile(); const output: string[] = []; let calls = 0;
  const code = await runCli(['replay', '--pack', path, '--role', 'candidate', '--report', join(dir, 'cli.json'), '--pack-checksum', pack.checksum], {
    env: { ...env, TASTECASE_ASSISTANT_VERSION: 'release-after' }, adapter: adapter(async () => { calls++; return success(); }), write: text => output.push(text),
  });
  assert.equal(code, 0); assert.equal(calls, 6); assert.deepEqual(JSON.parse(output[0] ?? ''), JSON.parse(await readFile(join(dir, 'cli.json'), 'utf8')));
  assert.equal(JSON.stringify(output).includes('PRIVATE_'), false);
});

for (const [result, expectation, code] of [[success(['two']), policy, 2], [malformed, objective, 2], [unavailable, policy, 4], [success([null]), policy, 4]] as const) test(`replay CLI exit code ${code} matches structural execution/evaluation`, async () => {
  const { path } = await packFile(fixture(expectation));
  assert.equal(await runCli(['replay', '--pack', path, '--role', 'candidate'], { env: { ...env, TASTECASE_ASSISTANT_VERSION: 'release-after' }, adapter: adapter(async () => result), write: () => {} }), code);
});

test('CLI missing/wrong label and unsupported options reject without provider calls or sensitive output', async () => {
  const { path } = await packFile(); let calls = 0; const output: string[] = [];
  for (const label of [undefined, 'wrong-release']) assert.equal(await runCli(['replay', '--pack', path, '--role', 'candidate'], { env: { ...env, TASTECASE_ASSISTANT_VERSION: label }, adapter: adapter(async () => { calls++; return success(); }), write: text => output.push(text) }), 1);
  for (const args of [[], ['--role', 'bad'], ['--module', 'arbitrary.js'], ['--api-key', env.LITELLM_API_KEY], ['--pack', path, '--pack', path], ['--request-timeout-ms', '10']]) assert.equal(await runCli(['replay', ...args], { env, adapter: adapter(async () => { calls++; return success(); }), write: text => output.push(text) }), 1);
  assert.equal(calls, 0); assert.equal(JSON.stringify(output).includes(env.LITELLM_API_KEY), false);
});

test('CLI tampering before real LiteLLM mock transport and no release-to-model mapping', async () => {
  const { pack, path } = await packFile(); let calls = 0;
  const providerEnv = { ...env, LITELLM_BASE_URL: 'https://local-provider.example.test/v1', LITELLM_MODEL: 'explicit-local-model', TASTECASE_ASSISTANT_VERSION: 'release-after' };
  const fetch: typeof globalThis.fetch = async (_url, request) => {
    calls++; const body: unknown = JSON.parse(String(request?.body)); assert.ok(body && typeof body === 'object' && 'model' in body); assert.equal(body.model, 'explicit-local-model');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ recommendations: [{ catalogEntryId: 'one', name: 'Synthetic', reason: 'Synthetic reason' }] }) } }] }), { status: 200 });
  };
  await writeFile(path, JSON.stringify({ ...pack, checksum: '0'.repeat(64) }));
  assert.equal(await runCli(['replay', '--pack', path, '--role', 'candidate'], { env: providerEnv, fetch, write: () => {} }), 1); assert.equal(calls, 0);
  await writeFile(path, JSON.stringify(pack));
  const local = createLiteLLMAdapter({ env: providerEnv, fetch });
  const report = await replayComparisonFile({ packPath: path, role: 'candidate', assistantVersion: 'release-after', env: providerEnv, adapter: local });
  assert.equal(calls, 6); assert.ok(report.comparisonReport.limitations.includes('incomplete_traces'));
});
