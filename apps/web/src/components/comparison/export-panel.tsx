'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { Facts, Hash, Time } from '@/components/ui/data';
import { Notice } from '@/components/ui/notice';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { UiError } from '@/lib/api/result';
import type { ComparisonFinalReport } from '@/lib/api/types';

function save(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Durable proof: frozen report identity, schema versions, checksums, downloads and verified replay
 * instructions. "Pack downloaded" is a browser fact; a replay is complete only when the runner writes its report.
 */
export function ExportPanel({ projectId, comparisonId, report }: { projectId: string; comparisonId: string; report: ComparisonFinalReport }) {
  const api = useApi();
  const [packChecksum, setPackChecksum] = useState<string | null>(null);
  const [busy, setBusy] = useState<'pack' | 'report' | 'text' | null>(null);
  const [error, setError] = useState<{ what: string; error: UiError } | null>(null);
  const short = comparisonId.slice(0, 8);

  async function download(kind: 'pack' | 'report' | 'text') {
    setBusy(kind); setError(null);
    if (kind === 'pack') {
      const result = await api.comparisons.pack(projectId, comparisonId);
      if (result.ok) { save(`tastecase-pack-${short}.json`, JSON.stringify(result.data, null, 2), 'application/json'); setPackChecksum(result.data.checksum); }
      else setError({ what: 'the test pack', error: result.error });
    } else if (kind === 'report') {
      const result = await api.comparisons.report(projectId, comparisonId);
      if (result.ok) save(`tastecase-report-${short}.json`, JSON.stringify(result.data, null, 2), 'application/json'); else setError({ what: 'the report', error: result.error });
    } else {
      const result = await api.comparisons.readableReport(projectId, comparisonId);
      if (result.ok) save(`tastecase-report-${short}.txt`, result.data, 'text/plain'); else setError({ what: 'the readable report', error: result.error });
    }
    setBusy(null);
  }

  const replay = `export TASTECASE_ASSISTANT_VERSION="${report.candidateVersion}"
node packages/runner/dist/cli.js replay \\
  --pack ./tastecase-pack-${short}.json --role candidate \\
  --pack-checksum ${packChecksum ?? '<pack checksum shown after download>'} \\
  --report ./replay-candidate-${short}.json`;

  return (
    <div className="space-y-5">
      <Facts columns={3} items={[
        ['Report', <Hash key="r" value={report.id} label="report ID" />], ['Finalized', <Time key="t" iso={report.finalizedAt} />],
        ['Completion', report.completion === 'complete' ? 'Complete' : 'Partial'],
        ['Report schema', <code key="s">{report.report_version}</code>], ['Test pack schema', <code key="p">tastecase-test-pack/1</code>],
        ['Report checksum', <Hash key="c" value={report.checksum} label="report checksum" />],
        ['Suite checksum', <Hash key="sc" value={report.suiteChecksum} label="suite checksum" />], ['Plan checksum', <Hash key="pc" value={report.planChecksum} label="plan checksum" />],
      ]} />
      <div className="flex flex-wrap gap-2">
        <Button onPress={() => void download('pack')} isPending={busy === 'pack'} pendingLabel="Preparing pack" icon={<Download aria-hidden className="size-4" strokeWidth={1.75} />}>Download test pack</Button>
        <Button variant="secondary" onPress={() => void download('report')} isPending={busy === 'report'} icon={<Download aria-hidden className="size-4" strokeWidth={1.75} />}>Report (JSON)</Button>
        <Button variant="secondary" onPress={() => void download('text')} isPending={busy === 'text'} icon={<Download aria-hidden className="size-4" strokeWidth={1.75} />}>Report (text)</Button>
      </div>
      {error ? <ErrorState error={error.error} what={error.what} onRetry={() => void download(error.what === 'the test pack' ? 'pack' : error.what === 'the report' ? 'report' : 'text')} /> : null}
      {packChecksum ? (
        <Notice tone="info" title="Pack downloaded" role="status">
          <p>Keep this checksum from the authenticated download as your trusted reference: <code className="break-all">{packChecksum}</code></p>
          <p>Downloading isn’t a replay. TasteCase can’t see local replays; one is complete only when your runner writes its report.</p>
        </Notice>
      ) : null}
      <div className="space-y-2">
        <p className="text-control font-medium">Replay locally before your next release</p>
        <p className="text-control text-ink-2">Replay needs your local provider settings, not a TasteCase login or runner token, and makes no Qloo calls. It runs only the role you choose, so its report is marked <strong>Partial report — only this role ran</strong>; the other role stays pending rather than invented.</p>
        <CodeBlock label="Replay the candidate role" code={replay} />
        <p className="text-meta text-ink-2">Exit codes: 0 completed without a mechanical failure (advisory isn’t a pass) · 2 a rule failed · 4 unavailable or not run · 1 invalid or cancelled. Existing report files are never overwritten.</p>
      </div>
      <p className="text-meta text-ink-2">The pack contains pinned synthetic inputs, approved declarative checks and evidence references. It omits Qloo responses, assistant text, trace events and credentials. A self-checksum detects corruption, not tampering — compare against the checksum above.</p>
    </div>
  );
}
