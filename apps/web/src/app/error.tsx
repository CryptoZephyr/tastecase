'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { routes } from '@/lib/routes';

/** Unexpected rendering error. Saved work lives in TasteCase, not in this page, so nothing is lost by retrying. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="mx-auto max-w-[640px] px-4 py-16">
      <h1 className="text-title font-medium">This page hit an unexpected problem</h1>
      <p className="mt-3 text-ink">Your saved records aren’t affected. Try again, or go back to your projects.</p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onPress={reset}>Try again</Button>
        <Link href={routes.projects} className="text-control text-action underline underline-offset-4">Your projects</Link>
      </div>
    </main>
  );
}
