'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { useApi } from '@/lib/api/context';
import type { UiError } from '@/lib/api/result';
import type { Session } from '@/lib/api/types';
import { routes } from '@/lib/routes';

type SessionState =
  | { status: 'checking' }
  | { status: 'signed_in'; session: Session; signOut: () => Promise<void> }
  | { status: 'unknown'; error: UiError; retry: () => void };
const SessionContext = createContext<SessionState>({ status: 'checking' });
export const useSession = () => useContext(SessionContext);

/** Unknown/checking/expired auth never mounts private children. Owner changes remount all
 * session-local resources and mutation receipts; same-owner expiry drafts remain on disk. */
export function SessionGate({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname() ?? routes.projects;
  const [state, setState] = useState<SessionState>({ status: 'checking' });
  const [signOutError, setSignOutError] = useState<UiError | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const signingOut = useRef(false);
  const checkRef = useRef<() => void>(() => undefined);
  async function signOut() {
    signingOut.current = true;
    generation.current++;
    setState({ status: 'checking' });
    setSignOutError(null);
    const result = await api.auth.signOut();
    if (result.ok) router.replace(routes.signIn(undefined, 'signed_out'));
    else setSignOutError(result.error);
  }
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async (keepDisplay = false) => {
      const current = ++generation.current;
      if (!keepDisplay) setState({ status: 'checking' });
      const result = await api.auth.getSession();
      if (!active || current !== generation.current || signingOut.current) return;
      if (result.ok && result.data) setState({ status: 'signed_in', session: result.data, signOut });
      else if (result.ok || result.error.kind === 'unauthorized') {
        setState({ status: 'checking' });
        router.replace(routes.signIn(pathname, !result.ok ? 'expired' : undefined));
      } else setState({ status: 'unknown', error: result.error, retry: () => setRetry(value => value + 1) });
    };
    checkRef.current = () => { void check(); };
    const unsubscribe = api.auth.subscribe?.(event => {
      if (signingOut.current) return;
      if (event === 'expired') {
        generation.current++; setState({ status: 'checking' });
        router.replace(routes.signIn(pathname, 'expired'));
      } else {
        // A refresh carries no trusted identity. Validate outside Supabase's auth lock.
        generation.current++; setState({ status: 'checking' });
        clearTimeout(timer);
        timer = setTimeout(() => { void check(); }, 0);
      }
    });
    void check();
    return () => { active = false; clearTimeout(timer); unsubscribe?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signOut reads the same api/router; session checks are lifetime-scoped.
  }, [api, router, pathname, retry]);
  if (signOutError) return <div className="p-8"><p role="alert">{signOutError.message ?? 'Sign-out could not be confirmed. Private data is hidden.'}</p><Button className="mt-4" onPress={() => void signOut()}>Retry sign-out</Button></div>;
  if (state.status === 'unknown') return <div className="p-8"><p role="alert">{state.error.message ?? 'Your session could not be checked. No private data is shown.'}</p><div className="mt-4 flex gap-2"><Button onPress={() => checkRef.current()}>Check again</Button><ButtonLink variant="secondary" href={routes.signIn(pathname)}>Sign in</ButtonLink></div></div>;
  if (state.status === 'checking') return <p role="status" className="p-8 text-ink-2">Checking your session…</p>;
  return <SessionContext.Provider key={state.session.userId} value={state}>{children}</SessionContext.Provider>;
}
