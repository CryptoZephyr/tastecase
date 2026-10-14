'use client';

import { useState } from 'react';
import { ExportPanel } from '@/components/comparison/export-panel';
import { ReportTable } from '@/components/comparison/report-parts';
import { ProfileTag, RoleTag } from '@/components/case/labels';
import { Badge, OutcomeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/choice';
import { CodeBlock } from '@/components/ui/code';
import { Facts, Hash, Time } from '@/components/ui/data';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { PageHeader, Section } from '@/components/ui/page';
import { SkeletonPanel } from '@/components/ui/skeleton';
import { ErrorState, LastUpdated, Receipt } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import type { ComparisonDetail, FinalizeComparisonRequest } from '@/lib/api/types';
import { useResource } from '@/lib/api/use-resource';
import { newId, SCHEMA_VERSION } from '@/lib/ids';
import { outcomeCounts, reportRows } from '@/lib/view/comparison-view';
import { LIMITATION_TEXT, STOP_REASON } from '@/lib/view/expectation-text';
import { COMPARISON_STATE } from './comparisons-screen';

function Progress({ detail }: { detail: ComparisonDetail }) {
  const p = detail.comparison.progress;
  const request = detail.comparison.plan.request;
  return (
    <Facts columns={3} items={[
      ['Runs completed', `${p.completed} of ${p.logicalSlots}`], ['Running on a runner', p.leased], ['Waiting', p.queued],
      ['Dispatches charged', `${p.dispatches} of ${request.dispatchBudget}`], ['Reclaims', `${p.reclaims} of ${request.reclaimBudget}`],
      ['Interrupted dispatches', p.uncertainDispatches ? `${p.uncertainDispatches} — may have repeated` : 'None'],
    ]} />
  );
}

function LiveSlots({ detail }: { detail: ComparisonDetail }) {
  const rows = detail.associations;
  if (!rows.length) return null;
  return (
    <div tabIndex={0} role="region" aria-label="Planned runs table" className="overflow-x-auto rounded-panel border border-rule bg-surface">
      <table className="w-full min-w-[36rem] text-left text-control">
        <caption className="sr-only">Planned runs</caption>
        <thead className="bg-subtle text-meta text-ink-2"><tr>{['Case', 'Release', 'Brief', 'Repeat', 'Status'].map(h => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-rule">
          {rows.map(row => (
            <tr key={row.attemptId}>
              <td className="px-3 py-2">{detail.comparison.plan.cases.findIndex(item => item.caseId === row.caseId) + 1}</td>
              <td className="px-3 py-2"><RoleTag role={row.role} version={row.assistantVersion} /></td>
              <td className="px-3 py-2"><ProfileTag profile={row.profileId} /></td>
              <td className="px-3 py-2">{row.repeat + 1}</td>
              <td className="px-3 py-2">{row.cancelled ? 'Cancelled' : row.status === 'completed' ? 'Completed' : row.status === 'leased' ? 'Running' : 'Waiting for a runner'}{row.uncertainDispatches ? ' · interrupted' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ComparisonScreen({ projectId, comparisonId }: { projectId: string; comparisonId: string }) {
  const api = useApi();
  const detail = useResource(() => api.comparisons.get(projectId, comparisonId), [api, projectId, comparisonId], { pollWhile: data => COMPARISON_STATE[data.comparison.state].active });
  const [allowPartial, setAllowPartial] = useState(false);
  const [finalBody, setFinalBody] = useState<FinalizeComparisonRequest | null>(null);
  const [actionError, setActionError] = useState<{ what: string; error: UiError } | null>(null);
  const [busy, setBusy] = useState<'cancel' | 'finalize' | null>(null);

  if (detail.status === 'loading') return <SkeletonPanel label="Loading the comparison" className="min-h-80" />;
  if (detail.status === 'error') return <ErrorState error={detail.error} what="this comparison" onRetry={detail.reload} retrying={detail.reloading} />;
  const run = detail.data.comparison;
  const { plan, finalReport } = run;
  const state = COMPARISON_STATE[run.state];
  const incomplete = run.progress.completed < run.progress.logicalSlots;
  const evidenceTimes = plan.cases.length;
  const repeatCounts = [...new Set(plan.cases.map(row => row.repeatCount))].sort();
  const repeatLabel = repeatCounts.length === 1 ? `${repeatCounts[0]} repeat${repeatCounts[0] === 1 ? '' : 's'}` : `${repeatCounts[0]}–${repeatCounts.at(-1)} repeats`;

  async function cancel(close: () => void) {
    setBusy('cancel'); setActionError(null);
    const result = await api.comparisons.cancel(projectId, comparisonId, { schema_version: SCHEMA_VERSION, id: newId() });
    setBusy(null); close();
    if (result.ok) void detail.reload(); else setActionError({ what: 'the cancellation', error: result.error });
  }
  async function finalize(body: FinalizeComparisonRequest, close?: () => void) {
    setBusy('finalize'); setActionError(null); setFinalBody(body);
    const result = await api.comparisons.finalize(projectId, comparisonId, body);
    setBusy(null); close?.();
    if (result.ok) { setFinalBody(null); void detail.reload(); } else setActionError({ what: 'the report', error: result.error });
  }

  return (
    <div className="space-y-10">
      <PageHeader title="Release comparison"
        description={<span className="inline-flex flex-wrap items-center gap-x-1">Suite version <Hash value={plan.request.suiteVersionId} label="suite version ID" length={8} /> · {evidenceTimes} case{evidenceTimes === 1 ? '' : 's'} · {repeatLabel} · inputs and evidence pinned <Time iso={plan.createdAt} /></span>}
        meta={<div className="flex flex-wrap items-center gap-2"><RoleTag role="baseline" version={plan.request.baselineVersion} /><RoleTag role="candidate" version={plan.request.candidateVersion} /><Badge tone={state.tone}>{state.label}</Badge><LastUpdated at={detail.updatedAt} polling={detail.polling} reloading={detail.reloading} onRefresh={() => void detail.reload()} /></div>}
        actions={state.active ? (
          <ConfirmDialog title="Cancel this comparison?" confirmLabel="Cancel comparison" isPending={busy === 'cancel'} onConfirm={close => void cancel(close)} trigger={<Button variant="destructive">Cancel</Button>}>
            <p>No new runs will be claimed. Runs already in progress may still upload and stay visible.</p>
            <p>You can still freeze a partial report afterwards; missing runs are shown as not run.</p>
          </ConfirmDialog>
        ) : undefined} />

      {detail.error ? <ErrorState error={detail.error} what="the latest progress" onRetry={detail.reload} retrying={detail.reloading} /> : null}
      {actionError?.error.kind === 'conflict' && actionError.what === 'the report' ? <Notice tone="advisory" title="Some runs are still pending" role="alert">Wait for them to finish, or tick “Freeze a partial report” to capture the gaps explicitly.</Notice>
        : actionError && isUncertain(actionError.error) && finalBody ? <Notice tone="advisory" title="We couldn’t confirm the report was frozen" role="alert" actions={<Button variant="secondary" onPress={() => void finalize(finalBody)} isPending={busy === 'finalize'}>Retry the same request</Button>}><p>Retrying returns the original report if it was frozen.</p></Notice>
        : actionError ? <ErrorState error={actionError.error} what={actionError.what} /> : null}

      <Section title="Progress" description="Actual counts. Profile A / Profile B are the pinned input briefs; Baseline / Candidate are the assistant releases.">
        <Progress detail={detail.data} />
        <p className="mt-3 flex flex-wrap items-center gap-1 text-meta text-ink-2">Suite checksum <Hash value={plan.suiteChecksum} label="suite checksum" /> · deadline <Time iso={plan.request.deadlineAt} /></p>
      </Section>

      {state.active ? (
        <Section title="Run both releases on your runner" description="Bind the exact release label before each batch. A runner with no label or the wrong label can’t claim these runs.">
          <div className="grid gap-4 xl:grid-cols-2">
            <CodeBlock label="Baseline runs" code={`export TASTECASE_ASSISTANT_VERSION="${plan.request.baselineVersion}"\nnode packages/runner/dist/cli.js run-once`} />
            <CodeBlock label="Candidate runs" code={`export TASTECASE_ASSISTANT_VERSION="${plan.request.candidateVersion}"\nnode packages/runner/dist/cli.js run-once`} />
          </div>
          <p className="mt-2 text-control text-ink-2">Configure the matching assistant locally first — the label attests your configuration; it doesn’t switch models.</p>
        </Section>
      ) : null}

      {!finalReport ? (
        <Section title="Freeze the report" description="Outcomes are evaluated when you freeze the report, from the stored runs and the approved rules only.">
          <div className="space-y-3 rounded-panel border border-rule bg-surface p-4 md:p-6">
            {incomplete ? <Checkbox isSelected={allowPartial} onChange={setAllowPartial}>Freeze a partial report<span className="block text-meta text-ink-2">{run.progress.logicalSlots - run.progress.completed} run(s) haven’t completed. They’ll be recorded as not run — never as passed.</span></Checkbox> : <p className="text-control">Every planned run completed.</p>}
            <ConfirmDialog title="Freeze this report?" confirmLabel="Freeze report" confirmVariant="primary" isPending={busy === 'finalize'}
              onConfirm={close => void finalize({ schema_version: SCHEMA_VERSION, id: newId(), allowPartial: incomplete && allowPartial }, close)}
              trigger={<Button isDisabled={incomplete && !allowPartial}>Freeze report</Button>}>
              <p>The report is frozen once, with a checksum. Later uploads stay visible in progress but never change it.</p>
            </ConfirmDialog>
            {incomplete && !allowPartial ? <p className="text-meta text-ink-2">Wait for the remaining runs, or choose to freeze a partial report.</p> : null}
          </div>
          <div className="mt-6"><LiveSlots detail={detail.data} /></div>
        </Section>
      ) : (
        <>
          <Receipt title={`Report frozen ${finalReport.completion === 'partial' ? '(partial)' : ''}`}>
            <p className="text-control">{STOP_REASON[finalReport.stopReason]} Finalized <Time iso={finalReport.finalizedAt} />.</p>
          </Receipt>
          <Section title="Outcomes" description="Class and outcome are separate. Mechanical rule outcomes are listed apart from changed recommendations.">
            <div className="mb-4 flex flex-wrap gap-2" aria-label="Outcome counts across briefs and releases">
              {Object.entries(outcomeCounts(finalReport)).filter(([, count]) => count > 0).map(([outcome, count]) => (
                <span key={outcome} className="inline-flex items-center gap-1.5"><OutcomeBadge outcome={outcome as 'pass'} /><span className="text-control">× {count}</span></span>
              ))}
            </div>
            <ReportTable projectId={projectId} plan={plan} rows={reportRows(plan, finalReport)} />
            <ul className="mt-6 list-disc space-y-1 pl-5 text-control text-ink">{finalReport.limitations.map(limit => <li key={limit}>{LIMITATION_TEXT[limit]}</li>)}</ul>
          </Section>
          <Section title="Export and proof"><ExportPanel projectId={projectId} comparisonId={comparisonId} report={finalReport} /></Section>
        </>
      )}
    </div>
  );
}
