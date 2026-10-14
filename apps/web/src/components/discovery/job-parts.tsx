'use client';

import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Radio, RadioGroup } from 'react-aria-components';
import { ProfileTag } from '@/components/case/labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Hash, Time } from '@/components/ui/data';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { UiError } from '@/lib/api/result';
import type { AnchorResolution, DiscoveryJobDetail, ReviewCaseResponse } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { newId, SCHEMA_VERSION } from '@/lib/ids';
import { routes } from '@/lib/routes';
import { budgetRows, CHECKPOINTS, checkpointIndex, DISCOVERY_STATES } from '@/lib/view/discovery-view';

export function StageTracker({ detail }: { detail: DiscoveryJobDetail }) {
  const current = checkpointIndex(detail.job);
  const active = DISCOVERY_STATES[detail.job.state].active;
  return (
    <ol className="grid gap-2 sm:grid-cols-4 xl:grid-cols-7" aria-label="Checkpoints">
      {CHECKPOINTS.map((row, index) => {
        const done = active ? index < current : index <= current;
        const inProgress = active && index === current;
        return (
          <li key={row.id} aria-current={index === current ? 'step' : undefined}
            className={cn('flex items-start gap-2 rounded-control border p-2 text-control', done ? 'border-action/40 bg-surface' : inProgress ? 'border-action bg-surface font-medium' : 'border-rule bg-transparent text-ink-2')}>
            {done ? <Check aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={2} /> : <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', inProgress ? 'bg-action' : 'bg-stroke/60')} />}
            <span>{row.label}<span className="sr-only">{done ? ' — done' : inProgress ? ' — in progress' : ' — not reached'}</span></span>
          </li>
        );
      })}
    </ol>
  );
}

/** Actual counters against pinned budgets. No estimated percentages. */
export function BudgetMeters({ detail }: { detail: DiscoveryJobDetail }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {budgetRows(detail.job).map(row => (
        <div key={row.key}>
          <dt className="text-meta text-ink-2">{row.label}</dt>
          <dd className="mt-1 text-control"><span className="font-medium">{row.used}</span> of {row.limit} used</dd>
          <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle"><div className="h-full bg-ink" style={{ width: `${Math.min(100, (row.used / row.limit) * 100)}%` }} /></div>
        </div>
      ))}
    </dl>
  );
}

