import type { ReactNode } from 'react';
import { Notice } from '@/components/ui/notice';
import { CodeBlock } from '@/components/ui/code';

/** Section heading whose id feeds the page contents and search index. */
export function H2({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id}>{children}</h2>;
}

type Kind = 'implemented' | 'planned' | 'synthetic' | 'recorded' | 'limitation' | 'note';
const KIND = {
  implemented: { tone: 'neutral', title: 'Implemented' },
  planned: { tone: 'info', title: 'Planned — not built yet' },
  synthetic: { tone: 'info', title: 'Synthetic example' },
  recorded: { tone: 'neutral', title: 'Recorded evidence' },
  limitation: { tone: 'unavailable', title: 'Limitation' },
  note: { tone: 'info', title: 'Note' },
} as const;

/** Distinct notices keep implemented behaviour, plans, synthetic examples and evidence apart. */
export function Callout({ kind, title, children }: { kind: Kind; title?: string; children: ReactNode }) {
  return <Notice tone={KIND[kind].tone} title={title ?? KIND[kind].title}>{children}</Notice>;
}

export function Code({ code, label }: { code: string; label: string }) {
  return <CodeBlock code={code} label={label} />;
}

export function Table({ head, rows, label }: { head: string[]; rows: ReactNode[][]; label?: string }) {
  return (
    <div tabIndex={0} role="region" aria-label={label ?? `Table: ${head.join(", ")}`} className="overflow-x-auto rounded-panel border border-rule bg-surface">
      <table className="w-full min-w-[32rem] text-left text-control">
        <thead className="bg-subtle text-meta text-ink-2"><tr>{head.map(cell => <th key={cell} scope="col" className="px-3 py-2 font-medium">{cell}</th>)}</tr></thead>
        <tbody className="divide-y divide-rule">{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top">{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
