import { z } from 'zod';
import { checksum } from './canonical.js';
export { canonicalJson, checksum, type JsonValue } from './canonical.js';

export const SCHEMA_VERSION = '1.0.0' as const;
export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);
export const IdSchema = z.uuid().toLowerCase();
export const ChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected lowercase SHA-256 hex');
export const TimestampSchema = z.iso.datetime({ offset: true });
const label = z.string().trim().min(1).max(160);
const text = z.string().trim().min(1).max(8000);
export const CatalogEntryIdSchema = z.string().trim().min(1).max(160);
const entryIds = z.array(CatalogEntryIdSchema).max(500).refine(ids => new Set(ids).size === ids.length, 'Duplicate catalog entry IDs');
const recordIds = z.array(IdSchema).max(500).refine(ids => new Set(ids).size === ids.length, 'Duplicate record IDs');
const labels = z.array(label).max(100).refine(values => new Set(values).size === values.length, 'Duplicate values');
const money = z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: z.number().int().nonnegative().safe() });

export const CreateProjectRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema, name: label });
export const ProjectSchema = CreateProjectRequestSchema.extend({ id: IdSchema, ownerId: IdSchema, createdAt: TimestampSchema });
export const ProjectListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, projects: z.array(ProjectSchema) });

/** Optional facts are unknown when absent, never an invented negative or positive. */
export const RestaurantMetadataSchema = z.strictObject({
  address: text.optional(), city: label.optional(), countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  cuisines: labels.optional(), description: text.optional(),
});
export const ConstraintFactsSchema = z.strictObject({
  dietaryOptions: labels.optional(), accessibilityFeatures: labels.optional(),
  maxPartySize: z.number().int().positive().max(10000).optional(),
  typicalPerPersonSpend: money.optional(), reservationRequired: z.boolean().optional(),
});
export const CatalogEntrySchema = z.strictObject({
  id: CatalogEntryIdSchema, name: label, metadata: RestaurantMetadataSchema.optional(),
  constraintFacts: ConstraintFactsSchema.optional(), qlooEntityId: IdSchema.optional(),
});
export const CreateCatalogVersionRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, label,
  entries: z.array(CatalogEntrySchema).min(1).max(500).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate catalog entry IDs'),
});
export const CatalogVersionSchema = CreateCatalogVersionRequestSchema.extend({ projectId: IdSchema, checksum: ChecksumSchema, createdAt: TimestampSchema })
  .refine(row => row.checksum === checksum(CreateCatalogVersionRequestSchema.parse(rowPayload(row))), 'Catalog checksum does not match content');

export const SyntheticTextSchema = z.strictObject({ provenance: z.literal('synthetic'), label, text });
export const PracticalConstraintsSchema = z.strictObject({
  partySize: z.number().int().positive().max(10000),
  location: z.strictObject({ city: label, countryCode: z.string().regex(/^[A-Z]{2}$/).optional() }).optional(),
  budgetPerPerson: money.optional(), dietaryRequirements: labels,
  accessibilityRequirements: labels, requiredCuisines: labels, excludedEntryIds: entryIds,
});
export const CreateTaskVersionRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, label, catalogVersionId: IdSchema,
  syntheticBrief: SyntheticTextSchema, syntheticInterests: z.array(SyntheticTextSchema).max(100),
  constraints: PracticalConstraintsSchema,
});
export const TaskVersionSchema = CreateTaskVersionRequestSchema.extend({ projectId: IdSchema, checksum: ChecksumSchema, createdAt: TimestampSchema })
  .refine(row => row.checksum === checksum(CreateTaskVersionRequestSchema.parse(rowPayload(row))), 'Task checksum does not match content');

// Version checksum payloads exclude server-owned provenance fields only.
function rowPayload(row: { projectId: string; checksum: string; createdAt: string; [key: string]: unknown }) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !['projectId', 'checksum', 'createdAt'].includes(key)));
}

/** Candidate Qloo IDs on entries are not confirmations. This owner action creates an immutable mapping. */
export const CreateMappingConfirmationRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, catalogVersionId: IdSchema,
  catalogEntryId: CatalogEntryIdSchema, qlooEntityId: IdSchema,
});
export const MappingConfirmationSchema = CreateMappingConfirmationRequestSchema.extend({
  projectId: IdSchema, confirmedBy: IdSchema, createdAt: TimestampSchema,
});

