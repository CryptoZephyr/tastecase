import * as contracts from '@tastecase/contracts';
import { boundedText, matchHttpRoute, PROXY_PREFIX, requestLimit, RESPONSE_LIMIT, windowQuery } from './http-routes';

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const failure = (status: number, code: string, message: string) => Response.json({ schema_version: '1.0.0', error: { code, message } }, { status, headers });

/** Exactly one server-configured origin. No path, userinfo, fragments or insecure remote HTTP. */
export function backendOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:', 'http:'].includes(url.protocol)) return null;
    if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

/** Never forwards cookies, backend locations, arbitrary headers, or auto-retries mutations.
 * 20 seconds bounds inbound reads, fetch and outbound reads; failures have safe fixed messages. */
export async function proxyRequest(request: Request, originValue: string | undefined, fetcher: typeof fetch = fetch, deadlineMs = 20000): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${PROXY_PREFIX}/`)) return failure(404, 'not_found', 'The resource was not found.');
  const path = url.pathname.slice(PROXY_PREFIX.length);
  const template = matchHttpRoute(request.method, path);
  if (!template) return failure(404, 'not_found', 'The resource was not found.');
  const normalize = (value: string) => value.replace(/:[A-Za-z]+/g, ':id');
  const contract = contracts.REST_CONTRACTS.find(row => row.auth !== 'runner' && row.method === request.method && normalize(row.path) === normalize(template));
  if (!contract) return failure(404, 'not_found', 'The resource was not found.');
  const origin = backendOrigin(originValue);
  if (!origin) return failure(503, 'internal_error', 'The TasteCase backend is not configured.');
  const publicRoute = template === '/public/sample';
  if ((request.headers.get('origin') && request.headers.get('origin') !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return failure(403, 'forbidden', 'Same-origin requests are required.');
  for (const key of url.searchParams.keys()) {
    if (request.method !== 'GET' || !windowQuery(template) || !['limit', 'offset'].includes(key) || url.searchParams.getAll(key).length !== 1) return failure(400, 'invalid_request', 'Invalid query window.');
    const value = url.searchParams.get(key)!;
    if ((key === 'limit' && (!/^[1-9][0-9]?$/.test(value) || Number(value) > 20)) || (key === 'offset' && (!/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > 10000))) return failure(400, 'invalid_request', 'Invalid query window.');
  }
  const authorization = request.headers.get('authorization');
  if (!publicRoute && (!authorization || authorization.length > 16384 || !/^Bearer [A-Za-z0-9._-]+$/.test(authorization) || authorization.startsWith('Bearer tc_runner_'))) return failure(401, 'unauthorized', 'Owner authentication is required.');
  if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return failure(415, 'invalid_request', 'JSON is required.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) controller.abort();
  let dispatched = false;
  try {
    const body = request.method === 'POST' ? await boundedText(request.body, requestLimit(template), controller.signal) : undefined;
    if (body !== undefined) {
      try { JSON.parse(body); } catch { return failure(400, 'invalid_request', 'A valid JSON body is required.'); }
    }
    dispatched = true;
    const upstream = await fetcher(`${origin}${path}${url.search}`, {
      method: request.method, headers: { accept: template.endsWith('/report.txt') ? 'text/plain' : 'application/json', ...(publicRoute ? {} : { authorization: authorization! }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body, cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) return failure(502, 'internal_error', 'The backend returned an invalid response.');
    const text = await boundedText(upstream.body, RESPONSE_LIMIT, controller.signal);
    if (upstream.ok) {
      const type = upstream.headers.get('content-type') ?? '';
      const readable = template.endsWith('/report.txt');
      if (upstream.status !== contract.status || !type.startsWith(readable ? 'text/plain' : 'application/json')) return failure(502, 'internal_error', 'The backend returned an invalid response.');
      try {
        const validator = (contracts as unknown as Record<string, { safeParse(value: unknown): { success: boolean } }>)[contract.response];
        if (!validator?.safeParse(readable ? text : JSON.parse(text)).success) return failure(502, 'internal_error', 'The backend returned incomplete or invalid evidence.');
      } catch { return failure(502, 'internal_error', 'The backend returned incomplete or invalid evidence.'); }
      return new Response(text, { status: upstream.status, headers: { ...headers, 'content-type': readable ? 'text/plain; charset=utf-8' : 'application/json' } });
    }
    // Backend errors are safe typed envelopes. Never echo untyped gateway/provider bodies.
    let code = 'internal_error';
    try {
      const data = JSON.parse(text);
      if (['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'lease_expired', 'credential_revoked', 'internal_error'].includes(data?.error?.code)) code = data.error.code;
    } catch { /* fixed fallback */ }
    const messages: Record<string, string> = { invalid_request: 'The request is invalid.', unauthorized: 'Owner authentication is required.', forbidden: 'Access is denied.', not_found: 'The resource was not found.', conflict: 'The request conflicts with saved state.', lease_expired: 'The lease expired.', credential_revoked: 'The credential was revoked.', internal_error: publicRoute ? 'Recorded public sample is unavailable.' : 'The backend could not confirm the request.' };
    return failure(upstream.status, code, messages[code]);
  } catch (error) {
    if (error instanceof RangeError) return failure(dispatched ? 502 : 413, dispatched ? 'internal_error' : 'invalid_request', dispatched ? 'The backend outcome could not be confirmed.' : 'The request exceeded the size limit.');
    return failure(503, 'internal_error', 'The backend outcome could not be confirmed. Retry unchanged requests with the same ID.');
  } finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); }
}
