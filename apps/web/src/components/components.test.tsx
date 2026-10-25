import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CaseReview } from '@/components/case/case-review';
import { ReviewPanel } from '@/components/case/review-panel';
import { ProjectsScreen } from '@/components/screens/projects-screen';
import { SampleScreen } from '@/components/screens/sample-screen';
import { RunnerStep } from '@/components/setup/runner-step';
import { ClassBadge, OutcomeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { ApiProvider } from '@/lib/api/context';
import { buildCaseView } from '@/lib/view/case-view';
import { fixtureApi } from '@/test/fixture-api';
import * as fx from '@/test/fixtures';

describe('result labels', () => {
  it('keeps class separate from outcome and reserves Passed for executed checks', () => {
    render(<><ClassBadge classification="advisory" /><OutcomeBadge outcome="advisory" /><OutcomeBadge outcome="unavailable" /><OutcomeBadge outcome="pass" /></>);
    expect(screen.getByText('Advisory · Needs human review')).toBeTruthy();
    expect(screen.getByText('Needs human review')).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getAllByText('Passed')).toHaveLength(1);
  });
});

describe('projects screen states', () => {
  it('shows the not-connected state, never an empty list', async () => {
    render(<ApiProvider api={fixtureApi({ scenario: 'not_connected' })}><ProjectsScreen /></ApiProvider>);
    expect(await screen.findByText('TasteCase isn’t connected to its service yet')).toBeTruthy();
    expect(screen.queryByText('No projects yet')).toBeNull();
  });
  it('distinguishes a failed request from an empty account', async () => {
    const { unmount } = render(<ApiProvider api={fixtureApi({ scenario: 'network' })}><ProjectsScreen /></ApiProvider>);
    expect(await screen.findByText('Couldn’t reach TasteCase')).toBeTruthy();
    expect(screen.queryByText('No projects yet')).toBeNull();
    unmount();
    render(<ApiProvider api={fixtureApi({ scenario: 'empty' })}><ProjectsScreen /></ApiProvider>);
    expect(await screen.findByText('No projects yet')).toBeTruthy();
  });
});

describe('public sample', () => {
  it('shows the actual unavailable state with no stand-in results', async () => {
    render(<ApiProvider api={fixtureApi({ scenario: 'not_connected' })}><SampleScreen /></ApiProvider>);
    expect(await screen.findByText('TasteCase isn’t connected to its service yet')).toBeTruthy();
    expect(screen.getByText(/Public sample · fictional diners · real recorded results · read-only/)).toBeTruthy();
    expect(screen.getByText(/No made-up results are shown instead/)).toBeTruthy();
    expect(screen.queryByText(/Fixture/)).toBeNull();
  });
});

describe('runner setup instructions', () => {
  it('configures the default OpenRouter adapter and explicitly binds an assistant release', async () => {
    render(<ApiProvider api={fixtureApi()}><RunnerStep projectId={fx.ids.project} /></ApiProvider>);
    await screen.findByRole('button', { name: 'Issue runner credential' });
    const environment = screen.getByText(/export OPENROUTER_API_KEY/).textContent!;
    expect(environment).toContain('TASTECASE_MODEL_PROVIDER="openrouter"');
    expect(environment).toContain('TASTECASE_ASSISTANT_VERSION=');
    expect(environment).toContain('TASTECASE_API_ORIGIN=');
    expect(environment).not.toContain('LITELLM_');
    expect(environment).not.toContain('nova-micro');
  });
});

