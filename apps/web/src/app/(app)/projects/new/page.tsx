import type { Metadata } from 'next';
import { NewProjectScreen } from '@/components/screens/new-project-screen';

export const metadata: Metadata = { title: 'Bring your assistant' };

export default function Page() {
  return <NewProjectScreen />;
}
