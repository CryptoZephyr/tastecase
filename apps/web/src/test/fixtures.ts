/**
 * SYNTHETIC FIXTURES — tests and `next dev` state screens only. Never imported by production
 * routes (dev screens use the `.dev.tsx` extension, which `next build` excludes). Every name is
 * prefixed "Fixture" and no value here is a TasteCase, Qloo or assistant result.
 */
import type {
  Attempt, CatalogVersion, ComparisonDetail, ComparisonFinalReport, ComparisonListItem, ComparisonPlan, ComparisonRepeatResult,
  DiscoveryCandidate, DiscoveryEvidence, DiscoveryJob, DiscoveryJobDetail, DiscoveryTargetAssociation, MappingConfirmation, Project,
  ReviewCaseResponse, ReviewRecord, RunnerCredential, SuiteIdentity, SuiteVersion, TargetResult, TaskVersion,
} from '@/lib/api/types';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (c: string) => c.repeat(64).slice(0, 64);
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 13, 10, minutes)).toISOString();

export const ids = {
  owner: uuid(1), project: uuid(2), catalog: uuid(3), task: uuid(4), job: uuid(5), candidate: uuid(6), case: uuid(7), suite: uuid(8),
  suiteVersion: uuid(9), comparison: uuid(10), credential: uuid(11), decision: uuid(12), expectation: uuid(13), contrast: uuid(14),
  anchorA: uuid(15), anchorB: uuid(16),
};

export const project: Project = { schema_version: '1.0.0', id: ids.project, ownerId: ids.owner, name: 'Fixture concierge project', createdAt: at(0) };

const entry = (id: string, name: string, qloo?: number) => ({ id, name, metadata: { city: 'Fixture City', cuisines: ['Fixture cuisine'] }, ...(qloo ? { qlooEntityId: uuid(qloo) } : {}) });
export const catalog: CatalogVersion = {
  schema_version: '1.0.0', id: ids.catalog, label: 'Fixture catalog v1', projectId: ids.project, checksum: hash('a'), createdAt: at(1),
  entries: [entry('fx-harbor', 'Fixture Harbor Grill', 101), entry('fx-garden', 'Fixture Garden Table', 102), entry('fx-noodle', 'Fixture Noodle Bar', 103),
    entry('fx-oven', 'Fixture Stone Oven', 104), entry('fx-unmapped', 'Fixture Corner Cafe'), entry('fx-excluded', 'Fixture Closed Kitchen', 105)],
};
const eligible = ['fx-harbor', 'fx-garden', 'fx-noodle', 'fx-oven', 'fx-unmapped'];
export const mappings: MappingConfirmation[] = ['fx-harbor', 'fx-garden', 'fx-noodle', 'fx-oven'].map((entryId, index) => ({
  schema_version: '1.0.0', id: uuid(200 + index), catalogVersionId: ids.catalog, catalogEntryId: entryId, qlooEntityId: uuid(101 + index), projectId: ids.project, confirmedBy: ids.owner, createdAt: at(2),
}));
const constraints = { partySize: 2, location: { city: 'Fixture City', countryCode: 'US' }, budgetPerPerson: { currency: 'USD', amountMinor: 6000 },
  dietaryRequirements: ['vegetarian'], accessibilityRequirements: ['step-free entrance'], requiredCuisines: [], excludedEntryIds: ['fx-excluded'] };
export const task: TaskVersion = {
  schema_version: '1.0.0', id: ids.task, label: 'Fixture dinner task', catalogVersionId: ids.catalog, projectId: ids.project, checksum: hash('b'), createdAt: at(3),
  syntheticBrief: { provenance: 'synthetic', label: 'Fixture brief', text: 'Fixture: recommend dinner for two tonight.' }, syntheticInterests: [], constraints,
};
const targetInput = { schema_version: '1.0.0' as const, projectId: ids.project, catalog, task, mappings, eligibleCatalogEntryIds: eligible };
export const credentials: RunnerCredential[] = [{ schema_version: '1.0.0', id: ids.credential, projectId: ids.project, label: 'Fixture laptop runner', createdAt: at(4), revokedAt: null }];

