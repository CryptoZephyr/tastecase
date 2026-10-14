import { Callout, Code, H2, Table } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const reference: DocSection = {
  'adapter-schema': {
    headings: [{ id: 'interface', label: 'Interface' }, { id: 'results', label: 'Result outcomes' }, { id: 'trace', label: 'Trace' }],
    keywords: ['TargetAdapter', 'TargetResult', 'TargetInput', 'contract'],
    Body: () => (
      <>
        <H2 id="interface">Interface</H2>
        <p>Implement <code>TargetAdapter</code> from <code>@tastecase/contracts</code> in trusted local runner code. Provider credentials stay on your machine.</p>
        <Code label="TargetAdapter" code={`interface TargetAdapter {
  readonly name: string;
  readonly version: string;
  run(input: TargetInput, context: { signal: AbortSignal }): Promise<TargetResult>;
}`} />
        <p><code>TargetInput</code> carries the resolved catalog and task versions, synthetic brief and interests, confirmed mappings and eligible catalog IDs. Schema version: <code>1.0.0</code>.</p>
        <H2 id="results">Result outcomes</H2>
        <Table head={['Outcome', 'Meaning']} rows={[
          [<code key="s">success</code>, 'Structured output: ordered recommendations (catalog ID when known, name, optional reason) and optional text. Outside-catalog and name-only items are kept for later checks.'],
          [<code key="m">malformed_output</code>, 'Bounded, redacted invalid output with an error code.'],
          [<code key="p">provider_unavailable</code>, 'No usable provider response, with a safe error and a retryable flag.'],
        ]} />
        <H2 id="trace">Trace</H2>
        <p>Every result has a normalised trace with completeness <code>complete</code>, <code>partial</code> or <code>unavailable</code>, and metadata-only events (start, completion, tool call, tool result). No headers, bodies, tool arguments or credentials. The sample LiteLLM adapter records only start/end metadata and labels its trace partial.</p>
      </>
    ),
  },
  'artifact-schema': {
    headings: [{ id: 'versions', label: 'Versions' }, { id: 'report', label: 'Report contents' }],
    keywords: ['pack', 'report', 'replay report', 'schema'],
    Body: () => (
      <>
        <H2 id="versions">Versions</H2>
        <Table head={['Artifact', 'Version string']} rows={[
          ['Test pack', <code key="p">tastecase-test-pack/1</code>], ['Comparison report', <code key="r">tastecase-comparison-report/1</code>],
          ['Target output contract', <code key="t">tastecase-target-output/1</code>], ['Replay report', <code key="rr">tastecase-replay-report/1</code>],
        ]} />
        <p>Unknown versions, fields or rules, incompatible contexts and altered checksums are rejected before any adapter call.</p>
        <H2 id="report">Report contents</H2>
        <p>Suite and plan checksums, both release labels, completion (complete or partial) and stop reason, progress counts, every planned repeat with its structural result and rule outcomes, per-brief summaries, behaviour changes and limitation codes, all under a final checksum. Reports contain no response text, reasons, errors or trace events.</p>
      </>
    ),
  },
  'result-classes': {
    headings: [{ id: 'two', label: 'Two labels' }, { id: 'classes', label: 'Classes' }, { id: 'outcomes', label: 'Outcomes' }],
    keywords: ['passed', 'failed', 'advisory', 'unavailable', 'mixed', 'not applicable'],
    Body: () => (
      <>
        <H2 id="two">Two labels</H2>
        <p>Every result shows what kind of check it is and, separately, what happened. Button green means an action, not a passed result.</p>
        <H2 id="classes">Classes</H2>
        <Table head={['Class', 'Meaning']} rows={[
          ['Objective check', 'Mechanical contract checks: output shape, allowed IDs, explicit exclusions.'],
          ['Approved policy', 'A rule the owner approved, with its exact profile scope.'],
          ['Advisory · Needs human review', 'Reviewed cultural evidence. Never an automatic failure.'],
          ['Unavailable', 'Missing evidence or execution. Never a pass.'],
        ]} />
        <H2 id="outcomes">Outcomes</H2>
        <Table head={['Outcome', 'When']} rows={[
          ['Passed', 'Only for an executed objective check or explicitly approved policy rule with sufficient evidence.'],
          ['Failed', 'An established violation of a supported rule.'],
          ['Unavailable', 'Provider unavailable, not run, missing IDs or an unsupported evaluation.'],
          ['Not applicable', 'The rule doesn’t apply to this profile, or an order rule’s restaurants weren’t both recommended.'],
          ['Needs human review', 'Advisory expectations.'],
          ['Mixed across repeats', 'Repeats disagreed; each outcome is kept.'],
        ]} />
      </>
    ),
  },
  'error-codes': {
    headings: [{ id: 'api', label: 'API errors' }, { id: 'retries', label: 'Retrying safely' }, { id: 'runner', label: 'Runner exit codes' }],
    keywords: ['409', '404', '503', 'conflict', 'not found', 'exit code'],
    Body: () => (
      <>
        <H2 id="api">API errors</H2>
        <Table head={['Status', 'Code', 'Meaning']} rows={[
          ['400 / 415', <code key="i">invalid_request</code>, 'The body doesn’t match the supported schema.'],
          ['401', <code key="u">unauthorized</code>, 'Missing or expired owner session.'],
          ['401', <code key="c">credential_revoked</code>, 'The runner credential was revoked.'],
          ['403', <code key="f">forbidden</code>, 'Not permitted.'],
          ['404', <code key="n">not_found</code>, 'Unknown, or belongs to another account.'],
          ['409', <code key="x">conflict</code>, 'Stale revision, or an immutable ID reused with different content.'],
          ['409', <code key="l">lease_expired</code>, 'The runner’s lease expired.'],
          ['413', <code key="t">invalid_request</code>, 'The body is too large.'],
          ['503', <code key="b">internal_error</code>, 'Busy or timed out. Retry with the same ID and body.'],
        ]} />
        <H2 id="retries">Retrying safely</H2>
        <p>Request IDs are generated by the caller. Retry an uncertain request with the <strong>same ID and unchanged body</strong>: a matching retry returns the original receipt; different content returns 409. Never generate a fresh ID for a request whose outcome you don’t know.</p>
        <H2 id="runner">Runner exit codes</H2>
        <Table head={['Code', 'Meaning']} rows={[['0', 'Completed, or no work'], ['1', 'Invalid or failed'], ['3', 'Revoked or unauthorised'], ['4', 'API or provider unavailable'], ['5', 'Lease expired']]} />
      </>
    ),
  },
  configuration: {
    headings: [{ id: 'api', label: 'API and worker' }, { id: 'runner', label: 'Runner' }, { id: 'web', label: 'Web app' }],
    keywords: ['env', 'environment variables', 'supabase', 'database'],
    Body: () => (
      <>
        <H2 id="api">API and worker</H2>
        <Table label="API and worker variables" head={['Variable', 'Purpose']} rows={[
          [<code key="d">DATABASE_URL</code>, 'Dedicated Postgres database. Hosted Supabase uses its session pooler with sslmode=verify-full.'],
          [<code key="h">HOST</code>, 'Bind address; loopback by default.'], [<code key="p">PORT</code>, 'HTTP port.'],
          [<code key="s">SUPABASE_URL</code>, 'Verifies real owner sessions.'], [<code key="a">SUPABASE_ANON_KEY</code>, 'Supabase public key for session verification.'],
          [<code key="ca">NODE_EXTRA_CA_CERTS</code>, 'Path to Supabase’s CA certificate.'], [<code key="cf">DATABASE_SSL_CA_FILE</code>, 'Same certificate for the database client.'],
          [<code key="q">QLOO_API_KEY</code>, 'Backend-only Qloo credential.'], [<code key="l">LiteLLM_API_KEY</code>, 'Backend decision model credential.'],
        ]} />
        <H2 id="runner">Runner</H2>
        <Table label="Runner variables" head={['Variable', 'Purpose']} rows={[
          [<code key="o">TASTECASE_API_ORIGIN</code>, 'HTTPS API origin, with no path, query or credentials.'], [<code key="t">TASTECASE_RUNNER_TOKEN</code>, 'Project-scoped token shown once at creation.'],
          [<code key="b">LITELLM_BASE_URL</code>, 'Your provider base URL, including /v1 when needed.'], [<code key="k">LITELLM_API_KEY</code>, 'Your provider key. Stays local.'],
          [<code key="m">LITELLM_MODEL</code>, 'Optional; defaults to nova-micro.'], [<code key="v">TASTECASE_ASSISTANT_VERSION</code>, 'Exact release label, required for comparisons and replay.'],
        ]} />
        <p>Never pass keys or tokens as command-line arguments.</p>
        <H2 id="web">Web app</H2>
        <Table label="Web app variables" head={['Variable', 'Purpose']} rows={[[<code key="r">NEXT_PUBLIC_TASTECASE_REPOSITORY_URL</code>, 'Optional public repository URL. The footer shows a GitHub link only when this is set.']]} />
        <Callout kind="limitation">Anything prefixed <code>NEXT_PUBLIC_</code> is visible to browsers. Never put secrets there.</Callout>
      </>
    ),
  },
};
