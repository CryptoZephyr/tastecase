'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { StartJobForm } from '@/components/discovery/start-job-form';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Time } from '@/components/ui/data';
import { PageHeader, Section } from '@/components/ui/page';
import { SkeletonPanel, SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, LastUpdated } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { all, useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';
import { loadOwnerHistory } from '@/lib/view/owner-history';
import { budgetRows, DISCOVERY_STATES } from '@/lib/view/discovery-view';

export function DiscoverScreen({ projectId }: { projectId: string }) {
  const api = useApi();
  const jobs = useResource(() => loadOwnerHistory(window => api.discovery.list(projectId, window)), [api, projectId], { pollWhile: list => list.some(job => DISCOVERY_STATES[job.state].active) });
  const inputs = useResource(() => all([api.catalogs.list(projectId), api.tasks.list(projectId), api.mappings.list(projectId)] as const), [api, projectId]);

  return (
    <div className="space-y-12">
      <PageHeader title="Discover" description="A bounded job ranks your eligible restaurants for two fictional profiles with Qloo, picks a reversed pair worth checking, and has your runner ask your assistant both briefs." />

      <Section title="Discovery jobs" actions={jobs.status === 'ready' ? <LastUpdated at={jobs.updatedAt} polling={jobs.polling} reloading={jobs.reloading} onRefresh={() => void jobs.reload()} /> : undefined}>
        {jobs.status === 'loading' ? <SkeletonRows label="Loading discovery jobs" /> : null}
        {jobs.status === 'error' ? <ErrorState error={jobs.error} what="discovery jobs" onRetry={jobs.reload} retrying={jobs.reloading} /> : null}
        {jobs.status === 'ready' && jobs.error ? <ErrorState className="mb-4" error={jobs.error} what="the latest job states" onRetry={jobs.reload} retrying={jobs.reloading} /> : null}
        {jobs.status === 'ready' && jobs.data.length === 0 ? <EmptyState title="No discovery jobs yet"><p>Start one below. Completed cases stay available even while another job runs.</p></EmptyState> : null}
        {jobs.status === 'ready' && jobs.data.length > 0 ? (
          <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
            {jobs.data.map(job => {
              const state = DISCOVERY_STATES[job.state];
              const runs = budgetRows(job).find(row => row.key === 'targetAttempts')!;
              return (
                <li key={job.id} className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-center">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={routes.job(projectId, job.id)} className="font-medium underline-offset-4 hover:underline break-words">{job.input.request.profiles[0].label} / {job.input.request.profiles[1].label}</Link>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </div>
                    <p className="text-meta text-ink-2">Started <Time iso={job.createdAt} /> · {job.checkpointData.candidateIds.length} case{job.checkpointData.candidateIds.length === 1 ? '' : 's'} saved · assistant runs {runs.used} of {runs.limit}</p>
                  </div>
                  <Link href={routes.job(projectId, job.id)} className="inline-flex min-h-11 items-center gap-1.5 text-control font-medium text-action underline-offset-4 hover:underline">Open<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} /></Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Section>

      <Section id="start" title="Start a discovery job" description="Inputs, budgets and deadline are pinned when the job starts and can’t change afterwards.">
        {inputs.status === 'loading' ? <SkeletonPanel label="Loading project inputs" /> : null}
        {inputs.status === 'error' ? <ErrorState error={inputs.error} what="this project’s catalog, tasks and mappings" onRetry={inputs.reload} retrying={inputs.reloading} /> : null}
        {inputs.status === 'ready' ? (() => {
          const [catalogs, tasks, mappings] = inputs.data;
          if (!catalogs.length || !tasks.length) {
            return (
              <EmptyState title={!catalogs.length ? 'Import a catalog first' : 'Define a task first'} action={<ButtonLink href={routes.setup(projectId, !catalogs.length ? 'catalog' : 'task')}>Go to setup</ButtonLink>}>
                <p>Discovery pins a catalog version and a task version. {!catalogs.length ? 'There’s no catalog in this project yet.' : 'There’s no task version yet.'}</p>
              </EmptyState>
            );
          }
          return <StartJobForm projectId={projectId} catalogs={catalogs} tasks={tasks} mappings={mappings} />;
        })() : null}
      </Section>
    </div>
  );
}
