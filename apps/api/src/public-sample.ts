import type { PoolClient } from 'pg';
import { IdSchema, PublicSampleSchema, SCHEMA_VERSION, validatePinnedReviewEvidence, type ReviewCaseResponse, type PublicSample } from '@tastecase/contracts';
import { readReviewCase } from './review-store.js';
import { HttpError } from './errors.js';

export interface PublicSampleConfig { projectId: string; caseId: string; syntheticInputs: true }
/** Server-only, dedicated synthetic sample allowlist. No default or caller-controlled selector. */
export function publicSampleConfig(env: NodeJS.ProcessEnv): PublicSampleConfig | undefined {
  const projectId = env.TASTECASE_PUBLIC_SAMPLE_PROJECT_ID;
  const caseId = env.TASTECASE_PUBLIC_SAMPLE_CASE_ID;
  const synthetic = env.TASTECASE_PUBLIC_SAMPLE_INPUTS_SYNTHETIC;
  if (projectId === undefined && caseId === undefined && synthetic === undefined) return undefined;
  return validatePublicSampleConfig({ projectId, caseId, syntheticInputs: synthetic === 'true' });
}
export function validatePublicSampleConfig(value: unknown): PublicSampleConfig {
  const config = value as Partial<PublicSampleConfig> | null;
  if (!config || !IdSchema.safeParse(config.projectId).success || !IdSchema.safeParse(config.caseId).success || config.syntheticInputs !== true) {
    throw new Error('Public sample requires explicit project/case UUIDs and synthetic-input approval.');
  }
  return Object.freeze({ projectId: config.projectId!, caseId: config.caseId!, syntheticInputs: true });
}
export function sampleUnavailable(): never {
  throw new HttpError(503, 'internal_error', 'Recorded public sample is unavailable.');
}

const privateKeys = new Set(['confirmedBy', 'reviewedBy', 'leaseId', 'leaseCredentialId', 'leaseExpiresAt', 'rawText', 'error', 'note']);
function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.has(key)).map(([key, item]) => [key, project(item)]));
  return value;
}
/** Fail closed for runtime secrets even in a schema-valid free-text output. No substitutions,
 * secret logging, or persistence; public errors are fixed messages. Known formats also protect
 * credentials no longer in this process's environment. */
export function assertPublicTextSafe(value: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 2097152) sampleUnavailable();
  if (/tc_runner_[A-Za-z0-9_-]+|\bBearer\s+\S+|-----BEGIN [^-]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:sk|qloo)[-_][A-Za-z0-9_-]{16,}|postgres(?:ql)?:\/\//i.test(text)) sampleUnavailable();
  for (const [name, secret] of Object.entries(env)) {
    if (/(?:KEY|TOKEN|PASSWORD|SECRET|DATABASE_URL)/i.test(name) && secret && secret.length >= 8
      && (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))) sampleUnavailable();
  }
}

/** Pinned persisted review snapshot only: no mutable job refresh, provider adapter, dispatch,
 * owner CRUD, receipt fabrication or recomputed checksums. Operator must independently review
 * the dedicated inputs as synthetic before setting the server allowlist. */
export function projectPublicSample(response: ReviewCaseResponse, config: PublicSampleConfig): PublicSample {
  if (response.case.projectId !== config.projectId || response.case.id !== config.caseId || !response.currentReview) sampleUnavailable();
  const evidence = validatePinnedReviewEvidence(response.currentReview.decision.evidence, response.case);
  if (evidence.projectId !== config.projectId || evidence.job.input.request.profiles.some(p => p.provenance !== 'public_synthetic')) sampleUnavailable();
  // A stored candidate alone cannot certify executed cultural evidence or assistant output.
  const selected = evidence.evidence.filter(row => evidence.candidate.content.evidenceIds.includes(row.id) && row.data.kind === 'rank');
  if (!(['a', 'b'] as const).every(profileId => selected.some(row => row.data.kind === 'rank' && row.data.profileId === profileId
    && row.data.scope === 'full' && ['ok', 'partial'].includes(row.data.providerStatus) && row.attemptId !== null
    && evidence.providerAttempts.some(attempt => attempt.id === row.attemptId && attempt.kind === 'qloo' && attempt.status === 'accepted' && attempt.finishedAt !== null)))) sampleUnavailable();
  if (!evidence.targets.some(row => row.attempt.status === 'completed' && row.attempt.result?.outcome === 'success')) sampleUnavailable();
  const decision = Object.fromEntries(Object.entries(response.currentReview.decision).filter(([key]) => !['evidence', 'reviewedBy', 'requestChecksum'].includes(key)));
  const job = Object.fromEntries(Object.entries(evidence.job).filter(([key]) => key !== 'reason'));
  const projected = project({ schema_version: SCHEMA_VERSION, provenance: 'recorded', inputs: 'synthetic', capturedAt: evidence.capturedAt,
    caseResponse: { ...response, currentReview: { decision, expectationVersion: response.currentReview.expectationVersion } },
    job: { schema_version: SCHEMA_VERSION, job, resolutions: evidence.resolutions, confirmations: evidence.confirmations,
      evidence: evidence.evidence, candidates: [evidence.candidate], attempts: evidence.targets.map(row => row.association),
      providerAttempts: evidence.providerAttempts.map(row => ({ id: row.id, kind: row.kind, status: row.status,
        reservedAt: row.reservedAt, dispatchedAt: row.dispatchedAt, finishedAt: row.finishedAt, retryable: row.retryable, errorCategory: row.errorCategory })) },
    attempts: evidence.targets.map(row => row.attempt),
  });
  const sample = PublicSampleSchema.parse(projected);
  assertPublicTextSafe(sample);
  return sample;
}
export async function readPublicSample(client: PoolClient, config: PublicSampleConfig) {
  // Project and case are only from frozen server configuration, never request params/Auth.
  return projectPublicSample(await readReviewCase(client, config.projectId, config.caseId), config);
}
