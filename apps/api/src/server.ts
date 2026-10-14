import Fastify, { type FastifyRequest } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  SCHEMA_VERSION, IdSchema, checksum, canonicalJson, CreateProjectRequestSchema,
  CreateCatalogVersionRequestSchema, CreateTaskVersionRequestSchema, CreateMappingConfirmationRequestSchema,
  MintRunnerCredentialRequestSchema, RevokeRunnerCredentialRequestSchema, QueueAttemptRequestSchema,
  RunnerHandshakeRequestSchema, RunnerHandshakeResponseSchema, ClaimAttemptRequestSchema, ClaimAttemptResponseSchema,
  UploadTargetResultRequestSchema, UploadTargetResultResponseSchema, TargetInputSchema, validateComparisonRunnerBinding,
} from '@tastecase/contracts';
import { bearerToken, createSupabaseOwnerVerifier, type OwnerVerifier } from './auth.js';
import { HttpError, parseRequest, safeError } from './errors.js';
import { registerDiscoveryRoutes } from './discovery-routes.js';
import { registerReviewRoutes } from './review-routes.js';
import { registerComparisonRoutes } from './comparison-routes.js';
import { readPublicSample, sampleUnavailable, validatePublicSampleConfig, type PublicSampleConfig } from './public-sample.js';
import {
  transaction, CREDENTIAL_COLUMNS, projectRecord, catalogRecord, taskRecord, mappingRecord, credentialRecord,
  attemptRecord, type ProjectRow, type VersionRow, type MappingRow, type CredentialRow, type AttemptRow,
} from './db.js';

export interface ServerOptions {
  pool: Pool;
  auth: { supabaseUrl: string; supabaseAnonKey: string } | { testVerifier: OwnerVerifier };
  leaseDurationSeconds?: number;
  handlerTimeoutMs?: number;
  workerReady?: () => boolean;
  publicSample?: PublicSampleConfig;
}

const deadlineSignals = new WeakMap<FastifyRequest, AbortSignal>();
export function requestSignal(request: FastifyRequest): AbortSignal {
  const signal = deadlineSignals.get(request);
  if (!signal) throw new Error('Request deadline was not initialized.');
  return signal;
}