/** Fully resolved immutable input. Only API-resolved, same-project versions/mappings are accepted. */
export const TargetInputSchema = z.strictObject({
  schema_version: SchemaVersionSchema, projectId: IdSchema, catalog: CatalogVersionSchema,
  task: TaskVersionSchema, mappings: z.array(MappingConfirmationSchema).max(500), eligibleCatalogEntryIds: entryIds,
}).superRefine((input, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (input.catalog.projectId !== input.projectId) issue(['catalog', 'projectId'], 'Catalog belongs to another project');
  if (input.task.projectId !== input.projectId) issue(['task', 'projectId'], 'Task belongs to another project');
  if (input.task.catalogVersionId !== input.catalog.id) issue(['task', 'catalogVersionId'], 'Task catalog is not pinned catalog');
  const entries = new Set(input.catalog.entries.map(entry => entry.id));
  const excluded = new Set(input.task.constraints.excludedEntryIds);
  input.task.constraints.excludedEntryIds.forEach((id, index) => {
    if (!entries.has(id)) issue(['task', 'constraints', 'excludedEntryIds', index], 'Excluded entry is not in pinned catalog');
  });
  input.eligibleCatalogEntryIds.forEach((id, index) => {
    if (!entries.has(id) || excluded.has(id)) issue(['eligibleCatalogEntryIds', index], 'Eligible entry must be in pinned catalog and not excluded');
  });
  const mappingIds = new Set<string>();
  const mappingEntries = new Set<string>();
  input.mappings.forEach((mapping, index) => {
    if (mapping.projectId !== input.projectId || mapping.catalogVersionId !== input.catalog.id || !entries.has(mapping.catalogEntryId)) {
      issue(['mappings', index], 'Mapping must reference this project and pinned catalog entry');
    }
    if (mappingIds.has(mapping.id) || mappingEntries.has(mapping.catalogEntryId)) issue(['mappings', index], 'Duplicate mapping or entry confirmation');
    mappingIds.add(mapping.id);
    mappingEntries.add(mapping.catalogEntryId);
  });
});
export const QueueAttemptRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, catalogVersionId: IdSchema,
  taskVersionId: IdSchema, mappingConfirmationIds: recordIds, eligibleCatalogEntryIds: entryIds,
});

/** Trace is metadata only: no headers, request bodies, tool arguments, credentials or arbitrary blobs. */
export const TraceEventSchema = z.strictObject({
  kind: z.enum(['target_started', 'target_completed', 'tool_call', 'tool_result']),
  name: label.optional(), timestamp: TimestampSchema.optional(),
  durationMs: z.number().int().nonnegative().max(86400000).optional(),
  status: z.enum(['ok', 'error', 'unavailable']).optional(),
  catalogEntryIds: entryIds.optional(), qlooEntityIds: recordIds.optional(),
});
export const NormalizedTraceSchema = z.strictObject({
  completeness: z.enum(['complete', 'partial', 'unavailable']), events: z.array(TraceEventSchema).max(1000),
}).refine(trace => trace.completeness !== 'unavailable' || trace.events.length === 0, 'Unavailable trace cannot contain events');
export const TargetRecommendationSchema = z.strictObject({
  // Unknown/outside IDs are retained for later objective evaluation; never filter by eligibility here.
  catalogEntryId: CatalogEntryIdSchema.optional(), name: label, reason: text.optional(),
});
export const TargetOutputSchema = z.strictObject({ recommendations: z.array(TargetRecommendationSchema).max(500), text: text.optional() });
const targetError = z.strictObject({ code: label, message: text });
export const TargetResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ schema_version: SchemaVersionSchema, outcome: z.literal('success'), output: TargetOutputSchema, trace: NormalizedTraceSchema }),
  z.strictObject({ schema_version: SchemaVersionSchema, outcome: z.literal('malformed_output'), rawText: z.string().max(64000), error: targetError, trace: NormalizedTraceSchema }),
  z.strictObject({ schema_version: SchemaVersionSchema, outcome: z.literal('provider_unavailable'), error: targetError, retryable: z.boolean(), trace: NormalizedTraceSchema }),
]);
export type TargetInput = z.infer<typeof TargetInputSchema>;
export type TargetResult = z.infer<typeof TargetResultSchema>;
export interface TargetAdapter {
  readonly name: string;
  readonly version: string;
  /** Provider credentials/configuration remain on the local machine, never in TargetInput or trace. */
  run(input: TargetInput, context: { signal: AbortSignal }): Promise<TargetResult>;
}
export type Adapter = TargetAdapter;

