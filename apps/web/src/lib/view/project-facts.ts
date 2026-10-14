import type { TasteCaseApi } from '@/lib/api/port';
import type { ApiResult } from '@/lib/api/result';
import { all } from '@/lib/api/use-resource';
import type {
  CatalogVersion, ComparisonListItem, DiscoveryJob, MappingConfirmation, ReviewCaseResponse, RunnerCredential, SuiteIdentity, TaskVersion,
} from '@/lib/api/types';
import { routes } from '@/lib/routes';
import { loadOwnerHistory } from './owner-history';

export interface ProjectFacts {
  credentials: RunnerCredential[];
  catalogs: CatalogVersion[];
  mappings: MappingConfirmation[];
  tasks: TaskVersion[];
  jobs: DiscoveryJob[];
  cases: ReviewCaseResponse[];
  suites: SuiteIdentity[];
  comparisons: ComparisonListItem[];
}

/** All facts come from authoritative backend lists; any failure fails the derivation as a whole. */
export async function loadProjectFacts(api: TasteCaseApi, projectId: string): Promise<ApiResult<ProjectFacts>> {
  const result = await all([
    api.runnerCredentials.list(projectId), api.catalogs.list(projectId), api.mappings.list(projectId), api.tasks.list(projectId),
    loadOwnerHistory(window => api.discovery.list(projectId, window)), loadOwnerHistory(window => api.cases.list(projectId, window)), loadOwnerHistory(window => api.suites.list(projectId, window)),
    loadOwnerHistory(window => api.comparisons.list(projectId, window)),
  ] as const);
  if (!result.ok) return result;
  const [credentials, catalogs, mappings, tasks, jobs, cases, suites, comparisons] = result.data;
  return { ok: true, data: { credentials, catalogs, mappings, tasks, jobs, cases, suites, comparisons } };
}

export interface SetupStep { id: 'runner' | 'catalog' | 'mappings' | 'task' | 'budgets'; title: string; done: boolean; detail: string }

export function setupSteps(facts: ProjectFacts): SetupStep[] {
  const active = facts.credentials.filter(row => row.revokedAt === null);
  const verified = active.filter(row => row.lastHandshakeAt != null);
  return [
    { id: 'runner', title: 'Connect your runner', done: verified.length > 0,
      detail: verified.length ? `${verified.length} credential${verified.length === 1 ? '' : 's'} with a verified handshake. Current connection is offline or unknown.` : active.length ? `${active.length} issued credential${active.length === 1 ? '' : 's'}; no verified handshake recorded. Run the handshake, then check status.` : 'Issue a project credential for your local runner.' },
    { id: 'catalog', title: 'Import your restaurant catalog', done: facts.catalogs.length > 0,
      detail: facts.catalogs.length ? `${facts.catalogs.length} immutable catalog version${facts.catalogs.length === 1 ? '' : 's'}.` : 'Import the restaurants your assistant may recommend.' },
    { id: 'mappings', title: 'Confirm Qloo mappings', done: facts.mappings.length > 0,
      detail: facts.mappings.length ? `${facts.mappings.length} confirmed mapping${facts.mappings.length === 1 ? '' : 's'}.` : 'Confirm which Qloo entity each restaurant is. Unconfirmed restaurants stay unranked.' },
    { id: 'task', title: 'Define the task and constraints', done: facts.tasks.length > 0,
      detail: facts.tasks.length ? `${facts.tasks.length} task version${facts.tasks.length === 1 ? '' : 's'}.` : 'Describe the recommendation task and the practical constraints held fixed.' },
    { id: 'budgets', title: 'Review call budgets', done: facts.jobs.length > 0,
      detail: facts.jobs.length ? 'Budgets are pinned on each discovery job.' : 'Budgets are reviewed when you start discovery.' },
  ];
}

export interface NextAction { title: string; body: string; href: string; cta: string }

/** One dominant next action derived from backend facts, never from local checkmarks. */
export function nextAction(projectId: string, facts: ProjectFacts): NextAction {
  const step = setupSteps(facts).find(row => !row.done && row.id !== 'budgets');
  if (step) return { title: step.title, body: step.detail, href: routes.setup(projectId, step.id), cta: step.id === 'runner' ? (facts.credentials.some(row => !row.revokedAt) ? 'Verify the runner handshake' : 'Issue a runner credential') : `Go to ${step.title.toLowerCase()}` };
  const confirming = facts.jobs.find(job => job.state === 'needs_confirmation');
  if (confirming) return { title: 'Confirm an interest match', body: 'A discovery job is waiting for you to choose the right Qloo entity.', href: routes.job(projectId, confirming.id), cta: 'Review the matches' };
  const waiting = facts.jobs.find(job => job.state === 'waiting_runner');
  if (waiting) return { title: 'Run your local runner', body: 'Discovery work is queued for your runner.', href: routes.job(projectId, waiting.id), cta: 'See runner instructions' };
  const unreviewed = facts.cases.find(row => row.head.status === 'unreviewed');
  if (unreviewed) return { title: 'Review a saved case', body: 'A case is waiting for an accept, edit, reject or defer decision.', href: routes.case(projectId, unreviewed.case.id), cta: 'Review the case' };
  const withCandidates = facts.jobs.find(job => job.checkpointData.candidateIds.some(id => !facts.cases.some(row => row.case.candidateId === id)));
  if (withCandidates) return { title: 'Open a discovered case', body: 'A discovery job saved a case that hasn’t been opened for review yet.', href: routes.job(projectId, withCandidates.id), cta: 'Open the job' };
  if (!facts.jobs.length) return { title: 'Start discovery', body: 'Setup is complete. Start a bounded discovery job to find a case worth testing.', href: routes.discover(projectId), cta: 'Start discovery' };
  const approved = facts.cases.some(row => row.head.status === 'accepted' || row.head.status === 'edited');
  if (approved && !facts.suites.some(suite => suite.currentVersion > 0)) return { title: 'Publish a suite', body: 'You have approved cases. Publish them as an immutable suite version.', href: routes.suites(projectId), cta: 'Publish a suite' };
  const running = facts.comparisons.find(row => row.state === 'queued' || row.state === 'running');
  if (running) return { title: 'Comparison in progress', body: 'Your runner is executing both assistant versions.', href: routes.comparison(projectId, running.id), cta: 'Check progress' };
  if (facts.suites.some(suite => suite.currentVersion > 0) && !facts.comparisons.length) return { title: 'Compare two releases', body: 'Run a baseline and a candidate version against a published suite.', href: routes.newComparison(projectId), cta: 'Start a comparison' };
  const finalized = facts.comparisons.find(row => row.state === 'finalized');
  if (finalized) return { title: 'Export and replay', body: 'Download the test pack and replay it locally before your next release.', href: routes.comparison(projectId, finalized.id), cta: 'Open the report' };
  return { title: 'Continue discovery', body: 'Look for more cases, or review what you have.', href: routes.discover(projectId), cta: 'Open discovery' };
}
