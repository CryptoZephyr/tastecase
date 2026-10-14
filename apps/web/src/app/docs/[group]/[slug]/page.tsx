import type { Metadata } from 'next';
import { DocPage } from '@/components/docs/doc-page';
import { ALL_DOCS, findDoc } from '@/content/docs/nav';

export const dynamicParams = false;

export function generateStaticParams() {
  return ALL_DOCS.map(doc => ({ group: doc.group, slug: doc.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ group: string; slug: string }> }): Promise<Metadata> {
  const { group, slug } = await params;
  const doc = findDoc(group, slug);
  return doc ? { title: `${doc.title} · Docs`, description: doc.summary } : {};
}

export default async function Page({ params }: { params: Promise<{ group: string; slug: string }> }) {
  const { group, slug } = await params;
  return <DocPage group={group} slug={slug} />;
}
