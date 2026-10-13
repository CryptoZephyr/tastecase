import type { PoolClient } from 'pg';
import {
  SCHEMA_VERSION, ReviewCaseSchema, ReviewCaseResponseSchema, ReviewCaseListResponseSchema, ReviewHistoryResponseSchema,
  ReviewDecisionResponseSchema, ReviewHeadSchema, ReviewRecordSchema, ReviewWindowRequestSchema,
  SuiteIdentitySchema, SuiteListResponseSchema, SuiteVersionSchema, SuiteVersionListResponseSchema,
  PublishSuiteResponseSchema, validateReviewRetry, validatePublicationRetry, validatePinnedReviewEvidence,
  pinReviewEvidence, ReviewConflictError,
  type CreateReviewCaseRequest, type ReviewCaseResponse, type ReviewDecisionRequest,
  type CreateSuiteRequest, type PublishSuiteRequest, type SuiteIdentity,
} from '@tastecase/contracts';
import { attemptRecord, type AttemptRow } from './db.js';
import { readDiscoveryDetail, readDiscoveryCandidate } from './discovery-store.js';
import { HttpError, type RequestSchema } from './errors.js';

interface CaseRow {
  case_json: unknown; project_id: string; case_id: string; job_id: string; candidate_id: string;
  revision: string; status: string; last_decision_id: string | null; approved_expectation_version_id: string | null;
  receipt: unknown | null; version_json: unknown | null;
  candidate_content: unknown; candidate_checksum: string; candidate_created_at: Date;
}
interface RecordRow { receipt: unknown; version_json: unknown | null }
interface SuiteRow { id: string; project_id: string; name: string; current_version: string; created_at: Date }

/** Call only after projectOwner authorisation. Stored corruption is a visible conflict, never raw validation output. */
function stored<T>(schema: RequestSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(409, 'conflict', 'The stored review or suite evidence conflicts with its pinned context.');
  return result.data;
}
function bounds(limit: number, offset: number) {
  if (!ReviewWindowRequestSchema.safeParse({ limit, offset }).success) {
    throw new HttpError(400, 'invalid_request', 'The review list bounds are invalid.');
  }
}
function missing(): never { throw new HttpError(404, 'not_found', 'The resource was not found in this project.'); }
function conflict(): never { throw new HttpError(409, 'conflict', 'The review or suite changed, or the immutable request ID has different content.'); }

/** RPCs alone lock/validate/advance mutations. The surrounding foundation transaction bounds the entire statement. */
async function mutation(client: PoolClient, sql: string, values: unknown[]): Promise<unknown> {
  try { return (await client.query<{ value: unknown }>(sql, values)).rows[0]?.value; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (['40001', '23505'].includes(String(error.code))) conflict();
      if (['23503', '42501'].includes(String(error.code))) missing();
      if (error.code === '23514' && error instanceof Error && [
        'Candidate checksum mismatch', 'Stored review source checksum mismatch',
        'Target source does not preserve pinned job context or checksum', 'Candidate changed',
      ].includes(error.message)) {
        throw new HttpError(409, 'conflict', 'The stored source conflicts with its pinned identity or checksum.');
      }
      if (['23514', '22P02', '22003'].includes(String(error.code))) {
        throw new HttpError(400, 'invalid_request', 'The review or suite request violates its pinned scope or supported rules.');
      }
      if (['55P03', '57014', '40P01'].includes(String(error.code))) {
        throw new HttpError(503, 'internal_error', 'The review or suite is busy. Retry the same request ID.');
      }
    }
    throw error;
  }
}
const caseQuery = `SELECT c.case_json,h.*,d.receipt,v.version_json,
    candidate.content AS candidate_content,candidate.checksum AS candidate_checksum,candidate.created_at AS candidate_created_at
  FROM public.review_cases c
  JOIN public.review_heads h ON h.project_id=c.project_id AND h.case_id=c.id
  JOIN public.discovery_candidates candidate ON candidate.project_id=c.project_id AND candidate.job_id=c.job_id AND candidate.id=c.candidate_id
  LEFT JOIN public.review_decisions d ON d.project_id=h.project_id AND d.case_id=h.case_id AND d.id=h.last_decision_id
  LEFT JOIN public.expectation_versions v ON v.project_id=d.project_id AND v.case_id=d.case_id AND v.review_decision_id=d.id`;
const recordQuery = `SELECT d.receipt,v.version_json FROM public.review_decisions d
  LEFT JOIN public.expectation_versions v ON v.project_id=d.project_id AND v.case_id=d.case_id AND v.review_decision_id=d.id`;
