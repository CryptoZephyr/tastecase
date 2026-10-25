import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CatalogEntryIdSchema, ChecksumSchema, IdSchema, SchemaVersionSchema, SyntheticTextSchema,
  TimestampSchema, PracticalConstraintsSchema,
} from './primitives.js';
import { TargetInputSchema } from './index.js';
import { canonicalJson, checksum } from './canonical.js';

const label = z.string().trim().min(1).max(160);
const explanation = z.string().trim().min(1).max(2000);
const entryIds = z.array(CatalogEntryIdSchema).max(500).refine(ids => new Set(ids).size === ids.length, 'Duplicate entry IDs');
const recordIds = z.array(IdSchema).max(20).refine(ids => new Set(ids).size === ids.length, 'Duplicate record IDs');
const mappingIds = z.array(IdSchema).max(500).refine(ids => new Set(ids).size === ids.length, 'Duplicate mapping IDs');
export const DiscoveryProfileIdSchema = z.enum(['a', 'b']);
export const PublicAnchorSchema = z.strictObject({
  id: IdSchema, label, kind: z.enum(['music', 'film', 'brand']),
  // An owner-supplied confirmation, not a provider/model candidate or catalog hint.
  confirmedEntityId: IdSchema.optional(),
});
export const DiscoveryProfileSchema = z.strictObject({
  id: DiscoveryProfileIdSchema, provenance: z.literal('public_synthetic'), label,
  anchors: z.array(PublicAnchorSchema).min(1).max(5),
});
export const DiscoveryBudgetsSchema = z.strictObject({
  qlooAttempts: z.number().int().min(1).max(20).default(8),
  modelDecisions: z.number().int().min(1).max(8).default(2),
  targetAttempts: z.number().int().min(2).max(12).default(6),
  rounds: z.number().int().min(1).max(6).default(3),
  deadlineSeconds: z.number().int().min(30).max(3600).default(900),
  outputBytes: z.number().int().min(1024).max(262144).default(64000),
  retriesPerOperation: z.number().int().min(0).max(2).default(1),
});
export const CreateDiscoveryJobRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, catalogVersionId: IdSchema, taskVersionId: IdSchema,
  mappingConfirmationIds: mappingIds, eligibleCatalogEntryIds: entryIds.min(2),
  profiles: z.tuple([DiscoveryProfileSchema, DiscoveryProfileSchema]),
  assistantVersion: label, budgets: DiscoveryBudgetsSchema.default(() => DiscoveryBudgetsSchema.parse({})),
  repeatCount: z.number().int().min(1).max(3).default(2), reducePair: z.boolean().default(true),
}).superRefine((request, ctx) => {
  if (request.profiles[0].id !== 'a' || request.profiles[1].id !== 'b') ctx.addIssue({ code: 'custom', message: 'Profiles must be ordered a, b' });
  const ids = request.profiles.flatMap(profile => profile.anchors.map(anchor => anchor.id));
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Anchor IDs must be unique across profiles' });
});
export const PinnedDiscoveryInputSchema = z.strictObject({
  schema_version: SchemaVersionSchema, request: CreateDiscoveryJobRequestSchema, targetInput: z.lazy(() => TargetInputSchema),
}).superRefine((input, ctx) => {
  const { request, targetInput } = input;
  if (request.catalogVersionId !== targetInput.catalog.id || request.taskVersionId !== targetInput.task.id
    || canonicalJson(request.eligibleCatalogEntryIds) !== canonicalJson(targetInput.eligibleCatalogEntryIds)
    || canonicalJson([...request.mappingConfirmationIds].sort()) !== canonicalJson(targetInput.mappings.map(mapping => mapping.id).sort())) {
    ctx.addIssue({ code: 'custom', message: 'Request must match exact pinned versions, eligibility and confirmed mappings' });
  }
});
export const DiscoveryStateSchema = z.enum([
  'queued', 'resolving', 'needs_confirmation', 'ranking', 'selecting', 'running_target', 'waiting_runner',
  'investigating', 'awaiting_review', 'no_useful_contrast', 'unavailable', 'partial', 'budget_exhausted',
  'deadline_exceeded', 'cancelled', 'failed',
]);
export const DiscoveryCheckpointSchema = z.enum(['pinned', 'anchors', 'ranks', 'selection', 'targets', 'investigation', 'saved']);
export const DiscoveryCountersSchema = z.strictObject({
  qlooAttempts: z.number().int().min(0).max(20), modelDecisions: z.number().int().min(0).max(8),
  targetAttempts: z.number().int().min(0).max(12), rounds: z.number().int().min(0).max(6),
});
export const DiscoveryJobSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema, input: PinnedDiscoveryInputSchema,
  inputChecksum: ChecksumSchema, state: DiscoveryStateSchema, checkpoint: DiscoveryCheckpointSchema,
  checkpointData: z.strictObject({ evidenceIds: recordIds, candidateIds: recordIds, note: explanation.optional() }),
  counters: DiscoveryCountersSchema, revision: z.number().int().nonnegative(),
  leaseId: IdSchema.nullable(), leaseExpiresAt: TimestampSchema.nullable(),
  availableAt: TimestampSchema, deadlineAt: TimestampSchema, createdAt: TimestampSchema,
  cancelledAt: TimestampSchema.nullable(), reason: explanation.nullable(),
}).superRefine((job, ctx) => {
  if (job.id !== job.input.request.id || job.projectId !== job.input.targetInput.projectId || checksum(job.input) !== job.inputChecksum) {
    ctx.addIssue({ code: 'custom', message: 'Job identity or input checksum mismatch' });
  }
  if ((job.leaseId === null) !== (job.leaseExpiresAt === null)) ctx.addIssue({ code: 'custom', message: 'Lease identity and expiry must coexist' });
  for (const key of ['qlooAttempts', 'modelDecisions', 'targetAttempts', 'rounds'] as const) {
    if (job.counters[key] > job.input.request.budgets[key]) ctx.addIssue({ code: 'custom', message: `Exceeded ${key} budget` });
  }
});
export const DiscoveryJobListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, jobs: z.array(DiscoveryJobSchema).max(500) });
export const CancelDiscoveryJobRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema });
export const AnchorCandidateSchema = z.strictObject({ entityId: IdSchema, name: label, kind: z.enum(['music', 'film', 'brand']) });
export const AnchorResolutionSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema, jobId: IdSchema, anchorId: IdSchema,
  evidenceId: IdSchema, candidates: z.array(AnchorCandidateSchema).max(10)
    .refine(values => new Set(values.map(value => value.entityId)).size === values.length, 'Duplicate candidate IDs'),
  createdAt: TimestampSchema,
});
export const ConfirmDiscoveryAnchorRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, anchorId: IdSchema, resolutionId: IdSchema, entityId: IdSchema,
});
export const DiscoveryAnchorConfirmationSchema = ConfirmDiscoveryAnchorRequestSchema.extend({
  resolutionId: IdSchema.nullable(), projectId: IdSchema, jobId: IdSchema, confirmedBy: IdSchema, createdAt: TimestampSchema,
});
/** Literal official status vocabulary. Adapter parsing must not accept a seventh status. */
export const QlooStatusSchema = z.enum(['ok', 'empty', 'needs_input', 'partial', 'degraded', 'error']);
export const QLOO_TAG_TYPES = [
  'urn:tag:cuisine:qloo', 'urn:tag:genre:place', 'urn:tag:category:place',
  'urn:tag:ambience:qloo', 'urn:tag:culinary_style:qloo',
] as const;
export const QlooTagSchema = z.strictObject({
  type: z.enum(QLOO_TAG_TYPES), name: z.string().trim().min(1).max(80),
});
export const QlooHttpDiagnosticsSchema = z.strictObject({
  maxAttempts: z.literal(2), attempts: z.number().int().min(0).max(2), cacheHits: z.number().int().min(0).max(15),
  requests: z.array(z.strictObject({
    endpoint: z.enum(['/search', '/entities', '/v2/insights']),
    status: z.number().int().min(100).max(599).nullable(),
    retryAfterSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  })).max(2),
}).refine(value => value.attempts === value.requests.length, 'HTTP attempts must match receipts');
export type QlooHttpDiagnostics = z.infer<typeof QlooHttpDiagnosticsSchema>;
export const NormalizedQlooErrorSchema = z.strictObject({ code: label, retryable: z.boolean(), category: z.enum(['auth', 'transient', 'invalid_input', 'unavailable']) })
  .refine(error => error.category !== 'auth' || !error.retryable, 'Authentication failures cannot be retried');
