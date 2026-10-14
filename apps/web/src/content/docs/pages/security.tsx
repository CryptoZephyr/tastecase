import { H2 } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const security: DocSection = {
  'project-isolation': {
    headings: [{ id: 'layers', label: 'Isolation at every layer' }, { id: 'not-found', label: 'Not found, not forbidden' }],
    keywords: ['rls', 'row level security', 'owner', 'isolation'],
    Body: () => (
      <>
        <H2 id="layers">Isolation at every layer</H2>
        <p>Your private project is available only to its signed-in owner. Both the API and database enforce this boundary, and private files are not publicly readable. A runner token can access work only in its own project. The public sample is one explicitly selected fictional example, not a way to browse other projects.</p>
        <H2 id="not-found">Not found, not forbidden</H2>
        <p>If another account opens your private link, TasteCase says it could not find it. This avoids revealing whether the project or record exists.</p>
      </>
    ),
  },
  credentials: {
    headings: [{ id: 'owner', label: 'Owner sessions' }, { id: 'runner', label: 'Runner tokens' }, { id: 'provider', label: 'Provider keys' }],
    keywords: ['token', 'hash', 'revoke', 'session', 'supabase auth'],
    Body: () => (
      <>
        <H2 id="owner">Owner sessions</H2>
        <p>TasteCase checks your sign-in session with Supabase before allowing private requests. Expired sessions require you to sign in again.</p>
        <H2 id="runner">Runner tokens</H2>
        <p>A runner token is a secret password for one project’s runner. It is shown only once. Keep it out of chat, screenshots and source code. TasteCase stores a one-way fingerprint, not the token itself. Revoke it if it is lost or exposed; the runner can no longer connect, pick up work or upload results.</p>
        <H2 id="provider">Provider keys</H2>
        <p>Your assistant’s model-provider key stays on the runner machine. Do not paste it into the website. TasteCase’s own Qloo and case-selection keys stay on its backend. See the configuration reference for the exact settings.</p>
      </>
    ),
  },
  'data-boundaries': {
    headings: [{ id: 'qloo', label: 'To Qloo' }, { id: 'exports', label: 'Into exports' }, { id: 'repo', label: 'Never in the repository' }],
    keywords: ['pii', 'privacy', 'guest data', 'export'],
    Body: () => (
      <>
        <H2 id="qloo">To Qloo</H2>
        <p>Use fictional diners and public interests, such as artists or films. Qloo receives those interests and confirmed restaurant IDs, not real guest names, email addresses, histories or model keys. You are responsible for supplying public, safe-to-use inputs.</p>
        <H2 id="exports">Into exports</H2>
        <p>Downloaded test packs include the fictional requests and approved checks, not model keys, Qloo response bodies, assistant text or activity logs. Inputs that look like credentials or URLs are rejected rather than quietly changed. These checks are not a complete secret scanner; review what you put into a project.</p>
        <H2 id="repo">Never in the repository</H2>
        <p>Do not commit credentials, raw Qloo replies, personal guest histories or local test records to source control.</p>
      </>
    ),
  },
  'untrusted-inputs': {
    headings: [{ id: 'model', label: 'Model output' }, { id: 'adapter', label: 'Adapter results' }, { id: 'display', label: 'In the web app' }],
    keywords: ['prompt injection', 'validation', 'allowlist'],
    Body: () => (
      <>
        <H2 id="model">Model output</H2>
        <p>The case-selection model can only choose from pairs already found in the rankings. It cannot invent evidence or declare a taste failure. Unsupported choices are rejected, and provider operations have fixed limits.</p>
        <H2 id="adapter">Adapter results</H2>
        <p>Returned answers must match the expected format and size limit. An invalid answer is shown as malformed, not silently rewritten into a recommendation.</p>
        <H2 id="display">In the web app</H2>
        <p>The app treats assistant text and provider messages as text, not code to run. It does not turn them into executable HTML or clickable links.</p>
      </>
    ),
  },
};