function record(row: RecordRow) { return stored(ReviewRecordSchema, { decision: row.receipt, expectationVersion: row.version_json }); }
function reviewCase(row: CaseRow): ReviewCaseResponse {
  return stored(ReviewCaseResponseSchema, {
    schema_version: SCHEMA_VERSION, case: row.case_json,
    head: stored(ReviewHeadSchema, { schema_version: SCHEMA_VERSION, projectId: row.project_id, caseId: row.case_id,
      jobId: row.job_id, candidateId: row.candidate_id, revision: Number(row.revision), status: row.status,
      lastDecisionId: row.last_decision_id, approvedExpectationVersionId: row.approved_expectation_version_id }),
    candidate: { schema_version: SCHEMA_VERSION, id: row.candidate_id, projectId: row.project_id, jobId: row.job_id,
      content: row.candidate_content, checksum: row.candidate_checksum, createdAt: row.candidate_created_at.toISOString() },
    currentReview: row.receipt === null ? null : record(row),
  });
}

/** Detailed reads and windows must run with transaction(snapshot=true). No job/lease/budget writes occur. */
export async function readReviewCase(client: PoolClient, projectId: string, caseId: string) {
  const row = (await client.query<CaseRow>(`${caseQuery} WHERE c.project_id=$1 AND c.id=$2`, [projectId, caseId])).rows[0];
  if (!row) missing();
  return reviewCase(row);
}
export async function listReviewCases(client: PoolClient, projectId: string, limit: number, offset: number) {
  bounds(limit, offset);
  const rows = await client.query<CaseRow>(`${caseQuery} WHERE c.project_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT $2 OFFSET $3`, [projectId, limit, offset]);
  return stored(ReviewCaseListResponseSchema, { schema_version: SCHEMA_VERSION, cases: rows.rows.map(reviewCase) });
}
export async function readReviewHistory(client: PoolClient, projectId: string, caseId: string, limit: number, offset: number) {
  bounds(limit, offset);
  // Existence check never reconstructs history from this mutable head.
  const found = await client.query('SELECT id FROM public.review_cases WHERE project_id=$1 AND id=$2', [projectId, caseId]);
  if (!found.rows[0]) missing();
  const rows = await client.query<RecordRow>(`${recordQuery} WHERE d.project_id=$1 AND d.case_id=$2 ORDER BY d.revision DESC LIMIT $3 OFFSET $4`, [projectId, caseId, limit, offset]);
  return stored(ReviewHistoryResponseSchema, { schema_version: SCHEMA_VERSION, reviews: rows.rows.map(record) });
}

/** Backend-resolved live source for investigation only. Use snapshot=true; never use this to materialise historical approvals. */
export async function readReviewEvidence(client: PoolClient, projectId: string, caseId: string) {
  const row = await readReviewCase(client, projectId, caseId);
  const detail = await readDiscoveryDetail(client, projectId, row.case.jobId);
  const candidate = await readDiscoveryCandidate(client, projectId, row.case.jobId, row.case.candidateId);
  const attempts = await client.query<AttemptRow>(`SELECT a.* FROM public.target_attempts a
    JOIN public.discovery_job_targets t ON t.project_id=a.project_id AND t.attempt_id=a.id
    WHERE t.project_id=$1 AND t.job_id=$2 ORDER BY t.created_at,t.attempt_id LIMIT 13`, [projectId, row.case.jobId]);
  const byId = new Map(attempts.rows.map(attempt => [attempt.id, attemptRecord(attempt)]));
  try {
    return validatePinnedReviewEvidence(pinReviewEvidence({ schema_version: SCHEMA_VERSION, projectId, jobId: row.case.jobId,
      candidate, job: detail.job, resolutions: detail.resolutions, confirmations: detail.confirmations,
      evidence: detail.evidence, providerAttempts: detail.providerAttempts,
      targets: detail.attempts.map(association => {
        const attempt = byId.get(association.attemptId);
        if (!attempt) throw new Error('Target not resolved.');
        return { association, attempt };
      }), capturedAt: new Date().toISOString() }), row.case);
  } catch { throw new HttpError(409, 'conflict', 'The discovery evidence conflicts with its pinned review context.'); }
}