const request = {
  schema_version: '1.0.0' as const, id: ids.job, catalogVersionId: ids.catalog, taskVersionId: ids.task, mappingConfirmationIds: mappings.map(row => row.id),
  eligibleCatalogEntryIds: eligible, assistantVersion: 'fixture-prompt-v1', repeatCount: 2, reducePair: true,
  profiles: [
    { id: 'a' as const, provenance: 'public_synthetic' as const, label: 'Fixture jazz fan', anchors: [{ id: ids.anchorA, label: 'Fixture Jazz Artist', kind: 'music' as const }] },
    { id: 'b' as const, provenance: 'public_synthetic' as const, label: 'Fixture film buff', anchors: [{ id: ids.anchorB, label: 'Fixture Film', kind: 'film' as const }] },
  ] as [never, never],
  budgets: { qlooAttempts: 8, modelDecisions: 2, targetAttempts: 6, rounds: 3, deadlineSeconds: 900, outputBytes: 64000, retriesPerOperation: 1 },
};

const rank = (n: number, profileId: 'a' | 'b', scope: 'full' | 'reduced_pair', ordered: string[], missing: string[]): DiscoveryEvidence => ({
  schema_version: '1.0.0', id: uuid(300 + n), projectId: ids.project, jobId: ids.job, attemptId: uuid(400 + n), checksum: hash(String(n)), capturedAt: at(10 + n),
  data: { kind: 'rank', providerStatus: missing.length ? 'partial' : 'ok', profileId, scope, requestedEntryIds: scope === 'full' ? ['fx-harbor', 'fx-garden', 'fx-noodle', 'fx-oven'] : ['fx-harbor', 'fx-garden'],
    orderedEntryIds: ordered, missingEntryIds: missing, unmappedEntryIds: scope === 'full' ? ['fx-unmapped'] : [], mappingConfirmationIds: [], anchorConfirmationIds: [] },
});
export const evidence: DiscoveryEvidence[] = [
  rank(1, 'a', 'full', ['fx-harbor', 'fx-garden', 'fx-oven'], ['fx-noodle']),
  rank(2, 'b', 'full', ['fx-garden', 'fx-harbor', 'fx-oven'], ['fx-noodle']),
  rank(3, 'a', 'reduced_pair', ['fx-harbor', 'fx-garden'], []),
  rank(4, 'b', 'reduced_pair', ['fx-garden', 'fx-harbor'], []),
];

const success = (ids_: string[], trace: 'complete' | 'partial' | 'unavailable' = 'partial'): TargetResult => ({
  schema_version: '1.0.0', outcome: 'success', trace: { completeness: trace, events: trace === 'unavailable' ? [] : [{ kind: 'target_started' }, { kind: 'target_completed', durationMs: 1840, status: 'ok' }] },
  output: { recommendations: ids_.map(id => ({ catalogEntryId: id, name: catalog.entries.find(row => row.id === id)?.name ?? id, reason: 'Fixture reason text.' })), text: `Fixture response recommending ${ids_.join(', ')}.` },
});
type Slot = { n: number; profileId: 'a' | 'b'; repeat: number; variant: 'full' | 'reduced_pair'; status: 'queued' | 'leased' | 'completed'; result?: TargetResult; uncertain?: number };
const slots: Slot[] = [
  { n: 1, profileId: 'a', repeat: 0, variant: 'full', status: 'completed', result: success(['fx-harbor', 'fx-oven']) },
  { n: 2, profileId: 'b', repeat: 0, variant: 'full', status: 'completed', result: success(['fx-harbor', 'fx-oven']) },
  { n: 3, profileId: 'a', repeat: 1, variant: 'full', status: 'completed', result: success(['fx-harbor', 'fx-garden']) },
  { n: 4, profileId: 'b', repeat: 1, variant: 'full', status: 'completed', result: { schema_version: '1.0.0', outcome: 'provider_unavailable', retryable: true, error: { code: 'fixture_timeout', message: 'Fixture provider timeout' }, trace: { completeness: 'unavailable', events: [] } }, uncertain: 1 },
  { n: 5, profileId: 'a', repeat: 0, variant: 'reduced_pair', status: 'completed', result: success(['fx-harbor']) },
  { n: 6, profileId: 'b', repeat: 0, variant: 'reduced_pair', status: 'queued' },
];
export const associations: DiscoveryTargetAssociation[] = slots.map(slot => ({
  attemptId: uuid(500 + slot.n), profileId: slot.profileId, round: 0, repeat: slot.repeat, variant: slot.variant, status: slot.status,
  dispatchCount: slot.status === 'queued' ? 0 : 1 + (slot.uncertain ?? 0), cancelled: false, uncertainDispatches: slot.uncertain ?? 0,
}));
export const attempts: Attempt[] = slots.filter(slot => slot.status === 'completed').map(slot => ({
  schema_version: '1.0.0', id: uuid(500 + slot.n), projectId: ids.project, catalogVersionId: ids.catalog, taskVersionId: ids.task, mappingConfirmationIds: mappings.map(row => row.id),
  status: 'completed', input: targetInput, inputChecksum: hash('c'), leaseId: uuid(600 + slot.n), leaseCredentialId: ids.credential, leaseExpiresAt: at(40),
  result: slot.result ?? null, resultChecksum: hash('d'), createdAt: at(20), completedAt: at(21 + slot.n),
}));

