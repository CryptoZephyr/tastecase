import { z } from 'zod';
import type { Attempt, TargetInput, TargetResult, TargetAdapter } from './index.js';
import type { ApprovedExpectation, ReviewContracts, SuiteCaseSnapshot, SuiteVersion } from './review.js';
import { canonicalJson, checksum } from './canonical.js';
import { AssistantVersionSchema, CatalogEntryIdSchema, ChecksumSchema, ComparisonExecutionBindingSchema, IdSchema, SchemaVersionSchema, TimestampSchema } from './primitives.js';

export const COMPARISON_LIMITS = { requestBytes: 65536, planBytes: 8388608, packBytes: 8388608, reportBytes: 2097152,
  cases: 10, slots: 120, reclaims: 24, dispatches: 144, deadlineSeconds: 3600, window: 20, offset: 10000 } as const;
export const TEST_PACK_VERSION = 'tastecase-test-pack/1' as const;
export const COMPARISON_REPORT_VERSION = 'tastecase-comparison-report/1' as const;
export const TARGET_OUTPUT_CONTRACT = 'tastecase-target-output/1' as const;
type ProfileId = 'a' | 'b';
export type DiscoveryProfile = SuiteVersion['cases'][number]['review']['decision']['evidence']['job']['input']['request']['profiles'][number];
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const withoutChecksum = (value: { checksum: string }) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'checksum'));
const bounded = (value: unknown, bytes: number) => Buffer.byteLength(canonicalJson(value), 'utf8') <= bytes;
const entryIds = z.array(CatalogEntryIdSchema).max(500);
const count = z.number().int().nonnegative().safe();
export class ComparisonConflictError extends Error { readonly code = 'conflict'; }

/** Required pinned meaning is rejected, never redacted and rehashed. This is a conservative
 * pattern/known-value check, not a universal secret detector. Error strings never echo input. */
