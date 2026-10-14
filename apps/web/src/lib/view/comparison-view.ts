import type { ComparisonFinalReport, ComparisonPlan, ComparisonRepeatResult, ComparisonRepeatSummary } from '@/lib/api/types';

export type ProfileId = 'a' | 'b';

export interface RepeatPair { repeat: number; baseline?: ComparisonRepeatResult; candidate?: ComparisonRepeatResult; behaviour?: 'changed' | 'unchanged' | 'unavailable' }

export interface ProfileRow {
  profile: ProfileId;
  baseline?: ComparisonRepeatSummary;
  candidate?: ComparisonRepeatSummary;
  repeats: RepeatPair[];
  behaviour: { changed: number; unchanged: number; unavailable: number };
}

export interface CaseRow {
  index: number;
  caseId: string;
  planCase: ComparisonPlan['cases'][number];
  profiles: ProfileRow[];
}

/** Groups the frozen report by case, then by input brief, then by repeat. */
export function reportRows(plan: ComparisonPlan, report: ComparisonFinalReport): CaseRow[] {
  return plan.cases.map((planCase, index) => ({
    index, caseId: planCase.caseId, planCase,
    profiles: (['a', 'b'] as const).filter(profile => planCase.inputs[profile]).map(profile => {
      const repeats = Array.from({ length: planCase.repeatCount }, (_, repeat) => ({
        repeat,
        baseline: report.repeats.find(row => row.caseId === planCase.caseId && row.profileId === profile && row.repeat === repeat && row.role === 'baseline'),
        candidate: report.repeats.find(row => row.caseId === planCase.caseId && row.profileId === profile && row.repeat === repeat && row.role === 'candidate'),
        behaviour: report.behaviorChanges.find(row => row.caseId === planCase.caseId && row.profileId === profile && row.repeat === repeat)?.status,
      }));
      return {
        profile,
        baseline: report.summaries.find(row => row.caseId === planCase.caseId && row.profileId === profile && row.role === 'baseline'),
        candidate: report.summaries.find(row => row.caseId === planCase.caseId && row.profileId === profile && row.role === 'candidate'),
        repeats,
        behaviour: {
          changed: repeats.filter(row => row.behaviour === 'changed').length,
          unchanged: repeats.filter(row => row.behaviour === 'unchanged').length,
          unavailable: repeats.filter(row => row.behaviour !== 'changed' && row.behaviour !== 'unchanged').length,
        },
      };
    }),
  }));
}

export function behaviourText(row: ProfileRow): string {
  const total = row.repeats.length;
  if (row.behaviour.unavailable === total) return 'Can’t compare — results missing';
  const parts = [`Changed in ${row.behaviour.changed} of ${total}`];
  if (row.behaviour.unavailable) parts.push(`${row.behaviour.unavailable} not comparable`);
  return parts.join(' · ');
}

export type PositionChange = { id: string | null; baseline: number | null; candidate: number | null; status: 'same' | 'moved' | 'added' | 'removed' };

/** Position-level differences between two ordered recommendation lists (nulls are name-only items). */
export function positionChanges(baseline: (string | null)[], candidate: (string | null)[]): PositionChange[] {
  const ids = [...new Set([...baseline, ...candidate].filter((id): id is string => id !== null))];
  const rows: PositionChange[] = ids.map(id => {
    const b = baseline.indexOf(id); const c = candidate.indexOf(id);
    return { id, baseline: b < 0 ? null : b + 1, candidate: c < 0 ? null : c + 1, status: b < 0 ? 'added' : c < 0 ? 'removed' : b === c ? 'same' : 'moved' };
  });
  return rows.sort((x, y) => (x.baseline ?? x.candidate ?? 0) - (y.baseline ?? y.candidate ?? 0));
}

export function outcomeCounts(report: ComparisonFinalReport) {
  const counts = { fail: 0, unavailable: 0, pass: 0, advisory: 0, not_applicable: 0, mixed: 0 };
  for (const row of report.summaries) counts[row.outcome] += 1;
  return counts;
}

export function plannedSlots(cases: { repeatCount: number }[]): number {
  return cases.reduce((total, row) => total + row.repeatCount * 4, 0);
}
