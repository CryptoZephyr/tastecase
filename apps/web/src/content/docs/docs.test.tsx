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

  it('search finds real pages and headings', () => {
    const index = buildSearchIndex();
    expect(searchDocs(index, 'runner exit codes').some(entry => entry.doc.slug === 'error-codes')).toBe(true);
    expect(searchDocs(index, 'not connected').some(entry => entry.heading?.id === 'not-connected')).toBe(true);
    expect(searchDocs(index, 'zzzz-no-such-term')).toEqual([]);
  });
});
