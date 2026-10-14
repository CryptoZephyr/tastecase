'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import type { SearchEntry } from '@/content/docs/registry';
import { docHref } from '@/content/docs/nav';

export function searchDocs(index: SearchEntry[], query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return index
    .map(entry => ({ entry, score: terms.reduce((total, term) => total + (entry.text.includes(term) ? (entry.heading ? 1 : 2) : -10), 0) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(row => row.entry);
}

/** Searches page titles, summaries, keywords and section headings. Results are real links. */
export function DocsSearch({ index, onNavigate }: { index: SearchEntry[]; onNavigate?: () => void }) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchDocs(index, query), [index, query]);
  const id = useId();
  return (
    <div role="search">
      <label htmlFor={id} className="sr-only">Search the docs</label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-2" strokeWidth={1.75} />
        <input id={id} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the docs" autoComplete="off" aria-describedby={`${id}-status`}
          className="min-h-11 w-full rounded-control border border-stroke bg-surface pl-9 pr-3 text-control text-ink placeholder:text-ink-2" />
      </div>
      <p id={`${id}-status`} className="sr-only" aria-live="polite">{query ? `${results.length} result${results.length === 1 ? '' : 's'}` : ''}</p>
      {query ? (
        results.length ? (
          <ul className="mt-2 divide-y divide-rule rounded-control border border-rule bg-surface">
            {results.map((entry, position) => (
              <li key={position}>
                <Link href={`${docHref(entry.doc)}${entry.heading ? `#${entry.heading.id}` : ''}`} onClick={() => { setQuery(''); onNavigate?.(); }} className="block px-3 py-2 text-control hover:bg-subtle">
                  <span className="block font-medium">{entry.heading ? entry.heading.label : entry.doc.title}</span>
                  <span className="block text-meta text-ink-2">{entry.heading ? entry.doc.title : entry.doc.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-meta text-ink-2">No pages match “{query}”.</p>
      ) : null}
    </div>
  );
}
