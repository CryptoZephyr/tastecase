import type { Metadata } from 'next';
import { SetupScreen } from '@/components/screens/setup-screen';

export const metadata: Metadata = { title: 'Setup' };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SetupScreen projectId={projectId} />;
}
