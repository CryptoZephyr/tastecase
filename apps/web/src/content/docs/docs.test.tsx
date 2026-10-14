import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { searchDocs } from '@/components/docs/docs-search';
import { ALL_DOCS, DOC_GROUPS } from './nav';
import { buildSearchIndex, docContent } from './registry';

function pageText(group: string, slug: string) {
  const Body = docContent(group, slug)!.Body;
  const { container, unmount } = render(<Body />);
  const content = container.textContent ?? '';
  unmount();
  return content;
}

describe('in-app docs', () => {
  it('covers the seven required groups', () => {
    expect(DOC_GROUPS.map(group => group.title)).toEqual(['Start', 'Using', 'Architecture', 'Reference', 'Security', 'Proof', 'Help']);
  });

  it('has content for every navigation entry, and every listed heading exists on its page', () => {
    for (const doc of ALL_DOCS) {
      const content = docContent(doc.group, doc.slug);
      expect(content, `${doc.group}/${doc.slug}`).toBeTruthy();
      const Body = content!.Body;
      const { container, unmount } = render(<Body />);
      for (const heading of content!.headings) expect(container.querySelector(`h2#${heading.id}`), `${doc.slug}#${heading.id}`).toBeTruthy();
      unmount();
    }
  });

  it('explains the product and assistant versions before technical setup', () => {
    const introduction = pageText('start', 'introduction');
    expect(introduction).toContain('helps teams test an AI assistant that recommends restaurants');
    expect(introduction).toContain('Connect your assistant → find a case → review it → save a test → compare versions');
    expect(introduction).toContain('You do not need two different models');
    expect(introduction).not.toContain('bounded same-origin proxy');
    expect(introduction).not.toContain('Current status');
    expect(introduction).not.toContain('What you can use today');
    expect(docContent('start', 'introduction')!.headings.some(heading => heading.id === 'status')).toBe(false);
    expect(pageText('using', 'projects')).toContain('Creating a token alone does not connect your runner');
    expect(pageText('using', 'comparisons')).toContain('Changing the label alone does not change the prompt or model');
    expect(pageText('help', 'faq')).toContain('Both can use the same model with different prompts');
  });

  it('describes the recorded sample without claiming automatic taste correctness', () => {
    const sample = pageText('start', 'sample-walkthrough');
    expect(sample).toContain('The diners are fictional');
    expect(sample).toContain('came from a real run');
    expect(sample).toContain('Profile A likes Radiohead; Profile B likes Taylor Swift');
    expect(sample).toContain('Gramercy Tavern ahead of Via Carota for Profile A');
    expect(sample).toContain('not an automatic failure');
    expect(sample).toContain('gap in the evidence, not a negative opinion');
    expect(sample).toContain('activity record is also partial');
    expect(sample).toContain('sample is read-only');
    expect(sample).toContain('rather than inventing results');
  });

  it('keeps completed hosted checks separate from simulations and remaining gaps', () => {
    const verified = pageText('proof', 'verified-evidence');
    expect(verified).toContain('A hosted browser run completed discovery');
    expect(verified).toContain('Some automated tests use simulated provider results');
    expect(verified).toContain('Those are not the real results shown in the public sample');
    expect(verified).toContain('checked through both the API and website connection, without sign-in');
    expect(verified).toContain('What remains untested');
    const limits = pageText('proof', 'current-limitations');
    expect(limits).toContain('proves a past connection, not that it is online now');
    expect(limits).toContain('up to an offset of 10,000');
    expect(limits).not.toContain('List screens show the first 20');
    expect(limits).toContain('sleeps after 15 idle minutes');
    expect(pageText('help', 'troubleshooting')).toContain('A timeout does not tell you whether a save reached the server');
    expect(pageText('reference', 'configuration')).toContain('Server-only fixed API origin');
  });

  it('search finds real pages and headings', () => {
    const index = buildSearchIndex();
    expect(searchDocs(index, 'runner exit codes').some(entry => entry.doc.slug === 'error-codes')).toBe(true);
    expect(searchDocs(index, 'not connected').some(entry => entry.heading?.id === 'not-connected')).toBe(true);
    expect(searchDocs(index, 'two models').some(entry => entry.doc.slug === 'faq')).toBe(true);
    expect(searchDocs(index, 'zzzz-no-such-term')).toEqual([]);
  });
});