const briefs = { a: { provenance: 'synthetic' as const, label: 'Fixture brief A', text: 'Fixture: a jazz-loving traveller wants a relaxed vegetarian dinner for two.' },
  b: { provenance: 'synthetic' as const, label: 'Fixture brief B', text: 'Fixture: a film-loving traveller wants a relaxed vegetarian dinner for two.' } };
export const candidate: DiscoveryCandidate = {
  schema_version: '1.0.0', id: ids.candidate, projectId: ids.project, jobId: ids.job, checksum: hash('e'), createdAt: at(30),
  content: {
    contrast: { id: ids.contrast, entryIds: ['fx-harbor', 'fx-garden'], orders: { a: ['fx-harbor', 'fx-garden'], b: ['fx-garden', 'fx-harbor'] } },
    briefs: { ...briefs, constraints, eligibleCatalogEntryIds: eligible }, evidenceIds: evidence.map(row => row.id), targetAttemptIds: associations.map(row => row.attemptId),
    proposedExpectation: { classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: ids.contrast, rationale: 'Fixture rationale: the pair reverses between profiles.' },
    limitations: ['Fixture limitation: one follow-up run has not completed.'],
  },
};

export function job(state: DiscoveryJob['state'] = 'awaiting_review'): DiscoveryJob {
  return {
    schema_version: '1.0.0', id: ids.job, projectId: ids.project, input: { schema_version: '1.0.0', request, targetInput } as DiscoveryJob['input'], inputChecksum: hash('f'),
    state, checkpoint: state === 'needs_confirmation' ? 'anchors' : state === 'waiting_runner' ? 'targets' : 'saved',
    checkpointData: { evidenceIds: evidence.map(row => row.id), candidateIds: state === 'awaiting_review' || state === 'partial' ? [ids.candidate] : [] },
    counters: { qlooAttempts: 4, modelDecisions: 1, targetAttempts: 6, rounds: 2 }, revision: 7, leaseId: null, leaseExpiresAt: null,
    availableAt: at(5), deadlineAt: at(25), createdAt: at(5), cancelledAt: null, reason: null,
  };
}

export function jobDetail(state: DiscoveryJob['state'] = 'awaiting_review'): DiscoveryJobDetail {
  const confirming = state === 'needs_confirmation';
  return {
    schema_version: '1.0.0', job: job(state), evidence, attempts: associations,
    candidates: state === 'awaiting_review' || state === 'partial' ? [candidate] : [],
    resolutions: confirming ? [{ schema_version: '1.0.0', id: uuid(700), projectId: ids.project, jobId: ids.job, anchorId: ids.anchorA, evidenceId: uuid(701), createdAt: at(6),
      candidates: [{ entityId: uuid(702), name: 'Fixture Jazz Artist (band)', kind: 'music' }, { entityId: uuid(703), name: 'Fixture Jazz Artist (album)', kind: 'music' }] }] : [],
    confirmations: confirming ? [] : [ids.anchorA, ids.anchorB].map((anchorId, index) => ({ schema_version: '1.0.0', id: uuid(710 + index), anchorId, resolutionId: null, entityId: uuid(720 + index), projectId: ids.project, jobId: ids.job, confirmedBy: ids.owner, createdAt: at(7) })),
    providerAttempts: [
      { id: uuid(401), projectId: ids.project, jobId: ids.job, kind: 'qloo', operationKey: 'rank:a:full', tryNumber: 0, requestChecksum: hash('1'), reservedLeaseId: uuid(800), status: 'accepted', reservedAt: at(10), dispatchedAt: at(10), finishedAt: at(11), retryable: false, errorCategory: null, errorCode: null, nextDispatchAt: null },
      { id: uuid(405), projectId: ids.project, jobId: ids.job, kind: 'model', operationKey: 'select-contrast', tryNumber: 0, requestChecksum: hash('2'), reservedLeaseId: uuid(800), status: 'accepted', reservedAt: at(15), dispatchedAt: at(15), finishedAt: at(16), retryable: false, errorCategory: null, errorCode: null, nextDispatchAt: null },
    ],
  };
}

