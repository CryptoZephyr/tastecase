import {
  ApiErrorSchema, ClaimAttemptRequestSchema, ClaimAttemptResponseSchema, IdSchema,
  RunnerHandshakeRequestSchema, RunnerHandshakeResponseSchema, SCHEMA_VERSION,
  TargetResultSchema, UploadTargetResultRequestSchema, UploadTargetResultResponseSchema, checksum,
  type ClaimAttemptResponse, type RunnerHandshakeResponse, type TargetAdapter,
  type TargetResult, type UploadTargetResultResponse,
} from '@tastecase/contracts';
import { RunnerError, readText, redactJson, validateEndpoint, validateTimeout, withDeadline, type Fetch, type RunnerErrorCode } from './safety.js';

export type Environment = Readonly<Record<string, string | undefined>>;
export interface RunnerClientOptions {
  /** TASTECASE_RUNNER_TOKEN is read from this environment, never from a URL or request body. */
  env?: Environment;
  apiOrigin?: string;
  allowLoopbackHttp?: boolean;
  fetch?: Fetch;
  requestTimeoutMs?: number;
}

const errorCodes: Record<string, RunnerErrorCode> = {
  credential_revoked: 'credential_revoked', unauthorized: 'unauthorized', forbidden: 'forbidden',
  not_found: 'not_found', conflict: 'conflict', lease_expired: 'lease_expired', invalid_request: 'invalid_request',
  internal_error: 'server_unavailable',
};

/** Project-scoped runner API only. No owner endpoints, target configuration or automatic retries. */
export class RunnerClient {
  #origin: string;
  #token: string;
  #secrets: readonly string[];
  #fetch: Fetch;
  #timeout: number;
  #handshake: RunnerHandshakeResponse | undefined;

