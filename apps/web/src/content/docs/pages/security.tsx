import { H2 } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const security: DocSection = {
  'project-isolation': {
    headings: [{ id: 'layers', label: 'Isolation at every layer' }, { id: 'not-found', label: 'Not found, not forbidden' }],
    keywords: ['rls', 'row level security', 'owner', 'isolation'],
    Body: () => (
      <>
        <H2 id="layers">Isolation at every layer</H2>
        <p>Every private row carries its project boundary. The API checks project ownership on every owner route; Postgres enforces forced row-level owner isolation; composite foreign keys prevent cross-project references; private storage denies anonymous, public and cross-project access; runner tokens are bound to one project.</p>
        <H2 id="not-found">Not found, not forbidden</H2>
        <p>Another account receives 404 for your projects, jobs, evidence, cases, suites and artifacts. The web app shows that as “not found or belongs to another account” — never as an empty list.</p>
      </>
    ),
  },
  credentials: {
    headings: [{ id: 'owner', label: 'Owner sessions' }, { id: 'runner', label: 'Runner tokens' }, { id: 'provider', label: 'Provider keys' }],
    keywords: ['token', 'hash', 'revoke', 'session', 'supabase auth'],
    Body: () => (
      <>
        <H2 id="owner">Owner sessions</H2>
        <p>Owner requests are verified through Supabase Auth on the server, not by decoding token claims or trusting caller-supplied owner IDs.</p>
        <H2 id="runner">Runner tokens</H2>
        <p>A runner token is 32 random bytes, shown once at creation. Only its SHA-256 hash is stored, and listings never return the token or hash. Revocation stops new handshakes, claims and uploads immediately.</p>
        <H2 id="provider">Provider keys</H2>
        <p>Your assistant’s provider key lives only in the runner’s environment. The hosted app never asks for it. Qloo and decision-model keys stay on the backend; the Qloo child process receives only what it needs.</p>
      </>
    ),
  },
  'data-boundaries': {
    headings: [{ id: 'qloo', label: 'To Qloo' }, { id: 'exports', label: 'Into exports' }, { id: 'repo', label: 'Never in the repository' }],
    keywords: ['pii', 'privacy', 'guest data', 'export'],
    Body: () => (
      <>
        <H2 id="qloo">To Qloo</H2>
        <p>Only genuinely public cultural anchors and your catalog’s confirmed entity IDs. No names, emails, account or device IDs, guest histories or credentials. Profile interests must be public entities; that provenance is your responsibility, not a semantic detector’s.</p>
        <H2 id="exports">Into exports</H2>
        <p>Test packs contain pinned synthetic inputs, approved checks and structural evidence references — not Qloo responses, assistant text, trace events or credentials. Required input that looks like a credential or URL is refused, not silently redacted. Detection is conservative, not a universal secret scanner.</p>
        <H2 id="repo">Never in the repository</H2>
        <p>Credentials, raw Qloo responses, personal guest histories and local evidence are never committed.</p>
      </>
    ),
  },
  'untrusted-inputs': {
    headings: [{ id: 'model', label: 'Model output' }, { id: 'adapter', label: 'Adapter results' }, { id: 'display', label: 'In the web app' }],
    keywords: ['prompt injection', 'validation', 'allowlist'],
    Body: () => (
      <>
        <H2 id="model">Model output</H2>
        <p>The decision model can only choose from code-computed contrast IDs. Unsupported choices or extra claims are rejected rather than stored as a verdict. Tools run only through a schema-validated allowlist within budgets.</p>
        <H2 id="adapter">Adapter results</H2>
        <p>Uploaded results are validated against the contract, bounded in size and checksummed. Malformed output is stored as malformed — never coerced into a recommendation.</p>
        <H2 id="display">In the web app</H2>
        <p>Assistant text, names and provider messages are rendered as plain text, never as HTML or links.</p>
      </>
    ),
  },
};
