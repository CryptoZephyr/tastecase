import { notFound } from 'next/navigation';
import { SCREENS, type ScreenId } from '@/dev/screens';
import { StateGallery } from '@/dev/state-gallery';

export default async function Page({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { screen } = await params;
  if (!(SCREENS as readonly string[]).includes(screen)) notFound();
  return <StateGallery screen={screen as ScreenId} params={await searchParams} />;
}
