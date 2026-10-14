import Link from 'next/link';
import { Callout, Code, H2, Table } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const using: DocSection = {
  projects: {
    headings: [{ id: 'private', label: 'Private by default' }, { id: 'setup', label: 'Setup checklist' }, { id: 'next', label: 'The next-step view' }, { id: 'return', label: 'Coming back later' }],
    keywords: ['create project', 'setup', 'runner credential', 'bring your assistant'],
    Body: () => (
      <>
        <p>A project holds one assistant’s test work: its runner credentials, catalog versions, mappings, tasks, discovery jobs, cases, suites and comparisons.</p>
        <H2 id="private">Private by default</H2>
        <p>Projects belong to the signed-in owner. Another account gets “not found” for your project, job, case or artifact links — TasteCase doesn’t reveal whether they exist.</p>
        <H2 id="setup">Setup checklist</H2>
        <ol>
          <li>Connect your runner: issue a project credential and run the handshake on your machine.</li>
          <li>Import your restaurant catalog.</li>
          <li>Confirm Qloo mappings.</li>
          <li>Define the task and practical constraints.</li>
          <li>Review call budgets when you start discovery.</li>
        </ol>
        <p>A step counts as done only when its record is saved in TasteCase; nothing is ticked off in your browser alone. Issuing a credential does not verify a runner: setup needs a persisted handshake on an active credential. The timestamp records a past connection, not a live heartbeat, and revocation removes that credential from readiness.</p>
        <H2 id="next">The next-step view</H2>
        <p>The project overview shows one dominant next action derived from saved records — the next setup step for a new project, or the latest suite and comparison with a Resume link for a returning one.</p>
        <H2 id="return">Coming back later</H2>
        <p>Every project, job, case, suite version and comparison has a stable link. Reloading or signing in from another session reopens the same saved work.</p>
      </>
    ),
  },
  catalogs: {
    headings: [{ id: 'shape', label: 'Catalog shape' }, { id: 'versions', label: 'Immutable versions' }, { id: 'limits', label: 'Limits' }],
    keywords: ['restaurants', 'import', 'json', 'catalog version'],
    Body: () => (
      <>
        <p>The catalog is the set of restaurants your assistant may recommend. TasteCase tests recommendations against it, never against the open web.</p>
        <H2 id="shape">Catalog shape</H2>
        <p>Each entry needs a stable <code>id</code> and a <code>name</code>. Optional <code>metadata</code> (address, city, country code, cuisines, description), <code>constraintFacts</code> (dietary options, accessibility features, max party size, typical spend, reservation required) and a candidate <code>qlooEntityId</code> may be supplied.</p>
        <Code label="Shape of one entry (placeholders, not runnable data)" code={`{
  "id": "your-stable-restaurant-id",
  "name": "Restaurant name",
  "metadata": { "city": "City", "countryCode": "US", "cuisines": ["Cuisine"] },
  "constraintFacts": { "dietaryOptions": ["vegetarian"], "maxPartySize": 8 },
  "qlooEntityId": "<optional candidate Qloo entity UUID>"
}`} />
        <p>Missing optional facts are unknown — never treated as yes or no. A candidate Qloo ID is not a confirmation.</p>
        <H2 id="versions">Immutable versions</H2>
        <p>Each import creates a catalog version with a checksum. Tasks, jobs and suites pin a version, so later imports never change earlier results.</p>
        <H2 id="limits">Limits</H2>
        <p>Up to 500 restaurants per version. A discovery job can rank at most 10 mapped restaurants; larger sets are refused rather than split into incomparable scores.</p>
      </>
    ),
  },
  'mapping-confirmation': {
    headings: [{ id: 'why', label: 'Why confirm' }, { id: 'how', label: 'How it works' }, { id: 'unmapped', label: 'Unmapped restaurants' }],
    keywords: ['qloo entity', 'mapping', 'ambiguous'],
    Body: () => (
      <>
        <H2 id="why">Why confirm</H2>
        <p>Qloo ranks entities it knows. A confirmation records, explicitly and immutably, which public Qloo entity a catalog restaurant is. TasteCase never confirms a guess for you.</p>
        <H2 id="how">How it works</H2>
        <p>For each restaurant with a candidate ID, choose <strong>Confirm this match</strong>, or enter a different Qloo entity ID. Each confirmation belongs to one catalog version and can’t be edited.</p>
        <p>Public interests on discovery profiles work the same way: when Qloo returns candidate matches, the job waits for you to choose — even if there’s only one.</p>
        <H2 id="unmapped">Unmapped restaurants</H2>
        <p>An unmapped restaurant can still be eligible for your assistant. It simply isn’t ranked, and its coverage is reported as unavailable — not as disliked.</p>
      </>
    ),
  },
  discovery: {
    headings: [{ id: 'inputs', label: 'What a job pins' }, { id: 'stages', label: 'Stages' }, { id: 'budgets', label: 'Budgets' }, { id: 'states', label: 'Outcomes' }, { id: 'cancel', label: 'Cancelling' }],
    keywords: ['discovery job', 'budgets', 'profiles', 'public interests', 'needs confirmation', 'waiting runner'],
    Body: () => (
      <>
        <H2 id="inputs">What a job pins</H2>
        <p>The task and catalog versions, confirmed mappings, eligible restaurants, two fictional profiles (each with one to five public music, film or brand interests), the assistant version label, repeat count, whether to run the pair follow-up, budgets and a deadline. None of it can change once the job starts.</p>
        <H2 id="stages">Stages</H2>
        <p>Inputs pinned → interests confirmed → rankings captured → contrast selected → assistant runs → investigation → case saved. A job may wait for you (<em>needs confirmation</em>) or for your runner (<em>waiting for runner</em>).</p>
        <H2 id="budgets">Budgets</H2>
        <Table head={['Budget', 'Default', 'Range']} rows={[
          ['Qloo calls', '8', '1–20'], ['Model decisions', '2', '1–8'], ['Assistant runs', '6', '2–12'], ['Rounds', '3', '1–6'],
          ['Deadline', '900 s', '30–3600 s'], ['Output limit', '64,000 bytes', '1,024–262,144'], ['Retries per operation', '1', '0–2'],
        ]} />
        <p>Calls are reserved before dispatch and stay charged even when the outcome is unknown. Only flagged transient errors retry, after a persisted backoff; authentication errors never retry.</p>
        <H2 id="states">Outcomes</H2>
        <p>A job can end <em>ready for review</em>, with <em>no useful contrast</em> (a valid result), or <em>partial</em>, <em>unavailable</em>, <em>budget used up</em>, <em>deadline reached</em>, <em>cancelled</em> or <em>failed</em>. Completed cases stay available in every case, and you can open them while another job still runs.</p>
        <H2 id="cancel">Cancelling</H2>
        <p>Cancelling stops new provider work and unsent runner claims. Results your runner already started may still arrive under a valid lease and stay labelled as cancelled.</p>
      </>
    ),
  },
  review: {
    headings: [{ id: 'decisions', label: 'Four decisions' }, { id: 'expectations', label: 'Expectations you can approve' }, { id: 'conflicts', label: 'Conflicts and drafts' }, { id: 'receipts', label: 'Receipts' }],
    keywords: ['accept', 'edit', 'reject', 'defer', 'rationale', 'policy', 'objective'],
    Body: () => (
      <>
        <H2 id="decisions">Four decisions</H2>
        <Table head={['Decision', 'Effect']} rows={[
          ['Accept', 'Keeps the proposed advisory expectation unchanged. Never an automatic failure.'],
          ['Edit', 'Saves your own expectation: advisory with your rationale, an approved policy, or objective checks.'],
          ['Reject', 'Not worth testing. Saved in history; published suites don’t change.'],
          ['Defer', 'Decide later. Saved in history without an approval.'],
        ]} />
        <p>Every decision needs a rationale and is based on the case’s current revision.</p>
        <H2 id="expectations">Expectations you can approve</H2>
        <ul>
          <li><strong>Objective checks:</strong> the output matches the expected shape; it recommends only the pinned eligible restaurants; it never recommends the task’s explicitly excluded restaurants.</li>
          <li><strong>Approved policy:</strong> for Profile A or B, recommend at least one of some eligible restaurants, never recommend some restaurants, or put one eligible restaurant before another when both appear.</li>
          <li><strong>Advisory:</strong> keep the original contrast with your rationale for human review.</li>
        </ul>
        <p>There are no free-text rules, expressions or uploaded code.</p>
        <H2 id="conflicts">Conflicts and drafts</H2>
        <p>If someone saves a newer decision while you’re reviewing, yours isn’t applied and your draft is kept; load the latest revision and submit again. Drafts are also kept in your browser tab if your session expires. A retry after an unconfirmed save resends the identical request, so it can’t be applied twice.</p>
        <H2 id="receipts">Receipts</H2>
        <p>A saved decision shows its revision, rationale, receipt checksum and the checksum of the evidence pinned with it — only after TasteCase confirms the save.</p>
      </>
    ),
  },
  suites: {
    headings: [{ id: 'publish', label: 'Publishing' }, { id: 'immutable', label: 'Immutability' }, { id: 'limits', label: 'Limits' }],
    keywords: ['suite version', 'publish', 'immutable'],
    Body: () => (
      <>
        <H2 id="publish">Publishing</H2>
        <p>Create a named suite, select approved cases and publish. Each case is saved with its current approved expectation and the evidence pinned at approval. If any selected case is stale, rejected, deferred or superseded, the whole publication is rejected — there are no partial suites.</p>
        <H2 id="immutable">Immutability</H2>
        <p>Every publication is a new version with a checksum. Later edits, rejections or late runner results never change it; changing a suite means publishing a new version.</p>
        <H2 id="limits">Limits</H2>
        <p>Up to 50 cases per version and 8 MiB per snapshot.</p>
      </>
    ),
  },
  comparisons: {
    headings: [{ id: 'fixed', label: 'What stays fixed' }, { id: 'run', label: 'Running both releases' }, { id: 'reading', label: 'Reading the report' }, { id: 'limits', label: 'Limits' }],
    keywords: ['baseline', 'candidate', 'release', 'changes only', 'finalize'],
    Body: () => (
      <>
        <H2 id="fixed">What stays fixed</H2>
        <p>A comparison references an exact published suite version and explicit cases. It pins the catalog, task, eligibility, mappings, constraints, both synthetic briefs and the original repeat count. Both releases execute fresh runs; old discovery outputs are never substituted.</p>
        <p>Two dimensions stay separate: <strong>Profile A / Profile B</strong> are the pinned input briefs; <strong>Baseline / Candidate</strong> are your assistant releases.</p>
        <H2 id="run">Running both releases</H2>
        <p>Configure the matching assistant locally, bind its exact label and run the runner. A runner with no label or the wrong label can’t claim comparison runs. Labels attest your local configuration; they never switch models.</p>
        <Code label="Bind a release label, then run one attempt" code={`export TASTECASE_ASSISTANT_VERSION="concierge-prompt-v1"
node packages/runner/dist/cli.js run-once`} />
        <H2 id="reading">Reading the report</H2>
        <p>Freeze the report once runs finish, or explicitly freeze a partial report. Outcomes come only from approved rules and stored results. Changed recommendations are shown separately as behaviour changes — not as better taste — and a “changes only” view lists moved, added and removed restaurants. Text differences are inspection aids, not verdicts.</p>
        <H2 id="limits">Limits</H2>
        <p>10 cases, 120 planned runs, 24 reclaims, 144 charged dispatches and a deadline within one hour.</p>
      </>
    ),
  },
  exports: {
    headings: [{ id: 'contents', label: 'What’s in the pack' }, { id: 'replay', label: 'Replay locally' }, { id: 'exit', label: 'Exit codes' }, { id: 'trust', label: 'Checksums and trust' }],
    keywords: ['test pack', 'download', 'replay', 'checksum'],
    Body: () => (
      <>
        <H2 id="contents">What’s in the pack</H2>
        <p>Pinned synthetic inputs, the approved declarative checks and structural evidence references. It omits Qloo response bodies and scores, assistant text and reasons, malformed raw output, provider diagnostics, trace events, credentials and executable code. It’s private project data.</p>
        <H2 id="replay">Replay locally</H2>
        <Code label="Replay one role (placeholders for your files and checksum)" code={`export TASTECASE_ASSISTANT_VERSION="concierge-prompt-v2"
node packages/runner/dist/cli.js replay \\
  --pack ./tests.json --role candidate \\
  --pack-checksum <trusted pack checksum> --report ./new-report.json`} />
        <p>Replay needs your local provider settings — no TasteCase login or runner token — and makes no Qloo calls. It runs only the selected role, so the report is a <strong>partial report — only this role ran</strong>; the other role stays pending, not invented. Existing report files are never overwritten.</p>
        <H2 id="exit">Exit codes</H2>
        <Table head={['Code', 'Meaning']} rows={[['0', 'Selected role completed without a mechanical failure (advisory is not a pass)'], ['2', 'A rule failed'], ['4', 'Unavailable or not run'], ['1', 'Invalid input, configuration or cancelled']]} />
        <H2 id="trust">Checksums and trust</H2>
        <p>Keep the pack checksum shown after the authenticated download. A self-checksum detects corruption, not someone changing the pack and recomputing every checksum. Downloading a pack is not a replay; TasteCase can’t see local replays.</p>
        <Callout kind="note">The web app labels a download as “Pack downloaded”. It never shows “Replay completed”, because that only happens on your machine.</Callout>
        <p>See also <Link href="/docs/reference/artifact-schema">Artifact schema</Link>.</p>
      </>
    ),
  },
};
