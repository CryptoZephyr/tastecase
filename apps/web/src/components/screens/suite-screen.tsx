'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { startTransition, useState, ViewTransition } from 'react';
import { ClassBadge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Checkbox, CheckboxGroup } from '@/components/ui/choice';
import { Facts, Hash, Time } from '@/components/ui/data';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { PageHeader, Section } from '@/components/ui/page';
import { SkeletonPanel, SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, Receipt } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import type { PublishSuiteRequest, ReviewCaseResponse, SuiteIdentity, SuiteVersion } from '@/lib/api/types';
import { all, useResource } from '@/lib/api/use-resource';
import { newId, SCHEMA_VERSION } from '@/lib/ids';
import { routes } from '@/lib/routes';

const caseTitle = (row: { candidate: ReviewCaseResponse['candidate'] }) => `${row.candidate.content.briefs.a.label} / ${row.candidate.content.briefs.b.label}`;

function PublishPanel({ projectId, suite, cases, onPublished }: { projectId: string; suite: SuiteIdentity; cases: ReviewCaseResponse[]; onPublished: () => void }) {
  const api = useApi();
  const approved = cases.filter(row => (row.head.status === 'accepted' || row.head.status === 'edited') && row.head.approvedExpectationVersionId);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingBody, setPendingBody] = useState<PublishSuiteRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [published, setPublished] = useState<SuiteVersion | null>(null);

  async function send(body: PublishSuiteRequest, close?: () => void) {
    setPending(true); setError(null); setPendingBody(body);
    const result = await api.suites.publish(projectId, suite.id, body);
    setPending(false); close?.();
    if (result.ok) {
      // Backend-confirmed: carry each case title into its suite entry (no motion when reduced motion is set).
      startTransition(() => { setPublished(result.data.suite); setPendingBody(null); setSelected([]); });
      onPublished();
    } else setError(result.error);
  }

  function publish(close: () => void) {
    const body: PublishSuiteRequest = { schema_version: SCHEMA_VERSION, id: newId(), suiteId: suite.id, expectedVersion: suite.currentVersion,
      cases: approved.filter(row => selected.includes(row.case.id)).map(row => ({ caseId: row.case.id, expectationVersionId: row.head.approvedExpectationVersionId!, expectedReviewRevision: row.head.revision })) };
    void send(body, close);
  }

  if (published) {
    return (
      <Receipt title={`Version ${published.version} published`} actions={<>
        <ButtonLink href={routes.suiteVersion(projectId, suite.id, published.id)}>Open version {published.version}</ButtonLink>
        <ButtonLink variant="secondary" href={routes.newComparison(projectId, suite.id, published.id)}>Compare two releases</ButtonLink>
        <Button variant="text" onPress={() => setPublished(null)}>Publish another version</Button>
      </>}>
        <Facts items={[['Published', <Time key="t" iso={published.createdAt} />], ['Cases', published.cases.length], ['Suite checksum', <Hash key="h" value={published.checksum} label="suite checksum" />]]} />
        <ul className="mt-4 space-y-1">
          {published.cases.map(row => (
            <li key={row.case.id}><ViewTransition name={`suite-case-${row.case.id}`}><span className="inline-block font-medium">{row.review.decision.evidence.candidate.content.briefs.a.label} / {row.review.decision.evidence.candidate.content.briefs.b.label}</span></ViewTransition></li>
          ))}
        </ul>
      </Receipt>
    );
  }

  if (!approved.length) {
    return <EmptyState title="No approved cases to publish" action={<ButtonLink href={routes.cases(projectId)}>Review cases</ButtonLink>}><p>Accept or edit a case’s expectation first. Rejected, deferred and unreviewed cases can’t be published.</p></EmptyState>;
  }
  return (
    <div className="space-y-4 rounded-panel border border-rule bg-surface p-4 md:p-6">
      <CheckboxGroup label="Approved cases" value={selected} onChange={setSelected} description="Each case is published with its current approved expectation and the evidence pinned at approval. Maximum 50.">
        {approved.map(row => (
          <Checkbox key={row.case.id} value={row.case.id}>
            <ViewTransition name={`suite-case-${row.case.id}`}><span className="inline-block font-medium">{caseTitle(row)}</span></ViewTransition>
            <span className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ink-2">{row.currentReview?.expectationVersion ? <ClassBadge classification={row.currentReview.expectationVersion.expectation.classification} /> : null} review revision {row.head.revision}</span>
          </Checkbox>
        ))}
      </CheckboxGroup>
      {error?.kind === 'conflict' ? <Notice tone="advisory" title="The suite or a selected case changed" role="alert" actions={<Button variant="secondary" onPress={onPublished}>Reload the latest</Button>}>
        <p>Nothing was published — one stale, rejected or superseded case rejects the whole publication. Your selection is kept; reload and check it.</p></Notice>
        : error && isUncertain(error) && pendingBody ? <Notice tone="advisory" title="We couldn’t confirm the publication" role="alert" actions={<Button variant="secondary" onPress={() => void send(pendingBody)} isPending={pending}>Retry the same publication</Button>}>
          <p>Retrying sends the identical request, so it can’t publish twice.</p></Notice>
        : error ? <ErrorState error={error} what="the publication" /> : null}
      <ConfirmDialog title={`Publish version ${suite.currentVersion + 1}?`} confirmLabel="Publish" confirmVariant="primary" isPending={pending} onConfirm={publish}
        trigger={<Button isDisabled={!selected.length || selected.length > 50}>Publish {selected.length || ''} case{selected.length === 1 ? '' : 's'}</Button>}>
        <p>Version {suite.currentVersion + 1} will contain {selected.length} case{selected.length === 1 ? '' : 's'} with their approved expectations and pinned evidence.</p>
        <p>Published versions are immutable. Earlier versions stay exactly as they are.</p>
      </ConfirmDialog>
      {!selected.length ? <p className="text-meta text-ink-2">Select at least one approved case to publish.</p> : null}
    </div>
  );
}

