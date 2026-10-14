'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Checkbox, CheckboxGroup } from '@/components/ui/choice';
import { Field, NativeSelect } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { PageHeader, Panel } from '@/components/ui/page';
import { SkeletonPanel } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import type { CreateComparisonRequest, SuiteVersion } from '@/lib/api/types';
import { useResource } from '@/lib/api/use-resource';
import { newId, SCHEMA_VERSION } from '@/lib/ids';
import { routes } from '@/lib/routes';
import { plannedSlots } from '@/lib/view/comparison-view';
import { loadOwnerHistory } from '@/lib/view/owner-history';

function ComparisonForm({ projectId, version }: { projectId: string; version: SuiteVersion }) {
  const api = useApi();
  const router = useRouter();
  const cases = version.cases.map(row => ({
    id: row.case.id, repeatCount: row.review.decision.evidence.job.input.request.repeatCount,
    title: `${row.review.decision.evidence.candidate.content.briefs.a.label} / ${row.review.decision.evidence.candidate.content.briefs.b.label}`,
  }));
  const [selected, setSelected] = useState<string[]>(() => cases.slice(0, 10).map(row => row.id));
  const [baseline, setBaseline] = useState('');
  const [candidate, setCandidate] = useState('');
  const [minutes, setMinutes] = useState('55');
  const [reclaims, setReclaims] = useState('0');
  const [extraDispatches, setExtraDispatches] = useState('0');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingBody, setPendingBody] = useState<CreateComparisonRequest | null>(null);
  const request = useRef<{ key: string; body: CreateComparisonRequest } | null>(null);
  const sending = useRef(false);
  const [error, setError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(false);
  const slots = plannedSlots(cases.filter(row => selected.includes(row.id)));

  function build(): CreateComparisonRequest | null {
    const next: Record<string, string> = {};
    const reclaimBudget = Number(reclaims); const extra = Number(extraDispatches); const windowMinutes = Number(minutes);
    if (!selected.length) next.cases = 'Choose at least one case.';
    if (selected.length > 10) next.cases = 'A comparison can include at most 10 cases.';
    if (!baseline.trim()) next.baseline = 'Enter the baseline release label.';
    if (!candidate.trim()) next.candidate = 'Enter the candidate release label.';
    if (baseline.trim() && baseline.trim() === candidate.trim()) next.candidate = 'Baseline and candidate must be different versions.';
    if (!Number.isInteger(windowMinutes) || windowMinutes < 5 || windowMinutes > 59) next.minutes = 'Choose 5 to 59 minutes.';
    if (!Number.isInteger(reclaimBudget) || reclaimBudget < 0 || reclaimBudget > 24) next.reclaims = 'Use 0 to 24.';
    if (!Number.isInteger(extra) || extra < 0 || extra > reclaimBudget) next.extraDispatches = 'Use 0 up to the reclaim allowance.';
    if (slots > 120) next.cases = `These cases need ${slots} runs; the limit is 120.`;
    if (slots + extra > 144) next.extraDispatches = 'The total dispatch budget can’t exceed 144.';
    setErrors(next);
    if (Object.keys(next).length) return null;
    const content = { schema_version: SCHEMA_VERSION, suiteVersionId: version.id, baselineVersion: baseline.trim(), candidateVersion: candidate.trim(),
      caseIds: cases.filter(row => selected.includes(row.id)).map(row => row.id), dispatchBudget: Math.max(4, slots + extra), reclaimBudget };
    // The deadline window is part of the intent; elapsed time is not a body change.
    const key = JSON.stringify({ ...content, windowMinutes });
    if (request.current?.key === key) return request.current.body;
    const body = { ...content, id: newId(), deadlineAt: new Date(Date.now() + windowMinutes * 60_000).toISOString() };
    request.current = { key, body };
    return body;
  }

  async function send(body: CreateComparisonRequest) {
    if (sending.current) return;
    sending.current = true;
    setPending(true); setError(null); setPendingBody(body);
    const result = await api.comparisons.create(projectId, body);
    sending.current = false;
    setPending(false);
    if (result.ok) router.push(routes.comparison(projectId, result.data.comparison.plan.id)); else setError(result.error);
  }

  return (
    <form noValidate onSubmit={event => { event.preventDefault(); const body = build(); if (body) void send(body); }} className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Baseline version" value={baseline} onChange={setBaseline} isRequired maxLength={160} errorMessage={errors.baseline} mono description="Exact local release label, such as concierge-prompt-v1." />
        <Field label="Candidate version" value={candidate} onChange={setCandidate} isRequired maxLength={160} errorMessage={errors.candidate} mono description="Must differ from the baseline. Labels never select a model." />
      </div>
      <CheckboxGroup label="Cases" value={selected} onChange={setSelected} errorMessage={errors.cases} description="Each case runs both versions on both profiles for its pinned number of repeats.">
        {cases.map(row => <Checkbox key={row.id} value={row.id}>{row.title}<span className="block text-meta text-ink-2">{row.repeatCount} repeat{row.repeatCount === 1 ? '' : 's'} → {row.repeatCount * 4} runs</span></Checkbox>)}
      </CheckboxGroup>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Deadline (minutes from now)" value={minutes} onChange={setMinutes} inputMode="numeric" errorMessage={errors.minutes} description="Within one hour of creation." />
        <Field label="Reclaim allowance" value={reclaims} onChange={setReclaims} inputMode="numeric" errorMessage={errors.reclaims} description="Extra charged dispatches allowed for expired leases (0–24)." />
        <Field label="Extra dispatches in budget" value={extraDispatches} onChange={setExtraDispatches} inputMode="numeric" errorMessage={errors.extraDispatches} description="Added to the planned runs; at most the reclaim allowance." />
      </div>
      <Notice tone="info" title={`${slots} planned runs · dispatch budget ${Math.max(4, slots + (Number(extraDispatches) || 0))}`}>
        <p>Both versions execute fresh runs; old discovery outputs are never substituted. Unknown or repeated dispatches stay charged.</p>
      </Notice>
      {error && isUncertain(error) && pendingBody ? <Notice tone="advisory" title="We couldn’t confirm the comparison started" role="alert" actions={<Button variant="secondary" onPress={() => void send(pendingBody)} isPending={pending}>Retry the same request</Button>}><p>Retrying sends the identical request and deadline, so it can’t start twice.</p></Notice>
        : error ? <ErrorState error={error} what="the comparison" /> : null}
      <Button type="submit" isPending={pending} pendingLabel="Starting comparison">Start comparison</Button>
    </form>
  );
}

