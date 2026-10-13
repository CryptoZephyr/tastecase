import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  ApprovedExpectationSchema, AttemptSchema, CreateDiscoveryJobRequestSchema, CreateReviewCaseRequestSchema,
  DiscoveryCandidateSchema, DiscoveryEvidenceSchema, DiscoveryJobSchema, ExpectationVersionSchema,
  PinnedDiscoveryInputSchema, PinnedReviewEvidenceSchema, PublishSuiteRequestSchema, REVIEW_LIMITS,
  REST_CONTRACTS, ReviewCaseResponseSchema, ReviewConflictError, ReviewDecisionRequestSchema,
  ReviewDecisionResponseSchema, ReviewHeadSchema, ReviewRecordSchema, ReviewExpectationSchema, ReviewWindowRequestSchema,
  SuiteIdentitySchema, SuiteVersionSchema, TargetInputSchema, checksum, computeDiscoveryFacts, discoveryAttemptId,
  pinReviewEvidence, prepareReviewCase, prepareReviewDecision, prepareSuitePublication, selectSuiteCases,
  validateApprovedExpectation, validatePinnedReviewEvidence, validatePublicationRetry, validateReviewRetry,
  type ApprovedExpectation, type PinnedReviewEvidence, type PinnedReviewEvidenceSource, type ReviewDecisionRequest,
  type ReviewHead, type ReviewRecord, type TargetResult,
} from './index.js';

