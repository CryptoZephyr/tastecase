import type { Metadata } from 'next';
import { SuiteScreen } from '@/components/screens/suite-screen';

export const metadata: Metadata = { title: 'Suite' };

export default async function Page({ params }: { params: Promise<{ projectId: string; suiteId: string }> }) {
  const { projectId, suiteId } = await params;
  return <SuiteScreen projectId={projectId} suiteId={suiteId} />;
}
