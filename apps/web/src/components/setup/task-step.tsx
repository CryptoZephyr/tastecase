'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, CheckboxGroup } from '@/components/ui/choice';
import { Facts, Hash, Time } from '@/components/ui/data';
import { Field, NativeSelect } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Section } from '@/components/ui/page';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState, Receipt } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import type { CatalogVersion, CreateTaskVersionRequest, TaskVersion } from '@/lib/api/types';
import { all, useResource } from '@/lib/api/use-resource';
import { formatMoney } from '@/lib/format';
import { newId, SCHEMA_VERSION } from '@/lib/ids';

const tags = (value: string) => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];

function minorUnits(amount: string, currency: string): number | null {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) return null;
  let digits = 2;
  try { digits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return null; }
  return Math.round(value * 10 ** digits);
}

export function constraintSummary(task: TaskVersion): string {
  const c = task.constraints;
  return [`Party of ${c.partySize}`, c.location ? `${c.location.city}${c.location.countryCode ? `, ${c.location.countryCode}` : ''}` : null,
    c.budgetPerPerson ? `${formatMoney(c.budgetPerPerson.amountMinor, c.budgetPerPerson.currency)} per person` : null,
    c.dietaryRequirements.length ? c.dietaryRequirements.join(', ') : null, c.accessibilityRequirements.length ? c.accessibilityRequirements.join(', ') : null,
    c.excludedEntryIds.length ? `${c.excludedEntryIds.length} excluded` : null].filter(Boolean).join(' · ');
}

function TaskForm({ projectId, catalogs, onSaved }: { projectId: string; catalogs: CatalogVersion[]; onSaved: (task: TaskVersion) => void }) {
  const api = useApi();
  const [catalogId, setCatalogId] = useState(catalogs[catalogs.length - 1].id);
  const [label, setLabel] = useState('');
  const [briefLabel, setBriefLabel] = useState('');
  const [brief, setBrief] = useState('');
  const [interests, setInterests] = useState<{ key: string; label: string; text: string }[]>([]);
  const [partySize, setPartySize] = useState('2');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [amount, setAmount] = useState('');
  const [dietary, setDietary] = useState('');
  const [accessibility, setAccessibility] = useState('');
  const [cuisines, setCuisines] = useState('');
  const [excluded, setExcluded] = useState<string[]>([]);
  const [requestId, setRequestId] = useState(newId);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(false);
  const catalog = catalogs.find(row => row.id === catalogId) ?? catalogs[0];
  const touch = () => setRequestId(newId());

  function build(): CreateTaskVersionRequest | null {
    const next: Record<string, string> = {};
    const party = Number(partySize);
    if (!label.trim()) next.label = 'Give this task version a label.';
    if (!briefLabel.trim()) next.briefLabel = 'Name the synthetic brief.';
    if (!brief.trim()) next.brief = 'Describe the fictional request.';
    if (!Number.isInteger(party) || party < 1 || party > 10000) next.partySize = 'Enter a whole number of people (1 or more).';
    if (country && !/^[A-Z]{2}$/.test(country.trim().toUpperCase())) next.country = 'Use a two-letter country code, such as US.';
    if (country && !city.trim()) next.city = 'Add the city for this country.';
    const hasBudget = currency.trim() || amount.trim();
    const minor = hasBudget ? minorUnits(amount, currency.trim().toUpperCase()) : null;
    if (hasBudget && !/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) next.currency = 'Use a three-letter currency code, such as USD.';
    if (hasBudget && minor === null) next.amount = 'Enter a non-negative amount.';
    interests.forEach(row => { if (!row.label.trim() || !row.text.trim()) next[`interest-${row.key}`] = 'Each interest needs a label and text.'; });
    setErrors(next);
    if (Object.keys(next).length) return null;
    return {
      schema_version: SCHEMA_VERSION, id: requestId, label: label.trim(), catalogVersionId: catalog.id,
      syntheticBrief: { provenance: 'synthetic', label: briefLabel.trim(), text: brief.trim() },
      syntheticInterests: interests.map(row => ({ provenance: 'synthetic' as const, label: row.label.trim(), text: row.text.trim() })),
      constraints: {
        partySize: party,
        ...(city.trim() ? { location: { city: city.trim(), ...(country.trim() ? { countryCode: country.trim().toUpperCase() } : {}) } } : {}),
        ...(hasBudget && minor !== null ? { budgetPerPerson: { currency: currency.trim().toUpperCase(), amountMinor: minor } } : {}),
        dietaryRequirements: tags(dietary), accessibilityRequirements: tags(accessibility), requiredCuisines: tags(cuisines), excludedEntryIds: excluded,
      },
    };
  }

  async function submit() {
    const body = build();
    if (!body) return;
    setPending(true); setError(null);
    const result = await api.tasks.create(projectId, body);
    setPending(false);
    if (result.ok) { onSaved(result.data); setRequestId(newId()); } else setError(result.error);
  }

  return (
    <form noValidate onSubmit={event => { event.preventDefault(); void submit(); }} onChange={touch} className="space-y-6 rounded-panel border border-rule bg-surface p-4 md:p-6">
      <Notice tone="info" title="Use fictional text only">Briefs and interests must be synthetic. Don’t paste real guest names, histories or contact details.</Notice>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Task version label" value={label} onChange={setLabel} isRequired maxLength={160} errorMessage={errors.label} />
        {catalogs.length > 1 ? <NativeSelect id="task-catalog" label="Catalog version" value={catalog.id} onChange={value => { setCatalogId(value); setExcluded([]); }}
          options={catalogs.map(row => ({ value: row.id, label: row.label }))} /> : <div><p className="text-control font-medium">Catalog version</p><p className="mt-2 text-control">{catalog.label}</p></div>}
      </div>
      <fieldset className="space-y-4">
        <legend className="text-body font-medium">Synthetic brief</legend>
        <Field label="Brief label" value={briefLabel} onChange={setBriefLabel} isRequired maxLength={160} errorMessage={errors.briefLabel} />
        <Field label="Brief" value={brief} onChange={setBrief} isRequired multiline rows={4} maxLength={8000} errorMessage={errors.brief}
          description="The fictional dining request your assistant receives, for example a traveller’s dinner plans." />
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-body font-medium">Synthetic interests <span className="text-control font-normal text-ink-2">(optional)</span></legend>
        {interests.map((row, index) => (
          <div key={row.key} className="grid gap-3 rounded-control bg-subtle p-3 md:grid-cols-[1fr_2fr_auto] md:items-end">
            <Field label={`Interest ${index + 1} label`} value={row.label} onChange={value => setInterests(list => list.map(item => item.key === row.key ? { ...item, label: value } : item))} maxLength={160} />
            <Field label={`Interest ${index + 1} text`} value={row.text} onChange={value => setInterests(list => list.map(item => item.key === row.key ? { ...item, text: value } : item))} maxLength={8000} errorMessage={errors[`interest-${row.key}`]} />
            <Button variant="text" onPress={() => setInterests(list => list.filter(item => item.key !== row.key))} icon={<Trash2 aria-hidden className="size-4" strokeWidth={1.75} />}>Remove</Button>
          </div>
        ))}
        <Button variant="secondary" onPress={() => setInterests(list => [...list, { key: newId(), label: '', text: '' }])} isDisabled={interests.length >= 100} icon={<Plus aria-hidden className="size-4" strokeWidth={1.75} />}>Add an interest</Button>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="text-body font-medium">Practical constraints</legend>
        <p className="text-control text-ink-2">These stay identical for every profile and repeat. Leave optional facts empty rather than guessing.</p>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Party size" value={partySize} onChange={setPartySize} isRequired inputMode="numeric" errorMessage={errors.partySize} />
          <Field label="City" value={city} onChange={setCity} maxLength={160} errorMessage={errors.city} />
          <Field label="Country code" value={country} onChange={setCountry} maxLength={2} errorMessage={errors.country} description="Two letters, such as US." />
          <Field label="Budget currency" value={currency} onChange={setCurrency} maxLength={3} errorMessage={errors.currency} description="Three letters, such as USD." />
          <Field label="Budget per person" value={amount} onChange={setAmount} inputMode="decimal" errorMessage={errors.amount} description="In the currency’s main unit." />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Dietary requirements" value={dietary} onChange={setDietary} description="Comma-separated." />
          <Field label="Accessibility requirements" value={accessibility} onChange={setAccessibility} description="Comma-separated." />
          <Field label="Required cuisines" value={cuisines} onChange={setCuisines} description="Comma-separated." />
        </div>
        <CheckboxGroup label="Excluded restaurants" description="Restaurants the assistant must never recommend for this task. These become objective exclusion checks only if you approve them later." value={excluded} onChange={setExcluded}>
          <div className="grid max-h-72 overflow-y-auto rounded-control border border-rule px-3 sm:grid-cols-2">
            {catalog.entries.map(entry => <Checkbox key={entry.id} value={entry.id}>{entry.name}</Checkbox>)}
          </div>
        </CheckboxGroup>
      </fieldset>
      {Object.keys(errors).length ? <p role="alert" className="text-control font-medium text-failed">Fix the highlighted fields to save. Everything you entered is kept.</p> : null}
      {error && isUncertain(error) ? <Notice tone="advisory" title="We couldn’t confirm the save" actions={<Button variant="secondary" type="submit" isPending={pending}>Retry the same save</Button>}><p>Retrying reuses the same task version ID, so nothing is duplicated.</p></Notice>
        : error ? <ErrorState error={error} what="the task version" /> : null}
      <Button type="submit" isPending={pending} pendingLabel="Saving task version">Save task version</Button>
    </form>
  );
}

