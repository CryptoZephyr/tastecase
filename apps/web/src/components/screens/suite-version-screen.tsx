'use client';

import Link from 'next/link';
import { ProfileTag } from '@/components/case/labels';
import { ClassBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Facts, Hash, Time } from '@/components/ui/data';
import { PageHeader, Section } from '@/components/ui/page';
import { SkeletonPanel } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { all, useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';
import { describeExpectation } from '@/lib/view/expectation-text';

export function SuiteVersionScreen({ projectId, suiteId, versionId }: { projectId: string; suiteId: string; versionId: string }) {
  const api = useApi();
  const data = useResource(() => all([api.suites.get(projectId, suiteId), api.suites.version(projectId, suiteId, versionId)] as const), [api, projectId, suiteId, versionId]);
  if (data.status === 'loading') return <SkeletonPanel label="Loading the published version" />;
  if (data.status === 'error') return <ErrorState error={data.error} what="this suite version" onRetry={data.reload} retrying={data.reloading} />;
  const [suite, version] = data.data;
  return (
    <div className="space-y-10">
      <PageHeader title={`${suite.name} · version ${version.version}`} description="An immutable snapshot: each case with the expectation and evidence pinned when it was approved."
        actions={<ButtonLink href={routes.newComparison(projectId, suiteId, versionId)}>Compare two releases</ButtonLink>} />
      <Facts columns={3} items={[['Published', <Time key="t" iso={version.createdAt} />], ['Cases', version.cases.length], ['Suite checksum', <Hash key="h" value={version.checksum} label="suite checksum" />]]} />
      <Section title="Cases in this version">
        <ol className="space-y-4">
          {version.cases.map((row, index) => {
            const evidence = row.review.decision.evidence;
            const catalog = new Map(evidence.job.input.targetInput.catalog.entries.map(entry => [entry.id, entry.name]));
            const name = (id: string) => catalog.get(id) ?? id;
            const expectation = row.review.expectationVersion!.expectation;
            const [x, y] = evidence.candidate.content.contrast.entryIds;
            return (
              <li key={row.case.id} className="rounded-panel border border-rule bg-surface p-4 md:p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-meta text-ink-2">Case {index + 1}</span>
                  <Link href={routes.case(projectId, row.case.id)} className="font-medium underline-offset-4 hover:underline break-words">{name(x)} and {name(y)}</Link>
                  <ClassBadge classification={expectation.classification} />
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {(['a', 'b'] as const).map(profile => (
                    <div key={profile} className="rounded-control bg-subtle p-3">
                      <ProfileTag profile={profile} />
                      <p className="mt-1 text-control">{evidence.candidate.content.briefs[profile].label}</p>
                    </div>
                  ))}
                </div>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-control">{describeExpectation(expectation, name).map(line => <li key={line}>{line}</li>)}</ul>
                <p className="mt-3 text-control"><span className="text-ink-2">Reviewer rationale:</span> {row.review.decision.rationale}</p>
                <p className="mt-2 flex flex-wrap items-center gap-1 text-meta text-ink-2">
                  Pinned evidence: {evidence.coverage.completedFullAttempts} of {evidence.coverage.intendedFullAttempts} intended full runs completed · evidence <Hash value={evidence.checksum} label="evidence checksum" />
                </p>
              </li>
            );
          })}
        </ol>
      </Section>
    </div>
  );
}
