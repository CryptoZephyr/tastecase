import Link from 'next/link';
import { Lockup } from '@/components/brand/logo';
import { routes } from '@/lib/routes';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-[1200px] flex-col px-4 sm:px-6">
      <header className="flex h-16 items-center"><Link href={routes.home} aria-label="TasteCase home" className="rounded-control"><Lockup /></Link></header>
      <main id="main" className="max-w-[56ch] py-16">
        <h1 className="text-title font-medium">This page doesn’t exist</h1>
        <p className="mt-3 text-ink">The address may be mistyped, or the page may have moved.</p>
        <ul className="mt-6 space-y-2 text-control">
          <li><Link href={routes.home} className="text-action underline underline-offset-4">TasteCase home</Link></li>
          <li><Link href={routes.projects} className="text-action underline underline-offset-4">Your projects</Link></li>
          <li><Link href={routes.docs} className="text-action underline underline-offset-4">Docs</Link></li>
        </ul>
      </main>
    </div>
  );
}
