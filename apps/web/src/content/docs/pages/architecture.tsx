import { Callout, H2 } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const architecture: DocSection = {
  'cultural-evidence': {
    headings: [{ id: 'role', label: 'Qloo’s role' }, { id: 'stored', label: 'What is stored' }, { id: 'coverage', label: 'Coverage and gaps' }],
    keywords: ['qloo', 'mcp', 'ranking', 'affinity', 'harness'],
    Body: () => (
      <>
        <H2 id="role">Qloo’s role</H2>
        <p>Qloo helps connect public interests, such as music or films, with places. TasteCase asks it to rank the same allowed restaurants for each fictional diner. Those rankings help choose a question to test; they are not a verdict about the diner.</p>
        <p>TasteCase looks for a restaurant pair whose order reverses between the diners. It compares the order within each ranking, not score differences between separate requests.</p>
        <H2 id="stored">What is stored</H2>
        <p>TasteCase saves the confirmed matches, restaurant order, missing options and the time the evidence was captured. It stores only the details needed for the case, not raw Qloo replies. Test packs do not include Qloo response bodies or scores.</p>
        <H2 id="coverage">Coverage and gaps</H2>
        <p>Missing means Qloo did not return the restaurant. Unmapped means you have not confirmed its Qloo match. Neither means a diner dislikes it. If Qloo is unavailable, TasteCase shows the gap; it does not invent replacement evidence.</p>
      </>
    ),
  },
  'agent-loop': {
    headings: [{ id: 'bounded', label: 'Work within your limits' }, { id: 'model', label: 'What the model may decide' }, { id: 'investigation', label: 'Ask your assistant' }],
    keywords: ['worker', 'minimax', 'model decision', 'contrast'],
    Body: () => (
      <>
        <H2 id="bounded">Work within your limits</H2>
        <p>The background worker handles one saved discovery job at a time: find interest matches for you to confirm, collect rankings, find an interesting pair, ask your assistant through the runner and save a case. Your call limits and deadline keep that work bounded.</p>
        <H2 id="model">What the model may decide</H2>
        <p>MiniMax M3.1 Flash, through OpenRouter’s free route, helps select one of the restaurant pairs already found in the rankings. It may choose none. It cannot invent a pair or decide that the assistant failed a taste test. Unsupported choices are rejected.</p>
        <H2 id="investigation">Ask your assistant</H2>
        <p>The runner asks your assistant about both diners. You can request repeats and a focused follow-up about the interesting pair. The practical needs and allowed restaurants stay the same.</p>
      </>
    ),
  },
  runner: {
    headings: [{ id: 'what', label: 'What the runner does' }, { id: 'commands', label: 'Commands' }, { id: 'recovery', label: 'Expired work and revoked tokens' }],
    keywords: ['cli', 'handshake', 'run-once', 'openrouter', 'adapter', 'connect'],
    Body: () => (
      <>
        <H2 id="what">What the runner does</H2>
        <p>The runner is a small Node program you run on your computer or server. It connects using a token for one project, picks up a queued request, asks your assistant and sends the result back. Your assistant’s provider key stays on that machine. TasteCase does not ask you to upload the assistant’s source code.</p>
        <H2 id="commands">Commands</H2>
        <ul>
          <li><code>handshake</code> — checks that the runner can connect. It does not call your assistant or need a model key.</li>
          <li><code>run-once</code> — picks up one queued request, runs it and sends back the answer. “No work” means there is no matching request ready.</li>
          <li><code>replay</code> — reruns a downloaded test pack for one assistant version. It needs your model connection, but not a TasteCase login.</li>
        </ul>
        <p>The runner does not keep running automatically. Run it again for the next queued request. It does not automatically retry assistant calls. The local-development option <code>--allow-loopback-http</code> is not needed for the hosted API.</p>
        <H2 id="recovery">Expired work and revoked tokens</H2>
        <p>A runner gets a time-limited claim on a request. If that expires, another claim may pick up the work; an old result cannot overwrite it. Sending the same completed result again is safe, but different content is rejected. Revoking a token stops new connections, claims and uploads.</p>
      </>
    ),
  },
  jobs: {
    headings: [{ id: 'durable', label: 'Saved progress' }, { id: 'charges', label: 'Calls with unknown outcomes' }, { id: 'restart', label: 'Restarts' }],
    keywords: ['lease', 'checkpoint', 'retry', 'restart', 'exactly once'],
    Body: () => (
      <>
        <H2 id="durable">Saved progress</H2>
        <p>Saved evidence and accepted answers live in the database, not on the hosting machine’s temporary disk. After a restart, the worker uses saved progress instead of repeating completed provider work.</p>
        <H2 id="charges">Calls with unknown outcomes</H2>
        <p>TasteCase counts a provider request before sending it. If work stops before sending, it is labelled interrupted. If it was sent but no answer was saved, it is labelled uncertain. Both count against the job’s allowance; TasteCase cannot promise a provider was called or billed exactly once.</p>
        <H2 id="restart">Restarts</H2>
        <p>A real restart test resumed from saved progress. Each request has a stable ID so the same accepted work is not saved twice. Uncertain provider calls still remain visible.</p>
      </>
    ),
  },
  'version-pinning': {
    headings: [{ id: 'pinned', label: 'Keep the original inputs' }, { id: 'new', label: 'Change means a new version' }],
    keywords: ['immutable', 'checksum', 'version'],
    Body: () => (
      <>
        <H2 id="pinned">Keep the original inputs</H2>
        <p>Each stage keeps a fixed copy of the inputs it used: the restaurant list, task, matches, evidence and approved checks. Saved fingerprints, called checksums, help identify that exact content.</p>
        <H2 id="new">Change means a new version</H2>
        <p>To change published tests, create a new version. Old results keep their original inputs. A new discovery run collects new evidence without rewriting earlier comparisons.</p>
        <Callout kind="note">A label such as <code>concierge-prompt-v2</code> names the setup you configured locally. It does not independently prove which prompt or model ran.</Callout>
      </>
    ),
  },
};
