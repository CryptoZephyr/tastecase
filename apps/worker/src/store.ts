import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  canonicalJson, checksum, DiscoveryJobSchema, DiscoveryEvidenceSchema, DiscoveryProviderAttemptSchema,
  DiscoveryAnchorConfirmationSchema, TargetResultSchema, NormalizedDiscoveryEvidenceSchema,
  CreateTaskVersionRequestSchema, TargetInputSchema, DiscoveryCandidateContentSchema,
  discoveryAttemptId, type DiscoveryJob, type NormalizedDiscoveryEvidence,
} from '@tastecase/contracts';
import type { Snapshot, Transition, ScheduledTarget } from './types.js';

export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export interface WorkerDatabase extends Queryable { transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> }

/** Use a backend DB role, not an owner JWT. No local bootstrap or migration is performed here. */
export class PoolDatabase implements WorkerDatabase {
  constructor(private readonly pool: Pool) {}
  query(sql: string, params?: unknown[]) { return this.pool.query<Record<string, unknown>>(sql, params); }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL idle_in_transaction_session_timeout='10s'");
      const value = await work(client); await client.query('COMMIT'); return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }
}

const checkpoints = ['pinned', 'anchors', 'ranks', 'selection', 'targets', 'investigation', 'saved'] as const;
const jobQuery = `SELECT jsonb_build_object(
  'schema_version',j.schema_version,'id',j.id,'projectId',j.project_id,'input',j.pinned_input,'inputChecksum',j.input_checksum,
  'state',s.state,'checkpoint',s.checkpoint,'checkpointData',s.checkpoint_data,
  'counters',jsonb_build_object('qlooAttempts',s.qloo_attempts,'modelDecisions',s.model_decisions,'targetAttempts',s.target_attempts,'rounds',s.rounds),
  'revision',s.revision,'leaseId',s.lease_id,'leaseExpiresAt',s.lease_expires_at,'availableAt',s.available_at,
  'deadlineAt',j.deadline_at,'createdAt',j.created_at,'cancelledAt',s.cancelled_at,'reason',s.reason) AS data
  FROM public.discovery_jobs j JOIN public.discovery_job_state s ON s.project_id=j.project_id AND s.job_id=j.id
  WHERE j.project_id=$1 AND j.id=$2`;
const jobWithNumber = z.object({ checkpoint: z.number().int().min(0).max(6) }).passthrough();
const targetSchema = z.strictObject({
  attemptId: z.uuid(), profileId: z.enum(['a','b']), round: z.number().int(), repeat: z.number().int(),
  variant: z.enum(['full','reduced_pair']), status: z.enum(['queued','leased','completed']),
  result: TargetResultSchema.nullable(), resultChecksum: z.string().nullable(),
  uncertainDispatches: z.number().int().nonnegative(), claimable: z.boolean(),
}).refine(value => value.result === null ? value.resultChecksum === null : checksum(value.result) === value.resultChecksum, 'Target result checksum mismatch');
const providerQuery = `SELECT jsonb_build_object('id',id,'projectId',project_id,'jobId',job_id,'kind',kind,'operationKey',operation_key,
  'tryNumber',try_number,'requestChecksum',request_checksum,'reservedLeaseId',reserved_lease_id,'status',status,
  'reservedAt',reserved_at,'dispatchedAt',dispatched_at,'finishedAt',finished_at,'retryable',retryable,
  'errorCategory',error_category,'errorCode',error_code,'nextDispatchAt',next_dispatch_at) AS data
  FROM public.discovery_provider_attempts WHERE project_id=$1 AND job_id=$2 ORDER BY reserved_at,id`;

function fenced(job: DiscoveryJob): [string, string, string] {
  if (job.leaseId === null) throw new Error('No discovery lease');
  return [job.projectId, job.id, job.leaseId];
}

