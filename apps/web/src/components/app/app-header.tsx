'use client';

import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Lockup } from '@/components/brand/logo';
import { Button, ButtonLink } from '@/components/ui/button';
import { Sheet } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { routes } from '@/lib/routes';
import { useSession } from './session';

function Account() {
  const session = useSession();
  const pathname = usePathname() ?? routes.projects;
  if (session.status === 'signed_in') {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden max-w-[16rem] truncate text-control text-ink-2 lg:inline" title={session.session.email ?? undefined}>{session.session.email ?? 'Signed in'}</span>
        <Button variant="secondary" onPress={() => void session.signOut()}>Sign out</Button>
      </div>
    );
  }
  if (session.status === 'unknown') return <ButtonLink variant="secondary" href={routes.signIn(pathname)}>Sign in</ButtonLink>;
  return <span className="text-control text-ink-2" role="status">Checking session…</span>;
}

export function AppHeader({ drawerContent }: { drawerContent?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? '';
  const session = useSession();
  const nav = [{ href: routes.projects, label: 'Projects' }, { href: routes.docs, label: 'Docs' }];
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-rule bg-canvas/95 backdrop-blur-[2px]">
        <div className="flex h-16 items-center justify-between gap-4 px-4 md:px-6">
          <div className="flex items-center gap-6">
            <Link href={routes.projects} aria-label="TasteCase projects" className="rounded-control"><Lockup /></Link>
            <nav aria-label="Global" className="hidden items-center gap-1 md:flex">
              {nav.map(item => (
                <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}
                  className={cn('inline-flex min-h-11 items-center rounded-control px-3 text-control hover:bg-white/60', pathname.startsWith(item.href) && item.href !== routes.docs ? 'font-medium text-ink' : 'text-ink-2')}>{item.label}</Link>
              ))}
            </nav>
          </div>
          <div className="hidden md:block"><Account /></div>
          <AriaButton onPress={() => setOpen(true)} aria-label="Open navigation" className="inline-flex size-11 items-center justify-center rounded-control text-ink hover:bg-white/60 md:hidden">
            <Menu aria-hidden className="size-5" strokeWidth={1.75} />
          </AriaButton>
        </div>
        {session.status === 'unknown' ? (
          <p role="status" className="border-t border-rule bg-unavailable-bg px-4 py-2 text-meta text-unavailable md:px-6">
            Sign-in status unknown: TasteCase can’t reach its service, so no private data is shown.
          </p>
        ) : null}
      </header>
      <Sheet isOpen={open} onOpenChange={setOpen} title="Navigation" side="left">
        <div onClick={event => { if ((event.target as HTMLElement).closest('a')) setOpen(false); }}>
          {drawerContent}
          <nav aria-label="Global" className="mt-4 flex flex-col border-t border-rule pt-2">
            {nav.map(item => <Link key={item.href} href={item.href} className="flex min-h-11 items-center text-ink">{item.label}</Link>)}
          </nav>
          <div className="mt-4 border-t border-rule pt-4"><Account /></div>
        </div>
      </Sheet>
    </>
  );
}
