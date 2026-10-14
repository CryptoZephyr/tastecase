'use client';

import { useState } from 'react';
import { AnchorConfirmations, BudgetMeters, CandidateList, EvidenceList, ProviderLedger, RunsTable, StageTracker } from '@/components/discovery/job-parts';
import { ProfileTag } from '@/components/case/labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { Facts, Time } from '@/components/ui/data';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { PageHeader, Section } from '@/components/ui/page';
import { SkeletonPanel } from '@/components/ui/skeleton';
import { ErrorState, LastUpdated } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { UiError } from '@/lib/api/result';
import { useResource } from '@/lib/api/use-resource';
import { DISCOVERY_STATES } from '@/lib/view/discovery-view';
import { loadOwnerHistory } from '@/lib/view/owner-history';

export function JobScreen({ projectId, jobId }: { projectId: string; jobId: string }) {
  const api = useApi();
  const detail = useResource(() => api.discovery.get(projectId, jobId), [api, projectId, jobId], { pollWhile: data => DISCOVERY_STATES[data.job.state].active });
  const cases = useResource(() => loadOwnerHistory(window => api.cases.list(projectId, window)), [api, projectId]);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<UiError | null>(null);

  if (detail.status === 'loading') return <SkeletonPanel label="Loading the discovery job" />;
  if (detail.status === 'error') return <ErrorState error={detail.error} what="this discovery job" onRetry={detail.reload} retrying={detail.reloading} />;
  const { job } = detail.data;
  const state = DISCOVERY_STATES[job.state];
  const request = job.input.request;

  async function cancel(close: () => void) {
    setCancelPending(true); setCancelError(null);
    const result = await api.discovery.cancel(projectId, jobId);
    setCancelPending(false); close();
    if (result.ok) void detail.reload(); else setCancelError(result.error);
  }

  return (
    <div className="space-y-10">
      <PageHeader title={`${request.profiles[0].label} / ${request.profiles[1].label}`}
        description={<>Discovery job started <Time iso={job.createdAt} />. Inputs and budgets are pinned.</>}
        meta={<div className="flex flex-wrap items-center gap-2"><Badge tone={state.tone}>{state.label}</Badge><LastUpdated at={detail.updatedAt} polling={detail.polling} reloading={detail.reloading} onRefresh={() => void detail.reload()} /></div>}
        actions={state.active ? (
          <ConfirmDialog title="Cancel this discovery job?" confirmLabel="Cancel job" isPending={cancelPending} onConfirm={close => void cancel(close)}
            trigger={<Button variant="destructive">Cancel job</Button>}>
            <p>TasteCase stops new Qloo, model and runner work for this job. Calls already reserved stay charged.</p>
            <p>Saved evidence and cases stay available. Results your runner had already started may still arrive and are labelled as cancelled.</p>
          </ConfirmDialog>
        ) : undefined} />

      {detail.error ? <ErrorState error={detail.error} what="the latest job state" onRetry={detail.reload} retrying={detail.reloading} /> : null}
      {cancelError ? <ErrorState error={cancelError} what="the cancellation" /> : null}
      <Notice tone={state.tone === 'neutral' ? 'info' : state.tone} title={state.label}>
        <p>{state.explanation}</p>
        {job.reason ? <p>Recorded reason: {job.reason}</p> : null}
        {job.checkpointData.note ? <p>{job.checkpointData.note}</p> : null}
      </Notice>

      {job.state === 'needs_confirmation' || detail.data.resolutions.length ? (
        <Section title="Confirm interest matches" description="Choose the Qloo entity each public interest refers to. Unconfirmed interests are never used for ranking.">
          <AnchorConfirmations projectId={projectId} detail={detail.data} onConfirmed={() => void detail.reload()} />
          {job.state !== 'needs_confirmation' ? <p className="text-control text-ink-2">No confirmations are waiting.</p> : null}
        </Section>
      ) : null}

      {job.state === 'waiting_runner' ? (
        <Section title="Run your runner" description="Work is queued for this project’s runner. On the runner machine, with the environment from setup:">
          <CodeBlock label="Claim and run one attempt" code={`node packages/runner/dist/cli.js run-once`} />
          <p className="mt-2 text-control text-ink-2">Each run claims at most one attempt. Repeat it for the queued work below; there’s no background daemon and no automatic retry.</p>
        </Section>
      ) : null}

      <Section title="Cases found" description="Completed cases open for review even while this job is still running.">
        <CandidateList projectId={projectId} detail={detail.data} cases={cases.status === 'ready' && !cases.error ? cases.data : null} onCreated={() => void cases.reload()} />
        {cases.error ? <ErrorState className="mt-3" error={cases.error} what="review status for these cases" onRetry={cases.reload} retrying={cases.reloading} /> : null}
      </Section>

      <Section title="Progress"><StageTracker detail={detail.data} /></Section>
      <Section title="Budgets" description="Actual counts against the budgets pinned when the job started."><BudgetMeters detail={detail.data} /></Section>

      <Section title="Pinned inputs">
        <Facts columns={3} items={[
          ['Task', job.input.targetInput.task.label], ['Catalog', job.input.targetInput.catalog.label],
          ['Eligible restaurants', `${request.eligibleCatalogEntryIds.length} (${request.mappingConfirmationIds.length} mapped)`],
          ['Assistant version', <code key="v" className="break-all">{request.assistantVersion}</code>], ['Repeats', request.repeatCount],
          ['Follow-up on the pair', request.reducePair ? 'Yes' : 'No'], ['Deadline', <Time key="d" iso={job.deadlineAt} />],
        ]} />
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {request.profiles.map(profile => (
            <div key={profile.id} className="rounded-panel border border-rule bg-surface p-4">
              <ProfileTag profile={profile.id} />
              <p className="mt-2 font-medium">{profile.label}</p>
              <ul className="mt-2 space-y-1 text-control">{profile.anchors.map(anchor => <li key={anchor.id}>{anchor.label} <span className="text-ink-2">· {anchor.kind}</span></li>)}</ul>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Assistant runs"><RunsTable detail={detail.data} /></Section>
      <Section title="Qloo and model calls" description="Every call is reserved before it’s sent and stays charged, even when the outcome is unknown."><ProviderLedger detail={detail.data} /></Section>
      <Section title="Evidence"><EvidenceList detail={detail.data} /></Section>
    </div>
  );
}
