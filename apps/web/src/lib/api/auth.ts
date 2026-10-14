import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { HttpAuth } from './http';
import type { Session } from './types';
import { fail, ok, type ApiResult } from './result';
import { safeNext } from '@/lib/routes';
const CALLBACK_PATH = '/auth/callback';

export function publicAuthConfig(urlValue: string | undefined, key: string | undefined): { url: string; key: string } | null {
  if (!urlValue || !key) return null;
  try {
    const url = new URL(urlValue);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
    if (key.startsWith('sb_publishable_')) return { url: url.origin, key };
    // Configuration screening only, NOT identity or signature verification. Never accept service_role.
    const parts = key.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replaceAll('-', '+').replaceAll('_', '/')));
    return payload.role === 'anon' ? { url: url.origin, key } : null;
  } catch { return null; }
}
export function callbackCode(value: string, origin: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.pathname !== CALLBACK_PATH || url.hash || url.searchParams.has('error') || url.searchParams.has('error_code') || url.searchParams.has('error_description') || url.searchParams.getAll('code').length !== 1) return null;
    const code = url.searchParams.get('code')!;
    return /^[A-Za-z0-9_-]{8,512}$/.test(code) ? code : null;
  } catch { return null; }
}
export function clearOwnerDrafts(owner: string): void {
  if (typeof window === 'undefined') return;
  try {
    const prefix = `tastecase:review-draft:${owner}:`;
    for (const storage of [sessionStorage, localStorage]) {
      for (let i = storage.length - 1; i >= 0; i--) { const key = storage.key(i); if (key?.startsWith(prefix)) storage.removeItem(key); }
    }
  } catch { /* Unavailable local storage cannot become an authentication failure. */ }
}

