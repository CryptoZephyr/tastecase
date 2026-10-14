import { ArrowLeft, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DOC_GROUPS, docHref, findDoc, neighbours } from '@/content/docs/nav';
import { docContent } from '@/content/docs/registry';

/** One documentation page: title, summary, page contents (desktop rail, mobile disclosure) and prev/next. */
export function DocPage({ group, slug }: { group: string; slug: string }) {
  const doc = findDoc(group, slug);
  const content = docContent(group, slug);
  if (!doc || !content) notFound();
  const { previous, next } = neighbours(group, slug);
  const groupTitle = DOC_GROUPS.find(row => row.slug === group)?.title;
  const toc = (
    <ul className="space-y-1">
      {content.headings.map(heading => <li key={heading.id}><a href={`#${heading.id}`} className="block py-1 text-control text-ink-2 hover:text-ink">{heading.label}</a></li>)}
    </ul>
  );
  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_200px]">
      <article className="min-w-0">
        <p className="text-meta text-ink-2">{groupTitle}</p>
        <h1 className="mt-1 text-title font-medium">{doc.title}</h1>
        <p className="mt-2 max-w-[68ch] text-body text-ink-2">{doc.summary}</p>
        <details className="mt-6 rounded-control border border-rule bg-surface p-3 xl:hidden">
          <summary className="min-h-9 cursor-pointer text-control font-medium">On this page</summary>
          <div className="mt-2">{toc}</div>
        </details>
        <div className="prose-doc mt-8"><content.Body /></div>
        <nav aria-label="Previous and next" className="mt-14 grid gap-3 border-t border-rule pt-6 sm:grid-cols-2">
          {previous ? <Link href={docHref(previous)} className="flex min-h-11 items-center gap-2 rounded-control p-2 text-control hover:bg-white/60"><ArrowLeft aria-hidden className="size-4 shrink-0" strokeWidth={1.75} /><span><span className="block text-meta text-ink-2">Previous</span>{previous.title}</span></Link> : <span />}
          {next ? <Link href={docHref(next)} className="flex min-h-11 items-center justify-end gap-2 rounded-control p-2 text-right text-control hover:bg-white/60"><span><span className="block text-meta text-ink-2">Next</span>{next.title}</span><ArrowRight aria-hidden className="size-4 shrink-0" strokeWidth={1.75} /></Link> : null}
        </nav>
      </article>
      <aside aria-label="On this page" className="hidden xl:block">
        <div className="sticky top-24"><p className="text-meta font-medium text-ink-2">On this page</p><div className="mt-2">{toc}</div></div>
      </aside>
    </div>
  );
}