export const RankingEvidenceSchema = z.strictObject({
  kind: z.literal('rank'), providerStatus: QlooStatusSchema, profileId: DiscoveryProfileIdSchema,
  scope: z.enum(['full', 'reduced_pair']), requestedEntryIds: entryIds.min(1).max(10),
  orderedEntryIds: entryIds.max(10), missingEntryIds: entryIds.max(10), unmappedEntryIds: entryIds,
  mappingConfirmationIds: recordIds, anchorConfirmationIds: recordIds,
  affinities: z.array(z.strictObject({
    entryId: CatalogEntryIdSchema, affinity: z.number().min(0).max(1),
    interests: z.array(z.strictObject({
      anchorConfirmationId: IdSchema, score: z.number().min(0).max(1),
    })).max(5),
  })).max(10).optional(),
  entryTags: z.array(z.strictObject({
    entryId: CatalogEntryIdSchema, tags: z.array(QlooTagSchema).max(12),
  })).max(10).optional(),
  error: NormalizedQlooErrorSchema.optional(),
  http: QlooHttpDiagnosticsSchema.optional(),
}).superRefine((rank, ctx) => {
  const returned = new Set(rank.orderedEntryIds); const requested = new Set(rank.requestedEntryIds);
  const anchors = new Set(rank.anchorConfirmationIds);
  if (rank.orderedEntryIds.some(id => !requested.has(id))
    || canonicalJson([...rank.missingEntryIds].sort()) !== canonicalJson(rank.requestedEntryIds.filter(id => !returned.has(id)).sort())
    || rank.unmappedEntryIds.some(id => requested.has(id))) ctx.addIssue({ code: 'custom', message: 'Rank coverage must partition requested mapped IDs' });
  if (['empty', 'needs_input', 'error'].includes(rank.providerStatus) && rank.orderedEntryIds.length) ctx.addIssue({ code: 'custom', message: 'This status cannot establish a ranking' });
  if (rank.providerStatus === 'error' && !rank.error) ctx.addIssue({ code: 'custom', message: 'Error status needs normalised error metadata' });
  if (rank.affinities) {
    const entries = new Set<string>();
    rank.affinities.forEach((affinity, index) => {
      if (entries.has(affinity.entryId) || !returned.has(affinity.entryId)) {
        ctx.addIssue({ code: 'custom', path: ['affinities', index, 'entryId'], message: 'Affinity entries must be unique ranked entries' });
      }
      entries.add(affinity.entryId);
      const interests = new Set<string>();
      affinity.interests.forEach((interest, interestIndex) => {
        if (interests.has(interest.anchorConfirmationId) || !anchors.has(interest.anchorConfirmationId)) {
          ctx.addIssue({ code: 'custom', path: ['affinities', index, 'interests', interestIndex, 'anchorConfirmationId'], message: 'Interests must use unique request anchors' });
        }
        interests.add(interest.anchorConfirmationId);
      });
    });
  }
  if (rank.entryTags) {
    const entries = new Set<string>();
    rank.entryTags.forEach((entry, index) => {
      if (entries.has(entry.entryId) || !requested.has(entry.entryId)) {
        ctx.addIssue({ code: 'custom', path: ['entryTags', index, 'entryId'], message: 'Entity tags must use unique requested entries' });
      }
      entries.add(entry.entryId);
    });
  }
});
export const ResolutionEvidenceSchema = z.strictObject({
  kind: z.literal('resolve'), providerStatus: QlooStatusSchema, anchorId: IdSchema,
  candidates: z.array(AnchorCandidateSchema).max(10).refine(values => new Set(values.map(value => value.entityId)).size === values.length, 'Duplicate candidate IDs'),
  error: NormalizedQlooErrorSchema.optional(),
  http: QlooHttpDiagnosticsSchema.optional(),
});
export const ContrastFactSchema = z.strictObject({
  id: IdSchema, entryIds: z.tuple([CatalogEntryIdSchema, CatalogEntryIdSchema]),
  orders: z.strictObject({ a: z.tuple([CatalogEntryIdSchema, CatalogEntryIdSchema]), b: z.tuple([CatalogEntryIdSchema, CatalogEntryIdSchema]) }),
}).superRefine((fact, ctx) => {
  if (fact.entryIds[0] === fact.entryIds[1] || canonicalJson([...fact.entryIds].sort()) !== canonicalJson([...fact.orders.a].sort())
    || canonicalJson([...fact.entryIds].sort()) !== canonicalJson([...fact.orders.b].sort()) || fact.orders.a[0] !== fact.orders.b[1]) {
    ctx.addIssue({ code: 'custom', message: 'Contrast must reverse exactly the same pair' });
  }
});
export const ComputedDiscoveryFactsSchema = z.strictObject({
  kind: z.literal('facts'), rankingEvidenceIds: z.tuple([IdSchema, IdSchema]),
  contrasts: z.array(ContrastFactSchema).max(45), missingEntryIds: entryIds, unmappedEntryIds: entryIds,
  unsupportedReason: z.enum(['more_than_ten_mapped_options', 'insufficient_coverage', 'provider_unavailable']).optional(),
});
export const ModelContrastDecisionSchema = z.strictObject({ kind: z.literal('model_decision'), selectedContrastId: IdSchema.nullable(), rationale: explanation });
export const NormalizedDiscoveryEvidenceSchema = z.discriminatedUnion('kind', [RankingEvidenceSchema, ResolutionEvidenceSchema, ComputedDiscoveryFactsSchema, ModelContrastDecisionSchema]);
export const DiscoveryEvidenceSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema, jobId: IdSchema,
  attemptId: IdSchema.nullable(), data: NormalizedDiscoveryEvidenceSchema, checksum: ChecksumSchema, capturedAt: TimestampSchema,
}).refine(evidence => checksum(evidence.data) === evidence.checksum, 'Evidence checksum mismatch');
export const PairedSyntheticBriefsSchema = z.strictObject({ a: SyntheticTextSchema, b: SyntheticTextSchema,
  constraints: PracticalConstraintsSchema, eligibleCatalogEntryIds: entryIds.min(2) });
