/** SYNTHETIC fixture transport for tests and `next dev` state screens. Never used by production routes. */
import type { TasteCaseApi } from '@/lib/api/port';
import { fail, ok, type ApiResult, type UiErrorKind } from '@/lib/api/result';
import type { DiscoveryJob, PortableTestPack } from '@/lib/api/types';
import * as fx from './fixtures';

export type Scenario = 'data' | 'empty' | 'loading' | UiErrorKind;
export interface FixtureOptions {
  scenario?: Scenario;
  session?: 'signed_in' | 'signed_out' | 'unknown';
  jobState?: DiscoveryJob['state'];
  finalized?: boolean;
  caseVariant?: 'paired' | 'single' | 'approved';
  mutation?: 'ok' | UiErrorKind;
}

const never = <T>() => new Promise<ApiResult<T>>(() => undefined);

export function fixtureApi(options: FixtureOptions = {}): TasteCaseApi {
  const scenario = options.scenario ?? 'data';
  const read = async <T>(data: T, empty?: T): Promise<ApiResult<T>> => {
    if (scenario === 'loading') return never<T>();
    if (scenario === 'data') return ok(data);
    if (scenario === 'empty') return ok(empty ?? data);
    return fail({ kind: scenario, message: scenario === 'conflict' ? 'Fixture conflict.' : undefined });
  };
  const write = async <T>(data: T): Promise<ApiResult<T>> => {
    const mutation = options.mutation ?? 'ok';
    return mutation === 'ok' ? ok(data) : fail({ kind: mutation });
  };
  const caseResponse = options.caseVariant === 'single' ? fx.singleBriefCase() : options.caseVariant === 'approved' ? fx.approvedCase : fx.caseResponse();
  const pack = { schema_version: '1.0.0', pack_version: 'tastecase-test-pack/1', target_output_contract: 'tastecase-target-output/1', plan: fx.plan, checksum: 'f'.repeat(64) } as PortableTestPack;

  return {
    transport: 'fixture',
    auth: {
      getSession: async () => options.session === 'signed_out' ? ok(null) : options.session === 'unknown' ? fail({ kind: 'not_connected' }) : ok({ userId: fx.ids.owner, email: 'fixture.owner@example.com', expiresAt: null }),
      signInWithPassword: async () => write({ userId: fx.ids.owner, email: 'fixture.owner@example.com', expiresAt: null }),
      signOut: async () => ok(null),
      completeAuthLink: async () => write({ userId: fx.ids.owner, email: 'fixture.owner@example.com', expiresAt: null }),
    },
    sample: { getPublicSample: () => read({ provenance: 'recorded' as const, capturedAt: '2026-10-13T10:30:00.000Z', caseResponse: fx.caseResponse(), job: fx.jobDetail(), attempts: fx.attempts }) },
    projects: { list: () => read([fx.project], []), get: () => read(fx.project), create: () => write(fx.project) },
    catalogs: { list: () => read([fx.catalog], []), get: () => read(fx.catalog), create: () => write(fx.catalog) },
    tasks: { list: () => read([fx.task], []), get: () => read(fx.task), create: () => write(fx.task) },
    mappings: { list: () => read(fx.mappings, []), create: () => write(fx.mappings[0]) },
    runnerCredentials: {
      list: () => read(fx.credentials, []),
      mint: () => write({ schema_version: '1.0.0', credential: fx.credentials[0], token: `tc_runner_${'FIXTUREnotArealTOKEN'.padEnd(43, 'x')}` }),
      revoke: () => write({ ...fx.credentials[0], revokedAt: '2026-10-13T11:00:00.000Z' }),
    },
    attempts: { get: async (_project, attemptId) => { const found = fx.attempts.find(row => row.id === attemptId) ?? fx.comparisonAttempt(attemptId); return found ? read(found) : fail({ kind: 'not_found' }); } },
    discovery: {
      list: () => read([fx.job(options.jobState)], []), get: () => read(fx.jobDetail(options.jobState)), create: () => write(fx.job('queued')),
      cancel: () => write(fx.job('cancelled')), confirmAnchor: () => write(fx.jobDetail().confirmations[0]),
      getEvidence: () => read(fx.evidence[0]), getCandidate: () => read(fx.candidate),
    },
    cases: {
      list: () => read([caseResponse], []), get: () => read(caseResponse), create: () => write(caseResponse),
      review: () => write({ schema_version: '1.0.0', head: fx.approvedCase.head, review: fx.reviewRecord, idempotent: false }),
      history: () => read(options.caseVariant === 'approved' ? [fx.reviewRecord] : [], []),
    },
    suites: {
      list: () => read([fx.suite], []), get: () => read(fx.suite), create: () => write(fx.suite),
      publish: () => write({ schema_version: '1.0.0', suite: fx.suiteVersion, idempotent: false }),
      versions: () => read([fx.suiteVersion], []), version: () => read(fx.suiteVersion),
    },
    comparisons: {
      list: () => read(fx.comparisonList, []), get: () => read(fx.comparison(options.finalized ?? true)),
      create: () => write({ schema_version: '1.0.0', comparison: fx.comparison(false).comparison, idempotent: false }),
      cancel: () => write({ schema_version: '1.0.0', comparison: fx.comparison(false).comparison, idempotent: false }),
      finalize: () => write({ schema_version: '1.0.0', report: fx.report, idempotent: false }),
      pack: () => read(pack), report: () => read(fx.report), readableReport: () => read('Fixture readable report'),
    },
  };
}
