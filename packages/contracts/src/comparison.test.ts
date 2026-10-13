import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  AttemptSchema, ComparisonPlanSchema, ComparisonConflictError, ComparisonExecutionBindingSchema, CreateComparisonRequestSchema,
  CreateDiscoveryJobRequestSchema, DiscoveryCandidateSchema, DiscoveryEvidenceSchema, DiscoveryJobSchema, PinnedDiscoveryInputSchema,
  SuiteIdentitySchema, COMPARISON_LIMITS, PortableTestPackSchema, ComparisonFinalReportSchema, REST_CONTRACTS,
  checksum, computeDiscoveryFacts, pinReviewEvidence, prepareReviewCase, prepareReviewDecision, prepareSuitePublication,
  prepareComparisonPlan, validateComparisonRetry, validateComparisonPlanAgainstSuite, initialComparisonAssociations, comparisonProgress,
  comparisonClaimAllowed, validateComparisonRunnerBinding, comparisonExecutionRows, comparisonListItem, ComparisonListResponseSchema,
  ComparisonRuleResultSchema, ComparisonCaseSchema, projectComparisonResult, evaluateComparisonRules, prepareComparisonFinalization,
  validateComparisonFinalizationRetry, validateComparisonReportAgainstPlan, buildPortableTestPack, parsePortableTestPack,
  validatePortableTestPack, replayPortableTestPack, validateReplayReport, renderComparisonReport, assertSafePortableContent,
  deriveSyntheticFullProfileInput,
  type ApprovedExpectation, type TargetResult, type TargetAdapter, type ComparisonPlan, type ComparisonFinalizationSource,
} from './index.js';

const schema_version = '1.0.0' as const;
const createdAt = '2026-10-13T12:00:00.000Z';
const deadlineAt = '2026-10-13T12:30:00.000Z';
const success = (ids: (string | null)[], completeness: 'complete' | 'partial' | 'unavailable' = 'complete'): TargetResult => ({ schema_version, outcome: 'success',
  output: { text: 'PRIVATE_TARGET_TEXT', recommendations: ids.map(id => ({ ...(id === null ? {} : { catalogEntryId: id }), name: 'one', reason: 'PRIVATE_TARGET_REASON' })) },
  trace: { completeness, events: completeness === 'unavailable' ? [] : [{ kind: 'tool_call', name: 'PRIVATE_TRACE_EVENT' }] } });