const schema_version = '1.0.0' as const;
const createdAt = '2026-10-13T12:00:00.000Z';
function rehash<T extends { checksum: string }>(row: T): T {
  const content = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'checksum'));
  return { ...row, checksum: checksum(content) };
}
function fixture(projectId = randomUUID()) {
  const ownerId = randomUUID(); const jobId = randomUUID();
  const catalogId = randomUUID(); const taskId = randomUUID();
  const catalogPayload = { schema_version, id: catalogId, label: 'Synthetic catalog', entries: ['one', 'two', 'missing', 'unmapped', 'excluded'].map(id => ({ id, name: `Synthetic ${id}` })) };
  const syntheticBrief = { provenance: 'synthetic' as const, label: 'Fictional lunch', text: 'An explicitly fictional lunch.' };
  const constraints = { partySize: 2, dietaryRequirements: ['vegetarian'], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: ['excluded'] };
  const taskPayload = { schema_version, id: taskId, label: 'Synthetic task', catalogVersionId: catalogId, syntheticBrief, syntheticInterests: [], constraints };
  const mappings = ['one', 'two', 'missing'].map(catalogEntryId => ({ schema_version, id: randomUUID(), projectId, catalogVersionId: catalogId, catalogEntryId, qlooEntityId: randomUUID(), confirmedBy: ownerId, createdAt }));
  const request = CreateDiscoveryJobRequestSchema.parse({ schema_version, id: jobId, catalogVersionId: catalogId, taskVersionId: taskId,
    mappingConfirmationIds: mappings.map(row => row.id), eligibleCatalogEntryIds: ['one', 'two', 'missing', 'unmapped'], assistantVersion: 'synthetic-v1',
    profiles: ['a', 'b'].map(id => ({ id, provenance: 'public_synthetic', label: `Profile ${id}`, anchors: [{ id: randomUUID(), kind: 'film', label: 'Public film' }] })) });
  const input = PinnedDiscoveryInputSchema.parse({ schema_version, request, targetInput: { schema_version, projectId,
    catalog: { ...catalogPayload, projectId, checksum: checksum(catalogPayload), createdAt }, task: { ...taskPayload, projectId, checksum: checksum(taskPayload), createdAt },
    mappings, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds } });
  const confirmations = request.profiles.flatMap(profile => profile.anchors.map(anchor => ({ schema_version, id: randomUUID(), projectId, jobId,
    anchorId: anchor.id, resolutionId: null, entityId: randomUUID(), confirmedBy: ownerId, createdAt })));
  const rankingIds: [string, string] = [randomUUID(), randomUUID()];
  const rank = (profileId: 'a' | 'b') => ({ kind: 'rank' as const, providerStatus: profileId === 'a' ? 'ok' as const : 'partial' as const, profileId, scope: 'full' as const,
    requestedEntryIds: ['one', 'two', 'missing'], orderedEntryIds: profileId === 'a' ? ['one', 'two'] : ['two', 'one'], missingEntryIds: ['missing'], unmappedEntryIds: ['unmapped'],
    mappingConfirmationIds: mappings.map(row => row.id), anchorConfirmationIds: confirmations.filter(row => request.profiles.find(profile => profile.id === profileId)?.anchors.some(anchor => anchor.id === row.anchorId)).map(row => row.id) });
  const a = rank('a'); const b = rank('b'); const facts = computeDiscoveryFacts(jobId, rankingIds, a, b);
  const evidence = [a, b, facts].map((data, i) => DiscoveryEvidenceSchema.parse({ schema_version, id: rankingIds[i] ?? randomUUID(), projectId, jobId,
    attemptId: null, data, checksum: checksum(data), capturedAt: createdAt }));
  const contrast = facts.contrasts[0]; assert.ok(contrast);
  const briefs = { a: { ...syntheticBrief, text: 'Synthetic profile a.' }, b: { ...syntheticBrief, text: 'Synthetic profile b.' }, constraints, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds };
  function target(profileId: 'a' | 'b', repeat: number, result: TargetResult | null, variant: 'full' | 'reduced_pair' = 'full') {
    const round = variant === 'full' ? 0 : 1;
    const task = { ...taskPayload, id: discoveryAttemptId(jobId, `task:${profileId}:${variant}`, 0), syntheticBrief: variant === 'full' ? briefs[profileId] : { ...briefs[profileId], text: 'Synthetic reduced question, unchanged constraints.' } };
    const targetInput = TargetInputSchema.parse({ ...input.targetInput, task: { ...task, projectId, createdAt, checksum: checksum(task) } });
    const id = discoveryAttemptId(jobId, `target:${profileId}:${round}:${repeat}:${variant}`, 0);
    const attempt = AttemptSchema.parse({ schema_version, id, projectId, catalogVersionId: catalogId, taskVersionId: task.id, mappingConfirmationIds: mappings.map(row => row.id),
      status: result === null ? 'queued' : 'completed', input: targetInput, inputChecksum: checksum(targetInput), leaseId: result === null ? null : randomUUID(),
      leaseCredentialId: result === null ? null : randomUUID(), leaseExpiresAt: result === null ? null : createdAt,
      result, resultChecksum: result === null ? null : checksum(result), createdAt, completedAt: result === null ? null : createdAt });
    return { attempt, association: { attemptId: id, profileId, round, repeat, variant, status: attempt.status, dispatchCount: result === null ? 0 : 1, cancelled: false, uncertainDispatches: 0 } };
  }
  const targets = [target('a', 0, { schema_version, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'one', name: 'Synthetic One' }] }, trace: { completeness: 'partial', events: [] } }), target('b', 0, null)];
  const content = { contrast, briefs, evidenceIds: evidence.map(row => row.id), targetAttemptIds: targets.map(row => row.attempt.id),
    proposedExpectation: { classification: 'advisory' as const, automaticFailure: false as const, humanReviewRequired: true as const, contrastId: contrast.id, rationale: 'Observed order reversal only, not correctness.' },
    limitations: ['Synthetic finding; no individual preference claim.'] };
  const candidate = DiscoveryCandidateSchema.parse({ schema_version, id: randomUUID(), projectId, jobId, content, checksum: checksum(content), createdAt });
  const job = DiscoveryJobSchema.parse({ schema_version, id: jobId, projectId, input, inputChecksum: checksum(input), state: 'partial', checkpoint: 'saved',
    checkpointData: { evidenceIds: evidence.map(row => row.id), candidateIds: [candidate.id] }, counters: { qlooAttempts: 0, modelDecisions: 0, targetAttempts: 2, rounds: 1 },
    revision: 4, leaseId: null, leaseExpiresAt: null, availableAt: createdAt, deadlineAt: createdAt, createdAt, cancelledAt: null, reason: 'Captured gaps.' });
  const source: PinnedReviewEvidenceSource = { schema_version, projectId, jobId, candidate, job, evidence, targets, confirmations, resolutions: [], providerAttempts: [], capturedAt: createdAt };
  const pinned = pinReviewEvidence(source);
  const initial = prepareReviewCase({ request: { schema_version, id: randomUUID(), jobId, candidateId: candidate.id }, projectId, candidate, createdAt });
  function decide(request: ReviewDecisionRequest, head: ReviewHead = initial.head, snapshot: PinnedReviewEvidence = pinned) {
    return prepareReviewDecision({ request, reviewCase: initial.case, head, evidence: snapshot, ownerId, createdAt });
  }
  const suite = SuiteIdentitySchema.parse({ schema_version, id: randomUUID(), projectId, name: 'Synthetic release suite', currentVersion: 0, createdAt });
  return { projectId, ownerId, source, pinned, initial, decide, suite, target };
}
const acceptRequest = (expectedRevision = 0): ReviewDecisionRequest => ({ schema_version, id: randomUUID(), expectedRevision, action: 'accept', rationale: 'Save this finding as non-automatic advisory.' });
const policy: ApprovedExpectation = { classification: 'approved_policy', automaticFailure: true, rules: [
  { kind: 'recommend_any', profileId: 'a', entryIds: ['one', 'two'] },
  { kind: 'avoid', profileId: 'b', entryIds: ['one'] },
  { kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true },
] };
function publication(f: ReturnType<typeof fixture>, approved: { head: ReviewHead; record: ReviewRecord }) {
  const version = approved.record.expectationVersion; assert.ok(version);
  const request = PublishSuiteRequestSchema.parse({ schema_version, id: randomUUID(), suiteId: f.suite.id, expectedVersion: 0,
    cases: [{ caseId: f.initial.case.id, expectationVersionId: version.id, expectedReviewRevision: approved.head.revision }] });
  const selections = [{ case: f.initial.case, head: approved.head, review: approved.record }];
  const snapshot = prepareSuitePublication({ request, suite: f.suite, selections, ownerId: f.ownerId, createdAt });
  return { request, selections, snapshot };
}

