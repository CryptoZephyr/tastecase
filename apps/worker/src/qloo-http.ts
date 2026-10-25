import { setTimeout as delay } from 'node:timers/promises';
import { QlooWorkflowExecutionError, type QlooToolClient } from '@qloo/qloo-harness';
import { IdSchema, QlooTagSchema, type QlooHttpDiagnostics } from '@tastecase/contracts';
import { z } from 'zod';
import { boundedJson } from './decision.js';
import { QLOO_HOST } from './qloo.js';

type Query = Parameters<QlooToolClient['insights']>[0];
type RequestOptions = NonNullable<Parameters<QlooToolClient['insights']>[1]>;
type Endpoint = QlooHttpDiagnostics['requests'][number]['endpoint'];
type Operation = 'rank' | 'describe';
type Entity = z.infer<typeof entitySchema>;
const entitySchema = z.object({ entity_id: IdSchema, name: z.string().min(1) }).passthrough();
const entityListSchema = z.array(entitySchema).max(15);
const entitiesSchema = z.object({ results: z.union([entityListSchema, z.object({ entities: entityListSchema }).transform(value => value.entities)]) });
const maxBodyBytes = 5 * 1024 * 1024;
const cacheTtlMs = 15 * 60 * 1000;
/** Qloo support reported a 5 req/s hackathon limit; 250ms keeps one client below it. */
export const minimumDispatchGapMs = 250;

export function retryAfterSeconds(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (Number.isSafeInteger(seconds)) return seconds;
  // Only an HTTP date, never an arbitrary provider string, becomes durable metadata.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : null;
}

interface Call {
  operation: Operation; signal: AbortSignal; http: QlooHttpDiagnostics;
  entityTags: Map<string, z.infer<typeof QlooTagSchema>[]>;
  entityTagsRequested: boolean;
  pending: { ids: string[]; resolve: (entities: Entity[]) => void; reject: (error: unknown) => void }[];
}

function filteredTags(value: unknown): z.infer<typeof QlooTagSchema>[] {
  if (!Array.isArray(value)) return [];
  const tags: z.infer<typeof QlooTagSchema>[] = []; const names = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const parsed = QlooTagSchema.safeParse({ type: item.type, name: item.name });
    if (!parsed.success) continue;
    const name = parsed.data.name.toLowerCase();
    if (names.has(name)) continue;
    names.add(name); tags.push(parsed.data);
    if (tags.length === 12) break;
  }
  return tags;
}

