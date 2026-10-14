'use client';

import { Check, RefreshCw } from 'lucide-react';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { UiError } from '@/lib/api/result';
import { routes } from '@/lib/routes';
import { Button, ButtonLink } from './button';
import { Notice } from './notice';
import type { Tone } from './badge';

interface Copy { tone: Tone; title: string; body: ReactNode }

/** Distinct, plain-language explanations per failure. Never rendered as an empty or zero state. */
export function describeError(error: UiError, what: string): Copy {
  switch (error.kind) {
    case 'not_connected':
      return { tone: 'unavailable', title: 'TasteCase isn’t connected to its service yet',
        body: <p>This deployment can’t reach the TasteCase API, so {what} can’t be shown. Nothing is displayed in its place until the service responds.</p> };
    case 'network':
      return { tone: 'unavailable', title: 'Couldn’t reach TasteCase',
        body: <p>Check your connection and try again. If you had just submitted something, it may have been saved — reload before sending it again.</p> };
    case 'unauthorized':
      return { tone: 'info', title: 'Your session has ended', body: <p>Sign in again to continue. You’ll come back to this page.</p> };
    case 'forbidden':
      return { tone: 'failed', title: 'You don’t have access to this', body: <p>This account can’t open {what}.</p> };
    case 'not_found':
      return { tone: 'unavailable', title: `We couldn’t find ${what}`,
        body: <p>It doesn’t exist, or it belongs to another account. TasteCase doesn’t reveal which.</p> };
    case 'busy':
      return { tone: 'unavailable', title: 'TasteCase is busy right now',
        body: <p>Try again in a moment. Retrying sends the same request, so nothing is duplicated.</p> };
    case 'too_large':
      return { tone: 'failed', title: 'That request is too large', body: <p>{error.message ?? 'Reduce its size and try again.'}</p> };
    case 'invalid_request':
      return { tone: 'failed', title: 'The request wasn’t accepted', body: <p>{error.message ?? 'Check the highlighted fields and try again.'}</p> };
    case 'conflict':
      return { tone: 'advisory', title: 'This changed since you loaded it', body: <p>{error.message ?? 'Reload to see the latest saved version.'}</p> };
    case 'credential_revoked':
      return { tone: 'failed', title: 'That runner credential was revoked', body: <p>Create a new credential for the runner.</p> };
    case 'lease_expired':
      return { tone: 'advisory', title: 'The runner’s lease expired', body: <p>The work can be claimed again under a new lease.</p> };
    default:
      return { tone: 'failed', title: 'Something went wrong on our side', body: <p>The request couldn’t be completed. Try again shortly.</p> };
  }
}

export function ErrorState({ error, what, onRetry, retrying, className }: {
  error: UiError; what: string; onRetry?: () => void; retrying?: boolean; className?: string;
}) {
  const pathname = usePathname() ?? routes.projects;
  const copy = describeError(error, what);
  const retryable = error.kind !== 'not_found' && error.kind !== 'forbidden' && error.kind !== 'unauthorized';
  return (
    <Notice tone={copy.tone} title={copy.title} role="alert" className={className} actions={<>
      {error.kind === 'unauthorized' ? <ButtonLink href={routes.signIn(pathname, 'expired')}>Sign in again</ButtonLink> : null}
      {retryable && onRetry ? <Button variant="secondary" onPress={onRetry} isPending={retrying} pendingLabel="Retrying" icon={<RefreshCw aria-hidden className="size-4" strokeWidth={1.75} />}>Try again</Button> : null}
      {error.kind === 'not_found' || error.kind === 'forbidden' ? <ButtonLink variant="secondary" href={routes.projects}>Go to your projects</ButtonLink> : null}
      {error.kind === 'not_connected' ? <ButtonLink variant="text" href="/docs/help/troubleshooting#not-connected">What this means</ButtonLink> : null}
    </>}>{copy.body}</Notice>
  );
}

/** Explains what has not been created yet and offers one specific first action. */
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-panel border border-dashed border-stroke/70 bg-surface px-6 py-8">
      <h3 className="text-section font-medium">{title}</h3>
      <div className="mt-2 max-w-[62ch] text-ink-2">{children}</div>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * Persistent proof of a backend-confirmed save. Shown only after the API returns the record.
 * Deliberately neutral: a saved record is not a passed evaluation, so it never uses the Passed token.
 */
export function Receipt({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-panel border border-action bg-surface p-5 text-ink" role="status">
      <h3 className="flex items-center gap-2 font-medium"><Check aria-hidden className="size-5 text-ink" strokeWidth={2} />{title}</h3>
      <div className="mt-3">{children}</div>
      {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
    </section>
  );
}

export function LastUpdated({ at, polling, reloading, onRefresh }: { at?: Date; polling?: boolean; reloading?: boolean; onRefresh: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-meta text-ink-2">
      <span aria-live="polite">
        {reloading ? 'Refreshing…' : at ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(at)}` : 'Not loaded yet'}
        {polling ? ' · checks every 5 seconds while this tab is open' : ''}
      </span>
      <Button variant="text" onPress={onRefresh} isDisabled={reloading} className="min-h-0 py-1 text-meta">Refresh</Button>
    </div>
  );
}
