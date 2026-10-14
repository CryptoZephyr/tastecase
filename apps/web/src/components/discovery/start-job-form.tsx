'use client';

import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ProfileTag } from '@/components/case/labels';
import { Button } from '@/components/ui/button';
import { Checkbox, CheckboxGroup } from '@/components/ui/choice';
import { Field, NativeSelect } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import type { CatalogVersion, CreateDiscoveryJobRequest, MappingConfirmation, TaskVersion } from '@/lib/api/types';
import { newId, SCHEMA_VERSION } from '@/lib/ids';
import { routes } from '@/lib/routes';

type Kind = 'music' | 'film' | 'brand';
interface AnchorDraft { id: string; label: string; kind: Kind }
interface ProfileDraft { label: string; anchors: AnchorDraft[] }

const BUDGETS = [
  { key: 'qlooAttempts', label: 'Qloo calls', min: 1, max: 20, initial: 8 },
  { key: 'modelDecisions', label: 'Model decisions', min: 1, max: 8, initial: 2 },
  { key: 'targetAttempts', label: 'Assistant runs', min: 2, max: 12, initial: 6 },
  { key: 'rounds', label: 'Rounds', min: 1, max: 6, initial: 3 },
  { key: 'deadlineSeconds', label: 'Deadline (seconds)', min: 30, max: 3600, initial: 900 },
  { key: 'outputBytes', label: 'Output limit (bytes)', min: 1024, max: 262144, initial: 64000 },
  { key: 'retriesPerOperation', label: 'Retries per operation', min: 0, max: 2, initial: 1 },
] as const;
type BudgetKey = (typeof BUDGETS)[number]['key'];

const emptyProfile = (): ProfileDraft => ({ label: '', anchors: [{ id: newId(), label: '', kind: 'music' }] });

