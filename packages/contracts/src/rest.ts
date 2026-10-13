/** All owner routes use Supabase Bearer auth. Runner routes use a separate Bearer token
 * resolved by its SHA-256 hash to an unrevoked credential/project; body project IDs are forbidden.
 * Request/response names identify exports from @tastecase/contracts; no body means no payload.
 * Lists are unpaginated v1 project-scoped lists. Unknown/cross-project records return 404.
 * Conflicting idempotent IDs/results return 409. Expired leases return 409 lease_expired.
 * Revoked credentials return 401 credential_revoked. Invalid bodies return 400 invalid_request.
 */
export const REST_CONTRACTS = [
  { method: 'POST', path: '/projects', auth: 'owner', request: 'CreateProjectRequestSchema', response: 'ProjectSchema', status: 201 },
  { method: 'GET', path: '/projects', auth: 'owner', response: 'ProjectListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId', auth: 'owner', response: 'ProjectSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/catalogs', auth: 'owner', request: 'CreateCatalogVersionRequestSchema', response: 'CatalogVersionSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/catalogs', auth: 'owner', response: 'CatalogVersionListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/catalogs/:catalogVersionId', auth: 'owner', response: 'CatalogVersionSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/tasks', auth: 'owner', request: 'CreateTaskVersionRequestSchema', response: 'TaskVersionSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/tasks', auth: 'owner', response: 'TaskVersionListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/tasks/:taskVersionId', auth: 'owner', response: 'TaskVersionSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/mappings', auth: 'owner', request: 'CreateMappingConfirmationRequestSchema', response: 'MappingConfirmationSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/mappings', auth: 'owner', response: 'MappingConfirmationListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/mappings/:mappingId', auth: 'owner', response: 'MappingConfirmationSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/runner-credentials', auth: 'owner', request: 'MintRunnerCredentialRequestSchema', response: 'MintRunnerCredentialResponseSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/runner-credentials', auth: 'owner', response: 'RunnerCredentialListResponseSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/runner-credentials/:credentialId/revoke', auth: 'owner', request: 'RevokeRunnerCredentialRequestSchema', response: 'RunnerCredentialSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/attempts', auth: 'owner', request: 'QueueAttemptRequestSchema', response: 'AttemptSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/attempts', auth: 'owner', response: 'AttemptListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/attempts/:attemptId', auth: 'owner', response: 'AttemptSchema', status: 200 },
  { method: 'POST', path: '/runner/handshake', auth: 'runner', request: 'RunnerHandshakeRequestSchema', response: 'RunnerHandshakeResponseSchema', status: 200 },
  { method: 'POST', path: '/runner/claims', auth: 'runner', request: 'ClaimAttemptRequestSchema', response: 'ClaimAttemptResponseSchema', status: 200, emptyStatus: 204 },
  { method: 'POST', path: '/runner/attempts/:attemptId/results', auth: 'runner', request: 'UploadTargetResultRequestSchema', response: 'UploadTargetResultResponseSchema', status: 200 },
] as const;
