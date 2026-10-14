import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CaseReview } from '@/components/case/case-review';
import { ReviewPanel, reviewDraftKey } from '@/components/case/review-panel';
import { SessionGate } from '@/components/app/session';
import { ReportTable } from '@/components/comparison/report-parts';
import { ExportPanel } from '@/components/comparison/export-panel';
import { NewComparisonScreen } from '@/components/screens/new-comparison-screen';
import { SuiteScreen } from '@/components/screens/suite-screen';
import { MappingStep } from '@/components/setup/mapping-step';
import { Segmented } from '@/components/ui/choice';
import { ApiProvider } from '@/lib/api/context';
import { fail, ok, type ApiResult } from '@/lib/api/result';
import type { CreateComparisonRequest, CreateMappingConfirmationRequest, ReviewDecisionResponse } from '@/lib/api/types';
import { buildCaseView } from '@/lib/view/case-view';
import { reportRows } from '@/lib/view/comparison-view';
import { quotePosix } from '@/lib/view/shell-quote';
import { fixtureApi } from '@/test/fixture-api';
import * as fx from '@/test/fixtures';

async function fillComparison(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('button', { name: 'Start comparison' });
  await user.type(screen.getByRole('textbox', { name: /Baseline version/ }), 'Fixture baseline');
  await user.type(screen.getByRole('textbox', { name: /Candidate version/ }), 'Fixture candidate');
}

describe('comparison request identity and pinned version selection', () => {
  it.each(['network', 'busy', 'internal'] as const)('reuses the full unchanged main-submit body after %s, but rotates on content change', async kind => {
    const api = fixtureApi();
    const bodies: CreateComparisonRequest[] = [];
    api.comparisons.create = vi.fn(async (_project, body) => { bodies.push(body); return fail({ kind }); });
    const user = userEvent.setup();
    render(<ApiProvider api={api}><NewComparisonScreen projectId={fx.ids.project} suiteId={fx.ids.suite} versionId={fx.ids.suiteVersion} /></ApiProvider>);
    await fillComparison(user);
    await user.click(screen.getByRole('button', { name: 'Start comparison' }));
    await screen.findByText('We couldn’t confirm the comparison started');
    await user.click(screen.getByRole('button', { name: 'Start comparison' }));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await user.type(screen.getByRole('textbox', { name: /Candidate version/ }), ' changed');
    await user.click(screen.getByRole('button', { name: 'Start comparison' }));
    expect(bodies[2].id).not.toBe(bodies[0].id);
  });

  it('fetches the exact requested older version even when absent from the version list', async () => {
    const api = fixtureApi();
    api.suites.versions = vi.fn(async (_project, _suite, window) => ok(window?.offset ? [] : Array.from({ length: 20 }, (_, index) => ({ ...fx.suiteVersion, id: `Fixture newer ${index}`, version: index + 2 }))));
    api.suites.version = vi.fn(async () => ok(fx.suiteVersion));
    api.comparisons.create = vi.fn(async () => fail({ kind: 'network' }));
    const user = userEvent.setup();
    render(<ApiProvider api={api}><NewComparisonScreen projectId={fx.ids.project} suiteId={fx.ids.suite} versionId={fx.ids.suiteVersion} /></ApiProvider>);
    await fillComparison(user);
    expect(api.suites.version).toHaveBeenCalledWith(fx.ids.project, fx.ids.suite, fx.ids.suiteVersion);
    expect((screen.getByRole('combobox', { name: 'Published version' }) as HTMLSelectElement).value).toBe(fx.ids.suiteVersion);
    await user.click(screen.getByRole('button', { name: 'Start comparison' }));
    expect(api.comparisons.create).toHaveBeenCalledWith(fx.ids.project, expect.objectContaining({ suiteVersionId: fx.ids.suiteVersion }));
  });

  it('never silently falls back to the latest version when the requested version is unavailable', async () => {
    const api = fixtureApi();
    api.suites.version = vi.fn(async () => fail({ kind: 'not_found' }));
    render(<ApiProvider api={api}><NewComparisonScreen projectId={fx.ids.project} suiteId={fx.ids.suite} versionId="Fixture unavailable version" /></ApiProvider>);
    await waitFor(() => expect(api.suites.version).toHaveBeenCalled());
    await screen.findByText('We couldn’t find the requested exact suite version');
    expect(screen.queryByRole('button', { name: 'Start comparison' })).toBeNull();
  });

  it('resets to a changed exact version prop when query navigation reuses the screen', async () => {
    const api = fixtureApi();
    const other = { ...fx.suiteVersion, id: 'Fixture other pinned version', version: 2 };
    api.suites.versions = async () => ok([fx.suiteVersion, other]);
    api.suites.version = vi.fn(async (_project, _suite, id) => ok(id === other.id ? other : fx.suiteVersion));
    const { rerender } = render(<ApiProvider api={api}><NewComparisonScreen projectId={fx.ids.project} suiteId={fx.ids.suite} versionId={fx.ids.suiteVersion} /></ApiProvider>);
    await screen.findByRole('button', { name: 'Start comparison' });
    rerender(<ApiProvider api={api}><NewComparisonScreen projectId={fx.ids.project} suiteId={fx.ids.suite} versionId={other.id} /></ApiProvider>);
    await screen.findByRole('button', { name: 'Start comparison' });
    expect(api.suites.version).toHaveBeenLastCalledWith(fx.ids.project, fx.ids.suite, other.id);
    expect((screen.getByRole('combobox', { name: 'Published version' }) as HTMLSelectElement).value).toBe(other.id);
  });

  it('blocks selection from an incomplete later-page history even if the exact snapshot was fetched', async () => {
    const api = fixtureApi();
    api.suites.versions = vi.fn(async (_project, _suite, window) => window?.offset ? fail({ kind: 'network' }) : ok(Array.from({ length: 20 }, () => fx.suiteVersion)));
    render(<ApiProvider api={api}><NewComparisonScreen projectId={fx.ids.project} suiteId={fx.ids.suite} versionId={fx.ids.suiteVersion} /></ApiProvider>);
    await screen.findByText('Couldn’t reach TasteCase');
    expect(screen.queryByRole('button', { name: 'Start comparison' })).toBeNull();
  });
});

