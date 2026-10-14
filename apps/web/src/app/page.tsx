import { ArrowRight, KeyRound } from 'lucide-react';
import Link from 'next/link';
import { CaseAnatomy } from '@/components/site/case-anatomy';
import { HeroFooter } from '@/components/site/hero-footer';
import { SiteHeader } from '@/components/site/site-header';
import { ButtonLink } from '@/components/ui/button';
import { routes } from '@/lib/routes';

const steps = [
  { title: 'Investigate', body: 'Qloo helps choose cultural contrasts worth checking. Your local runner asks your assistant the same question for two fictional profiles, under identical constraints.' },
  { title: 'Review', body: 'Your team decides which expectations belong in a test — accept, edit, reject or defer, each with a rationale. Taste findings stay advisory unless you write an explicit rule.' },
  { title: 'Replay', body: 'Compare releases against the saved inputs and evidence. Export the test pack and replay it locally before the next release, without new Qloo calls.' },
];

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="mx-auto grid w-full max-w-[1200px] gap-10 px-4 pb-16 pt-10 sm:px-6 md:pt-16 lg:grid-cols-[11fr_9fr] lg:items-start lg:gap-12 lg:pb-24">
          <div className="lg:pt-10">
            <p className="text-body text-ink-2">For teams building AI travel concierges.</p>
            <h1 className="mt-3 max-w-[16ch] font-serif text-hero font-normal tracking-[-0.01em] md:text-hero-lg">Find recommendation cases worth testing.</h1>
            <p className="mt-5 max-w-[56ch] text-body text-ink">
              Use Qloo’s cultural signals to investigate your assistant’s dining recommendations, review the findings, and save tests for your next release.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <ButtonLink href={routes.sample} iconAfter={<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} />}>Inspect a case</ButtonLink>
              <ButtonLink href={routes.newProject} variant="secondary">Bring your assistant</ButtonLink>
            </div>
            <p className="mt-3 flex items-center gap-2 text-meta text-ink-2">
              <KeyRound aria-hidden className="size-4" strokeWidth={1.75} /> Your assistant keys stay in your local runner.
            </p>
            <p className="mt-6">
              <Link href={routes.workflow} className="text-control font-medium text-action underline underline-offset-4 hover:text-action-hover">From taste to test</Link>
              <span className="text-control text-ink-2"> — how a finding becomes a release test</span>
            </p>
          </div>
          <CaseAnatomy />
        </section>

        <section aria-labelledby="loop-title" className="border-y border-rule bg-surface">
          <div className="mx-auto w-full max-w-[1200px] px-4 py-14 sm:px-6 md:py-20">
            <h2 id="loop-title" className="max-w-[30ch] text-title font-medium">One loop, from a cultural contrast to a test you can replay</h2>
            <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
              {steps.map((step, index) => (
                <li key={step.title} className="border-t border-ink pt-4">
                  <p className="text-meta text-ink-2">Step {index + 1}</p>
                  <h3 className="mt-1 text-section font-medium">{step.title}</h3>
                  <p className="mt-2 text-ink">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="example-title" className="mx-auto grid w-full max-w-[1200px] gap-10 px-4 py-14 sm:px-6 md:py-20 lg:grid-cols-[5fr_7fr]">
          <div>
            <h2 id="example-title" className="text-title font-medium">Before a prompt change ships</h2>
            <p className="mt-3 text-ink-2">An example of the workflow, not a recorded result.</p>
          </div>
          <ol className="space-y-6">
            {[
              ['Connect', 'The team creates a private project, issues a runner credential and imports a versioned restaurant catalog. Their model keys stay on the runner machine.'],
              ['Discover', 'A bounded discovery job ranks the same eligible restaurants for two fictional profiles. Where the order reverses, the runner asks the concierge both briefs and repeats them.'],
              ['Decide', 'A reviewer reads the paired briefs, outputs and evidence limits, then accepts the finding as advisory or writes a scoped policy, such as “for Profile B, avoid these restaurants”.'],
              ['Compare', 'They publish the approved cases as an immutable suite and run concierge-prompt-v1 and concierge-prompt-v2 against it. Changed recommendations are shown as behaviour changes, not as better taste.'],
              ['Keep', 'They download the test pack with its checksum and replay it locally on the next release.'],
            ].map(([title, body]) => (
              <li key={title} className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-6">
                <p className="font-medium">{title}</p>
                <p className="text-ink">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="qloo-title" className="border-t border-rule">
          <div className="mx-auto grid w-full max-w-[1200px] gap-10 px-4 py-14 sm:px-6 md:grid-cols-2 md:py-20">
            <div>
              <h2 id="qloo-title" className="text-title font-medium">What Qloo contributes</h2>
              <p className="mt-4 text-ink">Qloo supplies public, aggregate cultural relationships. TasteCase uses them to rank your own eligible restaurants for each fictional profile and to pick contrasts worth investigating — instead of asking a language model to invent one.</p>
            </div>
            <div>
              <h2 className="text-title font-medium">What it doesn’t decide</h2>
              <ul className="mt-4 space-y-2 text-ink">
                <li>Qloo doesn’t know whether a particular person will like a restaurant.</li>
                <li>A changed ranking is a signal to investigate, never an automatic failure.</li>
                <li>Missing coverage is shown as unavailable — not as a dislike.</li>
                <li>No personal guest data or credentials are sent to Qloo.</li>
              </ul>
              <p className="mt-5"><Link href={routes.limitations} className="font-medium text-action underline underline-offset-4 hover:text-action-hover">Read the current limitations</Link></p>
            </div>
          </div>
        </section>
      </main>
      <HeroFooter />
    </>
  );
}
