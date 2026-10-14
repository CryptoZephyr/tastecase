'use client';

import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Lockup } from '@/components/brand/logo';
import { ButtonLink } from '@/components/ui/button';
import { Sheet } from '@/components/ui/dialog';
import { DOC_GROUPS, docHref } from '@/content/docs/nav';
import { cn } from '@/lib/cn';
import { routes } from '@/lib/routes';
import type { SearchEntry } from '@/content/docs/registry';
import { DocsSearch } from './docs-search';

function Sidebar({ index, onNavigate }: { index: SearchEntry[]; onNavigate?: () => void }) {
  const pathname = usePathname() ?? '';
  return (
    <div className="space-y-6">
      <DocsSearch index={index} onNavigate={onNavigate} />
      <nav aria-label="Documentation" className="space-y-5">
        {DOC_GROUPS.map(group => (
          <div key={group.slug}>
            <p className="px-2 text-meta font-medium text-ink-2">{group.title}</p>
            <ul className="mt-1 space-y-0.5">
              {group.pages.map(page => {
                const href = docHref(page);
                const active = pathname === href || (pathname === '/docs' && page.slug === 'introduction');
                return (
                  <li key={href}>
                    <Link href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
                      className={cn('flex min-h-10 items-center rounded-control px-2 text-control', active ? 'bg-surface font-medium text-ink' : 'text-ink-2 hover:bg-white/60 hover:text-ink')}>{page.title}</Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}

export function DocsShell({ index, children }: { index: SearchEntry[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-rule bg-canvas/95 backdrop-blur-[2px]">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-4 px-4 md:px-6">
          <div className="flex items-center gap-3">
            <Link href={routes.home} aria-label="TasteCase home" className="rounded-control"><Lockup /></Link>
            <span aria-hidden className="text-ink-2">/</span>
            <Link href={routes.docs} className="text-control font-medium">Docs</Link>
          </div>
          <div className="flex items-center gap-2">
            <Link href={routes.projects} className="hidden min-h-11 items-center rounded-control px-3 text-control text-ink hover:bg-white/60 sm:inline-flex">Projects</Link>
            <ButtonLink href={routes.sample} className="hidden sm:inline-flex">Inspect a case</ButtonLink>
            <AriaButton onPress={() => setOpen(true)} aria-label="Open documentation menu" className="inline-flex size-11 items-center justify-center rounded-control text-ink hover:bg-white/60 lg:hidden">
              <Menu aria-hidden className="size-5" strokeWidth={1.75} />
            </AriaButton>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1400px] gap-8 px-4 md:px-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden lg:block"><div className="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto py-8 pr-2"><Sidebar index={index} /></div></aside>
        <main id="main" className="min-w-0 py-8">{children}</main>
      </div>
      <Sheet isOpen={open} onOpenChange={setOpen} title="Documentation" side="left">
        <Sidebar index={index} onNavigate={() => setOpen(false)} />
        <div className="mt-6 border-t border-rule pt-4"><Link href={routes.projects} onClick={() => setOpen(false)} className="flex min-h-11 items-center text-ink">Projects</Link><Link href={routes.sample} onClick={() => setOpen(false)} className="flex min-h-11 items-center text-ink">Inspect a case</Link></div>
      </Sheet>
    </>
  );
}
