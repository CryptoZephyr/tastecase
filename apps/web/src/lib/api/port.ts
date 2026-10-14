import type { ApiResult } from './result';
import type {
  Attempt, CancelComparisonRequest, CatalogVersion, ComparisonCreateResponse, ComparisonDetail, ComparisonFinalReport,
  ComparisonFinalizeResponse, ComparisonListItem, ConfirmDiscoveryAnchorRequest, CreateCatalogVersionRequest, CreateComparisonRequest,
  CreateDiscoveryJobRequest, CreateMappingConfirmationRequest, CreateProjectRequest, CreateReviewCaseRequest, CreateSuiteRequest,
  CreateTaskVersionRequest, DiscoveryAnchorConfirmation, DiscoveryCandidate, DiscoveryEvidence, DiscoveryJob, DiscoveryJobDetail,
  FinalizeComparisonRequest, ListWindow, MappingConfirmation, MintRunnerCredentialResponse, PortableTestPack, Project, PublicSample,
  PublishSuiteRequest, PublishSuiteResponse, ReviewCaseResponse, ReviewDecisionRequest, ReviewDecisionResponse, ReviewRecord,
  RunnerCredential, Session, SuiteIdentity, SuiteVersion, TaskVersion,
} from './types';

type R<T> = Promise<ApiResult<T>>;

/**
 * The single seam between the web app and the TasteCase API. Each method corresponds to one
 * owner route in `packages/contracts/src/rest.ts`; request bodies are the exact contract shapes
 * with caller-generated UUIDs. Implementations must:
 * - send the Supabase owner access token as `Authorization: Bearer …` on every owner route;
 * - return `fromApiError(status, body)` for non-2xx responses and `{ kind: 'network' }` when
 *   the outcome is unknown, never an empty list or a fabricated record;
 * - unwrap list envelopes (`{ projects }`, `{ jobs }`, …) into arrays.
 */
export interface TasteCaseApi {
  readonly transport: 'unwired' | 'http' | 'fixture';
  auth: {
    getSession(): R<Session | null>;
    /** Events invalidate private displays immediately; refresh can retain a verified same owner. */
    subscribe?(listener: (event: 'changed' | 'refresh' | 'expired') => void): () => void;
    signUp?(email: string, password: string, next: string): R<Session | null>;
    requestPasswordReset?(email: string, next: string): R<null>;
    updatePassword?(password: string): R<Session>;
    signInWithPassword(email: string, password: string): R<Session>;
    signOut(): R<null>;
    /** Completes an emailed auth link (e.g. confirmation) from its callback URL. */
    completeAuthLink(url: string): R<Session>;
  };
  sample: {
    /** Anonymous, fixed recorded synthetic sample; never an owner record or live dispatch. */
    getPublicSample(): R<PublicSample>;
  };
  projects: {
    list(): R<Project[]>;
    get(projectId: string): R<Project>;
    create(body: CreateProjectRequest): R<Project>;
  };
  catalogs: {
    list(projectId: string): R<CatalogVersion[]>;
    get(projectId: string, catalogVersionId: string): R<CatalogVersion>;
    create(projectId: string, body: CreateCatalogVersionRequest): R<CatalogVersion>;
  };
  tasks: {
    list(projectId: string): R<TaskVersion[]>;
    get(projectId: string, taskVersionId: string): R<TaskVersion>;
    create(projectId: string, body: CreateTaskVersionRequest): R<TaskVersion>;
  };
  mappings: {
    get(projectId: string, mappingId: string): R<MappingConfirmation>;
    list(projectId: string): R<MappingConfirmation[]>;
    create(projectId: string, body: CreateMappingConfirmationRequest): R<MappingConfirmation>;
  };
  runnerCredentials: {
    list(projectId: string): R<RunnerCredential[]>;
    /** The plaintext token is returned once and must never be stored by the web app. */
    mint(projectId: string, label: string): R<MintRunnerCredentialResponse>;
    revoke(projectId: string, credentialId: string): R<RunnerCredential>;
  };
  attempts: {
    list(projectId: string): R<Attempt[]>;
    queue(projectId: string, body: import('@tastecase/contracts').QueueAttemptRequest): R<Attempt>;
    get(projectId: string, attemptId: string): R<Attempt>;
  };
  discovery: {
    list(projectId: string, window?: ListWindow): R<DiscoveryJob[]>;
    get(projectId: string, jobId: string): R<DiscoveryJobDetail>;
    create(projectId: string, body: CreateDiscoveryJobRequest): R<DiscoveryJob>;
    cancel(projectId: string, jobId: string): R<DiscoveryJob>;
    confirmAnchor(projectId: string, jobId: string, body: ConfirmDiscoveryAnchorRequest): R<DiscoveryAnchorConfirmation>;
    getEvidence(projectId: string, jobId: string, evidenceId: string): R<DiscoveryEvidence>;
    getCandidate(projectId: string, jobId: string, candidateId: string): R<DiscoveryCandidate>;
  };
  cases: {
    list(projectId: string, window?: ListWindow): R<ReviewCaseResponse[]>;
    get(projectId: string, caseId: string): R<ReviewCaseResponse>;
    create(projectId: string, body: CreateReviewCaseRequest): R<ReviewCaseResponse>;
    review(projectId: string, caseId: string, body: ReviewDecisionRequest): R<ReviewDecisionResponse>;
    history(projectId: string, caseId: string, window?: ListWindow): R<ReviewRecord[]>;
  };
  suites: {
    list(projectId: string, window?: ListWindow): R<SuiteIdentity[]>;
    get(projectId: string, suiteId: string): R<SuiteIdentity>;
    create(projectId: string, body: CreateSuiteRequest): R<SuiteIdentity>;
    publish(projectId: string, suiteId: string, body: PublishSuiteRequest): R<PublishSuiteResponse>;
    versions(projectId: string, suiteId: string, window?: ListWindow): R<SuiteVersion[]>;
    version(projectId: string, suiteId: string, suiteVersionId: string): R<SuiteVersion>;
  };
  comparisons: {
    list(projectId: string, window?: ListWindow): R<ComparisonListItem[]>;
    get(projectId: string, comparisonId: string): R<ComparisonDetail>;
    create(projectId: string, body: CreateComparisonRequest): R<ComparisonCreateResponse>;
    cancel(projectId: string, comparisonId: string, body: CancelComparisonRequest): R<ComparisonCreateResponse>;
    finalize(projectId: string, comparisonId: string, body: FinalizeComparisonRequest): R<ComparisonFinalizeResponse>;
    pack(projectId: string, comparisonId: string): R<PortableTestPack>;
    report(projectId: string, comparisonId: string): R<ComparisonFinalReport>;
    readableReport(projectId: string, comparisonId: string): R<string>;
  };
}
