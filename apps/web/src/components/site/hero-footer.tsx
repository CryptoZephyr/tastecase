import Link from 'next/link';
import { Tile } from '@/components/brand/logo';
import { routes } from '@/lib/routes';

const repositoryUrl = process.env.NEXT_PUBLIC_TASTECASE_REPOSITORY_URL;

/**
 * Owner-selected hero footer: oversized wordmark with the approved Distill logo (shown as the
 * original Emerald-on-Champagne tile, unaltered) on an Emerald Ink band. Only reachable links are
 * listed; GitHub appears once a public repository URL is configured.
 */
export function HeroFooter() {
  const links = [
    { href: routes.sample, label: 'Inspect a case' },
    { href: routes.workflow, label: 'From taste to test' },
    { href: routes.docs, label: 'Docs' },
    ...(repositoryUrl ? [{ href: repositoryUrl, label: 'GitHub', external: true }] : []),
  ];
  return (
    <footer className="on-emerald bg-action text-champagne">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-16 sm:px-6 md:pt-24">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:gap-8">
          <Tile size={112} className="size-20 sm:size-28 md:size-36" />
          <p aria-hidden className="font-sans text-[clamp(3rem,13vw,9.5rem)] font-semibold leading-[0.9] tracking-[-0.03em]">TasteCase</p>
        </div>
        <p className="mt-8 max-w-[46ch] text-body text-champagne">Find recommendation cases worth testing, and keep the reviewed ones for every release.</p>
        <div className="mt-12 flex flex-col gap-6 border-t border-champagne/30 pt-6 md:flex-row md:items-center md:justify-between">
          <nav aria-label="Footer">
            <ul className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-2">
              {links.map(link => (
                <li key={link.href}>
                  {'external' in link
                    ? <a href={link.href} rel="noreferrer" className="inline-flex min-h-11 items-center rounded-control px-2 -mx-2 underline-offset-4 hover:underline sm:mx-0">{link.label}</a>
                    : <Link href={link.href} className="inline-flex min-h-11 items-center rounded-control px-2 -mx-2 underline-offset-4 hover:underline sm:mx-0">{link.label}</Link>}
                </li>
              ))}
            </ul>
          </nav>
          <p className="text-meta text-champagne">© 2026 TasteCase · MIT licensed</p>
        </div>
      </div>
    </footer>
  );
}
