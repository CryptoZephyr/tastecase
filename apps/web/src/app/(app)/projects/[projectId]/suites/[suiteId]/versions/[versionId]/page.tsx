import type { Metadata } from 'next';
import { SuiteVersionScreen } from '@/components/screens/suite-version-screen';

export const metadata: Metadata = { title: 'Suite version' };

export default async function Page({ params }: { params: Promise<{ projectId: string; suiteId: string; versionId: string }> }) {
  const { projectId, suiteId, versionId } = await params;
  return <SuiteVersionScreen projectId={projectId} suiteId={suiteId} versionId={versionId} />;
}
