import { z } from 'zod';

/** Browser-only structural boundary. Backend remains authoritative for checksums, scoped rules,
 * provenance and CAS. Never filter malformed list entries or invent missing nested evidence.
 * Contracts cannot be imported at runtime here (they use Node crypto/Buffer). */
const s = z.string();
const n = z.number().int().nonnegative();
const b = z.boolean();
const id = z.uuid();
const time = z.iso.datetime({ offset: true });
const hash = s.regex(/^[a-f0-9]{64}$/);
const arr = <T extends z.ZodType>(item: T) => z.array(item);
const obj = (shape: z.ZodRawShape) => z.object(shape).passthrough();
const schema_version = z.literal('1.0.0');
const base = { schema_version, id, projectId: id, createdAt: time };
const synthetic = obj({ provenance: z.literal('synthetic'), label: s, text: s });
const constraints = obj({ partySize: n, dietaryRequirements: arr(s), accessibilityRequirements: arr(s), requiredCuisines: arr(s), excludedEntryIds: arr(s) });
const catalog = obj({ ...base, label: s, checksum: hash, entries: arr(obj({ id: s, name: s })) });
const task = obj({ ...base, label: s, checksum: hash, catalogVersionId: id, syntheticBrief: synthetic, syntheticInterests: arr(synthetic), constraints });
const mapping = obj({ ...base, catalogVersionId: id, catalogEntryId: s, qlooEntityId: id, confirmedBy: id });
const publicMapping = mapping.omit({ confirmedBy: true });
const credential = obj({ ...base, label: s, revokedAt: time.nullable(), lastHandshakeAt: time.nullable().optional() });
const targetInput = (publicDto: boolean) => obj({ schema_version, projectId: id, catalog, task, mappings: arr(publicDto ? publicMapping : mapping), eligibleCatalogEntryIds: arr(s) });
const trace = obj({ completeness: z.enum(['complete', 'partial', 'unavailable']), events: arr(obj({ kind: z.enum(['target_started', 'target_completed', 'tool_call', 'tool_result']) })) });
const targetError = obj({ code: s, message: s });
const targetResult = (publicDto: boolean) => z.discriminatedUnion('outcome', [
  obj({ schema_version, outcome: z.literal('success'), output: obj({ recommendations: arr(obj({ name: s, catalogEntryId: s.optional(), reason: s.optional() })), text: s.optional() }), trace }),
  obj({ schema_version, outcome: z.literal('malformed_output'), trace, ...(publicDto ? {} : { error: targetError, rawText: s }) }),
  obj({ schema_version, outcome: z.literal('provider_unavailable'), retryable: b, trace, ...(publicDto ? {} : { error: targetError }) }),
]);
const attempt = (publicDto: boolean) => obj({ ...base, catalogVersionId: id, taskVersionId: id, mappingConfirmationIds: arr(id), status: z.enum(['queued', 'leased', 'completed']), input: targetInput(publicDto), inputChecksum: hash, result: targetResult(publicDto).nullable(), resultChecksum: hash.nullable(), completedAt: time.nullable(), ...(publicDto ? {} : { leaseId: id.nullable(), leaseCredentialId: id.nullable(), leaseExpiresAt: time.nullable() }) });
const state = z.enum(['queued', 'resolving', 'needs_confirmation', 'ranking', 'selecting', 'running_target', 'waiting_runner', 'investigating', 'awaiting_review', 'no_useful_contrast', 'unavailable', 'partial', 'budget_exhausted', 'deadline_exceeded', 'cancelled', 'failed']);
const association = obj({ attemptId: id, profileId: z.enum(['a', 'b']), round: n, repeat: n, variant: z.enum(['full', 'reduced_pair']), status: z.enum(['queued', 'leased', 'completed']), dispatchCount: n, cancelled: b, uncertainDispatches: n });
const contrast = obj({ id, entryIds: arr(s).length(2), orders: obj({ a: arr(s).length(2), b: arr(s).length(2) }) });
const candidate = obj({ ...base, jobId: id, checksum: hash, content: obj({ contrast, briefs: obj({ a: synthetic.optional(), b: synthetic.optional(), constraints, eligibleCatalogEntryIds: arr(s) }), evidenceIds: arr(id), targetAttemptIds: arr(id), proposedExpectation: obj({ classification: z.literal('advisory'), automaticFailure: z.literal(false), humanReviewRequired: z.literal(true), contrastId: id, rationale: s }), limitations: arr(s) }) });
const qlooTag = obj({ type: z.enum(['urn:tag:cuisine:qloo', 'urn:tag:genre:place', 'urn:tag:category:place', 'urn:tag:ambience:qloo', 'urn:tag:culinary_style:qloo']), name: s.trim().min(1).max(80) });
const rankAffinity = obj({ entryId: s, affinity: z.number().min(0).max(1), interests: arr(obj({ anchorConfirmationId: id, score: z.number().min(0).max(1) })).max(5) });
const evidenceData = z.discriminatedUnion('kind', [
  obj({ kind: z.literal('rank'), providerStatus: z.enum(['ok', 'empty', 'needs_input', 'partial', 'degraded', 'error']), profileId: z.enum(['a', 'b']), scope: z.enum(['full', 'reduced_pair']), requestedEntryIds: arr(s), orderedEntryIds: arr(s), missingEntryIds: arr(s), unmappedEntryIds: arr(s), mappingConfirmationIds: arr(id), anchorConfirmationIds: arr(id), affinities: arr(rankAffinity).max(10).optional(), entryTags: arr(obj({ entryId: s, tags: arr(qlooTag).max(12) })).max(10).optional() }),
  obj({ kind: z.literal('resolve'), anchorId: id, providerStatus: s, candidates: arr(obj({ entityId: id, name: s, kind: s })) }),
  obj({ kind: z.literal('facts'), rankingEvidenceIds: arr(id).length(2), contrasts: arr(contrast), missingEntryIds: arr(s), unmappedEntryIds: arr(s) }),
  obj({ kind: z.literal('model_decision'), selectedContrastId: id.nullable(), rationale: s }),
]);
const evidence = obj({ schema_version, id, projectId: id, jobId: id, attemptId: id.nullable(), data: evidenceData, checksum: hash, capturedAt: time });
const resolution = obj({ ...base, jobId: id, anchorId: id, evidenceId: id, candidates: arr(obj({ entityId: id, name: s, kind: s })) });
const confirmation = (publicDto: boolean) => obj({ ...base, jobId: id, anchorId: id, entityId: id, resolutionId: id.nullable(), ...(publicDto ? {} : { confirmedBy: id }) });
const job = (publicDto: boolean) => obj({ ...base, input: obj({ request: obj({ id, repeatCount: n, assistantVersion: s, profiles: arr(obj({ id: z.enum(['a', 'b']), label: s, anchors: arr(obj({ id, kind: s, label: s })) })) }), targetInput: targetInput(publicDto) }), inputChecksum: hash, state, checkpoint: s, checkpointData: obj({ evidenceIds: arr(id), candidateIds: arr(id) }), counters: obj({ qlooAttempts: n, modelDecisions: n, targetAttempts: n, rounds: n }), revision: n, availableAt: time, deadlineAt: time, cancelledAt: time.nullable(), ...(publicDto ? {} : { leaseId: id.nullable(), leaseExpiresAt: time.nullable(), reason: s.nullable() }) });
const detail = (publicDto: boolean) => obj({ schema_version, job: job(publicDto), resolutions: arr(resolution), confirmations: arr(confirmation(publicDto)), evidence: arr(evidence), candidates: arr(candidate), attempts: arr(association), providerAttempts: arr(obj({ id, kind: z.enum(['qloo', 'model']), status: s, reservedAt: time, dispatchedAt: time.nullable(), finishedAt: time.nullable(), retryable: b, errorCategory: s.nullable() })) });
const head = obj({ schema_version, projectId: id, caseId: id, jobId: id, candidateId: id, revision: n, status: z.enum(['unreviewed', 'accepted', 'edited', 'rejected', 'deferred']), lastDecisionId: id.nullable(), approvedExpectationVersionId: id.nullable() });
const reviewCase = obj({ ...base, jobId: id, candidateId: id, candidateChecksum: hash });
const expectationVersion = obj({ ...base, caseId: id, jobId: id, candidateId: id, reviewDecisionId: id, reviewRevision: n, checksum: hash, evidenceChecksum: hash, expectation: obj({ classification: z.enum(['advisory', 'approved_policy', 'objective_contract']), automaticFailure: b }) });
const decision = (publicDto: boolean) => obj({ ...base, caseId: id, jobId: id, candidateId: id, candidateChecksum: hash, revision: n, expectedRevision: n, action: z.enum(['accept', 'edit', 'reject', 'defer']), rationale: s, approvedExpectationVersionId: id.nullable(), checksum: hash, ...(publicDto ? {} : { reviewedBy: id, requestChecksum: hash, evidence: obj({ schema_version, projectId: id, jobId: id, capturedAt: time, checksum: hash, coverage: obj({ intendedFullAttempts: n, completedFullAttempts: n }) }) }) });
const review = (publicDto: boolean) => obj({ decision: decision(publicDto), expectationVersion: expectationVersion.nullable() });
const caseResponse = (publicDto: boolean) => obj({ schema_version, case: reviewCase, head, candidate, currentReview: review(publicDto).nullable() });
const suite = obj({ ...base, name: s, currentVersion: n });
const suiteVersion = obj({ ...base, suiteId: id, expectedVersion: n, version: n, requestChecksum: hash, publishedBy: id, checksum: hash, cases: arr(obj({ case: reviewCase, review: review(false) })) });
const comparisonState = z.enum(['queued', 'running', 'cancelled', 'deadline_exceeded', 'budget_exhausted', 'finalized']);
const progress = obj({ logicalSlots: n, completed: n, dispatches: n, uncertainDispatches: n });
const plan = obj({ ...base, request: obj({ id, suiteVersionId: id, baselineVersion: s, candidateVersion: s, deadlineAt: time }), suiteChecksum: hash, checksum: hash, cases: arr(obj({ caseId: id })), slots: arr(obj({ attemptId: id })) });
const report = obj({ schema_version, id, projectId: id, finalizedAt: time, report_version: z.literal('tastecase-comparison-report/1'), comparisonId: id, planChecksum: hash, suiteVersionId: id, suiteChecksum: hash, checksum: hash, baselineVersion: s, candidateVersion: s, completion: z.enum(['complete', 'partial']), stopReason: s, progress, repeats: arr(obj({ caseId: id })), summaries: arr(obj({ caseId: id })), behaviorChanges: arr(obj({ caseId: id })), limitations: arr(s) });
const run = obj({ schema_version, plan, state: comparisonState, progress, cancelledAt: time.nullable(), finalReport: report.nullable() });
const comparison = obj({ ...base, suiteVersionId: id, suiteChecksum: hash, planChecksum: hash, baselineVersion: s, candidateVersion: s, state: comparisonState, progress, deadlineAt: time, cancelledAt: time.nullable(), finalReportChecksum: hash.nullable() });
const list = (key: string, item: z.ZodType) => obj({ schema_version, [key]: arr(item) });
export const responses = {
  project: obj({ schema_version, id, ownerId: id, name: s, createdAt: time }),
  catalog, task, mapping, credential, attempt: attempt(false), job: job(false), detail: detail(false), evidence, candidate, confirmation: confirmation(false),
  mint: obj({ schema_version, credential, token: s.regex(/^tc_runner_[A-Za-z0-9_-]{43}$/) }),
  case: caseResponse(false), reviewRecord: review(false), review: obj({ schema_version, head, review: review(false), idempotent: b }),
  suite, suiteVersion, publish: obj({ schema_version, suite: suiteVersion, idempotent: b }),
  comparison, comparisonDetail: obj({ schema_version, comparison: run, associations: arr(obj({ attemptId: id })) }),
  comparisonCreate: obj({ schema_version, comparison: run, idempotent: b }), finalize: obj({ schema_version, report, idempotent: b }),
  pack: obj({ schema_version, pack_version: z.literal('tastecase-test-pack/1'), target_output_contract: z.literal('tastecase-target-output/1'), plan, checksum: hash }), report,
  sample: obj({ schema_version, provenance: z.literal('recorded'), inputs: z.literal('synthetic'), capturedAt: time, caseResponse: caseResponse(true), job: detail(true), attempts: arr(attempt(true)).max(12) }),
  error: obj({ schema_version, error: obj({ code: z.enum(['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'lease_expired', 'credential_revoked', 'internal_error']), message: s, issues: arr(obj({ path: arr(z.union([s, n])), message: s })).optional() }) }),
};
export function validResponse(kind: keyof typeof responses, value: unknown): boolean { return responses[kind].safeParse(value).success; }
export function validList(kind: keyof typeof responses, key: string, value: unknown): boolean { return list(key, responses[kind]).safeParse(value).success; }
