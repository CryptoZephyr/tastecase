import type { PoolClient } from 'pg';
import {
  SCHEMA_VERSION, canonicalJson, checksum, TargetInputSchema, PinnedDiscoveryInputSchema,
  DiscoveryJobSchema, DiscoveryJobDetailResponseSchema, DiscoveryJobListResponseSchema,
  AnchorResolutionSchema, DiscoveryAnchorConfirmationSchema, DiscoveryEvidenceSchema,
  DiscoveryCandidateSchema, DiscoveryProviderAttemptSchema, DiscoveryTargetAssociationSchema,
  type CreateDiscoveryJobRequest, type DiscoveryJob, type DiscoveryProviderAttempt,
} from '@tastecase/contracts';
import { catalogRecord, taskRecord, mappingRecord, type VersionRow, type MappingRow } from './db.js';
import { HttpError, parseRequest } from './errors.js';

/** Backend-only row mappings. Callers must establish the owner's project or a worker lease first. */
export interface DiscoveryJobRow {
  id: string; project_id: string; schema_version: string; pinned_input: unknown; input_checksum: string;
  state: DiscoveryJob['state']; checkpoint: number; checkpoint_data: unknown;
  qloo_attempts: number; model_decisions: number; target_attempts: number; rounds: number; revision: string;
  lease_id: string | null; lease_expires_at: Date | null; available_at: Date; deadline_at: Date;
  created_at: Date; cancelled_at: Date | null; reason: string | null;
}
interface EvidenceRow {
  id: string; project_id: string; job_id: string; schema_version: string; attempt_id: string | null;
  data: unknown; checksum: string; captured_at: Date;
}
interface CandidateRow {
  id: string; project_id: string; job_id: string; schema_version: string; content: unknown; checksum: string; created_at: Date;
}
interface ResolutionRow {
  id: string; project_id: string; job_id: string; anchor_id: string; evidence_id: string; candidates: unknown; created_at: Date;
}
interface ConfirmationRow {
  id: string; project_id: string; job_id: string; anchor_id: string; resolution_id: string | null;
  entity_id: string; confirmed_by: string; created_at: Date;
}
export interface DiscoveryProviderAttemptRow {
  id: string; project_id: string; job_id: string; kind: DiscoveryProviderAttempt['kind']; operation_key: string;
  try_number: number; request_checksum: string; reserved_lease_id: string; status: DiscoveryProviderAttempt['status'];
  reserved_at: Date; dispatched_at: Date | null; finished_at: Date | null; retryable: boolean;
  error_category: DiscoveryProviderAttempt['errorCategory']; error_code: string | null; next_dispatch_at: Date | null;
}
interface AssociationRow {
  attempt_id: string; profile_id: string; round: number; repeat: number; variant: string; status: string;
  dispatch_count: number; uncertain_dispatches: number; cancelled: boolean;
}

