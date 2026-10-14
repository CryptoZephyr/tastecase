import type { ReactNode } from 'react';
import { DocsShell } from '@/components/docs/docs-shell';
import { buildSearchIndex } from '@/content/docs/registry';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsShell index={buildSearchIndex()}>{children}</DocsShell>;
}
