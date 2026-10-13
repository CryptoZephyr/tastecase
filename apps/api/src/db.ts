import type { Pool, PoolClient } from 'pg';
import {
  AttemptSchema, CatalogVersionSchema, TaskVersionSchema, MappingConfirmationSchema, ProjectSchema,
  RunnerCredentialSchema, TargetInputSchema, type Attempt,
} from '@tastecase/contracts';

/** Credential locks always precede attempt locks, including upload retries.
 * Snapshot reads use repeatable read without granting row-lock/update permissions. */
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>, signal?: AbortSignal, snapshot = false): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    signal?.throwIfAborted();
    await client.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'; SET LOCAL idle_in_transaction_session_timeout = '10s'");
    const value = await work(client);
    // Do not start COMMIT for a request that has already timed out or disconnected.
    signal?.throwIfAborted();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

interface BaseRow { id: string; schema_version: string; created_at: Date }
export interface ProjectRow extends BaseRow { owner_id: string; name: string }
export interface VersionRow extends BaseRow { project_id: string; content: Record<string, unknown>; checksum: string }
export interface MappingRow extends BaseRow {
  project_id: string; catalog_version_id: string; catalog_entry_id: string; qloo_entity_id: string; confirmed_by: string;
}
export interface CredentialRow extends BaseRow { project_id: string; label: string; revoked_at: Date | null }
export interface AttemptRow extends BaseRow {
  project_id: string; catalog_version_id: string; task_version_id: string; pinned_input: unknown;
  input_checksum: string; status: Attempt['status']; lease_id: string | null; lease_credential_id: string | null;
  lease_expires_at: Date | null; result: unknown; result_checksum: string | null; completed_at: Date | null;
}

export const CREDENTIAL_COLUMNS = 'id, schema_version, project_id, label, created_at, revoked_at';
export const projectRecord = (row: ProjectRow) => ProjectSchema.parse({ schema_version: row.schema_version, id: row.id, ownerId: row.owner_id, name: row.name, createdAt: row.created_at.toISOString() });
export const catalogRecord = (row: VersionRow) => CatalogVersionSchema.parse({ ...row.content, projectId: row.project_id, checksum: row.checksum, createdAt: row.created_at.toISOString() });
export const taskRecord = (row: VersionRow) => TaskVersionSchema.parse({ ...row.content, projectId: row.project_id, checksum: row.checksum, createdAt: row.created_at.toISOString() });
export const mappingRecord = (row: MappingRow) => MappingConfirmationSchema.parse({ schema_version: row.schema_version, id: row.id, projectId: row.project_id, catalogVersionId: row.catalog_version_id, catalogEntryId: row.catalog_entry_id, qlooEntityId: row.qloo_entity_id, confirmedBy: row.confirmed_by, createdAt: row.created_at.toISOString() });
export const credentialRecord = (row: CredentialRow) => RunnerCredentialSchema.parse({ schema_version: row.schema_version, id: row.id, projectId: row.project_id, label: row.label, createdAt: row.created_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null });
export function attemptRecord(row: AttemptRow): Attempt {
  const input = TargetInputSchema.parse(row.pinned_input);
  return AttemptSchema.parse({
    schema_version: row.schema_version, id: row.id, projectId: row.project_id,
    catalogVersionId: row.catalog_version_id, taskVersionId: row.task_version_id,
    mappingConfirmationIds: input.mappings.map(mapping => mapping.id), status: row.status, input,
    inputChecksum: row.input_checksum, leaseId: row.lease_id, leaseCredentialId: row.lease_credential_id,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null, result: row.result,
    resultChecksum: row.result_checksum, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
  });
}
