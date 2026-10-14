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
          <FlaskConical aria-hidden className="size-4" strokeWidth={1.75} /> Public sample · fictional diners · real recorded results · read-only
        </p>
      </aside>
      <main id="main" className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6">
        {sample.status === 'loading' ? <SkeletonPanel label="Loading the public sample" className="min-h-80" /> : null}
        {sample.status === 'error' ? (
          <div className="grid gap-10 lg:grid-cols-[3fr_2fr]">
            <div className="space-y-5">
              <h1 className="text-title font-medium">Inspect a case</h1>
              <p className="max-w-[60ch] text-ink">Read a saved restaurant test: two fictional diners, the same practical needs, Qloo’s rankings and the assistant’s answers. See what changed and what the evidence can’t tell us.</p>
              <ErrorState error={sample.error} what="the public sample" onRetry={sample.reload} retrying={sample.reloading} />
              <p className="text-control text-ink-2">We couldn’t load the saved example. No made-up results are shown instead. If the free service is waking up, wait about a minute and retry.</p>
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
                  <Badge tone="info">Recorded evidence</Badge>
                  <span className="text-control text-ink-2">Captured <Time iso={sample.data.capturedAt} /> · fictional diners</span>
                </div>
                <h1 className="text-title font-medium">Inspect a case</h1>
                <p className="max-w-[64ch] text-ink-2">Two fictional diners want dinner in the same city, but have different interests. Qloo helps us find a restaurant pair worth checking. Read the assistant’s answers beside those rankings — a difference is a question to review, not an automatic failure.</p>
                <p className="max-w-[64ch] text-control text-ink-2">This is a saved example, not a new run. Select a restaurant to follow it across panels, or <Link href="/docs/start/sample-walkthrough" className="text-action underline underline-offset-4">read the short walkthrough</Link>.</p>
              </div>
            } decision={
              <section id="decision" className="scroll-mt-24 rounded-panel border border-rule bg-surface p-5">
                <h2 className="text-section font-medium">Review your own cases</h2>
                <p className="mt-2 max-w-[60ch] text-ink">In your own project, decide whether to keep a case and write down why. Save the useful ones as tests, then compare your next assistant version against them.</p>
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
