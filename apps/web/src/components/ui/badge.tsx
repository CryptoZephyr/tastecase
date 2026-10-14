import { Ban, CircleCheck, CircleDashed, CircleDot, CircleX, Clock, Eye, Info, Minus, Shuffle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type Tone = 'neutral' | 'passed' | 'advisory' | 'failed' | 'unavailable' | 'info';

const tones: Record<Tone, string> = {
  neutral: 'border border-stroke/60 bg-surface text-ink',
  passed: 'bg-passed-bg text-passed',
  advisory: 'bg-advisory-bg text-advisory',
  failed: 'bg-failed-bg text-failed',
  unavailable: 'bg-unavailable-bg text-unavailable',
  info: 'bg-info-bg text-info',
};

/** Compact label. Always text plus, where useful, an icon; never color alone. */
export function Badge({ tone = 'neutral', icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-meta font-medium whitespace-nowrap', tones[tone], className)}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

const icon = (Icon: typeof Info) => <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />;

export type ExpectationClass = 'objective_contract' | 'approved_policy' | 'advisory' | 'unavailable';

/** What kind of check this is. Class is never an outcome. */
export function ClassBadge({ classification }: { classification: ExpectationClass }) {
  switch (classification) {
    case 'objective_contract': return <Badge icon={icon(CircleDot)}>Objective check</Badge>;
    case 'approved_policy': return <Badge icon={icon(CircleDot)}>Approved policy</Badge>;
    case 'advisory': return <Badge tone="advisory" icon={icon(Eye)}>Advisory · Needs human review</Badge>;
    case 'unavailable': return <Badge tone="unavailable" icon={icon(CircleDashed)}>Unavailable</Badge>;
  }
}

export type Outcome = 'pass' | 'fail' | 'unavailable' | 'not_applicable' | 'advisory' | 'mixed' | 'pending';

/**
 * What happened. `pass` renders the Passed token and must only be used for an executed objective
 * check or an explicitly approved policy check; advisory and unavailable results never pass.
 */
export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  switch (outcome) {
    case 'pass': return <Badge tone="passed" icon={icon(CircleCheck)}>Passed</Badge>;
    case 'fail': return <Badge tone="failed" icon={icon(CircleX)}>Failed</Badge>;
    case 'unavailable': return <Badge tone="unavailable" icon={icon(CircleDashed)}>Unavailable</Badge>;
    case 'not_applicable': return <Badge icon={icon(Minus)}>Not applicable</Badge>;
    case 'advisory': return <Badge tone="advisory" icon={icon(Eye)}>Needs human review</Badge>;
    case 'mixed': return <Badge icon={icon(Shuffle)}>Mixed across repeats</Badge>;
    case 'pending': return <Badge tone="unavailable" icon={icon(Clock)}>Not run yet</Badge>;
  }
}

export function TraceBadge({ completeness }: { completeness: 'complete' | 'partial' | 'unavailable' | null }) {
  if (completeness === 'complete') return <Badge icon={icon(CircleCheck)}>Trace complete</Badge>;
  if (completeness === 'partial') return <Badge tone="unavailable" icon={icon(CircleDashed)}>Trace partial</Badge>;
  if (completeness === 'unavailable') return <Badge tone="unavailable" icon={icon(Ban)}>Trace unavailable</Badge>;
  return <Badge tone="unavailable" icon={icon(Clock)}>No result yet</Badge>;
}

export function ToneIcon({ tone }: { tone: Tone }) {
  const Icon = tone === 'failed' ? CircleX : tone === 'advisory' ? Eye : tone === 'passed' ? CircleCheck : tone === 'unavailable' ? CircleDashed : Info;
  return <Icon aria-hidden className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} />;
}