describe('mapping content identity and reconciliation', () => {
  it('reuses normalized unchanged IDs, rotates for changed content and shows only the confirmed mapping receipt', async () => {
    const api = fixtureApi();
    api.catalogs.list = async () => ok([{ ...fx.catalog, entries: [{ ...fx.catalog.entries[0], qlooEntityId: undefined }] }]);
    api.mappings.list = async () => ok([]);
    const bodies: CreateMappingConfirmationRequest[] = [];
    api.mappings.create = vi.fn(async (_project, body) => {
      bodies.push(body);
      return bodies.length < 3 ? fail({ kind: 'network' }) : ok({ ...fx.mappings[0], id: body.id, qlooEntityId: body.qlooEntityId });
    });
    const user = userEvent.setup();
    render(<ApiProvider api={api}><MappingStep projectId={fx.ids.project} refreshKey={0} /></ApiProvider>);
    const input = await screen.findByRole('textbox', { name: /Qloo entity ID for Fixture Harbor Grill/ });
    const entity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await user.type(input, entity);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Couldn’t reach TasteCase');
    expect(screen.queryByText('Confirmed')).toBeNull();
    await user.clear(input); await user.type(input, ` ${entity.toUpperCase()} `);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(bodies[1]).toEqual(bodies[0]);
    await user.clear(input); await user.type(input, fx.ids.anchorA);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Confirmed');
    expect(bodies[2].id).not.toBe(bodies[0].id);
    expect(screen.getByText(fx.ids.anchorA)).toBeTruthy();
  });
});

describe('publication selection across owner history', () => {
  it('finds approved cases beyond an unapproved first page', async () => {
    const api = fixtureApi();
    const recent = Array.from({ length: 20 }, (_, index) => ({ ...fx.caseResponse(), case: { ...fx.caseResponse().case, id: `Fixture recent ${index}` } }));
    api.cases.list = vi.fn(async (_project, window) => ok(window?.offset ? [fx.approvedCase] : recent));
    render(<ApiProvider api={api}><SuiteScreen projectId={fx.ids.project} suiteId={fx.ids.suite} /></ApiProvider>);
    expect(await screen.findByRole('group', { name: 'Approved cases' })).toBeTruthy();
    expect(screen.queryByText('No approved cases to publish')).toBeNull();
    expect(api.cases.list).toHaveBeenCalledWith(fx.ids.project, { limit: 20, offset: 20 });
  });

  it('does not expose a partial approved selection when a later page fails', async () => {
    const api = fixtureApi();
    api.cases.list = vi.fn(async (_project, window) => window?.offset ? fail({ kind: 'network' }) : ok(Array.from({ length: 20 }, () => fx.approvedCase)));
    render(<ApiProvider api={api}><SuiteScreen projectId={fx.ids.project} suiteId={fx.ids.suite} /></ApiProvider>);
    await screen.findByText('Couldn’t reach TasteCase');
    expect(screen.queryByRole('group', { name: 'Approved cases' })).toBeNull();
    expect(screen.queryByText('No approved cases to publish')).toBeNull();
  });
});

