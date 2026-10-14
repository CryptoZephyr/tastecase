import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { searchDocs } from '@/components/docs/docs-search';
import { ALL_DOCS, DOC_GROUPS } from './nav';
import { buildSearchIndex, docContent } from './registry';

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

  it('keeps implemented wiring separate from hosted/browser proof and sample provisioning', () => {
    const text = (group: string, slug: string) => {
      const Body = docContent(group, slug)!.Body;
      const { container, unmount } = render(<Body />);
      const content = container.textContent ?? '';
      unmount(); return content;
    };
    expect(text('start', 'introduction')).toContain('bounded same-origin proxy');
    const sample = text('start', 'sample-walkthrough');
    expect(sample).toContain('anonymous, read-only sample endpoint is implemented');
    expect(sample).toContain('explicitly simulated provider evidence');
    expect(sample).not.toContain('doesn’t exist yet');
    const limits = text('proof', 'current-limitations');
    expect(limits).toContain('never continuous availability');
    expect(limits).toContain('bounded offset of 10,000');
    expect(limits).not.toContain('List screens show the first 20');
    expect(text('proof', 'verified-evidence')).toContain('No browser, hosted authentication, deployment or live-provider verification was performed for this wiring change');
    expect(text('reference', 'configuration')).toContain('Server-only fixed API origin');
    expect(text('using', 'projects')).toContain('Issuing a credential does not verify a runner');
  });

  it('search finds real pages and headings', () => {
    const index = buildSearchIndex();
    expect(searchDocs(index, 'runner exit codes').some(entry => entry.doc.slug === 'error-codes')).toBe(true);
    expect(searchDocs(index, 'not connected').some(entry => entry.heading?.id === 'not-connected')).toBe(true);
    expect(searchDocs(index, 'zzzz-no-such-term')).toEqual([]);
  });
});
