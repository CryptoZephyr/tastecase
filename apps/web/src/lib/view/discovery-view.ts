import type { Tone } from '@/components/ui/badge';
import type { DiscoveryJob, DiscoveryState } from '@/lib/api/types';

interface StateCopy { label: string; tone: Tone; active: boolean; explanation: string }

/** Each job state has its own explanation; terminal gaps are never phrased as a pass. */
export const DISCOVERY_STATES: Record<DiscoveryState, StateCopy> = {
  queued: { label: 'Queued', tone: 'info', active: true, explanation: 'Waiting for the discovery worker to pick up this job.' },
  resolving: { label: 'Resolving interests', tone: 'info', active: true, explanation: 'Looking up the public music, film and brand interests with Qloo.' },
  needs_confirmation: { label: 'Needs your confirmation', tone: 'advisory', active: true, explanation: 'Qloo returned candidate matches for an interest. Choose the right one — TasteCase never picks for you.' },
  ranking: { label: 'Ranking restaurants', tone: 'info', active: true, explanation: 'Qloo is ranking the same eligible, mapped restaurants for each profile.' },
  selecting: { label: 'Selecting a contrast', tone: 'info', active: true, explanation: 'Choosing one code-computed contrast to investigate. The model can only choose from observed contrasts or none.' },
  running_target: { label: 'Running your assistant', tone: 'info', active: true, explanation: 'Your runner is executing the paired briefs.' },
  waiting_runner: { label: 'Waiting for your runner', tone: 'advisory', active: true, explanation: 'Work is queued for your local runner. Run it with this project’s credential to continue.' },
  investigating: { label: 'Investigating', tone: 'info', active: true, explanation: 'Repeating the case and running the focused follow-up within the remaining budget.' },
  awaiting_review: { label: 'Ready for review', tone: 'advisory', active: false, explanation: 'A case was saved with its evidence. It needs a human decision.' },
  no_useful_contrast: { label: 'No useful contrast', tone: 'neutral', active: false, explanation: 'The rankings didn’t reveal a contrast worth testing. This is a valid outcome, not a failure.' },
  unavailable: { label: 'Unavailable', tone: 'unavailable', active: false, explanation: 'A required provider or evidence was unavailable. Nothing was concluded from the gap.' },
  partial: { label: 'Partial', tone: 'unavailable', active: false, explanation: 'Some evidence or assistant runs are missing. Saved work stays available with its gaps labelled.' },
  budget_exhausted: { label: 'Budget used up', tone: 'unavailable', active: false, explanation: 'The job reached one of its call budgets. Completed work is kept; no extra calls were made.' },
  deadline_exceeded: { label: 'Deadline reached', tone: 'unavailable', active: false, explanation: 'The job reached its deadline. Completed work is kept; unfinished runs are labelled.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', active: false, explanation: 'You cancelled this job. Results already dispatched may still arrive and stay labelled as cancelled.' },
  failed: { label: 'Failed', tone: 'failed', active: false, explanation: 'The job stopped because of an error. Completed work and evidence are kept.' },
};

export const CHECKPOINTS = [
  { id: 'pinned', label: 'Inputs pinned' },
  { id: 'anchors', label: 'Interest matching' },
  { id: 'ranks', label: 'Qloo rankings' },
  { id: 'selection', label: 'Contrast selection' },
  { id: 'targets', label: 'Assistant runs' },
  { id: 'investigation', label: 'Investigation' },
  { id: 'saved', label: 'Case saved' },
] as const;

export function checkpointIndex(job: DiscoveryJob): number {
  return CHECKPOINTS.findIndex(row => row.id === job.checkpoint);
}

export const BUDGET_LABELS = {
  qlooAttempts: 'Qloo calls',
  modelDecisions: 'Model decisions',
  targetAttempts: 'Assistant runs',
  rounds: 'Rounds',
} as const;

export function budgetRows(job: DiscoveryJob) {
  return (Object.keys(BUDGET_LABELS) as (keyof typeof BUDGET_LABELS)[]).map(key => ({
    key, label: BUDGET_LABELS[key], used: job.counters[key], limit: job.input.request.budgets[key],
  }));
}
