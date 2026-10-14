'use client';

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Checkbox as AriaCheckbox, CheckboxGroup as AriaCheckboxGroup, FieldError, Label, Radio as AriaRadio, RadioGroup as AriaRadioGroup, Text,
  ToggleButton, ToggleButtonGroup,
  type CheckboxGroupProps, type CheckboxProps, type RadioGroupProps, type ToggleButtonGroupProps,
} from 'react-aria-components';
import { cn } from '@/lib/cn';

export function RadioGroup({ label, description, children, errorMessage, className, ...props }: Omit<RadioGroupProps, 'children' | 'className'> & {
  label: string; description?: ReactNode; children: ReactNode; errorMessage?: string | null; className?: string;
}) {
  return (
    <AriaRadioGroup {...props} isInvalid={Boolean(errorMessage)} className={cn('flex flex-col gap-2', className)}>
      <Label className="text-control font-medium">{label}</Label>
      {description ? <Text slot="description" className="text-meta text-ink-2">{description}</Text> : null}
      {children}
      <FieldError className="text-meta font-medium text-failed">{errorMessage}</FieldError>
    </AriaRadioGroup>
  );
}

/** Card-like radio for meaningful choices with a supporting explanation. */
export function RadioCard({ value, title, description, isDisabled }: { value: string; title: ReactNode; description?: ReactNode; isDisabled?: boolean }) {
  return (
    <AriaRadio value={value} isDisabled={isDisabled} className="group flex min-h-11 cursor-pointer gap-3 rounded-control border border-stroke bg-surface p-3 data-[selected]:border-action data-[selected]:bg-champagne/50 data-[disabled]:cursor-not-allowed data-[disabled]:bg-subtle data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-action">
      <span aria-hidden className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-stroke bg-surface group-data-[selected]:border-action">
        <span className="size-2.5 rounded-full bg-action opacity-0 group-data-[selected]:opacity-100" />
      </span>
      <span className="min-w-0">
        <span className="block text-control font-medium">{title}</span>
        {description ? <span className="mt-0.5 block text-meta text-ink-2">{description}</span> : null}
      </span>
    </AriaRadio>
  );
}

export function Checkbox({ children, className, ...props }: Omit<CheckboxProps, 'children' | 'className'> & { children: ReactNode; className?: string }) {
  return (
    <AriaCheckbox {...props} className={cn('group flex min-h-11 cursor-pointer items-start gap-3 py-2 text-control data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-2', className)}>
      <span aria-hidden className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-[4px] border border-stroke bg-surface group-data-[selected]:border-action group-data-[selected]:bg-action group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-action">
        <Check className="size-3.5 text-white opacity-0 group-data-[selected]:opacity-100" strokeWidth={2.5} />
      </span>
      <span className="min-w-0">{children}</span>
    </AriaCheckbox>
  );
}

export function CheckboxGroup({ label, description, children, errorMessage, className, ...props }: Omit<CheckboxGroupProps, 'children' | 'className'> & {
  label: string; description?: ReactNode; children: ReactNode; errorMessage?: string | null; className?: string;
}) {
  return (
    <AriaCheckboxGroup {...props} isInvalid={Boolean(errorMessage)} className={cn('flex flex-col gap-1', className)}>
      <Label className="text-control font-medium">{label}</Label>
      {description ? <Text slot="description" className="text-meta text-ink-2">{description}</Text> : null}
      {children}
      <FieldError className="text-meta font-medium text-failed">{errorMessage}</FieldError>
    </AriaCheckboxGroup>
  );
}

/** Labelled segmented control (e.g. captured attempts, full vs changes-only view). */
export function Segmented({ label, items, className, ...props }: Omit<ToggleButtonGroupProps, 'children' | 'className'> & {
  label: string; items: { id: string; label: ReactNode; isDisabled?: boolean; description?: string }[]; className?: string;
}) {
  return (
    <ToggleButtonGroup {...props} aria-label={label} selectionMode="single" disallowEmptySelection className={cn('inline-flex flex-wrap gap-1 rounded-control border border-stroke bg-surface p-1', className)}>
      {items.map(item => (
        <ToggleButton key={item.id} id={item.id} isDisabled={item.isDisabled} aria-description={item.description}
          className="min-h-11 rounded-[4px] px-3 text-control text-ink hover:bg-subtle data-[selected]:bg-action data-[selected]:text-white data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-2 data-[disabled]:line-through data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-action">
          {item.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
