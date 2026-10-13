import {
  SCHEMA_VERSION, type ClaimAttemptResponse, type TargetAdapter, type TargetResult, type UploadTargetResultResponse,
} from '@tastecase/contracts';
import { RunnerClient } from './client.js';
import { RunnerError, validateTimeout, withDeadline, type RunnerErrorCode } from './safety.js';

/** Implement this shared Adapter locally. Select it in trusted runner code, never from a server URL/source payload.
 * run receives schema-validated synthetic pinned input and a deadline AbortSignal.
 * Return a validated TargetResult; preserve outside-catalog recommendations and invalid output.
 * Mark trace partial/unavailable unless full target/tool execution is actually observable.
 * Never include provider secrets, account IDs, headers or raw request/response envelopes in trace.
 * No blind provider retries: a single run may have already incurred cost or side effects.
 */
export type { TargetAdapter as Adapter } from '@tastecase/contracts';

export interface RunOnceOptions {
  signal?: AbortSignal;
  targetTimeoutMs?: number;
  /** Leave time to upload before lease expiry; no lease extension or background daemon. */
  uploadReserveMs?: number;
  now?: () => number;
}
export interface PendingUpload { claim: ClaimAttemptResponse; result: TargetResult }
export type RunOnceOutcome =
  | { status: 'no_work' }
  | { status: 'completed'; attemptId: string; leaseId: string; result: TargetResult; acknowledgement: UploadTargetResultResponse }
  | { status: 'credential_revoked' | 'unauthorized' | 'lease_expired'; stage: 'handshake' | 'claim' | 'target' | 'upload' }
  | { status: 'unavailable' | 'failed'; stage: 'handshake' | 'claim' | 'target' | 'upload'; code: RunnerErrorCode; pendingUpload?: PendingUpload };

/** Handshake, claim at most one attempt, execute once locally and upload exactly one result. */
export async function runOnce(client: RunnerClient, adapter: TargetAdapter, options: RunOnceOptions = {}): Promise<RunOnceOutcome> {
  const timeout = validateTimeout(options.targetTimeoutMs ?? 60_000);
  const reserve = validateTimeout(options.uploadReserveMs ?? 5_000, 120_000);
  const now = options.now ?? Date.now;
  let stage: 'handshake' | 'claim' | 'target' | 'upload' = 'handshake';
  let pendingUpload: PendingUpload | undefined;
  try {
    await client.handshake(adapter, options.signal);
    stage = 'claim';
    const claim = await client.claim(options.signal);
    if (!claim) return { status: 'no_work' };
    stage = 'target';
    const remaining = Date.parse(claim.leaseExpiresAt) - now() - reserve;
    if (remaining < 1) return { status: 'lease_expired', stage };
    let result: TargetResult;
    try {
      const value = await withDeadline(Math.min(timeout, Math.floor(remaining)), options.signal, signal => adapter.run(claim.input, { signal }));
      result = client.validateResult(value);
    } catch (error) {
      if (options.signal?.aborted || error instanceof RunnerError && (error.code === 'adapter_invalid_result' || error.code === 'aborted')) throw error;
      result = client.validateResult({
        schema_version: SCHEMA_VERSION, outcome: 'provider_unavailable',
        error: { code: error instanceof RunnerError && error.code === 'timeout' ? 'target_timeout' : 'adapter_exception', message: 'Local target execution did not produce an available response.' },
        retryable: false, trace: { completeness: 'unavailable', events: [] },
      });
    }
    stage = 'upload';
    if (options.signal?.aborted) throw new RunnerError('aborted', 'Operation was cancelled.');
    if (Date.parse(claim.leaseExpiresAt) <= now()) return { status: 'lease_expired', stage };
    pendingUpload = { claim, result };
    const acknowledgement = await client.uploadResult(claim, result, options.signal);
    return { status: 'completed', attemptId: claim.attemptId, leaseId: claim.leaseId, result, acknowledgement };
  } catch (error) {
    const code = error instanceof RunnerError ? error.code : 'invalid_response';
    if (code === 'credential_revoked' || code === 'unauthorized' || code === 'lease_expired') return { status: code, stage };
    const unavailable = ['network_unavailable', 'server_unavailable', 'timeout'].includes(code);
    return { status: unavailable ? 'unavailable' : 'failed', stage, code, ...(pendingUpload ? { pendingUpload } : {}) };
  }
}
