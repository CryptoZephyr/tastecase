'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Time } from '@/components/ui/data';
import { Field, NativeSelect } from '@/components/ui/field';
import { Section } from '@/components/ui/page';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { UiError } from '@/lib/api/result';
import type { CatalogEntry, CatalogVersion, MappingConfirmation } from '@/lib/api/types';
import { all, useResource } from '@/lib/api/use-resource';
import { newId, SCHEMA_VERSION } from '@/lib/ids';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function MappingRow({ projectId, catalog, entry, mapping, onSaved }: {
  projectId: string; catalog: CatalogVersion; entry: CatalogEntry; mapping?: MappingConfirmation; onSaved: () => void;
}) {
  const api = useApi();
  const [custom, setCustom] = useState(false);
  const [entityId, setEntityId] = useState(entry.qlooEntityId ?? '');
  const [requestId] = useState(newId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const valid = UUID.test(entityId.trim());

  async function confirm() {
    setPending(true); setError(null);
    const result = await api.mappings.create(projectId, { schema_version: SCHEMA_VERSION, id: requestId, catalogVersionId: catalog.id, catalogEntryId: entry.id, qlooEntityId: entityId.trim().toLowerCase() });
    setPending(false);
    if (result.ok) onSaved(); else setError(result.error);
  }

  return (
    <li className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:items-start">
      <div className="min-w-0">
        <p className="font-medium break-words">{entry.name}</p>
        <p className="font-mono text-meta text-ink-2 break-all">{entry.id}</p>
      </div>
      <div className="min-w-0 space-y-2">
        {mapping ? (
          <>
            <Badge>Confirmed</Badge>
            <p className="text-meta text-ink-2">Qloo entity <code className="break-all">{mapping.qlooEntityId}</code> · <Time iso={mapping.createdAt} /></p>
          </>
        ) : entry.qlooEntityId && !custom ? (
          <>
            <p className="text-control">Candidate Qloo entity <code className="break-all">{entry.qlooEntityId}</code> — supplied with your catalog, not yet confirmed.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onPress={() => void confirm()} isPending={pending} pendingLabel="Confirming">Confirm this match</Button>
              <Button variant="text" onPress={() => { setCustom(true); setEntityId(''); }}>Use a different ID</Button>
            </div>
          </>
        ) : (
          <>
            {!custom ? <p className="text-control text-ink-2">No Qloo candidate. Unless you confirm one, this restaurant stays unmapped and its ranking coverage is shown as unavailable.</p> : null}
            {custom || !entry.qlooEntityId ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <Field label={`Qloo entity ID for ${entry.name}`} value={entityId} onChange={setEntityId} mono className="flex-1"
                  errorMessage={entityId && !valid ? 'Enter a Qloo entity UUID.' : null} />
                <Button variant="secondary" onPress={() => void confirm()} isPending={pending} isDisabled={!valid}>Confirm</Button>
              </div>
            ) : null}
          </>
        )}
        {error ? <ErrorState error={error} what="this mapping" /> : null}
      </div>
    </li>
  );
}

export function MappingStep({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const api = useApi();
  const data = useResource(() => all([api.catalogs.list(projectId), api.mappings.list(projectId)] as const), [api, projectId, refreshKey]);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Section id="mappings" title="3. Confirm Qloo mappings" description="Tell TasteCase which public Qloo entity each restaurant is. Confirmations are explicit and immutable; TasteCase never confirms a guess for you.">
      {data.status === 'loading' ? <SkeletonRows rows={2} label="Loading catalog mappings" /> : null}
      {data.status === 'error' ? <ErrorState error={data.error} what="catalog mappings" onRetry={data.reload} retrying={data.reloading} /> : null}
      {data.status === 'ready' ? (() => {
        const [catalogs, mappings] = data.data;
        if (!catalogs.length) return <p className="text-ink-2">Import a catalog first; its restaurants will appear here.</p>;
        const catalog = catalogs.find(row => row.id === selected) ?? catalogs[catalogs.length - 1];
        const confirmed = new Map(mappings.filter(row => row.catalogVersionId === catalog.id).map(row => [row.catalogEntryId, row]));
        return (
          <div className="space-y-4">
            {catalogs.length > 1 ? (
              <NativeSelect id="mapping-catalog" label="Catalog version" value={catalog.id} onChange={setSelected} className="max-w-md"
                options={catalogs.map(row => ({ value: row.id, label: `${row.label} (${row.entries.length} restaurants)` }))} />
            ) : null}
            <p className="text-control text-ink-2">{confirmed.size} of {catalog.entries.length} restaurants confirmed. A discovery job can rank at most 10 mapped restaurants; larger sets are refused, not truncated.</p>
            <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
              {catalog.entries.map(entry => <MappingRow key={`${catalog.id}:${entry.id}`} projectId={projectId} catalog={catalog} entry={entry} mapping={confirmed.get(entry.id)} onSaved={() => void data.reload()} />)}
            </ul>
          </div>
        );
      })() : null}
    </Section>
  );
}
