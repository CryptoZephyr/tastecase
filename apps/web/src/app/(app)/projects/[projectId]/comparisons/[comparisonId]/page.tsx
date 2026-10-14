import type { Metadata } from 'next';
import { ComparisonScreen } from '@/components/screens/comparison-screen';

export const metadata: Metadata = { title: 'Release comparison' };

export default async function Page({ params }: { params: Promise<{ projectId: string; comparisonId: string }> }) {
  const { projectId, comparisonId } = await params;
  return <ComparisonScreen projectId={projectId} comparisonId={comparisonId} />;
}
