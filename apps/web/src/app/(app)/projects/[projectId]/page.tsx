import { ProjectHomeScreen } from '@/components/screens/project-home-screen';

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectHomeScreen projectId={projectId} />;
}