export const AdvisoryExpectationSchema = z.strictObject({
  classification: z.literal('advisory'), automaticFailure: z.literal(false), humanReviewRequired: z.literal(true), contrastId: IdSchema, rationale: explanation,
});
export const DiscoveryCandidateContentSchema = z.strictObject({
  contrast: ContrastFactSchema, briefs: PairedSyntheticBriefsSchema, evidenceIds: recordIds.min(1),
  targetAttemptIds: recordIds, proposedExpectation: AdvisoryExpectationSchema, limitations: z.array(explanation).min(1).max(20),
}).refine(candidate => candidate.contrast.id === candidate.proposedExpectation.contrastId, 'Expectation must reference supported contrast');
export const DiscoveryCandidateSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema, jobId: IdSchema,
  content: DiscoveryCandidateContentSchema, checksum: ChecksumSchema, createdAt: TimestampSchema,
}).refine(candidate => checksum(candidate.content) === candidate.checksum, 'Candidate checksum mismatch');
export const DiscoveryProviderAttemptSchema = z.strictObject({
  id: IdSchema, projectId: IdSchema, jobId: IdSchema, kind: z.enum(['qloo','model']), operationKey: label,
  tryNumber: z.number().int().min(0).max(2), requestChecksum: ChecksumSchema, reservedLeaseId: IdSchema,
  status: z.enum(['reserved','dispatched','accepted','error','interrupted','uncertain']), reservedAt: TimestampSchema,
  dispatchedAt: TimestampSchema.nullable(), finishedAt: TimestampSchema.nullable(), retryable: z.boolean(),
  errorCategory: z.enum(['auth','transient','invalid_input','unavailable']).nullable(), errorCode: label.nullable(), nextDispatchAt: TimestampSchema.nullable(),
}).superRefine((attempt,ctx)=>{
  if (attempt.retryable && (attempt.status !== 'error' || attempt.errorCategory !== 'transient' || attempt.nextDispatchAt === null)) ctx.addIssue({code:'custom',message:'Only flagged transient errors may retry with persisted backoff'});
  if ((['reserved','interrupted'].includes(attempt.status)) !== (attempt.dispatchedAt === null)
    || (['reserved','dispatched'].includes(attempt.status)) !== (attempt.finishedAt === null)) ctx.addIssue({code:'custom',message:'Dispatch lifecycle timestamps must match explicit outcome'});
});
export const DiscoveryTargetAssociationSchema = z.strictObject({ attemptId: IdSchema, profileId: DiscoveryProfileIdSchema, round: z.number().int().min(0).max(5),
  repeat: z.number().int().min(0).max(2), variant: z.enum(['full', 'reduced_pair']), status: z.enum(['queued', 'leased', 'completed']),
  dispatchCount: z.number().int().min(0).max(12), cancelled: z.boolean(), uncertainDispatches: z.number().int().min(0).max(12),
});
export const DiscoveryJobDetailResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema, job: DiscoveryJobSchema, resolutions: z.array(AnchorResolutionSchema).max(20),
  confirmations: z.array(DiscoveryAnchorConfirmationSchema).max(10), evidence: z.array(DiscoveryEvidenceSchema).max(50), candidates: z.array(DiscoveryCandidateSchema).max(6),
  attempts: z.array(DiscoveryTargetAssociationSchema).max(12), providerAttempts: z.array(DiscoveryProviderAttemptSchema).max(28),
});
export type CreateDiscoveryJobRequest = z.infer<typeof CreateDiscoveryJobRequestSchema>;
export type PinnedDiscoveryInput = z.infer<typeof PinnedDiscoveryInputSchema>;
export type DiscoveryJob = z.infer<typeof DiscoveryJobSchema>;
export type DiscoveryState = z.infer<typeof DiscoveryStateSchema>;
export type RankingEvidence = z.infer<typeof RankingEvidenceSchema>;
export type ComputedDiscoveryFacts = z.infer<typeof ComputedDiscoveryFactsSchema>;
export type ModelContrastDecision = z.infer<typeof ModelContrastDecisionSchema>;
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;
export type NormalizedDiscoveryEvidence = z.infer<typeof NormalizedDiscoveryEvidenceSchema>;
export type DiscoveryProviderAttempt = z.infer<typeof DiscoveryProviderAttemptSchema>;
export type DiscoveryTargetAssociation = z.infer<typeof DiscoveryTargetAssociationSchema>;

