import type { Metadata } from 'next';
import { NewComparisonScreen } from '@/components/screens/new-comparison-screen';

export const metadata: Metadata = { title: 'Compare two releases' };

export default async function Page({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ suite?: string; version?: string }> }) {
  const { projectId } = await params;
  const { suite, version } = await searchParams;
  return <NewComparisonScreen projectId={projectId} suiteId={suite} versionId={version} />;
}
