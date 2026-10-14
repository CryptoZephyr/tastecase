import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { ApiProvider } from '@/lib/api/context';
import './globals.css';

// Self-hosted (SIL OFL 1.1, licenses in ./fonts). No font request leaves the site at runtime.
const manrope = localFont({
  src: [{ path: './fonts/manrope-latin-wght-normal.woff2', weight: '200 800', style: 'normal' }],
  variable: '--font-manrope',
  display: 'swap',
  fallback: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
});
const plexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-plex-mono',
  display: 'swap',
  fallback: ['ui-monospace', 'Consolas', 'monospace'],
});

export const metadata: Metadata = {
  title: { default: 'TasteCase — find recommendation cases worth testing', template: '%s · TasteCase' },
  description: 'TasteCase helps teams building AI travel concierges find difficult dining recommendation cases and preserve reviewed tests across releases.',
  applicationName: 'TasteCase',
};

export const viewport: Viewport = { themeColor: '#f8e7c9', colorScheme: 'light' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${plexMono.variable}`}>
      <body className="bg-canvas font-sans text-ink antialiased">
        <a href="#main" className="sr-only z-50 rounded-control bg-action px-4 py-3 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Skip to content</a>
        <ApiProvider>{children}</ApiProvider>
      </body>
    </html>
  );
}
