'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Time } from '@/components/ui/data';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { PageHeader, Section } from '@/components/ui/page';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import { useResource } from '@/lib/api/use-resource';
import { newId, SCHEMA_VERSION } from '@/lib/ids';
import { routes } from '@/lib/routes';

export function SuitesScreen({ projectId }: { projectId: string }) {
  const api = useApi();
  const suites = useResource(() => api.suites.list(projectId, { limit: 20 }), [api, projectId]);
  const [name, setName] = useState('');
  const [requestId, setRequestId] = useState(newId);
  const [error, setError] = useState<UiError | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function create() {
    if (!name.trim()) return setFieldError('Name the suite.');
    setPending(true); setError(null); setFieldError(null);
    const result = await api.suites.create(projectId, { schema_version: SCHEMA_VERSION, id: requestId, name: name.trim() });
    setPending(false);
    if (result.ok) { setName(''); setRequestId(newId()); void suites.reload(); } else setError(result.error);
  }

  return (
    <div className="space-y-10">
      <PageHeader title="Suites" description="A suite collects approved cases. Each publication is an immutable version: later edits, rejections or runner results can’t change it." />
      <Section title="Your suites">
        {suites.status === 'loading' ? <SkeletonRows rows={2} label="Loading suites" /> : null}
        {suites.status === 'error' ? <ErrorState error={suites.error} what="suites" onRetry={suites.reload} retrying={suites.reloading} /> : null}
        {suites.status === 'ready' && !suites.data.length ? <EmptyState title="No suites yet"><p>Create a suite below, then publish approved cases into it.</p></EmptyState> : null}
        {suites.status === 'ready' && suites.data.length ? (
          <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
            {suites.data.map(suite => (
              <li key={suite.id} className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <Link href={routes.suite(projectId, suite.id)} className="font-medium underline-offset-4 hover:underline break-words">{suite.name}</Link>
                  <p className="text-meta text-ink-2">{suite.currentVersion ? `Version ${suite.currentVersion} published` : 'Nothing published yet'} · created <Time iso={suite.createdAt} /></p>
                </div>
                <Link href={routes.suite(projectId, suite.id)} className="inline-flex min-h-11 items-center gap-1.5 text-control font-medium text-action underline-offset-4 hover:underline">{suite.currentVersion ? 'Open' : 'Publish'}<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} /></Link>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
      <Section title="Create a suite">
        <form noValidate onSubmit={event => { event.preventDefault(); void create(); }} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Suite name" value={name} onChange={value => { setName(value); setRequestId(newId()); setFieldError(null); }} isRequired maxLength={160} errorMessage={fieldError} className="sm:w-96" />
          <Button type="submit" isPending={pending} pendingLabel="Creating">Create suite</Button>
        </form>
        {error && isUncertain(error) ? <Notice className="mt-3" tone="advisory" title="We couldn’t confirm the suite was created" actions={<Button variant="secondary" onPress={() => void create()} isPending={pending}>Retry the same request</Button>}><p>Retrying reuses the same suite ID, so nothing is duplicated.</p></Notice>
          : error ? <ErrorState className="mt-3" error={error} what="the new suite" /> : null}
      </Section>
    </div>
  );
}
