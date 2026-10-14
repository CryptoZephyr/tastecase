import Link from 'next/link';
import { Callout, H2, Table } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const proof: DocSection = {
  'verified-evidence': {
    headings: [{ id: 'checks', label: 'Automated checks' }, { id: 'local-wiring', label: 'Local web integration' }, { id: 'live', label: 'Live provider runs' }, { id: 'hosted', label: 'Hosted database checks' }, { id: 'not-verified', label: 'Not verified' }],
    keywords: ['tests', 'ci', 'evidence', 'hosted checks', 'verification'],
    Body: () => (
      <>
        <Callout kind="recorded" title="Recorded 2026-10-13">These results come from the repository’s verification records. Proof metadata stays in ignored local storage; no provider responses are published.</Callout>
        <H2 id="checks">Automated checks</H2>
        <p><code>npm run check</code> passed lint, strict types, builds and 473 tests on a fresh PostgreSQL 17 database in CI mode, with zero skipped. The dependency audit reported zero vulnerabilities after the Qloo/Pi remediation.</p>
        <H2 id="local-wiring">Local web integration</H2>
        <Callout kind="recorded" title="Local automated checks only">The production HTTP connection, bounded proxy and loopback backend were exercised together against a guarded local PostgreSQL database. Checks cover unchanged retries after lost responses, private owner isolation, persisted runner handshakes, history beyond 20 records, exact frozen suite evidence, partial comparison reports and anonymous public projection. Provider evidence in these tests is explicitly simulated, not a live Qloo or assistant run.</Callout>
        <p>Separate production-build checks confirm that development fixture routes are absent and local client imports do not pull in Node-only contracts. Generated browser assets were checked for configured private values and credential markers. No browser, hosted authentication, deployment or live-provider verification was performed for this wiring change.</p>
        <H2 id="live">Live provider runs</H2>
        <ul>
          <li>Discovery: four accepted Qloo ranking calls, one validated Nova Micro decision and six real assistant calls through the runner. A worker restart reused saved checkpoints. One advisory case was saved, ending <em>partial</em>.</li>
          <li>Full rankings returned 2 of 3 mapped restaurants for both profiles; the two-restaurant follow-ups returned 2 of 2.</li>
          <li>Replay: a downloaded pack replayed through eight real Nova Micro calls with no Qloo calls; advisory classification was preserved.</li>
        </ul>
        <H2 id="hosted">Hosted database checks</H2>
        <Table head={['Area', 'Checks', 'Covered']} rows={[
          ['Foundation', '61', 'Real sign-in, project and runner isolation, private storage'],
          ['Discovery', '28', 'Schema readiness, queue/reopen/cancel, owner isolation, backend-only RPCs'],
          ['Review and suites', '114', 'Review lifecycle, stale conflicts, atomic publication, late results'],
          ['Comparison, export, replay', '172', 'Real auth, version-bound execution, private artifacts, immutable reports'],
        ]} />
        <p>These ran through a loopback API against a dedicated hosted Supabase project with disposable synthetic accounts. They are not a deployed TasteCase application.</p>
        <H2 id="not-verified">Not verified</H2>
        <ul>
          <li>A deployed web app or API.</li>
          <li>A browser workflow using real hosted authentication, and a genuinely recorded public sample in this web app.</li>
          <li>A runner on a different physical machine, or replay on Windows.</li>
          <li>Better useful-case yield than generic generation.</li>
        </ul>
      </>
    ),
  },
  'recorded-workflows': {
    headings: [{ id: 'status', label: 'Status' }],
    keywords: ['demo', 'recording'],
    Body: () => (
      <>
        <H2 id="status">Status</H2>
        <Callout kind="planned">No recorded end-to-end workflow is published in the app yet. When one is, it will appear here with its capture time and clearly separated from live results.</Callout>
        <p>The verification runs listed in <Link href="/docs/proof/verified-evidence">Verified integration evidence</Link> are recorded as summaries and checksums, not as replayable workflows.</p>
      </>
    ),
  },
  'case-yield': {
    headings: [{ id: 'question', label: 'The open question' }, { id: 'known', label: 'What is known' }],
    keywords: ['yield', 'evaluation', 'benchmark'],
    Body: () => (
      <>
        <H2 id="question">The open question</H2>
        <p>Does Qloo-guided discovery find more useful, reproducible test cases than generic test generation? It hasn’t been measured yet.</p>
        <H2 id="known">What is known</H2>
        <p>A small live order reversal was preserved in a two-restaurant follow-up, and an earlier valid run found no useful contrast. That shows the mechanism works end to end; it doesn’t show a better yield.</p>
      </>
    ),
  },
  'current-limitations': {
    headings: [{ id: 'product', label: 'Product' }, { id: 'method', label: 'Method' }, { id: 'web', label: 'This web app' }],
    keywords: ['limits', 'known issues', 'gaps'],
    Body: () => (
      <>
        <H2 id="product">Product</H2>
        <ul>
          <li>No deployed backend or hosted app yet.</li>
          <li>The first supported job is dining recommendations from a fixed catalog.</li>
          <li>Ranking accepts at most ten mapped options per job; larger sets are refused, not split.</li>
          <li>Comparisons support up to ten selected cases and only the reviewed declarative rules.</li>
        </ul>
        <H2 id="method">Method</H2>
        <ul>
          <li>Qloo evidence is query-relative and advisory, not individual preference truth.</li>
          <li>Provider dispatch and billing aren’t exactly-once; unknown outcomes stay visible and charged.</li>
          <li>Release labels are local attestations, not proof of model identity; self-checksums aren’t signatures.</li>
          <li>Catalog facts are pinned as supplied; their freshness isn’t verified.</li>
        </ul>
        <H2 id="web">This web app</H2>
        <ul>
          <li>The production API connection and public sample endpoint are implemented; hosted provisioning and browser verification remain pending.</li>
          <li>Setup requires a persisted handshake on an active runner credential. Its timestamp proves a past connection, never continuous availability; the runner may now be offline or unknown.</li>
          <li>Histories are loaded in 20-record pages up to a bounded offset of 10,000. A later-page failure or exceeded bound is shown as an error, not a complete or empty history.</li>
          <li>The public sample remains unavailable without a server-selected, explicitly approved synthetic record and the required captured execution evidence.</li>
        </ul>
      </>
    ),
  },
};
