'use client';

import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton, Time } from '@/components/ui/data';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Section } from '@/components/ui/page';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import type { RunnerCredential } from '@/lib/api/types';
import { useResource } from '@/lib/api/use-resource';

const RUNNER_ENV = `export TASTECASE_API_ORIGIN="<your TasteCase API origin>"
export TASTECASE_RUNNER_TOKEN="<the token shown once above>"
export LITELLM_BASE_URL="<your provider base URL, including /v1 if needed>"
export LITELLM_API_KEY="<your provider key — stays on this machine>"
export LITELLM_MODEL="nova-micro"   # optional; this is the default`;

const RUNNER_COMMANDS = `npm ci --ignore-scripts && npm run build
node packages/runner/dist/cli.js handshake
node packages/runner/dist/cli.js run-once`;

/** The plaintext token exists only in this component's memory until dismissed; it is never stored. */
function TokenOnce({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <Notice tone="advisory" title="Copy this runner token now — it’s shown once" role="alert" actions={<Button variant="secondary" onPress={onDone}>I’ve stored it</Button>}>
      <p>Set it as <code>TASTECASE_RUNNER_TOKEN</code> on the runner machine. TasteCase keeps only a hash, so it can’t show this again. If it’s lost, revoke it and issue another.</p>
      <div className="mt-3 flex items-center gap-1 rounded-control border border-stroke bg-surface pl-3">
        <code tabIndex={0} className="min-w-0 flex-1 overflow-x-auto py-2 font-mono text-meta whitespace-nowrap" aria-label="Runner token">{token}</code>
        <CopyButton value={token} label="Copy runner token" />
      </div>
    </Notice>
  );
}

function CredentialRow({ projectId, credential, onRevoked }: { projectId: string; credential: RunnerCredential; onRevoked: () => void }) {
  const api = useApi();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium break-words">{credential.label}</p>
        <p className="text-meta text-ink-2">Issued <Time iso={credential.createdAt} />{credential.revokedAt ? <> · revoked <Time iso={credential.revokedAt} /></> : null}</p>
        {!credential.revokedAt ? <p className="text-meta text-ink-2">{credential.lastHandshakeAt ? <>Handshake verified <Time iso={credential.lastHandshakeAt} />. Current connection: offline or unknown.</> : 'Credential issued; no verified handshake recorded. Current connection: unknown.'}</p> : null}
        {error ? <ErrorState className="mt-2" error={error} what="this credential" /> : null}
      </div>
      {credential.revokedAt ? <Badge tone="unavailable">Revoked</Badge> : (
        <div className="flex items-center gap-2">
          <Badge tone={credential.lastHandshakeAt ? 'passed' : 'info'}>{credential.lastHandshakeAt ? 'Handshake verified' : 'Issued — unverified'}</Badge>
          <ConfirmDialog title={`Revoke “${credential.label}”?`} confirmLabel="Revoke credential" isPending={pending}
            trigger={<Button variant="destructive">Revoke</Button>}
            onConfirm={async close => {
              setPending(true); setError(null);
              const result = await api.runnerCredentials.revoke(projectId, credential.id);
              setPending(false); close();
              if (result.ok) onRevoked(); else setError(result.error);
            }}>
            <p>Runners using this credential can no longer handshake, claim work or upload results — including retries of an upload already in flight.</p>
            <p>Results already saved stay in the project. This can’t be undone; issue a new credential to reconnect.</p>
          </ConfirmDialog>
        </div>
      )}
    </li>
  );
}

export function RunnerStep({ projectId }: { projectId: string }) {
  const api = useApi();
  const credentials = useResource(() => api.runnerCredentials.list(projectId), [api, projectId]);
  const [label, setLabel] = useState('Local runner');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(false);

  async function mint() {
    if (!label.trim()) return;
    setPending(true); setError(null);
    const result = await api.runnerCredentials.mint(projectId, label.trim());
    setPending(false);
    if (result.ok) { setToken(result.data.token); void credentials.reload(); } else setError(result.error);
  }

  return (
    <Section id="runner" title="1. Connect your runner" description="The runner is a small program on your machine. It claims this project’s work, calls your assistant with your own provider key and uploads typed results.">
      <div className="space-y-5">
        <div className="grid gap-3 md:grid-cols-2">
          <p className="flex gap-2 text-control"><KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" strokeWidth={1.75} />Your provider key stays in the runner’s environment. TasteCase never asks for it.</p>
          <p className="flex gap-2 text-control"><ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" strokeWidth={1.75} />The runner token only works for this project, is stored as a hash and can be revoked.</p>
        </div>
        {token ? <TokenOnce token={token} onDone={() => setToken(null)} /> : null}
        {credentials.status === 'loading' ? <SkeletonRows rows={1} label="Loading runner credentials" /> : null}
        {credentials.status === 'error' ? <ErrorState error={credentials.error} what="runner credentials" onRetry={credentials.reload} retrying={credentials.reloading} /> : null}
        {credentials.status === 'ready' && credentials.data.length > 0 ? (
          <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
            {credentials.data.map(row => <CredentialRow key={row.id} projectId={projectId} credential={row} onRevoked={() => void credentials.reload()} />)}
          </ul>
        ) : null}
        {credentials.status === 'ready' && credentials.data.length === 0 ? <p className="text-ink-2">No runner credential yet.</p> : null}
        <Form onSubmit={event => { event.preventDefault(); void mint(); }} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Credential label" value={label} onChange={setLabel} isRequired maxLength={160} className="sm:w-80" description="Helps you tell runners apart later." />
          <Button type="submit" isPending={pending} pendingLabel="Issuing" isDisabled={!label.trim() || Boolean(token)}>Issue runner credential</Button>
        </Form>
        {error ? <ErrorState error={error} what="a new runner credential" /> : null}
        {error && isUncertain(error) ? <Notice tone="advisory" title="Credential issuance is unconfirmed"><p>Check the saved credential list before issuing another. If a credential was created but its one-time token was lost, revoke it and issue a replacement.</p><Button variant="secondary" onPress={() => void credentials.reload()}>Check saved credentials</Button></Notice> : null}
        <div className="space-y-3">
          <p className="text-control font-medium">On the runner machine</p>
          <p className="text-control text-ink-2">The runner ships in the TasteCase repository. Set these variables in its environment — never pass keys or tokens as command arguments:</p>
          <CodeBlock label="Runner environment" code={RUNNER_ENV} />
          <CodeBlock label="Build, check the handshake, run one attempt" code={RUNNER_COMMANDS} />
          <Notice tone="info" title="Verify the handshake, then check this page">
            <p>A successful handshake returns <code>verifiedAt</code> on the runner machine and records the verification time here. It makes no assistant call. A past handshake proves authentication then, not that the runner is online now. For a local API over plain HTTP, add <code>--allow-loopback-http</code>.</p>
          </Notice>
          <Button variant="secondary" onPress={() => void credentials.reload()} isPending={credentials.reloading}>Check handshake status</Button>
        </div>
      </div>
    </Section>
  );
}
