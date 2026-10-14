import Link from 'next/link';
import { Callout, H2 } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const proof: DocSection = {
  'verified-evidence': {
    headings: [{ id: 'checks', label: 'Code checks' }, { id: 'local-wiring', label: 'Saved work and access checks' }, { id: 'live', label: 'Real Qloo and model runs' }, { id: 'hosted', label: 'The hosted app' }, { id: 'not-verified', label: 'What remains untested' }],
    keywords: ['tests', 'ci', 'evidence', 'hosted checks', 'verification'],
    Body: () => (
      <>
        <p>These are completed checks, not promises about every future run. Provider availability and free-tier limits can change.</p>
        <H2 id="checks">Code checks</H2>
        <p>The deployed release passed 668 automated tests, code-style checks, type checks and the production build. Its dependency audit reported no known vulnerabilities.</p>
        <H2 id="local-wiring">Saved work and access checks</H2>
        <p>Tests covered sign-in, account isolation, runner connections, saving decisions, publishing test collections, reopening exact saved versions and retrying uncertain saves without creating duplicate work. Separate database checks used the dedicated hosted Supabase project.</p>
        <p>Some automated tests use simulated provider results to check errors and edge cases. Those are not the real results shown in the public sample.</p>
        <H2 id="live">Real Qloo and model runs</H2>
        <p>A hosted browser run completed discovery, review, publication, an 8-of-8 comparison, downloads and reopening. It used four Qloo calls and eleven model requests: one case-selection request plus ten assistant requests. There were no retries or paid fallbacks. The ten local assistant responses reported zero cost.</p>
        <p>A downloaded test pack was also replayed through the local runner before deployment, without new Qloo calls. The newly downloaded hosted pack was not separately replayed.</p>
        <H2 id="hosted">The hosted app</H2>
        <p>TasteCase is hosted on Vercel, with its API and discovery worker on one free Render service and saved data in Supabase. Private-route and second-account access checks passed in the hosted browser run.</p>
        <Callout kind="recorded">The <Link href="/sample">public sample</Link> is a saved, reviewed example with fictional diner inputs and genuine Qloo and Nemotron results. Its public response was checked through both the API and website connection, without sign-in. It omits private reviewer and runner-credential fields and rejects requests to select other projects.</Callout>
        <H2 id="not-verified">What remains untested</H2>
        <ul>
          <li>Successful signup and password-recovery email links.</li>
          <li>A deliberate hosted cold-start test, cancellation and objective-rule failure branches.</li>
          <li>Replay of the newly downloaded hosted pack, or a runner on a different physical machine or Windows.</li>
          <li>Whether Qloo-guided discovery finds more useful cases than ordinary generation.</li>
        </ul>
      </>
    ),
  },
  'recorded-workflows': {
    headings: [{ id: 'status', label: 'Open a saved example' }],
    keywords: ['demo', 'recording', 'public sample'],
    Body: () => (
      <>
        <H2 id="status">Open a saved example</H2>
        <p><Link href="/sample">Inspect a case</Link> shows real recorded rankings and answers for two fictional diners. The capture time is shown on the page. Reading it does not call Qloo or a model.</p>
        <p>It is one discovery and review example, not an interactive recording of every product step. For the wider checks, see <Link href="/docs/proof/verified-evidence">What we’ve tested</Link>.</p>
      </>
    ),
  },
  'case-yield': {
    headings: [{ id: 'question', label: 'Does this find better tests?' }, { id: 'known', label: 'What we know so far' }],
    keywords: ['yield', 'evaluation', 'benchmark'],
    Body: () => (
      <>
        <H2 id="question">Does this find better tests?</H2>
        <p>We have not yet measured whether Qloo-guided discovery finds more useful, repeatable cases than ordinary test generation.</p>
        <H2 id="known">What we know so far</H2>
        <p>Real runs found restaurant pairs whose order changed between profiles. Another valid run found no useful contrast. The system can save and test those cases, but that alone does not prove it finds better tests or improves diner satisfaction.</p>
      </>
    ),
  },
  'current-limitations': {
    headings: [{ id: 'product', label: 'What you can test' }, { id: 'method', label: 'What the evidence cannot prove' }, { id: 'web', label: 'Hosting and connection limits' }],
    keywords: ['limits', 'known issues', 'gaps', 'free', 'cold start', 'sleep'],
    Body: () => (
      <>
        <H2 id="product">What you can test</H2>
        <ul>
          <li>Dining recommendations from your fixed restaurant list, not booking or live availability.</li>
          <li>Up to ten matched restaurants per discovery job and ten selected cases per comparison.</li>
          <li>Only the supported checks you approved. A written reason is not executable test code.</li>
          <li>Comparisons allow 120 planned runs, 24 reclaims and 144 charged dispatches.</li>
        </ul>
        <H2 id="method">What the evidence cannot prove</H2>
        <ul>
          <li>Qloo rankings suggest questions to inspect, not what an individual should like.</li>
          <li>Missing evidence is not a pass or a dislike. Partial activity records cannot prove a tool was skipped.</li>
          <li>A release label identifies your local setup; it does not prove which model actually ran.</li>
          <li>Restaurant facts are saved as you supplied them. TasteCase does not verify their freshness.</li>
          <li>A sent provider call may count against your allowance even if its outcome is unknown.</li>
        </ul>
        <H2 id="web">Hosting and connection limits</H2>
        <ul>
          <li>The free Render backend sleeps after 15 idle minutes and may need about a minute to wake. Background discovery may pause; saved work remains in Supabase.</li>
          <li>Render’s free hours are shared with other services in the workspace. Free model quotas and provider availability also limit how many tests you can run.</li>
          <li>A runner’s saved handshake proves a past connection, not that it is online now.</li>
          <li>History loads in pages of 20, up to an offset of 10,000. A loading failure or exceeded limit is shown, not silently treated as the end.</li>
          <li>The public sample is read-only and recorded. It shows an evidence gap and partial activity records, not a fully verified recommendation verdict.</li>
        </ul>
      </>
    ),
  },
};