export function caseResponse(overrides: Partial<ReviewCaseResponse> = {}): ReviewCaseResponse {
  return {
    schema_version: '1.0.0',
    case: { schema_version: '1.0.0', id: ids.case, jobId: ids.job, candidateId: ids.candidate, projectId: ids.project, candidateChecksum: candidate.checksum, createdAt: at(31) },
    head: { schema_version: '1.0.0', projectId: ids.project, caseId: ids.case, jobId: ids.job, candidateId: ids.candidate, revision: 0, status: 'unreviewed', lastDecisionId: null, approvedExpectationVersionId: null },
    candidate, currentReview: null, ...overrides,
  };
}

/** A single-brief variant to prove the UI never invents a Profile B. */
export function singleBriefCase(): ReviewCaseResponse {
  const { b: _b, ...rest } = candidate.content.briefs;
  void _b;
  return caseResponse({ candidate: { ...candidate, content: { ...candidate.content, briefs: rest as typeof candidate.content.briefs } } });
}

const coverage = { missingEntryIds: ['fx-noodle'], unmappedEntryIds: ['fx-unmapped'], intendedFullAttempts: 4, capturedFullAttempts: 4, completedFullAttempts: 4,
  unfinishedAttemptIds: [uuid(506)], unavailableResultAttemptIds: [uuid(504)], partialTraceAttemptIds: [uuid(501)], unavailableTraceAttemptIds: [uuid(504)], uncertainAttemptIds: [uuid(504)] };
export const reviewRecord: ReviewRecord = {
  decision: {
    schema_version: '1.0.0', id: ids.decision, projectId: ids.project, caseId: ids.case, jobId: ids.job, candidateId: ids.candidate, candidateChecksum: candidate.checksum,
    action: 'edit', rationale: 'Fixture rationale: Profile B should avoid Fixture Noodle Bar.', expectedRevision: 0, revision: 1, requestChecksum: hash('3'), reviewedBy: ids.owner, createdAt: at(35),
    evidence: { schema_version: '1.0.0', projectId: ids.project, jobId: ids.job, candidate, job: job(), resolutions: [], confirmations: [], evidence, providerAttempts: [],
      targets: associations.filter(row => row.status === 'completed').map(association => ({ association, attempt: attempts.find(row => row.id === association.attemptId)! })),
      capturedAt: at(35), coverage, limitations: ['Fixture limitation.'], checksum: hash('4') } as ReviewRecord['decision']['evidence'],
    approvedExpectationVersionId: ids.expectation, checksum: hash('5'),
  },
  expectationVersion: {
    schema_version: '1.0.0', id: ids.expectation, projectId: ids.project, caseId: ids.case, jobId: ids.job, candidateId: ids.candidate, candidateChecksum: candidate.checksum,
    reviewDecisionId: ids.decision, reviewRevision: 1, evidenceChecksum: hash('4'), createdAt: at(35), checksum: hash('6'),
    expectation: { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'avoid', profileId: 'b', entryIds: ['fx-noodle'] }] },
  },
};
export const approvedCase = caseResponse({
  head: { schema_version: '1.0.0', projectId: ids.project, caseId: ids.case, jobId: ids.job, candidateId: ids.candidate, revision: 1, status: 'edited', lastDecisionId: ids.decision, approvedExpectationVersionId: ids.expectation },
  currentReview: reviewRecord,
});