const malformed: TargetResult = { schema_version, outcome: 'malformed_output', rawText: 'PRIVATE_MALFORMED_TEXT', error: { code: 'bad', message: 'PRIVATE_ERROR_MESSAGE' }, trace: { completeness: 'partial', events: [] } };
const unavailable: TargetResult = { schema_version, outcome: 'provider_unavailable', retryable: true, error: { code: 'down', message: 'PRIVATE_PROVIDER_MESSAGE' }, trace: { completeness: 'unavailable', events: [] } };
function rehash<T extends { checksum: string }>(row: T): T { return { ...row, checksum: checksum(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'checksum'))) }; }
const policy: ApprovedExpectation = { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'recommend_any', profileId: 'a', entryIds: ['one'] }] };
function fixture(expectation: ApprovedExpectation = policy, repeatCount = 3) {
  const projectId = randomUUID(); const ownerId = randomUUID(); const jobId = randomUUID(); const catalogId = randomUUID(); const taskId = randomUUID();
  const catalogPayload = { schema_version, id: catalogId, label: 'Synthetic catalog', entries: ['one', 'two', 'excluded', 'unmapped'].map(id => ({ id, name: `Synthetic ${id}`, constraintFacts: { dietaryOptions: ['vegetarian'] } })) };
  const brief = { provenance: 'synthetic' as const, label: 'Fictional lunch', text: 'A fictional lunch.' };
  const constraints = { partySize: 2, dietaryRequirements: ['vegetarian'], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: ['excluded'] };
  const taskPayload = { schema_version, id: taskId, label: 'Original task', catalogVersionId: catalogId, syntheticBrief: brief, syntheticInterests: [], constraints };
  const mappings = ['one', 'two'].map(catalogEntryId => ({ schema_version, id: randomUUID(), projectId, catalogVersionId: catalogId, catalogEntryId, qlooEntityId: randomUUID(), confirmedBy: ownerId, createdAt }));
  const request = CreateDiscoveryJobRequestSchema.parse({ schema_version, id: jobId, catalogVersionId: catalogId, taskVersionId: taskId,
    mappingConfirmationIds: mappings.map(row => row.id), eligibleCatalogEntryIds: ['one', 'two', 'unmapped'], assistantVersion: 'old-discovery-release', repeatCount,
    profiles: ['a', 'b'].map(id => ({ id, provenance: 'public_synthetic', label: `Profile ${id}`, anchors: [{ id: randomUUID(), kind: 'film', label: `Public film ${id}` }] })) });
  const input = PinnedDiscoveryInputSchema.parse({ schema_version, request, targetInput: { schema_version, projectId,
    catalog: { ...catalogPayload, projectId, checksum: checksum(catalogPayload), createdAt }, task: { ...taskPayload, projectId, checksum: checksum(taskPayload), createdAt },
    mappings, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds } });
  const confirmations = request.profiles.flatMap(profile => profile.anchors.map(anchor => ({ schema_version, id: randomUUID(), projectId, jobId,
    anchorId: anchor.id, resolutionId: null, entityId: randomUUID(), confirmedBy: ownerId, createdAt })));
  const rankIds: [string, string] = [randomUUID(), randomUUID()];
  const ranks = request.profiles.map(profile => ({ kind: 'rank' as const, providerStatus: 'partial' as const, profileId: profile.id, scope: 'full' as const,
    requestedEntryIds: ['one', 'two'], orderedEntryIds: profile.id === 'a' ? ['one', 'two'] : ['two', 'one'], missingEntryIds: [], unmappedEntryIds: ['unmapped'],
    mappingConfirmationIds: mappings.map(row => row.id), anchorConfirmationIds: confirmations.filter(row => profile.anchors.some(anchor => anchor.id === row.anchorId)).map(row => row.id) }));
  const [a, b] = ranks; assert.ok(a && b);
  const facts = computeDiscoveryFacts(jobId, rankIds, a, b); const contrast = facts.contrasts[0]; assert.ok(contrast);
  const evidence = [a, b, facts].map((data, i) => DiscoveryEvidenceSchema.parse({ schema_version, id: rankIds[i] ?? randomUUID(), projectId, jobId, attemptId: null, data, checksum: checksum(data), capturedAt: createdAt }));
  const briefs = { a: { ...brief, text: 'Full profile a published brief.' }, b: { ...brief, text: 'Full profile b published brief.' }, constraints, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds };
  const content = { contrast, briefs, evidenceIds: evidence.map(row => row.id), targetAttemptIds: [], proposedExpectation: { classification: 'advisory' as const,
    automaticFailure: false as const, humanReviewRequired: true as const, contrastId: contrast.id, rationale: 'PRIVATE_REVIEW_RATIONALE' }, limitations: ['PRIVATE_DISCOVERY_LIMITATION'] };
  const candidate = DiscoveryCandidateSchema.parse({ schema_version, id: randomUUID(), projectId, jobId, content, checksum: checksum(content), createdAt });
  const job = DiscoveryJobSchema.parse({ schema_version, id: jobId, projectId, input, inputChecksum: checksum(input), state: 'partial', checkpoint: 'saved',
    checkpointData: { evidenceIds: evidence.map(row => row.id), candidateIds: [candidate.id] }, counters: { qlooAttempts: 0, modelDecisions: 0, targetAttempts: 0, rounds: 1 },
    revision: 3, leaseId: null, leaseExpiresAt: null, availableAt: createdAt, deadlineAt, createdAt, cancelledAt: null, reason: 'No completed discovery targets.' });
  const pinned = pinReviewEvidence({ schema_version, projectId, jobId, candidate, job, evidence, targets: [], confirmations, resolutions: [], providerAttempts: [], capturedAt: createdAt });
  const initial = prepareReviewCase({ request: { schema_version, id: randomUUID(), jobId, candidateId: candidate.id }, projectId, candidate, createdAt });
  const approved = prepareReviewDecision({ request: { schema_version, id: randomUUID(), expectedRevision: 0, action: 'edit', expectation: expectation.classification === 'advisory' ? content.proposedExpectation : expectation, rationale: 'Owner reviewed this scoped rule.' },
    reviewCase: initial.case, head: initial.head, evidence: pinned, ownerId, createdAt });
  const version = approved.record.expectationVersion; assert.ok(version);
  const suite = SuiteIdentitySchema.parse({ schema_version, id: randomUUID(), projectId, name: 'Release suite', currentVersion: 0, createdAt });
  const snapshot = prepareSuitePublication({ request: { schema_version, id: randomUUID(), suiteId: suite.id, expectedVersion: 0,
    cases: [{ caseId: initial.case.id, expectationVersionId: version.id, expectedReviewRevision: approved.head.revision }] }, suite,
    selections: [{ case: initial.case, head: approved.head, review: approved.record }], ownerId, createdAt });
  const comparisonRequest = CreateComparisonRequestSchema.parse({ schema_version, id: randomUUID(), suiteVersionId: snapshot.id,
    baselineVersion: 'release-before', candidateVersion: 'release-after', caseIds: [initial.case.id], deadlineAt, dispatchBudget: repeatCount * 4 + 2, reclaimBudget: 2 });
  const plan = prepareComparisonPlan({ request: comparisonRequest, suite: snapshot, projectId, createdAt });
  return { projectId, snapshot, plan, comparisonRequest, input, briefs, job, pinned };
}
function source(plan: ComparisonPlan, resultFor: (index: number) => TargetResult | null = () => success(['one'])): ComparisonFinalizationSource {
  const associations = initialComparisonAssociations(plan);
  const attempts = plan.slots.map((slot, i) => {
    const result = resultFor(i); const association = associations[i]; assert.ok(association);
    association.status = result ? 'completed' : 'queued'; association.dispatchCount = result ? 1 : 0;
    return AttemptSchema.parse({ schema_version, id: slot.attemptId, projectId: plan.projectId, catalogVersionId: slot.input.catalog.id, taskVersionId: slot.input.task.id,
      mappingConfirmationIds: slot.input.mappings.map(row => row.id), status: association.status, input: slot.input, inputChecksum: slot.inputChecksum,
      leaseId: result ? randomUUID() : null, leaseCredentialId: result ? randomUUID() : null, leaseExpiresAt: result ? deadlineAt : null,
      result, resultChecksum: result ? checksum(result) : null, createdAt, completedAt: result ? createdAt : null });
  });
  return { plan, state: 'running', associations, attempts };
}
const finalizeRequest = (allowPartial = false) => ({ schema_version, id: randomUUID(), allowPartial });

