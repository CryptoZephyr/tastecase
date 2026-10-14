'use client';

import { diffWords } from 'diff';
import { useState } from 'react';
import { ProfileTag, RoleTag } from '@/components/case/labels';
import { OutcomeBadge, TraceBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/choice';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { UiError } from '@/lib/api/result';
import type { ComparisonPlan, ComparisonRepeatResult } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { behaviourText, positionChanges, type CaseRow, type ProfileRow, type RepeatPair } from '@/lib/view/comparison-view';
import { describeExpectation } from '@/lib/view/expectation-text';

const REASON: Record<ComparisonRepeatResult['rules'][number]['reason'], string> = {
  schema_valid: 'Output matched the expected shape', explicit_malformed_output: 'Output was malformed', provider_unavailable: 'Provider unavailable — not evaluated',
  pending_execution: 'Not run — not evaluated', malformed_execution: 'Malformed output — rule not evaluated', missing_identity: 'A recommendation had no catalog ID — not evaluated',
  unknown_catalog_id: 'Recommended an ID outside the catalog — not evaluated', compliant: 'Rule satisfied', violated: 'Rule violated',
  outside_profile: 'Rule doesn’t apply to this profile', both_ids_not_present: 'Both restaurants weren’t recommended — order not applicable', human_review_required: 'Advisory — needs human review',
};

const CLASS_LABEL = { objective_contract: 'Objective check', approved_policy: 'Approved policy', advisory: 'Advisory' } as const;

function names(plan: ComparisonPlan['cases'][number], profile: 'a' | 'b') {
  const map = new Map(plan.inputs[profile].catalog.entries.map(entry => [entry.id, entry.name]));
  return (id: string | null) => (id === null ? 'Name-only recommendation (no catalog ID)' : map.get(id) ?? `${id} (not in catalog)`);
}

function Recommendations({ result, name }: { result: ComparisonRepeatResult | undefined; name: (id: string | null) => string }) {
  if (!result) return <p className="text-control text-ink-2">Missing from the report.</p>;
  if (result.result.outcome === 'pending') return <p className="rounded-control bg-unavailable-bg p-2 text-control">Not run. Shown as not run — never as passed.</p>;
  if (result.result.outcome === 'provider_unavailable') return <p className="rounded-control bg-unavailable-bg p-2 text-control">Provider unavailable — no output.</p>;
  if (result.result.outcome === 'malformed_output') return <p className="rounded-control bg-unavailable-bg p-2 text-control">Malformed output.</p>;
  if (!result.result.recommendationIds.length) return <p className="text-control text-ink-2">No recommendations returned.</p>;
  return <ol className="space-y-1 text-control">{result.result.recommendationIds.map((id, index) => <li key={index}>{index + 1}. {name(id)}</li>)}</ol>;
}

function RoleColumn({ role, version, result, name }: { role: 'baseline' | 'candidate'; version: string; result: ComparisonRepeatResult | undefined; name: (id: string | null) => string }) {
  return (
    <div className="min-w-0 space-y-2 rounded-control border border-rule p-3">
      <div className="flex flex-wrap items-center gap-2"><RoleTag role={role} version={version} />{result ? <OutcomeBadge outcome={result.outcome} /> : null}{result?.result.traceCompleteness ? <TraceBadge completeness={result.result.traceCompleteness} /> : null}</div>
      <Recommendations result={result} name={name} />
      {result ? <ul className="space-y-0.5 text-meta text-ink-2">{result.rules.map(rule => <li key={rule.ruleIndex}>{CLASS_LABEL[rule.classification]} · rule {rule.ruleIndex + 1}: {REASON[rule.reason]}</li>)}</ul> : null}
      {result && (result.dispatchCount > 1 || result.uncertainDispatches) ? <p className="text-meta text-ink-2">{result.dispatchCount} dispatches{result.uncertainDispatches ? `, ${result.uncertainDispatches} interrupted` : ''}</p> : null}
    </div>
  );
}

/** Word-level difference of the two stored responses. An inspection aid, never a verdict. */
function TextDiff({ projectId, pair }: { projectId: string; pair: RepeatPair }) {
  const api = useApi();
  const [state, setState] = useState<{ status: 'idle' | 'loading' } | { status: 'error'; error: UiError } | { status: 'ready'; parts: { value: string; added?: boolean; removed?: boolean }[] | null; note?: string }>({ status: 'idle' });
  async function load() {
    if (!pair.baseline || !pair.candidate) return;
    setState({ status: 'loading' });
    const [a, b] = await Promise.all([api.attempts.get(projectId, pair.baseline.attemptId), api.attempts.get(projectId, pair.candidate.attemptId)]);
    if (!a.ok) return setState({ status: 'error', error: a.error });
    if (!b.ok) return setState({ status: 'error', error: b.error });
    const ta = a.data.result?.outcome === 'success' ? a.data.result.output.text : undefined;
    const tb = b.data.result?.outcome === 'success' ? b.data.result.output.text : undefined;
    if (ta === undefined || tb === undefined) return setState({ status: 'ready', parts: null, note: 'One or both runs have no response text to compare.' });
    setState({ status: 'ready', parts: diffWords(ta, tb) });
  }
  if (!pair.baseline || !pair.candidate) return null;
  return (
    <div className="space-y-2">
      {state.status === 'idle' || state.status === 'loading' ? <Button variant="text" onPress={() => void load()} isPending={state.status === 'loading'} pendingLabel="Loading responses">Compare response text</Button> : null}
      {state.status === 'error' ? <ErrorState error={state.error} what="the stored responses" onRetry={() => void load()} /> : null}
      {state.status === 'ready' && !state.parts ? <p className="text-meta text-ink-2">{state.note}</p> : null}
      {state.status === 'ready' && state.parts ? (
        <div>
          <p className="text-meta text-ink-2">Text difference — an inspection aid, not a correctness judgement. <span className="underline decoration-2">Added</span> in candidate, <span className="line-through">removed</span> from baseline.</p>
          <p className="mt-1 rounded-control bg-subtle p-3 text-control whitespace-pre-wrap">
            {state.parts.map((part, index) => part.added ? <ins key={index} className="bg-info-bg text-ink underline decoration-2">{part.value}</ins>
              : part.removed ? <del key={index} className="bg-failed-bg/60 text-ink line-through">{part.value}</del> : <span key={index}>{part.value}</span>)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ChangesOnly({ pair, name }: { pair: RepeatPair; name: (id: string | null) => string }) {
  if (!pair.baseline || !pair.candidate || pair.baseline.result.outcome !== 'success' || pair.candidate.result.outcome !== 'success') {
    return <p className="text-control text-ink-2">Can’t compare positions — at least one version has no successful output.</p>;
  }
  const changes = positionChanges(pair.baseline.result.recommendationIds, pair.candidate.result.recommendationIds).filter(row => row.status !== 'same');
  const nameOnly = [...pair.baseline.result.recommendationIds, ...pair.candidate.result.recommendationIds].filter(id => id === null).length;
  if (!changes.length) return <p className="text-control">Same restaurants in the same positions.{nameOnly ? ` ${nameOnly} name-only item(s) can’t be compared.` : ''}</p>;
  return (
    <ul className="space-y-1 text-control">
      {changes.map(row => <li key={row.id}>{name(row.id)}: {row.status === 'added' ? `added at #${row.candidate}` : row.status === 'removed' ? `removed (was #${row.baseline})` : `moved from #${row.baseline} to #${row.candidate}`}</li>)}
      {nameOnly ? <li className="text-ink-2">{nameOnly} name-only item(s) can’t be compared.</li> : null}
    </ul>
  );
}

function ProfileSection({ projectId, plan, row, profile, changesOnly }: { projectId: string; plan: ComparisonPlan; row: CaseRow; profile: ProfileRow; changesOnly: boolean }) {
  const name = names(row.planCase, profile.profile);
  const brief = row.planCase.inputs[profile.profile].task.syntheticBrief;
  return (
    <section aria-label={`Profile ${profile.profile.toUpperCase()}`} className="space-y-3 rounded-panel border border-rule bg-surface p-4">
      <ProfileTag profile={profile.profile} />
      <div className="rounded-control bg-subtle p-3"><p className="text-meta text-ink-2">Pinned brief · {brief.label}</p><p className="mt-1 text-control whitespace-pre-wrap">{brief.text}</p></div>
      {profile.repeats.map(pair => (
        <div key={pair.repeat} className="space-y-2 border-t border-rule pt-3">
          <p className="text-control font-medium">Repeat {pair.repeat + 1} <span className="font-normal text-ink-2">· {pair.behaviour === 'changed' ? 'recommendations changed' : pair.behaviour === 'unchanged' ? 'recommendations unchanged' : 'not comparable'}</span></p>
          {changesOnly ? <ChangesOnly pair={pair} name={name} /> : (
            <div className="grid gap-3 xl:grid-cols-2">
              <RoleColumn role="baseline" version={plan.request.baselineVersion} result={pair.baseline} name={name} />
              <RoleColumn role="candidate" version={plan.request.candidateVersion} result={pair.candidate} name={name} />
            </div>
          )}
          <TextDiff projectId={projectId} pair={pair} />
        </div>
      ))}
      <p className="text-meta text-ink-2">Behaviour change is not evidence of improved taste.</p>
    </section>
  );
}

export function ReportTable({ projectId, plan, rows }: { projectId: string; plan: ComparisonPlan; rows: CaseRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [mode, setMode] = useState<'full' | 'changes'>('full');
  const caseName = (row: CaseRow) => `${row.planCase.inputs.a.task.syntheticBrief.label} / ${row.planCase.inputs.b.task.syntheticBrief.label}`;
  return (
    <div className="space-y-4">
      <Segmented label="Output view" selectedKeys={[mode]} onSelectionChange={keys => { const [key] = [...keys]; if (key) setMode(key as 'full' | 'changes'); }}
        items={[{ id: 'full', label: 'Full outputs' }, { id: 'changes', label: 'Changes only' }]} />
      <ol className="space-y-3">
        {rows.map(row => {
          const expanded = open === row.caseId;
          const describe = describeExpectation(row.planCase.expectation, id => row.planCase.inputs.a.catalog.entries.find(entry => entry.id === id)?.name ?? id);
          return (
            <li key={row.caseId} className="rounded-panel border border-rule bg-surface">
              <div className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium break-words">Case {row.index + 1} · {caseName(row)}</p>
                    <p className="mt-1 text-meta text-ink-2">{CLASS_LABEL[row.planCase.expectation.classification]} · {describe.join(' ')}</p>
                  </div>
                  <Button variant="secondary" onPress={() => setOpen(expanded ? null : row.caseId)} aria-expanded={expanded}>{expanded ? 'Hide details' : 'Show details'}</Button>
                </div>
                <ul className="mt-3 space-y-3 md:hidden" aria-label={`Outcomes for case ${row.index + 1}`}>
                  {row.profiles.map(profile => (
                    <li key={profile.profile} className="rounded-control border border-rule p-3">
                      <ProfileTag profile={profile.profile} />
                      <dl className="mt-2 space-y-2 text-control">
                        <div className="flex flex-wrap items-center gap-2"><dt><RoleTag role="baseline" version={plan.request.baselineVersion} /></dt><dd>{profile.baseline ? <OutcomeBadge outcome={profile.baseline.outcome} /> : '—'}</dd></div>
                        <div className="flex flex-wrap items-center gap-2"><dt><RoleTag role="candidate" version={plan.request.candidateVersion} /></dt><dd>{profile.candidate ? <OutcomeBadge outcome={profile.candidate.outcome} /> : '—'}</dd></div>
                        <div className="flex flex-wrap items-start gap-2"><dt className="text-meta text-ink-2">Changed behaviour:</dt><dd className="min-w-0 flex-1">{behaviourText(profile)}</dd></div>
                      </dl>
                    </li>
                  ))}
                </ul>
                <div tabIndex={0} role="region" aria-label={`Outcomes for case ${row.index + 1}`} className="mt-3 hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[34rem] text-left text-control">
                    <caption className="sr-only">Outcomes for case {row.index + 1}</caption>
                    <thead className="text-meta text-ink-2"><tr><th scope="col" className="py-1 pr-3 font-medium">Brief</th><th scope="col" className="py-1 pr-3 font-medium">Baseline</th><th scope="col" className="py-1 pr-3 font-medium">Candidate</th><th scope="col" className="py-1 font-medium">Changed behaviour</th></tr></thead>
                    <tbody className="divide-y divide-rule">
                      {row.profiles.map(profile => (
                        <tr key={profile.profile}>
                          <th scope="row" className="py-2 pr-3 font-normal"><ProfileTag profile={profile.profile} /></th>
                          <td className="py-2 pr-3">{profile.baseline ? <OutcomeBadge outcome={profile.baseline.outcome} /> : '—'}</td>
                          <td className="py-2 pr-3">{profile.candidate ? <OutcomeBadge outcome={profile.candidate.outcome} /> : '—'}</td>
                          <td className="py-2">{behaviourText(profile)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {expanded ? (
                <div className={cn('grid gap-4 border-t border-rule bg-canvas/40 p-4', row.profiles.length > 1 && '2xl:grid-cols-2')}>
                  {row.profiles.map(profile => <ProfileSection key={profile.profile} projectId={projectId} plan={plan} row={row} profile={profile} changesOnly={mode === 'changes'} />)}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
