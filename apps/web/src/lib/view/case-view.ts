import type {
  ViewAttempt, CatalogEntry, ViewJobDetail, DiscoveryTargetAssociation, PracticalConstraints, RankingEvidence, ViewCaseResponse,
  SyntheticText,
} from '@/lib/api/types';

export type ProfileId = 'a' | 'b';

export interface CatalogIndex {
  entries: CatalogEntry[];
  byId: Map<string, CatalogEntry>;
  eligible: Set<string>;
  mapped: Set<string>;
  excluded: Set<string>;
}

export interface EntryFacts { id: string; name: string; known: boolean; eligible: boolean; mapped: boolean; excluded: boolean }

export interface RankingView {
  evidenceId: string;
  profileId: ProfileId;
  scope: 'full' | 'reduced_pair';
  providerStatus: RankingEvidence['providerStatus'];
  requested: string[];
  ordered: string[];
  missing: string[];
  unmapped: string[];
  capturedAt: string;
  checksum: string;
  errorCode?: string;
}

/** Captured output for one profile in one attempt slot. `attempt` is null when its record didn't load. */
export interface SlotOutput { association: DiscoveryTargetAssociation; attempt: ViewAttempt | null }

export interface AttemptSlot {
  key: string;
  label: string;
  variant: 'full' | 'reduced_pair';
  round: number;
  repeat: number;
  outputs: Partial<Record<ProfileId, SlotOutput>>;
}

/** Same meaning as `reviewEvidenceCoverage` in packages/contracts/src/review.ts, computed on live job data. */
export interface Coverage {
  missingEntryIds: string[];
  unmappedEntryIds: string[];
  intendedFullAttempts: number;
  capturedFullAttempts: number;
  completedFullAttempts: number;
  unfinishedAttemptIds: string[];
  unavailableResultAttemptIds: string[];
  partialTraceAttemptIds: string[];
  unavailableTraceAttemptIds: string[];
  uncertainAttemptIds: string[];
  /** Attempts whose records could not be read, so their trace completeness is unknown here. */
  unreadAttemptIds: string[];
}

export interface CaseView {
  caseId: string;
  projectId: string;
  jobId: string;
  candidateId: string;
  createdAt: string;
  taskLabel: string;
  catalogLabel: string;
  catalogVersionId: string;
  constraints: PracticalConstraints;
  profiles: ProfileId[];
  briefs: Partial<Record<ProfileId, SyntheticText>>;
  anchors: Partial<Record<ProfileId, { id: string; label: string; kind: string; confirmed: boolean }[]>>;
  profileLabels: Partial<Record<ProfileId, string>>;
  contrastId: string;
  contrast: { entryIds: [string, string]; orders: Record<ProfileId, [string, string]> };
  proposedRationale: string;
  limitations: string[];
  coverage: Coverage;
  rankings: RankingView[];
  slots: AttemptSlot[];
  head: ViewCaseResponse['head'];
  currentReview: ViewCaseResponse['currentReview'];
  catalog: CatalogIndex;
  evidenceCapturedAt: string | null;
  repeatCount: number;
  assistantVersion: string;
}

export function indexCatalog(job: ViewJobDetail): CatalogIndex {
  const input = job.job.input.targetInput;
  const entries = input.catalog.entries;
  return {
    entries,
    byId: new Map(entries.map(entry => [entry.id, entry])),
    eligible: new Set(input.eligibleCatalogEntryIds),
    mapped: new Set(input.mappings.map(mapping => mapping.catalogEntryId)),
    excluded: new Set(input.task.constraints.excludedEntryIds),
  };
}

export function entryFacts(catalog: CatalogIndex, id: string): EntryFacts {
  const entry = catalog.byId.get(id);
  return { id, name: entry?.name ?? id, known: Boolean(entry), eligible: catalog.eligible.has(id), mapped: catalog.mapped.has(id), excluded: catalog.excluded.has(id) };
}

const slotLabel = (variant: 'full' | 'reduced_pair', round: number, repeat: number) =>
  variant === 'full' ? `Repeat ${repeat + 1}${round > 0 ? ` · round ${round + 1}` : ''}` : `Pair follow-up${repeat > 0 ? ` · repeat ${repeat + 1}` : ''}`;

