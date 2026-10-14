'use client';

import { ChevronDown, Lock } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet } from '@/components/ui/dialog';
import { useApi } from '@/lib/api/context';
import { useResource } from '@/lib/api/use-resource';
import { cn } from '@/lib/cn';
import { routes } from '@/lib/routes';

function sections(projectId: string) {
  return [
    { href: routes.project(projectId), label: 'Overview', exact: true },
    { href: routes.setup(projectId), label: 'Setup' },
    { href: routes.discover(projectId), label: 'Discover' },
    { href: routes.cases(projectId), label: 'Cases' },
    { href: routes.suites(projectId), label: 'Suites' },
    { href: routes.comparisons(projectId), label: 'Comparisons' },
  ];
}

/** Persistent project title, privacy label and stage context around every project screen. */
export function ProjectFrame({ projectId, children }: { projectId: string; children: ReactNode }) {
  const api = useApi();
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(false);
  const project = useResource(() => api.projects.get(projectId), [api, projectId]);
  const items = sections(projectId);
  const current = items.find(item => (item.exact ? pathname === item.href : pathname.startsWith(item.href))) ?? items[0];
  const isCurrent = (item: (typeof items)[number]) => item === current;

  const navList = (variant: 'side' | 'tabs' | 'drawer') => (
    <ul className={cn(variant === 'tabs' ? 'flex gap-1 overflow-x-auto' : 'flex flex-col gap-0.5')}>
      {items.map(item => (
        <li key={item.href} className="shrink-0">
          <Link href={item.href} aria-current={isCurrent(item) ? 'page' : undefined} onClick={() => setOpen(false)}
            className={cn('flex min-h-11 items-center rounded-control px-3 text-control',
              isCurrent(item) ? 'bg-surface font-medium text-ink' : 'text-ink-2 hover:bg-white/60 hover:text-ink',
              variant === 'tabs' && isCurrent(item) && 'border border-rule')}>
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="xl:grid xl:grid-cols-[216px_1fr]">
      <aside className="hidden border-r border-rule xl:block">
        <nav aria-label="Project" className="sticky top-16 p-3">{navList('side')}</nav>
      </aside>
      <div className="min-w-0">
        <div className="border-b border-rule px-4 pb-3 pt-5 md:px-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {project.status === 'ready'
              ? <p className="text-section font-medium break-words">{project.data.name}</p>
              : project.status === 'loading' ? <Skeleton className="h-6 w-48" /> : <p className="text-section font-medium text-ink-2">Project</p>}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-subtle px-2.5 py-0.5 text-meta text-ink">
              <Lock aria-hidden className="size-3.5" strokeWidth={2} /> Private project
            </span>
          </div>
          <p className="mt-1 text-meta text-ink-2">Stage: {current.label}</p>
          <nav aria-label="Project" className="mt-3 hidden md:block xl:hidden">{navList('tabs')}</nav>
          <AriaButton onPress={() => setOpen(true)} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-control border border-stroke bg-surface px-3 text-control md:hidden">
            Sections: {current.label} <ChevronDown aria-hidden className="size-4" strokeWidth={1.75} />
          </AriaButton>
        </div>
        <Sheet isOpen={open} onOpenChange={setOpen} title="Project sections" side="left">
          <nav aria-label="Project">{navList('drawer')}</nav>
        </Sheet>
        <div className="px-4 py-6 md:px-8 md:py-8">{children}</div>
      </div>
    </div>
  );
}