export const RunnerCredentialSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema, label,
  createdAt: TimestampSchema, revokedAt: TimestampSchema.nullable(),
});
export const MintRunnerCredentialRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema, label });
export const MintRunnerCredentialResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema, credential: RunnerCredentialSchema,
  // 32 random bytes encoded as base64url. Only the SHA-256 of the full token is persisted.
  token: z.string().regex(/^tc_runner_[A-Za-z0-9_-]{43}$/),
});
export const RunnerCredentialListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, credentials: z.array(RunnerCredentialSchema) });
export const RevokeRunnerCredentialRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema });
export const RunnerHandshakeRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  runner: z.strictObject({ name: label, version: label }), adapter: z.strictObject({ name: label, version: label }),
  supportedSchemaVersions: z.array(SchemaVersionSchema).length(1),
});
export const RunnerHandshakeResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema, credentialId: IdSchema, projectId: IdSchema,
  leaseDurationSeconds: z.number().int().min(30).max(900),
});
export const ClaimAttemptRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema });
export const ClaimAttemptResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema, attemptId: IdSchema, leaseId: IdSchema, leaseExpiresAt: TimestampSchema, input: TargetInputSchema,
});
export const UploadTargetResultRequestSchema = z.strictObject({ schema_version: SchemaVersionSchema, leaseId: IdSchema, result: TargetResultSchema });
export const UploadTargetResultResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema, attemptId: IdSchema, status: z.literal('completed'), resultChecksum: ChecksumSchema, idempotent: z.boolean(),
});
export const AttemptSchema = z.strictObject({
  schema_version: SchemaVersionSchema, id: IdSchema, projectId: IdSchema,
  catalogVersionId: IdSchema, taskVersionId: IdSchema, mappingConfirmationIds: recordIds,
  status: z.enum(['queued', 'leased', 'completed']), input: TargetInputSchema, inputChecksum: ChecksumSchema,
  leaseId: IdSchema.nullable(), leaseCredentialId: IdSchema.nullable(), leaseExpiresAt: TimestampSchema.nullable(),
  result: TargetResultSchema.nullable(), resultChecksum: ChecksumSchema.nullable(),
  createdAt: TimestampSchema, completedAt: TimestampSchema.nullable(),
}).superRefine((row, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (row.input.projectId !== row.projectId || row.input.catalog.id !== row.catalogVersionId || row.input.task.id !== row.taskVersionId) issue('Attempt input references do not match pinned versions');
  if (checksum(row.input) !== row.inputChecksum) issue('Input checksum does not match pinned input');
  if (JSON.stringify([...row.mappingConfirmationIds].sort()) !== JSON.stringify(row.input.mappings.map(mapping => mapping.id).sort())) issue('Attempt mappings do not match pinned input');
  if (row.status === 'queued' && (row.leaseId !== null || row.leaseCredentialId !== null || row.leaseExpiresAt !== null)) issue('Queued attempt cannot have a lease');
  if (row.status !== 'queued' && (row.leaseId === null || row.leaseCredentialId === null || row.leaseExpiresAt === null)) issue('Leased/completed attempt requires a lease');
  if (row.status === 'completed') {
    if (row.result === null || row.resultChecksum === null || row.completedAt === null) issue('Completed attempt requires a result');
    else if (checksum(row.result) !== row.resultChecksum) issue('Result checksum does not match result');
  } else if (row.result !== null || row.resultChecksum !== null || row.completedAt !== null) issue('Unfinished attempt cannot have a result');
});
export const CatalogVersionListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, catalogs: z.array(CatalogVersionSchema) });
export const TaskVersionListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, tasks: z.array(TaskVersionSchema) });
export const MappingConfirmationListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, mappings: z.array(MappingConfirmationSchema) });
export const AttemptListResponseSchema = z.strictObject({ schema_version: SchemaVersionSchema, attempts: z.array(AttemptSchema) });
export const ApiErrorSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  error: z.strictObject({
    code: z.enum(['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'lease_expired', 'credential_revoked', 'internal_error']),
    message: text, issues: z.array(z.strictObject({ path: z.array(z.union([z.string(), z.number().int()])), message: text })).optional(),
  }),
});

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type CatalogVersion = z.infer<typeof CatalogVersionSchema>;
export type CreateCatalogVersionRequest = z.infer<typeof CreateCatalogVersionRequestSchema>;
export type PracticalConstraints = z.infer<typeof PracticalConstraintsSchema>;
export type SyntheticText = z.infer<typeof SyntheticTextSchema>;
export type TaskVersion = z.infer<typeof TaskVersionSchema>;
export type CreateTaskVersionRequest = z.infer<typeof CreateTaskVersionRequestSchema>;
export type MappingConfirmation = z.infer<typeof MappingConfirmationSchema>;
export type CreateMappingConfirmationRequest = z.infer<typeof CreateMappingConfirmationRequestSchema>;
export type QueueAttemptRequest = z.infer<typeof QueueAttemptRequestSchema>;
export type NormalizedTrace = z.infer<typeof NormalizedTraceSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type TargetOutput = z.infer<typeof TargetOutputSchema>;
export type TargetRecommendation = z.infer<typeof TargetRecommendationSchema>;
export type RunnerCredential = z.infer<typeof RunnerCredentialSchema>;
export type MintRunnerCredentialRequest = z.infer<typeof MintRunnerCredentialRequestSchema>;
export type MintRunnerCredentialResponse = z.infer<typeof MintRunnerCredentialResponseSchema>;
export type RunnerHandshakeRequest = z.infer<typeof RunnerHandshakeRequestSchema>;
export type RunnerHandshakeResponse = z.infer<typeof RunnerHandshakeResponseSchema>;
export type ClaimAttemptRequest = z.infer<typeof ClaimAttemptRequestSchema>;
export type ClaimAttemptResponse = z.infer<typeof ClaimAttemptResponseSchema>;
export type UploadTargetResultRequest = z.infer<typeof UploadTargetResultRequestSchema>;
export type UploadTargetResultResponse = z.infer<typeof UploadTargetResultResponseSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

export { REST_CONTRACTS } from './rest.js';
