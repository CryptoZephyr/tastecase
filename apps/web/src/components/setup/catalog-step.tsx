'use client';

import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Form } from 'react-aria-components';
import { Button } from '@/components/ui/button';
import { Facts, Hash, Time } from '@/components/ui/data';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Section } from '@/components/ui/page';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState, Receipt } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import type { CatalogEntry, CatalogVersion } from '@/lib/api/types';
import { useResource } from '@/lib/api/use-resource';
import { newId, SCHEMA_VERSION } from '@/lib/ids';
import { parseCatalogJson, type ImportIssue } from '@/lib/view/catalog-import';

const EXAMPLE = `[
  {
    "id": "your-stable-restaurant-id",
    "name": "Restaurant name",
    "metadata": { "city": "City", "countryCode": "US", "cuisines": ["Cuisine"] },
    "constraintFacts": { "dietaryOptions": ["vegetarian"], "maxPartySize": 8 },
    "qlooEntityId": "<optional candidate Qloo entity UUID>"
  }
]`;

function Preview({ entries }: { entries: CatalogEntry[] }) {
  const shown = entries.slice(0, 50);
  return (
    <div tabIndex={0} role="region" aria-label="Catalog preview" className="overflow-x-auto rounded-control border border-rule">
      <table className="w-full min-w-[36rem] text-left text-control">
        <caption className="sr-only">Catalog preview</caption>
        <thead className="bg-subtle text-meta text-ink-2">
          <tr><th scope="col" className="px-3 py-2 font-medium">ID</th><th scope="col" className="px-3 py-2 font-medium">Name</th><th scope="col" className="px-3 py-2 font-medium">City</th><th scope="col" className="px-3 py-2 font-medium">Qloo candidate</th></tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {shown.map(entry => (
            <tr key={entry.id}>
              <td className="px-3 py-2 font-mono text-meta break-all">{entry.id}</td>
              <td className="px-3 py-2">{entry.name}</td>
              <td className="px-3 py-2 text-ink-2">{entry.metadata?.city ?? 'Not given'}</td>
              <td className="px-3 py-2 text-ink-2">{entry.qlooEntityId ? 'Candidate supplied' : 'None'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entries.length > shown.length ? <p className="border-t border-rule px-3 py-2 text-meta text-ink-2">Showing 50 of {entries.length} restaurants.</p> : null}
    </div>
  );
}

export function CatalogStep({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const api = useApi();
  const catalogs = useResource(() => api.catalogs.list(projectId), [api, projectId]);
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [requestId, setRequestId] = useState(newId);
  const [error, setError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState<CatalogVersion | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function check(value: string) {
    setText(value); setSaved(null); setError(null);
    if (!value.trim()) { setIssues([]); setEntries(null); return; }
    const parsed = parseCatalogJson(value);
    setIssues(parsed.ok ? [] : parsed.issues);
    setEntries(parsed.ok ? parsed.entries : null);
    setRequestId(newId());
  }

  async function submit() {
    if (!entries || !label.trim()) return;
    setPending(true); setError(null);
    const result = await api.catalogs.create(projectId, { schema_version: SCHEMA_VERSION, id: requestId, label: label.trim(), entries });
    setPending(false);
    if (result.ok) { setSaved(result.data); setText(''); setEntries(null); setLabel(''); setRequestId(newId()); void catalogs.reload(); onSaved(); }
    else setError(result.error);
  }

  return (
    <Section id="catalog" title="2. Import your restaurant catalog" description="The restaurants your assistant may recommend. Each import is an immutable version with a checksum; later imports never change earlier results.">
      <div className="space-y-5">
        {catalogs.status === 'loading' ? <SkeletonRows rows={1} label="Loading catalog versions" /> : null}
        {catalogs.status === 'error' ? <ErrorState error={catalogs.error} what="catalog versions" onRetry={catalogs.reload} retrying={catalogs.reloading} /> : null}
        {catalogs.status === 'ready' && catalogs.data.length > 0 ? (
          <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
            {catalogs.data.map(row => (
              <li key={row.id} className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0"><p className="font-medium break-words">{row.label}</p><p className="text-meta text-ink-2">{row.entries.length} restaurants · imported <Time iso={row.createdAt} /></p></div>
                <Hash value={row.checksum} label="catalog checksum" />
              </li>
            ))}
          </ul>
        ) : null}
        {catalogs.status === 'ready' && catalogs.data.length === 0 ? <p className="text-ink-2">No catalog imported yet.</p> : null}
        {saved ? (
          <Receipt title="Catalog version saved">
            <Facts items={[['Label', saved.label], ['Restaurants', saved.entries.length], ['Saved', <Time key="t" iso={saved.createdAt} />], ['Checksum', <Hash key="h" value={saved.checksum} label="catalog checksum" />]]} />
          </Receipt>
        ) : null}
        <Form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-4 rounded-panel border border-rule bg-surface p-4 md:p-6">
          <Field label="Version label" value={label} onChange={value => { setLabel(value); setRequestId(newId()); }} isRequired maxLength={160} description="For example, “Spring menu 2026”." />
          <Field label="Restaurants (JSON)" value={text} onChange={check} multiline rows={8} mono
            description="Paste a JSON array, or choose a .json file. Optional facts that are missing stay unknown — never treated as yes or no."
            errorMessage={issues.length ? `${issues.length} problem${issues.length === 1 ? '' : 's'} found — see below.` : null} />
          <div className="flex flex-wrap items-center gap-3">
            <input ref={fileInput} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-hidden
              onChange={async event => { const file = event.target.files?.[0]; if (file) check(await file.text()); event.target.value = ''; }} />
            <Button variant="secondary" onPress={() => fileInput.current?.click()} icon={<Upload aria-hidden className="size-4" strokeWidth={1.75} />}>Choose a .json file</Button>
            <details className="text-control">
              <summary className="min-h-11 cursor-pointer py-3 text-action underline-offset-4 hover:underline">Show the expected shape</summary>
              <pre className="mt-2 overflow-x-auto rounded-control bg-subtle p-3 font-mono text-meta whitespace-pre-wrap">{EXAMPLE}</pre>
            </details>
          </div>
          {issues.length ? (
            <ul className="space-y-1 rounded-control bg-failed-bg p-3 text-control" aria-label="Catalog problems">
              {issues.slice(0, 20).map((issue, index) => <li key={index}><span className="font-medium">{issue.line}:</span> {issue.message}</li>)}
              {issues.length > 20 ? <li>…and {issues.length - 20} more.</li> : null}
            </ul>
          ) : null}
          {entries ? <Preview entries={entries} /> : null}
          {error && error.kind === 'conflict' ? <Notice tone="advisory" title="That version ID already exists with different content">Your file is kept. Submitting again sends it as a new version.</Notice> : null}
          {error && isUncertain(error) ? <Notice tone="advisory" title="We couldn’t confirm the import" actions={<Button variant="secondary" type="submit" isPending={pending}>Retry the same import</Button>}>
            <p>Retrying reuses the same version ID, so a version that did save won’t be duplicated.</p></Notice> : null}
          {error && error.kind !== 'conflict' && !isUncertain(error) ? <ErrorState error={error} what="the catalog import" /> : null}
          <div>
            <Button type="submit" isPending={pending} pendingLabel="Saving catalog version" isDisabled={!entries || !label.trim()} aria-describedby="catalog-submit-hint">Save catalog version</Button>
            {!entries || !label.trim() ? <p id="catalog-submit-hint" className="mt-2 text-meta text-ink-2">Add a label and a valid restaurant list to save.</p> : null}
          </div>
        </Form>
      </div>
    </Section>
  );
}
