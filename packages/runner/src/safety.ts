import { AssistantVersionSchema, assertSafePortableContent } from '@tastecase/contracts';
import type { Environment } from './client.js';

export type Fetch = typeof globalThis.fetch;

/** Conservative known-value coverage for local credentials; never a universal secret detector. */
export function localSecrets(env: Environment): string[] {
  return Object.entries(env).flatMap(([name, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL)/i.test(name) ? [value] : []);
}

export function localAssistantVersion(value: string | undefined, secrets: readonly string[] = []): string | undefined {
  if (value === undefined) return undefined;
  const parsed = AssistantVersionSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RunnerError('configuration_error', 'Local assistant release label is invalid.');
  }
  try { assertSafePortableContent(value, secrets); }
  catch { throw new RunnerError('configuration_error', 'Local assistant release label must not contain credentials.'); }
  return parsed.data;
}

export type RunnerErrorCode =
  | 'configuration_error' | 'invalid_request' | 'invalid_response' | 'project_mismatch'
  | 'network_unavailable' | 'timeout' | 'aborted' | 'redirect_rejected'
  | 'credential_revoked' | 'unauthorized' | 'forbidden' | 'not_found'
  | 'conflict' | 'lease_expired' | 'server_unavailable' | 'adapter_invalid_result';

/** Fixed messages only: never attach a provider response, URL, token or thrown cause. */
export class RunnerError extends Error {
  constructor(readonly code: RunnerErrorCode, message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

/** HTTP is opt-in and limited to literal loopback, never DNS names resolving to loopback. */
export function validateEndpoint(value: string, options: { allowLoopbackHttp?: boolean; originOnly?: boolean; secrets?: readonly string[] } = {}): URL {
  let url: URL;
  let decoded: string;
  try {
    if (value !== value.trim() || !/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new Error();
    decoded = decodeURIComponent(value);
    if (/[\u0000-\u001f\u007f]/.test(decoded)) throw new Error();
    url = new URL(value);
  } catch {
    throw new RunnerError('configuration_error', 'Endpoint must be a valid HTTP(S) URL.');
  }
  if (options.secrets?.some(secret => secret && (decoded.includes(secret) || url.hostname.includes(secret.toLowerCase())))) {
    throw new RunnerError('configuration_error', 'Endpoint must not contain local credentials.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || /[?#@]/.test(value)) {
    throw new RunnerError('configuration_error', 'Endpoint must not contain credentials, a query or a fragment.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && options.allowLoopbackHttp)) {
    throw new RunnerError('configuration_error', 'HTTPS is required; loopback HTTP requires explicit local opt-in.');
  }
  if (options.originOnly && url.pathname !== '/') {
    throw new RunnerError('configuration_error', 'API endpoint must be an origin without a path.');
  }
  return url;
}

export function validateTimeout(value: number, maximum = 600_000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RunnerError('configuration_error', `Timeout must be an integer between 1 and ${maximum} milliseconds.`);
  }
  return value;
}

/** Also bounds injected adapters/fetch implementations that ignore cancellation. */
export async function withDeadline<T>(milliseconds: number, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, validateTimeout(milliseconds));
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let rejectAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new RunnerError(timedOut ? 'timeout' : 'aborted', timedOut ? 'Operation deadline exceeded.' : 'Operation was cancelled.'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    if (controller.signal.aborted) return await cancelled;
    return await Promise.race([operation(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort();
  }
}

/** Bounded streaming read, including servers without a trustworthy Content-Length. */
export async function readText(response: Response, maximumBytes: number, signal?: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > maximumBytes) {
    await response.body?.cancel();
    throw new RunnerError('invalid_response', 'Response exceeds the local size limit.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new RunnerError('aborted', 'Response read was cancelled.');
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new RunnerError('invalid_response', 'Response exceeds the local size limit.');
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    // Cancellation releases an oversized or incomplete body without echoing it.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new RunnerError('invalid_response', 'Response is not valid UTF-8.'); }
}

/** Redact known local secrets and runner-token patterns even in malformed target text. */
export function redactText(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) {
      for (const representation of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
        redacted = redacted.split(representation).join('[REDACTED]');
      }
    }
  }
  return redacted.replace(/tc_runner_[A-Za-z0-9_-]{43}/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
}

export function redactJson(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactJson(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item, secrets)]));
  }
  return value;
}
