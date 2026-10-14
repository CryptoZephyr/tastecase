'use client';

import { Crosshair, PanelRightOpen } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { Button as AriaButton, Tooltip, TooltipTrigger } from 'react-aria-components';
import { Badge, ClassBadge, TraceBadge } from '@/components/ui/badge';
import { Time } from '@/components/ui/data';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';
import type { PracticalConstraints } from '@/lib/api/types';
import {
  entryFacts, limitationSummary, outputState, positionIn, recommendationIds, sameRecommendations,
  type AttemptSlot, type CaseView, type OutputState, type ProfileId, type RankingView, type SlotOutput,
} from '@/lib/view/case-view';
import { ProfileTag } from './labels';

/* ---------- Linked evidence highlighting ---------- */

interface Linking { selected: string | null; select: (id: string | null) => void; pin: (item: PinnedItem) => void; view: CaseView }
export type PinnedItem = { kind: 'ranking'; ranking: RankingView } | { kind: 'attempt'; output: SlotOutput; slotLabel: string };
const LinkContext = createContext<Linking | null>(null);
export const LinkProvider = LinkContext.Provider;
function useLinking(): Linking {
  const value = useContext(LinkContext);
  if (!value) throw new Error('Case parts must be rendered inside LinkProvider');
  return value;
}

/** A restaurant reference. Selecting it highlights the same stable catalog ID everywhere it appears. */
export function EntryChip({ id, name, prefix, note }: { id?: string; name?: string; prefix?: string; note?: string }) {
  const { selected, select, view } = useLinking();
  if (!id) {
    return <span className="inline-flex items-center gap-1.5 rounded-control border border-dashed border-stroke px-2 py-1 text-control">{prefix}{name} <span className="text-meta text-ink-2">(no catalog ID)</span></span>;
  }
  const facts = entryFacts(view.catalog, id);
  const active = selected === id;
  return (
    <AriaButton onPress={() => select(active ? null : id)} aria-pressed={active}
      className={cn('inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-control border px-2 py-1 text-left text-control transition-colors duration-150',
        active ? 'border-action bg-champagne font-medium text-ink' : 'border-rule bg-surface hover:border-stroke',
        !facts.known && 'border-dashed')}>
      {active ? <Crosshair aria-hidden className="size-3.5 shrink-0" strokeWidth={2} /> : null}
      <span className="min-w-0 truncate">{prefix}{facts.name}</span>
      {!facts.known ? <span className="text-meta text-failed">not in catalog</span> : !facts.eligible ? <span className="text-meta text-ink-2">not eligible</span> : null}
      {note ? <span className="text-meta text-ink-2">{note}</span> : null}
    </AriaButton>
  );
}

/** Explicit statement when the selected restaurant is absent from a panel. */
export function AbsentNote({ ids, what }: { ids: (string | undefined)[] | null; what: string }) {
  const { selected, view } = useLinking();
  if (!selected || !ids || ids.includes(selected)) return null;
  return <p className="mt-2 rounded-control bg-subtle px-2 py-1 text-meta text-ink">{entryFacts(view.catalog, selected).name}: {what}</p>;
}

