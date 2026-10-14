/** All owner routes use Supabase Bearer auth. Runner routes use a separate Bearer token
 * resolved by its SHA-256 hash to an unrevoked credential/project; body project IDs are forbidden.
 * Request/response names identify exports from @tastecase/contracts; no body means no payload.
 * Foundation lists are unpaginated; discovery/review/suite lists use bounded limit/offset windows.
 * Review/suite mutations are owner-only: caller IDs plus expected revisions provide CAS/idempotence.
 * Review requests never carry evidence/checksums/author IDs; the backend resolves and pins them.
 * Publication locks the suite and all selected review heads, validates the whole list then inserts.
 * Same-ID identical retries return the original receipt/snapshot, even after later reviews.
 * Review/suite limits: 64 KiB requests, 20-row windows, offset <= 10000, <= 50 suite cases.
 * Comparison requests select a published version and explicit cases, with distinct local release labels.
 * Claims without assistantVersion only see ordinary foundation/discovery work. Comparison claims
 * require exact equality with execution.assistantVersion; leased work also requires expiry.
 * The database atomically fences leases and charges every dispatch/reclaim under a run lock.
 * Finalization locks the run and all target rows, builds its report from typed attempts and rules,
 * freezes its checksum and returns the original receipt on retry. Uploads never rewrite reports.
 * Comparison bounds: 10 cases, 120 logical slots, <=24 extra reclaim charges, <=144 dispatches,
 * one-hour deadline, 64 KiB request, 8 MiB plan/pack and 2 MiB report; 20-row compact lists.
 * Runner credentials expose lastHandshakeAt (null before verification), never an online guarantee.
 * Anonymous GET /public/sample is read-only and accepts no selectors; its dedicated synthetic
 * project/case IDs and synthetic-input approval are server configuration only. It serves a
 * persisted review snapshot as recorded evidence, with capturedAt; never dispatches providers.
 * Public DTOs omit private credential/lease/reviewer/provider-error data. Original source
 * checksums are provenance references, not checksums of these non-replayable projections.
 * Unconfigured, unsafe or insufficiently recorded samples return 503 internal_error.
 * Unknown/cross-project records return 404.
 * Conflicting idempotent IDs/results return 409. Expired leases return 409 lease_expired.
 * Revoked credentials return 401 credential_revoked. Invalid bodies return 400 invalid_request.
 */
export const REST_CONTRACTS = [
  { method: 'GET', path: '/public/sample', auth: 'public', response: 'PublicSampleSchema', status: 200, unavailableStatus: 503 },
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
  { method: 'POST', path: '/projects/:projectId/discovery-jobs', auth: 'owner', request: 'CreateDiscoveryJobRequestSchema', response: 'DiscoveryJobSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/discovery-jobs', auth: 'owner', response: 'DiscoveryJobListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/discovery-jobs/:jobId', auth: 'owner', response: 'DiscoveryJobDetailResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/discovery-jobs/:jobId/evidence/:evidenceId', auth: 'owner', response: 'DiscoveryEvidenceSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/discovery-jobs/:jobId/cancel', auth: 'owner', request: 'CancelDiscoveryJobRequestSchema', response: 'DiscoveryJobSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/discovery-jobs/:jobId/confirmations', auth: 'owner', request: 'ConfirmDiscoveryAnchorRequestSchema', response: 'DiscoveryAnchorConfirmationSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/discovery-jobs/:jobId/candidates/:candidateId', auth: 'owner', response: 'DiscoveryCandidateSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/cases', auth: 'owner', request: 'CreateReviewCaseRequestSchema', response: 'ReviewCaseResponseSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/cases', auth: 'owner', response: 'ReviewCaseListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/cases/:caseId', auth: 'owner', response: 'ReviewCaseResponseSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/cases/:caseId/reviews', auth: 'owner', request: 'ReviewDecisionRequestSchema', response: 'ReviewDecisionResponseSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/cases/:caseId/reviews', auth: 'owner', response: 'ReviewHistoryResponseSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/suites', auth: 'owner', request: 'CreateSuiteRequestSchema', response: 'SuiteIdentitySchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/suites', auth: 'owner', response: 'SuiteListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/suites/:suiteId', auth: 'owner', response: 'SuiteIdentitySchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/suites/:suiteId/versions', auth: 'owner', request: 'PublishSuiteRequestSchema', response: 'PublishSuiteResponseSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/suites/:suiteId/versions', auth: 'owner', response: 'SuiteVersionListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/suites/:suiteId/versions/:suiteVersionId', auth: 'owner', response: 'SuiteVersionSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/comparisons', auth: 'owner', request: 'CreateComparisonRequestSchema', response: 'ComparisonCreateResponseSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/comparisons', auth: 'owner', response: 'ComparisonListResponseSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/comparisons/:comparisonId', auth: 'owner', response: 'ComparisonDetailResponseSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/comparisons/:comparisonId/cancel', auth: 'owner', request: 'CancelComparisonRequestSchema', response: 'ComparisonCreateResponseSchema', status: 200 },
  { method: 'POST', path: '/projects/:projectId/comparisons/:comparisonId/finalize', auth: 'owner', request: 'FinalizeComparisonRequestSchema', response: 'ComparisonFinalizeResponseSchema', status: 201 },
  { method: 'GET', path: '/projects/:projectId/comparisons/:comparisonId/pack', auth: 'owner', response: 'PortableTestPackSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/comparisons/:comparisonId/report', auth: 'owner', response: 'ComparisonFinalReportSchema', status: 200 },
  { method: 'GET', path: '/projects/:projectId/comparisons/:comparisonId/report.txt', auth: 'owner', response: 'ComparisonReadableReportSchema', status: 200 },
] as const;