export function assertSafePortableContent(value: unknown, knownSecrets: readonly string[] = []): void {
  const patterns = [ /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /tc_runner_[A-Za-z0-9_-]{43}/, /(?:AKIA|ASIA)[A-Z0-9]{16}/,
    /\b(?:sk|rk|pk)_?(?:live|test)?[_-][A-Za-z0-9_-]{16,}\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /\b(?:authorization\s*[:=]\s*(?:bearer|basic)|(?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]\s*\S+)/i,
    /[a-z][a-z0-9+.-]*:\/\//i ];
  function visit(item: unknown): void {
    if (typeof item === 'string' && (patterns.some(pattern => pattern.test(item)) || knownSecrets.some(secret => secret.length > 0 && item.includes(secret)))) {
      throw new TypeError('Unsafe credential-like or URL content in required portable input');
    }
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.entries(item).forEach(([key, child]) => { visit(key); visit(child); });
  }
  visit(value);
}

/** Lazy injected schemas avoid the index/review/discovery runtime cycle. Helpers validate
 * content, not ownership or transaction locking; the API must resolve rows under owner scope. */
export function createComparisonContracts(
  foundation: { targetInputSchema: z.ZodType<TargetInput>; attemptSchema: z.ZodType<Attempt>; targetResultSchema: z.ZodType<TargetResult> },
  review: Pick<ReviewContracts, 'SuiteVersionSchema' | 'SuiteCaseSnapshotSchema' | 'ApprovedExpectationSchema'>,
  discovery: Pick<typeof import('./discovery.js'), 'discoveryAttemptId'>,
) {
  const { discoveryAttemptId } = discovery;
  /** Same full-task semantics as apps/worker/src/synthetic.ts:syntheticTarget. The published
   * brief is authoritative; no completed discovery output is needed. Worker can call this helper
   * with its syntheticBrief result to keep task IDs, interests, labels and checksum in sync. */
  function deriveSyntheticFullProfileInput(args: { jobId: string; projectId: string; createdAt: string; targetInput: TargetInput; profile: DiscoveryProfile; brief: TargetInput['task']['syntheticBrief'] }): TargetInput {
    const task = { schema_version: args.targetInput.schema_version, id: discoveryAttemptId(args.jobId, `task:${args.profile.id}:full`, 0),
      label: `Synthetic discovery ${args.profile.id} full`, catalogVersionId: args.targetInput.catalog.id, syntheticBrief: args.brief,
      syntheticInterests: args.profile.anchors.map(anchor => ({ provenance: 'synthetic' as const, label: `Public ${anchor.kind} interest`, text: anchor.label })),
      constraints: args.targetInput.task.constraints };
    const { execution: _execution, ...base } = args.targetInput;
    void _execution;
    return foundation.targetInputSchema.parse({ ...base, task: { ...task, projectId: args.projectId, checksum: checksum(task), createdAt: args.createdAt } });
  }
  const CreateComparisonRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema, id: IdSchema,
    suiteVersionId: IdSchema, baselineVersion: AssistantVersionSchema, candidateVersion: AssistantVersionSchema,
    caseIds: z.array(IdSchema).min(1).max(COMPARISON_LIMITS.cases).refine(ids => new Set(ids).size === ids.length, 'Duplicate selected cases'),
    deadlineAt: TimestampSchema, dispatchBudget: z.number().int().min(4).max(COMPARISON_LIMITS.dispatches),
    reclaimBudget: z.number().int().min(0).max(COMPARISON_LIMITS.reclaims),
  }).superRefine((request, ctx) => {
    if (request.baselineVersion === request.candidateVersion) ctx.addIssue({ code: 'custom', message: 'Comparison requires distinct explicit assistant versions' });
    if (!bounded(request, COMPARISON_LIMITS.requestBytes)) ctx.addIssue({ code: 'custom', message: 'Comparison request exceeds byte limit' });
  });
  type Request = z.infer<typeof CreateComparisonRequestSchema>;
  const ComparisonEvidenceReferenceSchema = z.strictObject({ id: IdSchema, checksum: ChecksumSchema,
    kind: z.enum(['rank', 'resolve', 'facts', 'model_decision']), providerStatus: z.enum(['ok', 'empty', 'needs_input', 'partial', 'degraded', 'error']).nullable(),
    missingEntryIds: entryIds, unmappedEntryIds: entryIds });
  const ComparisonExpectationSchema = z.union([review.ApprovedExpectationSchema.options[0], review.ApprovedExpectationSchema.options[1],
    z.strictObject({ classification: z.literal('advisory'), automaticFailure: z.literal(false), humanReviewRequired: z.literal(true), contrastId: IdSchema })]);
  type Expectation = z.infer<typeof ComparisonExpectationSchema>;
  const ComparisonCaseSchema = z.strictObject({ caseId: IdSchema, caseChecksum: ChecksumSchema, candidateChecksum: ChecksumSchema,
    jobId: IdSchema, expectationVersionId: IdSchema, expectationChecksum: ChecksumSchema, evidenceChecksum: ChecksumSchema,
    repeatCount: z.number().int().min(1).max(3), inputs: z.strictObject({ a: z.lazy(() => foundation.targetInputSchema), b: z.lazy(() => foundation.targetInputSchema) }),
    expectation: ComparisonExpectationSchema, evidenceReferences: z.array(ComparisonEvidenceReferenceSchema).max(50), checksum: ChecksumSchema,
  }).superRefine((row, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (checksum(withoutChecksum(row)) !== row.checksum) issue('Comparison case projection checksum mismatch');
    const { a, b } = row.inputs;
    if (a.execution || b.execution || !same(a.catalog, b.catalog) || !same(a.mappings, b.mappings)
      || a.projectId !== b.projectId || !same(a.eligibleCatalogEntryIds, b.eligibleCatalogEntryIds) || !same(a.task.constraints, b.task.constraints)) issue('Profile inputs must preserve fixed catalog, mappings, constraints and eligibility');
    for (const profileId of ['a', 'b'] as const) {
      const input = row.inputs[profileId];
      if (input.task.id !== discoveryAttemptId(row.jobId, `task:${profileId}:full`, 0)
        || input.task.label !== `Synthetic discovery ${profileId} full`) issue('Profile full-task identity mismatch');
    }
    if (new Set(row.evidenceReferences.map(ref => ref.id)).size !== row.evidenceReferences.length) issue('Duplicate evidence reference');
    const eligible = new Set(a.eligibleCatalogEntryIds); const catalog = new Set(a.catalog.entries.map(entry => entry.id));
    const expectation = row.expectation;
    if (expectation.classification === 'objective_contract') for (const rule of expectation.rules) {
      if (rule.kind === 'allowed_ids' && !same([...rule.entryIds].sort(), [...eligible].sort())) issue('Allowed IDs must equal pinned eligibility');
      if (rule.kind === 'exclusions' && rule.entryIds.some(id => !a.task.constraints.excludedEntryIds.includes(id))) issue('Exclusions must be pinned explicit constraints');
    }
    if (expectation.classification === 'approved_policy') for (const rule of expectation.rules) {
      const ids = rule.kind === 'order' ? [rule.beforeEntryId, rule.afterEntryId] : rule.entryIds;
      if (ids.some(id => !catalog.has(id) || (rule.kind !== 'avoid' && !eligible.has(id)))) issue('Policy references unsupported catalog IDs');
    }
  });
  type Case = z.infer<typeof ComparisonCaseSchema>;
  function projectComparisonCase(rowValue: SuiteCaseSnapshot): Case {
    const row = review.SuiteCaseSnapshotSchema.parse(rowValue);
    const evidence = row.review.decision.evidence; const version = row.review.expectationVersion;
    if (!version) throw new TypeError('Comparison requires published approval');
    const inputs = Object.fromEntries((['a', 'b'] as const).map(profileId => {
      const profile = evidence.job.input.request.profiles.find(profile => profile.id === profileId);
      if (!profile) throw new TypeError('Missing published profile');
      return [profileId, foundation.targetInputSchema.parse(deriveSyntheticFullProfileInput({ jobId: evidence.jobId,
        projectId: evidence.projectId, createdAt: evidence.job.createdAt, targetInput: evidence.job.input.targetInput,
        profile, brief: evidence.candidate.content.briefs[profileId] }))];
    }));
    const content = { caseId: row.case.id, caseChecksum: checksum(row.case), candidateChecksum: row.case.candidateChecksum,
      jobId: evidence.jobId, expectationVersionId: version.id, expectationChecksum: version.checksum, evidenceChecksum: evidence.checksum,
      repeatCount: evidence.job.input.request.repeatCount, inputs, expectation: version.expectation.classification === 'advisory'
        ? { classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: version.expectation.contrastId } : version.expectation,
      evidenceReferences: evidence.evidence.map(ref => ({ id: ref.id, checksum: ref.checksum, kind: ref.data.kind,
        providerStatus: 'providerStatus' in ref.data ? ref.data.providerStatus : null,
        missingEntryIds: 'missingEntryIds' in ref.data ? ref.data.missingEntryIds : [],
        unmappedEntryIds: 'unmappedEntryIds' in ref.data ? ref.data.unmappedEntryIds : [] })) };
    return ComparisonCaseSchema.parse({ ...content, checksum: checksum(content) });
  }
  const ComparisonSlotSchema = z.strictObject({ attemptId: IdSchema, execution: ComparisonExecutionBindingSchema,
    input: z.lazy(() => foundation.targetInputSchema), inputChecksum: ChecksumSchema }).superRefine((slot, ctx) => {
    if (!same(slot.execution, slot.input.execution) || checksum(slot.input) !== slot.inputChecksum
      || slot.attemptId !== comparisonAttemptId(slot.execution)) ctx.addIssue({ code: 'custom', message: 'Comparison slot identity/input checksum mismatch' });
  });
  type Slot = z.infer<typeof ComparisonSlotSchema>;
  function comparisonAttemptId(execution: z.infer<typeof ComparisonExecutionBindingSchema>): string {
    return discoveryAttemptId(execution.comparisonId, `comparison:${checksum([execution.caseId, execution.role, execution.profileId, execution.repeat])}`, 0);
  }
  function createSlots(request: Request, suiteChecksum: string, cases: Case[]): Slot[] {
    return cases.flatMap(row => (['baseline', 'candidate'] as const).flatMap(role => (['a', 'b'] as const).flatMap(profileId =>
      Array.from({ length: row.repeatCount }, (_, repeat) => {
        const execution = ComparisonExecutionBindingSchema.parse({ kind: 'comparison', comparisonId: request.id, caseId: row.caseId,
          caseChecksum: row.caseChecksum, suiteVersionId: request.suiteVersionId, suiteChecksum, expectationVersionId: row.expectationVersionId,
          expectationChecksum: row.expectationChecksum, evidenceChecksum: row.evidenceChecksum,
          role, assistantVersion: role === 'baseline' ? request.baselineVersion : request.candidateVersion, profileId, repeat });
        const input = foundation.targetInputSchema.parse({ ...row.inputs[profileId], execution });
        return ComparisonSlotSchema.parse({ attemptId: comparisonAttemptId(execution), execution, input, inputChecksum: checksum(input) });
      }))));
  }
  const ComparisonPlanSchema = z.strictObject({ schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema,
    request: CreateComparisonRequestSchema, requestChecksum: ChecksumSchema, suiteChecksum: ChecksumSchema,
    createdAt: TimestampSchema, cases: z.array(ComparisonCaseSchema).min(1).max(COMPARISON_LIMITS.cases),
    slots: z.array(ComparisonSlotSchema).min(4).max(COMPARISON_LIMITS.slots), checksum: ChecksumSchema,
  }).superRefine((plan, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (plan.id !== plan.request.id || checksum(plan.request) !== plan.requestChecksum || checksum(withoutChecksum(plan)) !== plan.checksum) issue('Plan identity/checksum mismatch');
    if (!same(plan.cases.map(row => row.caseId), plan.request.caseIds) || plan.cases.some(row => row.inputs.a.projectId !== plan.projectId)) issue('Plan must preserve exact ordered case selection and project');
    if (!same(plan.slots, createSlots(plan.request, plan.suiteChecksum, plan.cases))) issue('Plan slots must be exact deterministic fresh full-profile repeats');
    const duration = Date.parse(plan.request.deadlineAt) - Date.parse(plan.createdAt);
    if (duration <= 0 || duration > COMPARISON_LIMITS.deadlineSeconds * 1000) issue('Deadline must be within one hour of creation');
    if (plan.request.dispatchBudget < plan.slots.length || plan.request.dispatchBudget > plan.slots.length + plan.request.reclaimBudget) issue('Dispatch budget must cover all logical slots with bounded extra charges');
    if (!bounded(plan, COMPARISON_LIMITS.planBytes)) issue('Plan exceeds byte limit');
    try { assertSafePortableContent(plan); } catch { issue('Unsafe credential-like required input'); }
  });
  type Plan = z.infer<typeof ComparisonPlanSchema>;
  function prepareComparisonPlan(args: { request: Request; suite: SuiteVersion; projectId: string; createdAt: string }): Plan {
    const request = CreateComparisonRequestSchema.parse(args.request); const suite = review.SuiteVersionSchema.parse(args.suite);
    if (suite.id !== request.suiteVersionId || suite.projectId !== IdSchema.parse(args.projectId)) throw new TypeError('Comparison must reference selected published suite in this project');
    const cases = request.caseIds.map(caseId => {
      const row = suite.cases.find(row => row.case.id === caseId);
      if (!row) throw new TypeError('Selected case is absent from published suite');
      return projectComparisonCase(row);
    });
    const content = { schema_version: request.schema_version, id: request.id, projectId: suite.projectId, request,
      requestChecksum: checksum(request), suiteChecksum: suite.checksum, createdAt: TimestampSchema.parse(args.createdAt), cases,
      slots: createSlots(request, suite.checksum, cases) };
    return ComparisonPlanSchema.parse({ ...content, checksum: checksum(content) });
  }
  /** Backend-only JSON row generation for atomic creation in existing target_attempts. */
  function comparisonExecutionRows(planValue: Plan) {
    const plan = ComparisonPlanSchema.parse(planValue);
    return plan.slots.map(slot => ({ attempt_id: slot.attemptId, project_id: plan.projectId, comparison_id: plan.id,
      case_id: slot.execution.caseId, role: slot.execution.role, assistant_version: slot.execution.assistantVersion,
      profile_id: slot.execution.profileId, repeat: slot.execution.repeat, catalog_version_id: slot.input.catalog.id,
      task_version_id: slot.input.task.id, mapping_confirmation_ids: slot.input.mappings.map(mapping => mapping.id),
      pinned_input: slot.input, input_checksum: slot.inputChecksum }));
  }
  function validateComparisonRetry(value: unknown, planValue: unknown, projectId: string): Plan {
    const request = CreateComparisonRequestSchema.parse(value); const plan = ComparisonPlanSchema.parse(planValue);
    if (plan.projectId !== IdSchema.parse(projectId) || plan.id !== request.id || plan.requestChecksum !== checksum(request)) throw new ComparisonConflictError('Comparison ID already has different immutable content');
    return plan;
  }
  function validateComparisonPlanAgainstSuite(value: unknown, suite: SuiteVersion): Plan {
    const plan = ComparisonPlanSchema.parse(value);
    const expected = prepareComparisonPlan({ request: plan.request, suite, projectId: plan.projectId, createdAt: plan.createdAt });
    if (!same(expected, plan)) throw new TypeError('Comparison projection does not match published suite');
    return plan;
  }

  const ComparisonAttemptAssociationSchema = z.strictObject({ attemptId: IdSchema, comparisonId: IdSchema, caseId: IdSchema,
    role: z.enum(['baseline', 'candidate']), assistantVersion: AssistantVersionSchema, profileId: z.enum(['a', 'b']), repeat: z.number().int().min(0).max(2),
    status: z.enum(['queued', 'leased', 'completed']), dispatchCount: z.number().int().min(0).max(COMPARISON_LIMITS.dispatches),
    uncertainDispatches: z.number().int().min(0).max(COMPARISON_LIMITS.dispatches), cancelled: z.boolean(),
  }).superRefine((row, ctx) => {
    if (row.uncertainDispatches > row.dispatchCount || (row.status !== 'queued' && row.dispatchCount === 0)) ctx.addIssue({ code: 'custom', message: 'Association dispatch accounting is inconsistent' });
  });
  type Association = z.infer<typeof ComparisonAttemptAssociationSchema>;
  function initialComparisonAssociations(planValue: Plan): Association[] {
    const plan = ComparisonPlanSchema.parse(planValue);
    return plan.slots.map(slot => ComparisonAttemptAssociationSchema.parse({ attemptId: slot.attemptId,
      comparisonId: plan.id, caseId: slot.execution.caseId, role: slot.execution.role, assistantVersion: slot.execution.assistantVersion,
      profileId: slot.execution.profileId, repeat: slot.execution.repeat, status: 'queued', dispatchCount: 0, uncertainDispatches: 0, cancelled: false }));
  }
  const ComparisonStateSchema = z.enum(['queued', 'running', 'cancelled', 'deadline_exceeded', 'budget_exhausted', 'finalized']);
  const ComparisonProgressSchema = z.strictObject({ logicalSlots: count.max(120), queued: count.max(120), leased: count.max(120), completed: count.max(120),
    dispatches: count.max(144), reclaims: count.max(24), uncertainDispatches: count.max(144) }).refine(row => row.queued + row.leased + row.completed === row.logicalSlots, 'Progress must retain all logical slots');
  function comparisonProgress(plan: Plan, associations: Association[]) {
    validateAssociations(plan, associations);
    return ComparisonProgressSchema.parse({ logicalSlots: plan.slots.length,
      queued: associations.filter(row => row.status === 'queued').length, leased: associations.filter(row => row.status === 'leased').length,
      completed: associations.filter(row => row.status === 'completed').length, dispatches: associations.reduce((n, row) => n + row.dispatchCount, 0),
      reclaims: associations.reduce((n, row) => n + Math.max(0, row.dispatchCount - 1), 0), uncertainDispatches: associations.reduce((n, row) => n + row.uncertainDispatches, 0) });
  }
  function validateAssociations(plan: Plan, values: Association[]): Association[] {
    const rows = z.array(ComparisonAttemptAssociationSchema).max(120).parse(values);
    if (rows.length !== plan.slots.length || new Set(rows.map(row => row.attemptId)).size !== rows.length) throw new TypeError('Resolve exactly all comparison associations');
    for (const row of rows) {
      const slot = plan.slots.find(slot => slot.attemptId === row.attemptId);
      if (!slot || row.comparisonId !== plan.id || row.caseId !== slot.execution.caseId || row.role !== slot.execution.role
        || row.assistantVersion !== slot.execution.assistantVersion || row.profileId !== slot.execution.profileId || row.repeat !== slot.execution.repeat) throw new TypeError('Comparison association does not match planned identity');
    }
    const dispatches = rows.reduce((n, row) => n + row.dispatchCount, 0); const reclaims = rows.reduce((n, row) => n + Math.max(0, row.dispatchCount - 1), 0);
    if (dispatches > plan.request.dispatchBudget || reclaims > plan.request.reclaimBudget) throw new TypeError('Comparison dispatch/reclaim budget exceeded');
    return rows;
  }
  function comparisonClaimAllowed(args: { plan: Plan; association: Association; state: z.infer<typeof ComparisonStateSchema>; assistantVersion?: string; now: string; associations: Association[]; leaseExpired?: boolean }): boolean {
    const plan = ComparisonPlanSchema.parse(args.plan); const rows = validateAssociations(plan, args.associations);
    const row = rows.find(row => row.attemptId === args.association.attemptId);
    if (!row || !same(row, args.association)) throw new TypeError('Claim association is not persisted state');
    const progress = comparisonProgress(plan, rows);
    return ['queued', 'running'].includes(args.state) && Date.parse(TimestampSchema.parse(args.now)) < Date.parse(plan.request.deadlineAt)
      && args.assistantVersion === row.assistantVersion && !row.cancelled && (row.status === 'queued' || (row.status === 'leased' && args.leaseExpired === true))
      && progress.dispatches < plan.request.dispatchBudget && (row.dispatchCount === 0 || progress.reclaims < plan.request.reclaimBudget);
  }

  const ComparisonResultEvidenceSchema = z.strictObject({ outcome: z.enum(['pending', 'success', 'malformed_output', 'provider_unavailable']),
    resultChecksum: ChecksumSchema.nullable(), traceCompleteness: z.enum(['complete', 'partial', 'unavailable']).nullable(),
    recommendationIds: z.array(CatalogEntryIdSchema.nullable()).max(500), checksum: ChecksumSchema,
  }).superRefine((row, ctx) => {
    if (checksum(withoutChecksum(row)) !== row.checksum || (row.outcome === 'pending') !== (row.resultChecksum === null)
      || (row.outcome === 'pending') !== (row.traceCompleteness === null) || (row.outcome !== 'success' && row.recommendationIds.length)) ctx.addIssue({ code: 'custom', message: 'Structural result evidence mismatch' });
  });
  type ResultEvidence = z.infer<typeof ComparisonResultEvidenceSchema>;
  function projectComparisonResult(resultValue: TargetResult | null): ResultEvidence {
    const result = resultValue === null ? null : foundation.targetResultSchema.parse(resultValue);
    const content = { outcome: result?.outcome ?? 'pending', resultChecksum: result === null ? null : checksum(result),
      traceCompleteness: result?.trace.completeness ?? null,
      recommendationIds: result?.outcome === 'success' ? result.output.recommendations.map(row => row.catalogEntryId ?? null) : [] };
    return ComparisonResultEvidenceSchema.parse({ ...content, checksum: checksum(content) });
  }
  const RuleOutcomeSchema = z.enum(['pass', 'fail', 'unavailable', 'not_applicable', 'advisory']);
  function validateComparisonRunnerBinding(inputValue: unknown, assistantVersion?: string): TargetInput {
    const input = foundation.targetInputSchema.parse(inputValue);
    if (input.execution && (assistantVersion === undefined || AssistantVersionSchema.parse(assistantVersion) !== input.execution.assistantVersion)) throw new TypeError('Comparison execution requires exact explicit local assistant version binding');
    return input;
  }
  const ComparisonRuleResultSchema = z.strictObject({ ruleIndex: count.max(19), ruleKind: z.enum(['output_schema', 'allowed_ids', 'exclusions', 'recommend_any', 'avoid', 'order', 'advisory']),
    classification: z.enum(['objective_contract', 'approved_policy', 'advisory']), automaticFailure: z.boolean(), outcome: RuleOutcomeSchema,
    reason: z.enum(['schema_valid', 'explicit_malformed_output', 'provider_unavailable', 'pending_execution', 'malformed_execution', 'missing_identity',
      'unknown_catalog_id', 'compliant', 'violated', 'outside_profile', 'both_ids_not_present', 'human_review_required']) }).superRefine((row, ctx) => {
    const advisory = row.classification === 'advisory';
    if (advisory !== (row.ruleKind === 'advisory') || advisory !== (row.outcome === 'advisory') || advisory === row.automaticFailure
      || (!advisory && (['output_schema', 'allowed_ids', 'exclusions'].includes(row.ruleKind) !== (row.classification === 'objective_contract')))) ctx.addIssue({ code: 'custom', message: 'Rule result classification/automatic evaluation mismatch' });
  });
  type RuleResult = z.infer<typeof ComparisonRuleResultSchema>;
  /** output_schema is exactly TargetOutputSchema v1 (optional IDs retained, never name-matched).
   * Trace gaps cannot support integrity claims. These supported rules use output IDs only. */
  function evaluateComparisonRules(expectationValue: ApprovedExpectation | Expectation, inputValue: TargetInput, profileId: ProfileId, resultValue: ResultEvidence): RuleResult[] {
    const expectation = z.union([ComparisonExpectationSchema, review.ApprovedExpectationSchema]).parse(expectationValue); const input = foundation.targetInputSchema.parse(inputValue);
    const result = ComparisonResultEvidenceSchema.parse(resultValue);
    if (expectation.classification === 'advisory') return [ComparisonRuleResultSchema.parse({ ruleIndex: 0, ruleKind: 'advisory',
      classification: 'advisory', automaticFailure: false, outcome: 'advisory', reason: 'human_review_required' })];
    return expectation.rules.map((rule, ruleIndex) => {
      let outcome: RuleResult['outcome'] = 'unavailable'; let reason: RuleResult['reason'] = 'pending_execution';
      const inProfile = expectation.classification === 'objective_contract' ? expectation.profiles.includes(profileId) : 'profileId' in rule && rule.profileId === profileId;
      const ids = result.recommendationIds; const missing = ids.some(id => id === null);
      const catalog = new Set(input.catalog.entries.map(row => row.id));
      if (!inProfile) { outcome = 'not_applicable'; reason = 'outside_profile'; }
      else if (result.outcome === 'provider_unavailable') reason = 'provider_unavailable';
      else if (result.outcome === 'pending') reason = 'pending_execution';
      else if (rule.kind === 'output_schema') { outcome = result.outcome === 'malformed_output' ? 'fail' : 'pass'; reason = outcome === 'fail' ? 'explicit_malformed_output' : 'schema_valid'; }
      else if (result.outcome === 'malformed_output') reason = 'malformed_execution';
      else if (missing) reason = 'missing_identity';
      else if (rule.kind !== 'allowed_ids' && ids.some(id => id !== null && !catalog.has(id))) reason = 'unknown_catalog_id';
      else {
        let passes = false;
        switch (rule.kind) {
          case 'allowed_ids': passes = ids.every(id => id !== null && rule.entryIds.includes(id)); break;
          case 'exclusions': case 'avoid': passes = ids.every(id => id !== null && !rule.entryIds.includes(id)); break;
          case 'recommend_any': passes = ids.some(id => id !== null && rule.entryIds.includes(id)); break;
          case 'order': {
            const before = ids.indexOf(rule.beforeEntryId); const after = ids.indexOf(rule.afterEntryId);
            if (before < 0 || after < 0) { outcome = 'not_applicable'; reason = 'both_ids_not_present'; }
            else passes = before < after;
            break;
          }
        }
        if (outcome !== 'not_applicable') { outcome = passes ? 'pass' : 'fail'; reason = passes ? 'compliant' : 'violated'; }
      }
      return ComparisonRuleResultSchema.parse({ ruleIndex, ruleKind: rule.kind, classification: expectation.classification,
        automaticFailure: true, outcome, reason });
    });
  }
  function combinedOutcome(rules: RuleResult[]): RuleResult['outcome'] {
    for (const outcome of ['fail', 'unavailable', 'pass', 'advisory', 'not_applicable'] as const) if (rules.some(rule => rule.outcome === outcome)) return outcome;
    return 'unavailable';
  }
  const ComparisonRepeatResultSchema = z.strictObject({ attemptId: IdSchema, caseId: IdSchema, role: z.enum(['baseline', 'candidate']),
    assistantVersion: AssistantVersionSchema, profileId: z.enum(['a', 'b']), repeat: z.number().int().min(0).max(2), inputChecksum: ChecksumSchema,
    dispatchCount: count.max(144), uncertainDispatches: count.max(144), result: ComparisonResultEvidenceSchema,
    rules: z.array(ComparisonRuleResultSchema).min(1).max(20), outcome: RuleOutcomeSchema });
  type RepeatResult = z.infer<typeof ComparisonRepeatResultSchema>;
  const ComparisonRepeatSummarySchema = z.strictObject({ caseId: IdSchema, role: z.enum(['baseline', 'candidate']), profileId: z.enum(['a', 'b']),
    repeatCount: z.number().int().min(1).max(3), outcomes: z.array(RuleOutcomeSchema).min(1).max(3),
    outcome: z.enum(['pass', 'fail', 'unavailable', 'not_applicable', 'advisory', 'mixed']), disagreement: z.boolean(), behaviorDisagreement: z.boolean() });
  const ComparisonBehaviorChangeSchema = z.strictObject({ caseId: IdSchema, profileId: z.enum(['a', 'b']), repeat: z.number().int().min(0).max(2),
    status: z.enum(['changed', 'unchanged', 'unavailable']), interpretation: z.literal('Behavior change is not evidence of improved taste.') });
  const FinalizeComparisonRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema, id: IdSchema, allowPartial: z.boolean() });
  const CancelComparisonRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema, id: IdSchema });
  const ComparisonFinalReportSchema = z.strictObject({ schema_version: SchemaVersionSchema, report_version: z.literal(COMPARISON_REPORT_VERSION),
    id: IdSchema, comparisonId: IdSchema, projectId: IdSchema, planChecksum: ChecksumSchema, suiteVersionId: IdSchema, suiteChecksum: ChecksumSchema,
    baselineVersion: AssistantVersionSchema, candidateVersion: AssistantVersionSchema, requestChecksum: ChecksumSchema, finalizedAt: TimestampSchema,
    completion: z.enum(['complete', 'partial']), stopReason: z.enum(['completed', 'explicit_partial', 'cancelled', 'deadline_exceeded', 'budget_exhausted']),
    progress: ComparisonProgressSchema, repeats: z.array(ComparisonRepeatResultSchema).min(4).max(120),
    summaries: z.array(ComparisonRepeatSummarySchema).min(4).max(40), behaviorChanges: z.array(ComparisonBehaviorChangeSchema).min(2).max(60),
    limitations: z.array(z.enum(['scoped_policy_only', 'not_individual_taste', 'incomplete_traces', 'partial_execution', 'uncertain_dispatch', 'qloo_not_redistributed', 'pinned_fact_freshness_unknown'])).min(3).max(7),
    checksum: ChecksumSchema,
  }).superRefine((report, ctx) => {
    if (checksum(withoutChecksum(report)) !== report.checksum || !bounded(report, COMPARISON_LIMITS.reportBytes)) ctx.addIssue({ code: 'custom', message: 'Report checksum or byte bound mismatch' });
    if (report.baselineVersion === report.candidateVersion || report.repeats.length !== report.progress.logicalSlots
      || new Set(report.repeats.map(row => row.attemptId)).size !== report.repeats.length) ctx.addIssue({ code: 'custom', message: 'Report must preserve distinct versions and all logical repeats' });
  });
  type Report = z.infer<typeof ComparisonFinalReportSchema>;
  function buildReport(args: { plan: Plan; request: z.infer<typeof FinalizeComparisonRequestSchema>; finalizedAt: string;
    state: z.infer<typeof ComparisonStateSchema>; associations: Association[]; results: Map<string, ResultEvidence> }): Report {
    const { plan } = args; const progress = comparisonProgress(plan, args.associations);
    const partial = progress.completed !== progress.logicalSlots;
    if (partial && !args.request.allowPartial) throw new ComparisonConflictError('Pending work requires waiting or explicit partial finalization');
    const repeats: RepeatResult[] = plan.slots.map(slot => {
      const association = args.associations.find(row => row.attemptId === slot.attemptId); const row = plan.cases.find(row => row.caseId === slot.execution.caseId);
      if (!association || !row) throw new TypeError('Missing planned repeat');
      const result = args.results.get(slot.attemptId) ?? projectComparisonResult(null);
      const rules = evaluateComparisonRules(row.expectation, slot.input, slot.execution.profileId, result);
      return ComparisonRepeatResultSchema.parse({ attemptId: slot.attemptId, caseId: row.caseId, role: slot.execution.role,
        assistantVersion: slot.execution.assistantVersion, profileId: slot.execution.profileId, repeat: slot.execution.repeat, inputChecksum: slot.inputChecksum,
        dispatchCount: association.dispatchCount, uncertainDispatches: association.uncertainDispatches, result, rules, outcome: combinedOutcome(rules) });
    });
    const summaries = plan.cases.flatMap(row => (['baseline', 'candidate'] as const).flatMap(role => (['a', 'b'] as const).map(profileId => {
      const selected = repeats.filter(repeat => repeat.caseId === row.caseId && repeat.role === role && repeat.profileId === profileId);
      const outcomes = selected.map(repeat => repeat.outcome); const disagreement = new Set(outcomes).size > 1;
      const comparable = selected.filter(repeat => repeat.result.outcome === 'success' && repeat.result.recommendationIds.every(id => id !== null));
      return { caseId: row.caseId, role, profileId, repeatCount: row.repeatCount, outcomes, outcome: disagreement ? 'mixed' : outcomes[0], disagreement,
        behaviorDisagreement: new Set(comparable.map(repeat => canonicalJson(repeat.result.recommendationIds))).size > 1 };
    })));
    const behaviorChanges = plan.cases.flatMap(row => (['a', 'b'] as const).flatMap(profileId => Array.from({ length: row.repeatCount }, (_, repeat) => {
      const pair = repeats.filter(result => result.caseId === row.caseId && result.profileId === profileId && result.repeat === repeat);
      const [a, b] = pair;
      const known = a && b && pair.every(result => result.result.outcome === 'success' && result.result.recommendationIds.every(id => id !== null && row.inputs.a.catalog.entries.some(entry => entry.id === id)));
      return { caseId: row.caseId, profileId, repeat, status: !known ? 'unavailable' : same(a.result.recommendationIds, b.result.recommendationIds) ? 'unchanged' : 'changed',
        interpretation: 'Behavior change is not evidence of improved taste.' };
    })));
    const limitations = ['scoped_policy_only', 'not_individual_taste', 'qloo_not_redistributed', 'pinned_fact_freshness_unknown',
      ...(repeats.some(row => row.result.traceCompleteness !== 'complete') ? ['incomplete_traces'] : []),
      ...(partial ? ['partial_execution'] : []), ...(progress.uncertainDispatches ? ['uncertain_dispatch'] : [])];
    const content = { schema_version: plan.schema_version, report_version: COMPARISON_REPORT_VERSION, id: args.request.id, comparisonId: plan.id, projectId: plan.projectId,
      planChecksum: plan.checksum, suiteVersionId: plan.request.suiteVersionId, suiteChecksum: plan.suiteChecksum,
      baselineVersion: plan.request.baselineVersion, candidateVersion: plan.request.candidateVersion, requestChecksum: checksum(args.request),
      finalizedAt: args.finalizedAt, completion: partial ? 'partial' : 'complete',
      stopReason: ['cancelled', 'deadline_exceeded', 'budget_exhausted'].includes(args.state) ? args.state : partial ? 'explicit_partial' : 'completed',
      progress, repeats, summaries, behaviorChanges, limitations };
    return ComparisonFinalReportSchema.parse({ ...content, checksum: checksum(content) });
  }
  const ComparisonFinalizationSourceSchema = z.strictObject({ plan: ComparisonPlanSchema, state: ComparisonStateSchema,
    associations: z.array(ComparisonAttemptAssociationSchema).max(120), attempts: z.array(z.lazy(() => foundation.attemptSchema)).max(120) });
  function prepareComparisonFinalization(args: { request: z.infer<typeof FinalizeComparisonRequestSchema>; source: z.infer<typeof ComparisonFinalizationSourceSchema>; finalizedAt: string }): Report {
    const request = FinalizeComparisonRequestSchema.parse(args.request); const source = ComparisonFinalizationSourceSchema.parse(args.source);
    const associations = validateAssociations(source.plan, source.associations); const results = new Map<string, ResultEvidence>();
    if (source.attempts.length !== source.plan.slots.length || new Set(source.attempts.map(row => row.id)).size !== source.attempts.length) throw new TypeError('Finalization must resolve all typed attempts from one coherent view');
    for (const slot of source.plan.slots) {
      const attempt = source.attempts.find(row => row.id === slot.attemptId); const association = associations.find(row => row.attemptId === slot.attemptId);
      if (!attempt || !association || attempt.projectId !== source.plan.projectId || attempt.inputChecksum !== slot.inputChecksum
        || !same(attempt.input, slot.input) || attempt.status !== association.status) throw new TypeError('Finalization attempt/input/status does not match immutable slot');
      results.set(slot.attemptId, projectComparisonResult(attempt.result));
    }
    return buildReport({ plan: source.plan, request, finalizedAt: TimestampSchema.parse(args.finalizedAt), state: source.state, associations, results });
  }
  function validateComparisonReportAgainstPlan(reportValue: unknown, planValue: Plan): Report {
    const report = ComparisonFinalReportSchema.parse(reportValue); const plan = ComparisonPlanSchema.parse(planValue);
    const associations = report.repeats.map(row => ComparisonAttemptAssociationSchema.parse({ attemptId: row.attemptId, comparisonId: plan.id,
      caseId: row.caseId, role: row.role, assistantVersion: row.assistantVersion, profileId: row.profileId, repeat: row.repeat,
      status: row.result.outcome === 'pending' ? (row.dispatchCount ? 'leased' : 'queued') : 'completed',
      dispatchCount: row.dispatchCount, uncertainDispatches: row.uncertainDispatches, cancelled: false }));
    // Frozen progress retains queued/leased distinctions which result projections alone cannot reconstruct.
    const derivedProgress = comparisonProgress(plan, associations);
    if (derivedProgress.completed !== report.progress.completed || derivedProgress.dispatches !== report.progress.dispatches
      || derivedProgress.reclaims !== report.progress.reclaims || derivedProgress.uncertainDispatches !== report.progress.uncertainDispatches) throw new TypeError('Report progress does not match structural results');
    const state = report.stopReason === 'cancelled' || report.stopReason === 'deadline_exceeded' || report.stopReason === 'budget_exhausted' ? report.stopReason : 'running';
    const expected = buildReport({ plan, request: { schema_version: plan.schema_version, id: report.id, allowPartial: report.completion === 'partial' },
      finalizedAt: report.finalizedAt, state, associations, results: new Map(report.repeats.map(row => [row.attemptId, row.result])) });
    const comparable = { ...expected, progress: report.progress, requestChecksum: report.requestChecksum };
    if (!same(withoutChecksum(comparable), withoutChecksum(report))) throw new TypeError('Report verdicts must be derived from pinned rules and structural results');
    return report;
  }
  function validateComparisonFinalizationRetry(requestValue: unknown, reportValue: unknown, plan: Plan): Report {
    const request = FinalizeComparisonRequestSchema.parse(requestValue); const report = validateComparisonReportAgainstPlan(reportValue, plan);
    if (report.comparisonId !== plan.id || report.projectId !== plan.projectId || report.planChecksum !== plan.checksum
      || report.id !== request.id || report.requestChecksum !== checksum(request)) throw new ComparisonConflictError('Finalization ID already has different immutable content');
    return report;
  }

  const ComparisonRunSchema = z.strictObject({ schema_version: SchemaVersionSchema, plan: ComparisonPlanSchema, state: ComparisonStateSchema,
    progress: ComparisonProgressSchema, cancelledAt: TimestampSchema.nullable(), finalReport: ComparisonFinalReportSchema.nullable() }).superRefine((run, ctx) => {
    if ((run.state === 'finalized') !== (run.finalReport !== null) || (run.finalReport && (run.finalReport.comparisonId !== run.plan.id
      || run.finalReport.planChecksum !== run.plan.checksum || run.finalReport.projectId !== run.plan.projectId))) ctx.addIssue({ code: 'custom', message: 'Final report/run identity mismatch' });
  });
  const ComparisonCreateResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, comparison: ComparisonRunSchema, idempotent: z.boolean() });
  const ComparisonDetailResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, comparison: ComparisonRunSchema, associations: z.array(ComparisonAttemptAssociationSchema).max(120) });
  const ComparisonListItemSchema = z.strictObject({ schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema, suiteVersionId: IdSchema,
    suiteChecksum: ChecksumSchema, planChecksum: ChecksumSchema, baselineVersion: AssistantVersionSchema, candidateVersion: AssistantVersionSchema,
    state: ComparisonStateSchema, progress: ComparisonProgressSchema, createdAt: TimestampSchema, deadlineAt: TimestampSchema,
    cancelledAt: TimestampSchema.nullable(), finalReportChecksum: ChecksumSchema.nullable() });
  function comparisonListItem(runValue: z.infer<typeof ComparisonRunSchema>) {
    const run = ComparisonRunSchema.parse(runValue);
    return ComparisonListItemSchema.parse({ schema_version: run.schema_version, id: run.plan.id, projectId: run.plan.projectId,
      suiteVersionId: run.plan.request.suiteVersionId, suiteChecksum: run.plan.suiteChecksum, planChecksum: run.plan.checksum,
      baselineVersion: run.plan.request.baselineVersion, candidateVersion: run.plan.request.candidateVersion, state: run.state, progress: run.progress,
      createdAt: run.plan.createdAt, deadlineAt: run.plan.request.deadlineAt, cancelledAt: run.cancelledAt, finalReportChecksum: run.finalReport?.checksum ?? null });
  }
  const ComparisonListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, comparisons: z.array(ComparisonListItemSchema).max(20) });
  const ComparisonFinalizeResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, report: ComparisonFinalReportSchema, idempotent: z.boolean() });
  const ComparisonWindowRequestSchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(20).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0) });
  const PortableTestPackSchema = z.strictObject({ schema_version: SchemaVersionSchema, pack_version: z.literal(TEST_PACK_VERSION),
    target_output_contract: z.literal(TARGET_OUTPUT_CONTRACT), plan: ComparisonPlanSchema, checksum: ChecksumSchema }).superRefine((pack, ctx) => {
    if (checksum(withoutChecksum(pack)) !== pack.checksum || !bounded(pack, COMPARISON_LIMITS.packBytes)) ctx.addIssue({ code: 'custom', message: 'Pack checksum or byte bound mismatch' });
    try { assertSafePortableContent(pack.plan); } catch { ctx.addIssue({ code: 'custom', message: 'Unsafe credential-like required input' }); }
  });
  type Pack = z.infer<typeof PortableTestPackSchema>;
  function buildPortableTestPack(planValue: Plan, options: { knownSecrets?: readonly string[] } = {}): Pack {
    const plan = ComparisonPlanSchema.parse(planValue); assertSafePortableContent(plan, options.knownSecrets);
    const content = { schema_version: plan.schema_version, pack_version: TEST_PACK_VERSION, target_output_contract: TARGET_OUTPUT_CONTRACT, plan };
    return PortableTestPackSchema.parse({ ...content, checksum: checksum(content) });
  }
  /** An externally trusted digest authenticates content; a self-checksum alone detects corruption,
   * not maliciously recomputed provenance. Omitted Qloo blobs cannot be rehashed from a pack. */
  function validatePortableTestPack(value: unknown, options: { expectedChecksum?: string; knownSecrets?: readonly string[] } = {}): Pack {
    if (!bounded(value, COMPARISON_LIMITS.packBytes)) throw new TypeError('Pack exceeds byte limit');
    const pack = PortableTestPackSchema.parse(value); assertSafePortableContent(pack.plan, options.knownSecrets);
    if (options.expectedChecksum !== undefined && ChecksumSchema.parse(options.expectedChecksum) !== pack.checksum) throw new TypeError('Pack does not match trusted checksum');
    return pack;
  }
  function parsePortableTestPack(text: string, options: { expectedChecksum?: string; knownSecrets?: readonly string[] } = {}): Pack {
    if (Buffer.byteLength(text, 'utf8') > COMPARISON_LIMITS.packBytes) throw new TypeError('Pack exceeds byte limit');
    return validatePortableTestPack(JSON.parse(text), options);
  }
  const ComparisonReadableReportSchema = z.string().max(COMPARISON_LIMITS.reportBytes).superRefine((text, ctx) => {
    if (Buffer.byteLength(text, 'utf8') > COMPARISON_LIMITS.reportBytes) ctx.addIssue({ code: 'custom', message: 'Readable report exceeds byte limit' });
    try { assertSafePortableContent(text); } catch { ctx.addIssue({ code: 'custom', message: 'Unsafe credential-like report content' }); }
  });
  function renderComparisonReport(reportValue: Report): string {
    const report = ComparisonFinalReportSchema.parse(reportValue);
    assertSafePortableContent(report);
    return [`TasteCase comparison ${report.comparisonId}`, `Suite ${report.suiteVersionId} (${report.suiteChecksum})`,
      `Baseline: ${report.baselineVersion}`, `Candidate: ${report.candidateVersion}`, `Completion: ${report.completion}; ${report.stopReason}`,
      `Completed ${report.progress.completed}/${report.progress.logicalSlots}; dispatch charges ${report.progress.dispatches}; uncertain ${report.progress.uncertainDispatches}`,
      ...report.summaries.map(row => `${row.caseId} ${row.role}/${row.profileId}: ${row.outcome}; repeats ${row.outcomes.join(', ')}; disagreement ${row.disagreement}`),
      'Passing an approved policy establishes only compliance with that scoped rule.', 'Changed recommendations are behavior changes, not proof of improved taste.',
      ...report.limitations.map(limit => `Limit: ${limit}`), `Report checksum: ${report.checksum}`].join('\n');
  }
  const ReplayReportSchema = z.strictObject({ schema_version: SchemaVersionSchema, replay_version: z.literal('tastecase-replay-report/1'),
    packChecksum: ChecksumSchema, comparisonReport: ComparisonFinalReportSchema, checksum: ChecksumSchema }).refine(row => checksum(withoutChecksum(row)) === row.checksum, 'Replay report checksum mismatch');
  function validateReplayReport(value: unknown, packValue: Pack) {
    const pack = validatePortableTestPack(packValue); const report = ReplayReportSchema.parse(value);
    if (report.packChecksum !== pack.checksum) throw new TypeError('Replay report belongs to another pack');
    validateComparisonReportAgainstPlan(report.comparisonReport, pack.plan);
    return report;
  }
  /** Local adapters only. All package/schema/checksum/binding validation finishes before first
   * dispatch. Caller explicitly binds both labels to adapter objects; never map labels to models. */
  async function replayPortableTestPack(args: { pack: unknown; expectedChecksum?: string; knownSecrets?: readonly string[];
    bindings: { baseline: { assistantVersion: string; adapter: TargetAdapter }; candidate: { assistantVersion: string; adapter: TargetAdapter } };
    signal: AbortSignal; reportId: string; finalizedAt: string }) {
    const pack = validatePortableTestPack(args.pack, { expectedChecksum: args.expectedChecksum, knownSecrets: args.knownSecrets });
    const plan = pack.plan;
    if (args.bindings.baseline.assistantVersion !== plan.request.baselineVersion || args.bindings.candidate.assistantVersion !== plan.request.candidateVersion
      || typeof args.bindings.baseline.adapter?.run !== 'function' || typeof args.bindings.candidate.adapter?.run !== 'function') throw new TypeError('Replay requires exact explicit local assistant version bindings');
    const request = FinalizeComparisonRequestSchema.parse({ schema_version: plan.schema_version, id: args.reportId, allowPartial: true });
    const finalizedAt = TimestampSchema.parse(args.finalizedAt); const associations = initialComparisonAssociations(plan); const results = new Map<string, ResultEvidence>();
    const replayDeadline = Date.now() + Math.min(COMPARISON_LIMITS.deadlineSeconds * 1000, Date.parse(plan.request.deadlineAt) - Date.parse(plan.createdAt));
    const dispatchSignal = AbortSignal.any([args.signal, AbortSignal.timeout(Math.max(1, replayDeadline - Date.now()))]);
    for (const slot of plan.slots) {
      if (dispatchSignal.aborted) break;
      const association = associations.find(row => row.attemptId === slot.attemptId);
      if (!association) throw new TypeError('Missing replay slot');
      association.dispatchCount = 1; association.status = 'leased';
      let result: TargetResult;
      const interrupted = Symbol('interrupted'); let stopAwaiting: () => void = () => {};
      const cancellation = new Promise<typeof interrupted>(resolve => { stopAwaiting = () => resolve(interrupted); dispatchSignal.addEventListener('abort', stopAwaiting, { once: true }); });
      try {
        const localInput = foundation.targetInputSchema.parse(slot.input);
        const execution = Promise.resolve().then(() => args.bindings[slot.execution.role].adapter.run(localInput, { signal: dispatchSignal }));
        const value = await Promise.race([execution, cancellation]);
        if (value === interrupted) { association.uncertainDispatches = 1; break; }
        result = foundation.targetResultSchema.parse(value);
      } catch {
        if (dispatchSignal.aborted) { association.uncertainDispatches = 1; break; }
        result = { schema_version: plan.schema_version, outcome: 'provider_unavailable', error: { code: 'local_adapter_unavailable', message: 'Local adapter execution was unavailable.' }, retryable: false, trace: { completeness: 'unavailable', events: [] } };
      } finally { dispatchSignal.removeEventListener('abort', stopAwaiting); }
      association.status = 'completed'; results.set(slot.attemptId, projectComparisonResult(result));
    }
    const comparisonReport = buildReport({ plan, request, finalizedAt, state: args.signal.aborted ? 'cancelled' : dispatchSignal.aborted ? 'deadline_exceeded' : 'running', associations, results });
    const content = { schema_version: plan.schema_version, replay_version: 'tastecase-replay-report/1', packChecksum: pack.checksum, comparisonReport };
    assertSafePortableContent(content, args.knownSecrets);
    return ReplayReportSchema.parse({ ...content, checksum: checksum(content) });
  }
  return { CreateComparisonRequestSchema, ComparisonEvidenceReferenceSchema, ComparisonExpectationSchema, ComparisonCaseSchema, ComparisonSlotSchema, ComparisonPlanSchema,
    ComparisonAttemptAssociationSchema, ComparisonStateSchema, ComparisonProgressSchema, ComparisonResultEvidenceSchema, ComparisonRuleResultSchema,
    ComparisonRepeatResultSchema, ComparisonRepeatSummarySchema, ComparisonBehaviorChangeSchema, FinalizeComparisonRequestSchema, CancelComparisonRequestSchema,
    ComparisonFinalReportSchema, ComparisonFinalizationSourceSchema, ComparisonRunSchema, ComparisonCreateResponseSchema, ComparisonDetailResponseSchema,
    ComparisonListItemSchema, ComparisonListResponseSchema, ComparisonFinalizeResponseSchema, ComparisonWindowRequestSchema, ComparisonReadableReportSchema, PortableTestPackSchema, ReplayReportSchema, comparisonListItem,
    deriveSyntheticFullProfileInput, projectComparisonCase, prepareComparisonPlan, comparisonExecutionRows, validateComparisonRetry, validateComparisonPlanAgainstSuite, comparisonAttemptId,
    initialComparisonAssociations, comparisonProgress, comparisonClaimAllowed, validateComparisonRunnerBinding, projectComparisonResult, evaluateComparisonRules,
    prepareComparisonFinalization, validateComparisonFinalizationRetry, validateComparisonReportAgainstPlan, buildPortableTestPack, validatePortableTestPack, parsePortableTestPack, renderComparisonReport, replayPortableTestPack, validateReplayReport };
}
export type ComparisonContracts = ReturnType<typeof createComparisonContracts>;
export type CreateComparisonRequest = z.infer<ComparisonContracts['CreateComparisonRequestSchema']>;
export type ComparisonPlan = z.infer<ComparisonContracts['ComparisonPlanSchema']>;
export type ComparisonCase = z.infer<ComparisonContracts['ComparisonCaseSchema']>;
export type ComparisonExpectation = z.infer<ComparisonContracts['ComparisonExpectationSchema']>;
export type ComparisonExecutionRow = ReturnType<ComparisonContracts['comparisonExecutionRows']>[number];
export type ComparisonListItem = z.infer<ComparisonContracts['ComparisonListItemSchema']>;
export type ComparisonSlot = z.infer<ComparisonContracts['ComparisonSlotSchema']>;
export type ComparisonAttemptAssociation = z.infer<ComparisonContracts['ComparisonAttemptAssociationSchema']>;
export type ComparisonState = z.infer<ComparisonContracts['ComparisonStateSchema']>;
export type ComparisonProgress = z.infer<ComparisonContracts['ComparisonProgressSchema']>;
export type ComparisonResultEvidence = z.infer<ComparisonContracts['ComparisonResultEvidenceSchema']>;
export type ComparisonRuleResult = z.infer<ComparisonContracts['ComparisonRuleResultSchema']>;
export type ComparisonRepeatResult = z.infer<ComparisonContracts['ComparisonRepeatResultSchema']>;
export type ComparisonFinalReport = z.infer<ComparisonContracts['ComparisonFinalReportSchema']>;
export type ComparisonFinalizationSource = z.infer<ComparisonContracts['ComparisonFinalizationSourceSchema']>;
export type ComparisonRun = z.infer<ComparisonContracts['ComparisonRunSchema']>;
export type FinalizeComparisonRequest = z.infer<ComparisonContracts['FinalizeComparisonRequestSchema']>;
export type CancelComparisonRequest = z.infer<ComparisonContracts['CancelComparisonRequestSchema']>;
export type PortableTestPack = z.infer<ComparisonContracts['PortableTestPackSchema']>;
export type ReplayReport = z.infer<ComparisonContracts['ReplayReportSchema']>;