  constructor(options: RunnerClientOptions = {}) {
    const env = options.env ?? process.env;
    this.#origin = validateEndpoint(options.apiOrigin ?? env.TASTECASE_API_ORIGIN ?? '', {
      allowLoopbackHttp: options.allowLoopbackHttp, originOnly: true,
      secrets: [env.TASTECASE_RUNNER_TOKEN ?? '', env.LITELLM_API_KEY ?? ''],
    }).origin;
    const token = env.TASTECASE_RUNNER_TOKEN;
    if (!token || !/^tc_runner_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new RunnerError('configuration_error', 'TASTECASE_RUNNER_TOKEN must contain a minted runner credential.');
    }
    this.#token = token;
    this.#secrets = [token, ...(env.LITELLM_API_KEY ? [env.LITELLM_API_KEY] : [])];
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = validateTimeout(options.requestTimeoutMs ?? 15_000, 120_000);
  }

  async handshake(adapter: Pick<TargetAdapter, 'name' | 'version'>, signal?: AbortSignal): Promise<RunnerHandshakeResponse> {
    this.#handshake = undefined;
    const metadata = { name: adapter.name, version: adapter.version };
    if (JSON.stringify(metadata) !== JSON.stringify(redactJson(metadata, this.#secrets))) {
      throw new RunnerError('invalid_request', 'Adapter metadata must not contain credentials.');
    }
    const parsed = RunnerHandshakeRequestSchema.safeParse({
      schema_version: SCHEMA_VERSION, runner: { name: 'tastecase-local', version: '0.1.0' },
      adapter: metadata, supportedSchemaVersions: [SCHEMA_VERSION],
    });
    if (!parsed.success) throw new RunnerError('invalid_request', 'Adapter handshake metadata is invalid.');
    const response = RunnerHandshakeResponseSchema.safeParse(await this.#post('/runner/handshake', JSON.stringify(parsed.data), signal));
    if (!response.success) throw new RunnerError('invalid_response', 'API handshake does not match the supported schema.');
    this.#handshake = response.data;
    return { ...response.data };
  }

  /** null is precisely HTTP 204, not an empty/malformed JSON response. */
  async claim(signal?: AbortSignal): Promise<ClaimAttemptResponse | null> {
    if (!this.#handshake) throw new RunnerError('configuration_error', 'Handshake is required before claiming work.');
    const value = await this.#post('/runner/claims', JSON.stringify(ClaimAttemptRequestSchema.parse({ schema_version: SCHEMA_VERSION })), signal, true);
    if (value === null) return null;
    const parsed = ClaimAttemptResponseSchema.safeParse(value);
    if (!parsed.success) throw new RunnerError('invalid_response', 'API claim does not contain a valid pinned input and lease.');
    if (parsed.data.input.projectId !== this.#handshake.projectId) {
      throw new RunnerError('project_mismatch', 'Claim belongs to a different project than the authenticated handshake.');
    }
    return parsed.data;
  }

  /** Repeat manually with the SAME claim/result after an ambiguous network failure; never rerun the target. */
  async uploadResult(claim: ClaimAttemptResponse, result: TargetResult, signal?: AbortSignal): Promise<UploadTargetResultResponse> {
    const parsedClaim = ClaimAttemptResponseSchema.safeParse(claim);
    if (!parsedClaim.success || !this.#handshake || parsedClaim.data.input.projectId !== this.#handshake.projectId) {
      throw new RunnerError('invalid_request', 'Upload requires a valid claim from this authenticated project.');
    }
    const payload = UploadTargetResultRequestSchema.safeParse({ schema_version: SCHEMA_VERSION, leaseId: parsedClaim.data.leaseId, result: this.validateResult(result) });
    if (!payload.success) throw new RunnerError('invalid_request', 'Upload result does not match the supported schema.');
    const attemptId = IdSchema.parse(parsedClaim.data.attemptId);
    const response = UploadTargetResultResponseSchema.safeParse(await this.#post(`/runner/attempts/${attemptId}/results`, JSON.stringify(payload.data), signal));
    if (!response.success || response.data.attemptId !== attemptId || response.data.resultChecksum !== checksum(payload.data.result)) {
      throw new RunnerError('invalid_response', 'Upload acknowledgement does not match the attempt and result checksum.');
    }
    return response.data;
  }

  /** Validate and redact before upload or returning runtime data to local callers. */
  validateResult(value: unknown): TargetResult {
    const parsed = TargetResultSchema.safeParse(value);
    if (!parsed.success) throw new RunnerError('adapter_invalid_result', 'Local adapter returned an invalid TargetResult.');
    const redacted = TargetResultSchema.safeParse(redactJson(parsed.data, this.#secrets));
    if (!redacted.success) throw new RunnerError('adapter_invalid_result', 'Local adapter result could not be safely normalised.');
    return redacted.data;
  }

  async #post(path: string, body: string, signal?: AbortSignal, allowNoWork = false): Promise<unknown> {
    return withDeadline(this.#timeout, signal, async deadline => {
      try {
        const response = await this.#fetch(`${this.#origin}${path}`, {
          method: 'POST', redirect: 'manual', signal: deadline,
          headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json', accept: 'application/json' }, body,
        });
        if (response.status >= 300 && response.status < 400 || response.redirected || response.type === 'opaqueredirect') {
          await response.body?.cancel();
          throw new RunnerError('redirect_rejected', 'API redirects are not permitted for authenticated runner requests.');
        }
        if (response.status === 204 && allowNoWork) return null;
        if (response.status !== 200) {
          let code: RunnerErrorCode = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status >= 500 || response.status === 429 ? 'server_unavailable' : 'invalid_response';
          // Parse only the typed code. Remote messages/validation issues are never surfaced.
          try {
            const error = ApiErrorSchema.safeParse(JSON.parse(await readText(response, 64_000, deadline)));
            if (error.success) code = errorCodes[error.data.error.code] ?? code;
          } catch { /* Untrusted response bodies are discarded. */ }
          if (code === 'credential_revoked' || code === 'unauthorized') this.#handshake = undefined;
          throw new RunnerError(code, `Runner API request failed (${code}).`);
        }
        let value: unknown;
        try { value = JSON.parse(await readText(response, 16 * 1024 * 1024, deadline)); }
        catch (error) {
          if (error instanceof RunnerError) throw error;
          throw new RunnerError('invalid_response', 'API response is not valid JSON.');
        }
        // JSON null must never be confused with the HTTP 204 no-work sentinel.
        if (value === null) throw new RunnerError('invalid_response', 'API response must contain a contract object.');
        return value;
      } catch (error) {
        if (error instanceof RunnerError) throw error;
        throw new RunnerError('network_unavailable', 'Runner API is unavailable.');
      }
    });
  }
}
