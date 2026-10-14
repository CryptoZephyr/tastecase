import type { Metadata } from 'next';
import { ProjectsScreen } from '@/components/screens/projects-screen';

export const metadata: Metadata = { title: 'Projects' };

export default function Page() {
  return <ProjectsScreen />;
}
