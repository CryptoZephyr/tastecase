import type { TasteCaseApi } from './port';
import { fail, fromApiError, ok, type ApiResult } from './result';
import type { ApiError, ListWindow } from './types';
import { boundedText, matchHttpRoute, PROXY_PREFIX, requestLimit, RESPONSE_LIMIT, successStatus } from './http-routes';
import { responses, validList, validResponse } from './response';

export interface HttpAuth {
  auth: TasteCaseApi['auth'];
  authorization(): Promise<ApiResult<{ token: string; ownerId: string }>>;
  epoch(): number;
  invalidate(): void;
}
const versionBody = { schema_version: '1.0.0' };
const path = (projectId: string, suffix = '') => `/projects/${encodeURIComponent(projectId)}${suffix}`;
const segment = (value: string) => encodeURIComponent(value);
function page(window?: ListWindow): string {
  const query = new URLSearchParams();
  if (window?.limit !== undefined) query.set('limit', String(window.limit));
  if (window?.offset !== undefined) query.set('offset', String(window.offset));
  return query.size ? `?${query}` : '';
}

/** No hidden retries, automatic mutation IDs, cached records or filtered partial arrays. */
export function createHttpApi(driver: HttpAuth, fetcher: typeof fetch = (...args) => fetch(...args)): TasteCaseApi {
  async function call<T>(method: 'GET' | 'POST', route: string, kind: keyof typeof responses | 'text', body?: unknown, envelope?: string): Promise<ApiResult<T>> {
    const template = matchHttpRoute(method, route.split('?')[0]);
    if (!template) return fail({ kind: 'invalid_request', message: 'The resource identifier is invalid.' });
    const publicRoute = template === '/public/sample';
    const epoch = driver.epoch();
    const authorization = publicRoute ? null : await driver.authorization();
    if (authorization && !authorization.ok) return authorization;
    if (!publicRoute && epoch !== driver.epoch()) return fail({ kind: 'unauthorized' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > requestLimit(template)) return fail({ kind: 'too_large' });
      const response = await fetcher(`${PROXY_PREFIX}${route}`, { method, body: serialized, headers: { accept: kind === 'text' ? 'text/plain' : 'application/json', ...(authorization?.ok ? { authorization: `Bearer ${authorization.data.token}` } : {}), ...(serialized === undefined ? {} : { 'content-type': 'application/json' }) }, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
      const text = await boundedText(response.body, kind === 'text' ? 2 * 1024 * 1024 : RESPONSE_LIMIT, controller.signal);
      if (!publicRoute && epoch !== driver.epoch()) return fail({ kind: 'unauthorized' });
      let data: unknown;
      try { data = kind === 'text' && response.ok ? text : JSON.parse(text); } catch { data = null; }
      if (!response.ok) {
        const error = fromApiError(response.status, validResponse('error', data) ? data as ApiError : null);
        if (!publicRoute && error.kind === 'unauthorized') driver.invalidate();
        return fail(error);
      }
      if (response.status !== successStatus(method, template)) return fail({ kind: 'internal', message: 'The backend returned an unexpected receipt status.' });
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith(kind === 'text' ? 'text/plain' : 'application/json') || (kind !== 'text' && !(envelope ? validList(kind, envelope, data) : validResponse(kind, data)))) return fail({ kind: 'internal', message: 'The backend response is incomplete or invalid.' });
      // Structural validators only inspect; the original payload, IDs and artifact bytes are preserved.
      return ok((envelope ? (data as Record<string, unknown>)[envelope] : data) as T);
    } catch { return fail({ kind: 'network', message: 'The outcome is unknown. Retry the unchanged request with the same ID.' }); }
    finally { clearTimeout(timer); }
  }
  return {
    transport: 'http', auth: driver.auth,
    sample: { getPublicSample: () => call('GET', '/public/sample', 'sample') },
    projects: { list: () => call('GET', '/projects', 'project', undefined, 'projects'), get: p => call('GET', path(p), 'project'), create: body => call('POST', '/projects', 'project', body) },
    catalogs: { list: p => call('GET', path(p, '/catalogs'), 'catalog', undefined, 'catalogs'), get: (p, id) => call('GET', path(p, `/catalogs/${segment(id)}`), 'catalog'), create: (p, body) => call('POST', path(p, '/catalogs'), 'catalog', body) },
    tasks: { list: p => call('GET', path(p, '/tasks'), 'task', undefined, 'tasks'), get: (p, id) => call('GET', path(p, `/tasks/${segment(id)}`), 'task'), create: (p, body) => call('POST', path(p, '/tasks'), 'task', body) },
    mappings: { get: (p, id) => call('GET', path(p, `/mappings/${segment(id)}`), 'mapping'), list: p => call('GET', path(p, '/mappings'), 'mapping', undefined, 'mappings'), create: (p, body) => call('POST', path(p, '/mappings'), 'mapping', body) },
    runnerCredentials: { list: p => call('GET', path(p, '/runner-credentials'), 'credential', undefined, 'credentials'), mint: (p, label) => call('POST', path(p, '/runner-credentials'), 'mint', { ...versionBody, label }), revoke: (p, id) => call('POST', path(p, `/runner-credentials/${segment(id)}/revoke`), 'credential', versionBody) },
    attempts: { list: p => call('GET', path(p, '/attempts'), 'attempt', undefined, 'attempts'), queue: (p, body) => call('POST', path(p, '/attempts'), 'attempt', body), get: (p, id) => call('GET', path(p, `/attempts/${segment(id)}`), 'attempt') },
    discovery: {
      list: (p, window) => call('GET', path(p, `/discovery-jobs${page(window)}`), 'job', undefined, 'jobs'), get: (p, id) => call('GET', path(p, `/discovery-jobs/${segment(id)}`), 'detail'), create: (p, body) => call('POST', path(p, '/discovery-jobs'), 'job', body), cancel: (p, id) => call('POST', path(p, `/discovery-jobs/${segment(id)}/cancel`), 'job', versionBody),
      confirmAnchor: (p, id, body) => call('POST', path(p, `/discovery-jobs/${segment(id)}/confirmations`), 'confirmation', body), getEvidence: (p, id, evidence) => call('GET', path(p, `/discovery-jobs/${segment(id)}/evidence/${segment(evidence)}`), 'evidence'), getCandidate: (p, id, candidate) => call('GET', path(p, `/discovery-jobs/${segment(id)}/candidates/${segment(candidate)}`), 'candidate'),
    },
    cases: { list: (p, window) => call('GET', path(p, `/cases${page(window)}`), 'case', undefined, 'cases'), get: (p, id) => call('GET', path(p, `/cases/${segment(id)}`), 'case'), create: (p, body) => call('POST', path(p, '/cases'), 'case', body), review: (p, id, body) => call('POST', path(p, `/cases/${segment(id)}/reviews`), 'review', body), history: (p, id, window) => call('GET', path(p, `/cases/${segment(id)}/reviews${page(window)}`), 'reviewRecord', undefined, 'reviews') },
    suites: { list: (p, window) => call('GET', path(p, `/suites${page(window)}`), 'suite', undefined, 'suites'), get: (p, id) => call('GET', path(p, `/suites/${segment(id)}`), 'suite'), create: (p, body) => call('POST', path(p, '/suites'), 'suite', body), publish: (p, id, body) => call('POST', path(p, `/suites/${segment(id)}/versions`), 'publish', body), versions: (p, id, window) => call('GET', path(p, `/suites/${segment(id)}/versions${page(window)}`), 'suiteVersion', undefined, 'versions'), version: (p, id, version) => call('GET', path(p, `/suites/${segment(id)}/versions/${segment(version)}`), 'suiteVersion') },
    comparisons: { list: (p, window) => call('GET', path(p, `/comparisons${page(window)}`), 'comparison', undefined, 'comparisons'), get: (p, id) => call('GET', path(p, `/comparisons/${segment(id)}`), 'comparisonDetail'), create: (p, body) => call('POST', path(p, '/comparisons'), 'comparisonCreate', body), cancel: (p, id, body) => call('POST', path(p, `/comparisons/${segment(id)}/cancel`), 'comparisonCreate', body), finalize: (p, id, body) => call('POST', path(p, `/comparisons/${segment(id)}/finalize`), 'finalize', body), pack: (p, id) => call('GET', path(p, `/comparisons/${segment(id)}/pack`), 'pack'), report: (p, id) => call('GET', path(p, `/comparisons/${segment(id)}/report`), 'report'), readableReport: (p, id) => call('GET', path(p, `/comparisons/${segment(id)}/report.txt`), 'text') },
  };
}
