import { z } from 'zod';
import { join } from 'node:path';
import {
  IdSchema, QlooStatusSchema, RankingEvidenceSchema, ResolutionEvidenceSchema,
  NormalizedQlooErrorSchema, PublicAnchorSchema,
  QlooHttpDiagnosticsSchema,
} from '@tastecase/contracts';
import type { PublicAnchor, RankRequest, ProviderContext, QlooAdapter } from './types.js';
import { UnknownDispatch } from './types.js';

export const QLOO_HOST = 'https://hackathon.api.qloo.com';
export function childEnvironment(key: string, home: string, inherited: readonly string[]): Record<string,string> {
  if (!key || !home) throw new TypeError('Qloo configuration required');
  return { ...Object.fromEntries(inherited.map(name => [name,''])),
    PATH:process.execPath.substring(0,process.execPath.lastIndexOf('/')),HOME:home,QLOO_HOME:join(home,'.qloo'),
    QLOO_API_KEY:key,QLOO_BASE_URL:QLOO_HOST,QLOO_TRUSTED_BASE_URL:QLOO_HOST,
  };
}
const kindType = { music: 'artist', film: 'movie', brand: 'brand' } as const;
const metadata = z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).optional(), additionalProperties: z.literal(false) }).passthrough();
const field = z.object({ type: z.string(), enum: z.array(z.string()).optional(), minItems: z.number().optional(), maxItems: z.number().optional(), minLength: z.number().optional(), items: z.unknown().optional() }).passthrough();
const toolSchema = z.object({ name: z.string(), inputSchema: z.unknown(), outputSchema: z.unknown() }).passthrough();

/** Check the actual live declarations before any allowed workflow dispatch. */
export function validateTools(value: unknown) {
  const tools = z.object({ tools: z.array(toolSchema).max(50) }).parse(value).tools;
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new TypeError('Duplicate MCP tools');
  for (const name of ['qloo_describe','qloo_rank']) {
    const tool = tools.find(tool => tool.name === name);
    if (!tool) throw new TypeError('Required MCP tool unavailable');
    const schema = metadata.parse(tool.inputSchema);
    const allowed = name === 'qloo_rank' ? ['options','option_type','signals'] : ['entity','type'];
    if (schema.required?.some(key => !allowed.includes(key))) throw new TypeError('Incompatible required tool parameters');
    for (const key of allowed) {
      const declaration = field.parse(schema.properties[key]);
      if (key === 'options' || key === 'signals') {
        if (declaration.type !== 'array' || declaration.minItems !== 1 || declaration.maxItems !== 10 || field.parse(declaration.items).type !== 'string') throw new TypeError('Incompatible MCP entity array');
      } else if (declaration.type !== 'string' || (key === 'option_type' && !declaration.enum?.includes('place'))
        || (key === 'type' && !Object.values(kindType).every(type => declaration.enum?.includes(type)))) throw new TypeError('Incompatible MCP entity type');
    }
    const output = z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), required: z.array(z.string()) }).passthrough().parse(tool.outputSchema);
    if (!['schema_version','operation','status','execution'].every(key => output.required.includes(key))) throw new TypeError('Incompatible MCP result requirements');
    const status = z.object({ anyOf: z.array(z.object({ const: z.string() }).passthrough()) }).parse(output.properties.status);
    const statuses = status.anyOf.map(value => value.const);
    if (statuses.length !== 6 || new Set(statuses).size !== 6 || !QlooStatusSchema.options.every(value => statuses.includes(value))) throw new TypeError('Incompatible MCP statuses');
  }
}

