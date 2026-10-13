import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  CreateDiscoveryJobRequestSchema, CancelDiscoveryJobRequestSchema, ConfirmDiscoveryAnchorRequestSchema,
} from '@tastecase/contracts';
import { parseRequest } from './errors.js';
import {
  queueDiscoveryJob, listDiscoveryJobs, readDiscoveryDetail, readDiscoveryCandidate, readDiscoveryEvidence,
  cancelDiscoveryJob, confirmDiscoveryAnchor,
} from './discovery-store.js';

const listQuery = z.strictObject({
  limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().int().max(20)).default(10),
  offset: z.string().regex(/^(0|[1-9][0-9]{0,4})$/).transform(Number).pipe(z.number().int().max(10000)).default(0),
});
interface DiscoveryRouteContext {
  pathId: (request: FastifyRequest, key: string) => string;
  projectOwner: <T>(request: FastifyRequest, work: (client: PoolClient, projectId: string, ownerId: string) => Promise<T>, snapshot?: boolean) => Promise<T>;
}

/** Reuses the foundation's Supabase verifier and bounded transaction, with no independent auth path. */
export function registerDiscoveryRoutes(app: FastifyInstance, { pathId, projectOwner }: DiscoveryRouteContext) {
  const base = '/projects/:projectId/discovery-jobs';
  app.post(base, async (request, reply) => projectOwner(request, async (client, projectId) => {
    const job = await queueDiscoveryJob(client, projectId, parseRequest(CreateDiscoveryJobRequestSchema, request.body));
    reply.code(201);
    return job;
  }));
  app.get(base, async request => projectOwner(request, async (client, projectId) => {
    const { limit, offset } = parseRequest(listQuery, request.query);
    return listDiscoveryJobs(client, projectId, limit, offset);
  }));
  app.get(`${base}/:jobId`, async request => projectOwner(request, (client, projectId) =>
    readDiscoveryDetail(client, projectId, pathId(request, 'jobId')), true));
  app.get(`${base}/:jobId/evidence/:evidenceId`, async request => projectOwner(request, (client, projectId) =>
    readDiscoveryEvidence(client, projectId, pathId(request, 'jobId'), pathId(request, 'evidenceId'))));
  app.get(`${base}/:jobId/candidates/:candidateId`, async request => projectOwner(request, (client, projectId) =>
    readDiscoveryCandidate(client, projectId, pathId(request, 'jobId'), pathId(request, 'candidateId'))));
  app.post(`${base}/:jobId/cancel`, async request => projectOwner(request, (client, projectId) => {
    parseRequest(CancelDiscoveryJobRequestSchema, request.body);
    return cancelDiscoveryJob(client, projectId, pathId(request, 'jobId'));
  }));
  app.post(`${base}/:jobId/confirmations`, async (request, reply) => projectOwner(request, async (client, projectId, ownerId) => {
    const confirmation = await confirmDiscoveryAnchor(client, projectId, pathId(request, 'jobId'), ownerId,
      parseRequest(ConfirmDiscoveryAnchorRequestSchema, request.body));
    reply.code(201);
    return confirmation;
  }));
}
