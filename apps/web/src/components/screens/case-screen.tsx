'use client';

import Link from 'next/link';
import { CaseReview } from '@/components/case/case-review';
import { ReceiptFacts, ReviewPanel } from '@/components/case/review-panel';
import { Badge } from '@/components/ui/badge';
import { Time } from '@/components/ui/data';
import { SkeletonPanel } from '@/components/ui/skeleton';
import { ErrorState, LastUpdated } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { TasteCaseApi } from '@/lib/api/port';
import type { ApiResult } from '@/lib/api/result';
import type { Attempt } from '@/lib/api/types';
import { useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';
import { loadOwnerHistory } from '@/lib/view/owner-history';
import { buildCaseView, entryFacts, type CaseView } from '@/lib/view/case-view';

/** Loads the case, its discovery job and every completed attempt. Unreadable attempts stay labelled as unread. */
export async function loadCaseView(api: TasteCaseApi, projectId: string, caseId: string): Promise<ApiResult<CaseView>> {
  const response = await api.cases.get(projectId, caseId);
  if (!response.ok) return response;
  const job = await api.discovery.get(projectId, response.data.case.jobId);
  if (!job.ok) return job;
  const ids = job.data.attempts.filter(row => row.status === 'completed').map(row => row.attemptId);
  const attempts = await Promise.all(ids.map(id => api.attempts.get(projectId, id)));
  const accessFailure = attempts.find(result => !result.ok && (['unauthorized', 'forbidden', 'not_found'].includes(result.error.kind) || [401, 403, 404].includes(result.error.status ?? 0)));
  if (accessFailure && !accessFailure.ok) return accessFailure;
  const loaded = attempts.flatMap(result => (result.ok ? [result.data] : [])) as Attempt[];
  return { ok: true, data: buildCaseView(response.data, job.data, loaded) };
}

const STATUS_LABEL = { unreviewed: 'Not reviewed', accepted: 'Accepted (advisory)', edited: 'Edited expectation', rejected: 'Rejected', deferred: 'Deferred' } as const;

function History({ projectId, caseId }: { projectId: string; caseId: string }) {
  const api = useApi();
  const history = useResource(() => loadOwnerHistory(window => api.cases.history(projectId, caseId, window)), [api, projectId, caseId]);
  return (
    <details className="rounded-panel border border-rule bg-surface p-4">
      <summary className="min-h-11 cursor-pointer py-2 font-medium">Decision history</summary>
      <div className="mt-3 space-y-4">
        {history.status === 'loading' ? <p className="text-ink-2" role="status">Loading history…</p> : null}
        {history.error ? <ErrorState error={history.error} what="decision history" onRetry={history.reload} retrying={history.reloading} /> : null}
        {history.status === 'ready' && !history.data.length ? <p className="text-ink-2">No decisions yet.</p> : null}
        {history.status === 'ready' ? history.data.map(record => (
          <div key={record.decision.id} className="border-t border-rule pt-4 first:border-0 first:pt-0"><ReceiptFacts record={record} /></div>
        )) : null}
      </div>
    </details>
  );
}

export function CaseScreen({ projectId, caseId }: { projectId: string; caseId: string }) {
  const api = useApi();
  const view = useResource(() => loadCaseView(api, projectId, caseId), [api, projectId, caseId]);
  if (view.status === 'loading') return <SkeletonPanel label="Loading the case and its evidence" className="min-h-96" />;
  if (view.status === 'error') return <ErrorState error={view.error} what="this case" onRetry={view.reload} retrying={view.reloading} />;
  const data = view.data;
  const [x, y] = data.contrast.entryIds;
  return (
    <CaseReview view={data}
      header={
        <div className="space-y-3">
          {view.error ? <ErrorState error={view.error} what="the latest version of this case" onRetry={view.reload} retrying={view.reloading} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={data.head.status === 'unreviewed' ? 'advisory' : 'neutral'}>{STATUS_LABEL[data.head.status]}</Badge>
            <LastUpdated at={view.updatedAt} reloading={view.reloading} onRefresh={() => void view.reload()} />
          </div>
          <h1 className="text-title font-medium break-words">{entryFacts(data.catalog, x).name} and {entryFacts(data.catalog, y).name}</h1>
          <p className="text-control text-ink-2">
            Task: {data.taskLabel} · Assistant <code className="break-all">{data.assistantVersion}</code> · Case opened <Time iso={data.createdAt} />
            {data.evidenceCapturedAt ? <> · Evidence captured <Time iso={data.evidenceCapturedAt} /></> : null}
          </p>
          <Link href={routes.job(projectId, data.jobId)} className="inline-flex min-h-11 items-center text-control text-action underline underline-offset-4">Open the discovery job</Link>
        </div>
      }
      decision={<ReviewPanel key={`${projectId}:${caseId}`} view={data} onSaved={() => void view.reload()} onReloadLatest={view.reload} />}
      history={<History projectId={projectId} caseId={caseId} />}
    />
  );
}