describe('frozen comparison context in both inspection modes', () => {
  it('keeps constraints, exact releases, traces and pinned ranking limits in full and changes-only', async () => {
    const api = fixtureApi();
    api.suites.version = vi.fn(async () => ok(fx.suiteVersion));
    api.discovery.get = vi.fn();
    const user = userEvent.setup();
    render(<ApiProvider api={api}><ReportTable projectId={fx.ids.project} plan={fx.plan} rows={reportRows(fx.plan, fx.report)} /></ApiProvider>);
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    await waitFor(() => expect(screen.getAllByText(/3 of 4 ranked/)).toHaveLength(2));
    expect(api.suites.version).toHaveBeenCalledWith(fx.ids.project, fx.ids.suite, fx.ids.suiteVersion);
    expect(api.discovery.get).not.toHaveBeenCalled();
    for (const mode of ['Full outputs', 'Changes only']) {
      await user.click(screen.getByRole('radio', { name: mode }));
      expect(screen.getByRole('region', { name: 'Shared constraints' })).toBeTruthy();
      expect(screen.getAllByText(/Missing trace can’t prove/)).toHaveLength(1);
      for (const profile of ['Profile A', 'Profile B']) {
        const section = within(screen.getByRole('region', { name: profile }));
        expect(section.getAllByText('fixture-prompt-v1')).toHaveLength(2);
        expect(section.getAllByText('fixture-prompt-v2')).toHaveLength(2);
        expect(section.getAllByText('Trace partial').length).toBeGreaterThan(0);
        expect(section.getByText(/Missing: Fixture Noodle Bar.*Unmapped: Fixture Corner Cafe/)).toBeTruthy();
      }
    }
    const a = screen.getByRole('region', { name: 'Profile A' });
    const b = screen.getByRole('region', { name: 'Profile B' });
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses one honest case brief in the summary and detail when only one input is present', async () => {
    const rows = reportRows(fx.plan, fx.report).map(row => ({ ...row, profiles: row.profiles.slice(0, 1) }));
    const user = userEvent.setup();
    render(<ApiProvider api={fixtureApi()}><ReportTable projectId={fx.ids.project} plan={fx.plan} rows={rows} /></ApiProvider>);
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByRole('region', { name: 'Case brief' })).toBeTruthy();
    expect(screen.queryByText('Profile A')).toBeNull();
    expect(screen.queryByText('Profile B')).toBeNull();
    expect(screen.queryByText(/Fixture Profile B/)).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Changes only' }));
    expect(screen.getByRole('region', { name: 'Shared constraints' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Profile B' })).toBeNull();
  });

  it('quotes the exported command as a literal rather than shell double quotes', () => {
    const label = 'Fixture review-$(printf SAFE_MARKER)\'\nnext line';
    render(<ApiProvider api={fixtureApi()}><ExportPanel projectId={fx.ids.project} comparisonId={fx.ids.comparison} report={{ ...fx.report, candidateVersion: label }} /></ApiProvider>);
    expect(screen.getByText((_, element) => element?.tagName === 'PRE' && Boolean(element.textContent?.includes(`TASTECASE_ASSISTANT_VERSION=${quotePosix(label)}`)))).toBeTruthy();
  });
});

describe('pending review snapshots and action targets', () => {
  it('does not clear a newer draft when an earlier pending save succeeds', async () => {
    const api = fixtureApi();
    let resolve!: (value: ApiResult<ReviewDecisionResponse>) => void;
    api.cases.review = vi.fn(() => new Promise<ApiResult<ReviewDecisionResponse>>(done => { resolve = done; }));
    const user = userEvent.setup();
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts);
    render(<ApiProvider api={api}><SessionGate><ReviewPanel view={view} onSaved={() => {}} onReloadLatest={async () => {}} /></SessionGate></ApiProvider>);
    await screen.findByRole('radio', { name: /Reject/ });
    await user.click(screen.getByRole('radio', { name: /Reject/ }));
    const rationale = screen.getByRole('textbox', { name: /Rationale/ });
    await user.type(rationale, 'Fixture submitted rationale');
    await user.click(screen.getByRole('button', { name: 'Save decision' }));
    await user.type(rationale, ' plus newer edit');
    await act(async () => { resolve(ok({ schema_version: '1.0.0', head: fx.approvedCase.head, review: fx.reviewRecord, idempotent: false })); });
    await screen.findByRole('status', { name: 'Decision saved' });
    expect((rationale as HTMLTextAreaElement).value).toBe('Fixture submitted rationale plus newer edit');
    expect(sessionStorage.getItem(reviewDraftKey(fx.ids.owner, fx.ids.project, fx.ids.case))).toContain('plus newer edit');
  });

  it('uses 44px minimum classes for segmented actions and evidence chips/peek controls', () => {
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts);
    render(<><Segmented label="Fixture actions" selectedKeys={['one']} items={[{ id: 'one', label: 'Fixture action' }]} /><CaseReview view={view} /></>);
    expect(screen.getByRole('radio', { name: 'Fixture action' }).className).toContain('min-h-11');
    for (const control of screen.getAllByRole('button').filter(button => /Inspect|Fixture Garden Table/.test(button.getAttribute('aria-label') ?? button.textContent ?? ''))) {
      expect(control.className).toContain('min-h-11');
    }
  });
});