/** Stable UUID-shaped operation identity, not an exactly-once dispatch guarantee. */
export function discoveryAttemptId(jobId: string, operation: string, ordinal: number): string {
  IdSchema.parse(jobId);
  if (!operation.length || operation.length > 160 || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError('Invalid operation identity');
  const hex = createHash('sha256').update(canonicalJson(['tastecase-discovery-v1', jobId.toLowerCase(), operation, ordinal])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Compute within-query reversals without combining scores or treating missing IDs as disliked. */
export function computeDiscoveryFacts(jobId: string, evidenceIds: [string, string], a: RankingEvidence, b: RankingEvidence): ComputedDiscoveryFacts {
  RankingEvidenceSchema.parse(a); RankingEvidenceSchema.parse(b);
  if (a.profileId !== 'a' || b.profileId !== 'b' || a.scope !== 'full' || b.scope !== 'full'
    || canonicalJson(a.requestedEntryIds) !== canonicalJson(b.requestedEntryIds)
    || canonicalJson(a.unmappedEntryIds) !== canonicalJson(b.unmappedEntryIds)) throw new TypeError('Full rankings must use the same fixed mapped catalog');
  const contrasts: z.infer<typeof ContrastFactSchema>[] = [];
  if ([a, b].every(rank => ['ok', 'partial'].includes(rank.providerStatus))) {
    for (let i = 0; i < a.orderedEntryIds.length; i++) for (let j = i + 1; j < a.orderedEntryIds.length; j++) {
      const first = a.orderedEntryIds[i]; const second = a.orderedEntryIds[j];
      if (first === undefined || second === undefined) continue;
      const bi = b.orderedEntryIds.indexOf(first); const bj = b.orderedEntryIds.indexOf(second);
      if (bi < 0 || bj < 0 || bi < bj) continue;
      contrasts.push({ id: discoveryAttemptId(jobId, `contrast:${checksum([first, second])}`, 0), entryIds: [first, second], orders: { a: [first, second], b: [second, first] } });
    }
  }
  return ComputedDiscoveryFactsSchema.parse({ kind: 'facts', rankingEvidenceIds: evidenceIds, contrasts,
    missingEntryIds: [...new Set([...a.missingEntryIds, ...b.missingEntryIds])], unmappedEntryIds: a.unmappedEntryIds,
    ...([a, b].some(rank => !['ok', 'partial'].includes(rank.providerStatus)) ? { unsupportedReason: 'provider_unavailable' } : {}),
  });
}
export function validateModelContrastDecision(value: unknown, facts: ComputedDiscoveryFacts): ModelContrastDecision {
  const decision = ModelContrastDecisionSchema.parse(value);
  if (decision.selectedContrastId !== null && !facts.contrasts.some(contrast => contrast.id === decision.selectedContrastId)) throw new TypeError('Model selected an unsupported contrast');
  return decision;
}
/** Full repeats and reduction retain all practical constraints and the target's eligible catalog. */
export function validateDiscoveryCandidate(content: unknown, input: PinnedDiscoveryInput, facts: ComputedDiscoveryFacts) {
  const candidate = DiscoveryCandidateContentSchema.parse(content);
  const supported = facts.contrasts.find(contrast => contrast.id === candidate.contrast.id);
  if (!supported || canonicalJson(supported) !== canonicalJson(candidate.contrast)) throw new TypeError('Candidate must reference a computed contrast');
  if (canonicalJson(candidate.briefs.constraints) !== canonicalJson(input.targetInput.task.constraints)
    || canonicalJson(candidate.briefs.eligibleCatalogEntryIds) !== canonicalJson(input.targetInput.eligibleCatalogEntryIds)) throw new TypeError('Practical constraints and eligible catalog must remain fixed');
  return candidate;
}