export function discoveryJobRecord(row: DiscoveryJobRow): DiscoveryJob {
  return DiscoveryJobSchema.parse({
    schema_version: row.schema_version, id: row.id, projectId: row.project_id, input: row.pinned_input,
    inputChecksum: row.input_checksum, state: row.state,
    checkpoint: ['pinned', 'anchors', 'ranks', 'selection', 'targets', 'investigation', 'saved'][row.checkpoint],
    checkpointData: row.checkpoint_data,
    counters: { qlooAttempts: row.qloo_attempts, modelDecisions: row.model_decisions, targetAttempts: row.target_attempts, rounds: row.rounds },
    revision: Number(row.revision), leaseId: row.lease_id, leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    availableAt: row.available_at.toISOString(), deadlineAt: row.deadline_at.toISOString(), createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null, reason: row.reason,
  });
}
export function discoveryProviderAttemptRecord(row: DiscoveryProviderAttemptRow): DiscoveryProviderAttempt {
  return DiscoveryProviderAttemptSchema.parse({
    id: row.id, projectId: row.project_id, jobId: row.job_id, kind: row.kind, operationKey: row.operation_key,
    tryNumber: row.try_number, requestChecksum: row.request_checksum, reservedLeaseId: row.reserved_lease_id,
    status: row.status, reservedAt: row.reserved_at.toISOString(), dispatchedAt: row.dispatched_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null, retryable: row.retryable, errorCategory: row.error_category,
    errorCode: row.error_code, nextDispatchAt: row.next_dispatch_at?.toISOString() ?? null,
  });
}
function evidenceRecord(row: EvidenceRow) {
  return DiscoveryEvidenceSchema.parse({ schema_version: row.schema_version, id: row.id, projectId: row.project_id,
    jobId: row.job_id, attemptId: row.attempt_id, data: row.data, checksum: row.checksum, capturedAt: row.captured_at.toISOString() });
}
function candidateRecord(row: CandidateRow) {
  return DiscoveryCandidateSchema.parse({ schema_version: row.schema_version, id: row.id, projectId: row.project_id,
    jobId: row.job_id, content: row.content, checksum: row.checksum, createdAt: row.created_at.toISOString() });
}
function resolutionRecord(row: ResolutionRow) {
  return AnchorResolutionSchema.parse({ schema_version: SCHEMA_VERSION, id: row.id, projectId: row.project_id,
    jobId: row.job_id, anchorId: row.anchor_id, evidenceId: row.evidence_id, candidates: row.candidates, createdAt: row.created_at.toISOString() });
}
function confirmationRecord(row: ConfirmationRow) {
  return DiscoveryAnchorConfirmationSchema.parse({ schema_version: SCHEMA_VERSION, id: row.id, projectId: row.project_id,
    jobId: row.job_id, anchorId: row.anchor_id, resolutionId: row.resolution_id, entityId: row.entity_id,
    confirmedBy: row.confirmed_by, createdAt: row.created_at.toISOString() });
}

const jobQuery = 'SELECT j.*, s.* FROM public.discovery_jobs j JOIN public.discovery_job_state s ON s.project_id=j.project_id AND s.job_id=j.id';

/** Reads saved checkpoints without mutating budgets, attempts or lease history. */
export async function readDiscoveryJob(client: PoolClient, projectId: string, jobId: string): Promise<DiscoveryJob> {
  const result = await client.query<DiscoveryJobRow>(`${jobQuery} WHERE j.project_id=$1 AND j.id=$2`, [projectId, jobId]);
  if (!result.rows[0]) throw new HttpError(404, 'not_found', 'The discovery job was not found in this project.');
  return discoveryJobRecord(result.rows[0]);
}

/** Queue retries return the same immutable input/current state; they never restart a job. */
export async function queueDiscoveryJob(client: PoolClient, projectId: string, body: CreateDiscoveryJobRequest) {
  const catalog = await client.query<VersionRow>('SELECT * FROM public.catalog_versions WHERE project_id=$1 AND id=$2', [projectId, body.catalogVersionId]);
  const task = await client.query<VersionRow>('SELECT * FROM public.task_versions WHERE project_id=$1 AND id=$2 AND catalog_version_id=$3', [projectId, body.taskVersionId, body.catalogVersionId]);
  if (!catalog.rows[0] || !task.rows[0]) throw new HttpError(404, 'not_found', 'The task or catalog version was not found in this project.');
  const mappings = await client.query<MappingRow>('SELECT * FROM public.mapping_confirmations WHERE project_id=$1 AND catalog_version_id=$2 AND id=ANY($3::uuid[])', [projectId, body.catalogVersionId, body.mappingConfirmationIds]);
  const byId = new Map(mappings.rows.map(row => [row.id, mappingRecord(row)]));
  if (byId.size !== body.mappingConfirmationIds.length) throw new HttpError(404, 'not_found', 'A mapping confirmation was not found in this project catalog.');
  const input = parseRequest(PinnedDiscoveryInputSchema, {
    schema_version: SCHEMA_VERSION, request: body,
    targetInput: parseRequest(TargetInputSchema, { schema_version: SCHEMA_VERSION, projectId,
      catalog: catalogRecord(catalog.rows[0]), task: taskRecord(task.rows[0]),
      mappings: body.mappingConfirmationIds.map(id => byId.get(id)), eligibleCatalogEntryIds: body.eligibleCatalogEntryIds }),
  });
  // A single database timestamp keeps the immutable deadline and created_at equal under the SQL guard.
  await client.query(`WITH timing AS (SELECT clock_timestamp() AS now)
    INSERT INTO public.discovery_jobs(id,project_id,catalog_version_id,task_version_id,schema_version,pinned_input,input_checksum,created_at,deadline_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,now,now+make_interval(secs=>$8) FROM timing ON CONFLICT DO NOTHING`,
  [body.id, projectId, body.catalogVersionId, body.taskVersionId, SCHEMA_VERSION, JSON.stringify(input), checksum(input), body.budgets.deadlineSeconds]);
  const existing = await client.query<DiscoveryJobRow>(`${jobQuery} WHERE j.project_id=$1 AND j.id=$2`, [projectId, body.id]);
  const row = existing.rows[0];
  if (!row || row.input_checksum !== checksum(input) || canonicalJson(row.pinned_input) !== canonicalJson(input)) {
    throw new HttpError(409, 'conflict', 'The discovery job ID already exists with different pinned inputs.');
  }
  return discoveryJobRecord(row);
}

