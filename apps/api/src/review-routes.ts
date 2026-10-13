import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  CreateReviewCaseRequestSchema, ReviewDecisionRequestSchema, CreateSuiteRequestSchema,
  PublishSuiteRequestSchema, REVIEW_LIMITS,
} from '@tastecase/contracts';
import { bearerToken } from './auth.js';
import { HttpError, parseRequest } from './errors.js';
import {
  createReviewCase, listReviewCases, readReviewCase, readReviewHistory, recordReviewDecision,
  createSuite, listSuites, readSuite, publishSuite, listSuiteVersions, readSuiteVersion,
} from './review-store.js';

const windowQuery = z.strictObject({
  limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().int().max(REVIEW_LIMITS.window)).default(REVIEW_LIMITS.window),
  offset: z.string().regex(/^(0|[1-9][0-9]{0,4})$/).transform(Number).pipe(z.number().int().max(REVIEW_LIMITS.offset)).default(0),
});
interface ReviewRouteContext {
  pathId: (request: FastifyRequest, key: string) => string;
  projectOwner: <T>(request: FastifyRequest, work: (client: PoolClient, projectId: string, ownerId: string) => Promise<T>, snapshot?: boolean) => Promise<T>;
}
const ownerOnly = async (request: FastifyRequest) => {
  if (bearerToken(request.headers.authorization).startsWith('tc_runner_')) {
    throw new HttpError(401, 'unauthorized', 'Owner authentication is required.');
  }
};

/** Human owner routes share foundation auth/transaction deadlines. No runner or worker review path exists. */
export function registerReviewRoutes(app: FastifyInstance, { pathId, projectOwner }: ReviewRouteContext) {
  const cases = '/projects/:projectId/cases';
  const suites = '/projects/:projectId/suites';
  const write = { bodyLimit: REVIEW_LIMITS.requestBytes, preHandler: ownerOnly };
  const read = { preHandler: ownerOnly };
  app.post(cases, write, async (request, reply) => projectOwner(request, async (client, projectId, ownerId) => {
    const result = await createReviewCase(client, projectId, ownerId, parseRequest(CreateReviewCaseRequestSchema, request.body));
    reply.code(201);
    return result;
  }));
  app.get(cases, read, async request => projectOwner(request, async (client, projectId) => {
    const { limit, offset } = parseRequest(windowQuery, request.query);
    return listReviewCases(client, projectId, limit, offset);
  }, true));
  app.get(`${cases}/:caseId`, read, async request => projectOwner(request, (client, projectId) =>
    readReviewCase(client, projectId, pathId(request, 'caseId')), true));
  app.post(`${cases}/:caseId/reviews`, write, async (request, reply) => projectOwner(request, async (client, projectId, ownerId) => {
    const result = await recordReviewDecision(client, projectId, ownerId, pathId(request, 'caseId'), parseRequest(ReviewDecisionRequestSchema, request.body));
    reply.code(201);
    return result;
  }));
  app.get(`${cases}/:caseId/reviews`, read, async request => projectOwner(request, async (client, projectId) => {
    const { limit, offset } = parseRequest(windowQuery, request.query);
    return readReviewHistory(client, projectId, pathId(request, 'caseId'), limit, offset);
  }, true));
  app.post(suites, write, async (request, reply) => projectOwner(request, async (client, projectId, ownerId) => {
    const result = await createSuite(client, projectId, ownerId, parseRequest(CreateSuiteRequestSchema, request.body));
    reply.code(201);
    return result;
  }));
  app.get(suites, read, async request => projectOwner(request, async (client, projectId) => {
    const { limit, offset } = parseRequest(windowQuery, request.query);
    return listSuites(client, projectId, limit, offset);
  }, true));
  app.get(`${suites}/:suiteId`, read, async request => projectOwner(request, (client, projectId) =>
    readSuite(client, projectId, pathId(request, 'suiteId')), true));
  app.post(`${suites}/:suiteId/versions`, write, async (request, reply) => projectOwner(request, async (client, projectId, ownerId) => {
    const body = parseRequest(PublishSuiteRequestSchema, request.body);
    if (body.suiteId !== pathId(request, 'suiteId')) throw new HttpError(400, 'invalid_request', 'The publication must select the suite in the route.');
    const result = await publishSuite(client, projectId, ownerId, body);
    reply.code(201);
    return result;
  }));
  app.get(`${suites}/:suiteId/versions`, read, async request => projectOwner(request, async (client, projectId) => {
    const { limit, offset } = parseRequest(windowQuery, request.query);
    return listSuiteVersions(client, projectId, pathId(request, 'suiteId'), limit, offset);
  }, true));
  app.get(`${suites}/:suiteId/versions/:suiteVersionId`, read, async request => projectOwner(request, (client, projectId) =>
    readSuiteVersion(client, projectId, pathId(request, 'suiteId'), pathId(request, 'suiteVersionId')), true));
}
