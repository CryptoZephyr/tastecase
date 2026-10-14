import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import {
  checksum, canonicalJson, computeDiscoveryFacts, CreateDiscoveryJobRequestSchema, PinnedDiscoveryInputSchema,
  ReviewCaseResponseSchema, ReviewDecisionResponseSchema, SuiteIdentitySchema, PublishSuiteResponseSchema,
  CreateComparisonRequestSchema, ComparisonCreateResponseSchema, ComparisonDetailResponseSchema, ComparisonListResponseSchema,
  ComparisonFinalizeResponseSchema, ComparisonFinalizationSourceSchema, prepareComparisonPlan, comparisonExecutionRows,
  initialComparisonAssociations, prepareComparisonFinalization, validateComparisonReportAgainstPlan, buildPortableTestPack,
  validatePortableTestPack, evaluateComparisonRules, projectComparisonResult,
  type CreateComparisonRequest, type ComparisonPlan, type TargetResult, type ApprovedExpectation,
} from '@tastecase/contracts';
import { assertLocalTestDatabase, applyMigrations, bootstrapLocalTest, loadMigrations } from '../apps/api/src/migrate.js';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55432/tastecase_test';
assertLocalTestDatabase(connectionString);
const schema_version = '1.0.0' as const;
const createSQL = 'SELECT public.create_comparison($1,$2,$3) AS value';
const reserveSQL = 'SELECT public.reserve_comparison_dispatch($1,$2,$3,$4,$5,$6) AS value';
const finalizeSQL = 'SELECT public.finalize_comparison($1,$2,$3,$4) AS value';
const tables = ['comparison_runs', 'comparison_state', 'comparison_cases', 'comparison_targets', 'comparison_dispatches', 'comparison_cancellations', 'comparison_reports', 'comparison_artifacts'];

