import type { Metadata } from 'next';
import { CasesScreen } from '@/components/screens/cases-screen';

export const metadata: Metadata = { title: 'Cases' };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <CasesScreen projectId={projectId} />;
}
