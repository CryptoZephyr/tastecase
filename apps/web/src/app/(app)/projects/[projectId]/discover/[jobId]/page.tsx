import type { Metadata } from 'next';
import { JobScreen } from '@/components/screens/job-screen';

export const metadata: Metadata = { title: 'Discovery job' };

export default async function Page({ params }: { params: Promise<{ projectId: string; jobId: string }> }) {
  const { projectId, jobId } = await params;
  return <JobScreen projectId={projectId} jobId={jobId} />;
}
