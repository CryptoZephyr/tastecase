import type { ApiError } from './types';

/**
 * Every API call resolves to a result; transports never throw for expected failures.
 * Kinds map one-to-one onto the backend's safe error vocabulary plus transport conditions,
 * so screens can give distinct explanations and the smallest useful retry.
 */
export type UiErrorKind =
  | 'not_connected' // this deployment has no API transport configured
  | 'network' // the request may not have reached the API; outcome unknown
  | 'unauthorized' // missing or expired owner session
  | 'forbidden'
  | 'not_found' // unknown, or owned by another account (the API does not distinguish)
  | 'conflict' // stale revision or an immutable ID reused with different content
  | 'invalid_request'
  | 'too_large'
  | 'busy' // 503: retry with the same request ID and unchanged body
  | 'lease_expired'
  | 'credential_revoked'
  | 'internal';

export interface UiError {
  kind: UiErrorKind;
  /** Safe server message when the API supplied one. Never contains private provider bodies. */
  message?: string;
  status?: number;
  issues?: { path: (string | number)[]; message: string }[];
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: UiError };

export const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
export const fail = (error: UiError): ApiResult<never> => ({ ok: false, error });

/** A failure whose server-side effect is unknown. Retries must reuse the same ID and body. */
export function isUncertain(error: UiError): boolean {
  return error.kind === 'network' || error.kind === 'busy' || error.kind === 'internal';
}

/** Translate a backend `ApiError` body and HTTP status into a UI error. For transport authors. */
export function fromApiError(status: number, body: ApiError | null | undefined): UiError {
  const message = body?.error.message;
  const issues = body?.error.issues;
  if (status === 413) return { kind: 'too_large', status, message };
  if (status === 503) return { kind: 'busy', status, message };
  switch (body?.error.code) {
    case 'invalid_request': return { kind: 'invalid_request', status, message, issues };
    case 'unauthorized': return { kind: 'unauthorized', status, message };
    case 'forbidden': return { kind: 'forbidden', status, message };
    case 'not_found': return { kind: 'not_found', status, message };
    case 'conflict': return { kind: 'conflict', status, message };
    case 'lease_expired': return { kind: 'lease_expired', status, message };
    case 'credential_revoked': return { kind: 'credential_revoked', status, message };
    default: break;
  }
  if (status === 400 || status === 415) return { kind: 'invalid_request', status, message };
  if (status === 401) return { kind: 'unauthorized', status, message };
  if (status === 403) return { kind: 'forbidden', status, message };
  if (status === 404) return { kind: 'not_found', status, message };
  if (status === 409) return { kind: 'conflict', status, message };
  return { kind: 'internal', status, message };
}
