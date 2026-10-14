import type { Metadata } from 'next';
import { DiscoverScreen } from '@/components/screens/discover-screen';

export const metadata: Metadata = { title: 'Discover' };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <DiscoverScreen projectId={projectId} />;
}
