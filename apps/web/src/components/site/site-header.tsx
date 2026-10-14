'use client';

import { Menu } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Lockup } from '@/components/brand/logo';
import { ButtonLink } from '@/components/ui/button';
import { Sheet } from '@/components/ui/dialog';
import { routes } from '@/lib/routes';

const links = [
  { href: routes.workflow, label: 'From taste to test' },
  { href: routes.docs, label: 'Docs' },
  { href: routes.signIn(), label: 'Sign in' },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
      <Link href={routes.home} aria-label="TasteCase home" className="rounded-control"><Lockup /></Link>
      <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
        {links.map(link => (
          <Link key={link.href} href={link.href} className="inline-flex min-h-11 items-center rounded-control px-3 text-control text-ink hover:bg-white/60">{link.label}</Link>
        ))}
        <ButtonLink href={routes.sample} className="ml-2">Inspect a case</ButtonLink>
      </nav>
      <div className="flex items-center gap-1 md:hidden">
        <ButtonLink href={routes.sample} className="px-3">Inspect a case</ButtonLink>
        <AriaButton onPress={() => setOpen(true)} aria-label="Open menu" className="inline-flex size-11 items-center justify-center rounded-control text-ink hover:bg-white/60">
          <Menu aria-hidden className="size-5" strokeWidth={1.75} />
        </AriaButton>
      </div>
      <Sheet isOpen={open} onOpenChange={setOpen} title="Menu">
        <nav aria-label="Main" className="flex flex-col">
          <Link href={routes.sample} onClick={() => setOpen(false)} className="flex min-h-11 items-center border-b border-rule text-ink">Inspect a case</Link>
          {links.map(link => (
            <Link key={link.href} href={link.href} onClick={() => setOpen(false)} className="flex min-h-11 items-center border-b border-rule text-ink">{link.label}</Link>
          ))}
        </nav>
      </Sheet>
    </header>
  );
}
