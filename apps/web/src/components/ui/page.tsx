import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function PageHeader({ title, description, actions, meta }: { title: string; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <h1 className="text-title font-medium break-words">{title}</h1>
        {description ? <div className="mt-2 max-w-[68ch] text-ink-2">{description}</div> : null}
        {meta ? <div className="mt-3">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({ title, description, actions, children, className, id, headingLevel = 2 }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={cn('scroll-mt-24', className)}>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Heading id={id ? `${id}-title` : undefined} className="text-section font-medium">{title}</Heading>
          {description ? <div className="mt-1 max-w-[68ch] text-control text-ink-2">{description}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Panel({ children, className, as: As = 'div' }: { children: ReactNode; className?: string; as?: 'div' | 'section' | 'article' | 'li' }) {
  return <As className={cn('rounded-panel border border-rule bg-surface p-4 md:p-6', className)}>{children}</As>;
}
