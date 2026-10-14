import type { ReactNode } from 'react';
import { AppHeader } from '@/components/app/app-header';
import { SessionGate } from '@/components/app/session';

export default function PrivateLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <AppHeader />
      <main id="main" className="min-h-[calc(100dvh-4rem)]">{children}</main>
    </SessionGate>
  );
}
