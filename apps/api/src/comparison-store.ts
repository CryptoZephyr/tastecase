import type { PoolClient } from 'pg';
import {
  COMPARISON_LIMITS, ComparisonCreateResponseSchema, ComparisonDetailResponseSchema,
  ComparisonListResponseSchema, ComparisonFinalizeResponseSchema, ComparisonWindowRequestSchema,
  SuiteVersionSchema, canonicalJson, comparisonProgress, assertSafePortableContent,
  validateComparisonPlanAgainstSuite, validateComparisonRetry, validateComparisonReportAgainstPlan,
  validateComparisonFinalizationRetry, validatePortableTestPack, buildPortableTestPack,
  type CreateComparisonRequest, type FinalizeComparisonRequest, type CancelComparisonRequest,
  type ComparisonPlan,
} from '@tastecase/contracts';
import { HttpError, type RequestSchema } from './errors.js';

/** Known runtime values supplement conservative contract patterns, not universal secret detection.
 * Never redact required pinned meaning, log rejected content or return parser/SQL diagnostics. */
function backendSecrets(): string[] {
  return Object.entries(process.env).flatMap(([key, value]) =>
    /secret|token|password|key|credential|database_url/i.test(key) && value ? [value] : []);
}
function conflict(): never { throw new HttpError(409, 'conflict', 'The immutable comparison or artifact conflicts with its pinned context.'); }
function missing(): never { throw new HttpError(404, 'not_found', 'The comparison or artifact was not found in this project.'); }
function safe(value: unknown): void {
  try { assertSafePortableContent(value, backendSecrets()); } catch { conflict(); }
}
function stored<T>(schema: RequestSchema<T>, value: unknown, maxBytes = COMPARISON_LIMITS.planBytes + COMPARISON_LIMITS.reportBytes): T {
  try {
    if (Buffer.byteLength(canonicalJson(value), 'utf8') > maxBytes) conflict();
    const result = schema.safeParse(value);
    if (!result.success) conflict();
    return result.data;
  } catch { conflict(); }
}
/** All RPC calls require projectOwner authentication and the foundation's bounded transaction. */
async function rpc(client: PoolClient, sql: string, values: unknown[]): Promise<unknown> {
  try { return (await client.query<{ value: unknown }>(sql, values)).rows[0]?.value; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = String(error.code);
      if (['40001', '23505'].includes(code)) conflict();
      if (['23503', '42501'].includes(code)) missing();
      if (['23514', '22P02', '22003', '22007', '22008'].includes(code)) {
        throw new HttpError(400, 'invalid_request', 'The comparison request or artifact violates its pinned scope, bounds or supported content.');
      }
      if (['55P03', '57014', '40P01'].includes(code)) {
        throw new HttpError(503, 'internal_error', 'The comparison is busy. Retry the same request ID.');
      }
    }
    throw error;
  }
}
async function pinnedPlan(client: PoolClient, plan: ComparisonPlan, projectId: string) {
  if (plan.projectId !== projectId) conflict();
  const row = (await client.query<{ snapshot: unknown }>(
    'SELECT snapshot FROM public.suite_versions WHERE project_id=$1 AND id=$2', [projectId, plan.request.suiteVersionId])).rows[0];
  if (!row) conflict();
  try { validateComparisonPlanAgainstSuite(plan, stored(SuiteVersionSchema, row.snapshot, COMPARISON_LIMITS.planBytes)); }
  catch { conflict(); }
  safe(plan);
}
function reportAgainstPlan(value: unknown, plan: ComparisonPlan) {
  try {
    const report = validateComparisonReportAgainstPlan(value, plan);
    safe(report);
    return report;
  } catch { conflict(); }
}
export async function createComparison(client: PoolClient, projectId: string, ownerId: string, request: CreateComparisonRequest) {
  safe(request);
  const response = stored(ComparisonCreateResponseSchema, await rpc(client,
    'SELECT public.create_comparison($1,$2,$3) AS value', [projectId, ownerId, JSON.stringify(request)]));
  await pinnedPlan(client, response.comparison.plan, projectId);
  try { validateComparisonRetry(request, response.comparison.plan, projectId); } catch { conflict(); }
  // SQL persists this exact pack on creation. Validate before COMMIT, never silently repair it.
  await exportComparisonPack(client, projectId, ownerId, request.id);
  return response;
}
/** Current progress is distinct from immutable creation/cancellation/finalization receipts.
 * Reads must use transaction(snapshot=true); reopening never reschedules or reconstructs from review heads. */