test('case lifecycle starts at revision zero with the unchanged immutable advisory candidate', () => {
  const f = fixture();
  assert.deepEqual(ReviewCaseResponseSchema.parse(f.initial), { ...f.initial, currentReview: null });
});
test('case creation refuses caller checksums, projects, approvals and cross-project/job candidates', () => {
  const f = fixture();
  for (const extras of [{ projectId: f.projectId }, { candidateChecksum: checksum('forged') }, { expectation: policy }]) {
    assert.equal(CreateReviewCaseRequestSchema.safeParse({ schema_version, id: randomUUID(), jobId: f.source.jobId, candidateId: f.source.candidate.id, ...extras }).success, false);
  }
  for (const candidate of [{ ...f.source.candidate, projectId: randomUUID() }, { ...f.source.candidate, jobId: randomUUID() }]) {
    assert.throws(() => prepareReviewCase({ request: { schema_version, id: f.initial.case.id, jobId: f.source.jobId, candidateId: f.source.candidate.id }, projectId: f.projectId, candidate, createdAt }), /selected project\/job/);
  }
});
for (const action of ['accept', 'edit', 'reject', 'defer'] as const) test(`${action} requires rationale, a stable UUID and explicit expected revision`, () => {
  const request = { schema_version, id: randomUUID(), expectedRevision: 0, rationale: 'Human rationale.', action, ...(action === 'edit' ? { expectation: policy } : {}) };
  assert.equal(ReviewDecisionRequestSchema.safeParse(request).success, true);
  for (const change of [{ rationale: '' }, { rationale: ' ' }, { id: undefined }, { id: 'not-a-uuid' }, { expectedRevision: undefined }, { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { reviewedBy: randomUUID() }, { evidence: {} }, { checksum: checksum('forged') }]) {
    assert.equal(ReviewDecisionRequestSchema.safeParse({ ...request, ...change }).success, false);
  }
});
test('accept preserves the proposal; reject/defer cannot carry any approval; edit is explicit', () => {
  for (const action of ['accept', 'reject', 'defer']) assert.equal(ReviewDecisionRequestSchema.safeParse({ ...acceptRequest(), action, expectation: policy }).success, false);
  assert.equal(ReviewDecisionRequestSchema.safeParse({ ...acceptRequest(), action: 'edit' }).success, false);
});
for (const expectation of [
  { classification: 'failure', automaticFailure: true },
  { classification: 'unavailable', automaticFailure: false, reason: 'Missing evidence.' },
  { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'expression', code: 'return true' }] },
  { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'recommend_any', profileId: 'c', entryIds: ['one'] }] },
  { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'one', whenBothPresent: true }] },
  { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'fresh_price', maxAgeSeconds: 3600 }] },
  { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'tool_not_called' }] },
  { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'output_schema', url: 'https://example.invalid' }] },
  { classification: 'objective_contract', automaticFailure: true, profiles: ['a', 'a'], rules: [{ kind: 'output_schema' }] },
  { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'output_schema' }, { kind: 'output_schema' }] },
  { classification: 'advisory', automaticFailure: true, humanReviewRequired: true, contrastId: randomUUID(), rationale: 'Incorrect automatic advisory.' },
]) test(`unsupported expectation is rejected: ${JSON.stringify(expectation)}`, () => assert.equal(ApprovedExpectationSchema.safeParse(expectation).success, false));
test('unavailable remains representable but is never an approved executable expectation', () => {
  const unavailable = { classification: 'unavailable', automaticFailure: false, reason: 'Missing mapped evidence.' };
  assert.equal(ReviewExpectationSchema.safeParse(unavailable).success, true);
  assert.equal(ReviewDecisionRequestSchema.safeParse({ ...acceptRequest(), action: 'edit', expectation: unavailable }).success, false);
});
test('pinning retains missing/unmapped ranks, unfinished repetitions and partial traces without misconduct predicates', () => {
  const f = fixture();
  assert.deepEqual(f.pinned.coverage, { missingEntryIds: ['missing'], unmappedEntryIds: ['unmapped'], intendedFullAttempts: 4, capturedFullAttempts: 2, completedFullAttempts: 1,
    unfinishedAttemptIds: [f.source.targets[1]?.attempt.id], unavailableResultAttemptIds: [], partialTraceAttemptIds: [f.source.targets[0]?.attempt.id], unavailableTraceAttemptIds: [], uncertainAttemptIds: [] });
  assert.ok(f.pinned.limitations.some(text => text.includes('cannot prove misconduct')));
  assert.ok(f.pinned.limitations.some(text => text.includes('fact freshness')));
});
test('reduced results, unavailable/malformed outputs and uncertain dispatches remain explicit', () => {
  const f = fixture();
  const unavailable = f.target('a', 0, { schema_version, outcome: 'provider_unavailable', error: { code: 'UNAVAILABLE', message: 'Synthetic gap' }, retryable: false, trace: { completeness: 'unavailable', events: [] } }, 'reduced_pair');
  unavailable.association.uncertainDispatches = 1;
  const malformed = f.target('b', 0, { schema_version, outcome: 'malformed_output', rawText: 'Synthetic invalid JSON.', error: { code: 'INVALID', message: 'Synthetic schema gap' }, trace: { completeness: 'partial', events: [] } }, 'reduced_pair');
  const snapshot = pinReviewEvidence({ ...f.source, targets: [...f.source.targets, unavailable, malformed] });
  assert.deepEqual(snapshot.coverage.unavailableResultAttemptIds, [unavailable.attempt.id]);
  assert.deepEqual(snapshot.coverage.unavailableTraceAttemptIds, [unavailable.attempt.id]);
  assert.deepEqual(snapshot.coverage.uncertainAttemptIds, [unavailable.attempt.id]);
  assert.equal(snapshot.targets[3]?.attempt.result?.outcome, 'malformed_output');
});
test('a result-free capture is allowed, but intended target coverage cannot be hidden', () => {
  const f = fixture(); const candidateContent = { ...f.source.candidate.content, targetAttemptIds: [] };
  const candidate = { ...f.source.candidate, content: candidateContent, checksum: checksum(candidateContent) };
  const snapshot = pinReviewEvidence({ ...f.source, candidate, targets: [] });
  assert.equal(snapshot.coverage.completedFullAttempts, 0);
  assert.equal(snapshot.coverage.intendedFullAttempts, 4);
});
test('pinned immutable checksum detects tampering and rechecks coverage even after a forged rehash', () => {
  const f = fixture();
  assert.equal(PinnedReviewEvidenceSchema.safeParse({ ...f.pinned, capturedAt: '2026-10-14T12:00:00.000Z' }).success, false);
  assert.equal(PinnedReviewEvidenceSchema.safeParse(rehash({ ...f.pinned, coverage: { ...f.pinned.coverage, missingEntryIds: [] } })).success, false);
  assert.equal(PinnedReviewEvidenceSchema.safeParse(rehash({ ...f.pinned, limitations: [] })).success, false);
});
for (const field of ['projectId', 'jobId', 'candidateId', 'candidateChecksum'] as const) test(`persisted case rejects forged ${field}`, () => {
  const f = fixture();
  assert.throws(() => validatePinnedReviewEvidence(f.pinned, { ...f.initial.case, [field]: field === 'candidateChecksum' ? checksum('forged') : randomUUID() }));
});
for (const change of ['candidate-project', 'candidate-job', 'evidence-project', 'evidence-job', 'missing-evidence', 'duplicate-evidence', 'missing-target', 'foreign-target-id', 'foreign-target-project', 'profile-mismatch', 'foreign-anchor', 'foreign-mapping', 'missing-anchor', 'coverage-omission', 'checksum-change'] as const) test(`adversarial evidence/context rejects ${change}`, () => {
  const f = fixture(); const source = structuredClone(f.source);
  const firstEvidence = source.evidence[0]; const firstTarget = source.targets[0];
  assert.ok(firstEvidence); assert.ok(firstTarget); assert.equal(firstEvidence.data.kind, 'rank');
  if (change === 'candidate-project') source.candidate.projectId = randomUUID();
  if (change === 'candidate-job') source.candidate.jobId = randomUUID();
  if (change === 'evidence-project') firstEvidence.projectId = randomUUID();
  if (change === 'evidence-job') firstEvidence.jobId = randomUUID();
  if (change === 'missing-evidence') source.evidence.shift();
  if (change === 'duplicate-evidence') source.evidence.push(firstEvidence);
  if (change === 'missing-target') source.targets.shift();
  if (change === 'foreign-target-id') { firstTarget.attempt.id = randomUUID(); firstTarget.association.attemptId = firstTarget.attempt.id; }
  if (change === 'foreign-target-project') firstTarget.attempt.projectId = randomUUID();
  if (change === 'profile-mismatch') firstTarget.association.profileId = 'b';
  if (firstEvidence.data.kind === 'rank') {
    if (change === 'foreign-anchor') firstEvidence.data.anchorConfirmationIds = [randomUUID()];
    if (change === 'foreign-mapping') firstEvidence.data.mappingConfirmationIds = [randomUUID()];
    if (change === 'missing-anchor') firstEvidence.data.anchorConfirmationIds = [];
    if (change === 'coverage-omission') { firstEvidence.data.requestedEntryIds = ['one', 'two']; firstEvidence.data.missingEntryIds = []; firstEvidence.data.mappingConfirmationIds = source.job.input.targetInput.mappings.filter(row => row.catalogEntryId !== 'missing').map(row => row.id); }
  }
  if (change !== 'checksum-change') firstEvidence.checksum = checksum(firstEvidence.data);
  else firstEvidence.checksum = checksum('forged');
  assert.throws(() => pinReviewEvidence(source));
});
test('provider evidence cannot reference an absent or incompatible attempt', () => {
  const f = fixture(); const evidence = f.source.evidence.map((row, i) => i === 0 ? { ...row, attemptId: randomUUID() } : row);
  assert.throws(() => pinReviewEvidence({ ...f.source, evidence }));
});
test('objective ID checks cannot disguise taste restrictions or invent verified exclusions', () => {
  const f = fixture();
  const objective = { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'allowed_ids', entryIds: ['one', 'two', 'missing', 'unmapped'] }, { kind: 'exclusions', entryIds: ['excluded'] }, { kind: 'output_schema' }] };
  assert.equal(validateApprovedExpectation(objective, f.pinned).classification, 'objective_contract');
  for (const rule of [{ kind: 'allowed_ids', entryIds: ['one'] }, { kind: 'allowed_ids', entryIds: ['outside'] }, { kind: 'exclusions', entryIds: ['one'] }]) {
    assert.throws(() => validateApprovedExpectation({ ...objective, rules: [rule] }, f.pinned));
  }
});
test('policy references are scoped to the pinned catalog, eligible IDs and supported profiles', () => {
  const f = fixture();
  assert.deepEqual(validateApprovedExpectation(policy, f.pinned), policy);
  for (const rule of [{ kind: 'recommend_any', profileId: 'a', entryIds: ['outside'] }, { kind: 'recommend_any', profileId: 'a', entryIds: ['excluded'] },
    { kind: 'avoid', profileId: 'b', entryIds: ['outside'] }, { kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'outside', whenBothPresent: true }]) {
    assert.throws(() => validateApprovedExpectation({ ...policy, rules: [rule] }, f.pinned));
  }
  assert.throws(() => validateApprovedExpectation({ ...f.source.candidate.content.proposedExpectation, contrastId: randomUUID() }, f.pinned));
});
test('accept creates an immutable advisory approval without rewriting or failing the candidate', () => {
  const f = fixture(); const original = structuredClone(f.source.candidate); const saved = f.decide(acceptRequest());
  assert.deepEqual(saved.record.expectationVersion?.expectation, original.content.proposedExpectation);
  assert.equal(saved.head.revision, 1);
  assert.deepEqual(f.source.candidate, original);
});
test('approved edits create a new immutable expectation and stale edits return a visible conflict', () => {
  const f = fixture(); const accepted = f.decide(acceptRequest()); const old = structuredClone(accepted.record);
  const edited = f.decide({ ...acceptRequest(1), action: 'edit', expectation: policy }, accepted.head);
  assert.equal(edited.head.revision, 2);
  assert.notEqual(edited.record.expectationVersion?.id, accepted.record.expectationVersion?.id);
  assert.deepEqual(accepted.record, old);
  assert.throws(() => f.decide({ ...acceptRequest(1), action: 'edit', expectation: policy }, edited.head), ReviewConflictError);
});
for (const action of ['accept', 'edit', 'reject', 'defer'] as const) test(`re-review with ${action} changes current publication eligibility without mutating history`, () => {
  const f = fixture(); const approved = f.decide(acceptRequest()); const published = publication(f, approved); const old = structuredClone(published.snapshot);
  const request = ReviewDecisionRequestSchema.parse({ ...acceptRequest(1), action, ...(action === 'edit' ? { expectation: policy } : {}) });
  const changed = f.decide(request, approved.head);
  assert.throws(() => selectSuiteCases(published.request, f.projectId, [{ case: f.initial.case, head: changed.head, review: changed.record }]), ReviewConflictError);
  assert.deepEqual(SuiteVersionSchema.parse(published.snapshot), old);
  if (action === 'reject' || action === 'defer') assert.equal(changed.record.expectationVersion, null);
});
test('review retries replay original content, including revision zero, after later review', () => {
  const f = fixture(); const request = acceptRequest(); const approved = f.decide(request); f.decide({ ...acceptRequest(1), action: 'reject' }, approved.head);
  assert.deepEqual(validateReviewRetry(request, approved.record, f.initial.case), approved.record);
  assert.throws(() => validateReviewRetry({ ...request, rationale: 'Changed rationale' }, approved.record, f.initial.case), ReviewConflictError);
  assert.throws(() => validateReviewRetry({ ...request, expectedRevision: 1 }, approved.record, f.initial.case), ReviewConflictError);
  assert.throws(() => validateReviewRetry(request, approved.record, { ...f.initial.case, id: randomUUID() }), ReviewConflictError);
});
test('review receipts and expectation versions reject checksum and provenance tampering', () => {
  const f = fixture(); const saved = f.decide(acceptRequest()); const version = saved.record.expectationVersion; assert.ok(version);
  assert.equal(ExpectationVersionSchema.safeParse({ ...version, expectation: policy }).success, false);
  for (const field of ['projectId', 'caseId', 'jobId', 'candidateId', 'reviewDecisionId', 'evidenceChecksum', 'candidateChecksum'] as const) {
    const forged: typeof version = rehash({ ...version, [field]: field.endsWith('Checksum') ? checksum('forged') : randomUUID() });
    assert.equal(ReviewRecordSchema.safeParse({ ...saved.record, expectationVersion: forged }).success, false);
  }
  assert.equal(ReviewRecordSchema.safeParse({ ...saved.record, decision: { ...saved.record.decision, rationale: 'Modified rationale' } }).success, false);
});
test('first publication pins an explicit approval and immutable receipt rather than a live head', () => {
  const f = fixture(); const approved = f.decide({ ...acceptRequest(), action: 'edit', expectation: policy }); const saved = publication(f, approved);
  assert.equal(saved.snapshot.version, 1);
  assert.deepEqual(saved.snapshot.cases[0]?.review, approved.record);
  assert.equal(saved.snapshot.cases[0]?.review.decision.evidence.candidate.content.proposedExpectation.classification, 'advisory');
});
test('publication requests reject empty, duplicate, zero-revision, forged, oversized and implicit-latest selections', () => {
  const f = fixture(); const saved = publication(f, f.decide(acceptRequest())); const selection = saved.request.cases[0]; assert.ok(selection);
  for (const cases of [[], [selection, selection], [{ ...selection, expectedReviewRevision: 0 }], [{ caseId: selection.caseId }],
    [{ ...selection, checksum: checksum('forged') }], Array.from({ length: REVIEW_LIMITS.suiteCases + 1 }, () => ({ ...selection, caseId: randomUUID(), expectationVersionId: randomUUID() }))]) {
    assert.equal(PublishSuiteRequestSchema.safeParse({ ...saved.request, cases }).success, false);
  }
  assert.equal(PublishSuiteRequestSchema.safeParse({ ...saved.request, publishedBy: randomUUID() }).success, false);
  assert.equal(PublishSuiteRequestSchema.safeParse({ ...saved.request, cases: Array.from({ length: REVIEW_LIMITS.suiteCases }, () => ({ ...selection, caseId: randomUUID(), expectationVersionId: randomUUID() })) }).success, true);
});
test('publication refuses stale, unreviewed, rejected, deferred and superseded selections', () => {
  const f = fixture(); const approved = f.decide(acceptRequest()); const saved = publication(f, approved);
  for (const status of ['unreviewed', 'rejected', 'deferred'] as const) {
    const head = ReviewHeadSchema.parse({ ...approved.head, status, revision: status === 'unreviewed' ? 0 : 2, lastDecisionId: status === 'unreviewed' ? null : randomUUID(), approvedExpectationVersionId: null });
    assert.throws(() => selectSuiteCases(saved.request, f.projectId, [{ ...saved.selections[0], case: f.initial.case, review: approved.record, head }]), ReviewConflictError);
  }
  assert.throws(() => selectSuiteCases({ ...saved.request, cases: saved.request.cases.map(row => ({ ...row, expectationVersionId: randomUUID() })) }, f.projectId, saved.selections), ReviewConflictError);
  assert.throws(() => prepareSuitePublication({ request: saved.request, suite: { ...f.suite, currentVersion: 1 }, selections: saved.selections, ownerId: f.ownerId, createdAt }), ReviewConflictError);
});
test('multiple cases and jobs can be published under one project-scoped suite identity', () => {
  const f = fixture(); const other = fixture(f.projectId);
  const one = publication(f, f.decide(acceptRequest())); const two = publication(other, other.decide({ ...acceptRequest(), action: 'edit', expectation: policy }));
  const request = { ...one.request, cases: [...one.request.cases, ...two.request.cases] };
  const snapshot = prepareSuitePublication({ request, suite: f.suite, selections: [...one.selections, ...two.selections], ownerId: f.ownerId, createdAt });
  assert.deepEqual(snapshot.cases.map(row => row.case.jobId), [f.source.jobId, other.source.jobId]);
  assert.equal(snapshot.version, 1);
  const nextRequest = { ...request, id: randomUUID(), expectedVersion: 1 };
  const next = prepareSuitePublication({ request: nextRequest, suite: { ...f.suite, currentVersion: 1 }, selections: [...one.selections, ...two.selections], ownerId: f.ownerId, createdAt });
  assert.equal(next.version, 2);
  assert.notEqual(next.checksum, snapshot.checksum);
});
test('the whole multi-case selection is validated and cross-project cases cannot be published', () => {
  const f = fixture(); const other = fixture(); const one = publication(f, f.decide(acceptRequest())); const two = publication(other, other.decide(acceptRequest()));
  const request = { ...one.request, cases: [...one.request.cases, ...two.request.cases] };
  assert.throws(() => selectSuiteCases(request, f.projectId, [...one.selections, ...two.selections]), /another project/);
  assert.throws(() => selectSuiteCases(request, f.projectId, one.selections), /complete publication selection/);
});
test('publication retry keeps the ID, checksum and version after later reviews and publications', () => {
  const f = fixture(); const approved = f.decide(acceptRequest()); const saved = publication(f, approved);
  f.decide({ ...acceptRequest(1), action: 'defer' }, approved.head);
  assert.deepEqual(validatePublicationRetry(saved.request, saved.snapshot, { ...f.suite, currentVersion: 9 }), saved.snapshot);
  for (const request of [{ ...saved.request, expectedVersion: 1 }, { ...saved.request, id: randomUUID() }, { ...saved.request, cases: saved.request.cases.map(row => ({ ...row, expectedReviewRevision: 2 })) }]) {
    assert.throws(() => validatePublicationRetry(request, saved.snapshot, f.suite), ReviewConflictError);
  }
  assert.throws(() => validatePublicationRetry(saved.request, saved.snapshot, { ...f.suite, projectId: randomUUID() }), ReviewConflictError);
});
test('suite snapshot rejects altered checksums, unrelated projects and modified embedded approval provenance', () => {
  const f = fixture(); const saved = publication(f, f.decide(acceptRequest()));
  assert.equal(SuiteVersionSchema.safeParse({ ...saved.snapshot, version: 2 }).success, false);
  assert.equal(SuiteVersionSchema.safeParse(rehash({ ...saved.snapshot, projectId: randomUUID() })).success, false);
  assert.equal(SuiteVersionSchema.safeParse(rehash({ ...saved.snapshot, requestChecksum: checksum('forged') })).success, false);
});
test('late-arriving results cannot change old receipt or suite snapshot', () => {
  const f = fixture(); const approved = f.decide(acceptRequest()); const saved = publication(f, approved); const original = structuredClone(saved.snapshot);
  const late = f.target('b', 0, { schema_version, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'two', name: 'Synthetic Two' }] }, trace: { completeness: 'complete', events: [] } });
  const fresh = pinReviewEvidence({ ...f.source, targets: [f.source.targets[0], late].filter((row): row is NonNullable<typeof row> => row !== undefined) });
  assert.notEqual(fresh.checksum, f.pinned.checksum);
  assert.deepEqual(SuiteVersionSchema.parse(saved.snapshot), original);
  assert.equal(saved.snapshot.cases[0]?.review.decision.evidence.coverage.unfinishedAttemptIds.length, 1);
});
test('response schemas enforce head/receipt context while supporting historical idempotent receipts', () => {
  const f = fixture(); const accepted = f.decide(acceptRequest()); const rejected = f.decide({ ...acceptRequest(1), action: 'reject' }, accepted.head);
  assert.equal(ReviewDecisionResponseSchema.safeParse({ schema_version, head: rejected.head, review: accepted.record, idempotent: true }).success, true);
  assert.equal(ReviewDecisionResponseSchema.safeParse({ schema_version, head: rejected.head, review: accepted.record, idempotent: false }).success, false);
  assert.equal(ReviewCaseResponseSchema.safeParse({ ...f.initial, head: rejected.head, currentReview: accepted.record }).success, false);
});
test('pinned evidence rejects oversized otherwise-valid target results', () => {
  const f = fixture();
  const result: TargetResult = { schema_version, outcome: 'success', output: { recommendations: Array.from({ length: 300 }, () => ({ catalogEntryId: 'one', name: 'Synthetic One', reason: 'x'.repeat(8000) })) }, trace: { completeness: 'partial', events: [] } };
  const large = f.target('a', 0, result);
  const second = f.source.targets[1]; assert.ok(second);
  assert.throws(() => pinReviewEvidence({ ...f.source, targets: [large, second] }), /byte limit/);
});
test('request body bytes are bounded after normalisation, including multibyte IDs', () => {
  const f = fixture();
  const expectation = { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'recommend_any', profileId: 'a', entryIds: Array.from({ length: 500 }, (_, i) => `${i}${'界'.repeat(150)}`) }] };
  assert.equal(ReviewDecisionRequestSchema.safeParse({ ...acceptRequest(), action: 'edit', expectation }).success, false);
  const request = acceptRequest();
  const uppercase = { ...request, id: request.id.toUpperCase(), rationale: `  ${request.rationale}  ` };
  const approved = f.decide(request);
  assert.equal(validateReviewRetry(uppercase, approved.record, f.initial.case).decision.requestChecksum, checksum(request));
});
test('contract modules can be imported directly without introducing runtime cycles', () => {
  for (const source of ['./src/review.ts', './src/discovery.ts']) {
    const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(source)});`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(result, '');
  }
});
test('review history/list windows are bounded and owner-only route metadata stays separate from discovery', () => {
  assert.deepEqual(ReviewWindowRequestSchema.parse({}), { limit: 20, offset: 0 });
  for (const query of [{ limit: 21 }, { offset: 10001 }, { limit: 0 }, { offset: -1 }, { ownerId: randomUUID() }]) assert.equal(ReviewWindowRequestSchema.safeParse(query).success, false);
  const routes = REST_CONTRACTS.filter(route => route.path.includes('/cases') || route.path.includes('/suites'));
  assert.equal(routes.length, 11);
  assert.ok(routes.every(route => route.auth === 'owner'));
  assert.equal(REST_CONTRACTS.filter(route => route.path.includes('/discovery-jobs')).length, 7);
});