async function fixture(client: pg.Client | pg.PoolClient, projectId = randomUUID(), ownerId = randomUUID(), repeatCount = 3) {
  const jobId = randomUUID(); const catalogId = randomUUID(); const taskId = randomUUID(); const candidateId = randomUUID(); const credentialId = randomUUID();
  const createdAt = new Date().toISOString();
  const catalog = { schema_version, id: catalogId, label: 'Synthetic Gate 4 catalog', entries: ['one', 'two', 'excluded'].map(id => ({ id, name: `Synthetic ${id}` })) };
  const task = { schema_version, id: taskId, label: 'Synthetic Gate 4 task', catalogVersionId: catalogId,
    syntheticBrief: { provenance: 'synthetic' as const, label: 'Fictional lunch', text: 'An explicitly fictional lunch.' }, syntheticInterests: [],
    constraints: { partySize: 2, dietaryRequirements: ['vegetarian'], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: ['excluded'] } };
  const mappings = ['one', 'two'].map(catalogEntryId => ({ schema_version, id: randomUUID(), projectId, catalogVersionId: catalogId, catalogEntryId, qlooEntityId: randomUUID(), confirmedBy: ownerId, createdAt }));
  const request = CreateDiscoveryJobRequestSchema.parse({ schema_version, id: jobId, catalogVersionId: catalogId, taskVersionId: taskId, repeatCount,
    mappingConfirmationIds: mappings.map(row => row.id), eligibleCatalogEntryIds: ['one', 'two'], assistantVersion: 'old-discovery-only',
    profiles: ['a', 'b'].map(id => ({ id, label: `Synthetic ${id}`, provenance: 'public_synthetic', anchors: [{ id: randomUUID(), kind: 'film', label: `Public ${id} concept`, confirmedEntityId: randomUUID() }] })) });
  const input = PinnedDiscoveryInputSchema.parse({ schema_version, request, targetInput: { schema_version, projectId,
    catalog: { ...catalog, projectId, checksum: checksum(catalog), createdAt }, task: { ...task, projectId, checksum: checksum(task), createdAt }, mappings, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds } });
  await client.query('INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [projectId, ownerId, 'Synthetic Gate 4 SQL owner']);
  await client.query('INSERT INTO public.catalog_versions(id,project_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5)', [catalogId, projectId, JSON.stringify(catalog), checksum(catalog), createdAt]);
  await client.query('INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)', [taskId, projectId, catalogId, JSON.stringify(task), checksum(task), createdAt]);
  for (const mapping of mappings) await client.query('INSERT INTO public.mapping_confirmations(id,project_id,catalog_version_id,catalog_entry_id,qloo_entity_id,confirmed_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [mapping.id, projectId, catalogId, mapping.catalogEntryId, mapping.qlooEntityId, ownerId, createdAt]);
  await client.query('INSERT INTO public.runner_credentials(id,project_id,label,token_hash) VALUES($1,$2,$3,$4)', [credentialId, projectId, 'Synthetic local runner', checksum(randomUUID())]);
  await client.query("INSERT INTO public.discovery_jobs(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '900 seconds')", [jobId, projectId, catalogId, taskId, JSON.stringify(input), checksum(input), createdAt]);
  const confirmations = (await client.query('SELECT id,anchor_id FROM public.discovery_anchor_confirmations WHERE job_id=$1', [jobId])).rows as { id: string; anchor_id: string }[];
  const rankIds: [string, string] = [randomUUID(), randomUUID()];
  const ranks = (['a', 'b'] as const).map(profileId => ({ kind: 'rank' as const, profileId, scope: 'full' as const, providerStatus: 'ok' as const,
    requestedEntryIds: ['one', 'two'], orderedEntryIds: profileId === 'a' ? ['one', 'two'] : ['two', 'one'], missingEntryIds: [], unmappedEntryIds: [],
    mappingConfirmationIds: mappings.map(row => row.id), anchorConfirmationIds: confirmations.filter(c => request.profiles.find(p => p.id === profileId)?.anchors.some(a => a.id === c.anchor_id)).map(c => c.id) }));
  const [a, b] = ranks; assert.ok(a && b);
  const facts = computeDiscoveryFacts(jobId, rankIds, a, b); const factId = randomUUID();
  for (const [index, data] of [...ranks, facts].entries()) await client.query('INSERT INTO public.discovery_tool_evidence(id,project_id,job_id,data,checksum,captured_at) VALUES($1,$2,$3,$4,$5,$6)', [rankIds[index] ?? factId, projectId, jobId, JSON.stringify(data), checksum(data), createdAt]);
  const briefs = { a: { ...task.syntheticBrief, text: 'Synthetic profile a, full brief.' }, b: { ...task.syntheticBrief, text: 'Synthetic profile b, full brief.' }, constraints: task.constraints, eligibleCatalogEntryIds: request.eligibleCatalogEntryIds };
  const contrast = facts.contrasts[0]; assert.ok(contrast);
  // No discovery target exists: unfinished published evidence must still produce
  // fresh full tasks, rather than borrowing an old result or mutable job state.
  const candidate = { contrast, briefs, evidenceIds: [...rankIds, factId], targetAttemptIds: [],
    proposedExpectation: { classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: contrast.id, rationale: 'Order reversal remains advisory.' }, limitations: ['Explicitly synthetic local fixture.'] };
  await client.query('INSERT INTO public.discovery_candidates(id,project_id,job_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)', [candidateId, projectId, jobId, JSON.stringify(candidate), checksum(candidate), createdAt]);
  await client.query("UPDATE public.discovery_job_state SET state='partial',checkpoint=6,checkpoint_data=$2,revision=revision+1,reason='Synthetic missing target results.' WHERE job_id=$1", [jobId, JSON.stringify({ evidenceIds: [...rankIds, factId], candidateIds: [candidateId] })]);
  const reviewCase = ReviewCaseResponseSchema.parse((await client.query('SELECT public.create_review_case($1,$2,$3) AS value', [projectId, ownerId, JSON.stringify({ schema_version, id: randomUUID(), jobId, candidateId })])).rows[0].value);
  const review = ReviewDecisionResponseSchema.parse((await client.query('SELECT public.record_review_decision($1,$2,$3,$4) AS value', [projectId, ownerId, reviewCase.case.id,
    JSON.stringify({ schema_version, id: randomUUID(), expectedRevision: 0, action: 'edit', rationale: 'Approved only these scoped output rules.', expectation: { classification: 'objective_contract', automaticFailure: true, profiles: ['a', 'b'], rules: [{ kind: 'output_schema' }, { kind: 'allowed_ids', entryIds: ['one', 'two'] }, { kind: 'exclusions', entryIds: ['excluded'] }] } })])).rows[0].value);
  assert.ok(review.review.expectationVersion);
  const identity = SuiteIdentitySchema.parse((await client.query('SELECT public.create_suite($1,$2,$3) AS value', [projectId, ownerId, JSON.stringify({ schema_version, id: randomUUID(), name: 'Synthetic release suite' })])).rows[0].value);
  const publication = PublishSuiteResponseSchema.parse((await client.query('SELECT public.publish_suite($1,$2,$3) AS value', [projectId, ownerId, JSON.stringify({ schema_version, id: randomUUID(), suiteId: identity.id, expectedVersion: 0, cases: [{ caseId: reviewCase.case.id, expectationVersionId: review.review.expectationVersion.id, expectedReviewRevision: 1 }] })])).rows[0].value);
  const body = (overrides: Partial<CreateComparisonRequest> = {}): CreateComparisonRequest => CreateComparisonRequestSchema.parse({ schema_version, id: randomUUID(), suiteVersionId: publication.suite.id, baselineVersion: 'release-baseline', candidateVersion: 'release-candidate', caseIds: [reviewCase.case.id], deadlineAt: new Date(Date.now() + 300_000).toISOString(), dispatchBudget: 4 * repeatCount + 2, reclaimBudget: 2, ...overrides });
  return { projectId, ownerId, jobId, credentialId, input, reviewCase, publication, body };
}

test('Gate 4 SQL: immutable published comparisons and bounded dispatch history', async t => {
  const client = new pg.Client({ connectionString }); await client.connect();
  let serial = 0;
  async function fails(sql: string, params: unknown[] = [], code = '23514') {
    const savepoint = `comparison_${serial++}`; await client.query(`SAVEPOINT ${savepoint}`);
    try { await assert.rejects(client.query(sql, params), (e: unknown) => e instanceof Error && 'code' in e && e.code === code); }
    finally { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await client.query(`RELEASE SAVEPOINT ${savepoint}`); }
  }
  try {
    const migrations = await loadMigrations();
    const pool = new pg.Pool({ connectionString, max: 1 }); const setup = await pool.connect();
    try {
      await setup.query('BEGIN'); await bootstrapLocalTest(setup);
      await applyMigrations(setup, migrations);
      await setup.query('COMMIT');
    } finally { setup.release(); await pool.end(); }
    await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext('tastecase:migrations'))");
    const original = migrations.find(m => m.name === '202610130005_comparisons.sql'); assert.ok(original);
    await client.query(original.sql); await client.query(original.sql);
    for (const migration of migrations.filter(m => m.name > original.name)) await client.query(migration.sql);
    const f = await fixture(client); const other = await fixture(client); const sibling = await fixture(client, f.projectId, f.ownerId, 1);
    const create = async (body: CreateComparisonRequest) => ComparisonCreateResponseSchema.parse((await client.query(createSQL, [f.projectId, f.ownerId, JSON.stringify(body)])).rows[0].value);
    const body = f.body(); const first = await create(body); const plan = first.comparison.plan;
    const detail = async (id = plan.id) => ComparisonDetailResponseSchema.parse((await client.query('SELECT public.get_comparison($1,$2,$3) AS value', [f.projectId, f.ownerId, id])).rows[0].value);
    const reserve = async (slot: ComparisonPlan['slots'][number], lease = randomUUID(), seconds = 30) => (await client.query(reserveSQL, [f.projectId, slot.attemptId, lease, f.credentialId, seconds, slot.execution.assistantVersion])).rows[0].value as boolean;
    async function upload(slot: ComparisonPlan['slots'][number], result: TargetResult) {
      await client.query("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1", [slot.attemptId, JSON.stringify(result), checksum(result)]);
    }
    const success = (id: string): TargetResult => ({ schema_version, outcome: 'success', output: { recommendations: [{ catalogEntryId: id, name: 'Synthetic name omitted from artifacts', reason: 'Private target reason omitted.' }] }, trace: { completeness: 'partial', events: [] } });

    await t.test('byte-for-byte plan, task, slot, pack and execution rows match shared contracts', async () => {
      assert.deepEqual(plan, prepareComparisonPlan({ request: body, suite: f.publication.suite, projectId: f.projectId, createdAt: plan.createdAt }));
      assert.equal(plan.slots.length, 12); assert.deepEqual(first.comparison.progress, { logicalSlots: 12, queued: 12, leased: 0, completed: 0, dispatches: 0, reclaims: 0, uncertainDispatches: 0 });
      assert.deepEqual((await detail()).associations, initialComparisonAssociations(plan));
      const rows = (await client.query('SELECT t.attempt_id,t.project_id,t.comparison_id,t.case_id,t.role,t.assistant_version,t.profile_id,t.repeat,a.catalog_version_id,a.task_version_id,(SELECT coalesce(jsonb_agg(m.mapping_confirmation_id ORDER BY n),\'[]\') FROM jsonb_array_elements(a.pinned_input->\'mappings\') WITH ORDINALITY p(v,n) JOIN public.target_attempt_mappings m ON m.attempt_id=a.id AND m.mapping_confirmation_id=(p.v->>\'id\')::uuid) AS mapping_confirmation_ids,a.pinned_input,a.input_checksum FROM public.comparison_targets t JOIN public.target_attempts a ON a.id=t.attempt_id WHERE t.comparison_id=$1 ORDER BY t.ordinal', [plan.id])).rows;
      assert.deepEqual(rows, comparisonExecutionRows(plan));
      const pack = validatePortableTestPack((await client.query('SELECT public.export_comparison_artifact($1,$2,$3,\'pack\') AS value', [f.projectId, f.ownerId, plan.id])).rows[0].value);
      assert.deepEqual(pack, buildPortableTestPack(plan));
      assert.equal(canonicalJson(pack).includes('orderedEntryIds'), false);
      assert.equal(canonicalJson(pack).includes('providerAttempts'), false);
      assert.equal(canonicalJson(pack).includes('targetAttemptIds'), false);
    });
    await t.test('creation retries retain original receipt and cannot queue twice or forge project/suite/cases', async () => {
      assert.deepEqual(await create(body), { ...first, idempotent: true });
      for (const changed of [{ ...body, candidateVersion: 'other-label' }, { ...body, caseIds: [sibling.reviewCase.case.id] }]) await fails(createSQL, [f.projectId, f.ownerId, JSON.stringify(changed)], '23505');
      for (const changed of [{ ...f.body(), suiteVersionId: other.publication.suite.id }, { ...f.body(), caseIds: [sibling.reviewCase.case.id] }, { ...f.body(), caseIds: [other.reviewCase.case.id] }]) await fails(createSQL, [f.projectId, f.ownerId, JSON.stringify(changed)], '23503');
      await fails(createSQL, [f.projectId, other.ownerId, JSON.stringify(f.body())], '42501');
      for (const changed of [{ ...f.body(), snapshot: f.publication.suite }, { ...f.body(), caseIds: [] }, { ...f.body(), caseIds: [f.reviewCase.case.id, f.reviewCase.case.id] }, { ...f.body(), baselineVersion: 'release-candidate' }, { ...f.body(), dispatchBudget: 11 }, { ...f.body(), dispatchBudget: 15 }, { ...f.body(), reclaimBudget: 25 }, { ...f.body(), deadlineAt: new Date(Date.now() + 3_700_000).toISOString() }, { ...f.body(), baselineVersion: 'password=not-a-real-fixture-secret' }, { ...f.body(), caseIds: Array.from({ length: 11 }, () => randomUUID()) }]) await fails(createSQL, [f.projectId, f.ownerId, JSON.stringify(changed)]);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM public.comparison_targets WHERE comparison_id=$1', [plan.id])).rows[0].n, 12);
    });
    await t.test('FORCE owner read, denied writes/TRUNCATE and RPC EXECUTE including service direct writes', async () => {
      const forced = (await client.query('SELECT count(*)::int AS n FROM pg_class WHERE relname=ANY($1) AND relrowsecurity AND relforcerowsecurity', [tables])).rows[0].n;
      assert.equal(forced, tables.length);
      await client.query('SET LOCAL ROLE authenticated'); await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [f.ownerId]);
      assert.equal((await client.query('SELECT id FROM public.comparison_runs WHERE project_id=$1', [f.projectId])).rowCount, 1);
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [other.ownerId]);
      for (const table of tables) {
        assert.equal((await client.query(`SELECT project_id FROM public.${table} WHERE project_id=$1`, [f.projectId])).rowCount, 0);
        for (const statement of [`UPDATE public.${table} SET project_id=project_id`, `DELETE FROM public.${table}`, `TRUNCATE public.${table}`]) await fails(statement, [], '42501');
      }
      for (const role of ['authenticated', 'anon']) {
        await client.query(`SET LOCAL ROLE ${role}`);
        for (const [query, params] of [[createSQL, [f.projectId, f.ownerId, JSON.stringify(body)]], ['SELECT public.export_comparison_artifact($1,$2,$3,\'pack\')', [f.projectId, f.ownerId, plan.id]], [reserveSQL, [f.projectId, plan.slots[0]?.attemptId, randomUUID(), f.credentialId, 30, body.baselineVersion]], [finalizeSQL, [f.projectId, f.ownerId, plan.id, JSON.stringify({ schema_version, id: randomUUID(), allowPartial: true })]] ] as const) await fails(query, [...params], '42501');
      }
      await client.query('RESET ROLE'); await client.query('SET LOCAL ROLE service_role');
      await fails('UPDATE public.comparison_state SET state=\'running\' WHERE comparison_id=$1', [plan.id], '42501');
      await fails('SELECT public.get_comparison($1,$2,$3)', [f.projectId, other.ownerId, plan.id], '42501');
      await client.query('RESET ROLE');
    });
    await t.test('exact release filtering, atomic charges, retry conflict and denied unreserved lease', async () => {
      const slot = plan.slots[0]; assert.ok(slot); const lease = randomUUID();
      for (const version of [null, 'wrong-label', body.candidateVersion]) assert.equal((await client.query('SELECT public.comparison_target_claimable($1,$2) AS value', [slot.attemptId, version])).rows[0].value, false);
      assert.equal((await client.query('SELECT public.comparison_target_claimable($1,$2) AS value', [slot.attemptId, body.baselineVersion])).rows[0].value, true);
      assert.equal((await client.query(reserveSQL, [f.projectId, slot.attemptId, lease, f.credentialId, 30, null])).rows[0].value, false);
      await fails("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1", [slot.attemptId, randomUUID(), f.credentialId]);
      assert.equal(await reserve(slot, lease), true); assert.equal(await reserve(slot, lease), true);
      await fails(reserveSQL, [f.projectId, slot.attemptId, lease, f.credentialId, 31, body.baselineVersion], '23505');
      assert.equal(await reserve(slot), false);
      assert.equal((await detail()).comparison.progress.dispatches, 1);
      await upload(slot, success('one'));
    });
    await t.test('authoritative coherent finalization waits, preserves mixed repeats and projects raw results safely', async () => {
      const pendingRequest = { schema_version, id: randomUUID(), allowPartial: false };
      await fails(finalizeSQL, [f.projectId, f.ownerId, plan.id, JSON.stringify(pendingRequest)], '40001');
      const slots = plan.slots.slice(1, 5);
      for (const [index, slot] of slots.entries()) {
        assert.equal(await reserve(slot), true);
        await upload(slot, index === 0 ? { schema_version, outcome: 'provider_unavailable', error: { code: 'unavailable', message: 'Provider detail is never exported.' }, retryable: false, trace: { completeness: 'unavailable', events: [] } } : index === 1 ? { schema_version, outcome: 'malformed_output', rawText: 'Raw malformed text never exported.', error: { code: 'invalid_output', message: 'Synthetic schema error.' }, trace: { completeness: 'partial', events: [] } } : success(index === 2 ? 'two' : 'excluded'));
      }
      const request = { schema_version, id: randomUUID(), allowPartial: true };
      const source = ComparisonFinalizationSourceSchema.parse((await client.query('SELECT public.tastecase_comparison_source($1,$2,clock_timestamp()) AS value', [f.projectId, plan.id])).rows[0].value);
      const response = ComparisonFinalizeResponseSchema.parse((await client.query(finalizeSQL, [f.projectId, f.ownerId, plan.id, JSON.stringify(request)])).rows[0].value);
      const report = validateComparisonReportAgainstPlan(response.report, plan);
      assert.deepEqual(report, prepareComparisonFinalization({ request, source, finalizedAt: report.finalizedAt }));
      assert.equal(report.completion, 'partial'); assert.ok(report.summaries.some(row => row.disagreement && row.outcome === 'mixed'));
      const unavailable = report.repeats.find(row => row.result.outcome === 'provider_unavailable'); assert.ok(unavailable); assert.ok(unavailable.rules.every(row => row.outcome === 'unavailable'));
      assert.ok(report.repeats.some(row => row.rules.some(rule => rule.reason === 'explicit_malformed_output' && rule.outcome === 'fail')));
      for (const text of ['Provider detail', 'Raw malformed text', 'Private target reason', 'Synthetic name omitted', 'leaseCredentialId', 'events']) assert.equal(canonicalJson(report).includes(text), false);
      assert.deepEqual(ComparisonFinalizeResponseSchema.parse((await client.query(finalizeSQL, [f.projectId, f.ownerId, plan.id, JSON.stringify(request)])).rows[0].value), { ...response, idempotent: true });
      await fails(finalizeSQL, [f.projectId, f.ownerId, plan.id, JSON.stringify({ ...request, allowPartial: false })], '23505');
      await fails(finalizeSQL, [f.projectId, f.ownerId, plan.id, JSON.stringify({ ...request, id: randomUUID() })], '23505');
      const pendingSlot = plan.slots[5]; assert.ok(pendingSlot); assert.equal(await reserve(pendingSlot), false);
      for (const table of tables.filter(table => !['comparison_state', 'comparison_cancellations'].includes(table))) await fails(`UPDATE public.${table} SET project_id=project_id WHERE ${table === 'comparison_runs' ? 'id' : 'comparison_id'}=$1`, [plan.id]);
      await fails('UPDATE public.comparison_state SET state=\'running\' WHERE comparison_id=$1', [plan.id]);
      assert.deepEqual((await detail()).comparison.finalReport, report);
      assert.deepEqual((await client.query('SELECT public.export_comparison_artifact($1,$2,$3,\'report\') AS value', [f.projectId, f.ownerId, plan.id])).rows[0].value, report);
    });
    await t.test('SQL supported rules match reviewed contracts for unavailable, missing identity and conditional ordering', async () => {
      const expectations: ApprovedExpectation[] = [
        { classification: 'objective_contract', automaticFailure: true, profiles: ['a'], rules: [{ kind: 'output_schema' }, { kind: 'allowed_ids', entryIds: ['one', 'two'] }, { kind: 'exclusions', entryIds: ['excluded'] }] },
        { classification: 'approved_policy', automaticFailure: true, rules: [{ kind: 'recommend_any', profileId: 'a', entryIds: ['one'] }, { kind: 'avoid', profileId: 'a', entryIds: ['two'] }, { kind: 'order', profileId: 'a', beforeEntryId: 'one', afterEntryId: 'two', whenBothPresent: true }] },
        { classification: 'advisory', automaticFailure: false, humanReviewRequired: true, contrastId: randomUUID(), rationale: 'Reviewed advisory only.' },
      ];
      const results: (TargetResult | null)[] = [null, success('one'), success('excluded'), success('outside'),
        { schema_version, outcome: 'success', output: { recommendations: [{ name: 'No stable identity' }] }, trace: { completeness: 'unavailable', events: [] } },
        { schema_version, outcome: 'success', output: { recommendations: [{ catalogEntryId: 'two', name: 'Two' }, { catalogEntryId: 'one', name: 'One' }] }, trace: { completeness: 'complete', events: [] } },
        { schema_version, outcome: 'provider_unavailable', error: { code: 'unavailable', message: 'Synthetic unavailable' }, retryable: false, trace: { completeness: 'unavailable', events: [] } },
        { schema_version, outcome: 'malformed_output', rawText: 'Synthetic malformed', error: { code: 'invalid', message: 'Synthetic malformed' }, trace: { completeness: 'partial', events: [] } },
      ];
      const input = plan.cases[0]?.inputs.a; assert.ok(input);
      for (const expectation of expectations) for (const result of results) for (const profileId of ['a', 'b'] as const) {
        const evidence = projectComparisonResult(result);
        const actual = (await client.query('SELECT public.tastecase_comparison_rules($1,$2,$3,$4) AS value', [JSON.stringify(expectation), JSON.stringify(input), profileId, JSON.stringify(evidence)])).rows[0].value;
        assert.deepEqual(actual, evaluateComparisonRules(expectation, input, profileId, evidence));
      }
      const legacyId = randomUUID();
      await client.query('INSERT INTO public.target_attempts(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum) VALUES($1,$2,$3,$4,$5,$6)', [legacyId, f.projectId, f.input.targetInput.catalog.id, f.input.targetInput.task.id, JSON.stringify(f.input.targetInput), checksum(f.input.targetInput)]);
      assert.equal((await client.query('SELECT public.comparison_target_claimable($1) AS value', [legacyId])).rows[0].value, true);
      assert.equal((await client.query(reserveSQL, [f.projectId, legacyId, randomUUID(), f.credentialId, 30, null])).rows[0].value, true);
      assert.equal((await client.query('SELECT status FROM public.target_attempts WHERE id=$1', [legacyId])).rows[0].status, 'queued');
    });
    await t.test('historical re-review cannot rewrite comparison pins or original create receipt', async () => {
      await client.query('SELECT public.record_review_decision($1,$2,$3,$4)', [f.projectId, f.ownerId, f.reviewCase.case.id, JSON.stringify({ schema_version, id: randomUUID(), expectedRevision: 1, action: 'reject', rationale: 'Later independent review.' })]);
      assert.deepEqual((await create(f.body())).comparison.plan.cases, plan.cases);
      assert.deepEqual(await create(body), { ...first, idempotent: true });
      const list = ComparisonListResponseSchema.parse((await client.query('SELECT public.list_comparisons($1,$2,20,0) AS value', [f.projectId, f.ownerId])).rows[0].value);
      assert.equal(list.comparisons.length, 2); assert.ok(list.comparisons.every(row => !('plan' in row) && !('finalReport' in row)));
      await fails('SELECT public.list_comparisons($1,$2,21,0)', [f.projectId, f.ownerId]);
    });
    await t.test('cancellation freezes receipt, stops new claims and keeps already dispatched late uploads live', async () => {
      const run = await create(f.body()); const slot = run.comparison.plan.slots[0]; assert.ok(slot); assert.equal(await reserve(slot), true);
      const request = { schema_version, id: randomUUID() };
      const cancel = (await client.query('SELECT public.cancel_comparison($1,$2,$3,$4) AS value', [f.projectId, f.ownerId, run.comparison.plan.id, JSON.stringify(request)])).rows[0].value;
      const another = run.comparison.plan.slots[1]; assert.ok(another); assert.equal(await reserve(another), false);
      await upload(slot, success('two'));
      const retry = (await client.query('SELECT public.cancel_comparison($1,$2,$3,$4) AS value', [f.projectId, f.ownerId, run.comparison.plan.id, JSON.stringify(request)])).rows[0].value;
      assert.deepEqual(retry, { ...cancel, idempotent: true });
      await fails('UPDATE public.comparison_cancellations SET project_id=project_id WHERE id=$1', [request.id]);
      await fails('SELECT public.cancel_comparison($1,$2,$3,$4)', [f.projectId, f.ownerId, plan.id, JSON.stringify(request)], '23505');
      const finalRequest = { schema_version, id: randomUUID(), allowPartial: true };
      const report = ComparisonFinalizeResponseSchema.parse((await client.query(finalizeSQL, [f.projectId, f.ownerId, run.comparison.plan.id, JSON.stringify(finalRequest)])).rows[0].value).report;
      assert.equal(report.stopReason, 'cancelled'); assert.equal(report.progress.completed, 1);
      const lateRun = await create(f.body()); const late = lateRun.comparison.plan.slots[0]; assert.ok(late); await reserve(late);
      const frozen = ComparisonFinalizeResponseSchema.parse((await client.query(finalizeSQL, [f.projectId, f.ownerId, lateRun.comparison.plan.id, JSON.stringify({ schema_version, id: randomUUID(), allowPartial: true })])).rows[0].value).report;
      await upload(late, success('one'));
      const live = await detail(lateRun.comparison.plan.id); assert.equal(live.comparison.progress.completed, 1); assert.deepEqual(live.comparison.finalReport, frozen);
    });
    await t.test('persisted reclaim caps expose unknown dispatches and deadline prevents dispatch', async () => {
      const run = await create(f.body({ reclaimBudget: 1, dispatchBudget: 13 })); const slot = run.comparison.plan.slots[0]; assert.ok(slot);
      const lease = randomUUID(); assert.equal(await reserve(slot, lease, 1), true);
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.equal((await detail(run.comparison.plan.id)).comparison.progress.uncertainDispatches, 1);
      assert.equal(await reserve(slot, randomUUID(), 1), true);
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.equal(await reserve(slot), false);
      const progress = (await detail(run.comparison.plan.id)).comparison.progress;
      assert.equal(progress.dispatches, 2); assert.equal(progress.reclaims, 1); assert.equal(progress.uncertainDispatches, 2);
      const deadlineRun = await create(f.body({ deadlineAt: new Date(Date.now() + 150).toISOString() }));
      await new Promise(resolve => setTimeout(resolve, 200)); const deadlineSlot = deadlineRun.comparison.plan.slots[0]; assert.ok(deadlineSlot);
      assert.equal(await reserve(deadlineSlot), false);
      const report = ComparisonFinalizeResponseSchema.parse((await client.query(finalizeSQL, [f.projectId, f.ownerId, deadlineRun.comparison.plan.id, JSON.stringify({ schema_version, id: randomUUID(), allowPartial: true })])).rows[0].value).report;
      assert.equal(report.stopReason, 'deadline_exceeded'); assert.equal(report.progress.dispatches, 0);
    });
    await t.test('all completed fresh repeats finalize honestly and cannot silently reuse discovery outputs', async () => {
      const run = await create(f.body({ suiteVersionId: sibling.publication.suite.id, caseIds: [sibling.reviewCase.case.id], dispatchBudget: 4, reclaimBudget: 0 }));
      for (const slot of run.comparison.plan.slots) { assert.equal(await reserve(slot), true); await upload(slot, success(slot.execution.role === 'baseline' ? 'one' : 'two')); }
      const request = { schema_version, id: randomUUID(), allowPartial: false };
      const report = ComparisonFinalizeResponseSchema.parse((await client.query(finalizeSQL, [f.projectId, f.ownerId, run.comparison.plan.id, JSON.stringify(request)])).rows[0].value).report;
      assert.equal(report.completion, 'complete'); assert.equal(report.stopReason, 'completed'); assert.equal(report.progress.dispatches, 4);
      assert.ok(report.repeats.every(row => row.outcome === 'pass')); assert.ok(report.behaviorChanges.every(row => row.status === 'changed'));
      assert.deepEqual(validateComparisonReportAgainstPlan(report, run.comparison.plan), report);
    });
    await t.test('ten explicitly selected cases retain all 120 logical slots in exact caller order', async () => {
      const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
      for (let i = 0; i < 10; i++) fixtures.push(await fixture(client, f.projectId, f.ownerId));
      const head = fixtures[0]; assert.ok(head);
      const cases = fixtures.map(row => { const c = row.publication.suite.cases[0]; assert.ok(c?.review.expectationVersion); return { caseId: c.case.id, expectationVersionId: c.review.expectationVersion.id, expectedReviewRevision: 1 }; }).reverse();
      const suite = PublishSuiteResponseSchema.parse((await client.query('SELECT public.publish_suite($1,$2,$3) AS value', [f.projectId, f.ownerId, JSON.stringify({ schema_version, id: randomUUID(), suiteId: head.publication.suite.suiteId, expectedVersion: 1, cases })])).rows[0].value).suite;
      const request = f.body({ suiteVersionId: suite.id, caseIds: cases.map(row => row.caseId), dispatchBudget: 144, reclaimBudget: 24 });
      const run = await create(request); assert.equal(run.comparison.plan.slots.length, 120);
      assert.deepEqual(run.comparison.plan, prepareComparisonPlan({ request, suite, projectId: f.projectId, createdAt: run.comparison.plan.createdAt }));
      assert.equal((await client.query('SELECT count(*)::int AS n FROM public.comparison_targets WHERE comparison_id=$1', [request.id])).rows[0].n, 120);
      const changed = { ...request, id: randomUUID(), caseIds: [...request.caseIds, randomUUID()] };
      await fails(createSQL, [f.projectId, f.ownerId, JSON.stringify(changed)]);
    });
    await client.query('ROLLBACK');
  } finally { await client.query('ROLLBACK'); await client.end(); }
});

