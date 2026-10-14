'use client';

import { FlaskConical } from 'lucide-react';
import Link from 'next/link';
import { CaseReview } from '@/components/case/case-review';
import { SiteHeader } from '@/components/site/site-header';
import { HeroFooter } from '@/components/site/hero-footer';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Time } from '@/components/ui/data';
import { SkeletonPanel } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';
import { buildCaseView } from '@/lib/view/case-view';

/**
 * Public sample: actual execution with synthetic inputs, visibly separate from private projects.
 * If it can't run, the real unavailable state is shown; recorded evidence appears only when the
 * payload says it is recorded, with its capture time. It never routes into a private project.
 */
export function SampleScreen() {
  const api = useApi();
  const sample = useResource(() => api.sample.getPublicSample(), [api]);
  return (
    <>
      <SiteHeader />
      <aside aria-label="About this sample" className="border-y border-info/20 bg-info-bg">
        <p className="mx-auto flex w-full max-w-[1200px] items-center gap-2 px-4 py-2 text-control font-medium text-info sm:px-6">
          <FlaskConical aria-hidden className="size-4" strokeWidth={1.75} /> Public sample · synthetic inputs · not a private project
        </p>
      </aside>
      <main id="main" className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6">
        {sample.status === 'loading' ? <SkeletonPanel label="Loading the public sample" className="min-h-80" /> : null}
        {sample.status === 'error' ? (
          <div className="grid gap-10 lg:grid-cols-[3fr_2fr]">
            <div className="space-y-5">
              <h1 className="text-title font-medium">Inspect a case</h1>
              <p className="max-w-[60ch] text-ink">The sample runs one recommendation case end to end: two fictional profiles, the same constraints and catalog, Qloo rankings, the assistant’s answers and the evidence limits — the same view your team uses to decide what becomes a test.</p>
              <ErrorState error={sample.error} what="the public sample" onRetry={sample.reload} retrying={sample.reloading} />
              <p className="text-control text-ink-2">No recorded results are shown in its place. When the sample can run, it uses synthetic inputs, and any recorded evidence is labelled with when it was captured.</p>
            </div>
            <aside className="space-y-3 rounded-panel border border-rule bg-surface p-5">
              <p className="font-medium">While the sample is unavailable</p>
              <ul className="space-y-2 text-control">
                <li><Link href={routes.workflow} className="text-action underline underline-offset-4">From taste to test</Link> — how a finding becomes a release test.</li>
                <li><Link href="/docs/start/sample-walkthrough" className="text-action underline underline-offset-4">Sample walkthrough</Link> — what each part of a case means.</li>
                <li><Link href={routes.limitations} className="text-action underline underline-offset-4">Current limitations</Link></li>
              </ul>
              <ButtonLink href={routes.newProject} variant="secondary" className="mt-2 w-full">Bring your assistant</ButtonLink>
            </aside>
          </div>
        ) : null}
        {sample.status === 'ready' ? (() => {
          const view = buildCaseView(sample.data.caseResponse, sample.data.job, sample.data.attempts);
          return (
            <CaseReview view={view} header={
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">{sample.data.provenance === 'live' ? 'Live run' : 'Recorded evidence'}</Badge>
                  <span className="text-control text-ink-2">{sample.data.provenance === 'live' ? 'Processed' : 'Captured'} <Time iso={sample.data.capturedAt} /> · synthetic inputs</span>
                </div>
                <h1 className="text-title font-medium">Inspect a case</h1>
                <p className="max-w-[64ch] text-ink-2">Read it top to bottom: constraints, the finding and its evidence limits, then each profile’s brief, the assistant’s answers and Qloo’s rankings. Select any restaurant to follow it across panels.</p>
              </div>
            } decision={
              <section id="decision" className="scroll-mt-24 rounded-panel border border-rule bg-surface p-5">
                <h2 className="text-section font-medium">Review your own cases</h2>
                <p className="mt-2 max-w-[60ch] text-ink">In a private project you’d accept, edit, reject or defer this finding with a rationale, then publish approved cases as a release suite.</p>
                <ButtonLink href={routes.newProject} className="mt-4">Bring your assistant</ButtonLink>
              </section>
            } />
          );
        })() : null}
      </main>
      <HeroFooter />
    </>
  );
}