export async function readComparison(client: PoolClient, projectId: string, ownerId: string, comparisonId: string) {
  const response = stored(ComparisonDetailResponseSchema, await rpc(client,
    'SELECT public.get_comparison($1,$2,$3) AS value', [projectId, ownerId, comparisonId]));
  const run = response.comparison;
  if (run.plan.id !== comparisonId) conflict();
  await pinnedPlan(client, run.plan, projectId);
  try { if (canonicalJson(comparisonProgress(run.plan, response.associations)) !== canonicalJson(run.progress)) conflict(); }
  catch { conflict(); }
  if (run.finalReport) reportAgainstPlan(run.finalReport, run.plan);
  return response;
}
export async function listComparisons(client: PoolClient, projectId: string, ownerId: string, limit: number, offset: number) {
  if (!ComparisonWindowRequestSchema.safeParse({ limit, offset }).success) {
    throw new HttpError(400, 'invalid_request', 'The comparison list bounds are invalid.');
  }
  const response = stored(ComparisonListResponseSchema, await rpc(client,
    'SELECT public.list_comparisons($1,$2,$3,$4) AS value', [projectId, ownerId, limit, offset]), COMPARISON_LIMITS.reportBytes);
  if (response.comparisons.some(row => row.projectId !== projectId)) conflict();
  safe(response);
  return response;
}
export async function cancelComparison(client: PoolClient, projectId: string, ownerId: string, comparisonId: string, request: CancelComparisonRequest) {
  const response = stored(ComparisonCreateResponseSchema, await rpc(client,
    'SELECT public.cancel_comparison($1,$2,$3,$4) AS value', [projectId, ownerId, comparisonId, JSON.stringify(request)]));
  if (response.comparison.plan.id !== comparisonId) conflict();
  await pinnedPlan(client, response.comparison.plan, projectId);
  return response;
}
export async function finalizeComparison(client: PoolClient, projectId: string, ownerId: string, comparisonId: string, request: FinalizeComparisonRequest) {
  // SQL locks all attempts then state and resolves the source itself. No caller-authoritative source is accepted.
  const response = stored(ComparisonFinalizeResponseSchema, await rpc(client,
    'SELECT public.finalize_comparison($1,$2,$3,$4) AS value', [projectId, ownerId, comparisonId, JSON.stringify(request)]), COMPARISON_LIMITS.reportBytes);
  const detail = await readComparison(client, projectId, ownerId, comparisonId);
  try { validateComparisonFinalizationRetry(request, response.report, detail.comparison.plan); } catch { conflict(); }
  reportAgainstPlan(response.report, detail.comparison.plan);
  if (canonicalJson(detail.comparison.finalReport) !== canonicalJson(response.report)) conflict();
  await exportComparisonReport(client, projectId, ownerId, comparisonId);
  return response;
}
export async function exportComparisonPack(client: PoolClient, projectId: string, ownerId: string, comparisonId: string) {
  const value = await rpc(client, 'SELECT public.export_comparison_artifact($1,$2,$3,$4) AS value', [projectId, ownerId, comparisonId, 'pack']);
  try {
    const pack = validatePortableTestPack(value, { knownSecrets: backendSecrets() });
    if (pack.plan.id !== comparisonId || pack.plan.projectId !== projectId
      || canonicalJson(buildPortableTestPack(pack.plan, { knownSecrets: backendSecrets() })) !== canonicalJson(pack)) conflict();
    await pinnedPlan(client, pack.plan, projectId);
    const row = (await client.query<{ checksum: string }>('SELECT checksum FROM public.comparison_artifacts WHERE project_id=$1 AND comparison_id=$2 AND kind=$3', [projectId, comparisonId, 'pack'])).rows[0];
    if (!row || row.checksum !== pack.checksum) conflict();
    return pack;
  } catch { conflict(); }
}
export async function exportComparisonReport(client: PoolClient, projectId: string, ownerId: string, comparisonId: string) {
  const value = await rpc(client, 'SELECT public.export_comparison_artifact($1,$2,$3,$4) AS value', [projectId, ownerId, comparisonId, 'report']);
  const detail = await readComparison(client, projectId, ownerId, comparisonId);
  const report = reportAgainstPlan(value, detail.comparison.plan);
  const row = (await client.query<{ checksum: string }>('SELECT checksum FROM public.comparison_artifacts WHERE project_id=$1 AND comparison_id=$2 AND kind=$3', [projectId, comparisonId, 'report'])).rows[0];
  if (!row || row.checksum !== report.checksum || canonicalJson(detail.comparison.finalReport) !== canonicalJson(report)) conflict();
  return report;
}
