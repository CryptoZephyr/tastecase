import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Development fixture screens (`*.dev.tsx`) exist only in `next dev`. Production builds
// never route to them, so synthetic fixture data cannot ship as product content.
const includeDevScreens = process.env.NODE_ENV !== 'production';

const config: NextConfig = {
  pageExtensions: includeDevScreens ? ['tsx', 'ts', 'dev.tsx'] : ['tsx', 'ts'],
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root },
  outputFileTracingRoot: root,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default config;
