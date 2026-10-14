'use client';

import Link from 'next/link';
import { LoaderCircle } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { cn } from '@/lib/cn';

export type Variant = 'primary' | 'secondary' | 'text' | 'destructive' | 'onEmerald';

const base = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-control text-control font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out select-none';
const variants: Record<Variant, string> = {
  primary: 'bg-action px-4 text-white hover:bg-action-hover active:translate-y-px',
  secondary: 'border border-stroke bg-surface px-4 text-action hover:bg-subtle active:translate-y-px',
  text: 'px-1 text-action underline-offset-4 hover:underline',
  destructive: 'border border-failed bg-surface px-4 text-failed hover:bg-failed-bg active:translate-y-px',
  onEmerald: 'border border-champagne bg-champagne px-4 text-action hover:bg-white active:translate-y-px',
};
const disabled = 'data-[disabled]:cursor-not-allowed data-[disabled]:border-rule data-[disabled]:bg-subtle data-[disabled]:text-ink-2 data-[disabled]:translate-y-0';

export function buttonClass(variant: Variant = 'primary', className?: string) {
  return cn(base, variants[variant], className);
}

type ButtonProps = Omit<AriaButtonProps, 'className' | 'children'> & {
  variant?: Variant;
  className?: string;
  icon?: ReactNode;
  children: ReactNode;
  pendingLabel?: string;
};

/** Every button has default, hover, focus, active, disabled and working states. */
export function Button({ variant = 'primary', className, icon, children, pendingLabel, isPending, ...props }: ButtonProps) {
  return (
    <AriaButton {...props} isPending={isPending} className={cn(buttonClass(variant, className), disabled, 'data-[pending]:cursor-progress')}>
      {isPending ? <LoaderCircle aria-hidden className="size-4 animate-spin" strokeWidth={1.75} /> : icon}
      <span>{isPending && pendingLabel ? pendingLabel : children}</span>
    </AriaButton>
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & { variant?: Variant; icon?: ReactNode; iconAfter?: ReactNode };

export function ButtonLink({ variant = 'primary', className, icon, iconAfter, children, ...props }: ButtonLinkProps) {
  return (
    <Link {...props} className={buttonClass(variant, typeof className === 'string' ? className : undefined)}>
      {icon}
      <span>{children}</span>
      {iconAfter}
    </Link>
  );
}

/** Explains why an action is unavailable and links to the missing requirement. */
export function DisabledReason({ id, children }: { id: string; children: ReactNode }) {
  return <p id={id} className="text-meta text-ink-2">{children}</p>;
}
