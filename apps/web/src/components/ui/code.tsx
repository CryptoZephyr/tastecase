import { cn } from '@/lib/cn';
import { CopyButton } from './data';

/** Readable command/code block. Content wraps instead of forcing horizontal page scroll. */
export function CodeBlock({ code, label, className }: { code: string; label: string; className?: string }) {
  return (
    <div className={cn('relative rounded-control border border-rule bg-subtle', className)}>
      <div className="flex items-center justify-between border-b border-rule pl-3">
        <span className="text-meta text-ink-2">{label}</span>
        <CopyButton value={code} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-meta leading-5 text-ink whitespace-pre-wrap break-words">{code}</pre>
    </div>
  );
}
