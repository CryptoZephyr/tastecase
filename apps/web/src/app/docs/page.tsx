import type { Metadata } from 'next';
import { DocPage } from '@/components/docs/doc-page';

export const metadata: Metadata = { title: 'Docs' };

export default function Page() {
  return <DocPage group="start" slug="introduction" />;
}