export function StartJobForm({ projectId, catalogs, tasks, mappings }: { projectId: string; catalogs: CatalogVersion[]; tasks: TaskVersion[]; mappings: MappingConfirmation[] }) {
  const api = useApi();
  const router = useRouter();
  const [taskId, setTaskId] = useState(tasks[tasks.length - 1].id);
  const task = tasks.find(row => row.id === taskId) ?? tasks[0];
  const catalog = catalogs.find(row => row.id === task.catalogVersionId);
  const excluded = useMemo(() => new Set(task.constraints.excludedEntryIds), [task]);
  const confirmed = useMemo(() => new Map(mappings.filter(row => row.catalogVersionId === task.catalogVersionId).map(row => [row.catalogEntryId, row])), [mappings, task]);
  const [eligible, setEligible] = useState<string[]>(() => (catalog?.entries ?? []).filter(entry => !excluded.has(entry.id)).map(entry => entry.id));
  const [profiles, setProfiles] = useState<{ a: ProfileDraft; b: ProfileDraft }>({ a: emptyProfile(), b: emptyProfile() });
  const [assistantVersion, setAssistantVersion] = useState('');
  const [repeatCount, setRepeatCount] = useState('2');
  const [reducePair, setReducePair] = useState(true);
  const [budgets, setBudgets] = useState<Record<BudgetKey, string>>(() => Object.fromEntries(BUDGETS.map(row => [row.key, String(row.initial)])) as Record<BudgetKey, string>);
  const [requestId, setRequestId] = useState(newId);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(false);

  if (!catalog) return <Notice tone="unavailable" title="This task’s catalog version didn’t load">Reload the page to try again.</Notice>;
  const mappedEligible = eligible.filter(id => confirmed.has(id));
  const repeats = Number(repeatCount);
  const scheduledRuns = (Number.isInteger(repeats) ? repeats : 0) * 2 + (reducePair ? 2 : 0);

  function updateProfile(id: 'a' | 'b', change: (draft: ProfileDraft) => ProfileDraft) {
    setProfiles(current => ({ ...current, [id]: change(current[id]) }));
  }

  function build(): CreateDiscoveryJobRequest | null {
    const next: Record<string, string> = {};
    if (eligible.length < 2) next.eligible = 'Choose at least two eligible restaurants.';
    if (mappedEligible.length > 10) next.eligible = `Ranking supports at most 10 mapped restaurants; ${mappedEligible.length} are selected. Narrow the selection.`;
    if (mappedEligible.length < 2 && !next.eligible) next.eligible = 'At least two eligible restaurants need confirmed Qloo mappings to be ranked.';
    for (const id of ['a', 'b'] as const) {
      if (!profiles[id].label.trim()) next[`${id}-label`] = 'Name this profile.';
      profiles[id].anchors.forEach(anchor => { if (!anchor.label.trim()) next[`anchor-${anchor.id}`] = 'Enter a public music artist, film or brand.'; });
    }
    if (!assistantVersion.trim()) next.assistantVersion = 'Enter the exact release label your runner uses.';
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) next.repeatCount = 'Choose 1, 2 or 3 repeats.';
    const budgetValues = {} as Record<BudgetKey, number>;
    for (const row of BUDGETS) {
      const value = Number(budgets[row.key]);
      if (!Number.isInteger(value) || value < row.min || value > row.max) next[row.key] = `Use a whole number from ${row.min} to ${row.max}.`;
      budgetValues[row.key] = value;
    }
    setErrors(next);
    if (Object.keys(next).length) return null;
    return {
      schema_version: SCHEMA_VERSION, id: requestId, catalogVersionId: catalog!.id, taskVersionId: task.id,
      mappingConfirmationIds: mappedEligible.map(id => confirmed.get(id)!.id), eligibleCatalogEntryIds: eligible,
      profiles: (['a', 'b'] as const).map(id => ({ id, provenance: 'public_synthetic' as const, label: profiles[id].label.trim(),
        anchors: profiles[id].anchors.map(anchor => ({ id: anchor.id, label: anchor.label.trim(), kind: anchor.kind })) })) as CreateDiscoveryJobRequest['profiles'],
      assistantVersion: assistantVersion.trim(), budgets: budgetValues, repeatCount: repeats, reducePair,
    };
  }

  async function submit() {
    const body = build();
    if (!body) return;
    setPending(true); setError(null);
    const result = await api.discovery.create(projectId, body);
    setPending(false);
    if (result.ok) router.push(routes.job(projectId, result.data.id)); else setError(result.error);
  }

  return (
    <form noValidate onSubmit={event => { event.preventDefault(); void submit(); }} onChange={() => setRequestId(newId())} className="space-y-8 rounded-panel border border-rule bg-surface p-4 md:p-6">
      <div className="grid gap-4 md:grid-cols-2">
        <NativeSelect id="job-task" label="Task version" value={task.id} onChange={value => { setTaskId(value); const nextTask = tasks.find(row => row.id === value); const nextCatalog = catalogs.find(row => row.id === nextTask?.catalogVersionId); setEligible((nextCatalog?.entries ?? []).filter(entry => !nextTask?.constraints.excludedEntryIds.includes(entry.id)).map(entry => entry.id)); }}
          options={tasks.map(row => ({ value: row.id, label: row.label }))} description={`Catalog: ${catalog.label}`} />
        <Field label="Assistant version" value={assistantVersion} onChange={setAssistantVersion} isRequired maxLength={160} errorMessage={errors.assistantVersion}
          description="The exact release label of the configuration your runner executes, such as concierge-prompt-v1." />
      </div>

      <CheckboxGroup label="Eligible restaurants" value={eligible} onChange={setEligible} errorMessage={errors.eligible}
        description={`${mappedEligible.length} selected with a confirmed mapping (maximum 10 ranked). Unmapped selections stay eligible for your assistant but are shown as unranked.`}>
        <div className="grid max-h-80 overflow-y-auto rounded-control border border-rule px-3 sm:grid-cols-2">
          {catalog.entries.map(entry => (
            <Checkbox key={entry.id} value={entry.id} isDisabled={excluded.has(entry.id)}>
              {entry.name}
              <span className="block text-meta text-ink-2">{excluded.has(entry.id) ? 'Excluded by the task' : confirmed.has(entry.id) ? 'Mapping confirmed' : 'No confirmed mapping'}</span>
            </Checkbox>
          ))}
        </div>
      </CheckboxGroup>
      {confirmed.size === 0 ? <Notice tone="advisory" title="No confirmed mappings for this catalog">Rankings need confirmed Qloo mappings. <Link href={routes.setup(projectId, 'mappings')} className="font-medium text-action underline underline-offset-4">Confirm mappings</Link>.</Notice> : null}

      <fieldset className="space-y-3">
        <legend className="text-body font-medium">Two fictional profiles</legend>
        <p className="text-control text-ink-2">Describe each profile through genuinely public interests — music artists, films or brands. No personal data. Constraints and eligible restaurants stay identical for both.</p>
        <div className="grid gap-4 xl:grid-cols-2">
          {(['a', 'b'] as const).map(id => (
            <div key={id} className="space-y-3 rounded-control border border-rule p-4">
              <ProfileTag profile={id} />
              <Field label={`Profile ${id.toUpperCase()} label`} value={profiles[id].label} onChange={value => updateProfile(id, draft => ({ ...draft, label: value }))} isRequired maxLength={160} errorMessage={errors[`${id}-label`]} />
              {profiles[id].anchors.map((anchor, index) => (
                <div key={anchor.id} className="grid gap-2 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
                  <Field label={`Public interest ${index + 1}`} value={anchor.label} maxLength={160} errorMessage={errors[`anchor-${anchor.id}`]}
                    onChange={value => updateProfile(id, draft => ({ ...draft, anchors: draft.anchors.map(row => row.id === anchor.id ? { ...row, label: value } : row) }))} />
                  <NativeSelect id={`kind-${anchor.id}`} label="Kind" value={anchor.kind} options={[{ value: 'music', label: 'Music' }, { value: 'film', label: 'Film' }, { value: 'brand', label: 'Brand' }]}
                    onChange={value => updateProfile(id, draft => ({ ...draft, anchors: draft.anchors.map(row => row.id === anchor.id ? { ...row, kind: value as Kind } : row) }))} />
                  <Button variant="text" isDisabled={profiles[id].anchors.length === 1} aria-label={`Remove public interest ${index + 1}`}
                    onPress={() => updateProfile(id, draft => ({ ...draft, anchors: draft.anchors.filter(row => row.id !== anchor.id) }))} icon={<Trash2 aria-hidden className="size-4" strokeWidth={1.75} />}>Remove</Button>
                </div>
              ))}
              <Button variant="secondary" isDisabled={profiles[id].anchors.length >= 5} onPress={() => updateProfile(id, draft => ({ ...draft, anchors: [...draft.anchors, { id: newId(), label: '', kind: 'music' }] }))}
                icon={<Plus aria-hidden className="size-4" strokeWidth={1.75} />}>Add a public interest</Button>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-body font-medium">Investigation and budgets</legend>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NativeSelect id="repeat-count" label="Repeats per profile" value={repeatCount} onChange={setRepeatCount} options={['1', '2', '3'].map(value => ({ value, label: value }))} />
          <div className="sm:col-span-1 lg:col-span-3"><Checkbox isSelected={reducePair} onChange={setReducePair}>Run a focused follow-up on the contrasting pair<span className="block text-meta text-ink-2">Asks the same question about just the two restaurants. Constraints and the eligible catalog don’t change.</span></Checkbox></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {BUDGETS.map(row => <Field key={row.key} label={row.label} value={budgets[row.key]} inputMode="numeric" errorMessage={errors[row.key]} description={`${row.min}–${row.max}`}
            onChange={value => setBudgets(current => ({ ...current, [row.key]: value }))} />)}
        </div>
        {Number(budgets.targetAttempts) < scheduledRuns ? <Notice tone="advisory" title="These settings schedule more assistant runs than the budget allows">Up to {scheduledRuns} runs are scheduled; the job stops at {budgets.targetAttempts}. Nothing is overspent, but some runs won’t happen.</Notice> : null}
        <p className="text-control text-ink-2">Calls are charged when reserved, including retries and interrupted dispatches. Budgets are maximums, not guarantees that a case will be found.</p>
      </fieldset>

      {Object.keys(errors).length ? <p role="alert" className="text-control font-medium text-failed">Fix the highlighted fields to start. Everything you entered is kept.</p> : null}
      {error && isUncertain(error) ? <Notice tone="advisory" title="We couldn’t confirm the job started" actions={<Button variant="secondary" type="submit" isPending={pending}>Retry the same request</Button>}><p>Retrying reuses the same job ID, so a job that did start won’t be duplicated or charged twice.</p></Notice>
        : error ? <ErrorState error={error} what="the discovery job" /> : null}
      <Button type="submit" isPending={pending} pendingLabel="Starting discovery">Start discovery</Button>
    </form>
  );
}
