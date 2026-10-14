'use client';

import type { ReactNode } from 'react';
import {
  FieldError, Input, Label, Text, TextArea, TextField,
  type TextFieldProps,
} from 'react-aria-components';
import { cn } from '@/lib/cn';

export const controlClass = 'w-full min-h-11 rounded-control border border-stroke bg-surface px-3 py-2 text-control text-ink placeholder:text-ink-2 data-[invalid]:border-failed data-[disabled]:bg-subtle data-[disabled]:text-ink-2 focus:outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-action';

type FieldProps = Omit<TextFieldProps, 'children' | 'className'> & {
  label: string;
  description?: ReactNode;
  errorMessage?: string | null;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  className?: string;
  mono?: boolean;
};

/** Labelled text input with inline description and validation; the entered value is preserved. */
export function Field({ label, description, errorMessage, multiline, rows = 4, placeholder, className, mono, ...props }: FieldProps) {
  return (
    <TextField validationBehavior="aria" {...props} isInvalid={Boolean(errorMessage) || props.isInvalid} className={cn('flex flex-col gap-1.5', className)}>
      <Label className="text-control font-medium text-ink">{label}{props.isRequired ? <span className="text-ink-2"> (required)</span> : null}</Label>
      {description ? <Text slot="description" className="text-meta text-ink-2">{description}</Text> : null}
      {multiline
        ? <TextArea rows={rows} placeholder={placeholder} className={cn(controlClass, 'min-h-24 resize-y leading-6', mono && 'font-mono text-meta')} />
        : <Input placeholder={placeholder} className={cn(controlClass, mono && 'font-mono text-meta')} />}
      <FieldError className="text-meta font-medium text-failed">{errorMessage}</FieldError>
    </TextField>
  );
}

/** Native select: accessible and familiar on every device, styled to the shared control tokens. */
export function NativeSelect({ id, label, value, onChange, options, description, className, disabled }: {
  id: string; label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[];
  description?: ReactNode; className?: string; disabled?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-control font-medium text-ink">{label}</label>
      {description ? <p id={`${id}-description`} className="text-meta text-ink-2">{description}</p> : null}
      <select id={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} aria-describedby={description ? `${id}-description` : undefined}
        className="min-h-11 w-full rounded-control border border-stroke bg-surface px-3 text-control text-ink disabled:bg-subtle disabled:text-ink-2">
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
  );
}

export function FieldGroupLabel({ children, description }: { children: ReactNode; description?: ReactNode }) {
  return (
    <div>
      <p className="text-control font-medium text-ink">{children}</p>
      {description ? <p className="mt-0.5 text-meta text-ink-2">{description}</p> : null}
    </div>
  );
}