export function SelectionSummary({ slot }: { slot: AttemptSlot | undefined }) {
  const { selected, select, view } = useLinking();
  if (!selected) return <p className="text-meta text-ink-2">Select any restaurant to highlight it across rankings and outputs.</p>;
  const name = entryFacts(view.catalog, selected).name;
  const parts = view.profiles.flatMap(profile => {
    const full = view.rankings.find(row => row.profileId === profile && row.scope === 'full');
    const rank = full ? positionIn(full.ordered, selected) : null;
    const output = slot ? recommendationIds(outputState(slot.outputs[profile])) : null;
    const position = output ? positionIn(output, selected) : null;
    const label = view.profiles.length === 1 ? 'Case brief' : `Profile ${profile.toUpperCase()}`;
    return [`${label}: ${!full ? 'no full ranking captured' : rank ? `Qloo rank ${rank}` : full.missing.includes(selected) ? 'missing from Qloo’s answer' : full.unmapped.includes(selected) ? 'not ranked (unmapped)' : 'not in ranking'}, ${output === null ? 'no output to compare' : position ? `recommended #${position}` : 'not recommended'}`];
  });
  return (
    <div className="flex flex-wrap items-center gap-2 text-meta" aria-live="polite">
      <span className="font-medium text-ink">{name}</span>
      <span className="text-ink">{parts.join(' · ')}</span>
      <AriaButton onPress={() => select(null)} className="min-h-11 rounded-control px-2 text-action underline-offset-4 hover:underline">Clear</AriaButton>
    </div>
  );
}

/** Hover or focus previews; activation pins the full record in the inspector (tap on touch). */
export function PeekPin({ item, summary, label }: { item: PinnedItem; summary: string; label: string }) {
  const { pin } = useLinking();
  return (
    <TooltipTrigger delay={350}>
      <AriaButton onPress={() => pin(item)} aria-label={`Inspect ${label}`}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 text-meta text-action hover:bg-subtle">
        <PanelRightOpen aria-hidden className="size-4" strokeWidth={1.75} /> Inspect
      </AriaButton>
      <Tooltip offset={6} className="max-w-xs rounded-control bg-ink px-3 py-2 text-meta text-white shadow-float">{summary}</Tooltip>
    </TooltipTrigger>
  );
}

/* ---------- Layout ---------- */

export function profileName(view: CaseView, profile: ProfileId) {
  return view.profiles.length === 1 ? 'single' : profile;
}

/** Matching A/B pair: side by side where space permits, A then B when stacked. Labels repeat per section. */
export function PairedSection({ title, view, render, description }: { title: string; view: CaseView; render: (profile: ProfileId) => ReactNode; description?: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3">
      <div>
        <h2 className="text-section font-medium">{title}</h2>
        {description ? <p className="mt-1 text-control text-ink-2">{description}</p> : null}
      </div>
      <div className={cn('grid gap-4', view.profiles.length > 1 && 'lg:grid-cols-2')}>
        {view.profiles.map(profile => (
          <article key={profile} className="min-w-0 rounded-panel border border-rule bg-surface p-4 md:p-5">
            <ProfileTag profile={profileName(view, profile)} />
            <div className="mt-3">{render(profile)}</div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function ConstraintStrip({ constraints, view }: { constraints: PracticalConstraints; view: CaseView }) {
  const items: [string, string][] = [
    ['Party size', String(constraints.partySize)],
    ['Location', constraints.location ? `${constraints.location.city}${constraints.location.countryCode ? `, ${constraints.location.countryCode}` : ''}` : 'Not specified'],
    ['Budget per person', constraints.budgetPerPerson ? formatMoney(constraints.budgetPerPerson.amountMinor, constraints.budgetPerPerson.currency) : 'Not specified'],
    ['Dietary', constraints.dietaryRequirements.join(', ') || 'None stated'],
    ['Accessibility', constraints.accessibilityRequirements.join(', ') || 'None stated'],
    ['Required cuisines', constraints.requiredCuisines.join(', ') || 'None stated'],
    ['Eligible restaurants', `${view.catalog.eligible.size} of ${view.catalog.entries.length} in ${view.catalogLabel}`],
    ['Excluded', constraints.excludedEntryIds.length ? constraints.excludedEntryIds.map(id => entryFacts(view.catalog, id).name).join(', ') : 'None'],
  ];
  return (
    <section aria-label="Shared constraints" className="rounded-panel bg-subtle p-4">
      <p className="text-control font-medium">Shared constraints <span className="font-normal text-ink-2">— unchanged for {view.profiles.length > 1 ? 'both profiles' : 'this brief'} and every repeat</span></p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-4">
        {items.map(([term, detail]) => <div key={term} className="min-w-0"><dt className="text-meta text-ink-2">{term}</dt><dd className="text-control break-words">{detail}</dd></div>)}
      </dl>
    </section>
  );
}

export function FindingSummary({ view }: { view: CaseView }) {
  const [x, y] = view.contrast.entryIds;
  const paired = view.profiles.length > 1;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section aria-labelledby="finding-title" className="rounded-panel border border-rule bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="finding-title" className="text-section font-medium">Finding</h2>
          <ClassBadge classification="advisory" />
        </div>
        <p className="mt-3 text-body">
          {paired ? <>Qloo ranked <EntryChip id={x} /> above <EntryChip id={y} /> for Profile A, and the reverse for Profile B.</> : <>Qloo’s ranking placed <EntryChip id={x} /> above <EntryChip id={y} />.</>}
        </p>
        <p className="mt-3 text-control text-ink-2">This is a cultural contrast to investigate, not a failed test. It can’t become an automatic failure unless you write an explicit rule.</p>
        <div className="mt-4 rounded-control bg-subtle p-3">
          <p className="text-meta text-ink-2">Proposed rationale (from discovery)</p>
          <p className="mt-1 text-control">{view.proposedRationale}</p>
        </div>
      </section>
      <section aria-labelledby="limits-title" className="rounded-panel border border-unavailable/30 bg-unavailable-bg p-4 md:p-5">
        <h2 id="limits-title" className="text-section font-medium">Evidence limits</h2>
        <dl className="mt-3 space-y-2 text-control">
          <div><dt className="text-meta text-ink-2">Ranking coverage</dt><dd>{view.rankings.filter(row => row.scope === 'full').map(row => `${paired ? `Profile ${row.profileId.toUpperCase()}` : 'Ranking'}: ${row.ordered.length} of ${row.requested.length} ranked (${row.providerStatus})`).join(' · ') || 'No full ranking captured'}</dd></div>
          <div><dt className="text-meta text-ink-2">Missing or unranked candidates</dt><dd>{[...view.coverage.missingEntryIds, ...view.coverage.unmappedEntryIds].length ? (
            <span className="flex flex-wrap gap-1.5">{view.coverage.missingEntryIds.map(id => <EntryChip key={`m-${id}`} id={id} note="missing" />)}{view.coverage.unmappedEntryIds.map(id => <EntryChip key={`u-${id}`} id={id} note="unmapped" />)}</span>
          ) : 'None — every eligible mapped restaurant was ranked'}</dd></div>
          <div><dt className="text-meta text-ink-2">Trace completeness</dt><dd>{traceSummary(view)}</dd></div>
        </dl>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-meta text-ink">
          {limitationSummary(view.coverage).map(line => <li key={line}>{line}</li>)}
          {view.limitations.map(line => <li key={line}>{line}</li>)}
        </ul>
      </section>
    </div>
  );
}

function traceSummary(view: CaseView): string {
  const total = view.slots.flatMap(slot => Object.values(slot.outputs)).filter(output => output?.association.status === 'completed').length;
  const partial = view.coverage.partialTraceAttemptIds.length; const missing = view.coverage.unavailableTraceAttemptIds.length; const unread = view.coverage.unreadAttemptIds.length;
  if (!total) return 'No completed assistant runs yet.';
  const complete = total - partial - missing - unread;
  return `${complete} complete, ${partial} partial, ${missing} unavailable${unread ? `, ${unread} unknown` : ''} of ${total} completed runs. Missing trace can’t prove a missing tool call.`;
}

export function BriefPanel({ view, profile }: { view: CaseView; profile: ProfileId }) {
  const brief = view.briefs[profile];
  const anchors = view.anchors[profile] ?? [];
  if (!brief) return <p className="text-ink-2">No brief captured.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{brief.label}</p><Badge tone="info">Synthetic</Badge></div>
      <p className="text-control whitespace-pre-wrap">{brief.text}</p>
      {anchors.length ? (
        <div>
          <p className="text-meta text-ink-2">Public interests{view.profileLabels[profile] ? ` · ${view.profileLabels[profile]}` : ''}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">{anchors.map(anchor => <li key={anchor.id} className="rounded-full border border-rule px-2 py-0.5 text-meta">{anchor.label} · {anchor.kind}{anchor.confirmed ? '' : ' · unconfirmed'}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

function outputSummary(state: OutputState): string {
  switch (state.kind) {
    case 'success': return `${state.recommendations.length} recommendation${state.recommendations.length === 1 ? '' : 's'}; trace ${state.trace}`;
    case 'malformed': return `Malformed output (${state.code}); trace ${state.trace}`;
    case 'unavailable': return `Provider unavailable (${state.code}); trace ${state.trace}`;
    case 'pending': return state.status === 'leased' ? 'Running on your runner' : 'Waiting for your runner';
    case 'unread': return 'Completed, but the record didn’t load';
    case 'not_captured': return 'Not captured';
  }
}

export function OutputPanel({ slot, profile }: { slot: AttemptSlot | undefined; profile: ProfileId }) {
  const output = slot?.outputs[profile];
  const state = outputState(output);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-meta text-ink-2">{slot?.label ?? 'No attempt'}</span>
          {state.kind === 'success' || state.kind === 'malformed' || state.kind === 'unavailable' ? <TraceBadge completeness={state.trace} /> : null}
        </div>
        {output && slot ? <PeekPin item={{ kind: 'attempt', output, slotLabel: slot.label }} label={`${slot.label} output`} summary={outputSummary(state)} /> : null}
      </div>
      {state.kind === 'success' ? (
        <>
          {state.recommendations.length ? (
            <ol className="flex flex-col gap-1.5">{state.recommendations.map((row, index) => <li key={index}><EntryChip id={row.catalogEntryId} name={row.name} prefix={`${index + 1}. `} /></li>)}</ol>
          ) : <p className="text-control text-ink-2">The assistant returned no recommendations.</p>}
          <AbsentNote ids={recommendationIds(state)} what="not recommended in this output" />
          {state.text ? <details className="text-control"><summary className="min-h-11 cursor-pointer py-2 text-action underline-offset-4 hover:underline">Read the full response</summary><p className="mt-1 whitespace-pre-wrap rounded-control bg-subtle p-3">{state.text}</p></details> : null}
        </>
      ) : null}
      {state.kind === 'malformed' ? <p className="rounded-control bg-unavailable-bg p-3 text-control">The assistant’s output didn’t match the expected shape ({state.code}). This is an execution gap here, not a taste failure.</p> : null}
      {state.kind === 'unavailable' ? <p className="rounded-control bg-unavailable-bg p-3 text-control">No usable response: {state.message} ({state.code}){state.retryable ? '. The provider marked this retryable.' : '.'} Not a pass or a failure.</p> : null}
      {state.kind === 'pending' ? <p className="rounded-control bg-unavailable-bg p-3 text-control">{state.status === 'leased' ? 'Your runner has claimed this run; the result hasn’t been uploaded yet.' : 'Queued for your runner. Nothing has run yet.'}</p> : null}
      {state.kind === 'unread' ? <p className="rounded-control bg-unavailable-bg p-3 text-control">This run completed, but its record couldn’t be loaded. Refresh to try again.</p> : null}
      {state.kind === 'not_captured' ? <p className="rounded-control bg-unavailable-bg p-3 text-control">No run was captured for this attempt. TasteCase doesn’t assume one happened.</p> : null}
    </div>
  );
}

export function RankingPanel({ view, profile }: { view: CaseView; profile: ProfileId }) {
  const rows = view.rankings.filter(row => row.profileId === profile).sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'full' ? -1 : 1));
  if (!rows.length) return <p className="text-control text-ink-2">No Qloo ranking was captured for this profile.</p>;
  return (
    <div className="space-y-5">
      {rows.map(row => (
        <div key={row.evidenceId}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-control font-medium">{row.scope === 'full' ? 'Full catalog ranking' : 'Two-restaurant follow-up'}</span>
              <Badge tone={row.providerStatus === 'ok' ? 'neutral' : 'unavailable'}>Qloo: {row.providerStatus}</Badge>
            </div>
            <PeekPin item={{ kind: 'ranking', ranking: row }} label={`${row.scope === 'full' ? 'Full' : 'Follow-up'} ranking`}
              summary={`${row.ordered.length} of ${row.requested.length} ranked · ${row.missing.length} missing · captured ${new Date(row.capturedAt).toLocaleString()}`} />
          </div>
          <p className="mt-1 text-meta text-ink-2">Captured <Time iso={row.capturedAt} /> · order within this query only</p>
          {row.ordered.length ? <ol className="mt-2 flex flex-col gap-1.5">{row.ordered.map((id, index) => <li key={id}><EntryChip id={id} prefix={`${index + 1}. `} /></li>)}</ol>
            : <p className="mt-2 text-control text-ink-2">No ranking was established{row.errorCode ? ` (${row.errorCode})` : ''}.</p>}
          {row.missing.length ? <div className="mt-2"><p className="text-meta text-ink-2">Missing from Qloo’s answer — unavailable, not disliked</p><div className="mt-1 flex flex-wrap gap-1.5">{row.missing.map(id => <EntryChip key={id} id={id} />)}</div></div> : null}
          {row.unmapped.length ? <div className="mt-2"><p className="text-meta text-ink-2">Not ranked — no confirmed mapping</p><div className="mt-1 flex flex-wrap gap-1.5">{row.unmapped.map(id => <EntryChip key={id} id={id} />)}</div></div> : null}
          <AbsentNote ids={[...row.ordered, ...row.missing, ...row.unmapped]} what="not part of this query" />
        </div>
      ))}
    </div>
  );
}

/** Code-computed behaviour summary across profiles and repeats; descriptive, never a verdict. */
export function RepeatedBehavior({ view }: { view: CaseView }) {
  const full = view.slots.filter(slot => slot.variant === 'full');
  const lines: string[] = [];
  if (view.profiles.length > 1) {
    for (const slot of full) {
      const same = sameRecommendations(outputState(slot.outputs.a), outputState(slot.outputs.b));
      lines.push(`${slot.label}: ${same === null ? 'can’t compare — a result is missing, malformed or lacks catalog IDs' : same ? 'Profile A and Profile B received the same recommendations' : 'Profile A and Profile B received different recommendations'}.`);
    }
  }
  for (const profile of view.profiles) {
    const states = full.map(slot => outputState(slot.outputs[profile]));
    if (states.length < 2) continue;
    const comparisons = states.slice(1).map(state => sameRecommendations(states[0], state));
    const label = view.profiles.length === 1 ? 'Case brief' : `Profile ${profile.toUpperCase()}`;
    lines.push(`${label} repeats: ${comparisons.some(value => value === null) ? 'not all comparable' : comparisons.every(Boolean) ? 'identical across repeats' : 'differ between repeats'}.`);
  }
  if (!lines.length) return <p className="text-control text-ink-2">Not enough captured runs to compare yet.</p>;
  return <ul className="list-disc space-y-1 pl-5 text-control">{lines.map(line => <li key={line}>{line}</li>)}</ul>;
}
