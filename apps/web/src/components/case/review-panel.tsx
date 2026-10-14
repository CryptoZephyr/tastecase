'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useSession } from '@/components/app/session';
import { RadioCard, RadioGroup } from '@/components/ui/choice';
import { Facts, Hash, Time } from '@/components/ui/data';
import { Field } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ErrorState, Receipt } from '@/components/ui/states';
import { ClassBadge } from '@/components/ui/badge';
import { useApi } from '@/lib/api/context';
import { isUncertain, type UiError } from '@/lib/api/result';
import type { ReviewDecisionRequest } from '@/lib/api/types';
import { z } from 'zod';
import { newId, SCHEMA_VERSION } from '@/lib/ids';
import type { CaseView } from '@/lib/view/case-view';
import { buildExpectation, ExpectationEditor, initialExpectationDraft, type ExpectationDraft } from './expectation-editor';

type Action = 'accept' | 'edit' | 'reject' | 'defer';
interface Draft { action: Action | null; rationale: string; expectation: ExpectationDraft }
const strings = z.array(z.string().max(2000)).max(500);
const storedDraft = z.object({
  version: z.literal(1), candidateId: z.uuid(),
  draft: z.object({ action: z.enum(['accept', 'edit', 'reject', 'defer']).nullable(), rationale: z.string().max(4000), expectation: z.object({
    classification: z.enum(['advisory', 'approved_policy', 'objective_contract']), advisoryRationale: z.string().max(4000),
    policyRules: z.array(z.object({ key: z.string(), kind: z.enum(['recommend_any', 'avoid', 'order']), profileId: z.enum(['a', 'b']), entryIds: strings, before: z.string(), after: z.string() })).max(500),
    objectiveProfiles: z.array(z.enum(['a', 'b'])).max(2), objectiveRules: z.array(z.enum(['output_schema', 'allowed_ids', 'exclusions'])).max(3), exclusionIds: strings,
  }) }), request: z.object({ id: z.uuid(), key: z.string().max(65536), draftKey: z.string().max(131072) }).nullable().optional(),
});

const ACTION_COPY: Record<Action, { title: string; description: string }> = {
  accept: { title: 'Accept as advisory', description: 'Keep the proposed expectation unchanged. It stays advisory and never fails automatically.' },
  edit: { title: 'Edit the expectation', description: 'Write your own scoped expectation: advisory, an approved policy or objective checks.' },
  reject: { title: 'Reject', description: 'Not worth testing. Saved in history; earlier published suites don’t change.' },
  defer: { title: 'Defer', description: 'Decide later. Saved in history without an approval.' },
};

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export const reviewDraftKey = (ownerId: string, projectId: string, caseId: string) => `tastecase:review-draft:${ownerId}:${projectId}:${caseId}`;

export function ReceiptFacts({ record }: { record: NonNullable<CaseView['currentReview']> }) {
  const { decision, expectationVersion } = record;
  const evidence = 'evidence' in decision ? decision.evidence : null;
  const coverage = evidence?.coverage;
  return (
    <Facts items={[
      ['Decision', ACTION_COPY[decision.action].title], ['Revision', decision.revision], ['Saved', <Time key="t" iso={decision.createdAt} />],
      ['Rationale', decision.rationale],
      ['Expectation', expectationVersion ? <ClassBadge key="c" classification={expectationVersion.expectation.classification} /> : 'None approved'],
      ['Pinned evidence', coverage ? `${coverage.completedFullAttempts} of ${coverage.intendedFullAttempts} intended full runs completed` : 'Private review snapshot omitted from public sample'],
      ['Receipt checksum', <Hash key="h" value={decision.checksum} label="receipt checksum" />],
      ...(evidence ? [['Evidence checksum', <Hash key="e" value={evidence.checksum} label="evidence checksum" />] as [string, ReactNode]] : []),
      ...(expectationVersion ? [['Expectation version', <Hash key="v" value={expectationVersion.id} label="expectation version ID" />] as [string, ReactNode]] : []),
    ]} />
  );
}