describe('case review', () => {
  it('renders paired sections with repeated profile labels and evidence limits before the decision', () => {
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts);
    render(<CaseReview view={view} decision={<section id="decision">Decision</section>} />);
    expect(screen.getAllByText('Profile A').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('Profile B').length).toBeGreaterThanOrEqual(3);
    const limits = screen.getByRole('heading', { name: 'Evidence limits' });
    const decision = screen.getByText('Decision');
    expect(limits.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText('Advisory · Needs human review').length).toBeGreaterThan(0);
    expect(screen.queryByText('Passed')).toBeNull();
  });

  it('shows one Case brief and no Profile B for a single-brief case', () => {
    const view = buildCaseView(fx.singleBriefCase(), fx.jobDetail(), fx.attempts);
    render(<CaseReview view={view} />);
    expect(screen.getAllByText('Case brief').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('Profile B')).toBeNull();
  });

  it('shows Qloo signals as unavailable when ranking evidence has no optional signal fields', () => {
    render(<CaseReview view={buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts)} />);
    const signals = screen.getByRole('region', { name: 'Qloo signals' });
    expect(within(signals).getByText('Qloo signals unavailable for this ranking.')).toBeTruthy();
    expect(within(signals).queryByText('Profile A')).toBeNull();
    expect(screen.getByText("Advisory Qloo evidence. Scores are relative to this request and aren't a quality verdict.")).toBeTruthy();
  });

  it('renders affinity, anchor influence and one-sided Qloo tags from ranking evidence', () => {
    const job = fx.jobDetail();
    const ranking = job.evidence.find(row => row.data.kind === 'rank' && row.data.profileId === 'a' && row.data.scope === 'full');
    const confirmation = job.confirmations.find(row => row.anchorId === fx.ids.anchorA);
    expect(ranking?.data.kind).toBe('rank');
    expect(confirmation).toBeTruthy();
    const enrichedJob = {
      ...job,
      evidence: job.evidence.map(row => row.id !== ranking?.id || row.data.kind !== 'rank' ? row : {
        ...row,
        data: {
          ...row.data,
          affinities: [
            { entryId: 'fx-harbor', affinity: 0.82, interests: [{ anchorConfirmationId: confirmation!.id, score: 0.63 }] },
            { entryId: 'fx-garden', affinity: 0.54, interests: [] },
          ],
          entryTags: [{ entryId: 'fx-harbor', tags: [{ type: 'urn:tag:cuisine:qloo' as const, name: 'Fixture cuisine' }] }],
        },
      }),
    };
    render(<CaseReview view={buildCaseView(fx.caseResponse(), enrichedJob, fx.attempts)} />);
    expect(screen.getByText(/0\.82/)).toBeTruthy();
    expect(screen.getByText(/gap 0\.28/)).toBeTruthy();
    expect(screen.getByText(/Fixture Jazz Artist 63%/)).toBeTruthy();
    expect(screen.getByText(/Fixture cuisine · only on this side/)).toBeTruthy();
  });

  it('highlights a selected restaurant everywhere and states where it is absent', async () => {
    const user = userEvent.setup();
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts);
    render(<CaseReview view={view} />);
    const chips = screen.getAllByRole('button', { name: /Fixture Garden Table/ });
    await user.click(chips[0]);
    expect(screen.getAllByRole('button', { name: /Fixture Garden Table/, pressed: true }).length).toBe(chips.length);
    expect(screen.getAllByText(/Fixture Garden Table: not recommended in this output/).length).toBeGreaterThan(0);
  });

  it.each(['trigger', 'panel', 'close button'])('dismisses the desktop inspector from %s and returns focus to its trigger', async action => {
    const media = vi.spyOn(window, 'matchMedia').mockReturnValue({ ...window.matchMedia(''), matches: true });
    try {
      const user = userEvent.setup();
      render(<CaseReview view={buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts)} />);
      const trigger = screen.getAllByRole('button', { name: /Inspect/ })[0]!;
      trigger.focus();
      await user.keyboard('{Enter}');
      const panel = screen.getByRole('complementary', { name: 'Evidence inspector' });
      const close = within(panel).getByRole('button', { name: 'Close inspector' });
      if (action === 'close button') await user.click(close);
      else {
        if (action === 'panel') close.focus();
        await user.keyboard('{Escape}');
      }
      expect(screen.queryByRole('complementary', { name: 'Evidence inspector' })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally { media.mockRestore(); }
  });

  it('dismisses a nested confirmation before the desktop inspector', async () => {
    const media = vi.spyOn(window, 'matchMedia').mockReturnValue({ ...window.matchMedia(''), matches: true });
    try {
      const user = userEvent.setup();
      render(<CaseReview view={buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts)} decision={
        <ConfirmDialog trigger={<Button>Fixture confirmation</Button>} title="Fixture confirm" confirmLabel="Fixture confirm action" onConfirm={() => {}}>
          Fixture confirmation text
        </ConfirmDialog>
      } />);
      const trigger = screen.getAllByRole('button', { name: /Inspect/ })[0]!;
      trigger.focus();
      await user.keyboard('{Enter}');
      const confirmation = screen.getByRole('button', { name: 'Fixture confirmation' });
      await user.click(confirmation);
      expect(screen.getByRole('alertdialog')).toBeTruthy();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(confirmation));
      expect(screen.getByRole('complementary', { name: 'Evidence inspector' })).toBeTruthy();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('complementary', { name: 'Evidence inspector' })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally { media.mockRestore(); }
  });

  it('leaves the inspector open when a child consumes Escape', async () => {
    const media = vi.spyOn(window, 'matchMedia').mockReturnValue({ ...window.matchMedia(''), matches: true });
    try {
      const user = userEvent.setup();
      render(<CaseReview view={buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts)} decision={
        <input aria-label="Fixture editor" onKeyDown={event => event.preventDefault()} />
      } />);
      screen.getAllByRole('button', { name: /Inspect/ })[0]!.focus();
      await user.keyboard('{Enter}');
      screen.getByRole('textbox', { name: 'Fixture editor' }).focus();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('complementary', { name: 'Evidence inspector' })).toBeTruthy();
    } finally { media.mockRestore(); }
  });
});

