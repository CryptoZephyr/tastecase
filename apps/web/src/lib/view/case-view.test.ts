import { reviewEvidenceCoverage } from '@tastecase/contracts';
import { describe, expect, it } from 'vitest';
import type { Attempt } from '@/lib/api/types';
import * as fx from '@/test/fixtures';
import { buildCaseView, computeCoverage, outputState, sameRecommendations } from './case-view';

describe('buildCaseView', () => {
  it('keeps paired profiles, rankings and every captured slot', () => {
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts);
    expect(view.profiles).toEqual(['a', 'b']);
    expect(view.rankings).toHaveLength(4);
    expect(view.slots.map(slot => slot.label)).toEqual(['Repeat 1', 'Repeat 2', 'Pair follow-up']);
    expect(view.coverage.missingEntryIds).toEqual(['fx-noodle']);
    expect(view.coverage.unmappedEntryIds).toEqual(['fx-unmapped']);
  });

  it('never invents a Profile B for a single-brief case', () => {
    const view = buildCaseView(fx.singleBriefCase(), fx.jobDetail(), fx.attempts);
    expect(view.profiles).toEqual(['a']);
    expect(view.briefs.b).toBeUndefined();
  });

  it('labels pending, unavailable and unread outputs instead of hiding them', () => {
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts.filter(row => row.id !== fx.attempts[0].id));
    const [first, second, followUp] = view.slots;
    expect(outputState(first.outputs.a).kind).toBe('unread');
    expect(outputState(second.outputs.b).kind).toBe('unavailable');
    expect(outputState(followUp.outputs.b).kind).toBe('pending');
    expect(view.coverage.unreadAttemptIds).toHaveLength(1);
  });

  it('compares recommendations only when both outputs are comparable', () => {
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts);
    expect(sameRecommendations(outputState(view.slots[0].outputs.a), outputState(view.slots[0].outputs.b))).toBe(true);
    expect(sameRecommendations(outputState(view.slots[1].outputs.a), outputState(view.slots[1].outputs.b))).toBeNull();
  });
});

describe('coverage parity with the backend contract', () => {
  it('matches reviewEvidenceCoverage from @tastecase/contracts on the same evidence', () => {
    const detail = fx.jobDetail();
    const queued: Attempt[] = detail.attempts.filter(row => row.status !== 'completed').map(row => ({ ...fx.attempts[0], id: row.attemptId, status: 'queued', leaseId: null, leaseCredentialId: null, leaseExpiresAt: null, result: null, resultChecksum: null, completedAt: null }));
    const all = [...fx.attempts, ...queued];
    const source = { evidence: detail.evidence, job: detail.job, targets: detail.attempts.map(association => ({ association, attempt: all.find(row => row.id === association.attemptId)! })) };
    const expected = reviewEvidenceCoverage(source as unknown as Parameters<typeof reviewEvidenceCoverage>[0]);
    const { unreadAttemptIds, ...actual } = computeCoverage(detail, new Map(all.map(row => [row.id, row])));
    expect(unreadAttemptIds).toEqual([]);
    expect(actual).toEqual(expected);
  });
});