test('published inputs synthesize both full profiles afresh without discovery results', () => {
  const f = fixture(); const row = f.plan.cases[0]; assert.ok(row);
  assert.equal(f.pinned.targets.length, 0); assert.equal(f.plan.slots.length, 12);
  for (const profileId of ['a', 'b'] as const) {
    const profile = f.job.input.request.profiles.find(row => row.id === profileId); assert.ok(profile);
    assert.deepEqual(row.inputs[profileId], deriveSyntheticFullProfileInput({ jobId: f.job.id, projectId: f.projectId, createdAt, targetInput: f.input.targetInput, profile, brief: f.briefs[profileId] }));
    assert.deepEqual(row.inputs[profileId].catalog, f.input.targetInput.catalog);
    assert.deepEqual(row.inputs[profileId].task.constraints, f.input.targetInput.task.constraints);
  }
  assert.deepEqual(validateComparisonPlanAgainstSuite(f.plan, f.snapshot), f.plan);
  assert.equal(new Set(f.plan.slots.map(slot => slot.attemptId)).size, 12);
  assert.ok(f.plan.slots.every(slot => slot.execution.assistantVersion !== f.job.input.request.assistantVersion));
});
for (const change of [{ candidateVersion: 'release-before' }, { baselineVersion: '' }, { caseIds: [] }, { caseIds: [randomUUID(), randomUUID(), ...Array.from({ length: 9 }, () => randomUUID())] },
  { reclaimBudget: 25 }, { dispatchBudget: 145 }, { suiteVersionId: undefined }, { deadlineAt: undefined }, { repeatCount: 1 }, { suite: {} }, { verdicts: [] }]) test(`strict bounded request rejects ${Object.keys(change).join(',')}`, () => {
  const f = fixture(); assert.equal(CreateComparisonRequestSchema.safeParse({ ...f.comparisonRequest, ...change }).success, false);
});
test('all request context is immutable for same-ID retries', () => {
  const f = fixture(); assert.deepEqual(validateComparisonRetry(f.comparisonRequest, f.plan, f.projectId), f.plan);
  for (const change of [{ baselineVersion: 'other' }, { candidateVersion: 'other' }, { caseIds: [randomUUID()] }, { suiteVersionId: randomUUID() }, { dispatchBudget: 12 }, { reclaimBudget: 1 }, { deadlineAt: '2026-10-13T12:29:00.000Z' }]) {
    assert.throws(() => validateComparisonRetry({ ...f.comparisonRequest, ...change }, f.plan, f.projectId), ComparisonConflictError);
  }
});
test('selection, same-project scope, repeat budget and deadline are validated against publication', () => {
  const f = fixture();
  for (const request of [{ ...f.comparisonRequest, caseIds: [randomUUID()] }, { ...f.comparisonRequest, suiteVersionId: randomUUID() },
    { ...f.comparisonRequest, caseIds: [f.comparisonRequest.caseIds[0], f.comparisonRequest.caseIds[0]] },
    { ...f.comparisonRequest, dispatchBudget: 11 }, { ...f.comparisonRequest, dispatchBudget: 15 },
    { ...f.comparisonRequest, deadlineAt: createdAt }, { ...f.comparisonRequest, deadlineAt: '2026-10-13T13:00:01.000Z' }]) {
    assert.throws(() => prepareComparisonPlan({ request, suite: f.snapshot, projectId: f.projectId, createdAt }));
  }
  assert.throws(() => prepareComparisonPlan({ request: f.comparisonRequest, suite: f.snapshot, projectId: randomUUID(), createdAt }));
});
test('binding contains complete suite/case/expectation/evidence and profile/repeat/version identity', () => {
  const slot = fixture().plan.slots[0]; assert.ok(slot);
  for (const key of ['caseChecksum', 'expectationChecksum', 'evidenceChecksum', 'suiteChecksum', 'assistantVersion', 'profileId', 'role', 'repeat'] as const) {
    assert.equal(ComparisonExecutionBindingSchema.safeParse({ ...slot.execution, [key]: undefined }).success, false);
  }
});
test('comparison claim gate rejects unbound/other versions, terminal state, expiry and budget exhaustion', () => {
  const f = fixture(); const associations = initialComparisonAssociations(f.plan); const association = associations[0]; assert.ok(association);
  const args = { plan: f.plan, association, associations, state: 'queued' as const, now: createdAt, assistantVersion: association.assistantVersion };
  assert.equal(comparisonClaimAllowed(args), true);
  for (const change of [{ assistantVersion: undefined }, { assistantVersion: 'wrong' }, { state: 'cancelled' as const }, { state: 'finalized' as const }, { now: deadlineAt }]) assert.equal(comparisonClaimAllowed({ ...args, ...change }), false);
  association.status = 'leased'; association.dispatchCount = 1;
  assert.equal(comparisonClaimAllowed(args), false);
  assert.equal(comparisonClaimAllowed({ ...args, leaseExpired: true }), true);
  association.status = 'queued'; association.dispatchCount = 3; association.uncertainDispatches = 2;
  assert.equal(comparisonClaimAllowed(args), false);
  assert.equal(comparisonProgress(f.plan, associations).reclaims, 2);
  association.dispatchCount = 4; assert.throws(() => comparisonProgress(f.plan, associations));
});