export async function createReviewCase(client: PoolClient, projectId: string, ownerId: string, request: CreateReviewCaseRequest) {
  return stored(ReviewCaseResponseSchema, await mutation(client, 'SELECT public.create_review_case($1,$2,$3) AS value', [projectId, ownerId, JSON.stringify(request)]));
}
export async function recordReviewDecision(client: PoolClient, projectId: string, ownerId: string, caseId: string, request: ReviewDecisionRequest) {
  // SQL builds source rows in one MVCC snapshot, not from a client-supplied snapshot or a pre-lock read.
  const response = stored(ReviewDecisionResponseSchema, await mutation(client, 'SELECT public.record_review_decision($1,$2,$3,$4) AS value', [projectId, ownerId, caseId, JSON.stringify(request)]));
  const found = await client.query<{ case_json: unknown }>('SELECT case_json FROM public.review_cases WHERE project_id=$1 AND id=$2', [projectId, caseId]);
  const row = found.rows[0];
  if (!row) missing();
  try {
    const review = validateReviewRetry(request, response.review, stored(ReviewCaseSchema, row.case_json));
    // Reassemble/validate the SQL-resolved source with shared canonical checks before COMMIT.
    const evidence = review.decision.evidence;
    if (pinReviewEvidence({ schema_version: evidence.schema_version, projectId: evidence.projectId, jobId: evidence.jobId,
      candidate: evidence.candidate, job: evidence.job, resolutions: evidence.resolutions, confirmations: evidence.confirmations,
      evidence: evidence.evidence, providerAttempts: evidence.providerAttempts, targets: evidence.targets, capturedAt: evidence.capturedAt,
    }).checksum !== evidence.checksum || review.decision.reviewedBy !== ownerId) conflict();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof ReviewConflictError) conflict();
    throw new HttpError(409, 'conflict', 'The stored review receipt conflicts with its immutable request.');
  }
  return response;
}
function suiteIdentity(row: SuiteRow): SuiteIdentity {
  return stored(SuiteIdentitySchema, { schema_version: SCHEMA_VERSION, id: row.id, projectId: row.project_id,
    name: row.name, currentVersion: Number(row.current_version), createdAt: row.created_at.toISOString() });
}
export async function readSuite(client: PoolClient, projectId: string, suiteId: string) {
  const row = (await client.query<SuiteRow>('SELECT * FROM public.suites WHERE project_id=$1 AND id=$2', [projectId, suiteId])).rows[0];
  if (!row) missing();
  return suiteIdentity(row);
}
export async function listSuites(client: PoolClient, projectId: string, limit: number, offset: number) {
  bounds(limit, offset);
  const rows = await client.query<SuiteRow>('SELECT * FROM public.suites WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3', [projectId, limit, offset]);
  return stored(SuiteListResponseSchema, { schema_version: SCHEMA_VERSION, suites: rows.rows.map(suiteIdentity) });
}
export async function createSuite(client: PoolClient, projectId: string, ownerId: string, request: CreateSuiteRequest) {
  return stored(SuiteIdentitySchema, await mutation(client, 'SELECT public.create_suite($1,$2,$3) AS value', [projectId, ownerId, JSON.stringify(request)]));
}
export async function publishSuite(client: PoolClient, projectId: string, ownerId: string, request: PublishSuiteRequest) {
  const response = stored(PublishSuiteResponseSchema, await mutation(client, 'SELECT public.publish_suite($1,$2,$3) AS value', [projectId, ownerId, JSON.stringify(request)]));
  try { validatePublicationRetry(request, response.suite, await readSuite(client, projectId, request.suiteId)); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    conflict();
  }
  if (response.suite.publishedBy !== ownerId) conflict();
  return response;
}
export async function readSuiteVersion(client: PoolClient, projectId: string, suiteId: string, versionId: string) {
  const row = (await client.query<{ snapshot: unknown }>('SELECT snapshot FROM public.suite_versions WHERE project_id=$1 AND suite_id=$2 AND id=$3', [projectId, suiteId, versionId])).rows[0];
  if (!row) missing();
  return stored(SuiteVersionSchema, row.snapshot);
}
export async function listSuiteVersions(client: PoolClient, projectId: string, suiteId: string, limit: number, offset: number) {
  bounds(limit, offset);
  await readSuite(client, projectId, suiteId);
  const rows = await client.query<{ snapshot: unknown }>('SELECT snapshot FROM public.suite_versions WHERE project_id=$1 AND suite_id=$2 ORDER BY version DESC LIMIT $3 OFFSET $4', [projectId, suiteId, limit, offset]);
  return stored(SuiteVersionListResponseSchema, { schema_version: SCHEMA_VERSION, versions: rows.rows.map(row => stored(SuiteVersionSchema, row.snapshot)) });
}
