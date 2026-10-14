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

export function SignInScreen({ next, reason, mode: initialMode }: { next?: string; reason?: string; mode?: string }) {
  const api = useApi();
  const router = useRouter();
  const destination = safeNext(next);
  const [mode, setMode] = useState<'sign-in' | 'create' | 'recover' | 'reset'>(initialMode === 'reset' ? 'reset' : 'sign-in');
  const [message, setMessage] = useState<string | null>(null);
  const title = mode === 'create' ? 'Create your account' : mode === 'recover' ? 'Recover your account' : mode === 'reset' ? 'Set a new password' : 'Sign in to TasteCase';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    if (pending) return;
    const nextErrors = { email: mode === 'reset' || /^\S+@\S+\.\S+$/.test(email.trim()) ? undefined : 'Enter the email address for your account.', password: mode === 'recover' || (password && (mode === 'sign-in' || password.length >= 8)) ? undefined : mode === 'sign-in' ? 'Enter your password.' : 'Use at least 8 characters for your password.' };
    setErrors(nextErrors);
    if (nextErrors.email || nextErrors.password) return;
    setPending(true); setError(null); setMessage(null);
    const result = mode === 'create' && api.auth.signUp ? await api.auth.signUp(email.trim(), password, destination)
      : mode === 'recover' && api.auth.requestPasswordReset ? await api.auth.requestPasswordReset(email.trim(), `/sign-in?mode=reset&next=${encodeURIComponent(destination)}`)
      : mode === 'reset' && api.auth.updatePassword ? await api.auth.updatePassword(password)
      : await api.auth.signInWithPassword(email.trim(), password);
    setPending(false);
    if (result.ok && mode === 'recover') { setMessage('If that account can receive recovery email, a link has been sent. Open it in this same browser.'); setPassword(''); }
    else if (result.ok && mode === 'create' && !result.data) { setMessage('Check your email to confirm account access. Open the link in this same browser, then sign in.'); setPassword(''); }
    else if (result.ok) router.replace(destination);
    else { setError(result.error); setPassword(''); }
  }

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-[1200px] flex-col px-4 sm:px-6">
      <header className="flex h-16 items-center"><Link href={routes.home} aria-label="TasteCase home" className="rounded-control"><Lockup /></Link></header>
      <main id="main" className="grid flex-1 items-start gap-10 py-10 md:grid-cols-2 md:py-16">
        <div className="max-w-[46ch]">
          <h1 className="text-title font-medium">{title}</h1>
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
            {mode !== 'reset' ? <Field label="Email" type="email" autoComplete="email" value={email} onChange={value => { setEmail(value); setErrors(current => ({ ...current, email: undefined })); }} errorMessage={errors.email} isRequired /> : null}
            {mode !== 'recover' ? <Field label={mode === 'reset' ? 'New password' : 'Password'} type="password" autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} value={password} onChange={value => { setPassword(value); setErrors(current => ({ ...current, password: undefined })); }} errorMessage={errors.password} isRequired /> : null}
            {error?.kind === 'unauthorized' || error?.kind === 'invalid_request' ? (
              <Notice tone="failed" title="Account access could not be completed" role="alert">{error.message ?? 'Check the fields and try again. You may need to confirm your email first.'}</Notice>
            ) : error ? <ErrorState error={error} what="sign-in" onRetry={() => void submit()} retrying={pending} /> : null}
            {message ? <Notice tone="info" title="Check your email" role="status">{message}</Notice> : null}
            <Button type="submit" isPending={pending} pendingLabel="Please wait" className="w-full">{mode === 'create' ? 'Create account' : mode === 'recover' ? 'Send recovery link' : mode === 'reset' ? 'Save new password' : 'Sign in'}</Button>
            <div className="flex flex-wrap gap-2">
              {(['sign-in', 'create', 'recover'] as const).filter(value => value !== mode && (value === 'sign-in' || (value === 'create' ? api.auth.signUp : api.auth.requestPasswordReset))).map(value => <Button key={value} variant="text" isDisabled={pending} onPress={() => { setMode(value); setError(null); setErrors({}); setMessage(null); setPassword(''); }}>{value === 'create' ? 'Create account' : value === 'recover' ? 'Forgot password?' : 'Back to sign in'}</Button>)}
            </div>
          </Form>
        </div>
      </main>
    </div>
  );
}
