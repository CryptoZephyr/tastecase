import { describe, expect, it, vi } from 'vitest';
import { REST_CONTRACTS } from '@tastecase/contracts';
import type { TasteCaseApi } from './port';
import { createHttpApi, type HttpAuth } from './http';
import { HTTP_ROUTES, PROXY_PREFIX } from './http-routes';
import { proxyRequest, backendOrigin } from './proxy';
import { ok } from './result';
import { fixtureApi } from '@/test/fixture-api';
import * as fx from '@/test/fixtures';
const p = fx.ids.project, id = fx.ids.case;
const post = { schema_version: '1.0.0', id, rationale: 'Synthetic request' };
const window = { limit: 20, offset: 20 };
const tail = '?limit=20&offset=20';
const fixture = fixtureApi({ finalized: true });
const driver = (): HttpAuth => ({ auth: fixture.auth, authorization: vi.fn(async () => ok({ token: 'synthetic.owner.token', ownerId: fx.ids.owner })), epoch: () => 0, invalidate: vi.fn() });
type Row = [keyof TasteCaseApi, string, unknown[], string, string, string?];
const rows: Row[] = [
  ['sample', 'getPublicSample', [], 'GET', '/public/sample'],
  ['projects', 'list', [], 'GET', '/projects', 'projects'], ['projects', 'get', [p], 'GET', `/projects/${p}`], ['projects', 'create', [post], 'POST', '/projects'],
  ...(['catalogs', 'tasks'] as const).flatMap(group => [
    [group, 'list', [p], 'GET', `/projects/${p}/${group}`, group], [group, 'get', [p, id], 'GET', `/projects/${p}/${group}/${id}`], [group, 'create', [p, post], 'POST', `/projects/${p}/${group}`],
  ] as Row[]),
  ['mappings', 'list', [p], 'GET', `/projects/${p}/mappings`, 'mappings'], ['mappings', 'get', [p, id], 'GET', `/projects/${p}/mappings/${id}`], ['mappings', 'create', [p, post], 'POST', `/projects/${p}/mappings`],
  ['runnerCredentials', 'list', [p], 'GET', `/projects/${p}/runner-credentials`, 'credentials'], ['runnerCredentials', 'mint', [p, 'Synthetic runner'], 'POST', `/projects/${p}/runner-credentials`], ['runnerCredentials', 'revoke', [p, id], 'POST', `/projects/${p}/runner-credentials/${id}/revoke`],
  ['attempts', 'list', [p], 'GET', `/projects/${p}/attempts`, 'attempts'], ['attempts', 'get', [p, fx.attempts[0].id], 'GET', `/projects/${p}/attempts/${fx.attempts[0].id}`], ['attempts', 'queue', [p, post], 'POST', `/projects/${p}/attempts`],
  ['discovery', 'list', [p, window], 'GET', `/projects/${p}/discovery-jobs${tail}`, 'jobs'], ['discovery', 'get', [p, id], 'GET', `/projects/${p}/discovery-jobs/${id}`], ['discovery', 'create', [p, post], 'POST', `/projects/${p}/discovery-jobs`], ['discovery', 'cancel', [p, id], 'POST', `/projects/${p}/discovery-jobs/${id}/cancel`], ['discovery', 'confirmAnchor', [p, id, post], 'POST', `/projects/${p}/discovery-jobs/${id}/confirmations`], ['discovery', 'getEvidence', [p, id, id], 'GET', `/projects/${p}/discovery-jobs/${id}/evidence/${id}`], ['discovery', 'getCandidate', [p, id, id], 'GET', `/projects/${p}/discovery-jobs/${id}/candidates/${id}`],
  ['cases', 'list', [p, window], 'GET', `/projects/${p}/cases${tail}`, 'cases'], ['cases', 'get', [p, id], 'GET', `/projects/${p}/cases/${id}`], ['cases', 'create', [p, post], 'POST', `/projects/${p}/cases`], ['cases', 'review', [p, id, post], 'POST', `/projects/${p}/cases/${id}/reviews`], ['cases', 'history', [p, id, window], 'GET', `/projects/${p}/cases/${id}/reviews${tail}`, 'reviews'],
  ['suites', 'list', [p, window], 'GET', `/projects/${p}/suites${tail}`, 'suites'], ['suites', 'get', [p, id], 'GET', `/projects/${p}/suites/${id}`], ['suites', 'create', [p, post], 'POST', `/projects/${p}/suites`], ['suites', 'publish', [p, id, post], 'POST', `/projects/${p}/suites/${id}/versions`], ['suites', 'versions', [p, id, window], 'GET', `/projects/${p}/suites/${id}/versions${tail}`, 'versions'], ['suites', 'version', [p, id, id], 'GET', `/projects/${p}/suites/${id}/versions/${id}`],
  ['comparisons', 'list', [p, window], 'GET', `/projects/${p}/comparisons${tail}`, 'comparisons'], ['comparisons', 'get', [p, id], 'GET', `/projects/${p}/comparisons/${id}`], ['comparisons', 'create', [p, post], 'POST', `/projects/${p}/comparisons`], ['comparisons', 'cancel', [p, id, post], 'POST', `/projects/${p}/comparisons/${id}/cancel`], ['comparisons', 'finalize', [p, id, post], 'POST', `/projects/${p}/comparisons/${id}/finalize`], ['comparisons', 'pack', [p, id], 'GET', `/projects/${p}/comparisons/${id}/pack`], ['comparisons', 'report', [p, id], 'GET', `/projects/${p}/comparisons/${id}/report`], ['comparisons', 'readableReport', [p, id], 'GET', `/projects/${p}/comparisons/${id}/report.txt`],
];
type Callable = Record<string, (...args: unknown[]) => Promise<{ ok: boolean; data?: unknown }>>;
function invoke(api: TasteCaseApi, row: Row) { return (api[row[0]] as Callable)[row[1]](...row[2]); }
const normalize = (path: string) => path.replace(/:[A-Za-z]+/g, ':id');
describe('complete owner/public transport', () => {
  it('mirrors every REST route except runner routes', () => { expect(HTTP_ROUTES.map(([verb, path, status]) => `${verb} ${normalize(path)} ${status}`).sort()).toEqual(REST_CONTRACTS.filter(row => row.auth !== 'runner').map(row => `${row.method} ${normalize(row.path)} ${row.status}`).sort()); });
  it.each(rows)('%s.%s uses its exact route and envelope', async (group, name, args, method, route, envelope) => {
    const row: Row = [group, name, args, method, route, envelope];
    const expected = await invoke(fixture, row); expect(expected.ok).toBe(true);
    const body = envelope ? { schema_version: '1.0.0', [envelope]: expected.data } : expected.data;
    const status = method === 'GET' || route.endsWith('/cancel') || route.endsWith('/revoke') ? 200 : 201;
    const fetcher = vi.fn(async () => typeof body === 'string' ? new Response(body, { status, headers: { 'content-type': 'text/plain' } }) : Response.json(body, { status }));
    const auth = driver();
    const api = createHttpApi(auth, fetcher);
    const result = await invoke(api, row);
    expect(result, `${group}.${name}`).toEqual(expected);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${PROXY_PREFIX}${route}`); expect(options.method).toBe(method);
    expect(options).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' });
    const headers = new Headers(options.headers);
    expect(headers.get('authorization')).toBe(group === 'sample' ? null : 'Bearer synthetic.owner.token');
    expect(auth.authorization).toHaveBeenCalledTimes(group === 'sample' ? 0 : 1);
    if (args.includes(post)) expect(options.body).toBe(JSON.stringify(post));
    if (name === 'mint') expect(options.body).toBe(JSON.stringify({ schema_version: '1.0.0', label: 'Synthetic runner' }));
  });
  it.each(['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'lease_expired', 'credential_revoked', 'internal_error'])('preserves error vocabulary %s', async code => {
    const status = ({ invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, lease_expired: 409, credential_revoked: 401, internal_error: 500 })[code]!;
    const auth = driver(); const api = createHttpApi(auth, async () => Response.json({ schema_version: '1.0.0', error: { code, message: 'Safe synthetic error' } }, { status }));
    const result = await api.projects.list(); expect(result).toMatchObject({ ok: false, error: { kind: code === 'internal_error' ? 'internal' : code, status } });
    if (code === 'unauthorized') expect(auth.invalidate).toHaveBeenCalledOnce();
  });
  it.each([{}, { schema_version: '1.0.0', projects: [fx.project, {}] }, { schema_version: '1.0.0', projects: null }])('does not filter malformed arrays or fabricate empty success', async body => { const api = createHttpApi(driver(), async () => Response.json(body)); expect(await api.projects.list()).toMatchObject({ ok: false, error: { kind: 'internal' } }); });
  it('preserves an exact mutation ID/body across unknown network outcomes', async () => { const fetcher = vi.fn(async () => { throw new Error('offline'); }); const api = createHttpApi(driver(), fetcher); const body = { schema_version: '1.0.0' as const, id, expectedRevision: 3, action: 'accept' as const, rationale: 'Synthetic rationale' }; await api.cases.review(p, id, body); await api.cases.review(p, id, body); expect(fetcher.mock.calls.map(call => (call as unknown as [string, RequestInit])[1].body)).toEqual([JSON.stringify(body), JSON.stringify(body)]); });
  it('drops in-flight data when ownership changes', async () => { let epoch = 0; const auth = { ...driver(), epoch: () => epoch }; const api = createHttpApi(auth, async () => { epoch++; return Response.json({ schema_version: '1.0.0', projects: [fx.project] }); }); expect(await api.projects.list()).toMatchObject({ ok: false, error: { kind: 'unauthorized' } }); });
  it('accepts the public projection with private fields genuinely omitted', async () => {
    const result = await fixture.sample.getPublicSample(); if (!result.ok) throw new Error('fixture failed');
    const publicSample = structuredClone({ ...result.data, caseResponse: fx.approvedCase });
    for (const row of publicSample.attempts) {
      for (const key of ['leaseId', 'leaseCredentialId', 'leaseExpiresAt']) Reflect.deleteProperty(row, key);
      row.input.mappings.forEach(mapping => Reflect.deleteProperty(mapping, 'confirmedBy'));
      if (row.result) for (const key of ['rawText', 'error']) Reflect.deleteProperty(row.result, key);
    }
    for (const key of ['leaseId', 'leaseExpiresAt', 'reason']) Reflect.deleteProperty(publicSample.job.job, key);
    Reflect.deleteProperty(publicSample.job.job.checkpointData, 'reservedProviderAttemptIds');
    publicSample.job.job.input.targetInput.mappings.forEach(mapping => Reflect.deleteProperty(mapping, 'confirmedBy'));
    publicSample.job.confirmations.forEach(row => Reflect.deleteProperty(row, 'confirmedBy'));
    publicSample.job.evidence.forEach(row => Reflect.deleteProperty(row.data, 'error'));
    for (const key of ['reviewedBy', 'evidence', 'requestChecksum']) Reflect.deleteProperty(publicSample.caseResponse.currentReview!.decision, key);
    const auth = driver(); const api = createHttpApi(auth, async () => Response.json(publicSample));
    expect(await api.sample.getPublicSample()).toEqual(ok(publicSample)); expect(auth.authorization).not.toHaveBeenCalled();
  });
  it('sample is unavailable on 503 without touching auth', async () => { const auth = driver(); const api = createHttpApi(auth, async () => Response.json({}, { status: 503 })); expect(await api.sample.getPublicSample()).toMatchObject({ ok: false, error: { kind: 'busy' } }); expect(auth.authorization).not.toHaveBeenCalled(); });
});
const req = (path = '/projects', options: RequestInit = {}) => new Request(`https://tastecase.example${PROXY_PREFIX}${path}`, { headers: { authorization: 'Bearer synthetic.owner.token', origin: 'https://tastecase.example' }, ...options });
describe('bounded fixed-origin proxy', () => {
  it.each(['http://remote.example', 'https://name:password@example.com', 'https://example.com/path', 'https://example.com?origin=x', 'file:///tmp/backend'])('rejects unsafe configured origin %s', value => expect(backendOrigin(value)).toBeNull());
  it.each(['/runner/claims', '/public/sample?projectId=x', '/projects/../runner/claims', '/projects/not-a-uuid', '/projects?url=https://evil.example'])('rejects disallowed request %s', async path => { const fetcher = vi.fn(); expect((await proxyRequest(req(path), 'https://api.example', fetcher)).status).toBeGreaterThanOrEqual(400); expect(fetcher).not.toHaveBeenCalled(); });
  it('only forwards the bounded owner Bearer and intended content headers', async () => {
    const fetcher = vi.fn(async () => Response.json({ schema_version: '1.0.0', projects: [fx.project] }));
    const result = await proxyRequest(req('/projects', { headers: { authorization: 'Bearer synthetic.owner.token', cookie: 'private=cookie', 'x-provider-secret': 'synthetic-non-secret' } }), 'https://api.example', fetcher);
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(fetcher.mock.calls[0]).toEqual(['https://api.example/projects', expect.objectContaining({ redirect: 'error', cache: 'no-store', headers: { accept: 'application/json', authorization: 'Bearer synthetic.owner.token' } })]);
  });
  it('public sample never forwards even a supplied auth header', async () => { const fetcher = vi.fn(async () => Response.json({}, { status: 503 })); await proxyRequest(req('/public/sample'), 'https://api.example', fetcher); expect(fetcher.mock.calls[0]).toEqual(['https://api.example/public/sample', expect.objectContaining({ headers: { accept: 'application/json' } })]); });
  it('rejects redirects, invalid envelopes and unsafe errors', async () => { for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.example' } }), Response.json({ schema_version: '1.0.0', projects: [fx.project, {}] }), new Response('synthetic-secret-leak', { status: 500 })]) { const result = await proxyRequest(req(), 'https://api.example', async () => response); expect(result.ok).toBe(false); expect(await result.text()).not.toContain('synthetic-secret-leak'); } });
  it('rejects cross-origin requests and runner credentials', async () => { const fetcher = vi.fn(); for (const headers of [{ origin: 'https://evil.example', authorization: 'Bearer synthetic.owner.token' }, { authorization: 'Bearer tc_runner_synthetic' }] as Record<string, string>[]) expect((await proxyRequest(req('/projects', { headers }), 'https://api.example', fetcher)).status).toBeGreaterThanOrEqual(400); expect(fetcher).not.toHaveBeenCalled(); });
  it('bounds chunked incoming bodies and deadlines', async () => { const oversized = req(`/projects/${p}/cases`, { method: 'POST', headers: { authorization: 'Bearer synthetic.owner.token', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(65536) }) }); const fetcher = vi.fn(); expect((await proxyRequest(oversized, 'https://api.example', fetcher)).status).toBe(413); expect(fetcher).not.toHaveBeenCalled(); const result = await proxyRequest(req(), 'https://api.example', async (_url, init) => { await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('deadline')))); return Response.json({}); }, 10); expect(result.status).toBe(503); });
});