export function TaskStep({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const api = useApi();
  const data = useResource(() => all([api.catalogs.list(projectId), api.tasks.list(projectId)] as const), [api, projectId, refreshKey]);
  const [saved, setSaved] = useState<TaskVersion | null>(null);
  return (
    <Section id="task" title="4. Define the task and constraints" description="What your assistant is asked to do, and the practical constraints held fixed while the cultural interests vary.">
      {data.status === 'loading' ? <SkeletonRows rows={1} label="Loading task versions" /> : null}
      {data.status === 'error' ? <ErrorState error={data.error} what="task versions" onRetry={data.reload} retrying={data.reloading} /> : null}
      {data.status === 'ready' ? (() => {
        const [catalogs, tasks] = data.data;
        return (
          <div className="space-y-5">
            {tasks.length ? (
              <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
                {tasks.map(task => (
                  <li key={task.id} className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="min-w-0"><p className="font-medium break-words">{task.label}</p><p className="text-meta text-ink-2">{constraintSummary(task)} · saved <Time iso={task.createdAt} /></p></div>
                    <Hash value={task.checksum} label="task checksum" />
                  </li>
                ))}
              </ul>
            ) : <p className="text-ink-2">No task version yet.</p>}
            {saved ? <Receipt title="Task version saved"><Facts items={[['Label', saved.label], ['Constraints', constraintSummary(saved)], ['Checksum', <Hash key="h" value={saved.checksum} label="task checksum" />]]} /></Receipt> : null}
            {catalogs.length ? <TaskForm projectId={projectId} catalogs={catalogs} onSaved={task => { setSaved(task); void data.reload(); }} /> : <p className="text-ink-2">Import a catalog first; a task pins one catalog version.</p>}
          </div>
        );
      })() : null}
    </Section>
  );
}

