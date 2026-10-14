import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/projects',
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false });
}

afterEach(() => {
  if (typeof window !== 'undefined') { cleanup(); sessionStorage.clear(); }
});