const envelopeSchema = z.object({
  schema_version: z.literal('1.0-preview.1'), operation: z.enum(['rank','describe']), status: QlooStatusSchema,
  results: z.array(z.unknown()).max(10).optional(), result_count: z.number().int().nonnegative().optional(),
  error: z.strictObject({ code: z.string(), layer: z.string(), retryable: z.boolean(), recovery: z.string() }).optional(),
  execution: z.strictObject({ transport: z.literal('mcp'), transport_name: z.string(), correlation_id: z.string(), duration_ms: z.number().finite().nonnegative() }),
  resolution: z.object({ issues: z.array(z.unknown()).max(10).optional() }).passthrough().optional(),
  http: QlooHttpDiagnosticsSchema.optional(),
}).passthrough();
const rankedEntity = z.object({ entity_id: IdSchema, name: z.string().min(1).max(160), type: z.string().optional() }).passthrough();
const candidateEntity = z.object({ id: IdSchema, name: z.string().trim().min(1).max(160), type: z.string() }).passthrough();
const transientCodes = new Set(['QLOO_DNS','QLOO_CONNECT','QLOO_TIMEOUT','QLOO_RATE_LIMIT','QLOO_UPSTREAM']);
const safeCodes = new Set([...transientCodes,'QLOO_AUTH','QLOO_CONTRACT','QLOO_TLS','CANCELLED','HARNESS_INTERNAL','MCP_ADAPTER_FAILURE','RESOLVER_CONFIGURATION','RESOLVER_UNAVAILABLE']);
function normalizedError(error: z.infer<typeof envelopeSchema>['error']) {
  if (!error) return undefined;
  const code = safeCodes.has(error.code) ? error.code : 'QLOO_UNAVAILABLE';
  const category = code === 'QLOO_AUTH' ? 'auth' : transientCodes.has(code) ? 'transient' : code === 'QLOO_CONTRACT' ? 'invalid_input' : 'unavailable';
  return NormalizedQlooErrorSchema.parse({ code,category,retryable: error.retryable && category === 'transient' });
}
export function parseEnvelope(value: unknown, operation: 'rank' | 'describe', outputBytes: number) {
  if (Buffer.byteLength(JSON.stringify(value)) > outputBytes) throw new TypeError('MCP result exceeds output budget');
  const envelope = envelopeSchema.parse(value);
  if (envelope.operation !== operation) throw new TypeError('MCP operation mismatch');
  if (envelope.result_count !== undefined && envelope.result_count !== (envelope.results?.length ?? 0)) throw new TypeError('MCP result count mismatch');
  if ((['ok','partial'].includes(envelope.status) && envelope.results === undefined)
    || (['empty','needs_input','error'].includes(envelope.status) && envelope.results?.length)
    || (envelope.status === 'error' && !envelope.error)
    || (envelope.status !== 'error' && envelope.error)) throw new TypeError('Malformed MCP status payload');
  return envelope;
}

export function normalizeRank(value: unknown, request: RankRequest, outputBytes: number) {
  const envelope = parseEnvelope(value,'rank',outputBytes);
  const entities = (envelope.results ?? []).map(value => rankedEntity.parse(value));
  const entityToEntry = new Map(request.options.map(option => [option.entityId.toLowerCase(), option.entryId]));
  if (entityToEntry.size !== request.options.length) throw new TypeError('Ambiguous duplicate mapped entities');
  const orderedEntryIds = entities.map(entity => {
    const entry = entityToEntry.get(entity.entity_id);
    if (entry === undefined) throw new TypeError('Outside ranked entity');
    if (entity.type && !['place','urn:entity:place','urn:entity'].includes(entity.type)) throw new TypeError('Rank returned non-place');
    return entry;
  });
  const error = normalizedError(envelope.error);
  return RankingEvidenceSchema.parse({ kind: 'rank',providerStatus: envelope.status,
    profileId: request.profileId,scope: request.scope,requestedEntryIds: request.options.map(option => option.entryId),orderedEntryIds,
    missingEntryIds: request.options.filter(option => !orderedEntryIds.includes(option.entryId)).map(option => option.entryId),
    unmappedEntryIds: request.unmappedEntryIds,mappingConfirmationIds: request.options.map(option => option.confirmationId),
    anchorConfirmationIds: request.anchors.map(anchor => anchor.confirmationId),...(error ? {error} : {}),...(envelope.http ? {http:envelope.http} : {}),
  });
}

