import { z } from 'zod';
import type * as Foundation from './index.js';
import type * as Discovery from './discovery.js';
import { SchemaVersionSchema, TimestampSchema } from './primitives.js';

/** Public display projections, NOT owner records or replay/export artifacts. Checksums are
 * original source checksums; omitted private fields mean they do not hash the public DTO.
 * Never fill omitted fields with invented values or run these through owner-record validators. */
function buildPublicSampleContracts(f: Pick<typeof Foundation,
  'TargetInputSchema' | 'MappingConfirmationSchema' | 'TargetResultSchema' | 'AttemptSchema' | 'ReviewDecisionSchema'
  | 'ReviewCaseSchema' | 'ReviewHeadSchema' | 'ExpectationVersionSchema'>, d: typeof Discovery) {
  const PublicTargetInputSchema = z.strictObject({ ...f.TargetInputSchema.shape,
    mappings: z.array(f.MappingConfirmationSchema.omit({ confirmedBy: true })).max(500),
  });
  const PublicTargetResultSchema = z.discriminatedUnion('outcome', [
    f.TargetResultSchema.options[0],
    f.TargetResultSchema.options[1].omit({ rawText: true, error: true }),
    f.TargetResultSchema.options[2].omit({ error: true }),
  ]);
  const attempt = z.strictObject(f.AttemptSchema.shape).omit({ leaseId: true, leaseCredentialId: true, leaseExpiresAt: true }).shape;
  const PublicAttemptSchema = z.strictObject({ ...attempt, input: PublicTargetInputSchema, result: PublicTargetResultSchema.nullable() });
  const job = z.strictObject(d.DiscoveryJobSchema.shape).omit({ leaseId: true, leaseExpiresAt: true, reason: true }).shape;
  const PublicDiscoveryJobSchema = z.strictObject({ ...job,
    input: z.strictObject({ ...d.PinnedDiscoveryInputSchema.shape, targetInput: PublicTargetInputSchema }),
    checkpointData: z.strictObject({ evidenceIds: job.checkpointData.shape.evidenceIds, candidateIds: job.checkpointData.shape.candidateIds }),
  });
  // Provider errors are deliberately not included, even if a provider called them normalised.
  const PublicEvidenceSchema = z.strictObject({ ...d.DiscoveryEvidenceSchema.shape,
    data: z.discriminatedUnion('kind', [
      z.strictObject(d.RankingEvidenceSchema.shape).omit({ error: true }),
      d.ResolutionEvidenceSchema.omit({ error: true }), d.ComputedDiscoveryFactsSchema, d.ModelContrastDecisionSchema,
    ]),
  });
  const PublicProviderAttemptSchema = z.strictObject({
    id: d.DiscoveryProviderAttemptSchema.shape.id, kind: d.DiscoveryProviderAttemptSchema.shape.kind,
    status: d.DiscoveryProviderAttemptSchema.shape.status, reservedAt: TimestampSchema,
    dispatchedAt: TimestampSchema.nullable(), finishedAt: TimestampSchema.nullable(),
    retryable: z.boolean(), errorCategory: d.DiscoveryProviderAttemptSchema.shape.errorCategory,
  });
  const decision = z.strictObject(f.ReviewDecisionSchema.shape).omit({ reviewedBy: true, evidence: true, requestChecksum: true }).shape;
  const PublicCaseResponseSchema = z.strictObject({
    schema_version: SchemaVersionSchema, case: f.ReviewCaseSchema, head: f.ReviewHeadSchema,
    candidate: d.DiscoveryCandidateSchema,
    currentReview: z.strictObject({ decision: z.strictObject(decision), expectationVersion: f.ExpectationVersionSchema.nullable() }).nullable(),
  });
  const PublicDiscoveryDetailSchema = z.strictObject({
    schema_version: SchemaVersionSchema, job: PublicDiscoveryJobSchema,
    resolutions: z.array(d.AnchorResolutionSchema).max(20),
    confirmations: z.array(d.DiscoveryAnchorConfirmationSchema.omit({ confirmedBy: true })).max(10),
    evidence: z.array(PublicEvidenceSchema).max(50), candidates: z.array(d.DiscoveryCandidateSchema).max(1),
    attempts: z.array(d.DiscoveryTargetAssociationSchema).max(12), providerAttempts: z.array(PublicProviderAttemptSchema).max(28),
  });
  const PublicSampleSchema = z.strictObject({
    schema_version: SchemaVersionSchema, provenance: z.literal('recorded'), inputs: z.literal('synthetic'),
    capturedAt: TimestampSchema, caseResponse: PublicCaseResponseSchema, job: PublicDiscoveryDetailSchema,
    attempts: z.array(PublicAttemptSchema).max(12),
  });
  return { PublicSampleSchema, PublicCaseResponseSchema, PublicDiscoveryDetailSchema, PublicAttemptSchema };
}
// Direct discovery-module imports evaluate the foundation before discovery's bindings.
// Defer all schema dereferences until parsing, as the review/comparison contracts do.
export function createPublicSampleContracts(...args: Parameters<typeof buildPublicSampleContracts>) {
  let cached: ReturnType<typeof buildPublicSampleContracts> | undefined;
  const schemas = () => cached ??= buildPublicSampleContracts(...args);
  return {
    PublicSampleSchema: z.lazy(() => schemas().PublicSampleSchema),
    PublicCaseResponseSchema: z.lazy(() => schemas().PublicCaseResponseSchema),
    PublicDiscoveryDetailSchema: z.lazy(() => schemas().PublicDiscoveryDetailSchema),
    PublicAttemptSchema: z.lazy(() => schemas().PublicAttemptSchema),
  };
}
export type PublicSample = z.infer<ReturnType<typeof createPublicSampleContracts>['PublicSampleSchema']>;
export type PublicCaseResponse = PublicSample['caseResponse'];
export type PublicDiscoveryDetail = PublicSample['job'];
export type PublicAttempt = PublicSample['attempts'][number];
