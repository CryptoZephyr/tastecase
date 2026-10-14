import type { ReactNode } from 'react';
import { ProjectFrame } from '@/components/app/project-frame';

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectFrame projectId={projectId}>{children}</ProjectFrame>;
}