export function buildSlots(associations: DiscoveryTargetAssociation[], attempts: Map<string, ViewAttempt>): AttemptSlot[] {
  const slots = new Map<string, AttemptSlot>();
  for (const association of associations) {
    const key = `${association.variant}:${association.round}:${association.repeat}`;
    const slot = slots.get(key) ?? { key, label: slotLabel(association.variant, association.round, association.repeat), variant: association.variant, round: association.round, repeat: association.repeat, outputs: {} };
    slot.outputs[association.profileId] = { association, attempt: attempts.get(association.attemptId) ?? null };
    slots.set(key, slot);
  }
  return [...slots.values()].sort((x, y) => (x.variant === y.variant ? 0 : x.variant === 'full' ? -1 : 1) || x.round - y.round || x.repeat - y.repeat);
}

export function computeCoverage(job: ViewJobDetail, attempts: Map<string, ViewAttempt>): Coverage {
  const ranks = job.evidence.flatMap(row => (row.data.kind === 'rank' || row.data.kind === 'facts' ? [row.data] : []));
  const targets = job.attempts;
  const result = (id: string) => attempts.get(id)?.result ?? null;
  return {
    missingEntryIds: [...new Set(ranks.flatMap(rank => rank.missingEntryIds))].sort(),
    unmappedEntryIds: [...new Set(ranks.flatMap(rank => rank.unmappedEntryIds))].sort(),
    intendedFullAttempts: job.job.input.request.repeatCount * 2,
    capturedFullAttempts: targets.filter(row => row.variant === 'full').length,
    completedFullAttempts: targets.filter(row => row.variant === 'full' && row.status === 'completed').length,
    unfinishedAttemptIds: targets.filter(row => row.status !== 'completed').map(row => row.attemptId),
    unavailableResultAttemptIds: targets.filter(row => result(row.attemptId)?.outcome === 'provider_unavailable').map(row => row.attemptId),
    partialTraceAttemptIds: targets.filter(row => result(row.attemptId)?.trace.completeness === 'partial').map(row => row.attemptId),
    unavailableTraceAttemptIds: targets.filter(row => result(row.attemptId)?.trace.completeness === 'unavailable').map(row => row.attemptId),
    uncertainAttemptIds: targets.filter(row => row.uncertainDispatches > 0).map(row => row.attemptId),
    unreadAttemptIds: targets.filter(row => row.status === 'completed' && !attempts.has(row.attemptId)).map(row => row.attemptId),
  };
}

export function rankingViews(job: ViewJobDetail): RankingView[] {
  return job.evidence.flatMap(row => row.data.kind === 'rank' ? [{
    evidenceId: row.id, profileId: row.data.profileId, scope: row.data.scope, providerStatus: row.data.providerStatus,
    requested: row.data.requestedEntryIds, ordered: row.data.orderedEntryIds, missing: row.data.missingEntryIds, unmapped: row.data.unmappedEntryIds,
    capturedAt: row.capturedAt, checksum: row.checksum, errorCode: 'error' in row.data ? row.data.error?.code : undefined,
  }] : []);
}

/** Builds the review view. Profiles come from the briefs actually present: a single brief never gains an invented Profile B. */
export function buildCaseView(response: ViewCaseResponse, job: ViewJobDetail, attemptList: ViewAttempt[]): CaseView {
  const attempts = new Map(attemptList.map(attempt => [attempt.id, attempt]));
  const content = response.candidate.content;
  const request = job.job.input.request;
  const input = job.job.input.targetInput;
  const briefs: Partial<Record<ProfileId, SyntheticText>> = {};
  for (const profile of ['a', 'b'] as const) if (content.briefs[profile]) briefs[profile] = content.briefs[profile];
  const confirmedAnchors = new Set(job.confirmations.map(row => row.anchorId));
  const evidence = job.evidence.filter(row => content.evidenceIds.includes(row.id));
  return {
    caseId: response.case.id, projectId: response.case.projectId, jobId: response.case.jobId, candidateId: response.case.candidateId,
    createdAt: response.case.createdAt, taskLabel: input.task.label, catalogLabel: input.catalog.label, catalogVersionId: input.catalog.id,
    constraints: content.briefs.constraints,
    profiles: (['a', 'b'] as const).filter(profile => briefs[profile]),
    briefs,
    anchors: Object.fromEntries(request.profiles.map(profile => [profile.id, profile.anchors.map(anchor => ({
      id: anchor.id, label: anchor.label, kind: anchor.kind, confirmed: Boolean(anchor.confirmedEntityId) || confirmedAnchors.has(anchor.id) }))])),
    profileLabels: Object.fromEntries(request.profiles.map(profile => [profile.id, profile.label])),
    contrastId: content.contrast.id,
    contrast: { entryIds: content.contrast.entryIds, orders: content.contrast.orders },
    proposedRationale: content.proposedExpectation.rationale,
    limitations: content.limitations,
    coverage: computeCoverage(job, attempts),
    rankings: rankingViews(job),
    slots: buildSlots(job.attempts, attempts),
    head: response.head,
    currentReview: response.currentReview,
    catalog: indexCatalog(job),
    evidenceCapturedAt: evidence.map(row => row.capturedAt).sort().at(-1) ?? null,
    repeatCount: request.repeatCount,
    assistantVersion: request.assistantVersion,
  };
}