function AnchorChoice({ projectId, jobId, resolution, anchor, onConfirmed }: {
  projectId: string; jobId: string; resolution: AnchorResolution; anchor: { label: string; kind: string; profileId: 'a' | 'b' }; onConfirmed: () => void;
}) {
  const api = useApi();
  const [choice, setChoice] = useState<string | null>(null);
  const [requestId] = useState(newId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  async function confirm() {
    if (!choice) return;
    setPending(true); setError(null);
    const result = await api.discovery.confirmAnchor(projectId, jobId, { schema_version: SCHEMA_VERSION, id: requestId, anchorId: resolution.anchorId, resolutionId: resolution.id, entityId: choice });
    setPending(false);
    if (result.ok) onConfirmed(); else setError(result.error);
  }
  return (
    <div className="space-y-3 rounded-panel border border-rule bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2"><ProfileTag profile={anchor.profileId} /><span className="text-ink-2">·</span><span className="font-medium">{anchor.label}</span><Badge>{anchor.kind}</Badge></div>
      {resolution.candidates.length === 0 ? <p className="text-control text-ink-2">Qloo returned no candidates for this interest. It stays unresolved; nothing is guessed.</p> : (
        <RadioGroup aria-label={`Qloo match for ${anchor.label}`} value={choice} onChange={setChoice} className="space-y-2">
          {resolution.candidates.map(candidate => (
            <Radio key={candidate.entityId} value={candidate.entityId} className="group flex min-h-11 cursor-pointer items-start gap-3 rounded-control border border-stroke p-3 data-[selected]:border-action data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-action">
              <span aria-hidden className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-stroke group-data-[selected]:border-action"><span className="size-2.5 rounded-full bg-action opacity-0 group-data-[selected]:opacity-100" /></span>
              <span className="min-w-0"><span className="block font-medium">{candidate.name}</span><span className="block text-meta text-ink-2">{candidate.kind} · <code className="break-all">{candidate.entityId}</code></span></span>
            </Radio>
          ))}
        </RadioGroup>
      )}
      {error ? <ErrorState error={error} what="this confirmation" /> : null}
      {resolution.candidates.length ? <Button onPress={() => void confirm()} isDisabled={!choice} isPending={pending} pendingLabel="Confirming">Confirm this match</Button> : null}
      {!choice && resolution.candidates.length ? <p className="text-meta text-ink-2">Choose a match to confirm. Even a single candidate needs your confirmation.</p> : null}
    </div>
  );
}

export function AnchorConfirmations({ projectId, detail, onConfirmed }: { projectId: string; detail: DiscoveryJobDetail; onConfirmed: () => void }) {
  const confirmed = new Set(detail.confirmations.map(row => row.anchorId));
  const anchors = new Map(detail.job.input.request.profiles.flatMap(profile => profile.anchors.map(anchor => [anchor.id, { ...anchor, profileId: profile.id, preconfirmed: Boolean(anchor.confirmedEntityId) }] as const)));
  const open = detail.resolutions.filter(row => !confirmed.has(row.anchorId) && !anchors.get(row.anchorId)?.preconfirmed);
  const latest = [...new Map(open.map(row => [row.anchorId, row])).values()];
  if (!latest.length) return null;
  return (
    <div className="space-y-3">
      {latest.map(resolution => {
        const anchor = anchors.get(resolution.anchorId);
        return anchor ? <AnchorChoice key={resolution.id} projectId={projectId} jobId={detail.job.id} resolution={resolution} anchor={anchor} onConfirmed={onConfirmed} /> : null;
      })}
    </div>
  );
}

export function CandidateList({ projectId, detail, cases, onCreated }: { projectId: string; detail: DiscoveryJobDetail; cases: ReviewCaseResponse[] | null; onCreated: () => void }) {
  const api = useApi();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  // One stable case ID per candidate, so retrying an unconfirmed request can't create a duplicate.
  const [requestIds] = useState(() => new Map<string, string>());
  const catalog = new Map(detail.job.input.targetInput.catalog.entries.map(entry => [entry.id, entry.name]));
  if (!detail.candidates.length) return <p className="text-ink-2">No case saved by this job yet. Saved cases appear here as soon as they exist, even while the job keeps running.</p>;
  async function open(candidateId: string) {
    setPending(candidateId); setError(null);
    if (!requestIds.has(candidateId)) requestIds.set(candidateId, newId());
    const result = await api.cases.create(projectId, { schema_version: SCHEMA_VERSION, id: requestIds.get(candidateId)!, jobId: detail.job.id, candidateId });
    setPending(null);
    if (result.ok) { onCreated(); router.push(routes.case(projectId, result.data.case.id)); } else setError(result.error);
  }
  return (
    <div className="space-y-3">
      {error ? <ErrorState error={error} what="a review case" /> : null}
      <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
        {detail.candidates.map(candidate => {
          const [x, y] = candidate.content.contrast.entryIds;
          const existing = cases?.find(row => row.case.candidateId === candidate.id);
          return (
            <li key={candidate.id} className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-center">
              <div className="min-w-0">
                <p className="font-medium break-words">{catalog.get(x) ?? x} and {catalog.get(y) ?? y}</p>
                <p className="text-meta text-ink-2">Saved <Time iso={candidate.createdAt} /> · Qloo ordered this pair differently for Profile A and Profile B · <Badge tone="advisory">Advisory</Badge></p>
              </div>
              {existing ? (
                <Link href={routes.case(projectId, existing.case.id)} className="inline-flex min-h-11 items-center gap-1.5 text-control font-medium text-action underline-offset-4 hover:underline">Open review<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} /></Link>
              ) : (
                <Button variant="secondary" onPress={() => void open(candidate.id)} isPending={pending === candidate.id} isDisabled={cases === null} pendingLabel="Opening">Open for review</Button>
              )}
            </li>
          );
        })}
      </ul>
      {cases === null ? <p className="text-meta text-ink-2">Review status is unavailable until the case list loads, so opening is paused to avoid duplicates.</p> : null}
    </div>
  );
}