export const suite: SuiteIdentity = { schema_version: '1.0.0', id: ids.suite, name: 'Fixture release suite', projectId: ids.project, currentVersion: 1, createdAt: at(36) };
export const suiteVersion: SuiteVersion = {
  schema_version: '1.0.0', id: ids.suiteVersion, suiteId: ids.suite, projectId: ids.project, expectedVersion: 0, version: 1, requestChecksum: hash('7'), publishedBy: ids.owner, createdAt: at(37),
  cases: [{ case: approvedCase.case, review: reviewRecord }], checksum: hash('8'),
};

const policy = { classification: 'approved_policy' as const, automaticFailure: true as const, rules: [{ kind: 'avoid' as const, profileId: 'b' as const, entryIds: ['fx-noodle'] }] };
export const plan: ComparisonPlan = {
  schema_version: '1.0.0', id: ids.comparison, projectId: ids.project, requestChecksum: hash('9'), suiteChecksum: suiteVersion.checksum, createdAt: at(40), checksum: hash('0'),
  request: { schema_version: '1.0.0', id: ids.comparison, suiteVersionId: ids.suiteVersion, baselineVersion: 'fixture-prompt-v1', candidateVersion: 'fixture-prompt-v2', caseIds: [ids.case], deadlineAt: at(99), dispatchBudget: 8, reclaimBudget: 0 },
  cases: [{ caseId: ids.case, caseChecksum: hash('a'), candidateChecksum: candidate.checksum, jobId: ids.job, expectationVersionId: ids.expectation, expectationChecksum: hash('6'), evidenceChecksum: hash('4'), repeatCount: 2,
    inputs: { a: { ...targetInput, task: { ...task, syntheticBrief: briefs.a } }, b: { ...targetInput, task: { ...task, syntheticBrief: briefs.b } } }, expectation: policy, evidenceReferences: [], checksum: hash('b') }],
  slots: [],
};

const repeatResult = (n: number, role: 'baseline' | 'candidate', profileId: 'a' | 'b', repeat: number, ids_: string[] | null, outcome: ComparisonRepeatResult['outcome']): ComparisonRepeatResult => ({
  attemptId: uuid(900 + n), caseId: ids.case, role, assistantVersion: role === 'baseline' ? 'fixture-prompt-v1' : 'fixture-prompt-v2', profileId, repeat, inputChecksum: hash('c'), dispatchCount: ids_ ? 1 : 0, uncertainDispatches: 0,
  result: ids_ ? { outcome: 'success', resultChecksum: hash('d'), traceCompleteness: 'partial', recommendationIds: ids_, checksum: hash('e') } : { outcome: 'pending', resultChecksum: null, traceCompleteness: null, recommendationIds: [], checksum: hash('e') },
  rules: [{ ruleIndex: 0, ruleKind: 'avoid', classification: 'approved_policy', automaticFailure: true, outcome, reason: outcome === 'pass' ? 'compliant' : outcome === 'fail' ? 'violated' : outcome === 'not_applicable' ? 'outside_profile' : 'pending_execution' }],
  outcome,
});
export const report: ComparisonFinalReport = {
  schema_version: '1.0.0', report_version: 'tastecase-comparison-report/1', id: uuid(950), comparisonId: ids.comparison, projectId: ids.project, planChecksum: plan.checksum,
  suiteVersionId: ids.suiteVersion, suiteChecksum: suiteVersion.checksum, baselineVersion: 'fixture-prompt-v1', candidateVersion: 'fixture-prompt-v2', requestChecksum: hash('f'), finalizedAt: at(80),
  completion: 'partial', stopReason: 'explicit_partial',
  progress: { logicalSlots: 8, queued: 1, leased: 0, completed: 7, dispatches: 7, reclaims: 0, uncertainDispatches: 0 },
  repeats: [
    repeatResult(1, 'baseline', 'a', 0, ['fx-harbor', 'fx-oven'], 'not_applicable'), repeatResult(2, 'candidate', 'a', 0, ['fx-garden', 'fx-harbor'], 'not_applicable'),
    repeatResult(3, 'baseline', 'a', 1, ['fx-harbor', 'fx-oven'], 'not_applicable'), repeatResult(4, 'candidate', 'a', 1, ['fx-harbor', 'fx-oven'], 'not_applicable'),
    repeatResult(5, 'baseline', 'b', 0, ['fx-garden', 'fx-oven'], 'pass'), repeatResult(6, 'candidate', 'b', 0, ['fx-noodle', 'fx-garden'], 'fail'),
    repeatResult(7, 'baseline', 'b', 1, ['fx-garden', 'fx-oven'], 'pass'), repeatResult(8, 'candidate', 'b', 1, null, 'unavailable'),
  ],
  summaries: [
    { caseId: ids.case, role: 'baseline', profileId: 'a', repeatCount: 2, outcomes: ['not_applicable', 'not_applicable'], outcome: 'not_applicable', disagreement: false, behaviorDisagreement: false },
    { caseId: ids.case, role: 'candidate', profileId: 'a', repeatCount: 2, outcomes: ['not_applicable', 'not_applicable'], outcome: 'not_applicable', disagreement: false, behaviorDisagreement: true },
    { caseId: ids.case, role: 'baseline', profileId: 'b', repeatCount: 2, outcomes: ['pass', 'pass'], outcome: 'pass', disagreement: false, behaviorDisagreement: false },
    { caseId: ids.case, role: 'candidate', profileId: 'b', repeatCount: 2, outcomes: ['fail', 'unavailable'], outcome: 'mixed', disagreement: true, behaviorDisagreement: false },
  ],
  behaviorChanges: [
    { caseId: ids.case, profileId: 'a', repeat: 0, status: 'changed', interpretation: 'Behavior change is not evidence of improved taste.' },
    { caseId: ids.case, profileId: 'a', repeat: 1, status: 'unchanged', interpretation: 'Behavior change is not evidence of improved taste.' },
    { caseId: ids.case, profileId: 'b', repeat: 0, status: 'changed', interpretation: 'Behavior change is not evidence of improved taste.' },
    { caseId: ids.case, profileId: 'b', repeat: 1, status: 'unavailable', interpretation: 'Behavior change is not evidence of improved taste.' },
  ],
  limitations: ['scoped_policy_only', 'not_individual_taste', 'qloo_not_redistributed', 'pinned_fact_freshness_unknown', 'incomplete_traces', 'partial_execution'],
  checksum: hash('7'),
};

