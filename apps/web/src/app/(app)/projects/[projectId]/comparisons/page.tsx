import type { Metadata } from 'next';
import { ComparisonsScreen } from '@/components/screens/comparisons-screen';

export const metadata: Metadata = { title: 'Comparisons' };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ComparisonsScreen projectId={projectId} />;
}