test('Gate 4 SQL: independent-connection creation, dispatch-budget and finalization contention', async () => {
  const pool = new pg.Pool({ connectionString, max: 3 }); const setup = await pool.connect();
  let f: Awaited<ReturnType<typeof fixture>>;
  try {
    await setup.query('BEGIN'); await bootstrapLocalTest(setup);
    const all = await loadMigrations();
    await applyMigrations(setup, all);
    f = await fixture(setup, randomUUID(), randomUUID(), 1); await setup.query('COMMIT');
    const request = f.body({ dispatchBudget: 4, reclaimBudget: 1 });
    const creations = await Promise.all([pool.query(createSQL, [f.projectId, f.ownerId, JSON.stringify(request)]), pool.query(createSQL, [f.projectId, f.ownerId, JSON.stringify(request)])]);
    const [a, b] = creations.map(result => ComparisonCreateResponseSchema.parse(result.rows[0].value)); assert.ok(a && b);
    assert.deepEqual(a.comparison.plan, b.comparison.plan); assert.notEqual(a.idempotent, b.idempotent);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.comparison_targets WHERE comparison_id=$1', [request.id])).rows[0].n, 4);
    const secondCredential = randomUUID();
    await pool.query('INSERT INTO public.runner_credentials(id,project_id,label,token_hash) VALUES($1,$2,$3,$4)', [secondCredential, f.projectId, 'Synthetic contention runner', checksum(randomUUID())]);
    const slots = a.comparison.plan.slots; const old = slots[1]; const fresh = slots[0]; assert.ok(old && fresh);
    for (const slot of slots.slice(1)) assert.equal((await pool.query(reserveSQL, [f.projectId, slot.attemptId, randomUUID(), f.credentialId, 1, slot.execution.assistantVersion])).rows[0].value, true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const race = await Promise.all([
      pool.query(reserveSQL, [f.projectId, fresh.attemptId, randomUUID(), f.credentialId, 30, fresh.execution.assistantVersion]),
      pool.query(reserveSQL, [f.projectId, old.attemptId, randomUUID(), secondCredential, 30, old.execution.assistantVersion]),
    ]);
    assert.deepEqual(race.map(result => result.rows[0].value).sort(), [false, true]);
    const live = ComparisonDetailResponseSchema.parse((await pool.query('SELECT public.get_comparison($1,$2,$3) AS value', [f.projectId, f.ownerId, request.id])).rows[0].value);
    assert.equal(live.comparison.progress.dispatches, 4); assert.equal(live.comparison.state, 'budget_exhausted');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.comparison_dispatches WHERE comparison_id=$1', [request.id])).rows[0].n, 4);
    const finalRequest = { schema_version, id: randomUUID(), allowPartial: true };
    const finals = await Promise.all([pool.query(finalizeSQL, [f.projectId, f.ownerId, request.id, JSON.stringify(finalRequest)]), pool.query(finalizeSQL, [f.projectId, f.ownerId, request.id, JSON.stringify(finalRequest)])]);
    const [fa, fb] = finals.map(result => ComparisonFinalizeResponseSchema.parse(result.rows[0].value)); assert.ok(fa && fb);
    assert.deepEqual(fa.report, fb.report); assert.notEqual(fa.idempotent, fb.idempotent);
    assert.equal(fa.report.stopReason, 'budget_exhausted'); assert.equal(fa.report.progress.uncertainDispatches >= 2, true);
    validateComparisonReportAgainstPlan(fa.report, a.comparison.plan);
    const cancelled = ComparisonCreateResponseSchema.parse((await pool.query(createSQL, [f.projectId, f.ownerId, JSON.stringify(f.body())])).rows[0].value);
    const blocked = cancelled.comparison.plan.slots[0]; assert.ok(blocked);
    await setup.query('BEGIN');
    await setup.query('SELECT public.cancel_comparison($1,$2,$3,$4)', [f.projectId, f.ownerId, cancelled.comparison.plan.id, JSON.stringify({ schema_version, id: randomUUID() })]);
    const waiting = pool.query(reserveSQL, [f.projectId, blocked.attemptId, randomUUID(), secondCredential, 30, blocked.execution.assistantVersion]);
    await setup.query('COMMIT'); assert.equal((await waiting).rows[0].value, false);
    assert.equal((await pool.query('SELECT dispatches FROM public.comparison_state WHERE comparison_id=$1', [cancelled.comparison.plan.id])).rows[0].dispatches, 0);
    // Committed, uniquely named synthetic history is retained. No fixture deletion,
    // reset or hosted connection is used to make concurrent tests pass.
  } finally { await setup.query('ROLLBACK'); setup.release(); await pool.end(); }
});
