'use client';

import { ArrowRight, Check, Circle } from 'lucide-react';
import Link from 'next/link';
import { ButtonLink } from '@/components/ui/button';
import { Time } from '@/components/ui/data';
import { Panel, Section } from '@/components/ui/page';
import { SkeletonPanel } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';
import { loadProjectFacts, nextAction, setupSteps, type ProjectFacts } from '@/lib/view/project-facts';

function LatestWork({ projectId, facts }: { projectId: string; facts: ProjectFacts }) {
  const suite = [...facts.suites].filter(row => row.currentVersion > 0).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const comparison = [...facts.comparisons].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const job = [...facts.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const rows = [
    suite && { label: 'Latest suite', title: `${suite.name} · version ${suite.currentVersion}`, at: suite.createdAt, href: routes.suite(projectId, suite.id) },
    comparison && { label: 'Latest comparison', title: `${comparison.baselineVersion} vs ${comparison.candidateVersion}`, at: comparison.createdAt, href: routes.comparison(projectId, comparison.id) },
    job && { label: 'Latest discovery job', title: job.input.request.profiles.map(profile => profile.label).join(' / '), at: job.createdAt, href: routes.job(projectId, job.id) },
  ].filter(Boolean) as { label: string; title: string; at: string; href: string }[];
  if (!rows.length) return <p className="text-ink-2">Nothing saved yet. Saved suites, comparisons and discovery jobs appear here with a direct link back.</p>;
  return (
    <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
      {rows.map(row => (
        <li key={row.label} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-meta text-ink-2">{row.label} · <Time iso={row.at} /></p>
            <p className="font-medium break-words">{row.title}</p>
          </div>
          <Link href={row.href} className="inline-flex min-h-11 items-center gap-1.5 text-control font-medium text-action underline-offset-4 hover:underline">Resume<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} /></Link>
        </li>
      ))}
    </ul>
  );
}

export function ProjectHomeScreen({ projectId }: { projectId: string }) {
  const api = useApi();
  const facts = useResource(() => loadProjectFacts(api, projectId), [api, projectId]);
  if (facts.status === 'loading') return <SkeletonPanel label="Working out the next step" />;
  if (facts.status === 'error') return <ErrorState error={facts.error} what="this project’s next step" onRetry={facts.reload} retrying={facts.reloading} />;
  const next = nextAction(projectId, facts.data);
  const steps = setupSteps(facts.data);
  return (
    <div className="space-y-10">
      {facts.error ? <ErrorState error={facts.error} what="the latest project state" onRetry={facts.reload} retrying={facts.reloading} /> : null}
      <Panel className="border-action/30">
        <p className="text-meta text-ink-2">Next step</p>
        <h1 className="mt-1 text-title font-medium">{next.title}</h1>
        <p className="mt-2 max-w-[62ch] text-ink">{next.body}</p>
        <ButtonLink href={next.href} className="mt-5" iconAfter={<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} />}>{next.cta}</ButtonLink>
      </Panel>
      <div className="grid gap-10 xl:grid-cols-2">
        <Section title="Saved work" description="Reopen your latest saved records.">
          <LatestWork projectId={projectId} facts={facts.data} />
        </Section>
        <Section title="Setup" description="Completion comes from saved project records.">
          <ol className="space-y-1">
            {steps.map(step => (
              <li key={step.id}>
                <Link href={routes.setup(projectId, step.id)} className="flex min-h-11 items-start gap-3 rounded-control p-2 hover:bg-white/60">
                  {step.done
                    ? <Check aria-hidden className="mt-0.5 size-5 shrink-0 text-ink" strokeWidth={2} />
                    : <Circle aria-hidden className="mt-0.5 size-5 shrink-0 text-ink-2" strokeWidth={1.75} />}
                  <span className="min-w-0">
                    <span className="block font-medium">{step.title}<span className="sr-only">{step.done ? ' — done' : ' — not done'}</span></span>
                    <span className="block text-meta text-ink-2">{step.detail}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </div>
  );
}