/** SDK events are invalidation signals, never authenticated identity. Only getUser(token) sets it. */
export function createAuthDriver(factory: () => SupabaseClient | null, browserOrigin: () => string = () => window.location.origin): HttpAuth {
  let client: SupabaseClient | null = null;
  let revision = 0;
  let owner: string | null = null;
  let blocked = false;
  let verifying: Promise<ApiResult<{ session: Session | null; token: string | null }>> | null = null;
  let verificationRevision = -1;
  const callbacks = new Map<string, Promise<ApiResult<Session>>>();
  const listeners = new Set<(event: 'changed' | 'refresh' | 'expired') => void>();
  const emit = (event: 'changed' | 'refresh' | 'expired') => { for (const listener of listeners) listener(event); };
  const invalidate = () => { revision++; blocked = true; emit('expired'); };
  function sdk() {
    if (!client) {
      client = factory();
      client?.auth.onAuthStateChange(event => {
        // Do not call another auth method inside the SDK lock/callback.
        if (event === 'INITIAL_SESSION') return;
        if (event === 'TOKEN_REFRESHED') { revision++; emit('refresh'); return; }
        revision++; blocked = event === 'SIGNED_OUT';
        emit(event === 'SIGNED_OUT' ? 'expired' : 'changed');
      });
    }
    return client;
  }
  async function verify(): Promise<ApiResult<{ session: Session | null; token: string | null }>> {
    const auth = sdk()?.auth;
    if (!auth) return fail({ kind: 'not_connected', message: 'Public Supabase authentication configuration is missing or invalid.' });
    const initialRevision = revision;
    try {
      const stored = await auth.getSession();
      if (stored.error) return fail({ kind: 'network', message: 'Your session could not be checked. Try again.' });
      if (!stored.data.session) return ok({ session: null, token: null });
      const token = stored.data.session.access_token;
      const verified = await auth.getUser(token);
      if (initialRevision !== revision) return fail({ kind: 'unauthorized' });
      if (verified.error || !verified.data.user || verified.data.user.is_anonymous) {
        const network = verified.error && (!verified.error.status || verified.error.status >= 500);
        if (!network) invalidate();
        return fail({ kind: network ? 'network' : 'unauthorized', message: 'Your session could not be verified. Sign in again or retry.' });
      }
      const user = verified.data.user;
      if (owner && owner !== user.id) { clearOwnerDrafts(owner); revision++; emit('changed'); }
      // A tab reload still rejects drafts when a different verified owner signs in.
      if (typeof window !== 'undefined') { try { const previous = sessionStorage.getItem('tastecase:last-owner'); if (previous && previous !== user.id) clearOwnerDrafts(previous); sessionStorage.setItem('tastecase:last-owner', user.id); } catch { /* storage unavailable */ } }
      owner = user.id;
      return ok({ token, session: { userId: user.id, email: user.email ?? null, expiresAt: stored.data.session.expires_at ? new Date(stored.data.session.expires_at * 1000).toISOString() : null } });
    } catch { return fail({ kind: 'network', message: 'Authentication could not be reached. Try again.' }); }
  }
  function verified() {
    if (!verifying || verificationRevision !== revision) {
      verificationRevision = revision;
      const promise = verify();
      verifying = promise;
      void promise.finally(() => { if (verifying === promise) verifying = null; });
    }
    return verifying;
  }
  async function session(): Promise<ApiResult<Session | null>> {
    const result = await verified();
    if (!result.ok) return result;
    blocked = false;
    return ok(result.data.session);
  }
  async function requiredSession(): Promise<ApiResult<Session>> {
    const result = await session();
    return result.ok ? result.data ? ok(result.data) : fail({ kind: 'unauthorized' }) : result;
  }
  const unavailable = () => fail({ kind: 'not_connected' });
  const failure = (message: string) => fail({ kind: 'invalid_request', message });
  return {
    epoch: () => revision, invalidate,
    async authorization() {
      if (blocked) return fail({ kind: 'unauthorized' });
      const result = await verified();
      if (!result.ok) return result;
      return result.data.session && result.data.token ? ok({ token: result.data.token, ownerId: result.data.session.userId }) : fail({ kind: 'unauthorized' });
    },
    auth: {
      getSession: session,
      subscribe(listener) { listeners.add(listener); sdk(); return () => { listeners.delete(listener); }; },
      async signInWithPassword(email, password) {
        const auth = sdk()?.auth; if (!auth) return unavailable();
        try { const result = await auth.signInWithPassword({ email, password }); if (result.error) return failure('Sign-in failed. Check your email and password and confirm your email first.'); return await requiredSession(); }
        catch { return fail({ kind: 'network' }); }
      },
      async signOut() {
        invalidate();
        const auth = sdk()?.auth; if (!auth) return unavailable();
        try { const result = await auth.signOut({ scope: 'local' }); if (result.error) return fail({ kind: 'network', message: 'Sign-out could not be confirmed. Private data is hidden; retry sign-out.' }); if (owner) clearOwnerDrafts(owner); owner = null; callbacks.clear(); return ok(null); }
        catch { return fail({ kind: 'network', message: 'Sign-out could not be confirmed. Retry sign-out.' }); }
      },
      completeAuthLink(url) {
        const code = callbackCode(url, browserOrigin());
        if (!code) return Promise.resolve(failure('This link is invalid or expired. Request a new link in the same browser.'));
        // React StrictMode/route retry must not redeem a one-time code twice.
        const pending = callbacks.get(code); if (pending) return pending;
        const result = (async () => {
          const auth = sdk()?.auth; if (!auth) return unavailable();
          try { const exchanged = await auth.exchangeCodeForSession(code); if (exchanged.error) return failure('This link could not be completed. Request a new link in the same browser.'); return await requiredSession(); }
          catch { return fail({ kind: 'network', message: 'The link outcome is unknown. Check your session or request a new link.' }); }
        })();
        if (callbacks.size >= 8) callbacks.delete(callbacks.keys().next().value!);
        callbacks.set(code, result); return result;
      },
      async signUp(email, password, next) {
        const auth = sdk()?.auth; if (!auth) return unavailable();
        try { const result = await auth.signUp({ email, password, options: { emailRedirectTo: `${browserOrigin()}${CALLBACK_PATH}?next=${encodeURIComponent(safeNext(next))}` } }); if (result.error) return failure('Account access could not be created. Check the fields or use sign-in/password recovery.'); return result.data.session ? session() : ok(null); }
        catch { return fail({ kind: 'network' }); }
      },
      async requestPasswordReset(email, next) {
        const auth = sdk()?.auth; if (!auth) return unavailable();
        try { const result = await auth.resetPasswordForEmail(email, { redirectTo: `${browserOrigin()}${CALLBACK_PATH}?next=${encodeURIComponent(safeNext(next))}` }); return result.error ? failure('The recovery request could not be sent. Try again.') : ok(null); }
        catch { return fail({ kind: 'network' }); }
      },
      async updatePassword(password) {
        const auth = sdk()?.auth; if (!auth) return unavailable();
        const current = await requiredSession(); if (!current.ok) return current;
        try { const result = await auth.updateUser({ password }); if (result.error) return failure('The password could not be updated. Use a valid new password or request another recovery link.'); return await requiredSession(); }
        catch { return fail({ kind: 'network' }); }
      },
    },
  };
}
let browserClient: SupabaseClient | null = null;
export const browserAuth = createAuthDriver(() => {
  if (typeof window === 'undefined') return null;
  const config = publicAuthConfig(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!config) return null;
  browserClient ??= createClient(config.url, config.key, { auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) } });
  return browserClient;
});
