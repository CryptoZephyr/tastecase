import { Callout, H2 } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const architecture: DocSection = {
  'cultural-evidence': {
    headings: [{ id: 'role', label: 'Qloo’s role' }, { id: 'stored', label: 'What is stored' }, { id: 'coverage', label: 'Coverage and gaps' }],
    keywords: ['qloo', 'mcp', 'ranking', 'affinity', 'harness'],
    Body: () => (
      <>
        <H2 id="role">Qloo’s role</H2>
        <p>Qloo supplies public cultural relationships used to identify contrasts within your actual task. The backend uses the official Qloo harness (<code>@qloo/qloo-harness@0.1.26</code>) through its MCP route, on the server only. Qloo ranks the same fixed set of eligible, mapped restaurants for each profile.</p>
        <p>Contrasts are computed by code within each query: a pair counts only if Profile A’s order is exactly reversed for Profile B. Scores from different queries are never subtracted or combined.</p>
        <H2 id="stored">What is stored</H2>
        <p>Bounded, normalised, task-relevant evidence: resolution choices, relative ordering, provider status, missing and unmapped IDs, with a checksum and capture time. Raw Qloo replies are not persisted and aren’t included in exports.</p>
        <H2 id="coverage">Coverage and gaps</H2>
        <p>A restaurant Qloo didn’t return is <em>missing</em>; one without a confirmed mapping is <em>unmapped</em>. Both are unavailable evidence, never a dislike. If Qloo is unavailable, there is no silent fallback to a language-model-only contrast.</p>
      </>
    ),
  },
  'agent-loop': {
    headings: [{ id: 'bounded', label: 'A bounded loop' }, { id: 'model', label: 'What the model may decide' }, { id: 'investigation', label: 'Investigation' }],
    keywords: ['worker', 'nova micro', 'model decision', 'contrast'],
    Body: () => (
      <>
        <H2 id="bounded">A bounded loop</H2>
        <p>The discovery worker leases a job, resolves and confirms public interests, ranks the catalog for both profiles, computes contrasts, chooses one to investigate, schedules runner attempts and saves a candidate case. Rounds, Qloo calls, model decisions, assistant runs and wall-clock time are all budgeted.</p>
        <H2 id="model">What the model may decide</H2>
        <p>The decision model (Nova Micro through LiteLLM) may only pick one software-computed contrast ID, or none. It can’t choose tools, invent ranking facts or declare a taste failure, and its prose isn’t treated as evidence. Output that references an unsupported contrast is rejected.</p>
        <H2 id="investigation">Investigation</H2>
        <p>The runner repeats both full briefs and, if enabled, asks a focused question about just the two contrasting restaurants. Practical constraints and the eligible catalog never change during investigation.</p>
      </>
    ),
  },
  runner: {
    headings: [{ id: 'what', label: 'What the runner does' }, { id: 'commands', label: 'Commands' }, { id: 'recovery', label: 'Leases and revocation' }],
    keywords: ['cli', 'handshake', 'run-once', 'litellm', 'adapter'],
    Body: () => (
      <>
        <H2 id="what">What the runner does</H2>
        <p>The runner is a small Node program in the TasteCase repository that you run on your own machine. It authenticates with a project-scoped token, claims one attempt, calls your adapter with your local provider credentials and uploads a typed result. TasteCase never receives your assistant’s source code or arbitrary target URLs.</p>
        <H2 id="commands">Commands</H2>
        <ul>
          <li><code>handshake</code> — checks the token and schema version; makes no assistant call and needs no provider key.</li>
          <li><code>run-once</code> — claims at most one attempt, runs it and uploads the result. A “no work” response is normal.</li>
          <li><code>replay</code> — replays an exported pack offline for one role.</li>
        </ul>
        <p>There’s no background daemon and no automatic retry of assistant calls. Use <code>--allow-loopback-http</code> only for a local API over plain HTTP.</p>
        <H2 id="recovery">Leases and revocation</H2>
        <p>Claims are leased for 30–900 seconds. Expired work can be reclaimed under a new lease; stale uploads fail. Identical re-uploads are idempotent; different content for a completed attempt is a visible conflict. Revocation is checked before handshake, claim and upload.</p>
      </>
    ),
  },
  jobs: {
    headings: [{ id: 'durable', label: 'Durable checkpoints' }, { id: 'charges', label: 'Charges and uncertainty' }, { id: 'restart', label: 'Restarts' }],
    keywords: ['lease', 'checkpoint', 'retry', 'restart', 'exactly once'],
    Body: () => (
      <>
        <H2 id="durable">Durable checkpoints</H2>
        <p>Jobs live in Postgres. Accepted evidence and assistant results survive restarts, and a worker resumes from its last checkpoint instead of paying for completed calls again.</p>
        <H2 id="charges">Charges and uncertainty</H2>
        <p>Every provider call is reserved before it’s sent. If a job stops, reserved calls are labelled <em>interrupted</em> and sent calls with no recorded outcome are labelled <em>uncertain</em> — without refunding budgets. Exactly-once calls or billing are not promised.</p>
        <H2 id="restart">Restarts</H2>
        <p>A restart during a verified live run reused saved checkpoints and checksums. Deterministic attempt IDs prevent duplicate accepted work; conflicting duplicates fail visibly.</p>
      </>
    ),
  },
  'version-pinning': {
    headings: [{ id: 'pinned', label: 'Pinned inputs' }, { id: 'new', label: 'Change means a new version' }],
    keywords: ['immutable', 'checksum', 'version'],
    Body: () => (
      <>
        <H2 id="pinned">Pinned inputs</H2>
        <p>Catalog versions, task versions, mapping confirmations, discovery inputs, review evidence, expectation versions, suite versions, comparison plans and final reports are immutable and checksummed. Each later stage references exact earlier versions.</p>
        <H2 id="new">Change means a new version</H2>
        <p>Editing a suite or an expectation creates a new version; it never rewrites an old result. A fresh discovery run creates fresh evidence and doesn’t overwrite historical comparisons.</p>
        <Callout kind="note">Release labels such as <code>concierge-prompt-v2</code> are your local attestation of which configuration ran, not cryptographic proof.</Callout>
      </>
    ),
  },
};
