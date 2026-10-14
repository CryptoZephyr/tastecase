import type { ApprovedExpectation, ComparisonPlan } from '@/lib/api/types';

type Expectation = ApprovedExpectation | ComparisonPlan['cases'][number]['expectation'];

/** Plain-language description of the exact approved scope. */
export function describeExpectation(expectation: Expectation, name: (id: string) => string): string[] {
  if (expectation.classification === 'advisory') return ['Advisory: keep this contrast for human review. Never an automatic failure.'];
  if (expectation.classification === 'objective_contract') {
    const who = expectation.profiles.map(profile => `Profile ${profile.toUpperCase()}`).join(' and ');
    return expectation.rules.map(rule => rule.kind === 'output_schema' ? `${who}: output matches the expected shape.`
      : rule.kind === 'allowed_ids' ? `${who}: recommends only the ${rule.entryIds.length} eligible restaurants.`
      : `${who}: never recommends ${rule.entryIds.map(name).join(', ')}.`);
  }
  return expectation.rules.map(rule => {
    const who = `Profile ${rule.profileId.toUpperCase()}`;
    if (rule.kind === 'recommend_any') return `${who}: recommends at least one of ${rule.entryIds.map(name).join(', ')}.`;
    if (rule.kind === 'avoid') return `${who}: never recommends ${rule.entryIds.map(name).join(', ')}.`;
    return `${who}: when both appear, ${name(rule.beforeEntryId)} comes before ${name(rule.afterEntryId)}.`;
  });
}

export const LIMITATION_TEXT = {
  scoped_policy_only: 'A passed rule shows compliance with that approved rule only.',
  not_individual_taste: 'Nothing here establishes what a real person would like.',
  incomplete_traces: 'Some traces were partial or unavailable; that can’t prove a missing tool call.',
  partial_execution: 'Not every planned run completed. Missing runs are shown as not run, never as passed.',
  uncertain_dispatch: 'Some dispatches were interrupted and may have repeated; exactly-once execution isn’t established.',
  qloo_not_redistributed: 'Raw Qloo responses aren’t included in exports.',
  pinned_fact_freshness_unknown: 'Catalog facts are pinned as supplied; their freshness isn’t verified.',
} as const;

export const STOP_REASON = {
  completed: 'Every planned run completed.',
  explicit_partial: 'You finalized before every run completed.',
  cancelled: 'The comparison was cancelled.',
  deadline_exceeded: 'The deadline was reached.',
  budget_exhausted: 'The dispatch budget was used up.',
} as const;
