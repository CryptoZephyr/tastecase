'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button as AriaButton, Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { cn } from '@/lib/cn';
import { Button, type Variant } from './button';

const overlay = 'fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4 transition-opacity duration-150 data-[entering]:opacity-0 data-[exiting]:opacity-0';

/**
 * Confirmation for consequential actions (cancel, revoke, finalize, publish). States what will
 * change and what history stays saved. Focus returns to the trigger when it closes.
 */
export function ConfirmDialog({ trigger, title, children, confirmLabel, confirmVariant = 'destructive', onConfirm, isPending }: {
  trigger: ReactNode; title: string; children: ReactNode; confirmLabel: string; confirmVariant?: Variant;
  onConfirm: (close: () => void) => void; isPending?: boolean;
}) {
  return (
    <DialogTrigger>
      {trigger}
      <ModalOverlay isDismissable={!isPending} className={overlay}>
        <Modal className="w-full max-w-lg rounded-panel bg-surface shadow-float">
          <Dialog role="alertdialog" className="p-6 outline-none">
            {({ close }) => (
              <>
                <Heading slot="title" className="text-section font-medium">{title}</Heading>
                <div className="mt-3 space-y-2 text-control text-ink">{children}</div>
                <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button variant="secondary" onPress={close} isDisabled={isPending}>Keep as is</Button>
                  <Button variant={confirmVariant} onPress={() => onConfirm(close)} isPending={isPending}>{confirmLabel}</Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

/** Side sheet used for the mobile navigation drawer and the evidence inspector on small screens. */
export function Sheet({ isOpen, onOpenChange, title, children, side = 'right', className }: {
  isOpen: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; side?: 'left' | 'right'; className?: string;
}) {
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className={cn(overlay, 'items-stretch p-0', side === 'left' ? 'justify-start' : 'justify-end')}>
      <Modal className={cn('flex h-full w-[min(26rem,100%)] flex-col bg-surface shadow-float', className)}>
        <Dialog className="flex h-full flex-col outline-none" aria-label={title}>
          {({ close }) => (
            <>
              <div className="flex items-center justify-between border-b border-rule px-4 py-2">
                <Heading slot="title" className="font-medium">{title}</Heading>
                <AriaButton onPress={close} aria-label={`Close ${title.toLowerCase()}`} className="inline-flex size-11 items-center justify-center rounded-control text-ink-2 hover:bg-subtle hover:text-ink">
                  <X aria-hidden className="size-5" strokeWidth={1.75} />
                </AriaButton>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
