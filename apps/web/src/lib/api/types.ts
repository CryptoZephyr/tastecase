// Type-only bridge to the shared backend contracts. The contracts package uses Node APIs at
// runtime (node:crypto, Buffer), so the browser bundle must never import its values.
export type {
  ApiError, Attempt, CatalogEntry, CatalogVersion, ComparisonAttemptAssociation, ComparisonFinalReport, ComparisonListItem,
  ComparisonPlan, ComparisonProgress, ComparisonRepeatResult, ComparisonRun, ComparisonState, CreateCatalogVersionRequest,
  CreateComparisonRequest, CreateDiscoveryJobRequest, CreateMappingConfirmationRequest, CreateProjectRequest, CreateTaskVersionRequest,
  DiscoveryCandidate, DiscoveryJob, DiscoveryProviderAttempt, DiscoveryState, DiscoveryTargetAssociation, MappingConfirmation,
  MintRunnerCredentialResponse, NormalizedDiscoveryEvidence, NormalizedTrace, PortableTestPack, PracticalConstraints, Project,
  RankingEvidence, RunnerCredential, SyntheticText, TargetRecommendation, TargetResult, TaskVersion, TraceEvent,
} from '@tastecase/contracts';
import type {
  ApprovedExpectationSchema, ComparisonCreateResponseSchema, ComparisonDetailResponseSchema, ComparisonFinalizeResponseSchema,
  DiscoveryAnchorConfirmationSchema, DiscoveryEvidenceSchema, DiscoveryJobDetailResponseSchema, PublishSuiteResponseSchema,
  ReviewCaseResponseSchema, ReviewDecisionRequestSchema, ReviewDecisionResponseSchema, ReviewRecordSchema, SuiteIdentitySchema,
  SuiteVersionSchema, ConfirmDiscoveryAnchorRequestSchema, PublishSuiteRequestSchema, CreateSuiteRequestSchema, AnchorResolutionSchema,
  CreateReviewCaseRequestSchema, FinalizeComparisonRequestSchema, CancelComparisonRequestSchema, ComparisonRepeatSummarySchema,
  ComparisonBehaviorChangeSchema,
} from '@tastecase/contracts';
import type { z } from 'zod';

export type DiscoveryJobDetail = z.infer<typeof DiscoveryJobDetailResponseSchema>;
export type DiscoveryEvidence = z.infer<typeof DiscoveryEvidenceSchema>;
export type AnchorResolution = z.infer<typeof AnchorResolutionSchema>;
export type DiscoveryAnchorConfirmation = z.infer<typeof DiscoveryAnchorConfirmationSchema>;
export type ConfirmDiscoveryAnchorRequest = z.infer<typeof ConfirmDiscoveryAnchorRequestSchema>;
export type ReviewCaseResponse = z.infer<typeof ReviewCaseResponseSchema>;
export type CreateReviewCaseRequest = z.infer<typeof CreateReviewCaseRequestSchema>;
export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequestSchema>;
export type ReviewDecisionResponse = z.infer<typeof ReviewDecisionResponseSchema>;
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
export type ApprovedExpectation = z.infer<typeof ApprovedExpectationSchema>;
export type SuiteIdentity = z.infer<typeof SuiteIdentitySchema>;
export type CreateSuiteRequest = z.infer<typeof CreateSuiteRequestSchema>;
export type SuiteVersion = z.infer<typeof SuiteVersionSchema>;
export type PublishSuiteRequest = z.infer<typeof PublishSuiteRequestSchema>;
export type PublishSuiteResponse = z.infer<typeof PublishSuiteResponseSchema>;
export type ComparisonCreateResponse = z.infer<typeof ComparisonCreateResponseSchema>;
export type ComparisonDetail = z.infer<typeof ComparisonDetailResponseSchema>;
export type ComparisonFinalizeResponse = z.infer<typeof ComparisonFinalizeResponseSchema>;
export type FinalizeComparisonRequest = z.infer<typeof FinalizeComparisonRequestSchema>;
export type CancelComparisonRequest = z.infer<typeof CancelComparisonRequestSchema>;
export type ComparisonRepeatSummary = z.infer<typeof ComparisonRepeatSummarySchema>;
export type ComparisonBehaviorChange = z.infer<typeof ComparisonBehaviorChangeSchema>;

/** Bounded list window used by discovery/review/suite/comparison routes (limit ≤ 20). */
export interface ListWindow { limit?: number; offset?: number }

/** An authenticated owner session as reported by the auth transport. Never decoded locally. */
export interface Session { userId: string; email: string | null; expiresAt: string | null }

/** Read-only public projection. It intentionally omits private ownership, leases and error text. */
export type PublicSample = import('@tastecase/contracts').PublicSample;
export type ViewCaseResponse = ReviewCaseResponse | PublicSample['caseResponse'];
export type ViewJobDetail = DiscoveryJobDetail | PublicSample['job'];
export type ViewAttempt = import('@tastecase/contracts').Attempt | PublicSample['attempts'][number];
