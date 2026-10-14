import type { Metadata } from 'next';
import { AuthCallbackScreen } from '@/components/screens/auth-callback-screen';

export const metadata: Metadata = { title: 'Signing in' };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; error_description?: string }> }) {
  const { next, error, error_description: description } = await searchParams;
  return <AuthCallbackScreen next={next} hasError={Boolean(error || description)} />;
}
