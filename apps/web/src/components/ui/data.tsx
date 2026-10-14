'use client';

import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { cn } from '@/lib/cn';
import { formatDateTime, shortHash } from '@/lib/format';

export function Time({ iso, className }: { iso: string; className?: string }) {
  return <time dateTime={iso} className={className}>{formatDateTime(iso)}</time>;
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <AriaButton
      aria-label={copied === 'copied' ? `${label}: copied` : label}
      onPress={async () => {
        try { await navigator.clipboard.writeText(value); setCopied('copied'); } catch { setCopied('failed'); }
        window.setTimeout(() => setCopied('idle'), 2000);
      }}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-subtle hover:text-ink"
    >
      {copied === 'copied' ? <Check aria-hidden className="size-4" strokeWidth={1.75} /> : <Copy aria-hidden className="size-4" strokeWidth={1.75} />}
      <span className="sr-only" aria-live="polite">{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed; select the text instead' : ''}</span>
    </AriaButton>
  );
}

/** Truncated hash/ID with the full value available to read (title) and copy. */
export function Hash({ value, label = 'value', length = 12, className }: { value: string; label?: string; length?: number; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center', className)}>
      <code title={value} className="truncate font-mono text-meta text-ink">{shortHash(value, length)}</code>
      <CopyButton value={value} label={`Copy full ${label}`} />
    </span>
  );
}

/** Definition list for receipts, metadata strips and evidence details. */
export function Facts({ items, className, columns = 2 }: { items: [ReactNode, ReactNode][]; className?: string; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3', className)}>
      {items.map(([term, detail], index) => (
        <div key={index} className="min-w-0">
          <dt className="text-meta text-ink-2">{term}</dt>
          <dd className="mt-0.5 min-w-0 text-control break-words">{detail}</dd>
        </div>
      ))}
    </dl>
  );
}
