import { cn } from '@/lib/cn';

/**
 * Stable input-brief identity. Profile labels (lettered squares) are visually distinct from
 * release-role labels (Baseline/Candidate with an exact version), and repeat at every section.
 */
export function ProfileTag({ profile, className }: { profile: 'a' | 'b' | 'single'; className?: string }) {
  if (profile === 'single') {
    return (
      <span className={cn('inline-flex items-center gap-2 font-medium text-ink', className)}>
        <span aria-hidden className="flex size-6 items-center justify-center rounded-[4px] border border-action text-meta font-semibold text-action">1</span>
        Case brief
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-2 font-medium text-ink', className)}>
      <span aria-hidden className={cn('flex size-6 items-center justify-center rounded-[4px] text-meta font-semibold',
        profile === 'a' ? 'bg-action text-white' : 'border-2 border-action bg-surface text-action')}>{profile.toUpperCase()}</span>
      Profile {profile.toUpperCase()}
    </span>
  );
}

/** Release role with its exact assistant version. Neutral styling: the candidate is never the winner. */
export function RoleTag({ role, version, className }: { role: 'baseline' | 'candidate'; version: string; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full items-center gap-2 rounded-control border border-rule bg-subtle px-2 py-1 text-meta', className)}>
      <span className="font-medium text-ink">{role === 'baseline' ? 'Baseline' : 'Candidate'}</span>
      <code className="truncate font-mono text-ink" title={version}>{version}</code>
    </span>
  );
}