describe('review decision', () => {
  it('keeps the draft and explains a conflict instead of claiming a save', async () => {
    const user = userEvent.setup();
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts);
    render(<ApiProvider api={fixtureApi({ mutation: 'conflict' })}><ReviewPanel view={view} onSaved={() => {}} onReloadLatest={async () => {}} /></ApiProvider>);
    await user.click(screen.getByRole('radio', { name: /Reject/ }));
    await user.type(screen.getByRole('textbox', { name: /Rationale/ }), 'Fixture rationale kept');
    await user.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(await screen.findByText('This case changed while you were reviewing')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /Rationale/ }) as HTMLTextAreaElement).value).toBe('Fixture rationale kept');
    expect(screen.queryByText('Decision saved')).toBeNull();
  });

  it('requires a rationale before sending', async () => {
    const user = userEvent.setup();
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts);
    render(<ApiProvider api={fixtureApi()}><ReviewPanel view={view} onSaved={() => {}} onReloadLatest={async () => {}} /></ApiProvider>);
    await user.click(screen.getByRole('radio', { name: /Defer/ }));
    await user.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(screen.getByText(/Explain your decision/)).toBeTruthy();
  });

  it('shows a durable receipt only after the API confirms the save', async () => {
    const user = userEvent.setup();
    const view = buildCaseView(fx.caseResponse(), fx.jobDetail(), fx.attempts);
    render(<ApiProvider api={fixtureApi()}><ReviewPanel view={view} onSaved={() => {}} onReloadLatest={async () => {}} /></ApiProvider>);
    await user.click(screen.getByRole('radio', { name: /Accept as advisory/ }));
    await user.type(screen.getByRole('textbox', { name: /Rationale/ }), 'Fixture rationale');
    await user.click(screen.getByRole('button', { name: 'Save decision' }));
    const receipt = await screen.findByRole('status', { name: 'Decision saved' });
    expect(within(receipt).getByText('Receipt checksum')).toBeTruthy();
  });
});