type SelectionProps = { projectId: string; suiteId?: string; versionId?: string };

/** Query-string navigation can reuse the screen; reset local selection to the requested pin. */
export function NewComparisonScreen(props: SelectionProps) {
  return <ComparisonSelection key={JSON.stringify([props.projectId, props.suiteId, props.versionId])} {...props} />;
}

function ComparisonSelection({ projectId, suiteId, versionId }: SelectionProps) {
  const api = useApi();
  const suites = useResource(() => loadOwnerHistory(window => api.suites.list(projectId, window)), [api, projectId]);
  const published = suites.status === 'ready' ? suites.data.filter(row => row.currentVersion > 0) : [];
  const [chosenSuite, setChosenSuite] = useState<string | undefined>(suiteId);
  const activeSuite = chosenSuite ?? published[0]?.id;
  const versions = useResource(() => loadOwnerHistory(window => api.suites.versions(projectId, activeSuite!, window)), [api, projectId, activeSuite], { enabled: Boolean(activeSuite) });
  const [chosenVersion, setChosenVersion] = useState<string | undefined>(versionId);
  const sorted = versions.status === 'ready' ? [...versions.data].sort((a, b) => b.version - a.version) : [];
  const activeVersion = chosenVersion ?? sorted[0]?.id;
  const exact = useResource(() => api.suites.version(projectId, activeSuite!, activeVersion!), [api, projectId, activeSuite, activeVersion], { enabled: Boolean(activeSuite && activeVersion) });
  const version = exact.status === 'ready' && exact.data.id === activeVersion && exact.data.suiteId === activeSuite && exact.data.projectId === projectId ? exact.data : undefined;
  const choices = version && !sorted.some(row => row.id === version.id) ? [version, ...sorted] : sorted;

  return (
    <div className="mx-auto max-w-[960px] space-y-8">
      <PageHeader title="Compare two releases" description="Pick a published suite version, name the baseline and candidate releases, then run both on your runner." />
      {suites.status === 'loading' ? <SkeletonPanel label="Loading suites" /> : null}
      {suites.error ? <ErrorState error={suites.error} what="the latest complete published-suite history (showing stale saved data if available)" onRetry={suites.reload} retrying={suites.reloading} /> : null}
      {suites.status === 'ready' && !published.length ? <EmptyState title="No published suite yet" action={<ButtonLink href={routes.suites(projectId)}>Go to suites</ButtonLink>}><p>Comparisons run against an exact published suite version.</p></EmptyState> : null}
      {published.length ? (
        <Panel className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <NativeSelect id="cmp-suite" label="Suite" value={activeSuite ?? ''} onChange={value => { setChosenSuite(value); setChosenVersion(undefined); }} options={published.map(row => ({ value: row.id, label: row.name }))} />
            {choices.length ? <NativeSelect id="cmp-version" label="Published version" value={activeVersion ?? ''} onChange={setChosenVersion} options={[...(activeVersion && !choices.some(row => row.id === activeVersion) ? [{ value: activeVersion, label: 'Requested exact version (loading or unavailable)' }] : []), ...choices.map(row => ({ value: row.id, label: `Version ${row.version} · ${row.cases.length} cases` }))]} /> : null}
          </div>
          {versions.status === 'loading' ? <SkeletonPanel label="Loading versions" /> : null}
          {versions.error ? <ErrorState error={versions.error} what="the latest complete suite-version history (showing stale saved data if available)" onRetry={versions.reload} retrying={versions.reloading} /> : null}
          {activeVersion && exact.status === 'loading' ? <SkeletonPanel label="Loading the exact published version" /> : null}
          {activeVersion && exact.error ? <ErrorState error={exact.error} what="the requested exact suite version" onRetry={exact.reload} retrying={exact.reloading} /> : null}
          {exact.status === 'ready' && !version && !exact.error ? <ErrorState error={{ kind: 'conflict', message: 'The published snapshot does not match the requested project, suite and exact version.' }} what="the requested exact suite version" onRetry={exact.reload} retrying={exact.reloading} /> : null}
          {version && versions.status === 'ready' && !exact.error && !versions.error && !suites.error ? <ComparisonForm key={`${projectId}:${version.id}`} projectId={projectId} version={version} /> : null}
        </Panel>
      ) : null}
    </div>
  );
}
