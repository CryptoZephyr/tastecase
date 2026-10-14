/** Browser-safe mirror of the owner/public REST routes. No runner, health or arbitrary URL proxy.
 * Contract parity is checked in transport.test.ts; dynamic parameters are UUIDs only. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HTTP_ROUTES = [
  ['GET', '/public/sample', 200],
  ['GET', '/projects', 200], ['POST', '/projects', 201], ['GET', '/projects/:projectId', 200],
  ['GET', '/projects/:projectId/catalogs', 200], ['POST', '/projects/:projectId/catalogs', 201], ['GET', '/projects/:projectId/catalogs/:catalogVersionId', 200],
  ['GET', '/projects/:projectId/tasks', 200], ['POST', '/projects/:projectId/tasks', 201], ['GET', '/projects/:projectId/tasks/:taskVersionId', 200],
  ['GET', '/projects/:projectId/mappings', 200], ['POST', '/projects/:projectId/mappings', 201], ['GET', '/projects/:projectId/mappings/:mappingId', 200],
  ['GET', '/projects/:projectId/runner-credentials', 200], ['POST', '/projects/:projectId/runner-credentials', 201], ['POST', '/projects/:projectId/runner-credentials/:credentialId/revoke', 200],
  ['GET', '/projects/:projectId/attempts/:attemptId', 200], ['GET', '/projects/:projectId/attempts', 200], ['POST', '/projects/:projectId/attempts', 201],
  ['GET', '/projects/:projectId/discovery-jobs', 200], ['POST', '/projects/:projectId/discovery-jobs', 201], ['GET', '/projects/:projectId/discovery-jobs/:jobId', 200],
  ['POST', '/projects/:projectId/discovery-jobs/:jobId/cancel', 200], ['POST', '/projects/:projectId/discovery-jobs/:jobId/confirmations', 201],
  ['GET', '/projects/:projectId/discovery-jobs/:jobId/evidence/:evidenceId', 200], ['GET', '/projects/:projectId/discovery-jobs/:jobId/candidates/:candidateId', 200],
  ['GET', '/projects/:projectId/cases', 200], ['POST', '/projects/:projectId/cases', 201], ['GET', '/projects/:projectId/cases/:caseId', 200],
  ['GET', '/projects/:projectId/cases/:caseId/reviews', 200], ['POST', '/projects/:projectId/cases/:caseId/reviews', 201],
  ['GET', '/projects/:projectId/suites', 200], ['POST', '/projects/:projectId/suites', 201], ['GET', '/projects/:projectId/suites/:suiteId', 200],
  ['GET', '/projects/:projectId/suites/:suiteId/versions', 200], ['POST', '/projects/:projectId/suites/:suiteId/versions', 201], ['GET', '/projects/:projectId/suites/:suiteId/versions/:suiteVersionId', 200],
  ['GET', '/projects/:projectId/comparisons', 200], ['POST', '/projects/:projectId/comparisons', 201], ['GET', '/projects/:projectId/comparisons/:comparisonId', 200],
  ['POST', '/projects/:projectId/comparisons/:comparisonId/cancel', 200], ['POST', '/projects/:projectId/comparisons/:comparisonId/finalize', 201],
  ['GET', '/projects/:projectId/comparisons/:comparisonId/pack', 200], ['GET', '/projects/:projectId/comparisons/:comparisonId/report', 200], ['GET', '/projects/:projectId/comparisons/:comparisonId/report.txt', 200],
] as const;
export const successStatus = (method: string, template: string) => HTTP_ROUTES.find(([verb, path]) => verb === method && path === template)?.[2];

export function matchHttpRoute(method: string, path: string): string | null {
  const actual = path.split('/');
  return HTTP_ROUTES.find(([verb, template]) => verb === method && template.split('/').length === actual.length && template.split('/').every((part, i) => part.startsWith(':') ? UUID.test(actual[i]) : part === actual[i]))?.[1] ?? null;
}
export function windowQuery(template: string): boolean {
  return ['/projects/:projectId/discovery-jobs', '/projects/:projectId/cases', '/projects/:projectId/cases/:caseId/reviews', '/projects/:projectId/suites', '/projects/:projectId/suites/:suiteId/versions', '/projects/:projectId/comparisons'].includes(template);
}
export function requestLimit(template: string): number {
  return /\/(cases|suites|comparisons)(\/|$)/.test(template) ? 65536 : 1048576;
}
export const RESPONSE_LIMIT = 8 * 1024 * 1024;
export const PROXY_PREFIX = '/api/tastecase';

/** Reads streams incrementally, including chunked bodies; Content-Length is not trusted. */
export async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('Deadline');
      const chunk = await reader.read();
      if (signal.aborted) throw new Error('Deadline');
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new RangeError('Body limit'); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