/** Injection seam is for tests only. Production main always constructs Supabase Auth. Pool remains caller-owned. */
export function buildServer(options: ServerOptions) {
  if ('testVerifier' in options.auth && process.env.NODE_ENV === 'production') throw new Error('Test authentication is forbidden in production.');
  const verifyOwner = 'testVerifier' in options.auth ? options.auth.testVerifier : createSupabaseOwnerVerifier(options.auth);
  const sampleConfig = options.publicSample === undefined ? undefined : validatePublicSampleConfig(options.publicSample);
  const leaseSeconds = options.leaseDurationSeconds ?? 300;
  const handlerTimeoutMs = options.handlerTimeoutMs ?? 15000;
  if (!Number.isInteger(handlerTimeoutMs) || handlerTimeoutMs < 10 || handlerTimeoutMs > 30000) throw new Error('Handler deadline must be between 10 and 30000 milliseconds.');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) throw new Error('Lease duration must be an integer between 30 and 900 seconds.');
  const app = Fastify({
    logger: false, bodyLimit: 1048576, requestTimeout: 15000, connectionTimeout: 10000,
    keepAliveTimeout: 5000, maxRequestsPerSocket: 100, routerOptions: { maxParamLength: 160 },
  });
  app.addHook('onRequest', async (request, reply) => {
    const controller = new AbortController();
    deadlineSignals.set(request, controller.signal);
    const timeout = setTimeout(() => {
      const error = new HttpError(503, 'internal_error', 'The request exceeded the time limit.');
      controller.abort(error);
      if (!reply.sent) void reply.code(503).send(safeError(error).body);
    }, handlerTimeoutMs);
    timeout.unref();
    const abort = () => controller.abort();
    const cleanup = () => {
      clearTimeout(timeout);
      request.raw.off('aborted', abort);
      reply.raw.off('close', closed);
    };
    const closed = () => {
      if (!reply.raw.writableEnded) abort();
      cleanup();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', closed);
    reply.raw.once('finish', cleanup);
  });
  app.setErrorHandler((error, _request, reply) => {
    const failure = safeError(error);
    void reply.code(failure.status).send(failure.body);
  });
  app.setNotFoundHandler((_request, reply) => {
    const failure = safeError(new HttpError(404, 'not_found', 'The resource was not found.'));
    void reply.code(failure.status).send(failure.body);
  });
  app.addHook('onSend', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/public/sample', async request => {
    if (Object.keys(request.query as object).length) throw new HttpError(400, 'invalid_request', 'The public sample does not accept selectors.');
    if (!sampleConfig) sampleUnavailable();
    try {
      return await transaction(options.pool, async client => {
        await client.query('SET TRANSACTION READ ONLY');
        return readPublicSample(client, sampleConfig);
      }, requestSignal(request), true);
    } catch { sampleUnavailable(); }
  });
  app.get('/ready', async (request, reply) => {
    try {
      if (options.workerReady && !options.workerReady()) throw new Error('Discovery worker unavailable.');
      // Readiness requires every exposed backend gate, not just a live database socket.
      await transaction(options.pool, async client => {
        await client.query("SET LOCAL statement_timeout='2s'");
        await client.query(`SELECT id FROM public.projects LIMIT 0;
          SELECT id FROM public.catalog_versions LIMIT 0; SELECT id FROM public.task_versions LIMIT 0;
          SELECT id FROM public.mapping_confirmations LIMIT 0; SELECT id FROM public.runner_credentials LIMIT 0;
          SELECT credential_id,first_verified_at,last_verified_at FROM public.runner_handshakes LIMIT 0;
          SELECT id FROM public.target_attempts LIMIT 0; SELECT attempt_id FROM public.target_attempt_mappings LIMIT 0;
          SELECT id FROM public.discovery_jobs LIMIT 0; SELECT job_id FROM public.discovery_job_state LIMIT 0;
          SELECT id FROM public.discovery_provider_attempts LIMIT 0; SELECT id FROM public.discovery_tool_evidence LIMIT 0;
          SELECT id FROM public.discovery_anchor_resolutions LIMIT 0; SELECT id FROM public.discovery_anchor_confirmations LIMIT 0;
          SELECT id FROM public.discovery_candidates LIMIT 0; SELECT attempt_id FROM public.discovery_job_targets LIMIT 0;
          SELECT lease_id FROM public.discovery_target_dispatches LIMIT 0;
          SELECT 'public.discovery_target_claimable(uuid)'::regprocedure;
          SELECT 'public.tastecase_close_discovery_dispatches()'::regprocedure;
          SELECT id FROM public.review_cases LIMIT 0; SELECT case_id FROM public.review_heads LIMIT 0;
          SELECT id FROM public.review_decisions LIMIT 0; SELECT id FROM public.expectation_versions LIMIT 0;
          SELECT id FROM public.suites LIMIT 0; SELECT id FROM public.suite_versions LIMIT 0;
          SELECT suite_version_id FROM public.suite_version_cases LIMIT 0;
          SELECT 'public.create_review_case(uuid,uuid,jsonb)'::regprocedure;
          SELECT 'public.record_review_decision(uuid,uuid,uuid,jsonb)'::regprocedure;
          SELECT 'public.create_suite(uuid,uuid,jsonb)'::regprocedure;
          SELECT 'public.publish_suite(uuid,uuid,jsonb)'::regprocedure;
          SELECT id FROM public.comparison_runs LIMIT 0; SELECT comparison_id FROM public.comparison_state LIMIT 0;
          SELECT comparison_id FROM public.comparison_cases LIMIT 0; SELECT attempt_id FROM public.comparison_targets LIMIT 0;
          SELECT lease_id FROM public.comparison_dispatches LIMIT 0; SELECT id FROM public.comparison_cancellations LIMIT 0;
          SELECT id FROM public.comparison_reports LIMIT 0; SELECT comparison_id FROM public.comparison_artifacts LIMIT 0;
          SELECT 'public.create_comparison(uuid,uuid,jsonb)'::regprocedure;
          SELECT 'public.get_comparison(uuid,uuid,uuid)'::regprocedure;
          SELECT 'public.list_comparisons(uuid,uuid,integer,integer)'::regprocedure;
          SELECT 'public.cancel_comparison(uuid,uuid,uuid,jsonb)'::regprocedure;
          SELECT 'public.comparison_target_claimable(uuid,text)'::regprocedure;
          SELECT 'public.reserve_comparison_dispatch(uuid,uuid,uuid,uuid,integer,text)'::regprocedure;
          SELECT 'public.finalize_comparison(uuid,uuid,uuid,jsonb)'::regprocedure;
          SELECT 'public.export_comparison_artifact(uuid,uuid,uuid,text)'::regprocedure`);
      }, requestSignal(request));
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  const pathId = (request: FastifyRequest, key: string) => parseRequest(IdSchema, (request.params as Record<string, unknown>)[key]);
  async function owner<T>(request: FastifyRequest, work: (client: PoolClient, ownerId: string) => Promise<T>, snapshot = false): Promise<T> {
    let verified: string | null;
    try { verified = await verifyOwner(bearerToken(request.headers.authorization)); } catch { verified = null; }
    const ownerId = IdSchema.safeParse(verified);
    if (!ownerId.success) throw new HttpError(401, 'unauthorized', 'Owner authentication is required.');
    return transaction(options.pool, client => work(client, ownerId.data), requestSignal(request), snapshot);
  }
  async function projectOwner<T>(request: FastifyRequest, work: (client: PoolClient, projectId: string, ownerId: string) => Promise<T>, snapshot = false): Promise<T> {
    return owner(request, async (client, ownerId) => {
      const projectId = pathId(request, 'projectId');
      const project = await client.query<ProjectRow>('SELECT * FROM public.projects WHERE id=$1 AND owner_id=$2', [projectId, ownerId]);
      if (!project.rows[0]) throw new HttpError(404, 'not_found', 'The project was not found.');
      return work(client, projectId, ownerId);
    }, snapshot);
  }
  async function catalog(client: PoolClient, projectId: string, id: string) {
    const result = await client.query<VersionRow>('SELECT * FROM public.catalog_versions WHERE project_id=$1 AND id=$2', [projectId, id]);
    if (!result.rows[0]) throw new HttpError(404, 'not_found', 'The catalog version was not found in this project.');
    return catalogRecord(result.rows[0]);
  }
  async function task(client: PoolClient, projectId: string, id: string) {
    const result = await client.query<VersionRow>('SELECT * FROM public.task_versions WHERE project_id=$1 AND id=$2', [projectId, id]);
    if (!result.rows[0]) throw new HttpError(404, 'not_found', 'The task version was not found in this project.');
    return taskRecord(result.rows[0]);
  }
  app.post('/projects', async (request, reply) => owner(request, async (client, ownerId) => {
    const body = parseRequest(CreateProjectRequestSchema, request.body);
    const result = await client.query<ProjectRow>('INSERT INTO public.projects(id,owner_id,schema_version,name) VALUES ($1,$2,$3,$4) RETURNING *', [randomUUID(), ownerId, SCHEMA_VERSION, body.name]);
    reply.code(201);
    return projectRecord(result.rows[0]);
  }));
  app.get('/projects', async request => owner(request, async (client, ownerId) => ({
    schema_version: SCHEMA_VERSION, projects: (await client.query<ProjectRow>('SELECT * FROM public.projects WHERE owner_id=$1 ORDER BY created_at,id', [ownerId])).rows.map(projectRecord),
  })));
  app.get('/projects/:projectId', async request => projectOwner(request, async (client, projectId, ownerId) =>
    projectRecord((await client.query<ProjectRow>('SELECT * FROM public.projects WHERE id=$1 AND owner_id=$2', [projectId, ownerId])).rows[0])));

  app.post('/projects/:projectId/catalogs', async (request, reply) => projectOwner(request, async (client, projectId) => {
    const body = parseRequest(CreateCatalogVersionRequestSchema, request.body);
    const hash = checksum(body);
    await client.query('INSERT INTO public.catalog_versions(id,project_id,schema_version,content,checksum) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [body.id, projectId, SCHEMA_VERSION, JSON.stringify(body), hash]);
    const result = await client.query<VersionRow>('SELECT * FROM public.catalog_versions WHERE project_id=$1 AND id=$2', [projectId, body.id]);
    if (!result.rows[0] || result.rows[0].checksum !== hash || canonicalJson(result.rows[0].content) !== canonicalJson(body)) throw new HttpError(409, 'conflict', 'The catalog ID already exists with different content.');
    reply.code(201);
    return catalogRecord(result.rows[0]);
  }));
  app.post('/projects/:projectId/tasks', async (request, reply) => projectOwner(request, async (client, projectId) => {
    const body = parseRequest(CreateTaskVersionRequestSchema, request.body);
    const pinnedCatalog = await catalog(client, projectId, body.catalogVersionId);
    const entryIds = new Set(pinnedCatalog.entries.map(entry => entry.id));
    if (body.constraints.excludedEntryIds.some(id => !entryIds.has(id))) throw new HttpError(400, 'invalid_request', 'Excluded entries must belong to the pinned catalog.');
    const hash = checksum(body);
    await client.query('INSERT INTO public.task_versions(id,project_id,catalog_version_id,schema_version,content,checksum) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [body.id, projectId, body.catalogVersionId, SCHEMA_VERSION, JSON.stringify(body), hash]);
    const result = await client.query<VersionRow>('SELECT * FROM public.task_versions WHERE project_id=$1 AND id=$2', [projectId, body.id]);
    if (!result.rows[0] || result.rows[0].checksum !== hash || canonicalJson(result.rows[0].content) !== canonicalJson(body)) throw new HttpError(409, 'conflict', 'The task ID already exists with different content.');
    reply.code(201);
    return taskRecord(result.rows[0]);
  }));
  app.post('/projects/:projectId/mappings', async (request, reply) => projectOwner(request, async (client, projectId, ownerId) => {
    const body = parseRequest(CreateMappingConfirmationRequestSchema, request.body);
    const pinnedCatalog = await catalog(client, projectId, body.catalogVersionId);
    if (!pinnedCatalog.entries.some(entry => entry.id === body.catalogEntryId)) throw new HttpError(404, 'not_found', 'The catalog entry was not found.');
    await client.query('INSERT INTO public.mapping_confirmations(id,project_id,catalog_version_id,catalog_entry_id,qloo_entity_id,confirmed_by,schema_version) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [body.id, projectId, body.catalogVersionId, body.catalogEntryId, body.qlooEntityId, ownerId, SCHEMA_VERSION]);
    const result = await client.query<MappingRow>('SELECT * FROM public.mapping_confirmations WHERE project_id=$1 AND id=$2', [projectId, body.id]);
    const row = result.rows[0];
    if (!row || row.catalog_version_id !== body.catalogVersionId || row.catalog_entry_id !== body.catalogEntryId || row.qloo_entity_id !== body.qlooEntityId || row.confirmed_by !== ownerId) throw new HttpError(409, 'conflict', 'An immutable mapping confirmation already exists.');
    reply.code(201);
    return mappingRecord(row);
  }));
  for (const definition of [
    { route: 'catalogs', table: 'catalog_versions', key: 'catalogVersionId', convert: catalogRecord },
    { route: 'tasks', table: 'task_versions', key: 'taskVersionId', convert: taskRecord },
  ] as const) {
    app.get(`/projects/:projectId/${definition.route}`, async request => projectOwner(request, async (client, projectId) => ({
      schema_version: SCHEMA_VERSION, [definition.route]: (await client.query<VersionRow>(`SELECT * FROM public.${definition.table} WHERE project_id=$1 ORDER BY created_at,id`, [projectId])).rows.map(row => definition.convert(row)),
    })));
    app.get(`/projects/:projectId/${definition.route}/:${definition.key}`, async request => projectOwner(request, async (client, projectId) => {
      const result = await client.query<VersionRow>(`SELECT * FROM public.${definition.table} WHERE project_id=$1 AND id=$2`, [projectId, pathId(request, definition.key)]);
      if (!result.rows[0]) throw new HttpError(404, 'not_found', 'The version was not found in this project.');
      return definition.convert(result.rows[0]);
    }));
  }
  app.get('/projects/:projectId/mappings', async request => projectOwner(request, async (client, projectId) => ({
    schema_version: SCHEMA_VERSION, mappings: (await client.query<MappingRow>('SELECT * FROM public.mapping_confirmations WHERE project_id=$1 ORDER BY created_at,id', [projectId])).rows.map(mappingRecord),
  })));
  app.get('/projects/:projectId/mappings/:mappingId', async request => projectOwner(request, async (client, projectId) => {
    const result = await client.query<MappingRow>('SELECT * FROM public.mapping_confirmations WHERE project_id=$1 AND id=$2', [projectId, pathId(request, 'mappingId')]);
    if (!result.rows[0]) throw new HttpError(404, 'not_found', 'The mapping was not found in this project.');
    return mappingRecord(result.rows[0]);
  }));

  app.post('/projects/:projectId/runner-credentials', async (request, reply) => projectOwner(request, async (client, projectId) => {
    const body = parseRequest(MintRunnerCredentialRequestSchema, request.body);
    const token = `tc_runner_${randomBytes(32).toString('base64url')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    const result = await client.query<CredentialRow>(`INSERT INTO public.runner_credentials(id,project_id,schema_version,label,token_hash) VALUES ($1,$2,$3,$4,$5) RETURNING ${CREDENTIAL_COLUMNS}`, [randomUUID(), projectId, SCHEMA_VERSION, body.label, hash]);
    reply.code(201);
    return { schema_version: SCHEMA_VERSION, credential: credentialRecord(result.rows[0]), token };
  }));
  app.get('/projects/:projectId/runner-credentials', async request => projectOwner(request, async (client, projectId) => ({
    schema_version: SCHEMA_VERSION, credentials: (await client.query<CredentialRow>(`SELECT ${CREDENTIAL_COLUMNS} FROM public.runner_credentials WHERE project_id=$1 ORDER BY created_at,id`, [projectId])).rows.map(credentialRecord),
  })));
  app.post('/projects/:projectId/runner-credentials/:credentialId/revoke', async request => projectOwner(request, async (client, projectId) => {
    parseRequest(RevokeRunnerCredentialRequestSchema, request.body);
    const result = await client.query<CredentialRow>(`UPDATE public.runner_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE project_id=$1 AND id=$2 RETURNING ${CREDENTIAL_COLUMNS}`, [projectId, pathId(request, 'credentialId')]);
    if (!result.rows[0]) throw new HttpError(404, 'not_found', 'The credential was not found in this project.');
    return credentialRecord(result.rows[0]);
  }));

  app.post('/projects/:projectId/attempts', async (request, reply) => projectOwner(request, async (client, projectId) => {
    const body = parseRequest(QueueAttemptRequestSchema, request.body);
    const pinnedCatalog = await catalog(client, projectId, body.catalogVersionId);
    const pinnedTask = await task(client, projectId, body.taskVersionId);
    if (pinnedTask.catalogVersionId !== pinnedCatalog.id) throw new HttpError(404, 'not_found', 'The task does not reference the pinned catalog.');
    const mappings = await client.query<MappingRow>('SELECT * FROM public.mapping_confirmations WHERE project_id=$1 AND catalog_version_id=$2 AND id=ANY($3::uuid[])', [projectId, pinnedCatalog.id, body.mappingConfirmationIds]);
    const byId = new Map(mappings.rows.map(row => [row.id, mappingRecord(row)]));
    if (byId.size !== body.mappingConfirmationIds.length) throw new HttpError(404, 'not_found', 'A mapping was not found in the pinned project catalog.');
    const input = parseRequest(TargetInputSchema, {
      schema_version: SCHEMA_VERSION, projectId, catalog: pinnedCatalog, task: pinnedTask,
      mappings: body.mappingConfirmationIds.map(id => byId.get(id)), eligibleCatalogEntryIds: body.eligibleCatalogEntryIds,
    });
    const hash = checksum(input);
    await client.query('INSERT INTO public.target_attempts(id,project_id,schema_version,catalog_version_id,task_version_id,pinned_input,input_checksum) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [body.id, projectId, SCHEMA_VERSION, pinnedCatalog.id, pinnedTask.id, JSON.stringify(input), hash]);
    const result = await client.query<AttemptRow>('SELECT * FROM public.target_attempts WHERE project_id=$1 AND id=$2', [projectId, body.id]);
    if (!result.rows[0] || result.rows[0].input_checksum !== hash || canonicalJson(result.rows[0].pinned_input) !== canonicalJson(input)) throw new HttpError(409, 'conflict', 'The attempt ID already exists with different pinned inputs.');
    reply.code(201);
    return attemptRecord(result.rows[0]);
  }));
  app.get('/projects/:projectId/attempts', async request => projectOwner(request, async (client, projectId) => ({
    schema_version: SCHEMA_VERSION, attempts: (await client.query<AttemptRow>('SELECT * FROM public.target_attempts WHERE project_id=$1 ORDER BY created_at,id', [projectId])).rows.map(attemptRecord),
  })));
  app.get('/projects/:projectId/attempts/:attemptId', async request => projectOwner(request, async (client, projectId) => {
    const result = await client.query<AttemptRow>('SELECT * FROM public.target_attempts WHERE project_id=$1 AND id=$2', [projectId, pathId(request, 'attemptId')]);
    if (!result.rows[0]) throw new HttpError(404, 'not_found', 'The attempt was not found in this project.');
    return attemptRecord(result.rows[0]);
  }));

  async function runner<T>(request: FastifyRequest, work: (client: PoolClient, credential: CredentialRow) => Promise<T>, claiming = false): Promise<T> {
    const token = bearerToken(request.headers.authorization);
    if (!/^tc_runner_[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'unauthorized', 'A valid runner credential is required.');
    const hash = createHash('sha256').update(token).digest('hex');
    return transaction(options.pool, async client => {
      // Credential precedes attempt/state locks. Claims take UPDATE immediately because
      // comparison reservation needs UPDATE; parallel SHARE upgrades would deadlock.
      const result = await client.query<CredentialRow>(`SELECT ${CREDENTIAL_COLUMNS} FROM public.runner_credentials WHERE token_hash=$1 FOR ${claiming ? 'UPDATE' : 'SHARE'}`, [hash]);
      const credential = result.rows[0];
      if (!credential) throw new HttpError(401, 'unauthorized', 'A valid runner credential is required.');
      if (credential.revoked_at) throw new HttpError(401, 'credential_revoked', 'The runner credential has been revoked.');
      return work(client, credential);
    }, requestSignal(request)).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && ['55P03', '57014', '40P01', '40001'].includes(String(error.code))) {
        throw new HttpError(503, 'internal_error', 'Runner work is temporarily busy.');
      }
      throw error;
    });
  }
  app.post('/runner/handshake', async request => runner(request, async (client, credential) => {
    parseRequest(RunnerHandshakeRequestSchema, request.body);
    const receipt = await client.query<{ last_verified_at: Date }>(`INSERT INTO public.runner_handshakes(credential_id,project_id)
      VALUES ($1,$2) ON CONFLICT (credential_id) DO UPDATE SET last_verified_at=clock_timestamp()
      RETURNING last_verified_at`, [credential.id, credential.project_id]);
    return RunnerHandshakeResponseSchema.parse({ schema_version: SCHEMA_VERSION, credentialId: credential.id, projectId: credential.project_id,
      leaseDurationSeconds: leaseSeconds, verifiedAt: receipt.rows[0].last_verified_at.toISOString() });
  }, true));
  app.post('/runner/claims', async (request, reply) => runner(request, async (client, credential) => {
    const body = parseRequest(ClaimAttemptRequestSchema, request.body);
    const found = await client.query<AttemptRow>("SELECT * FROM public.target_attempts WHERE project_id=$1 AND (status='queued' OR (status='leased' AND lease_expires_at<=clock_timestamp())) AND public.discovery_target_claimable(id) AND public.comparison_target_claimable(id,$2) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1", [credential.project_id, body.assistantVersion ?? null]);
    if (!found.rows[0]) {
      reply.code(204);
      return;
    }
    const selected = found.rows[0];
    const input = TargetInputSchema.safeParse(selected.pinned_input);
    if (!input.success || checksum(input.data) !== selected.input_checksum) throw new HttpError(409, 'conflict', 'The pinned work input is unavailable.');
    try { validateComparisonRunnerBinding(input.data, body.assistantVersion); }
    catch { throw new HttpError(409, 'conflict', 'The work does not match the explicit runner release binding.'); }
    const leaseId = randomUUID();
    const reserved = await client.query<{ value: boolean }>('SELECT public.reserve_comparison_dispatch($1,$2,$3,$4,$5,$6) AS value', [credential.project_id, selected.id, leaseId, credential.id, leaseSeconds, body.assistantVersion ?? null]);
    if (reserved.rows[0]?.value !== true) {
      reply.code(204);
      return;
    }
    // Comparisons already installed their charged lease. Ordinary discovery/foundation
    // inputs retain the legacy UPDATE and its discovery cancellation/budget backstop.
    const result = input.data.execution
      ? await client.query<AttemptRow>("SELECT * FROM public.target_attempts WHERE id=$1 AND project_id=$2 AND status='leased' AND lease_id=$3 AND lease_credential_id=$4 AND lease_expires_at>clock_timestamp()", [selected.id, credential.project_id, leaseId, credential.id])
      : await client.query<AttemptRow>("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+make_interval(secs=>$4) WHERE id=$1 AND project_id=$5 RETURNING *", [selected.id, leaseId, credential.id, leaseSeconds, credential.project_id]).catch((error: unknown) => {
      // The SQL backstop fences cancellation/deadline/budget races after claim selection.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23514') {
        throw new HttpError(409, 'conflict', 'Work was stopped before a lease could be issued.');
      }
      throw error;
    });
    if (!result.rows[0]) throw new HttpError(409, 'conflict', 'Work was stopped before a lease could be issued.');
    const record = attemptRecord(result.rows[0]);
    return ClaimAttemptResponseSchema.parse({ schema_version: SCHEMA_VERSION, attemptId: record.id, leaseId: record.leaseId, leaseExpiresAt: record.leaseExpiresAt, input: record.input });
  }, true));
  app.post('/runner/attempts/:attemptId/results', async request => runner(request, async (client, credential) => {
    const body = parseRequest(UploadTargetResultRequestSchema, request.body);
    const result = await client.query<AttemptRow>('SELECT * FROM public.target_attempts WHERE id=$1 AND project_id=$2 FOR UPDATE', [pathId(request, 'attemptId'), credential.project_id]);
    const row = result.rows[0];
    if (!row) throw new HttpError(404, 'not_found', 'The attempt was not found.');
    if (row.lease_id !== body.leaseId || row.lease_credential_id !== credential.id || row.status === 'queued') throw new HttpError(409, 'conflict', 'The upload does not match the current lease.');
    // Read database time after acquiring the row lock, not before a possible lock wait.
    const timing = await client.query<{ expired: boolean }>('SELECT $1::timestamptz<=clock_timestamp() AS expired', [row.lease_expires_at]);
    if (timing.rows[0].expired) throw new HttpError(409, 'lease_expired', 'The lease has expired.');
    const hash = checksum(body.result);
    const idempotent = row.status === 'completed';
    if (idempotent) {
      if (row.result_checksum !== hash || canonicalJson(row.result) !== canonicalJson(body.result)) throw new HttpError(409, 'conflict', 'The completed attempt has a different result.');
    } else {
      try {
        const updated = await client.query("UPDATE public.target_attempts SET status='completed',result=$3,result_checksum=$4,completed_at=clock_timestamp() WHERE id=$1 AND project_id=$2 AND lease_expires_at>clock_timestamp()", [row.id, credential.project_id, JSON.stringify(body.result), hash]);
        if (!updated.rowCount) throw new HttpError(409, 'lease_expired', 'The lease has expired.');
      } catch (error) {
        // At this point identity, result shape and the locked active credential are validated.
        // The DB lease guard can still catch expiry between our check and the UPDATE.
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23514') throw new HttpError(409, 'lease_expired', 'The lease has expired.');
        throw error;
      }
    }
    return UploadTargetResultResponseSchema.parse({ schema_version: SCHEMA_VERSION, attemptId: row.id, status: 'completed', resultChecksum: hash, idempotent });
  }));
  registerDiscoveryRoutes(app, { pathId, projectOwner });
  registerReviewRoutes(app, { pathId, projectOwner });
  registerComparisonRoutes(app, { pathId, projectOwner });
  return app;
}

export const createServer = buildServer;