export class DiscoveryStore {
  constructor(readonly database: WorkerDatabase) {}
  async claim(seconds = 60, projectId: string | null = null): Promise<Snapshot | null> {
    return this.database.transaction(async client => {
      const result = await client.query('SELECT project_id,job_id FROM public.claim_discovery_job($1,$2,$3)', [randomUUID(),seconds,projectId]);
      const row = result.rows[0];
      if (!row) return null;
      const identity = z.object({ project_id: z.uuid(), job_id: z.uuid() }).parse(row);
      return this.load(identity.project_id, identity.job_id, client);
    });
  }
  async load(projectId: string, jobId: string, client: Queryable = this.database): Promise<Snapshot> {
    const rows = await client.query(jobQuery, [projectId,jobId]);
    if (!rows.rows[0]) throw new Error('Discovery job not found');
    const record = jobWithNumber.parse(rows.rows[0].data);
    const job = DiscoveryJobSchema.parse({ ...record, checkpoint: checkpoints[record.checkpoint] });
    const params = [projectId,jobId];
    const evidence = await client.query(`SELECT jsonb_build_object('schema_version',schema_version,'id',id,'projectId',project_id,
      'jobId',job_id,'attemptId',attempt_id,'data',data,'checksum',checksum,'capturedAt',captured_at) AS data
      FROM public.discovery_tool_evidence WHERE project_id=$1 AND job_id=$2 ORDER BY captured_at,id`, params);
    const confirmations = await client.query(`SELECT jsonb_build_object('schema_version','1.0.0','id',id,'projectId',project_id,
      'jobId',job_id,'anchorId',anchor_id,'resolutionId',resolution_id,'entityId',entity_id,'confirmedBy',confirmed_by,'createdAt',created_at) AS data
      FROM public.discovery_anchor_confirmations WHERE project_id=$1 AND job_id=$2 ORDER BY anchor_id`,params);
    const providers = await client.query(providerQuery,params);
    const targets = await client.query(`SELECT jsonb_build_object('attemptId',a.attempt_id,'profileId',a.profile_id,'round',a.round,'repeat',a.repeat,
      'variant',a.variant,'status',t.status,'result',t.result,'resultChecksum',t.result_checksum,
      'claimable',public.discovery_target_claimable(a.attempt_id),
      'uncertainDispatches',(SELECT count(*) FROM public.discovery_target_dispatches d WHERE d.attempt_id=t.id
        AND NOT (t.status='completed' AND t.lease_id=d.lease_id) AND NOT (t.status='leased' AND t.lease_id=d.lease_id AND t.lease_expires_at>clock_timestamp()))) AS data
      FROM public.discovery_job_targets a JOIN public.target_attempts t ON t.project_id=a.project_id AND t.id=a.attempt_id
      WHERE a.project_id=$1 AND a.job_id=$2 ORDER BY a.round,a.repeat,a.profile_id`,params);
    return { job, evidence: evidence.rows.map(row => DiscoveryEvidenceSchema.parse(row.data)),
      confirmations: confirmations.rows.map(row => DiscoveryAnchorConfirmationSchema.parse(row.data)),
      providerAttempts: providers.rows.map(row => DiscoveryProviderAttemptSchema.parse(row.data)),
      targets: targets.rows.map(row => targetSchema.parse(row.data)),
    };
  }
  async renew(job: DiscoveryJob, seconds = 60) {
    await this.database.transaction(async client => {
      await client.query('SELECT public.renew_discovery_lease($1,$2,$3,$4)', [...fenced(job), seconds]);
    });
  }
  async advance(job: DiscoveryJob, transition: Transition, client: Queryable = this.database) {
    const data = { ...job.checkpointData,
      evidenceIds: [...new Set([...job.checkpointData.evidenceIds, ...(transition.evidenceIds ?? [])])],
      candidateIds: [...new Set([...job.checkpointData.candidateIds, ...(transition.candidateIds ?? [])])],
    };
    await client.query('SELECT public.advance_discovery_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[
      ...fenced(job),transition.state,Math.max(checkpoints.indexOf(job.checkpoint), transition.checkpoint ?? 0),JSON.stringify(data),
      transition.reason ?? null,transition.delaySeconds ?? 0,transition.release ?? false,transition.round ?? false,
    ]);
  }
  async reserve(job: DiscoveryJob, operation: string, kind: 'qloo' | 'model', tryNumber: number, request: unknown, allowUncertain: boolean) {
    const id = discoveryAttemptId(job.id, `${kind}:${operation}`,tryNumber);
    await this.database.query('SELECT public.reserve_discovery_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
      ...fenced(job),id,kind,operation,tryNumber,checksum(request),allowUncertain,
    ]);
    return id;
  }
  async dispatch(job: DiscoveryJob, id: string) {
    await this.database.query('SELECT public.dispatch_discovery_attempt($1,$2,$3,$4)', [...fenced(job),id]);
  }
  async fail(job: DiscoveryJob, id: string, category: 'auth' | 'invalid_input' | 'unavailable', code: 'MODEL_AUTH' | 'MODEL_RATE_LIMITED' | 'MODEL_UNAVAILABLE' | 'PROVIDER_INVALID_DATA') {
    await this.database.query("SELECT public.finish_discovery_attempt($1,$2,$3,$4,'error',false,$5,$6)", [...fenced(job),id,category,code]);
  }
  async putEvidence(job: DiscoveryJob, id: string, attemptId: string | null, value: unknown, client: Queryable = this.database) {
    const data = NormalizedDiscoveryEvidenceSchema.parse(value);
    if (Buffer.byteLength(canonicalJson(data)) > job.input.request.budgets.outputBytes) throw new TypeError('Normalised evidence exceeds output budget');
    await client.query('SELECT public.put_discovery_evidence($1,$2,$3,$4,$5,$6,$7)',[
      ...fenced(job),id,attemptId,JSON.stringify(data),checksum(data),
    ]);
  }
  /** Completion and its accepted evidence are committed together; neither can be replayed alone. */
  async complete(job: DiscoveryJob, id: string, value: NormalizedDiscoveryEvidence, backoffSeconds = 30) {
    const data = NormalizedDiscoveryEvidenceSchema.parse(value);
    const error = 'error' in data ? data.error : undefined;
    const evidenceId = discoveryAttemptId(job.id, `evidence:${id}`,0);
    await this.database.transaction(async client => {
      await client.query('SELECT public.finish_discovery_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
        ...fenced(job),id,error ? 'error' : 'accepted', error?.retryable ?? false, error?.category ?? null,error?.code ?? null,backoffSeconds,
      ]);
      await this.putEvidence(job,evidenceId,id,data,client);
      if (data.kind === 'resolve' && !error && data.candidates.length > 0) {
        const resolutionId = discoveryAttemptId(job.id,`resolution:${data.anchorId}`,0);
        await client.query(`INSERT INTO public.discovery_anchor_resolutions(id,project_id,job_id,anchor_id,evidence_id,candidates)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[
          resolutionId,job.projectId,job.id,data.anchorId,evidenceId,JSON.stringify(data.candidates),
        ]);
        const existing = await client.query('SELECT evidence_id,candidates FROM public.discovery_anchor_resolutions WHERE id=$1 AND project_id=$2 AND job_id=$3', [resolutionId,job.projectId,job.id]);
        if (existing.rows[0]?.evidence_id !== evidenceId || canonicalJson(existing.rows[0]?.candidates) !== canonicalJson(data.candidates)) throw new Error('Resolution identity conflict');
      }
    });
    return evidenceId;
  }
  /** Entire paired scheduling batch is one fenced transaction, including derived task creation. */
  async schedule(job: DiscoveryJob, targets: ScheduledTarget[], transition: Transition) {
    await this.database.transaction(async client => {
      for (const target of targets) {
        const task = CreateTaskVersionRequestSchema.parse(target.task); const input = TargetInputSchema.parse(target.input);
        await client.query(`INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[task.id,job.projectId,task.catalogVersionId,JSON.stringify(task),checksum(task),job.createdAt]);
        const row = (await client.query('SELECT project_id,content,checksum FROM public.task_versions WHERE id=$1',[task.id])).rows[0];
        if (row?.project_id !== job.projectId || row.checksum !== checksum(task) || canonicalJson(row.content) !== canonicalJson(task)) throw new Error('Derived task checksum conflict');
        await client.query('SELECT public.schedule_discovery_target($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[
          ...fenced(job),target.attemptId,task.id,JSON.stringify(input),checksum(input),target.profileId,target.round,target.repeat,target.variant,
        ]);
      }
      await this.advance(job,transition,client);
    });
  }
  async saveCandidate(job: DiscoveryJob, id: string, value: unknown, transition: Transition) {
    const content = DiscoveryCandidateContentSchema.parse(value);
    if (Buffer.byteLength(canonicalJson(content)) > job.input.request.budgets.outputBytes) throw new TypeError('Candidate output budget exceeded');
    await this.database.transaction(async client => {
      await client.query('SELECT public.put_discovery_candidate($1,$2,$3,$4,$5,$6)',[...fenced(job),id,JSON.stringify(content),checksum(content)]);
      await this.advance(job,{...transition,candidateIds:[id]},client);
    });
  }
}