export function RunsTable({ detail }: { detail: DiscoveryJobDetail }) {
  if (!detail.attempts.length) return <p className="text-ink-2">No assistant runs scheduled yet.</p>;
  return (
    <div tabIndex={0} role="region" aria-label="Assistant runs table" className="overflow-x-auto rounded-panel border border-rule bg-surface">
      <table className="w-full min-w-[40rem] text-left text-control">
        <caption className="sr-only">Assistant runs for this job</caption>
        <thead className="bg-subtle text-meta text-ink-2"><tr>{['Profile', 'Question', 'Repeat', 'Status', 'Dispatches', 'Notes'].map(h => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-rule">
          {detail.attempts.map(row => (
            <tr key={row.attemptId}>
              <td className="px-3 py-2"><ProfileTag profile={row.profileId} /></td>
              <td className="px-3 py-2">{row.variant === 'full' ? 'Full brief' : 'Two-restaurant follow-up'}{row.round ? ` · round ${row.round + 1}` : ''}</td>
              <td className="px-3 py-2">{row.repeat + 1}</td>
              <td className="px-3 py-2">{row.status === 'completed' ? 'Completed' : row.status === 'leased' ? 'Running on your runner' : 'Waiting for your runner'}</td>
              <td className="px-3 py-2">{row.dispatchCount}</td>
              <td className="px-3 py-2 text-ink-2">{[row.cancelled ? 'Cancelled' : null, row.uncertainDispatches ? `${row.uncertainDispatches} interrupted (may have repeated)` : null].filter(Boolean).join(' · ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PROVIDER_STATUS: Record<string, string> = { reserved: 'Reserved', dispatched: 'Sent', accepted: 'Accepted', error: 'Error', interrupted: 'Interrupted before sending', uncertain: 'Outcome unknown' };

export function ProviderLedger({ detail }: { detail: DiscoveryJobDetail }) {
  if (!detail.providerAttempts.length) return <p className="text-ink-2">No Qloo or model calls reserved yet.</p>;
  return (
    <div tabIndex={0} role="region" aria-label="Qloo and model call ledger" className="overflow-x-auto rounded-panel border border-rule bg-surface">
      <table className="w-full min-w-[40rem] text-left text-control">
        <caption className="sr-only">Qloo and model call ledger</caption>
        <thead className="bg-subtle text-meta text-ink-2"><tr>{['Provider', 'Operation', 'Try', 'Status', 'Error', 'Reserved'].map(h => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-rule">
          {detail.providerAttempts.map(row => (
            <tr key={row.id}>
              <td className="px-3 py-2">{row.kind === 'qloo' ? 'Qloo' : 'Model'}</td>
              <td className="px-3 py-2 font-mono text-meta break-all">{row.operationKey}</td>
              <td className="px-3 py-2">{row.tryNumber + 1}</td>
              <td className="px-3 py-2">{PROVIDER_STATUS[row.status] ?? row.status}</td>
              <td className="px-3 py-2 text-ink-2">{row.errorCategory ? `${row.errorCategory}${row.errorCode ? ` (${row.errorCode})` : ''}${row.retryable ? ' · will retry' : ''}` : '—'}</td>
              <td className="px-3 py-2 text-ink-2"><Time iso={row.reservedAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EVIDENCE_KIND = { rank: 'Qloo ranking', resolve: 'Interest lookup', facts: 'Computed contrasts', model_decision: 'Model choice' } as const;

export function EvidenceList({ detail }: { detail: DiscoveryJobDetail }) {
  if (!detail.evidence.length) return <p className="text-ink-2">No evidence captured yet.</p>;
  const names = new Map(detail.job.input.targetInput.catalog.entries.map(entry => [entry.id, entry.name]));
  const name = (id: string) => names.get(id) ?? id;
  return (
    <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
      {detail.evidence.map(row => {
        const data = row.data;
        return (
          <li key={row.id}>
            <details className="group p-4">
              <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2">
                <span className="font-medium">{EVIDENCE_KIND[data.kind]}</span>
                {data.kind === 'rank' ? <><ProfileTag profile={data.profileId} /><Badge tone={data.providerStatus === 'ok' ? 'neutral' : 'unavailable'}>{data.providerStatus}</Badge><span className="text-meta text-ink-2">{data.scope === 'full' ? 'full catalog' : 'two-restaurant follow-up'}</span></> : null}
                {data.kind === 'resolve' ? <Badge tone={data.providerStatus === 'ok' ? 'neutral' : 'unavailable'}>{data.providerStatus}</Badge> : null}
                <span className="text-meta text-ink-2">Captured <Time iso={row.capturedAt} /></span>
                <span className="ml-auto text-meta text-action group-open:hidden">Show details</span>
              </summary>
              <div className="mt-3 space-y-2 text-control">
                {data.kind === 'rank' ? <>
                  <p>Order: {data.orderedEntryIds.length ? data.orderedEntryIds.map((id, index) => `${index + 1}. ${name(id)}`).join('  ') : 'No ranking established'}</p>
                  {data.missingEntryIds.length ? <p className="text-ink-2">Missing from Qloo’s answer (unavailable, not disliked): {data.missingEntryIds.map(name).join(', ')}</p> : null}
                  {data.unmappedEntryIds.length ? <p className="text-ink-2">Not ranked — no confirmed mapping: {data.unmappedEntryIds.map(name).join(', ')}</p> : null}
                  {data.error ? <p className="text-ink-2">Provider error: {data.error.category} ({data.error.code})</p> : null}
                </> : null}
                {data.kind === 'resolve' ? <p>{data.candidates.length} candidate match{data.candidates.length === 1 ? '' : 'es'} returned.</p> : null}
                {data.kind === 'facts' ? <p>{data.contrasts.length} reversed pair{data.contrasts.length === 1 ? '' : 's'} found{data.unsupportedReason ? ` · not supported: ${data.unsupportedReason.replaceAll('_', ' ')}` : ''}.</p> : null}
                {data.kind === 'model_decision' ? <p>{data.selectedContrastId ? 'Selected one observed contrast.' : 'Selected no contrast.'} The model’s prose isn’t treated as evidence.</p> : null}
                <p className="flex flex-wrap items-center gap-1 text-meta text-ink-2">Evidence checksum <Hash value={row.checksum} label="evidence checksum" /></p>
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
