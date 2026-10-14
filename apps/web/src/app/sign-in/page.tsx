import type { Metadata } from 'next';
import { SignInScreen } from '@/components/screens/sign-in-screen';

export const metadata: Metadata = { title: 'Sign in' };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string }> }) {
  const { next, reason } = await searchParams;
  return <SignInScreen next={next} reason={reason} />;
}
