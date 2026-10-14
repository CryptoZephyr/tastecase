import { ALL_DOCS, type DocLink } from './nav';
import { architecture } from './pages/architecture';
import { help } from './pages/help';
import { proof } from './pages/proof';
import { reference } from './pages/reference';
import { security } from './pages/security';
import { start } from './pages/start';
import type { DocContent, DocSection } from './pages/types';
import { using } from './pages/using';

const SECTIONS: Record<string, DocSection> = { start, using, architecture, reference, security, proof, help };

export function docContent(group: string, slug: string): DocContent | undefined {
  return SECTIONS[group]?.[slug];
}

export interface SearchEntry { doc: DocLink; heading?: { id: string; label: string }; text: string }

/** Search index built on the server from real pages, summaries, headings and keywords (plain data). */
export function buildSearchIndex(): SearchEntry[] {
  return ALL_DOCS.flatMap(doc => {
    const content = docContent(doc.group, doc.slug);
    return [
      { doc, text: [doc.title, doc.summary, ...(content?.keywords ?? [])].join(' ').toLowerCase() },
      ...(content?.headings ?? []).map(heading => ({ doc, heading, text: `${heading.label} ${doc.title}`.toLowerCase() })),
    ];
  });
}