export function normalizeResolution(value: unknown, anchor: PublicAnchor, outputBytes: number) {
  const envelope = parseEnvelope(value,'describe',outputBytes);
  const candidates: { entityId: string; name: string; kind: PublicAnchor['kind'] }[] = [];
  const type = kindType[anchor.kind];
  const append = (entityId: string, name: string, returnedType: string | undefined) => {
    if (returnedType !== undefined && returnedType !== 'urn:entity' && returnedType !== type && returnedType !== `urn:entity:${type}`) throw new TypeError('Resolution kind mismatch');
    candidates.push({entityId,name,kind:anchor.kind});
  };
  if (envelope.status === 'needs_input') {
    if (!envelope.resolution?.issues) throw new TypeError('Missing resolution issues');
    for (const value of envelope.resolution.issues) {
      const issue = z.object({ input: z.literal(anchor.label), field: z.literal('entity'), input_kind: z.literal('entity'),
        candidates: z.array(candidateEntity).max(10).optional(), kind: z.enum(['ambiguous','not_found','unsupported']) }).passthrough().parse(value);
      for (const candidate of issue.candidates ?? []) append(candidate.id,candidate.name,candidate.type);
    }
  } else if (['ok','partial'].includes(envelope.status)) {
    for (const value of envelope.results ?? []) { const entity = rankedEntity.parse(value); append(entity.entity_id,entity.name,entity.type); }
  }
  const error = normalizedError(envelope.error);
  return ResolutionEvidenceSchema.parse({ kind:'resolve',providerStatus:envelope.status,anchorId:anchor.id,candidates,...(error ? {error} : {}),...(envelope.http ? {http:envelope.http} : {}) });
}

export interface McpSession {
  listTools(signal: AbortSignal): Promise<unknown>;
  callTool(name: 'qloo_describe' | 'qloo_rank', args: Record<string, unknown>, context: ProviderContext): Promise<unknown>;
  close(): Promise<void>;
}
export type SessionFactory = (context: ProviderContext) => Promise<McpSession>;

/** The model never supplies tool names/arguments. Only pinned public inputs reach this allowlist. */
export class OfficialQlooAdapter implements QlooAdapter {
  private session: McpSession | undefined;
  constructor(private readonly factory: SessionFactory = async context => (await import('./stdio.js')).openOfficialSession(context)) {}
  private async getSession(context: ProviderContext) {
    if (!this.session) {
      const session = await this.factory(context); this.session = session;
      try { validateTools(await session.listTools(context.signal)); }
      catch { await this.close(); throw new TypeError('Official MCP schema unavailable or incompatible'); }
    }
    return this.session;
  }
  async resolve(anchor: PublicAnchor, context: ProviderContext) {
    const parsed = PublicAnchorSchema.parse(anchor); context.signal.throwIfAborted();
    const session = await this.getSession(context);
    const raw = await session.callTool('qloo_describe',{entity:parsed.label,type:kindType[parsed.kind]},context).catch(()=>{ throw new UnknownDispatch(); });
    return normalizeResolution(raw,parsed,context.outputBytes);
  }
  async rank(request: RankRequest, context: ProviderContext) {
    context.signal.throwIfAborted();
    const ids = request.options.map(option => IdSchema.parse(option.entityId));
    const signals = request.anchors.map(anchor => IdSchema.parse(anchor.entityId));
    if (ids.length < 1 || ids.length > 10 || signals.length < 1 || signals.length > 5
      || new Set(ids).size !== ids.length || new Set(signals).size !== signals.length) throw new TypeError('Unsupported ranking inputs');
    const session = await this.getSession(context);
    const raw = await session.callTool('qloo_rank',{options:ids,option_type:'place',signals},context).catch(()=>{ throw new UnknownDispatch(); });
    return normalizeRank(raw,request,context.outputBytes);
  }
  async close() { const session = this.session; this.session = undefined; await session?.close(); }
}
