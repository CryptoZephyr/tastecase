import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ToneIcon, type Tone } from './badge';

const tones: Record<Tone, string> = {
  neutral: 'border border-rule bg-surface text-ink',
  passed: 'bg-passed-bg text-ink',
  advisory: 'bg-advisory-bg text-ink',
  failed: 'bg-failed-bg text-ink',
  unavailable: 'bg-unavailable-bg text-ink',
  info: 'bg-info-bg text-ink',
};
const iconTones: Record<Tone, string> = {
  neutral: 'text-ink-2', passed: 'text-passed', advisory: 'text-advisory', failed: 'text-failed', unavailable: 'text-unavailable', info: 'text-info',
};

/** Inline, contextual message. Tinted panel with an icon and a text title — not a side stripe. */
export function Notice({ tone = 'info', title, children, actions, className, role }: {
  tone?: Tone; title: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string; role?: 'status' | 'alert';
}) {
  return (
    <div role={role} className={cn('flex gap-3 rounded-panel p-4', tones[tone], className)}>
      <span className={iconTones[tone]}><ToneIcon tone={tone} /></span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children ? <div className="mt-1 text-control text-ink [&_p+p]:mt-2">{children}</div> : null}
        {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