export async function listDiscoveryJobs(client: PoolClient, projectId: string, limit: number, offset: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new HttpError(400, 'invalid_request', 'The discovery list bounds are invalid.');
  }
  return DiscoveryJobListResponseSchema.parse({ schema_version: SCHEMA_VERSION,
    jobs: (await client.query<DiscoveryJobRow>(`${jobQuery} WHERE j.project_id=$1 ORDER BY j.created_at DESC,j.id DESC LIMIT $2 OFFSET $3`, [projectId, limit, offset])).rows.map(discoveryJobRecord) });
}

export async function readDiscoveryEvidence(client: PoolClient, projectId: string, jobId: string, evidenceId: string) {
  const result = await client.query<EvidenceRow>('SELECT * FROM public.discovery_tool_evidence WHERE project_id=$1 AND job_id=$2 AND id=$3', [projectId, jobId, evidenceId]);
  if (!result.rows[0]) throw new HttpError(404, 'not_found', 'The discovery evidence was not found in this job.');
  return evidenceRecord(result.rows[0]);
}
export async function readDiscoveryCandidate(client: PoolClient, projectId: string, jobId: string, candidateId: string) {
  const result = await client.query<CandidateRow>('SELECT * FROM public.discovery_candidates WHERE project_id=$1 AND job_id=$2 AND id=$3', [projectId, jobId, candidateId]);
  if (!result.rows[0]) throw new HttpError(404, 'not_found', 'The discovery candidate was not found in this job.');
  return candidateRecord(result.rows[0]);
}

/** Bounded normalised evidence. Use a snapshot transaction for a consistent multi-query read.
 * Target outputs remain on the owner attempt route, not raw provider payloads here. */