export type OutputState =
  | { kind: 'not_captured' }
  | { kind: 'unread' }
  | { kind: 'pending'; status: 'queued' | 'leased' }
  | { kind: 'success'; recommendations: { catalogEntryId?: string; name: string; reason?: string }[]; text?: string; trace: 'complete' | 'partial' | 'unavailable' }
  | { kind: 'malformed'; code: string; message: string; trace: 'complete' | 'partial' | 'unavailable' }
  | { kind: 'unavailable'; code: string; message: string; retryable: boolean; trace: 'complete' | 'partial' | 'unavailable' };

export function outputState(output: SlotOutput | undefined): OutputState {
  if (!output) return { kind: 'not_captured' };
  if (output.association.status !== 'completed') return { kind: 'pending', status: output.association.status };
  const result = output.attempt?.result;
  if (!output.attempt || !result) return { kind: 'unread' };
  if (result.outcome === 'success') return { kind: 'success', recommendations: result.output.recommendations, text: result.output.text, trace: result.trace.completeness };
  if (result.outcome === 'malformed_output') return { kind: 'malformed', code: 'error' in result ? result.error.code : 'malformed_output', message: 'error' in result ? result.error.message : 'Provider error details are omitted from the public sample.', trace: result.trace.completeness };
  return { kind: 'unavailable', code: 'error' in result ? result.error.code : 'provider_unavailable', message: 'error' in result ? result.error.message : 'Provider error details are omitted from the public sample.', retryable: result.retryable, trace: result.trace.completeness };
}

/** Code-computed description of where an entry appears; absence is stated, never inferred as preference. */
export function positionIn(ids: (string | undefined)[], id: string): number | null {
  const index = ids.indexOf(id);
  return index < 0 ? null : index + 1;
}

export function recommendationIds(state: OutputState): (string | undefined)[] | null {
  return state.kind === 'success' ? state.recommendations.map(row => row.catalogEntryId) : null;
}

/** Whether two captured outputs recommend the same ordered catalog IDs. Null when not comparable. */
export function sameRecommendations(left: OutputState, right: OutputState): boolean | null {
  const a = recommendationIds(left); const b = recommendationIds(right);
  if (!a || !b || a.some(id => id === undefined) || b.some(id => id === undefined)) return null;
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function limitationSummary(coverage: Coverage): string[] {
  const lines = [`Full assistant runs: ${coverage.completedFullAttempts} completed of ${coverage.capturedFullAttempts} captured; ${coverage.intendedFullAttempts} intended.`];
  if (coverage.missingEntryIds.length) lines.push(`${coverage.missingEntryIds.length} candidate${coverage.missingEntryIds.length === 1 ? '' : 's'} missing from a Qloo ranking — unavailable, not disliked.`);
  if (coverage.unmappedEntryIds.length) lines.push(`${coverage.unmappedEntryIds.length} eligible restaurant${coverage.unmappedEntryIds.length === 1 ? '' : 's'} without a confirmed Qloo mapping — not ranked.`);
  if (coverage.partialTraceAttemptIds.length || coverage.unavailableTraceAttemptIds.length) lines.push('Some traces are partial or unavailable; that cannot prove a missing tool call.');
  if (coverage.uncertainAttemptIds.length) lines.push('Some dispatches were interrupted and may have repeated; exactly-once execution is not established.');
  if (coverage.unreadAttemptIds.length) lines.push(`${coverage.unreadAttemptIds.length} attempt record${coverage.unreadAttemptIds.length === 1 ? '' : 's'} could not be read here, so their trace completeness is unknown.`);
  return lines;
}
