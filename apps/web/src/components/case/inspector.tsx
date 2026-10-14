'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { TraceBadge } from '@/components/ui/badge';
import { Facts, Hash, Time } from '@/components/ui/data';
import { profileLabel } from '@/lib/format';
import { entryFacts, type CaseView } from '@/lib/view/case-view';
import type { PinnedItem } from './case-parts';

export function InspectorContent({ item, view }: { item: PinnedItem; view: CaseView }) {
  const name = (id: string) => entryFacts(view.catalog, id).name;
  if (item.kind === 'ranking') {
    const row = item.ranking;
    return (
      <div className="space-y-4 text-control">
        <p className="font-medium">Qloo ranking · {profileLabel(row.profileId)} · {row.scope === 'full' ? 'full catalog' : 'two-restaurant follow-up'}</p>
        <Facts columns={1} items={[
          ['Provider status', row.providerStatus], ['Captured', <Time key="t" iso={row.capturedAt} />],
          ['Requested (mapped, eligible)', row.requested.map(name).join(', ')],
          ['Returned order', row.ordered.length ? row.ordered.map((id, index) => `${index + 1}. ${name(id)}`).join('  ') : 'None'],
          ['Missing — unavailable, not disliked', row.missing.map(name).join(', ') || 'None'],
          ['Unmapped — not ranked', row.unmapped.map(name).join(', ') || 'None'],
          ...(row.errorCode ? [['Provider error', row.errorCode] as [string, string]] : []),
          ['Evidence ID', <code key="i" className="break-all font-mono text-meta">{row.evidenceId}</code>],
          ['Checksum', <Hash key="h" value={row.checksum} label="evidence checksum" />],
        ]} />
        <p className="text-meta text-ink-2">Order is relative within this query. Scores from different queries are never subtracted or combined.</p>
      </div>
    );
  }
  const { association, attempt } = item.output;
  const result = attempt?.result ?? null;
  return (
    <div className="space-y-4 text-control">
      <p className="font-medium">Assistant run · {profileLabel(association.profileId)} · {item.slotLabel}</p>
      <Facts columns={1} items={[
        ['Status', association.status], ['Dispatches', `${association.dispatchCount}${association.uncertainDispatches ? ` (${association.uncertainDispatches} interrupted, may have repeated)` : ''}`],
        ['Cancelled', association.cancelled ? 'Yes' : 'No'],
        ['Attempt ID', <code key="a" className="break-all font-mono text-meta">{association.attemptId}</code>],
        ...(attempt ? [
          ['Input checksum', <Hash key="ic" value={attempt.inputChecksum} label="input checksum" />],
          ['Result checksum', attempt.resultChecksum ? <Hash key="rc" value={attempt.resultChecksum} label="result checksum" /> : 'No result yet'],
          ['Completed', attempt.completedAt ? <Time key="c" iso={attempt.completedAt} /> : 'Not completed'],
        ] as [string, ReactNode][] : [['Record', 'Not loaded'] as [string, string]]),
        ['Outcome', result ? result.outcome.replaceAll('_', ' ') : 'No result'],
      ]} />
      {result ? (
        <div>
          <div className="flex items-center gap-2"><span className="font-medium">Trace</span><TraceBadge completeness={result.trace.completeness} /></div>
          {result.trace.events.length ? (
            <ol className="mt-2 space-y-1">
              {result.trace.events.map((event, index) => (
                <li key={index} className="rounded-control bg-subtle px-2 py-1 text-meta">
                  {event.kind.replaceAll('_', ' ')}{event.name ? ` · ${event.name}` : ''}{event.status ? ` · ${event.status}` : ''}{event.durationMs !== undefined ? ` · ${event.durationMs} ms` : ''}
                </li>
              ))}
            </ol>
          ) : <p className="mt-1 text-meta text-ink-2">No trace events recorded.</p>}
          <p className="mt-2 text-meta text-ink-2">Traces hold metadata only — no headers, bodies, tool arguments or credentials. An incomplete trace can’t prove a missing tool call.</p>
        </div>
      ) : null}
    </div>
  );
}

export function InspectorPanel({ item, view, onClose }: { item: PinnedItem; view: CaseView; onClose: () => void }) {
  return (
    <aside aria-label="Evidence inspector" className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-panel border border-rule bg-surface shadow-float">
      <div className="flex items-center justify-between border-b border-rule pl-4">
        <p className="font-medium">Pinned evidence</p>
        <AriaButton onPress={onClose} aria-label="Close inspector" className="inline-flex size-11 items-center justify-center rounded-control text-ink-2 hover:bg-subtle hover:text-ink"><X aria-hidden className="size-5" strokeWidth={1.75} /></AriaButton>
      </div>
      <div className="p-4"><InspectorContent item={item} view={view} /></div>
    </aside>
  );
}
