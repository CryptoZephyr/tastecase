import { z } from 'zod';
import type { Attempt, TargetInput } from './index.js';
import { canonicalJson, checksum } from './canonical.js';
import { CatalogEntryIdSchema, ChecksumSchema, IdSchema, SchemaVersionSchema, TimestampSchema } from './primitives.js';

export const REVIEW_LIMITS = { requestBytes: 65536, evidenceBytes: 2097152, suiteBytes: 8388608, suiteCases: 50, window: 20, offset: 10000 } as const;
const rationale = z.string().trim().min(1).max(2000);
const revision = z.number().int().nonnegative().safe();
const entryIds = z.array(CatalogEntryIdSchema).max(500).refine(ids => new Set(ids).size === ids.length, 'Duplicate catalog IDs');
const recordIds = z.array(IdSchema).max(12).refine(ids => new Set(ids).size === ids.length, 'Duplicate record IDs');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sameIds = (a: string[], b: string[]) => same([...a].sort(), [...b].sort());
const withoutChecksum = (value: { checksum: string }) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'checksum'));
const bounded = (value: unknown, bytes: number) => Buffer.byteLength(canonicalJson(value), 'utf8') <= bytes;

export class ReviewConflictError extends Error { readonly code = 'conflict'; }

/** Initialise in the foundational module, using lazy dependencies and type-only imports to
 * avoid both direct and indirect runtime cycles. API callers resolve all rows under owner scope,
 * never from request bodies. These validators do not authenticate, lock rows or evaluate results.
 */
