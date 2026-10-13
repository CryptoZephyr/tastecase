import { IdSchema } from '@tastecase/contracts';
import { HttpError } from './errors.js';

export type OwnerVerifier = (token: string) => Promise<string | null>;

export function bearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]{1,4096})$/i);
  if (!match) throw new HttpError(401, 'unauthorized', 'A valid bearer credential is required.');
  return match[1];
}

/** Verifies the token with Supabase Auth. Decoded JWT claims are never trusted. */
export function createSupabaseOwnerVerifier(options: {
  supabaseUrl: string; supabaseAnonKey: string; fetch?: typeof globalThis.fetch;
}): OwnerVerifier {
  const base = new URL(options.supabaseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error('SUPABASE_URL must be an HTTPS origin (or local HTTP origin).');
  }
  if (!options.supabaseAnonKey) throw new Error('SUPABASE_ANON_KEY is required.');
  const fetchUser = options.fetch ?? globalThis.fetch;
  const endpoint = new URL('/auth/v1/user', base);
  return async token => {
    try {
      const response = await fetchUser(endpoint, {
        method: 'GET', headers: { apikey: options.supabaseAnonKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 16384) {
            await reader.cancel();
            return null;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const user: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof user !== 'object' || user === null || !('id' in user)) return null;
      const id = IdSchema.safeParse(user.id);
      return id.success ? id.data : null;
    } catch {
      // Auth outages deny access without exposing upstream details or credentials.
      return null;
    }
  };
}
