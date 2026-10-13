#!/usr/bin/env node
import { type TargetAdapter } from '@tastecase/contracts';
import { RunnerClient, type Environment } from './client.js';
import { LITELLM_ADAPTER_METADATA, createLiteLLMAdapter } from './litellm.js';
import { runOnce } from './runtime.js';
import { RunnerError, validateTimeout, type Fetch } from './safety.js';

export const CLI_USAGE = `TasteCase authorised local runner (one attempt, no daemon)
Usage: tastecase-runner handshake [--allow-loopback-http] [--request-timeout-ms N]
       tastecase-runner run-once [--allow-loopback-http] [--request-timeout-ms N] [--target-timeout-ms N]

Environment (never pass keys/tokens as CLI arguments):
  TASTECASE_API_ORIGIN    HTTPS API origin, no path/query/credentials
  TASTECASE_RUNNER_TOKEN  Project-scoped minted runner bearer credential
  LITELLM_BASE_URL       Trusted local provider base URL (include /v1 if needed)
  LITELLM_API_KEY        Local provider credential; run-once only
  LITELLM_MODEL          Optional model name, defaults to nova-micro

Loopback HTTP requires --allow-loopback-http (API and provider).
handshake does not invoke the provider or require its key.
POST /runner/handshake -> 200; POST /runner/claims -> 200 lease or 204 no work;
POST /runner/attempts/:attemptId/results -> 200 matching checksum acknowledgement.
No automatic target/upload retries. Use exported uploadResult with the identical
claim/result for an ambiguous upload; never rerun the target to retry an upload.
Exit codes: 0 completed/no-work, 1 invalid/failed, 3 revoked/unauthorised,
4 API/provider unavailable, 5 lease expired. Output is metadata only.
`;

export interface CliDependencies {
  env?: Environment;
  fetch?: Fetch;
  adapter?: TargetAdapter;
  signal?: AbortSignal;
  write?: (line: string) => void;
}

/** Testable CLI entry point; output never includes target text, upstream errors or credentials. */
export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const write = dependencies.write ?? (line => console.log(line));
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { write(CLI_USAGE); return 0; }
  try {
    const command = args[0];
    if (command !== 'handshake' && command !== 'run-once') throw new RunnerError('configuration_error', 'Expected handshake or run-once; use --help.');
    let allowLoopbackHttp = false;
    let requestTimeoutMs = 15_000;
    let targetTimeoutMs = 60_000;
    const seen = new Set<string>();
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (seen.has(arg)) throw new RunnerError('configuration_error', 'Duplicate CLI option.');
      seen.add(arg);
      if (arg === '--allow-loopback-http') allowLoopbackHttp = true;
      else if (arg === '--request-timeout-ms' || arg === '--target-timeout-ms') {
        const value = args[++index];
        if (!value || !/^\d+$/.test(value) || command === 'handshake' && arg === '--target-timeout-ms') throw new RunnerError('configuration_error', 'Invalid timeout option.');
        const timeout = validateTimeout(Number(value), arg === '--request-timeout-ms' ? 120_000 : 600_000);
        if (arg === '--request-timeout-ms') requestTimeoutMs = timeout;
        else targetTimeoutMs = timeout;
      } else throw new RunnerError('configuration_error', 'Unknown CLI option; use --help.');
    }
    const client = new RunnerClient({ env: dependencies.env, fetch: dependencies.fetch, allowLoopbackHttp, requestTimeoutMs });
    if (command === 'handshake') {
      const response = await client.handshake(dependencies.adapter ?? LITELLM_ADAPTER_METADATA, dependencies.signal);
      write(JSON.stringify({ status: 'ready', ...response }));
      return 0;
    }
    const adapter = dependencies.adapter ?? createLiteLLMAdapter({ env: dependencies.env, fetch: dependencies.fetch, allowLoopbackHttp, providerTimeoutMs: targetTimeoutMs });
    const outcome = await runOnce(client, adapter, { signal: dependencies.signal, targetTimeoutMs, uploadReserveMs: requestTimeoutMs });
    if (outcome.status === 'completed') {
      write(JSON.stringify({ status: outcome.status, attemptId: outcome.attemptId, leaseId: outcome.leaseId, outcome: outcome.result.outcome, idempotent: outcome.acknowledgement.idempotent }));
      return outcome.result.outcome === 'provider_unavailable' ? 4 : 0;
    }
    // pendingUpload may contain target text; deliberately omit it from terminal output.
    write(JSON.stringify({ status: outcome.status, ...('stage' in outcome ? { stage: outcome.stage } : {}), ...('code' in outcome ? { code: outcome.code } : {}) }));
    if (outcome.status === 'no_work') return 0;
    if (outcome.status === 'credential_revoked' || outcome.status === 'unauthorized') return 3;
    if (outcome.status === 'unavailable') return 4;
    return outcome.status === 'lease_expired' ? 5 : 1;
  } catch (error) {
    const code = error instanceof RunnerError ? error.code : 'invalid_response';
    write(JSON.stringify({ status: 'failed', code }));
    if (code === 'credential_revoked' || code === 'unauthorized') return 3;
    return ['network_unavailable', 'server_unavailable', 'timeout'].includes(code) ? 4 : 1;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try { process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
