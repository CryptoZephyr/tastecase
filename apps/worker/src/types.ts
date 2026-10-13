import type { z } from 'zod';
import type {
  PublicAnchorSchema, ResolutionEvidenceSchema, DiscoveryEvidenceSchema, DiscoveryAnchorConfirmationSchema,
  DiscoveryJob, DiscoveryProviderAttempt, RankingEvidence, ComputedDiscoveryFacts, ModelContrastDecision,
  TargetResult, DiscoveryState, TargetInput, CreateTaskVersionRequest,
} from '@tastecase/contracts';

export type PublicAnchor = z.infer<typeof PublicAnchorSchema>;
export type ResolutionEvidence = z.infer<typeof ResolutionEvidenceSchema>;
export type Evidence = z.infer<typeof DiscoveryEvidenceSchema>;
export type Confirmation = z.infer<typeof DiscoveryAnchorConfirmationSchema>;
export interface RankRequest {
  profileId: 'a' | 'b'; scope: 'full' | 'reduced_pair';
  options: { entryId: string; entityId: string; confirmationId: string }[];
  anchors: { entityId: string; confirmationId: string }[];
  unmappedEntryIds: string[];
}
export interface ProviderContext { signal: AbortSignal; outputBytes: number }
/** Injectable for tests; runtime must use official providers, never fixture fallbacks. */
export interface QlooAdapter {
  resolve(anchor: PublicAnchor, context: ProviderContext): Promise<ResolutionEvidence>;
  rank(request: RankRequest, context: ProviderContext): Promise<RankingEvidence>;
  close(): Promise<void>;
}
export interface DecisionAdapter {
  select(facts: ComputedDiscoveryFacts, context: ProviderContext): Promise<ModelContrastDecision>;
}
export interface TargetObservation {
  attemptId: string; profileId: 'a' | 'b'; round: number; repeat: number;
  variant: 'full' | 'reduced_pair'; status: 'queued' | 'leased' | 'completed';
  result: TargetResult | null; uncertainDispatches: number; claimable: boolean;
}
export interface Snapshot {
  job: DiscoveryJob; evidence: Evidence[]; confirmations: Confirmation[];
  providerAttempts: DiscoveryProviderAttempt[]; targets: TargetObservation[];
}
export interface Transition {
  state: DiscoveryState; checkpoint?: number; evidenceIds?: string[]; candidateIds?: string[];
  reason?: string; delaySeconds?: number; release?: boolean; round?: boolean;
}
export interface ScheduledTarget {
  attemptId: string; input: TargetInput; task: CreateTaskVersionRequest;
  profileId: 'a' | 'b'; round: number; repeat: number; variant: 'full' | 'reduced_pair';
}
export class StopWork extends Error {
  constructor(readonly state: DiscoveryState, readonly safeReason: string, readonly delaySeconds = 0) { super(safeReason); }
}
/** An unknown transport outcome is not an official retryable provider error. */
export class UnknownDispatch extends Error {
  constructor() { super('Provider dispatch outcome is unknown; the reservation remains charged.'); }
}
export function evidenceFor(snapshot: Snapshot, operation: string): Evidence | undefined {
  const ids = new Set(snapshot.providerAttempts.filter(attempt => attempt.operationKey === operation && attempt.status === 'accepted').map(attempt => attempt.id));
  return snapshot.evidence.find(evidence => evidence.attemptId !== null && ids.has(evidence.attemptId));
}
