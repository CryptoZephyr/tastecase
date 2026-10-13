import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import {
  AttemptSchema, COMPARISON_LIMITS, IdSchema, ReplayReportSchema, SCHEMA_VERSION, TargetResultSchema,
  assertSafePortableContent, checksum, initialComparisonAssociations, parsePortableTestPack,
  prepareComparisonFinalization, projectComparisonResult, validateComparisonRunnerBinding,
  validatePortableTestPack, validateReplayReport,
  type PortableTestPack, type ReplayReport, type TargetAdapter, type TargetResult,
} from '@tastecase/contracts';
import type { Environment } from './client.js';
import { RunnerError, localAssistantVersion, localSecrets, redactJson, validateTimeout, withDeadline } from './safety.js';

export type ReplayRole = 'baseline' | 'candidate';
export interface ReplayRoleOptions {
  pack: unknown;
  role: ReplayRole;
  /** Explicit owner-controlled local release attestation; never inferred from adapter/model names. */
  assistantVersion: string;
  adapter: TargetAdapter;
  env?: Environment;
  expectedChecksum?: string;
  signal?: AbortSignal;
  targetTimeoutMs?: number;
  /** May shorten, never expand, the original bounded run duration. Historical absolute dates are not reused. */
  replayTimeoutMs?: number;
  reportId?: string;
}

function rejectArtifactUrls(value: unknown): void {
  if (typeof value === 'string' && /[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new RunnerError('invalid_request', 'Replay artifacts must not contain URLs.');
  if (Array.isArray(value)) value.forEach(rejectArtifactUrls);
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => { rejectArtifactUrls(key); rejectArtifactUrls(child); });
}

/** Validate the entire exported API pack, not only the selected role, before any target dispatch. */
export function validateReplayPack(value: unknown, options: { env?: Environment; expectedChecksum?: string } = {}): PortableTestPack {
  try {
    const pack = validatePortableTestPack(value, { expectedChecksum: options.expectedChecksum, knownSecrets: localSecrets(options.env ?? process.env) });
    rejectArtifactUrls(pack);
    return pack;
  } catch { throw new RunnerError('invalid_request', 'Replay pack is unsafe, incompatible or does not match its pinned checksums.'); }
}

function validateBinding(pack: PortableTestPack, role: ReplayRole, assistantVersion: string, secrets: readonly string[]): void {
  if (role !== 'baseline' && role !== 'candidate') throw new RunnerError('configuration_error', 'Replay role must be baseline or candidate.');
  const release = localAssistantVersion(assistantVersion, secrets);
  const expected = role === 'baseline' ? pack.plan.request.baselineVersion : pack.plan.request.candidateVersion;
  if (!release || release !== expected) throw new RunnerError('configuration_error', 'Replay requires the exact explicit release label for the selected role.');
  for (const slot of pack.plan.slots.filter(slot => slot.execution.role === role)) validateComparisonRunnerBinding(slot.input, release);
}

/** Single-role offline replay with the shared evaluator/finalizer. The other role remains pending,
 * so the common report is intentionally partial, never a fabricated two-version comparison.
 * No API, Qloo, uploaded modules, retries or trace-integrity inference. */
export async function replayComparisonRole(options: ReplayRoleOptions): Promise<ReplayReport> {
  const pack = validateReplayPack(options.pack, options);
  const secrets = localSecrets(options.env ?? process.env);
  validateBinding(pack, options.role, options.assistantVersion, secrets);
  if (typeof options.adapter?.run !== 'function') throw new RunnerError('configuration_error', 'Replay requires an authorised local TargetAdapter.');
  const timeout = validateTimeout(options.targetTimeoutMs ?? 60_000);
  const originalDuration = Date.parse(pack.plan.request.deadlineAt) - Date.parse(pack.plan.createdAt);
  const budget = Math.min(originalDuration, validateTimeout(options.replayTimeoutMs ?? originalDuration, COMPARISON_LIMITS.deadlineSeconds * 1000));
  const reportId = IdSchema.safeParse(options.reportId ?? randomUUID());
  if (!reportId.success) throw new RunnerError('configuration_error', 'Replay report ID is invalid.');
  try { assertSafePortableContent(reportId.data, secrets); }
  catch { throw new RunnerError('configuration_error', 'Replay report ID must not contain a local credential.'); }
  const associations = initialComparisonAssociations(pack.plan);
  const results = new Map<string, TargetResult>();
  const deadlineAt = Date.now() + budget;
  let deadlineExceeded = false;
  let dispatches = 0;
  const unavailable = (code: string): TargetResult => ({ schema_version: SCHEMA_VERSION, outcome: 'provider_unavailable',
    error: { code, message: 'Local replay did not produce an available structured result.' }, retryable: false, trace: { completeness: 'unavailable', events: [] } });
  for (const slot of pack.plan.slots) {
    if (slot.execution.role !== options.role) continue;
    if (options.signal?.aborted) break;
    const remaining = deadlineAt - Date.now();
    if (remaining < 1) { deadlineExceeded = true; break; }
    if (dispatches >= pack.plan.request.dispatchBudget) break;
    const association = associations.find(row => row.attemptId === slot.attemptId);
    if (!association) throw new RunnerError('invalid_request', 'Replay slot association is missing.');
    association.status = 'leased'; association.dispatchCount = 1; dispatches++;
    let result: TargetResult;
    try {
      const value = await withDeadline(Math.min(timeout, remaining), options.signal, signal => options.adapter.run(structuredClone(slot.input), { signal }));
      // Invalid adapter envelopes are execution-unavailable. Only an explicit malformed_output
      // TargetResult may fail an output_schema rule.
      result = TargetResultSchema.parse(value);
      assertSafePortableContent(projectComparisonResult(result), secrets);
      result = TargetResultSchema.parse(redactJson(result, secrets));
    } catch (error) {
      if (options.signal?.aborted || Date.now() >= deadlineAt) {
        association.uncertainDispatches = 1;
        deadlineExceeded = !options.signal?.aborted;
        break;
      }
      if (error instanceof RunnerError && error.code === 'timeout') association.uncertainDispatches = 1;
      result = unavailable(error instanceof RunnerError && error.code === 'timeout' ? 'target_timeout' : 'local_adapter_unavailable');
    }
    association.status = 'completed'; results.set(slot.attemptId, result);
  }
  const finalizedAt = new Date().toISOString();
  const attempts = pack.plan.slots.map(slot => {
    const association = associations.find(row => row.attemptId === slot.attemptId);
    if (!association) throw new RunnerError('invalid_request', 'Replay slot association is missing.');
    const result = results.get(slot.attemptId) ?? null;
    return AttemptSchema.parse({ schema_version: SCHEMA_VERSION, id: slot.attemptId, projectId: pack.plan.projectId,
      catalogVersionId: slot.input.catalog.id, taskVersionId: slot.input.task.id, mappingConfirmationIds: slot.input.mappings.map(row => row.id),
      status: association.status, input: slot.input, inputChecksum: slot.inputChecksum,
      // Ephemeral local accounting identities, not API leases or runner credentials.
      leaseId: association.dispatchCount ? slot.attemptId : null, leaseCredentialId: association.dispatchCount ? reportId.data : null,
      leaseExpiresAt: association.dispatchCount ? new Date(deadlineAt).toISOString() : null,
      result, resultChecksum: result ? checksum(result) : null, createdAt: pack.plan.createdAt, completedAt: result ? finalizedAt : null });
  });
  const comparisonReport = prepareComparisonFinalization({ request: { schema_version: SCHEMA_VERSION, id: reportId.data, allowPartial: true },
    source: { plan: pack.plan, associations, attempts, state: options.signal?.aborted ? 'cancelled' : deadlineExceeded ? 'deadline_exceeded' : 'running' }, finalizedAt });
  const content = { schema_version: SCHEMA_VERSION, replay_version: 'tastecase-replay-report/1' as const, packChecksum: pack.checksum, comparisonReport };
  try { assertSafePortableContent(content, secrets); }
  catch { throw new RunnerError('invalid_response', 'Replay report cannot safely retain local result identities.'); }
  return validateReplayReport(ReplayReportSchema.parse({ ...content, checksum: checksum(content) }), pack);
}

function localPath(path: string): void {
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) throw new RunnerError('configuration_error', 'Artifact path must be a local filesystem path.');
}

