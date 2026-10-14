import type { TasteCaseApi } from '@/lib/api/port';
import type { ApiResult } from '@/lib/api/result';
import type { ComparisonPlan, SuiteVersion } from '@/lib/api/types';
import { loadOwnerHistory } from './owner-history';

/** The plan pins a version ID but doesn't contain its suite identity. Resolve it
 * within owned suites only, then GET that exact immutable version. No discovery
 * refresh, current review head or Qloo request can substitute for this snapshot.
 */
export async function loadComparisonSuite(api: TasteCaseApi, projectId: string, plan: ComparisonPlan): Promise<ApiResult<SuiteVersion>> {
  const suites = await loadOwnerHistory(window => api.suites.list(projectId, window));
  if (!suites.ok) return suites;
  for (const suite of suites.data) {
    for (let offset = 0; offset <= 10000; offset += 20) {
      const versions = await api.suites.versions(projectId, suite.id, { limit: 20, offset });
      if (!versions.ok) return versions;
      if (versions.data.some(version => version.id === plan.request.suiteVersionId)) {
        const exact = await api.suites.version(projectId, suite.id, plan.request.suiteVersionId);
        if (!exact.ok) return exact;
        if (exact.data.id !== plan.request.suiteVersionId || exact.data.suiteId !== suite.id || exact.data.projectId !== projectId || exact.data.checksum !== plan.suiteChecksum) {
          return { ok: false, error: { kind: 'conflict', message: 'Published evidence does not match the comparison’s pinned suite identity and checksum.' } };
        }
        return exact;
      }
      if (versions.data.length < 20) break;
      if (offset === 10000) return { ok: false, error: { kind: 'too_large', message: 'Pinned evidence could not be resolved within the service’s bounded history.' } };
    }
  }
  return { ok: false, error: { kind: 'not_found', message: 'The exact published evidence snapshot is unavailable.' } };
}

export function pinnedCaseEvidence(suite: SuiteVersion | undefined, row: ComparisonPlan['cases'][number]) {
  return suite?.cases.find(snapshot => snapshot.case.id === row.caseId && snapshot.review.decision.evidence.checksum === row.evidenceChecksum)?.review.decision.evidence;
}
