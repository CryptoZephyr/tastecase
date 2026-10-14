import Link from 'next/link';
import { Callout, H2 } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const start: DocSection = {
  introduction: {
    headings: [{ id: 'what', label: 'What TasteCase does' }, { id: 'who', label: 'Who it’s for' }, { id: 'qloo', label: 'Qloo’s contribution' }, { id: 'not', label: 'What it doesn’t claim' }, { id: 'status', label: 'Current status' }],
    keywords: ['overview', 'about', 'product'],
    Body: () => (
      <>
        <p>TasteCase helps teams building AI travel concierges find difficult dining recommendation cases and keep the reviewed ones as tests they can replay before every release.</p>
        <H2 id="what">What TasteCase does</H2>
        <p>You connect your assistant through a local runner and import your own restaurant catalog. TasteCase describes two fictional diners through public cultural interests, uses Qloo to rank your eligible restaurants for each, and looks for pairs whose order reverses. Your runner then asks your assistant both briefs, under identical practical constraints, and repeats them.</p>
        <p>A person reviews the saved case and decides whether it belongs in a test. Approved cases are published as an immutable suite. Two named releases of your assistant can then run against that suite, and the pinned test pack can be replayed locally.</p>
        <H2 id="who">Who it’s for</H2>
        <p>Engineering and QA leads shipping an AI concierge who need to know, before a model, prompt, memory or ranking change goes out, which recommendation cases changed — and whether the change matters. It tests the team’s assistant, not travellers.</p>
        <H2 id="qloo">Qloo’s contribution</H2>
        <p>Qloo supplies public, aggregate cultural relationships. TasteCase uses them to rank the same eligible restaurants for each profile and to choose contrasts worth investigating, instead of asking a language model to invent one. See <Link href="/docs/architecture/cultural-evidence">Cultural evidence</Link>.</p>
        <H2 id="not">What it doesn’t claim</H2>
        <ul>
          <li>Qloo doesn’t know whether a particular person will like a restaurant. A changed ranking is a signal to investigate, never an automatic failure.</li>
          <li>Missing cultural coverage is unavailable — not a negative preference.</li>
          <li>An incomplete trace can’t prove an assistant skipped a tool.</li>
          <li>A better useful-case yield than generic test generation has not been demonstrated yet.</li>
        </ul>
        <H2 id="status">Current status</H2>
        <Callout kind="implemented">The backend API, discovery worker, review and immutable suites, comparisons, exports and the local runner are implemented and were verified on 2026-10-13. See <Link href="/docs/proof/verified-evidence">Verified integration evidence</Link>.</Callout>
        <Callout kind="implemented">The web app uses the production API connection through a bounded same-origin proxy. Private requests require a verified Supabase session. Local integration checks cover stored receipts; they do not prove a deployed app or browser workflow.</Callout>
        <Callout kind="limitation">Hosted API and Supabase configuration, and a dedicated recorded public sample, still need provisioning and verification. Missing configuration shows “not connected” or unavailable, never stand-in results.</Callout>
      </>
    ),
  },
  'sample-walkthrough': {
    headings: [{ id: 'order', label: 'Read it in order' }, { id: 'constraints', label: 'Shared constraints' }, { id: 'finding', label: 'Finding and evidence limits' }, { id: 'sections', label: 'Briefs, outputs and rankings' }, { id: 'interactions', label: 'Highlighting and inspecting' }, { id: 'sample-status', label: 'Sample availability' }],
    keywords: ['public sample', 'inspect a case', 'case anatomy', 'profile a', 'profile b'],
    Body: () => (
      <>
        <p>The public sample shows one case exactly as your team would see it in a private project, with synthetic inputs clearly labelled.</p>
        <H2 id="order">Read it in order</H2>
        <p>The case answers four questions without opening raw traces: what are we testing, what happened, what is uncertain, and what can I do next. Read from the top: constraints, the finding with its limits, then each profile’s brief, the assistant’s outputs and Qloo’s rankings.</p>
        <H2 id="constraints">Shared constraints</H2>
        <p>One strip lists the practical constraints that stay identical for both profiles and every repeat: party size, location, budget, dietary and accessibility needs, required cuisines, eligible and excluded restaurants. Only the cultural interests differ between Profile A and Profile B.</p>
        <H2 id="finding">Finding and evidence limits</H2>
        <p>The finding states the contrast — Qloo ordered two eligible restaurants one way for Profile A and the reverse for Profile B — and carries an <strong>Advisory · Needs human review</strong> label. Beside it, before any review control, you always see ranking coverage, missing or unranked candidates, and trace completeness.</p>
        <H2 id="sections">Briefs, outputs and rankings</H2>
        <p>Each section shows Profile A and Profile B side by side on wide screens, and A then B on narrow ones, with the profile label repeated every time. A case with a single brief shows one “Case brief” column — never an empty or invented Profile B.</p>
        <p>The attempt switcher moves between stored repeats and the two-restaurant follow-up. Browsing stored attempts never sends a new request; an intended attempt that wasn’t captured is shown as not captured.</p>
        <H2 id="interactions">Highlighting and inspecting</H2>
        <ul>
          <li><strong>Select a restaurant</strong> to highlight the same catalog ID across rankings and outputs. Where it’s absent, the panel says so.</li>
          <li><strong>Hover or focus “Inspect”</strong> for a short preview; activate it (or tap on touch screens) to pin the full evidence record in the inspector.</li>
        </ul>
        <H2 id="sample-status">Sample availability</H2>
        <Callout kind="implemented">The anonymous, read-only sample endpoint is implemented. It exposes only one server-selected recorded case with explicitly approved synthetic inputs, captured ranking evidence and an assistant result. It does not accept project or case selectors, use your owner session, or start new provider calls.</Callout>
        <Callout kind="limitation">A genuine dedicated sample has not been provisioned or verified through this web app. If its configuration or required evidence is missing, <Link href="/sample">Inspect a case</Link> shows unavailable and no stand-in results. Local tests use explicitly simulated provider evidence, not a publishable demonstration.</Callout>
      </>
    ),
  },
  'from-taste-to-test': {
    headings: [{ id: 'loop', label: 'The loop' }, { id: 'investigate', label: '1. Investigate' }, { id: 'review', label: '2. Review' }, { id: 'replay', label: '3. Replay' }, { id: 'classes', label: 'Why classes matter' }],
    keywords: ['workflow', 'how it works', 'loop', 'release'],
    Body: () => (
      <>
        <p>A cultural contrast is only a lead. It becomes a test when a person decides what the assistant should do and writes that down as a scoped expectation.</p>
        <H2 id="loop">The loop</H2>
        <p>Connect your assistant, define the task, discover a case, inspect the evidence, approve an expectation, publish a suite, compare two releases, export the pack and replay it — then come back to the same saved project later.</p>
        <H2 id="investigate">1. Investigate</H2>
        <p>A discovery job pins your catalog, task, confirmed mappings and two fictional profiles built from public music, film or brand interests. Qloo ranks the same eligible, mapped restaurants for each profile. Code finds pairs whose order reverses; a model may only pick one of those observed contrasts, or none. Your runner then asks your assistant both full briefs, repeats them, and optionally asks a focused follow-up about the two restaurants — with constraints and the eligible catalog unchanged.</p>
        <H2 id="review">2. Review</H2>
        <p>You accept, edit, reject or defer the saved case, always with a rationale. Accepting keeps the finding advisory. Editing lets you write an <strong>approved policy</strong> (recommend any of, avoid, or order two restaurants for one profile) or <strong>objective checks</strong> (output shape, only eligible restaurants, never excluded ones). Each decision is an immutable receipt with its pinned evidence.</p>
        <H2 id="replay">3. Replay</H2>
        <p>Publishing creates an immutable suite version. A comparison runs a named baseline and candidate release against it with fresh runs, evaluates only the approved rules and freezes a report. The test pack replays locally without new Qloo calls.</p>
        <H2 id="classes">Why classes matter</H2>
        <p>Every result shows two labels: what kind of check it is, and what happened. Advisory findings never turn into failures because a ranking changed, and missing evidence never counts as a pass. See <Link href="/docs/reference/result-classes">Result classes</Link>.</p>
      </>
    ),
  },
};
