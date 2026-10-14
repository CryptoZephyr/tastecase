'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { Badge, ClassBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Time } from '@/components/ui/data';
import { PageHeader } from '@/components/ui/page';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';
import { loadOwnerHistory } from '@/lib/view/owner-history';

const STATUS = {
  unreviewed: { label: 'Needs a decision', tone: 'advisory' },
  accepted: { label: 'Accepted', tone: 'neutral' },
  edited: { label: 'Expectation edited', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'unavailable' },
  deferred: { label: 'Deferred', tone: 'unavailable' },
} as const;

export function CasesScreen({ projectId }: { projectId: string }) {
  const api = useApi();
  const cases = useResource(() => loadOwnerHistory(window => api.cases.list(projectId, window)), [api, projectId]);
  return (
    <div className="space-y-8">
      <PageHeader title="Cases" description="Cases saved by discovery, with their current review decision. Approved cases can be published into an immutable suite." />
      {cases.status === 'loading' ? <SkeletonRows label="Loading cases" /> : null}
      {cases.status === 'error' ? <ErrorState error={cases.error} what="cases" onRetry={cases.reload} retrying={cases.reloading} /> : null}
      {cases.status === 'ready' && cases.data.length === 0 ? (
        <EmptyState title="No cases yet" action={<ButtonLink href={routes.discover(projectId)}>Go to discovery</ButtonLink>}>
          <p>Cases appear when a discovery job saves a contrast and you open it for review.</p>
        </EmptyState>
      ) : null}
      {cases.status === 'ready' && cases.data.length > 0 ? (
        <>
          <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
            {cases.data.map(row => {
              const status = STATUS[row.head.status];
              const content = row.candidate.content;
              const approved = row.currentReview?.expectationVersion?.expectation.classification;
              return (
                <li key={row.case.id} className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-center">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={routes.case(projectId, row.case.id)} className="font-medium underline-offset-4 hover:underline break-words">{content.briefs.a.label} / {content.briefs.b.label}</Link>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {approved ? <ClassBadge classification={approved} /> : null}
                    </div>
                    <p className="text-meta text-ink-2">Contrast <code className="break-all">{content.contrast.entryIds[0]}</code> ↔ <code className="break-all">{content.contrast.entryIds[1]}</code> · opened <Time iso={row.case.createdAt} /> · revision {row.head.revision}</p>
                  </div>
                  <Link href={routes.case(projectId, row.case.id)} className="inline-flex min-h-11 items-center gap-1.5 text-control font-medium text-action underline-offset-4 hover:underline">{row.head.status === 'unreviewed' ? 'Review' : 'Open'}<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} /></Link>
                </li>
              );
            })}
          </ul>
          {cases.error ? <ErrorState error={cases.error} what="the latest complete case history (showing stale saved data)" onRetry={cases.reload} retrying={cases.reloading} /> : null}
        </>
      ) : null}
    </div>
  );
}
