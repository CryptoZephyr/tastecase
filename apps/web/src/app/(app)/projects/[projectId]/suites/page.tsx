import type { Metadata } from 'next';
import { SuitesScreen } from '@/components/screens/suites-screen';

export const metadata: Metadata = { title: 'Suites' };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SuitesScreen projectId={projectId} />;
}