export function SuiteScreen({ projectId, suiteId }: { projectId: string; suiteId: string }) {
  const api = useApi();
  const data = useResource(() => all([api.suites.get(projectId, suiteId), api.suites.versions(projectId, suiteId, { limit: 20 })] as const), [api, projectId, suiteId]);
  const cases = useResource(() => api.cases.list(projectId, { limit: 20 }), [api, projectId]);
  if (data.status === 'loading') return <SkeletonPanel label="Loading the suite" />;
  if (data.status === 'error') return <ErrorState error={data.error} what="this suite" onRetry={data.reload} retrying={data.reloading} />;
  const [suite, versions] = data.data;
  return (
    <div className="space-y-10">
      <PageHeader title={suite.name} description={suite.currentVersion ? `Current version ${suite.currentVersion}. Comparisons always reference an exact version.` : 'Nothing published yet.'} />
      <Section title="Published versions">
        {versions.length ? (
          <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
            {[...versions].sort((a, b) => b.version - a.version).map(version => (
              <li key={version.id} className="grid gap-2 p-4 md:grid-cols-[1fr_auto_auto] md:items-center md:gap-4">
                <div className="min-w-0"><Link href={routes.suiteVersion(projectId, suite.id, version.id)} className="font-medium underline-offset-4 hover:underline">Version {version.version}</Link><p className="text-meta text-ink-2">{version.cases.length} case{version.cases.length === 1 ? '' : 's'} · published <Time iso={version.createdAt} /></p></div>
                <Hash value={version.checksum} label="suite checksum" />
                <Link href={routes.suiteVersion(projectId, suite.id, version.id)} className="inline-flex min-h-11 items-center gap-1.5 text-control font-medium text-action underline-offset-4 hover:underline">Open<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} /></Link>
              </li>
            ))}
          </ul>
        ) : <p className="text-ink-2">No versions published yet.</p>}
      </Section>
      <Section title={`Publish version ${suite.currentVersion + 1}`}>
        {cases.status === 'loading' ? <SkeletonRows rows={2} label="Loading approved cases" /> : null}
        {cases.status === 'error' ? <ErrorState error={cases.error} what="approved cases" onRetry={cases.reload} retrying={cases.reloading} /> : null}
        {cases.status === 'ready' ? <PublishPanel projectId={projectId} suite={suite} cases={cases.data} onPublished={() => { void data.reload(); void cases.reload(); }} /> : null}
      </Section>
    </div>
  );
}
