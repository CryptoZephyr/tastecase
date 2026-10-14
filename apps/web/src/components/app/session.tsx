'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useApi } from '@/lib/api/context';
import type { UiError } from '@/lib/api/result';
import type { Session } from '@/lib/api/types';
import { useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';

type SessionState =
  | { status: 'checking' }
  | { status: 'signed_in'; session: Session; signOut: () => Promise<void> }
  | { status: 'unknown'; error: UiError; retry: () => void };

const SessionContext = createContext<SessionState>({ status: 'checking' });
export const useSession = () => useContext(SessionContext);

/**
 * Private routes require an owner session. No session (or an expired one) redirects to sign-in
 * with the intended destination preserved. When the auth service can't be reached the state is
 * "unknown": screens still render their own unavailable states, and no private data exists to show.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname() ?? routes.projects;
  const session = useResource(() => api.auth.getSession(), [api]);

  const signedOut = session.status === 'ready' && session.data === null;
  const expired = session.status === 'error' && session.error.kind === 'unauthorized';
  useEffect(() => {
    if (signedOut || expired) router.replace(routes.signIn(pathname, expired ? 'expired' : undefined));
  }, [signedOut, expired, pathname, router]);

  let value: SessionState = { status: 'checking' };
  if (session.status === 'ready' && session.data) {
    value = { status: 'signed_in', session: session.data, signOut: async () => {
      const result = await api.auth.signOut();
      if (result.ok) router.replace(routes.signIn(undefined, 'signed_out'));
    } };
  } else if (session.status === 'error' && !expired) {
    value = { status: 'unknown', error: session.error, retry: () => void session.reload() };
  }
  if (signedOut || expired) return <p role="status" className="p-8 text-ink-2">Taking you to sign in…</p>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