const objective = (rule: { kind: 'output_schema' } | { kind: 'allowed_ids' | 'exclusions'; entryIds: string[] }): ApprovedExpectation => ({ classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [rule] });
const scoped = (rule: { kind: 'recommend_any' | 'avoid'; profileId: 'a'; entryIds: string[] } | { kind: 'order'; profileId: 'a'; beforeEntryId: string; afterEntryId: string; whenBothPresent: true }): ApprovedExpectation => ({ classification: 'approved_policy', automaticFailure: true, rules: [rule] });
const evaluationExamples: [string, ApprovedExpectation, TargetResult | null, string][] = [
  ['output schema valid', objective({ kind: 'output_schema' }), success([null]), 'pass'],
  ['explicit malformed output', objective({ kind: 'output_schema' }), malformed, 'fail'],
  ['schema provider unavailable', objective({ kind: 'output_schema' }), unavailable, 'unavailable'],
  ['schema pending', objective({ kind: 'output_schema' }), null, 'unavailable'],
  ['allowed ID', objective({ kind: 'allowed_ids', entryIds: ['one', 'two', 'unmapped'] }), success(['one']), 'pass'],
  ['outside ID objective failure', objective({ kind: 'allowed_ids', entryIds: ['one', 'two', 'unmapped'] }), success(['outside']), 'fail'],
  ['missing ID never matched by name', objective({ kind: 'allowed_ids', entryIds: ['one', 'two', 'unmapped'] }), success([null]), 'unavailable'],
  ['explicit exclusion', objective({ kind: 'exclusions', entryIds: ['excluded'] }), success(['excluded']), 'fail'],
  ['excluded absent', objective({ kind: 'exclusions', entryIds: ['excluded'] }), success(['one']), 'pass'],
  ['unknown exclusion identity', objective({ kind: 'exclusions', entryIds: ['excluded'] }), success(['outside']), 'unavailable'],
  ['recommend any complied', policy, success(['one']), 'pass'],
  ['recommend any violated', policy, success(['two']), 'fail'],
  ['empty explicit recommendation list', policy, success([]), 'fail'],
  ['missing policy identity', policy, success([null]), 'unavailable'],
  ['unknown policy identity', policy, success(['outside']), 'unavailable'],
  ['malformed execution not policy fail', policy, malformed, 'unavailable'],
  ['unavailable execution not policy fail', policy, unavailable, 'unavailable'],
  ['pending execution not policy fail', policy, null, 'unavailable'],
  ['avoid complied', scoped({ kind: 'avoid', profileId: 'a', entryIds: ['two'] }), success(['one']), 'pass'],
  ['avoid violated', scoped({ kind: 'avoid', profileId: 'a', entryIds: ['two'] }), success(['two']), 'fail'],
  ['avoid unknown', scoped({ kind: 'avoid', profileId: 'a', entryIds: ['two'] }), success(['outside']), 'unavailable'],
  ['order complied', scoped({ kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true }), success(['one', 'two']), 'pass'],
  ['order violated', scoped({ kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true }), success(['two', 'one']), 'fail'],
  ['order missing one known ID', scoped({ kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true }), success(['one']), 'not_applicable'],
  ['order missing both known IDs', scoped({ kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true }), success([]), 'not_applicable'],
  ['order missing identity', scoped({ kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true }), success(['one', null]), 'unavailable'],
];
for (const [name, expectation, result, outcome] of evaluationExamples) test(`mechanical rule: ${name}`, () => {
  const f = fixture(); const first = evaluateComparisonRules(expectation, f.plan.cases[0]!.inputs.a, 'a', projectComparisonResult(result))[0]; assert.ok(first);
  assert.equal(first.outcome, outcome);
});
test('rules outside scoped profile are not applicable and advisory stays non-automatic even unavailable', () => {
  const f = fixture(); const input = f.plan.cases[0]!.inputs.a;
  assert.equal(evaluateComparisonRules(policy, input, 'b', projectComparisonResult(unavailable))[0]?.outcome, 'not_applicable');
  const advisory = fixture({ classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: randomUUID(), rationale: 'Advisory only' });
  const result = evaluateComparisonRules(advisory.plan.cases[0]!.expectation, advisory.plan.cases[0]!.inputs.a, 'a', projectComparisonResult(unavailable))[0];
  assert.equal(result?.outcome, 'advisory'); assert.equal(result?.automaticFailure, false);
});
test('trace incompleteness stays a limitation, never proof of misconduct', () => {
  const f = fixture(); const report = prepareComparisonFinalization({ request: finalizeRequest(), source: source(f.plan, () => success(['one'], 'partial')), finalizedAt: createdAt });
  assert.ok(report.limitations.includes('incomplete_traces')); assert.equal(report.repeats[0]?.outcome, 'pass');
  assert.ok(report.repeats.every(row => row.rules.every(rule => !rule.ruleKind.includes('tool'))));
});
test('finalization preserves every repeat, mixed results, behavior disagreement and unavailable executions', () => {
  const f = fixture(); const report = prepareComparisonFinalization({ request: finalizeRequest(), source: source(f.plan, i => i === 0 ? success(['one']) : i === 1 ? success(['two']) : i === 2 ? unavailable : success(['one'])), finalizedAt: createdAt });
  assert.equal(report.repeats.length, 12); assert.deepEqual(report.summaries[0]?.outcomes, ['pass', 'fail', 'unavailable']);
  assert.equal(report.summaries[0]?.outcome, 'mixed'); assert.equal(report.summaries[0]?.disagreement, true); assert.equal(report.summaries[0]?.behaviorDisagreement, true);
  assert.equal(report.behaviorChanges.find(row => row.profileId === 'a' && row.repeat === 1)?.status, 'changed');
  assert.equal(report.behaviorChanges.find(row => row.profileId === 'a' && row.repeat === 2)?.status, 'unavailable');
  assert.deepEqual(validateComparisonReportAgainstPlan(report, f.plan), report);
});
test('pending work requires explicit honest partial finalization and original receipt retry', () => {
  const f = fixture(); const pending = source(f.plan, i => i === 0 ? success(['one']) : null); const request = finalizeRequest(true);
  assert.throws(() => prepareComparisonFinalization({ request: { ...request, allowPartial: false }, source: pending, finalizedAt: createdAt }), ComparisonConflictError);
  const report = prepareComparisonFinalization({ request, source: { ...pending, state: 'cancelled' }, finalizedAt: createdAt });
  assert.equal(report.completion, 'partial'); assert.equal(report.stopReason, 'cancelled'); assert.equal(report.repeats.filter(row => row.result.outcome === 'pending').length, 11);
  assert.deepEqual(validateComparisonFinalizationRetry(request, report, f.plan), report);
  assert.throws(() => validateComparisonFinalizationRetry({ ...request, allowPartial: false }, report, f.plan), ComparisonConflictError);
  const before = report.checksum; pending.attempts[0]!.result = unavailable;
  assert.equal(report.checksum, before);
});
test('finalization rejects cross-project, swapped input/status/results and caller-authoritative verdicts', () => {
  const f = fixture(); const resolved = source(f.plan); const request = finalizeRequest();
  for (const change of [{ projectId: randomUUID() }, { inputChecksum: checksum('forged') }, { resultChecksum: checksum('forged') }, { status: 'queued' }, { input: f.plan.slots[1]!.input }]) {
    const altered = { ...resolved, attempts: resolved.attempts.map((row, i) => i === 0 ? { ...row, ...change } : row) };
    assert.throws(() => prepareComparisonFinalization({ request, source: altered as ComparisonFinalizationSource, finalizedAt: createdAt }));
  }
  assert.throws(() => prepareComparisonFinalization({ request, source: { ...resolved, attempts: resolved.attempts.slice(1) }, finalizedAt: createdAt }));
  const report = prepareComparisonFinalization({ request, source: resolved, finalizedAt: createdAt });
  const altered = rehash({ ...report, repeats: report.repeats.map((row, i) => i === 0 ? { ...row, outcome: 'fail' as const } : row) });
  assert.throws(() => validateComparisonReportAgainstPlan(altered, f.plan), /derived/);
  assert.equal(ComparisonFinalReportSchema.safeParse({ ...report, rawResponses: [] }).success, false);
});
test('portable projection excludes raw Qloo/target/review/trace/error data and source code', () => {
  const f = fixture(); const pack = buildPortableTestPack(f.plan); const report = prepareComparisonFinalization({ request: finalizeRequest(), source: source(f.plan, i => i % 3 === 0 ? malformed : i % 3 === 1 ? unavailable : success(['one'])), finalizedAt: createdAt });
  const serialized = JSON.stringify({ pack, report, readable: renderComparisonReport(report) });
  for (const forbidden of ['PRIVATE_TARGET_TEXT', 'PRIVATE_TARGET_REASON', 'PRIVATE_TRACE_EVENT', 'PRIVATE_MALFORMED_TEXT', 'PRIVATE_ERROR_MESSAGE', 'PRIVATE_PROVIDER_MESSAGE', 'PRIVATE_REVIEW_RATIONALE', 'PRIVATE_DISCOVERY_LIMITATION', 'orderedEntryIds', 'rawText', 'runnerTokenHash', 'sourceCode', 'providerAttempts', 'reviewDecisionId']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.equal(pack.plan.cases[0]?.evidenceReferences[0]?.providerStatus, 'partial');
  assert.deepEqual(pack.plan.cases[0]?.evidenceReferences[0]?.unmappedEntryIds, ['unmapped']);
  assert.deepEqual(parsePortableTestPack(JSON.stringify(pack), { expectedChecksum: pack.checksum }), pack);
});
test('pack rejects unsupported schemas/contracts/rules, unknown fields and changed checksums', () => {
  const pack = buildPortableTestPack(fixture().plan);
  for (const change of [{ schema_version: '2.0.0' }, { pack_version: 'tastecase-test-pack/2' }, { target_output_contract: 'unknown' }, { checksum: checksum('bad') }, { artifactUrl: 'https://example.invalid' }, { module: './evil.js' }]) assert.throws(() => validatePortableTestPack({ ...pack, ...change }));
  assert.throws(() => validatePortableTestPack(pack, { expectedChecksum: checksum('other') }));
  const row = pack.plan.cases[0]; assert.ok(row);
  const invalidRule = { ...row, expectation: { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'tool_not_called' }] } };
  assert.equal(PortableTestPackSchema.safeParse({ ...pack, plan: { ...pack.plan, cases: [invalidRule] } }).success, false);
});
test('rehashed swapped case/profile/version/attempt identities do not bypass deterministic cross references', () => {
  const pack = buildPortableTestPack(fixture().plan); const first = pack.plan.slots[0]; assert.ok(first);
  for (const change of [{ attemptId: randomUUID() }, { execution: { ...first.execution, caseId: randomUUID() } }, { execution: { ...first.execution, assistantVersion: 'forged' } }, { execution: { ...first.execution, profileId: 'b' as const } }, { input: pack.plan.slots[3]!.input }]) {
    const plan = rehash({ ...pack.plan, slots: pack.plan.slots.map((slot, i) => i === 0 ? { ...slot, ...change } : slot) });
    assert.throws(() => validatePortableTestPack(rehash({ ...pack, plan })));
  }
  const forgedCase = rehash({ ...pack.plan.cases[0]!, caseId: randomUUID() });
  assert.throws(() => validatePortableTestPack(rehash({ ...pack, plan: rehash({ ...pack.plan, cases: [forgedCase] }) })));
  const modified = rehash({ ...pack.plan.cases[0]!, inputs: { a: pack.plan.cases[0]!.inputs.b, b: pack.plan.cases[0]!.inputs.a } });
  assert.equal(ComparisonPlanSchema.safeParse(rehash({ ...pack.plan, cases: [modified] })).success, false);
});
for (const unsafe of ['tc_runner_' + 'A'.repeat(43), 'Authorization: Bearer synthetic-only', 'password=synthetic-only', 'postgresql://user:synthetic@localhost/db', 'AKIA' + 'A'.repeat(16), '-----BEGIN PRIVATE KEY-----', 'sk-live-' + 'a'.repeat(24)]) test('credential-shaped required inputs are rejected without redaction or echoed values', () => {
  assert.throws(() => assertSafePortableContent({ text: unsafe }), error => error instanceof Error && !error.message.includes(unsafe));
});
test('known secret content and pack byte/count bounds are rejected before dispatch', async () => {
  const f = fixture(); const pack = buildPortableTestPack(f.plan);
  assert.throws(() => buildPortableTestPack(f.plan, { knownSecrets: ['Full profile a'] }));
  assert.throws(() => parsePortableTestPack(' '.repeat(COMPARISON_LIMITS.packBytes + 1)), /byte/);
  assert.throws(() => validatePortableTestPack({ oversized: 'a'.repeat(COMPARISON_LIMITS.packBytes) }), /byte/);
  let calls = 0;
  const adapter: TargetAdapter = { name: 'local', version: 'implementation-v1', async run() { calls++; return success(['one']); } };
  const args = { pack: { ...pack, checksum: checksum('bad') }, bindings: { baseline: { assistantVersion: 'release-before', adapter }, candidate: { assistantVersion: 'release-after', adapter } }, signal: new AbortController().signal, reportId: randomUUID(), finalizedAt: createdAt };
  await assert.rejects(replayPortableTestPack(args)); assert.equal(calls, 0);
  await assert.rejects(replayPortableTestPack({ ...args, pack, bindings: { ...args.bindings, baseline: { assistantVersion: 'wrong', adapter } } })); assert.equal(calls, 0);
});
test('local replay uses only explicitly bound adapters with identical inputs and structural report', async () => {
  const f = fixture(); const pack = buildPortableTestPack(f.plan); const seen: string[] = [];
  const adapter: TargetAdapter = { name: 'local', version: 'implementation-v1', async run(input) { seen.push(input.execution!.assistantVersion); return success(['one']); } };
  const replay = await replayPortableTestPack({ pack, expectedChecksum: pack.checksum, bindings: { baseline: { assistantVersion: 'release-before', adapter }, candidate: { assistantVersion: 'release-after', adapter } },
    signal: new AbortController().signal, reportId: randomUUID(), finalizedAt: createdAt });
  assert.equal(seen.length, 12); assert.equal(seen.filter(value => value === 'release-before').length, 6);
  assert.equal(replay.comparisonReport.completion, 'complete'); assert.deepEqual(validateReplayReport(replay, pack), replay);
  assert.ok(!JSON.stringify(replay).includes('PRIVATE_'));
});
test('local replay provider exceptions and cancellation remain honest unavailable/partial evidence', async () => {
  const pack = buildPortableTestPack(fixture().plan); const controller = new AbortController();
  const adapter: TargetAdapter = { name: 'local', version: 'implementation-v1', async run() { controller.abort(); throw new Error('PRIVATE_THROWN_ERROR'); } };
  const report = await replayPortableTestPack({ pack, bindings: { baseline: { assistantVersion: 'release-before', adapter }, candidate: { assistantVersion: 'release-after', adapter } }, signal: controller.signal, reportId: randomUUID(), finalizedAt: createdAt });
  assert.equal(report.comparisonReport.completion, 'partial'); assert.equal(report.comparisonReport.stopReason, 'cancelled');
  assert.equal(report.comparisonReport.repeats[0]?.outcome, 'unavailable'); assert.ok(!JSON.stringify(report).includes('PRIVATE_THROWN_ERROR'));
});
test('replay cancellation stops awaiting an uncooperative async adapter and preserves unknown dispatch', async () => {
  const f = fixture(); const pack = buildPortableTestPack(f.plan); const controller = new AbortController(); let calls = 0;
  const adapter: TargetAdapter = { name: 'uncooperative-local', version: 'implementation-v1', async run() { calls++; controller.abort(); return await new Promise<TargetResult>(() => {}); } };
  const watchdog = AbortSignal.timeout(1000);
  const report = await Promise.race([
    replayPortableTestPack({ pack, bindings: { baseline: { assistantVersion: 'release-before', adapter }, candidate: { assistantVersion: 'release-after', adapter } }, signal: controller.signal, reportId: randomUUID(), finalizedAt: createdAt }),
    new Promise<never>((_, reject) => watchdog.addEventListener('abort', () => reject(new Error('Replay hung after cancellation')), { once: true })),
  ]);
  assert.equal(calls, 1); assert.equal(report.comparisonReport.completion, 'partial'); assert.equal(report.comparisonReport.stopReason, 'cancelled');
  assert.equal(report.comparisonReport.progress.completed, 0); assert.equal(report.comparisonReport.progress.uncertainDispatches, 1);
  assert.equal(report.comparisonReport.repeats[0]?.result.outcome, 'pending');
});
test('runner bindings preserve ordinary claims but require exact explicit comparison release', () => {
  const f = fixture(); const slot = f.plan.slots[0]; assert.ok(slot);
  assert.deepEqual(validateComparisonRunnerBinding(f.input.targetInput), f.input.targetInput);
  assert.deepEqual(validateComparisonRunnerBinding(slot.input, slot.execution.assistantVersion), slot.input);
  assert.throws(() => validateComparisonRunnerBinding(slot.input));
  assert.throws(() => validateComparisonRunnerBinding(slot.input, 'other'));
  const row = comparisonExecutionRows(f.plan)[0]; assert.ok(row);
  assert.equal(row.attempt_id, slot.attemptId); assert.equal(row.input_checksum, slot.inputChecksum); assert.deepEqual(row.pinned_input, slot.input);
});
test('compact lists retain progress/immutable checksums without repeating large plans and reports', () => {
  const f = fixture(); const run = { schema_version, plan: f.plan, state: 'queued' as const, progress: comparisonProgress(f.plan, initialComparisonAssociations(f.plan)), cancelledAt: null, finalReport: null };
  const item = comparisonListItem(run);
  assert.equal(item.planChecksum, f.plan.checksum); assert.ok(!('plan' in item));
  assert.equal(ComparisonListResponseSchema.safeParse({ schema_version, comparisons: Array.from({ length: 20 }, () => item) }).success, true);
  assert.equal(ComparisonListResponseSchema.safeParse({ schema_version, comparisons: Array.from({ length: 21 }, () => item) }).success, false);
});
test('advisory packs strip rationale, while reports preserve advisory/non-automatic classification', () => {
  const f = fixture({ classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: randomUUID(), rationale: 'ignored by fixture' });
  const pack = buildPortableTestPack(f.plan);
  assert.ok(!JSON.stringify(pack).includes('PRIVATE_')); assert.ok(!JSON.stringify(pack).includes('rationale'));
  const report = prepareComparisonFinalization({ request: finalizeRequest(), source: source(f.plan, () => unavailable), finalizedAt: createdAt });
  assert.ok(report.repeats.every(row => row.outcome === 'advisory' && row.rules.every(rule => rule.automaticFailure === false)));
  assert.equal(ComparisonRuleResultSchema.safeParse({ ...report.repeats[0]!.rules[0], automaticFailure: true }).success, false);
});
test('case/plan slot counts and credential-shaped required inputs fail even with recomputed checksums', () => {
  const f = fixture();
  assert.equal(ComparisonPlanSchema.safeParse(rehash({ ...f.plan, slots: Array.from({ length: 121 }, () => f.plan.slots[0]!) })).success, false);
  const first = f.plan.cases[0]; assert.ok(first);
  assert.equal(ComparisonCaseSchema.safeParse(rehash({ ...first, repeatCount: 4 })).success, false);
  const a = first.inputs.a;
  const task = { ...a.task, syntheticBrief: { ...a.task.syntheticBrief, text: 'password=synthetic-only' } };
  const taskContent = Object.fromEntries(Object.entries(task).filter(([key]) => !['projectId', 'checksum', 'createdAt'].includes(key)));
  const alteredCase = rehash({ ...first, inputs: { ...first.inputs, a: { ...a, task: { ...task, checksum: checksum(taskContent) } } } });
  // A case alone permits public task text; package-level safety rejects before dispatch.
  assert.equal(ComparisonCaseSchema.safeParse(alteredCase).success, true);
  assert.throws(() => assertSafePortableContent(alteredCase), /Unsafe/);
  assert.throws(() => validatePortableTestPack(buildPortableTestPack(f.plan), { knownSecrets: ['Public film a'] }));
});
test('comparison routes are owner-only and all contract modules import without an index cycle', () => {
  assert.ok(REST_CONTRACTS.filter(route => route.path.includes('/comparisons')).every(route => route.auth === 'owner'));
  for (const module of ['index', 'comparison', 'review']) execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import('./src/${module}.ts')`], { cwd: new URL('..', import.meta.url) });
});
test('portable input URLs are rejected before export rather than producing a runner-incompatible pack', () => {
  assert.throws(() => assertSafePortableContent({ syntheticBrief: { text: 'See https://example.invalid/fixture' } }), /Unsafe/);
});