/** No URLs, symlinks, devices or unbounded file reads; strict UTF-8 and full pack validation. */
export async function readReplayPackFile(path: string, options: { env?: Environment; expectedChecksum?: string } = {}): Promise<PortableTestPack> {
  localPath(path);
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > COMPARISON_LIMITS.packBytes) throw new Error();
    const bytes = Buffer.alloc(COMPARISON_LIMITS.packBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await file.read(bytes, size, bytes.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > COMPARISON_LIMITS.packBytes) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    return validateReplayPack(parsePortableTestPack(text, { expectedChecksum: options.expectedChecksum, knownSecrets: localSecrets(options.env ?? process.env) }), options);
  } catch { throw new RunnerError('invalid_request', 'Local pack file is unreadable, oversized, unsafe or incompatible.'); }
  finally { await file?.close(); }
}

/** Exclusive private output reservation happens before dispatch. Existing/source files are never
 * overwritten. An interrupted write can leave an empty/incomplete reserved file; it is not a valid report. */
export async function replayComparisonFile(options: Omit<ReplayRoleOptions, 'pack'> & { packPath: string; reportPath?: string }): Promise<ReplayReport> {
  const pack = await readReplayPackFile(options.packPath, options);
  validateBinding(pack, options.role, options.assistantVersion, localSecrets(options.env ?? process.env));
  let output: FileHandle | undefined;
  try {
    if (options.reportPath !== undefined) {
      localPath(options.reportPath);
      try { output = await open(options.reportPath, 'wx', 0o600); }
      catch { throw new RunnerError('conflict', 'Report file cannot be created exclusively; no target was dispatched.'); }
    }
    const report = await replayComparisonRole({ ...options, pack });
    if (output) { await output.writeFile(`${JSON.stringify(report)}\n`, 'utf8'); await output.sync(); }
    return report;
  } finally { await output?.close(); }
}