export async function readDiscoveryDetail(client: PoolClient, projectId: string, jobId: string) {
  const found = await client.query<DiscoveryJobRow>(`${jobQuery} WHERE j.project_id=$1 AND j.id=$2`, [projectId, jobId]);
  if (!found.rows[0]) throw new HttpError(404, 'not_found', 'The discovery job was not found in this project.');
  const params = [projectId, jobId];
  const resolutions = await client.query<ResolutionRow>('SELECT * FROM public.discovery_anchor_resolutions WHERE project_id=$1 AND job_id=$2 ORDER BY created_at,id LIMIT 21', params);
  const confirmations = await client.query<ConfirmationRow>('SELECT * FROM public.discovery_anchor_confirmations WHERE project_id=$1 AND job_id=$2 ORDER BY created_at,id LIMIT 11', params);
  const evidence = await client.query<EvidenceRow>('SELECT * FROM public.discovery_tool_evidence WHERE project_id=$1 AND job_id=$2 ORDER BY captured_at,id LIMIT 51', params);
  const candidates = await client.query<CandidateRow>('SELECT * FROM public.discovery_candidates WHERE project_id=$1 AND job_id=$2 ORDER BY created_at,id LIMIT 7', params);
  const providers = await client.query<DiscoveryProviderAttemptRow>('SELECT * FROM public.discovery_provider_attempts WHERE project_id=$1 AND job_id=$2 ORDER BY reserved_at,id LIMIT 29', params);
  const targets = await client.query<AssociationRow>(`SELECT t.*, a.status, s.cancelled_at IS NOT NULL AS cancelled,
      (SELECT count(*)::int FROM public.discovery_target_dispatches d WHERE d.attempt_id=t.attempt_id) AS dispatch_count,
      (SELECT count(*)::int FROM public.discovery_target_dispatches d WHERE d.attempt_id=t.attempt_id
        AND (d.lease_id IS DISTINCT FROM a.lease_id OR (a.status='leased' AND a.lease_expires_at<=clock_timestamp()))) AS uncertain_dispatches
    FROM public.discovery_job_targets t JOIN public.target_attempts a ON a.project_id=t.project_id AND a.id=t.attempt_id
    JOIN public.discovery_job_state s ON s.project_id=t.project_id AND s.job_id=t.job_id
    WHERE t.project_id=$1 AND t.job_id=$2 ORDER BY t.created_at,t.attempt_id LIMIT 13`, params);
  // Read one beyond each supported bound and reject overflow rather than hide historical evidence.
  return DiscoveryJobDetailResponseSchema.parse({ schema_version: SCHEMA_VERSION, job: discoveryJobRecord(found.rows[0]),
    resolutions: resolutions.rows.map(resolutionRecord), confirmations: confirmations.rows.map(confirmationRecord),
    evidence: evidence.rows.map(evidenceRecord), candidates: candidates.rows.map(candidateRecord),
    providerAttempts: providers.rows.map(discoveryProviderAttemptRecord),
    attempts: targets.rows.map(row => DiscoveryTargetAssociationSchema.parse({ attemptId: row.attempt_id,
      profileId: row.profile_id, round: row.round, repeat: row.repeat, variant: row.variant, status: row.status,
      dispatchCount: row.dispatch_count, uncertainDispatches: row.uncertain_dispatches, cancelled: row.cancelled })),
  });
}

/** Owner confirmation is the only owner-triggered resume. No counter/deadline reset or blind retry exists. */
export async function confirmDiscoveryAnchor(client: PoolClient, projectId: string, jobId: string, ownerId: string,
  body: { id: string; anchorId: string; resolutionId: string; entityId: string }) {
  await readDiscoveryJob(client, projectId, jobId);
  const resolution = await client.query<ResolutionRow>(`SELECT r.* FROM public.discovery_anchor_resolutions r
    JOIN public.discovery_tool_evidence e ON e.project_id=r.project_id AND e.job_id=r.job_id AND e.id=r.evidence_id
    WHERE r.project_id=$1 AND r.job_id=$2 AND r.id=$3 AND r.anchor_id=$4 AND e.data->>'providerStatus' IN ('ok','partial','needs_input')`,
  [projectId, jobId, body.resolutionId, body.anchorId]);
  if (!resolution.rows[0]) throw new HttpError(404, 'not_found', 'A supported observed resolution was not found for this job anchor.');
  if (!resolutionRecord(resolution.rows[0]).candidates.some(candidate => candidate.entityId === body.entityId)) {
    throw new HttpError(400, 'invalid_request', 'The selected entity must be an observed anchor candidate.');
  }
  try {
    const result = await client.query<ConfirmationRow>('SELECT * FROM public.confirm_discovery_anchor($1,$2,$3,$4,$5,$6,$7)',
      [projectId, jobId, ownerId, body.id, body.anchorId, body.resolutionId, body.entityId]);
    return confirmationRecord(result.rows[0]);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23514') {
      throw new HttpError(409, 'conflict', 'The job cannot accept this confirmation in its current state.');
    }
    throw error;
  }
}

export async function cancelDiscoveryJob(client: PoolClient, projectId: string, jobId: string) {
  await readDiscoveryJob(client, projectId, jobId);
  await client.query('SELECT * FROM public.cancel_discovery_job($1,$2)', [projectId, jobId]);
  return readDiscoveryJob(client, projectId, jobId);
}
