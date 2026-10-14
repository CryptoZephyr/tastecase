import type { Metadata } from 'next';
import { SampleScreen } from '@/components/screens/sample-screen';

export const metadata: Metadata = { title: 'Inspect a case — public sample', description: 'A public TasteCase sample with synthetic inputs: one recommendation case, its evidence and its limits.' };

export default function Page() {
  return <SampleScreen />;
}
