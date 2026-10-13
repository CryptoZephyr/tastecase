import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  COMPARISON_LIMITS, CreateComparisonRequestSchema, CancelComparisonRequestSchema,
  FinalizeComparisonRequestSchema, ComparisonReadableReportSchema, renderComparisonReport,
} from '@tastecase/contracts';
import { bearerToken } from './auth.js';
import { HttpError, parseRequest } from './errors.js';
import {
  createComparison, readComparison, listComparisons, cancelComparison, finalizeComparison,
  exportComparisonPack, exportComparisonReport,
} from './comparison-store.js';

const windowQuery = z.strictObject({
  limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().int().max(COMPARISON_LIMITS.window)).default(COMPARISON_LIMITS.window),
  offset: z.string().regex(/^(0|[1-9][0-9]{0,4})$/).transform(Number).pipe(z.number().int().max(COMPARISON_LIMITS.offset)).default(0),
});
interface ComparisonRouteContext {
  pathId: (request: FastifyRequest, key: string) => string;
  projectOwner: <T>(request: FastifyRequest, work: (client: PoolClient, projectId: string, ownerId: string) => Promise<T>, snapshot?: boolean) => Promise<T>;
}
/** Owner artifacts are private no-store responses, never signed/public bucket URLs.
 * Reopen is GET detail, not a mutation or a fresh execution against current review heads. */
export function registerComparisonRoutes(app: FastifyInstance, { pathId, projectOwner }: ComparisonRouteContext) {
  const path = '/projects/:projectId/comparisons';
  const read = { preHandler: async (request: FastifyRequest) => {
    if (bearerToken(request.headers.authorization).startsWith('tc_runner_')) {
      throw new HttpError(401, 'unauthorized', 'Owner authentication is required.');
    }
  } };
  const write = { ...read, bodyLimit: COMPARISON_LIMITS.requestBytes };
  app.post(path, write, async (request, reply) => projectOwner(request, async (client, projectId, ownerId) => {
    const response = await createComparison(client, projectId, ownerId, parseRequest(CreateComparisonRequestSchema, request.body));
    reply.code(201);
    return response;
  }));
  app.get(path, read, async request => projectOwner(request, async (client, projectId, ownerId) => {
    const { limit, offset } = parseRequest(windowQuery, request.query);
    return listComparisons(client, projectId, ownerId, limit, offset);
  }, true));
  app.get(`${path}/:comparisonId`, read, async request => projectOwner(request, (client, projectId, ownerId) =>
    readComparison(client, projectId, ownerId, pathId(request, 'comparisonId')), true));
  app.post(`${path}/:comparisonId/cancel`, write, async request => projectOwner(request, (client, projectId, ownerId) =>
    cancelComparison(client, projectId, ownerId, pathId(request, 'comparisonId'), parseRequest(CancelComparisonRequestSchema, request.body))));
  app.post(`${path}/:comparisonId/finalize`, write, async (request, reply) => projectOwner(request, async (client, projectId, ownerId) => {
    const response = await finalizeComparison(client, projectId, ownerId, pathId(request, 'comparisonId'), parseRequest(FinalizeComparisonRequestSchema, request.body));
    reply.code(201);
    return response;
  }));
  app.get(`${path}/:comparisonId/pack`, read, async request => projectOwner(request, (client, projectId, ownerId) =>
    exportComparisonPack(client, projectId, ownerId, pathId(request, 'comparisonId')), true));
  app.get(`${path}/:comparisonId/report`, read, async request => projectOwner(request, (client, projectId, ownerId) =>
    exportComparisonReport(client, projectId, ownerId, pathId(request, 'comparisonId')), true));
  app.get(`${path}/:comparisonId/report.txt`, read, async (request, reply) => projectOwner(request, async (client, projectId, ownerId) => {
    const report = await exportComparisonReport(client, projectId, ownerId, pathId(request, 'comparisonId'));
    // Stored validation failures are safe conflicts, never field-bearing parser errors.
    let text: string;
    try { text = ComparisonReadableReportSchema.parse(renderComparisonReport(report)); }
    catch { throw new HttpError(409, 'conflict', 'The immutable report cannot be rendered safely.'); }
    reply.type('text/plain; charset=utf-8');
    return text;
  }, true));
}
