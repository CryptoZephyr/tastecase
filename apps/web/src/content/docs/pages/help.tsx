import Link from 'next/link';
import { H2, Table } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const help: DocSection = {
  troubleshooting: {
    headings: [{ id: 'not-connected', label: 'Not connected' }, { id: 'states', label: 'Other states' }, { id: 'runner', label: 'Runner problems' }],
    keywords: ['error', 'unavailable', 'offline', 'expired', 'conflict', 'busy'],
    Body: () => (
      <>
        <H2 id="not-connected">“TasteCase isn’t connected to its service yet”</H2>
        <p>This deployment of the web app has no connection to the TasteCase API, so it can’t load or save anything. It shows this state instead of placeholder data. Nothing you saved elsewhere is lost. Whoever runs this deployment needs to connect it to the API.</p>
        <H2 id="states">Other states</H2>
        <Table head={['You see', 'What it means', 'What to do']} rows={[
          ['Couldn’t reach TasteCase', 'The request may not have arrived, or the answer was lost.', 'Check your connection. Reload before resending anything you just submitted.'],
          ['Your session has ended', 'You need to sign in again.', 'Sign in; you’ll return to the same page. Review drafts are kept in that tab.'],
          ['We couldn’t find …', 'It doesn’t exist, or it belongs to another account.', 'Check the link, or go back to your projects.'],
          ['This changed since you loaded it', 'Someone saved a newer revision.', 'Load the latest revision; your draft is kept.'],
          ['TasteCase is busy', 'A safe temporary refusal.', 'Retry — the same request is sent, so nothing is duplicated.'],
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
    headings: [{ id: 'keys', label: 'Do you see my model keys?' }, { id: 'fail', label: 'Can a taste finding fail a release?' }, { id: 'missing', label: 'What if Qloo doesn’t know a restaurant?' }, { id: 'catalog', label: 'Can I test restaurants outside my catalog?' }],
    keywords: ['questions'],
    Body: () => (
      <>
        <H2 id="keys">Do you see my model keys?</H2>
        <p>No. Your runner holds them locally and uploads typed results only.</p>
        <H2 id="fail">Can a taste finding fail a release?</H2>
        <p>Only if you turn it into an explicit approved policy, such as “for Profile B, never recommend these restaurants”. Advisory findings never fail automatically.</p>
        <H2 id="missing">What if Qloo doesn’t know a restaurant?</H2>
        <p>It’s shown as missing or unmapped — unavailable evidence, never a dislike.</p>
        <H2 id="catalog">Can I test restaurants outside my catalog?</H2>
        <p>No. TasteCase tests against your eligible catalog. If your assistant recommends something outside it, that’s kept and can be checked by an objective rule.</p>
      </>
    ),
  },
};