export function createReviewContracts(
  foundation: { targetInputSchema: z.ZodType<TargetInput>; attemptSchema: z.ZodType<Attempt> },
  discovery: typeof import('./discovery.js'),
) {
  const AdvisoryExpectationSchema = z.lazy(() => discovery.AdvisoryExpectationSchema);
  const AnchorResolutionSchema = z.lazy(() => discovery.AnchorResolutionSchema);
  const DiscoveryAnchorConfirmationSchema = z.lazy(() => discovery.DiscoveryAnchorConfirmationSchema);
  const DiscoveryCandidateSchema = z.lazy(() => discovery.DiscoveryCandidateSchema);
  const DiscoveryEvidenceSchema = z.lazy(() => discovery.DiscoveryEvidenceSchema);
  const DiscoveryJobSchema = z.lazy(() => discovery.DiscoveryJobSchema);
  const DiscoveryProfileIdSchema = z.lazy(() => discovery.DiscoveryProfileIdSchema);
  const DiscoveryProviderAttemptSchema = z.lazy(() => discovery.DiscoveryProviderAttemptSchema);
  const DiscoveryTargetAssociationSchema = z.lazy(() => discovery.DiscoveryTargetAssociationSchema);
  const profiles = z.array(DiscoveryProfileIdSchema).min(1).max(2).refine(ids => new Set(ids).size === ids.length, 'Duplicate profiles');

  /** No prose, executable expressions, fact freshness claims or trace-misconduct predicates. */
  const ObjectiveContractRuleSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('output_schema') }),
    z.strictObject({ kind: z.literal('allowed_ids'), entryIds: entryIds.min(1) }),
    z.strictObject({ kind: z.literal('exclusions'), entryIds: entryIds.min(1) }),
  ]);
  const ApprovedPolicyRuleSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('recommend_any'), profileId: DiscoveryProfileIdSchema, entryIds: entryIds.min(1) }),
    z.strictObject({ kind: z.literal('avoid'), profileId: DiscoveryProfileIdSchema, entryIds: entryIds.min(1) }),
    z.strictObject({ kind: z.literal('order'), profileId: DiscoveryProfileIdSchema, beforeEntryId: CatalogEntryIdSchema,
      afterEntryId: CatalogEntryIdSchema, whenBothPresent: z.literal(true) })
      .refine(rule => rule.beforeEntryId !== rule.afterEntryId, 'Order requires distinct IDs'),
  ]);
  const ApprovedExpectationSchema = z.union([
    z.strictObject({ classification: z.literal('objective_contract'), automaticFailure: z.literal(true), profiles,
      rules: z.array(ObjectiveContractRuleSchema).min(1).max(3)
        .refine(rules => new Set(rules.map(rule => rule.kind)).size === rules.length, 'Duplicate contract checks') }),
    z.strictObject({ classification: z.literal('approved_policy'), automaticFailure: z.literal(true),
      rules: z.array(ApprovedPolicyRuleSchema).min(1).max(20)
        .refine(rules => new Set(rules.map(rule => canonicalJson(rule))).size === rules.length, 'Duplicate policy rules') }),
    AdvisoryExpectationSchema,
  ]);
  const ReviewExpectationSchema = z.union([ApprovedExpectationSchema, z.strictObject({
    classification: z.literal('unavailable'), automaticFailure: z.literal(false), reason: rationale,
  })]);
  type ApprovedExpectation = z.infer<typeof ApprovedExpectationSchema>;

  /** The stable request ID and expectedRevision are part of the idempotence checksum, including revision zero. */
  const decisionBase = { schema_version: SchemaVersionSchema, id: IdSchema, expectedRevision: revision, rationale };
  const ReviewDecisionRequestSchema = z.discriminatedUnion('action', [
    z.strictObject({ ...decisionBase, action: z.literal('accept') }),
    z.strictObject({ ...decisionBase, action: z.literal('edit'), expectation: ApprovedExpectationSchema }),
    z.strictObject({ ...decisionBase, action: z.literal('reject') }),
    z.strictObject({ ...decisionBase, action: z.literal('defer') }),
  ]).refine(value => bounded(value, REVIEW_LIMITS.requestBytes), 'Review request exceeds byte limit');
  const CreateReviewCaseRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema, id: IdSchema, jobId: IdSchema, candidateId: IdSchema });
  const ReviewCaseSchema = CreateReviewCaseRequestSchema.extend({ projectId: IdSchema, candidateChecksum: ChecksumSchema, createdAt: TimestampSchema });
  const ReviewHeadSchema = z.strictObject({
    schema_version: SchemaVersionSchema, projectId: IdSchema, caseId: IdSchema, jobId: IdSchema, candidateId: IdSchema,
    revision, status: z.enum(['unreviewed', 'accepted', 'edited', 'rejected', 'deferred']),
    lastDecisionId: IdSchema.nullable(), approvedExpectationVersionId: IdSchema.nullable(),
  }).superRefine((head, ctx) => {
    if ((head.revision === 0) !== (head.status === 'unreviewed') || (head.revision === 0) !== (head.lastDecisionId === null)) {
      ctx.addIssue({ code: 'custom', message: 'Only a revision-zero head is unreviewed and has no decision' });
    }
    if ((head.status === 'accepted' || head.status === 'edited') !== (head.approvedExpectationVersionId !== null)) {
      ctx.addIssue({ code: 'custom', message: 'Only an approved head has a current expectation version' });
    }
  });
  /** Case creation pins an existing immutable discovery candidate; revision zero is reviewable. */
  function prepareReviewCase(args: { request: CreateReviewCaseRequest; projectId: string; candidate: z.infer<typeof DiscoveryCandidateSchema>; createdAt: string }) {
    const request = CreateReviewCaseRequestSchema.parse(args.request); const candidate = DiscoveryCandidateSchema.parse(args.candidate);
    const projectId = IdSchema.parse(args.projectId);
    if (candidate.projectId !== projectId || candidate.jobId !== request.jobId || candidate.id !== request.candidateId) throw new TypeError('Case candidate must belong to the selected project/job');
    const reviewCase = ReviewCaseSchema.parse({ ...request, projectId, candidateChecksum: candidate.checksum, createdAt: args.createdAt });
    const head = ReviewHeadSchema.parse({ schema_version: request.schema_version, projectId, caseId: request.id, jobId: request.jobId,
      candidateId: request.candidateId, revision: 0, status: 'unreviewed', lastDecisionId: null, approvedExpectationVersionId: null });
    return { schema_version: request.schema_version, case: reviewCase, head, candidate, currentReview: null };
  }
  const ReviewWindowRequestSchema = z.strictObject({
    limit: z.coerce.number().int().min(1).max(REVIEW_LIMITS.window).default(REVIEW_LIMITS.window),
    offset: z.coerce.number().int().min(0).max(REVIEW_LIMITS.offset).default(0),
  });
  const PublishSuiteCaseSelectionSchema = z.strictObject({ caseId: IdSchema, expectationVersionId: IdSchema, expectedReviewRevision: revision.min(1) });
  const PublishSuiteRequestSchema = z.strictObject({
    schema_version: SchemaVersionSchema, id: IdSchema, suiteId: IdSchema, expectedVersion: revision,
    cases: z.array(PublishSuiteCaseSelectionSchema).min(1).max(REVIEW_LIMITS.suiteCases)
      .refine(cases => new Set(cases.map(row => row.caseId)).size === cases.length
        && new Set(cases.map(row => row.expectationVersionId)).size === cases.length, 'Duplicate suite selection'),
  }).refine(value => bounded(value, REVIEW_LIMITS.requestBytes), 'Publication request exceeds byte limit');
  const CreateSuiteRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema, id: IdSchema, name: z.string().trim().min(1).max(160) });
  const SuiteIdentitySchema = CreateSuiteRequestSchema.extend({ projectId: IdSchema, currentVersion: revision, createdAt: TimestampSchema });
  const SuiteListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, suites: z.array(SuiteIdentitySchema).max(REVIEW_LIMITS.window) });
  type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequestSchema>;
  type CreateReviewCaseRequest = z.infer<typeof CreateReviewCaseRequestSchema>;
  type ReviewCase = z.infer<typeof ReviewCaseSchema>;
  type ReviewHead = z.infer<typeof ReviewHeadSchema>;
  type PublishSuiteRequest = z.infer<typeof PublishSuiteRequestSchema>;
  type SuiteIdentity = z.infer<typeof SuiteIdentitySchema>;
  const PinnedReviewTargetSchema = z.strictObject({ association: DiscoveryTargetAssociationSchema, attempt: foundation.attemptSchema });
  const ReviewEvidenceCoverageSchema = z.strictObject({
    missingEntryIds: entryIds, unmappedEntryIds: entryIds,
    intendedFullAttempts: z.number().int().min(2).max(6), capturedFullAttempts: z.number().int().min(0).max(12), completedFullAttempts: z.number().int().min(0).max(12),
    unfinishedAttemptIds: recordIds, unavailableResultAttemptIds: recordIds, partialTraceAttemptIds: recordIds,
    unavailableTraceAttemptIds: recordIds, uncertainAttemptIds: recordIds,
  });
  const PinnedReviewEvidenceSourceSchema = z.strictObject({
    schema_version: SchemaVersionSchema, projectId: IdSchema, jobId: IdSchema, candidate: DiscoveryCandidateSchema, job: DiscoveryJobSchema,
    resolutions: z.array(AnchorResolutionSchema).max(20), confirmations: z.array(DiscoveryAnchorConfirmationSchema).max(10),
    evidence: z.array(DiscoveryEvidenceSchema).max(50), targets: z.array(PinnedReviewTargetSchema).max(12),
    providerAttempts: z.array(DiscoveryProviderAttemptSchema).max(28), capturedAt: TimestampSchema,
  });
  type EvidenceSource = z.infer<typeof PinnedReviewEvidenceSourceSchema>;
  function reviewEvidenceCoverage(source: EvidenceSource) {
    const ranks = source.evidence.flatMap(row => row.data.kind === 'rank' || row.data.kind === 'facts' ? [row.data] : []);
    return ReviewEvidenceCoverageSchema.parse({
      missingEntryIds: [...new Set(ranks.flatMap(rank => rank.missingEntryIds))].sort(),
      unmappedEntryIds: [...new Set(ranks.flatMap(rank => rank.unmappedEntryIds))].sort(),
      intendedFullAttempts: source.job.input.request.repeatCount * 2,
      capturedFullAttempts: source.targets.filter(row => row.association.variant === 'full').length,
      completedFullAttempts: source.targets.filter(row => row.association.variant === 'full' && row.attempt.status === 'completed').length,
      unfinishedAttemptIds: source.targets.filter(row => row.attempt.status !== 'completed').map(row => row.attempt.id),
      unavailableResultAttemptIds: source.targets.filter(row => row.attempt.result?.outcome === 'provider_unavailable').map(row => row.attempt.id),
      partialTraceAttemptIds: source.targets.filter(row => row.attempt.result?.trace.completeness === 'partial').map(row => row.attempt.id),
      unavailableTraceAttemptIds: source.targets.filter(row => row.attempt.result?.trace.completeness === 'unavailable').map(row => row.attempt.id),
      uncertainAttemptIds: source.targets.filter(row => row.association.uncertainDispatches > 0).map(row => row.attempt.id),
    });
  }
  function reviewEvidenceLimitations(source: EvidenceSource): string[] {
    const coverage = reviewEvidenceCoverage(source);
    return [...new Set([...source.candidate.content.limitations,
      'Qloo evidence is query-relative and advisory, not individual preference correctness.',
      'Absent tool events cannot prove misconduct; trace completeness is pinned for each captured result.',
      'Catalog facts are pinned as supplied; no fact freshness or evaluator is asserted.',
      `Full target coverage: ${coverage.completedFullAttempts} completed, ${coverage.capturedFullAttempts} captured, ${coverage.intendedFullAttempts} intended.`,
      ...(coverage.missingEntryIds.length || coverage.unmappedEntryIds.length ? ['Missing or unmapped ranking coverage is unavailable, not negative preference.'] : []),
      ...(source.evidence.some(row => row.data.kind === 'rank' && row.data.providerStatus !== 'ok') ? ['Reduced or non-ok provider evidence retains its scope, status and coverage.'] : []),
      ...(source.targets.some(row => row.attempt.result?.outcome !== 'success') ? ['Unfinished, malformed or unavailable target results are execution gaps, not taste passes or failures.'] : []),
      ...(coverage.partialTraceAttemptIds.length || coverage.unavailableTraceAttemptIds.length ? ['Incomplete traces cannot prove missing tool calls.'] : []),
      ...(coverage.uncertainAttemptIds.length ? ['Interrupted dispatches may have repeated provider calls; exactly-once execution is not established.'] : []),
    ])];
  }
  const PinnedReviewEvidenceSchema = PinnedReviewEvidenceSourceSchema.extend({
    coverage: ReviewEvidenceCoverageSchema, limitations: z.array(rationale).min(1).max(40), checksum: ChecksumSchema,
  }).superRefine((snapshot, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (!bounded(snapshot, REVIEW_LIMITS.evidenceBytes)) issue('Pinned evidence exceeds byte limit');
    if (checksum(withoutChecksum(snapshot)) !== snapshot.checksum) issue('Pinned evidence checksum mismatch');
    if (snapshot.projectId !== snapshot.job.projectId || snapshot.projectId !== snapshot.candidate.projectId
      || snapshot.jobId !== snapshot.job.id || snapshot.jobId !== snapshot.candidate.jobId) issue('Review project/job/candidate identity mismatch');
    if (!same(snapshot.coverage, reviewEvidenceCoverage(snapshot)) || !same(snapshot.limitations, reviewEvidenceLimitations(snapshot))) issue('Coverage and limitations must retain all captured gaps');
    for (const rows of [snapshot.evidence, snapshot.confirmations, snapshot.resolutions, snapshot.providerAttempts]) {
      if (new Set(rows.map(row => row.id)).size !== rows.length) issue('Duplicate evidence/context record');
      if (rows.some(row => row.projectId !== snapshot.projectId || row.jobId !== snapshot.jobId)) issue('Evidence/context belongs to another project/job');
    }
    const input = snapshot.job.input.targetInput;
    const eligible = new Set(input.eligibleCatalogEntryIds);
    const mappings = new Map(input.mappings.map(row => [row.id, row]));
    const confirmations = new Map(snapshot.confirmations.map(row => [row.id, row]));
    const evidence = new Map(snapshot.evidence.map(row => [row.id, row]));
    const providers = new Map(snapshot.providerAttempts.map(row => [row.id, row]));
    for (const id of snapshot.candidate.content.evidenceIds) if (!evidence.has(id)) issue('Candidate evidence is absent from snapshot');
    for (const confirmation of snapshot.confirmations) {
      const anchor = snapshot.job.input.request.profiles.flatMap(profile => profile.anchors).find(row => row.id === confirmation.anchorId);
      if (!anchor || (anchor.confirmedEntityId && anchor.confirmedEntityId !== confirmation.entityId)) issue('Anchor confirmation is not pinned job context');
      if (confirmation.resolutionId !== null) {
        const resolution = snapshot.resolutions.find(row => row.id === confirmation.resolutionId);
        if (!resolution || resolution.anchorId !== confirmation.anchorId || !resolution.candidates.some(row => row.entityId === confirmation.entityId)) issue('Anchor confirmation is not supported by its resolution');
      }
    }
    for (const resolution of snapshot.resolutions) {
      const row = evidence.get(resolution.evidenceId);
      if (!row || row.data.kind !== 'resolve' || row.data.anchorId !== resolution.anchorId || !same(row.data.candidates, resolution.candidates)) issue('Resolution evidence mismatch');
    }
    for (const row of snapshot.evidence) {
      if (row.attemptId !== null) {
        const provider = providers.get(row.attemptId);
        const errorEvidence = (row.data.kind === 'rank' || row.data.kind === 'resolve') && row.data.providerStatus === 'error';
        if (!provider || (provider.status !== 'accepted' && !(errorEvidence && provider.status === 'error'))
          || provider.kind !== (row.data.kind === 'model_decision' ? 'model' : 'qloo')) issue('Evidence provider attempt is absent or has incompatible status/kind');
      }
      if (row.data.kind === 'rank') {
        const rank = row.data;
        if (rank.requestedEntryIds.some(id => !eligible.has(id)) || rank.unmappedEntryIds.some(id => !eligible.has(id))) issue('Rank IDs are outside pinned eligibility');
        const mappedEligible = input.eligibleCatalogEntryIds.filter(id => input.mappings.some(mapping => mapping.catalogEntryId === id));
        if ((rank.scope === 'full' && !sameIds(rank.requestedEntryIds, mappedEligible))
          || !sameIds(rank.unmappedEntryIds, input.eligibleCatalogEntryIds.filter(id => !mappedEligible.includes(id)))) issue('Rank coverage must retain the complete pinned mapping boundary');
        if (!sameIds(rank.mappingConfirmationIds.map(id => mappings.get(id)?.catalogEntryId ?? ''), rank.requestedEntryIds)) issue('Rank mapping references do not match requested IDs');
        if (rank.unmappedEntryIds.some(id => input.mappings.some(mapping => mapping.catalogEntryId === id))) issue('Confirmed mapping cannot be labelled unmapped');
        const profile = snapshot.job.input.request.profiles.find(profile => profile.id === rank.profileId);
        if (rank.anchorConfirmationIds.some(id => !profile?.anchors.some(anchor => anchor.id === confirmations.get(id)?.anchorId))) issue('Rank anchor references are outside its profile');
        if (!sameIds(rank.anchorConfirmationIds.map(id => confirmations.get(id)?.anchorId ?? ''), profile?.anchors.map(anchor => anchor.id) ?? [])) issue('Rank must pin every confirmed profile anchor');
      }
      if (row.data.kind === 'facts') {
        const [a, b] = row.data.rankingEvidenceIds.map(id => evidence.get(id)?.data);
        if (a?.kind !== 'rank' || b?.kind !== 'rank') issue('Computed facts lack their pinned rankings');
        else {
          try { if (!same(discovery.computeDiscoveryFacts(snapshot.jobId, row.data.rankingEvidenceIds, a, b), row.data)) issue('Computed facts do not match pinned ranking evidence'); }
          catch { issue('Computed facts cannot be supported by pinned rankings'); }
        }
      }
    }
    const facts = snapshot.evidence.find(row => row.data.kind === 'facts' && row.data.contrasts.some(contrast => contrast.id === snapshot.candidate.content.contrast.id));
    if (!facts || facts.data.kind !== 'facts') issue('Candidate has no computed contrast evidence');
    else {
      try { discovery.validateDiscoveryCandidate(snapshot.candidate.content, snapshot.job.input, facts.data); }
      catch { issue('Candidate context does not match pinned job/facts'); }
    }
    if (new Set(snapshot.targets.map(row => row.attempt.id)).size !== snapshot.targets.length) issue('Duplicate target attempt');
    for (const id of snapshot.candidate.content.targetAttemptIds) if (!snapshot.targets.some(row => row.attempt.id === id)) issue('Candidate target association is absent');
    for (const { association, attempt } of snapshot.targets) {
      if (association.attemptId !== attempt.id || association.status !== attempt.status || attempt.projectId !== snapshot.projectId) issue('Target association identity/status mismatch');
      const target = foundation.targetInputSchema.parse(attempt.input);
      if (attempt.id !== discovery.discoveryAttemptId(snapshot.jobId, `target:${association.profileId}:${association.round}:${association.repeat}:${association.variant}`, 0)
        || target.task.id !== discovery.discoveryAttemptId(snapshot.jobId, `task:${association.profileId}:${association.variant}`, 0)) issue('Target attempt/task must belong to this job/profile/variant');
      if (!same(target.catalog, input.catalog) || !same(target.mappings, input.mappings)
        || !same(target.eligibleCatalogEntryIds, input.eligibleCatalogEntryIds) || !same(target.task.constraints, input.task.constraints)) issue('Target context must preserve catalog, mappings, eligibility and constraints');
      if (association.variant === 'full' && !same(target.task.syntheticBrief, snapshot.candidate.content.briefs[association.profileId])) issue('Full target brief does not match candidate profile');
      if (association.repeat >= snapshot.job.input.request.repeatCount) issue('Target repeat is outside pinned repeat count');
    }
  });
  type PinnedEvidence = z.infer<typeof PinnedReviewEvidenceSchema>;
  function pinReviewEvidence(value: z.input<typeof PinnedReviewEvidenceSourceSchema>): PinnedEvidence {
    const source = PinnedReviewEvidenceSourceSchema.parse(value);
    const content = { ...source, coverage: reviewEvidenceCoverage(source), limitations: reviewEvidenceLimitations(source) };
    return PinnedReviewEvidenceSchema.parse({ ...content, checksum: checksum(content) });
  }
  function validatePinnedReviewEvidence(value: unknown, reviewCase: ReviewCase): PinnedEvidence {
    const snapshot = PinnedReviewEvidenceSchema.parse(value);
    const row = ReviewCaseSchema.parse(reviewCase);
    if (row.projectId !== snapshot.projectId || row.jobId !== snapshot.jobId || row.candidateId !== snapshot.candidate.id || row.candidateChecksum !== snapshot.candidate.checksum) {
      throw new TypeError('Pinned review evidence does not match the persisted case');
    }
    return snapshot;
  }
  function validateApprovedExpectation(value: unknown, snapshot: PinnedEvidence): ApprovedExpectation {
    const expectation = ApprovedExpectationSchema.parse(value);
    const input = snapshot.job.input.targetInput;
    const eligible = new Set(input.eligibleCatalogEntryIds);
    const catalog = new Set(input.catalog.entries.map(row => row.id));
    if (expectation.classification === 'advisory' && expectation.contrastId !== snapshot.candidate.content.contrast.id) throw new TypeError('Advisory expectation must pin original contrast');
    if (expectation.classification === 'objective_contract') for (const rule of expectation.rules) {
      if (rule.kind === 'allowed_ids' && !sameIds(rule.entryIds, input.eligibleCatalogEntryIds)) throw new TypeError('Objective allowed IDs must equal pinned eligibility, not a taste policy');
      if (rule.kind === 'exclusions' && rule.entryIds.some(id => !input.task.constraints.excludedEntryIds.includes(id))) throw new TypeError('Objective exclusions must be explicit pinned constraints');
    }
    if (expectation.classification === 'approved_policy') for (const rule of expectation.rules) {
      const ids = rule.kind === 'order' ? [rule.beforeEntryId, rule.afterEntryId] : rule.entryIds;
      if (ids.some(id => !catalog.has(id) || (rule.kind !== 'avoid' && !eligible.has(id)))) throw new TypeError('Policy IDs must be scoped to pinned catalog/eligible recommendations');
    }
    return expectation;
  }
  const ExpectationVersionSchema = z.strictObject({
    schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema, caseId: IdSchema, jobId: IdSchema,
    candidateId: IdSchema, candidateChecksum: ChecksumSchema, reviewDecisionId: IdSchema, reviewRevision: revision.min(1),
    expectation: ApprovedExpectationSchema, evidenceChecksum: ChecksumSchema, createdAt: TimestampSchema, checksum: ChecksumSchema,
  }).refine(row => checksum(withoutChecksum(row)) === row.checksum, 'Expectation version checksum mismatch');
  const ReviewDecisionSchema = z.strictObject({
    schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema, caseId: IdSchema, jobId: IdSchema, candidateId: IdSchema, candidateChecksum: ChecksumSchema,
    action: z.enum(['accept', 'edit', 'reject', 'defer']), rationale, expectedRevision: revision, revision: revision.min(1),
    requestChecksum: ChecksumSchema, reviewedBy: IdSchema, createdAt: TimestampSchema,
    evidence: PinnedReviewEvidenceSchema, approvedExpectationVersionId: IdSchema.nullable(), checksum: ChecksumSchema,
  }).superRefine((row, ctx) => {
    if (checksum(withoutChecksum(row)) !== row.checksum) ctx.addIssue({ code: 'custom', message: 'Review receipt checksum mismatch' });
    if (row.revision !== row.expectedRevision + 1) ctx.addIssue({ code: 'custom', message: 'Review revision must advance exactly once' });
    if ((row.action === 'accept' || row.action === 'edit') !== (row.approvedExpectationVersionId !== null)) ctx.addIssue({ code: 'custom', message: 'Reject/defer cannot insert an approval' });
    if (row.projectId !== row.evidence.projectId || row.jobId !== row.evidence.jobId || row.candidateId !== row.evidence.candidate.id
      || row.candidateChecksum !== row.evidence.candidate.checksum) ctx.addIssue({ code: 'custom', message: 'Review receipt evidence context mismatch' });
  });
  const ReviewRecordSchema = z.strictObject({ decision: ReviewDecisionSchema, expectationVersion: ExpectationVersionSchema.nullable() }).superRefine((record, ctx) => {
    const { decision, expectationVersion: version } = record;
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if ((version?.id ?? null) !== decision.approvedExpectationVersionId) issue('Receipt must pin exactly its approved expectation version');
    if (version) {
      if (version.projectId !== decision.projectId || version.caseId !== decision.caseId || version.jobId !== decision.jobId
        || version.candidateId !== decision.candidateId || version.candidateChecksum !== decision.candidateChecksum
        || version.reviewDecisionId !== decision.id || version.reviewRevision !== decision.revision
        || version.evidenceChecksum !== decision.evidence.checksum || version.createdAt !== decision.createdAt
        || version.id !== discovery.discoveryAttemptId(decision.id, 'approved-expectation', 0)) issue('Expectation version/receipt provenance mismatch');
      try { validateApprovedExpectation(version.expectation, decision.evidence); } catch { issue('Expectation is unsupported by pinned context'); }
      if (decision.action === 'accept' && !same(version.expectation, decision.evidence.candidate.content.proposedExpectation)) issue('Accept must preserve the original advisory proposal; use edit for a human policy');
    }
    const request = { schema_version: decision.schema_version, id: decision.id, expectedRevision: decision.expectedRevision, rationale: decision.rationale, action: decision.action,
      ...(decision.action === 'edit' && version ? { expectation: version.expectation } : {}) };
    const parsed = ReviewDecisionRequestSchema.safeParse(request);
    if (!parsed.success || checksum(parsed.data) !== decision.requestChecksum) issue('Review request checksum does not match receipt');
  });
  type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
  function assertCaseHead(row: ReviewCase, head: ReviewHead) {
    if (head.caseId !== row.id || head.projectId !== row.projectId || head.jobId !== row.jobId || head.candidateId !== row.candidateId) throw new TypeError('Review head/case context mismatch');
  }
  function validateReviewRetry(value: unknown, recordValue: unknown, reviewCase: ReviewCase): ReviewRecord {
    const request = ReviewDecisionRequestSchema.parse(value); const record = ReviewRecordSchema.parse(recordValue);
    if (record.decision.caseId !== reviewCase.id) throw new ReviewConflictError('Review request ID belongs to another case');
    validatePinnedReviewEvidence(record.decision.evidence, reviewCase);
    if (request.id !== record.decision.id || checksum(request) !== record.decision.requestChecksum) throw new ReviewConflictError('Review request ID already has different immutable content');
    return record;
  }
  function prepareReviewDecision(args: { request: ReviewDecisionRequest; reviewCase: ReviewCase; head: ReviewHead; evidence: PinnedEvidence; ownerId: string; createdAt: string }) {
    const request = ReviewDecisionRequestSchema.parse(args.request); const row = ReviewCaseSchema.parse(args.reviewCase); const oldHead = ReviewHeadSchema.parse(args.head);
    assertCaseHead(row, oldHead);
    if (request.expectedRevision !== oldHead.revision) throw new ReviewConflictError('Review changed; reload the current revision before saving');
    const evidence = validatePinnedReviewEvidence(args.evidence, row);
    const expectation = request.action === 'accept' ? evidence.candidate.content.proposedExpectation : request.action === 'edit' ? validateApprovedExpectation(request.expectation, evidence) : null;
    const versionId = expectation === null ? null : discovery.discoveryAttemptId(request.id, 'approved-expectation', 0);
    const decisionContent = { schema_version: request.schema_version, id: request.id, projectId: row.projectId, caseId: row.id, jobId: row.jobId,
      candidateId: row.candidateId, candidateChecksum: row.candidateChecksum, action: request.action, rationale: request.rationale,
      expectedRevision: request.expectedRevision, revision: oldHead.revision + 1, requestChecksum: checksum(request), reviewedBy: IdSchema.parse(args.ownerId),
      createdAt: TimestampSchema.parse(args.createdAt), evidence, approvedExpectationVersionId: versionId };
    const versionContent = expectation === null || versionId === null ? null : { schema_version: request.schema_version, id: versionId,
      projectId: row.projectId, caseId: row.id, jobId: row.jobId, candidateId: row.candidateId, candidateChecksum: row.candidateChecksum,
      reviewDecisionId: request.id, reviewRevision: decisionContent.revision, expectation, evidenceChecksum: evidence.checksum, createdAt: decisionContent.createdAt };
    const record = ReviewRecordSchema.parse({ decision: { ...decisionContent, checksum: checksum(decisionContent) },
      expectationVersion: versionContent === null ? null : { ...versionContent, checksum: checksum(versionContent) } });
    const head = ReviewHeadSchema.parse({ ...oldHead, revision: decisionContent.revision,
      status: ({ accept: 'accepted', edit: 'edited', reject: 'rejected', defer: 'deferred' } as const)[request.action],
      lastDecisionId: request.id, approvedExpectationVersionId: versionId });
    return { head, record };
  }
  const ReviewCaseResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, case: ReviewCaseSchema, head: ReviewHeadSchema,
    candidate: DiscoveryCandidateSchema, currentReview: ReviewRecordSchema.nullable() }).superRefine((response, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    try { assertCaseHead(response.case, response.head); } catch { issue('Case/head context mismatch'); }
    if (response.candidate.id !== response.case.candidateId || response.candidate.checksum !== response.case.candidateChecksum
      || response.candidate.projectId !== response.case.projectId || response.candidate.jobId !== response.case.jobId) issue('Case candidate context mismatch');
    if ((response.currentReview?.decision.id ?? null) !== response.head.lastDecisionId) issue('Current review must match head');
    if (response.currentReview) {
      try { validatePinnedReviewEvidence(response.currentReview.decision.evidence, response.case); } catch { issue('Current review belongs to another candidate context'); }
    }
    if (response.currentReview && (response.currentReview.decision.caseId !== response.case.id
      || response.currentReview.decision.projectId !== response.case.projectId || response.currentReview.decision.revision !== response.head.revision
      || response.currentReview.decision.approvedExpectationVersionId !== response.head.approvedExpectationVersionId
      || response.head.status !== ({ accept: 'accepted', edit: 'edited', reject: 'rejected', defer: 'deferred' } as const)[response.currentReview.decision.action])) issue('Current review revision/status mismatch');
  });
  const ReviewCaseListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, cases: z.array(ReviewCaseResponseSchema).max(REVIEW_LIMITS.window) });
  const ReviewHistoryResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, reviews: z.array(ReviewRecordSchema).max(REVIEW_LIMITS.window) });
  const ReviewDecisionResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, head: ReviewHeadSchema, review: ReviewRecordSchema, idempotent: z.boolean() }).superRefine((response, ctx) => {
    const { head, review: { decision }, idempotent } = response;
    if (head.projectId !== decision.projectId || head.caseId !== decision.caseId || head.jobId !== decision.jobId || head.candidateId !== decision.candidateId
      || head.revision < decision.revision || (!idempotent && (head.revision !== decision.revision || head.lastDecisionId !== decision.id
        || head.approvedExpectationVersionId !== decision.approvedExpectationVersionId))) ctx.addIssue({ code: 'custom', message: 'Response head/receipt context or revision mismatch' });
  });
  const SuiteCaseSnapshotSchema = z.strictObject({ case: ReviewCaseSchema, review: ReviewRecordSchema }).superRefine((row, ctx) => {
    if (!row.review.expectationVersion) ctx.addIssue({ code: 'custom', message: 'Suite case requires an immutable approval' });
    if (row.case.id !== row.review.decision.caseId) ctx.addIssue({ code: 'custom', message: 'Suite receipt belongs to another case' });
    try { validatePinnedReviewEvidence(row.review.decision.evidence, row.case); } catch { ctx.addIssue({ code: 'custom', message: 'Suite case/evidence context mismatch' }); }
  });
  const SuiteVersionSchema = z.strictObject({
    schema_version: SchemaVersionSchema, id: IdSchema, suiteId: IdSchema, projectId: IdSchema, expectedVersion: revision, version: revision.min(1),
    requestChecksum: ChecksumSchema, publishedBy: IdSchema, createdAt: TimestampSchema,
    cases: z.array(SuiteCaseSnapshotSchema).min(1).max(REVIEW_LIMITS.suiteCases), checksum: ChecksumSchema,
  }).superRefine((snapshot, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (!bounded(snapshot, REVIEW_LIMITS.suiteBytes)) issue('Suite snapshot exceeds byte limit');
    if (checksum(withoutChecksum(snapshot)) !== snapshot.checksum) issue('Suite snapshot checksum mismatch');
    if (snapshot.version !== snapshot.expectedVersion + 1) issue('Suite version must advance exactly once');
    if (snapshot.cases.some(row => row.case.projectId !== snapshot.projectId)) issue('Suite cases belong to another project');
    const request = PublishSuiteRequestSchema.safeParse({ schema_version: snapshot.schema_version, id: snapshot.id, suiteId: snapshot.suiteId,
      expectedVersion: snapshot.expectedVersion, cases: snapshot.cases.map(row => ({ caseId: row.case.id,
        expectationVersionId: row.review.expectationVersion?.id, expectedReviewRevision: row.review.decision.revision })) });
    if (!request.success || checksum(request.data) !== snapshot.requestChecksum) issue('Suite selection/checksum mismatch');
  });
  type SuiteVersion = z.infer<typeof SuiteVersionSchema>;
  type SuiteCase = z.infer<typeof SuiteCaseSnapshotSchema>;
  /** Call only inside the publication transaction after locking the suite and every selected head.
   * The complete selection is checked before any insert; historical reads use SuiteVersionSchema only.
   */
  function selectSuiteCases(value: unknown, projectId: string, selections: { case: ReviewCase; head: ReviewHead; review: ReviewRecord }[]): SuiteCase[] {
    const request = PublishSuiteRequestSchema.parse(value);
    IdSchema.parse(projectId);
    if (selections.length !== request.cases.length) throw new TypeError('Resolve exactly the complete publication selection');
    return request.cases.map(selection => {
      const resolved = selections.find(row => row.case.id === selection.caseId);
      if (!resolved) throw new TypeError('Selected case was not resolved');
      const row = ReviewCaseSchema.parse(resolved.case); const head = ReviewHeadSchema.parse(resolved.head); const review = ReviewRecordSchema.parse(resolved.review);
      assertCaseHead(row, head);
      if (row.projectId !== projectId) throw new TypeError('Publication case belongs to another project');
      if (head.revision !== selection.expectedReviewRevision || head.approvedExpectationVersionId !== selection.expectationVersionId
        || head.lastDecisionId !== review.decision.id || review.decision.revision !== head.revision
        || head.status !== ({ accept: 'accepted', edit: 'edited', reject: 'rejected', defer: 'deferred' } as const)[review.decision.action]
        || !['accepted', 'edited'].includes(head.status) || review.expectationVersion?.id !== selection.expectationVersionId) {
        throw new ReviewConflictError('Selected expectation is stale, unreviewed, rejected, deferred or superseded');
      }
      return SuiteCaseSnapshotSchema.parse({ case: row, review });
    });
  }
  function prepareSuitePublication(args: { request: PublishSuiteRequest; suite: SuiteIdentity; selections: { case: ReviewCase; head: ReviewHead; review: ReviewRecord }[]; ownerId: string; createdAt: string }): SuiteVersion {
    const request = PublishSuiteRequestSchema.parse(args.request); const suite = SuiteIdentitySchema.parse(args.suite);
    if (request.suiteId !== suite.id) throw new TypeError('Publication suite identity mismatch');
    if (request.expectedVersion !== suite.currentVersion) throw new ReviewConflictError('Suite changed; reload its current version before publishing');
    const cases = selectSuiteCases(request, suite.projectId, args.selections);
    const content = { schema_version: request.schema_version, id: request.id, suiteId: suite.id, projectId: suite.projectId,
      expectedVersion: request.expectedVersion, version: suite.currentVersion + 1, requestChecksum: checksum(request),
      publishedBy: IdSchema.parse(args.ownerId), createdAt: TimestampSchema.parse(args.createdAt), cases };
    return SuiteVersionSchema.parse({ ...content, checksum: checksum(content) });
  }
  function validatePublicationRetry(value: unknown, snapshotValue: unknown, suite: SuiteIdentity): SuiteVersion {
    const request = PublishSuiteRequestSchema.parse(value); const snapshot = SuiteVersionSchema.parse(snapshotValue);
    if (snapshot.projectId !== suite.projectId || snapshot.suiteId !== suite.id) throw new ReviewConflictError('Publication ID belongs to another project/suite');
    if (request.id !== snapshot.id || checksum(request) !== snapshot.requestChecksum) throw new ReviewConflictError('Publication ID already has different immutable content');
    return snapshot;
  }
  const SuiteVersionListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, versions: z.array(SuiteVersionSchema).max(REVIEW_LIMITS.window) });
  const PublishSuiteResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, suite: SuiteVersionSchema, idempotent: z.boolean() });
  return { ObjectiveContractRuleSchema, ApprovedPolicyRuleSchema, ApprovedExpectationSchema, ReviewExpectationSchema,
    ReviewDecisionRequestSchema, CreateReviewCaseRequestSchema, ReviewCaseSchema, ReviewHeadSchema, ReviewWindowRequestSchema,
    PublishSuiteCaseSelectionSchema, PublishSuiteRequestSchema, CreateSuiteRequestSchema, SuiteIdentitySchema, SuiteListResponseSchema, prepareReviewCase,
    PinnedReviewTargetSchema, ReviewEvidenceCoverageSchema, PinnedReviewEvidenceSourceSchema, PinnedReviewEvidenceSchema,
    ExpectationVersionSchema, ReviewDecisionSchema, ReviewRecordSchema, ReviewCaseResponseSchema, ReviewCaseListResponseSchema,
    ReviewHistoryResponseSchema, ReviewDecisionResponseSchema, SuiteCaseSnapshotSchema, SuiteVersionSchema, SuiteVersionListResponseSchema, PublishSuiteResponseSchema,
    pinReviewEvidence, validatePinnedReviewEvidence, validateApprovedExpectation, reviewEvidenceCoverage, reviewEvidenceLimitations,
    validateReviewRetry, prepareReviewDecision, selectSuiteCases, prepareSuitePublication, validatePublicationRetry };
}
export type ReviewContracts = ReturnType<typeof createReviewContracts>;
export type ApprovedExpectation = z.infer<ReviewContracts['ApprovedExpectationSchema']>;
export type ReviewExpectation = z.infer<ReviewContracts['ReviewExpectationSchema']>;
export type ObjectiveContractRule = z.infer<ReviewContracts['ObjectiveContractRuleSchema']>;
export type ApprovedPolicyRule = z.infer<ReviewContracts['ApprovedPolicyRuleSchema']>;
export type ReviewDecisionRequest = z.infer<ReviewContracts['ReviewDecisionRequestSchema']>;
export type CreateReviewCaseRequest = z.infer<ReviewContracts['CreateReviewCaseRequestSchema']>;
export type ReviewCase = z.infer<ReviewContracts['ReviewCaseSchema']>;
export type ReviewHead = z.infer<ReviewContracts['ReviewHeadSchema']>;
export type ReviewWindowRequest = z.infer<ReviewContracts['ReviewWindowRequestSchema']>;
export type PublishSuiteRequest = z.infer<ReviewContracts['PublishSuiteRequestSchema']>;
export type PublishSuiteCaseSelection = z.infer<ReviewContracts['PublishSuiteCaseSelectionSchema']>;
export type CreateSuiteRequest = z.infer<ReviewContracts['CreateSuiteRequestSchema']>;
export type SuiteIdentity = z.infer<ReviewContracts['SuiteIdentitySchema']>;
export type SuiteListResponse = z.infer<ReviewContracts['SuiteListResponseSchema']>;
export type PinnedReviewEvidence = z.infer<ReviewContracts['PinnedReviewEvidenceSchema']>;
export type PinnedReviewEvidenceSource = z.infer<ReviewContracts['PinnedReviewEvidenceSourceSchema']>;
export type PinnedReviewTarget = z.infer<ReviewContracts['PinnedReviewTargetSchema']>;
export type ReviewEvidenceCoverage = z.infer<ReviewContracts['ReviewEvidenceCoverageSchema']>;
export type ExpectationVersion = z.infer<ReviewContracts['ExpectationVersionSchema']>;
export type ReviewDecision = z.infer<ReviewContracts['ReviewDecisionSchema']>;
export type ReviewRecord = z.infer<ReviewContracts['ReviewRecordSchema']>;
export type ReviewCaseResponse = z.infer<ReviewContracts['ReviewCaseResponseSchema']>;
export type ReviewCaseListResponse = z.infer<ReviewContracts['ReviewCaseListResponseSchema']>;
export type ReviewHistoryResponse = z.infer<ReviewContracts['ReviewHistoryResponseSchema']>;
export type ReviewDecisionResponse = z.infer<ReviewContracts['ReviewDecisionResponseSchema']>;
export type SuiteCaseSnapshot = z.infer<ReviewContracts['SuiteCaseSnapshotSchema']>;
export type SuiteVersion = z.infer<ReviewContracts['SuiteVersionSchema']>;
export type SuiteVersionListResponse = z.infer<ReviewContracts['SuiteVersionListResponseSchema']>;
export type PublishSuiteResponse = z.infer<ReviewContracts['PublishSuiteResponseSchema']>;
