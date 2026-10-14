'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { UiError } from '@/lib/api/result';
import { routes, safeNext } from '@/lib/routes';

/** Completes an emailed auth link. Invalid or expired links go to sign-in with an explanation. */
export function AuthCallbackScreen({ next, hasError }: { next?: string; hasError: boolean }) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<UiError | null>(null);
  useEffect(() => {
    if (hasError) { router.replace(routes.signIn(safeNext(next), 'invalid_link')); return; }
    let active = true;
    void api.auth.completeAuthLink(window.location.href).then(result => {
      if (!active) return;
      if (result.ok) router.replace(safeNext(next));
      else if (result.error.kind === 'unauthorized' || result.error.kind === 'invalid_request') router.replace(routes.signIn(safeNext(next), 'invalid_link'));
      else setError(result.error);
    });
    return () => { active = false; };
  }, [api, hasError, next, router]);
  return (
    <main id="main" className="mx-auto max-w-[640px] px-4 py-16">
      {error ? <ErrorState error={error} what="your sign-in link" onRetry={() => window.location.reload()} /> : <p role="status" className="text-ink-2">Checking your sign-in link…</p>}
    </main>
  );
}
