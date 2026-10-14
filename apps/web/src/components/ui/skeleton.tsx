import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block animate-pulse rounded-control bg-subtle', className)} />;
}

/** Layout-matched placeholder rows for lists and tables while the first response is pending. */
export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-live="polite" className="divide-y divide-rule rounded-panel border border-rule bg-surface">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 p-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonPanel({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn('space-y-3 rounded-panel border border-rule bg-surface p-6', className)}>
      <span className="sr-only">{label}</span>
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