/** A session-private transport for the official tools. No hidden retries or raw diagnostic logs. */
export class BoundedQlooClient implements QlooToolClient {
  readonly #key: string;
  private call: Call | undefined;
  private readonly cache = new Map<string, { entity: Entity; expires: number; bytes: number }>();
  private cacheBytes = 0;
  private recentEntityTags: { entityId: string; tags: z.infer<typeof QlooTagSchema>[] }[] = [];
  private nextDispatchAt = -Infinity;
  constructor(key: string, private readonly request: typeof fetch = fetch, private readonly now = Date.now,
    private readonly pause: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) => delay(ms, undefined, { signal })) {
    if (!key || /[\s\u0000-\u001f\u007f]/.test(key)) throw new TypeError('Qloo credential required');
    this.#key = key;
  }
  async run<T>(operation: Operation, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    if (this.call) throw new TypeError('Concurrent Qloo workflows are unsupported');
    const call: Call = { operation, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(55_000)]),
      http: { maxAttempts: 2, attempts: 0, cacheHits: 0, requests: [] }, entityTags: new Map(), entityTagsRequested: false, pending: [] };
    this.call = call;
    try {
      const result = await work(call.signal);
      const entityTags = call.entityTagsRequested
        ? [...call.entityTags].map(([entityId, tags]) => ({ entityId, tags }))
        : operation === 'rank' ? this.recentEntityTags : [];
      if (call.entityTagsRequested) this.recentEntityTags = entityTags;
      return { result, http: call.http, entityTags };
    }
    finally { this.call = undefined; }
  }
  private failure(code: 'QLOO_AUTH' | 'QLOO_RATE_LIMIT' | 'QLOO_UPSTREAM' | 'QLOO_CONNECT' | 'QLOO_TIMEOUT' | 'QLOO_CONTRACT' | 'CANCELLED', retryable = false) {
    return new QlooWorkflowExecutionError(this.call?.operation ?? 'rank', { kind: 'direct', name: 'Bounded Qloo HTTP' },
      'Qloo request unavailable.', undefined, { code, layer: 'qloo', expected: true, retryable,
        recovery: 'Inspect the safe HTTP receipt before authorizing another bounded attempt.' });
  }
  private active() {
    if (!this.call) throw new TypeError('Qloo workflow context required');
    this.call.signal.throwIfAborted();
    return this.call;
  }
  private async get(endpoint: Endpoint, query: Query, options: RequestOptions = {}) {
    const call = this.active();
    options.signal?.throwIfAborted();
    if (call.http.attempts >= call.http.maxAttempts) throw this.failure('QLOO_CONTRACT');
    // Reserve a slot synchronously so overlapping dispatches stay spaced. Waiting is uncharged.
    const at = Math.max(this.now(), this.nextDispatchAt); this.nextDispatchAt = at + minimumDispatchGapMs;
    const wait = at - this.now();
    if (wait > 0) {
      try { await this.pause(wait, AbortSignal.any([call.signal, ...(options.signal ? [options.signal] : [])])); }
      catch { throw this.failure(call.signal.aborted || options.signal?.aborted ? 'CANCELLED' : 'QLOO_TIMEOUT'); }
    }
    if (call.http.attempts >= call.http.maxAttempts) throw this.failure('QLOO_CONTRACT');
    const url = new URL(endpoint, QLOO_HOST);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value));
    }
    const receipt: QlooHttpDiagnostics['requests'][number] = { endpoint, status: null, retryAfterSeconds: null };
    call.http.requests.push(receipt); call.http.attempts++;
    const signal = AbortSignal.any([call.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(20_000)]);
    let response: Response;
    try { response = await this.request(url, { method: 'GET', headers: { Accept: 'application/json', 'X-Api-Key': this.#key }, redirect: 'error', signal }); }
    catch {
      throw this.failure(call.signal.aborted || options.signal?.aborted ? 'CANCELLED' : signal.aborted ? 'QLOO_TIMEOUT' : 'QLOO_CONNECT');
    }
    receipt.status = response.status;
    receipt.retryAfterSeconds = retryAfterSeconds(response.headers.get('retry-after'), this.now());
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {});
      const code = response.status === 401 || response.status === 403 ? 'QLOO_AUTH' : response.status === 429 ? 'QLOO_RATE_LIMIT'
        : response.status >= 500 ? 'QLOO_UPSTREAM' : 'QLOO_CONTRACT';
      // Rate limits always stop. A provider-requested wait must never be shortened by worker backoff.
      throw this.failure(code, code === 'QLOO_UPSTREAM' && !response.headers.has('retry-after'));
    }
    try {
      const body = z.record(z.string(), z.unknown()).parse(await boundedJson(response, maxBodyBytes));
      if (JSON.stringify(body).includes(this.#key)) throw new TypeError('Unsafe Qloo output');
      return body;
    } catch { throw this.failure('QLOO_CONTRACT'); }
  }
  insights(query: Query, options?: RequestOptions) {
    const call = this.active();
    return this.get('/v2/insights', call.operation === 'rank' ? { ...query, 'feature.explainability': true } : query, options);
  }
  searchEntities(query: Query, options?: RequestOptions) { return this.get('/search', query, options); }
  tags(): Promise<never> { return Promise.reject(this.failure('QLOO_CONTRACT')); }
  compare(): Promise<never> { return Promise.reject(this.failure('QLOO_CONTRACT')); }
  trending(): Promise<never> { return Promise.reject(this.failure('QLOO_CONTRACT')); }

  async entities(entityIds: readonly string[], options: RequestOptions = {}) {
    const call = this.active(); options.signal?.throwIfAborted();
    call.entityTagsRequested = true;
    const ids = [...new Set(entityIds.map(id => IdSchema.parse(id)))];
    if (!ids.length || ids.length > 15) throw this.failure('QLOO_CONTRACT');
    const entities: Entity[] = []; const missing: string[] = [];
    for (const id of ids) {
      const entry = this.cache.get(id);
      if (entry && entry.expires > this.now()) { entities.push(structuredClone(entry.entity)); call.http.cacheHits++; }
      else { if (entry) { this.cache.delete(id); this.cacheBytes -= entry.bytes; } missing.push(id); }
    }
    if (missing.length) {
      entities.push(...await new Promise<Entity[]>((resolve, reject) => {
        call.pending.push({ ids: missing, resolve, reject });
        if (call.pending.length === 1) queueMicrotask(() => { void this.flush(call); });
      }));
    }
    for (const entity of entities) call.entityTags.set(entity.entity_id, filteredTags(entity.tags));
    return { results: { entities } };
  }
  private async flush(call: Call) {
    const pending = call.pending.splice(0);
    try {
      const ids = [...new Set(pending.flatMap(item => item.ids))];
      if (ids.length > 15) throw this.failure('QLOO_CONTRACT');
      const body = entitiesSchema.parse(await this.get('/entities', { entity_ids: ids }));
      const entities = body.results;
      if (new Set(entities.map(entity => entity.entity_id)).size !== entities.length || entities.some(entity => !ids.includes(entity.entity_id))) throw this.failure('QLOO_CONTRACT');
      for (const entity of entities) {
        const bytes = Buffer.byteLength(JSON.stringify(entity));
        const old = this.cache.get(entity.entity_id);
        if (old) { this.cache.delete(entity.entity_id); this.cacheBytes -= old.bytes; }
        while (this.cache.size >= 256 || this.cacheBytes + bytes > maxBodyBytes) {
          const first = this.cache.keys().next().value;
          if (first === undefined) break;
          const entry = this.cache.get(first)!; this.cacheBytes -= entry.bytes; this.cache.delete(first);
        }
        this.cache.set(entity.entity_id, { entity: structuredClone(entity), expires: this.now() + cacheTtlMs, bytes }); this.cacheBytes += bytes;
      }
      for (const item of pending) item.resolve(structuredClone(entities.filter(entity => item.ids.includes(entity.entity_id))));
    } catch (error) {
      const safe = error instanceof QlooWorkflowExecutionError ? error : this.failure('QLOO_CONTRACT');
      for (const item of pending) item.reject(safe);
    }
  }
}
