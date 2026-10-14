import { fail } from './result';
import type { TasteCaseApi } from './port';

const notConnected = async () => fail({ kind: 'not_connected' });

/**
 * Default transport for this build. The API wiring is owned by a separate change: until a real
 * transport replaces this object in `ApiProvider`, every call reports `not_connected` so screens
 * show an honest unavailable state instead of fabricated data.
 */
export const unwiredApi: TasteCaseApi = {
  transport: 'unwired',
  auth: { getSession: notConnected, signInWithPassword: notConnected, signOut: notConnected, completeAuthLink: notConnected },
  sample: { getPublicSample: notConnected },
  projects: { list: notConnected, get: notConnected, create: notConnected },
  catalogs: { list: notConnected, get: notConnected, create: notConnected },
  tasks: { list: notConnected, get: notConnected, create: notConnected },
  mappings: { get: notConnected, list: notConnected, create: notConnected },
  runnerCredentials: { list: notConnected, mint: notConnected, revoke: notConnected },
  attempts: { list: notConnected, queue: notConnected, get: notConnected },
  discovery: { list: notConnected, get: notConnected, create: notConnected, cancel: notConnected, confirmAnchor: notConnected, getEvidence: notConnected, getCandidate: notConnected },
  cases: { list: notConnected, get: notConnected, create: notConnected, review: notConnected, history: notConnected },
  suites: { list: notConnected, get: notConnected, create: notConnected, publish: notConnected, versions: notConnected, version: notConnected },
  comparisons: { list: notConnected, get: notConnected, create: notConnected, cancel: notConnected, finalize: notConnected, pack: notConnected, report: notConnected, readableReport: notConnected },
};
