import { cn } from '@/lib/cn';

// Derivatives of the owner-approved Distill PNG (public/brand/tastecase-logo-distill.png, unchanged).
// The mark is alpha-keyed from the original pixels, keeping its silhouette, proportions and colour.
const MARK_RATIO = 817 / 726;

export function Mark({ height = 28, className, alt = '' }: { height?: number; className?: string; alt?: string }) {
  return (
    <img
      src="/brand/tastecase-mark-128.png"
      srcSet="/brand/tastecase-mark-64.png 64w, /brand/tastecase-mark-128.png 128w, /brand/tastecase-mark-256.png 256w, /brand/tastecase-mark-816.png 816w"
      sizes={`${Math.round(height * MARK_RATIO)}px`}
      width={Math.round(height * MARK_RATIO)}
      height={height}
      alt={alt}
      className={cn('shrink-0', className)}
      decoding="async"
    />
  );
}

/** Symbol plus the product name set in the UI typeface; the approved image is symbol-only. */
export function Lockup({ height = 28, className }: { height?: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Mark height={height} />
      <span className="text-[1.125rem] font-semibold tracking-[-0.01em] text-ink">TasteCase</span>
    </span>
  );
}

/** The approved image itself (Emerald Ink symbol on Champagne), used where the full tile reads best. */
export function Tile({ size = 160, className }: { size?: number; className?: string }) {
  return (
    <img src="/brand/tastecase-tile-512.png" srcSet="/brand/tastecase-tile-192.png 192w, /brand/tastecase-tile-512.png 512w" sizes={`${size}px`}
      width={size} height={size} alt="TasteCase logo" className={cn('rounded-panel', className)} decoding="async" />
  );
}
