'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Segmented } from '@/components/ui/choice';
import { Sheet } from '@/components/ui/dialog';
import { Time } from '@/components/ui/data';
import { cn } from '@/lib/cn';
import { entryFacts, type AttemptSlot, type CaseView } from '@/lib/view/case-view';
import {
  BriefPanel, ConstraintStrip, profileName, FindingSummary, LinkProvider, OutputPanel, PairedSection, RankingPanel, RepeatedBehavior, SelectionSummary,
  type PinnedItem,
} from './case-parts';
import { InspectorContent, InspectorPanel } from './inspector';
import { ProfileTag } from './labels';

/** Captured slots plus intended-but-missing full repeats, so a missing attempt is shown, not hidden. */
function attemptOptions(view: CaseView): { slots: AttemptSlot[]; missing: string[] } {
  const missing = Array.from({ length: view.repeatCount }, (_, repeat) => repeat)
    .filter(repeat => !view.slots.some(slot => slot.variant === 'full' && slot.round === 0 && slot.repeat === repeat))
    .map(repeat => `Repeat ${repeat + 1}`);
  return { slots: view.slots, missing };
}

export function CaseReview({ view, header, decision, history }: { view: CaseView; header?: ReactNode; decision?: ReactNode; history?: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState<PinnedItem | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pinTrigger = useRef<HTMLElement | null>(null);
  const { slots, missing } = useMemo(() => attemptOptions(view), [view]);
  const [slotKey, setSlotKey] = useState<string | null>(slots[0]?.key ?? null);
  const slot = slots.find(row => row.key === slotKey) ?? slots[0];
  const [x, y] = view.contrast.entryIds;

  const pin = (item: PinnedItem) => {
    pinTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPinned(item);
    if (!window.matchMedia('(min-width: 75rem)').matches) setSheetOpen(true);
  };
  const closeInspector = () => {
    setPinned(null);
    if (pinTrigger.current?.isConnected) pinTrigger.current.focus();
  };

  return (
    <LinkProvider value={{ selected, select: setSelected, pin, view }}>
      <div className={cn('grid gap-8', pinned && 'xl:grid-cols-[minmax(0,1fr)_22rem]')} onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented || !pinned || sheetOpen) return;
        if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"]')) return;
        event.preventDefault();
        event.stopPropagation();
        closeInspector();
      }}>
        <div className="min-w-0 space-y-8">
          {header ?? (
            <div>
              <h1 className="text-title font-medium break-words">{entryFacts(view.catalog, x).name} and {entryFacts(view.catalog, y).name}</h1>
              <p className="mt-2 text-control text-ink-2">
                Task: {view.taskLabel} · Assistant <code className="break-all">{view.assistantVersion}</code>
                {view.evidenceCapturedAt ? <> · Evidence captured <Time iso={view.evidenceCapturedAt} /></> : null}
              </p>
            </div>
          )}
          <ConstraintStrip constraints={view.constraints} view={view} />
          <FindingSummary view={view} />
          {decision ? <p><a href="#decision" className="text-control font-medium text-action underline underline-offset-4">Jump to your decision</a></p> : null}

          <div className="sticky top-16 z-10 -mx-1 rounded-control bg-canvas/95 px-1 py-2 backdrop-blur-[2px]"><SelectionSummary slot={slot} /></div>

          <PairedSection title="Briefs" view={view} render={profile => <BriefPanel view={view} profile={profile} />} />

          <section aria-label="Assistant outputs" className="space-y-3">
            <div className="flex flex-col gap-3">
              <div>
                <h2 className="text-section font-medium">Assistant outputs</h2>
                <p className="mt-1 text-control text-ink-2">Stored attempts only — browsing never sends a new request.</p>
              </div>
              {slots.length > 1 || missing.length ? (
                <Segmented label="Captured attempt" selectedKeys={slot ? [slot.key] : []} onSelectionChange={keys => { const [key] = [...keys]; if (key) setSlotKey(String(key)); }}
                  items={[...slots.map(row => ({ id: row.key, label: row.label })), ...missing.map(label => ({ id: `missing:${label}`, label: `${label} · not captured`, isDisabled: true, description: 'Intended, but no run was captured' }))]} />
              ) : null}
            </div>
            {slots.length ? (
              <div className={cn('grid gap-4', view.profiles.length > 1 && 'lg:grid-cols-2')}>
                {view.profiles.map(profile => (
                  <article key={profile} className="min-w-0 rounded-panel border border-rule bg-surface p-4 md:p-5">
                    <ProfileTag profile={profileName(view, profile)} />
                    <div className="mt-3"><OutputPanel slot={slot} profile={profile} /></div>
                  </article>
                ))}
              </div>
            ) : <p className="rounded-panel bg-unavailable-bg p-4 text-control">No assistant runs were captured for this case.</p>}
          </section>

          <PairedSection title="Qloo rankings and evidence" view={view} description="Rankings order the same eligible, mapped restaurants within one query. Missing and unmapped restaurants are listed, never treated as disliked."
            render={profile => <RankingPanel view={view} profile={profile} />} />

          <section aria-label="Repeated behaviour" className="space-y-2">
            <h2 className="text-section font-medium">Repeated behaviour</h2>
            <RepeatedBehavior view={view} />
          </section>

          {decision}
          {history}
        </div>
        {pinned ? <div className="hidden xl:block"><InspectorPanel item={pinned} view={view} onClose={closeInspector} /></div> : null}
      </div>
      <Sheet isOpen={sheetOpen && Boolean(pinned)} onOpenChange={open => { setSheetOpen(open); if (!open) setPinned(null); }} title="Pinned evidence">
        {pinned ? <InspectorContent item={pinned} view={view} /> : null}
      </Sheet>
    </LinkProvider>
  );
}