/** Stored attempt for a comparison repeat, so text inspection has a synthetic response to diff. */
export function comparisonAttempt(attemptId: string): Attempt | undefined {
  const row = report.repeats.find(repeat => repeat.attemptId === attemptId);
  if (!row || row.result.outcome !== 'success') return undefined;
  const result = success(row.result.recommendationIds.filter((id): id is string => id !== null), 'partial');
  if (result.outcome === 'success') result.output.text = `Fixture ${row.role} response: try ${result.output.recommendations.map(item => item.name).join(', then ')} for a relaxed dinner.`;
  return { ...attempts[0], id: attemptId, result };
}

export function comparison(finalized: boolean): ComparisonDetail {
  return {
    schema_version: '1.0.0',
    comparison: { schema_version: '1.0.0', plan, state: finalized ? 'finalized' : 'running', cancelledAt: null, finalReport: finalized ? report : null,
      progress: finalized ? report.progress : { logicalSlots: 8, queued: 3, leased: 1, completed: 4, dispatches: 5, reclaims: 0, uncertainDispatches: 0 } },
    associations: report.repeats.map((row, index) => ({ attemptId: row.attemptId, comparisonId: ids.comparison, caseId: ids.case, role: row.role, assistantVersion: row.assistantVersion,
      profileId: row.profileId, repeat: row.repeat, status: finalized ? (row.result.outcome === 'pending' ? 'queued' : 'completed') : index < 4 ? 'completed' : index === 4 ? 'leased' : 'queued',
      dispatchCount: finalized ? row.dispatchCount : index < 5 ? 1 : 0, uncertainDispatches: 0, cancelled: false })),
  };
}

export const comparisonList: ComparisonListItem[] = [{
  schema_version: '1.0.0', id: ids.comparison, projectId: ids.project, suiteVersionId: ids.suiteVersion, suiteChecksum: suiteVersion.checksum, planChecksum: plan.checksum,
  baselineVersion: 'fixture-prompt-v1', candidateVersion: 'fixture-prompt-v2', state: 'finalized', progress: report.progress, createdAt: at(40), deadlineAt: at(99), cancelledAt: null, finalReportChecksum: report.checksum,
}];