export function ReviewPanel({ view, onSaved, onReloadLatest }: { view: CaseView; onSaved: () => void; onReloadLatest: () => Promise<void> }) {
  const api = useApi();
  const session = useSession();
  const owner = session.status === 'signed_in' ? session.session.userId : null;
  const key = owner ? reviewDraftKey(owner, view.projectId, view.caseId) : null;
  const [draft, setDraft] = useState<Draft>(() => ({ action: null, rationale: '', expectation: initialExpectationDraft(view) }));
  const [restored, setRestored] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<UiError | null>(null);
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<CaseView['currentReview']>(null);
  const pendingRequest = useRef<{ id: string; key: string; draftKey: string } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = Boolean(draft.action || draft.rationale.trim());

  useEffect(() => {
    if (!key) return;
    try {
      // Never migrate an unscoped legacy draft into a newly verified owner.
      sessionStorage.removeItem(`tastecase:review-draft:${view.caseId}`);
      const saved = sessionStorage.getItem(key);
      if (!saved) return;
      if (saved.length > 262144) { sessionStorage.removeItem(key); return; }
      const parsed = storedDraft.safeParse(JSON.parse(saved));
      if (!parsed.success || parsed.data.candidateId !== view.candidateId) { sessionStorage.removeItem(key); return; }
      const value = parsed.data;
      setDraft(value.draft); setRestored(true);
      if (value.request) {
        try {
          const body = JSON.parse(value.request.key);
          if (body.schema_version === SCHEMA_VERSION && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0 && ['accept', 'edit', 'reject', 'defer'].includes(body.action) && typeof body.rationale === 'string') pendingRequest.current = value.request;
        } catch { /* Reject malformed retry metadata without discarding a valid draft. */ }
      }
    } catch { /* A blocked storage area doesn't prevent reviewing. */ }
  }, [key, view.caseId, view.candidateId]);

  useEffect(() => {
    if (dirty && key) { try { sessionStorage.setItem(key, JSON.stringify({ version: 1, candidateId: view.candidateId, draft, request: pendingRequest.current })); } catch { /* Keep the in-memory draft. */ } }
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, dirty, key, view.candidateId]);

  // If an unconfirmed submission actually saved, the reloaded head points at its request ID.
  useEffect(() => {
    const request = pendingRequest.current;
    if (request && view.currentReview?.decision.id === request.id) {
      setReceipt(view.currentReview); setError(null); pendingRequest.current = null;
      if (request.draftKey === JSON.stringify(draftRef.current)) {
        if (owner) { try { sessionStorage.removeItem(reviewDraftKey(owner, view.projectId, view.caseId)); } catch { /* storage unavailable */ } }
        setDraft({ action: null, rationale: '', expectation: initialExpectationDraft(view) });
      }
    }
  }, [view, owner]);

  function body(): WithoutId<ReviewDecisionRequest> | null {
    const next: Record<string, string> = {};
    if (!draft.action) next.action = 'Choose a decision.';
    if (!draft.rationale.trim()) next.rationale = 'Explain your decision; the rationale is saved with the receipt.';
    else if (draft.rationale.trim().length > 2000) next.rationale = 'Use 2,000 characters or fewer.';
    let expectation;
    if (draft.action === 'edit') { const built = buildExpectation(draft.expectation, view); Object.assign(next, built.errors); expectation = built.expectation; }
    setErrors(next);
    if (Object.keys(next).length || !draft.action) return null;
    const base = { schema_version: SCHEMA_VERSION, expectedRevision: view.head.revision, rationale: draft.rationale.trim() };
    return draft.action === 'edit' ? { ...base, action: 'edit', expectation: expectation! } : { ...base, action: draft.action };
  }

  async function submit() {
    if (sending.current) return;
    const content = pendingRequest.current?.draftKey === JSON.stringify(draft) ? JSON.parse(pendingRequest.current.key) as WithoutId<ReviewDecisionRequest> : body();
    if (!content) return;
    const key = JSON.stringify(content);
    // Same unchanged body keeps the same request ID, so an uncertain retry can't double-apply.
    const id = pendingRequest.current?.key === key ? pendingRequest.current.id : newId();
    const draftKey = JSON.stringify(draft);
    pendingRequest.current = { id, key, draftKey };
    if (owner) { try { sessionStorage.setItem(reviewDraftKey(owner, view.projectId, view.caseId), JSON.stringify({ version: 1, candidateId: view.candidateId, draft, request: pendingRequest.current })); } catch { /* In-memory retry remains available. */ } }
    sending.current = true;
    setPending(true); setError(null);
    const result = await api.cases.review(view.projectId, view.caseId, { ...content, id } as ReviewDecisionRequest);
    sending.current = false;
    if (!mounted.current) return;
    setPending(false);
    if (result.ok) {
      setReceipt(result.data.review); pendingRequest.current = null;
      // A receipt confirms the submitted snapshot, not edits made while it was in flight.
      if (draftKey === JSON.stringify(draftRef.current)) {
        if (owner) { try { sessionStorage.removeItem(reviewDraftKey(owner, view.projectId, view.caseId)); } catch { /* storage unavailable */ } }
        setDraft({ action: null, rationale: '', expectation: initialExpectationDraft(view) });
      }
      onSaved();
    } else setError(result.error);
  }

  return (
    <section id="decision" aria-labelledby="decision-title" className="scroll-mt-24 space-y-5 rounded-panel border border-rule bg-surface p-4 md:p-6">
      <div>
        <h2 id="decision-title" className="text-section font-medium">Your decision</h2>
        <p className="mt-1 text-control text-ink-2">Current revision {view.head.revision} · status {view.head.status}. Proposed expectation: advisory — {view.proposedRationale}</p>
      </div>
      {receipt ? (
        <Receipt title="Decision saved">
          <ReceiptFacts record={receipt} />
          {view.head.revision > receipt.decision.revision ? <p className="mt-3 text-meta text-ink-2">A newer decision exists (revision {view.head.revision}); this receipt is the earlier one.</p> : null}
        </Receipt>
      ) : null}
      {restored && dirty ? <Notice tone="info" title="We restored your unsaved draft">It was kept in this browser tab only. It isn’t saved in TasteCase until you submit it.</Notice> : null}
      <form noValidate onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-5">
        <RadioGroup label="Decision" value={draft.action} onChange={value => setDraft(current => ({ ...current, action: value as Action }))} errorMessage={errors.action} className="max-w-3xl">
          <div className="grid gap-2 md:grid-cols-2">
            {(Object.keys(ACTION_COPY) as Action[]).map(action => <RadioCard key={action} value={action} title={ACTION_COPY[action].title} description={ACTION_COPY[action].description} />)}
          </div>
        </RadioGroup>
        {draft.action === 'edit' ? <ExpectationEditor view={view} draft={draft.expectation} errors={errors} onChange={expectation => setDraft(current => ({ ...current, expectation }))} /> : null}
        <Field label="Rationale" isRequired value={draft.rationale} onChange={rationale => setDraft(current => ({ ...current, rationale }))} multiline rows={4} maxLength={2000} errorMessage={errors.rationale}
          description="Why this decision? Quote what you saw in the evidence if it helps." className="max-w-3xl" />

        {error?.kind === 'conflict' ? (
          <Notice tone="advisory" title="This case changed while you were reviewing" role="alert"
            actions={<Button variant="secondary" onPress={() => { setError(null); void onReloadLatest(); }}>Load the latest revision</Button>}>
            <p>Someone saved a newer decision, so yours wasn’t applied. Your draft is kept. Load the latest revision, check what changed, then submit again.</p>
          </Notice>
        ) : error && isUncertain(error) ? (
          <Notice tone="advisory" title="We couldn’t confirm your decision was saved" role="alert" actions={<>
            <Button variant="secondary" type="submit" isPending={pending}>Retry the same decision</Button>
            <Button variant="text" onPress={() => void onReloadLatest()}>Check the latest revision</Button>
          </>}>
            <p>Your draft is kept. Retrying sends the identical request, so it can’t be applied twice.</p>
          </Notice>
        ) : error ? <ErrorState error={error} what="your decision" /> : null}
        {Object.keys(errors).length ? <p role="alert" className="text-control font-medium text-failed">Fix the highlighted fields. Your draft is kept.</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" isPending={pending} pendingLabel="Saving decision">Save decision</Button>
          {dirty ? <Button variant="text" isDisabled={pending} onPress={() => { if (owner) { try { sessionStorage.removeItem(reviewDraftKey(owner, view.projectId, view.caseId)); } catch { /* storage unavailable */ } } setDraft({ action: null, rationale: '', expectation: initialExpectationDraft(view) }); setErrors({}); setRestored(false); }}>Discard draft</Button> : null}
        </div>
      </form>
    </section>
  );
}
