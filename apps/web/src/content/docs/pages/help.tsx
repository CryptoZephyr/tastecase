import Link from 'next/link';
import { H2, Table } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const help: DocSection = {
  troubleshooting: {
    headings: [{ id: 'cold-start', label: 'A page is taking too long' }, { id: 'not-connected', label: 'Not connected' }, { id: 'states', label: 'Other states' }, { id: 'runner', label: 'Runner problems' }],
    keywords: ['error', 'unavailable', 'offline', 'expired', 'conflict', 'busy', 'free', 'sleep', 'cold start'],
    Body: () => (
      <>
        <H2 id="cold-start">A page is taking too long</H2>
        <p>The free backend sleeps after 15 minutes without traffic. It can take about a minute to wake, which is longer than a page request waits. Wait about a minute, then retry. Your saved work stays in the database.</p>
        <p>If you just submitted something, use the same-request retry or check whether it was saved before starting it again. A timeout does not tell you whether a save reached the server.</p>
        <H2 id="not-connected">“TasteCase isn’t connected to its service yet”</H2>
        <p>This means the website has no configured API connection. It is different from a sleeping service: the deployment owner needs to fix its settings. TasteCase shows an error rather than made-up data.</p>
        <H2 id="states">Other states</H2>
        <Table head={['You see', 'What it means', 'What to do']} rows={[
          ['Couldn’t reach TasteCase', 'The request may not have arrived, or the answer was lost.', 'Check your connection. Reload before resending anything you just submitted.'],
          ['Your session has ended', 'You need to sign in again.', 'Sign in; you’ll return to the same page. Review drafts are kept in that tab.'],
          ['We couldn’t find …', 'It doesn’t exist, or it belongs to another account.', 'Check the link, or go back to your projects.'],
          ['This changed since you loaded it', 'Someone saved a newer revision.', 'Load the latest revision; your draft is kept.'],
          ['TasteCase is busy', 'The service is temporarily unable to answer.', 'Use the retry button. An unchanged save uses its original request ID.'],
          ['We couldn’t confirm …', 'The outcome of a save is unknown.', 'Use “Retry the same …”, or check the latest state first.'],
        ]} />
        <H2 id="runner">Runner problems</H2>
        <Table head={['Symptom', 'Likely cause']} rows={[
          ['Exit code 3', 'The token is wrong or was revoked. Issue a new credential.'],
          ['Exit code 4', 'The API or your provider is unavailable. Nothing was concluded from the gap.'],
          ['Exit code 5', 'The lease expired; the work can be claimed again.'],
          ['“No work”', 'Nothing is queued for this project, or for the release label you bound.'],
        ]} />
        <p>See <Link href="/docs/reference/error-codes">Error codes</Link> for the full list.</p>
      </>
    ),
  },
  faq: {
    headings: [{ id: 'keys', label: 'Do you see my model keys?' }, { id: 'fail', label: 'Can a taste finding fail a release?' }, { id: 'missing', label: 'What if Qloo doesn’t know a restaurant?' }, { id: 'catalog', label: 'Can I test restaurants outside my catalog?' }, { id: 'models', label: 'Do I need two different models?' }],
    keywords: ['questions', 'same model', 'two models', 'baseline', 'candidate'],
    Body: () => (
      <>
        <H2 id="keys">Do you see my model keys?</H2>
        <p>No. Your provider key stays on the machine running your assistant. The runner sends back the answer and a limited activity record, not the key.</p>
        <H2 id="fail">Can a taste finding fail a release?</H2>
        <p>An advisory finding cannot. You must first choose a supported rule, such as “for Profile B, never recommend these restaurants”, and approve it. Then a new run can pass or fail that rule.</p>
        <H2 id="missing">What if Qloo doesn’t know a restaurant?</H2>
        <p>You will see a gap in the evidence. That does not mean the diner dislikes it, and your assistant may still recommend it if it is allowed by your task.</p>
        <H2 id="catalog">Can I test restaurants outside my catalog?</H2>
        <p>The task uses your allowed restaurant list. If your assistant suggests something outside it, TasteCase keeps that answer so an approved check can flag it.</p>
        <H2 id="models">Do I need two different models?</H2>
        <p>No. Baseline is your current assistant; Candidate is the version you want to try. Both can use the same model with different prompts. Configure those differences locally — changing a release label alone does not change the assistant.</p>
      </>
    ),
  },
};
