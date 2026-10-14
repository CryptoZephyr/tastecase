'use client';

import { ArrowRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { RoleTag } from '@/components/case/labels';
import { Badge, type Tone } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Hash, Time } from '@/components/ui/data';
import { PageHeader } from '@/components/ui/page';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, LastUpdated } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { ComparisonState } from '@/lib/api/types';
import { useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';
import { loadOwnerHistory } from '@/lib/view/owner-history';

export const COMPARISON_STATE: Record<ComparisonState, { label: string; tone: Tone; active: boolean }> = {
  queued: { label: 'Queued for your runner', tone: 'info', active: true },
  running: { label: 'Running', tone: 'info', active: true },
  cancelled: { label: 'Cancelled', tone: 'neutral', active: false },
  deadline_exceeded: { label: 'Deadline reached', tone: 'unavailable', active: false },
  budget_exhausted: { label: 'Budget used up', tone: 'unavailable', active: false },
  finalized: { label: 'Report frozen', tone: 'neutral', active: false },
};

export function ComparisonsScreen({ projectId }: { projectId: string }) {
  const api = useApi();
  const list = useResource(() => loadOwnerHistory(window => api.comparisons.list(projectId, window)), [api, projectId], { pollWhile: rows => rows.some(row => COMPARISON_STATE[row.state].active) });
  return (
    <div className="space-y-8">
      <PageHeader title="Comparisons" description="Two explicitly named assistant versions run the same published cases, briefs and pinned evidence. Reports are frozen once finalized."
        actions={<ButtonLink href={routes.newComparison(projectId)} icon={<Plus aria-hidden className="size-4" strokeWidth={1.75} />}>New comparison</ButtonLink>} />
      {list.status === 'ready' ? <LastUpdated at={list.updatedAt} polling={list.polling} reloading={list.reloading} onRefresh={() => void list.reload()} /> : null}
      {list.status === 'loading' ? <SkeletonRows label="Loading comparisons" /> : null}
      {list.status === 'error' ? <ErrorState error={list.error} what="comparisons" onRetry={list.reload} retrying={list.reloading} /> : null}
      {list.status === 'ready' && list.error ? <ErrorState error={list.error} what="the latest comparison progress" onRetry={list.reload} retrying={list.reloading} /> : null}
      {list.status === 'ready' && !list.data.length ? (
        <EmptyState title="No comparisons yet" action={<ButtonLink href={routes.newComparison(projectId)}>Start a comparison</ButtonLink>}>
          <p>Publish a suite version first, then compare a baseline and a candidate release against it.</p>
        </EmptyState>
      ) : null}
      {list.status === 'ready' && list.data.length ? (
        <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
          {list.data.map(row => {
            const state = COMPARISON_STATE[row.state];
            return (
              <li key={row.id} className="grid gap-3 p-4 lg:grid-cols-[1fr_auto] lg:items-center">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2"><RoleTag role="baseline" version={row.baselineVersion} /><RoleTag role="candidate" version={row.candidateVersion} /><Badge tone={state.tone}>{state.label}</Badge></div>
                  <p className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
                    {row.progress.completed} of {row.progress.logicalSlots} runs completed · started <Time iso={row.createdAt} />
                    {row.finalReportChecksum ? <> · report <Hash value={row.finalReportChecksum} label="report checksum" /></> : null}
                  </p>
                </div>
                <Link href={routes.comparison(projectId, row.id)} className="inline-flex min-h-11 items-center gap-1.5 text-control font-medium text-action underline-offset-4 hover:underline">Open<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} /></Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
