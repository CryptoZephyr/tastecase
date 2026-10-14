'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Lockup } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { UiError } from '@/lib/api/result';
import { describeDestination, routes, safeNext } from '@/lib/routes';

export function SignInScreen({ next, reason }: { next?: string; reason?: string }) {
  const api = useApi();
  const router = useRouter();
  const destination = safeNext(next);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    const nextErrors = { email: /^\S+@\S+\.\S+$/.test(email.trim()) ? undefined : 'Enter the email address for your account.', password: password ? undefined : 'Enter your password.' };
    setErrors(nextErrors);
    if (nextErrors.email || nextErrors.password) return;
    setPending(true); setError(null);
    const result = await api.auth.signInWithPassword(email.trim(), password);
    setPending(false);
    if (result.ok) router.replace(destination);
    else { setError(result.error); setPassword(''); }
  }

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-[1200px] flex-col px-4 sm:px-6">
      <header className="flex h-16 items-center"><Link href={routes.home} aria-label="TasteCase home" className="rounded-control"><Lockup /></Link></header>
      <main id="main" className="grid flex-1 items-start gap-10 py-10 md:grid-cols-2 md:py-16">
        <div className="max-w-[46ch]">
          <h1 className="text-title font-medium">Sign in to TasteCase</h1>
          <p className="mt-3 text-ink">After signing in you’ll go to {describeDestination(destination)}.</p>
          <ul className="mt-6 space-y-2 text-control text-ink-2">
            <li>Your projects, cases and suites are private to your account.</li>
            <li>The public sample doesn’t need an account: <Link href={routes.sample} className="text-action underline underline-offset-4">inspect a case</Link>.</li>
          </ul>
        </div>
        <div className="space-y-4">
          {reason === 'expired' ? <Notice tone="info" title="Your session ended">Sign in again to continue where you left off. Unsaved review drafts are kept in the tab you were using.</Notice> : null}
          {reason === 'invalid_link' ? <Notice tone="advisory" title="That sign-in link isn’t valid">It may have expired or already been used. Sign in with your email and password instead.</Notice> : null}
          {reason === 'signed_out' ? <Notice tone="info" title="You’re signed out">Sign in again whenever you’re ready.</Notice> : null}
          <Form onSubmit={event => { event.preventDefault(); void submit(); }} validationBehavior="aria" className="space-y-4 rounded-panel border border-rule bg-surface p-5 md:p-6">
            <Field label="Email" type="email" autoComplete="email" value={email} onChange={value => { setEmail(value); setErrors(current => ({ ...current, email: undefined })); }} errorMessage={errors.email} isRequired />
            <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={value => { setPassword(value); setErrors(current => ({ ...current, password: undefined })); }} errorMessage={errors.password} isRequired />
            {error?.kind === 'unauthorized' || error?.kind === 'invalid_request' ? (
              <Notice tone="failed" title="Email or password didn’t match" role="alert">Check them and try again.</Notice>
            ) : error ? <ErrorState error={error} what="sign-in" onRetry={() => void submit()} retrying={pending} /> : null}
            <Button type="submit" isPending={pending} pendingLabel="Signing in" className="w-full">Sign in</Button>
          </Form>
        </div>
      </main>
    </div>
  );
}
