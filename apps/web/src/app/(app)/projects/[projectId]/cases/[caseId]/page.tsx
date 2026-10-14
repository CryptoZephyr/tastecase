import type { Metadata } from 'next';
import { CaseScreen } from '@/components/screens/case-screen';

export const metadata: Metadata = { title: 'Case review' };

export default async function Page({ params }: { params: Promise<{ projectId: string; caseId: string }> }) {
  const { projectId, caseId } = await params;
  return <CaseScreen projectId={projectId} caseId={caseId} />;
}
