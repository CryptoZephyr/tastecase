import Link from 'next/link';
import { SCREENS } from '@/dev/screens';

const VARIANTS: Record<string, string[]> = {
  sample: ['scenario=not_connected', 'scenario=data', 'scenario=loading'],
  'sign-in': ['reason=expired&next=/projects/x/cases/y', 'reason=invalid_link', 'mutation=unauthorized', 'mutation=not_connected'],
  projects: ['scenario=data', 'scenario=empty', 'scenario=not_connected', 'scenario=network', 'scenario=loading', 'session=unknown&scenario=not_connected'],
  'new-project': ['mutation=network', 'mutation=not_connected'],
  project: ['scenario=data', 'scenario=empty', 'scenario=not_found'],
  setup: ['scenario=data', 'scenario=empty', 'mutation=network'],
  discover: ['scenario=data', 'scenario=empty', 'scenario=busy'],
  job: ['job=awaiting_review', 'job=needs_confirmation', 'job=waiting_runner', 'job=partial', 'scenario=not_found'],
  cases: ['scenario=data', 'scenario=empty'],
  case: ['variant=paired', 'variant=single', 'variant=approved', 'mutation=conflict', 'mutation=network', 'scenario=unauthorized', 'scenario=loading'],
  suites: ['scenario=data', 'scenario=empty'],
  suite: ['variant=approved', 'variant=approved&mutation=conflict', 'variant=paired'],
  'suite-version': ['scenario=data'],
  comparisons: ['scenario=data', 'scenario=empty'],
  'new-comparison': ['scenario=data', 'mutation=network'],
  comparison: ['finalized=true', 'finalized=false', 'scenario=internal'],
};

export default function Page() {
  return (
    <main className="mx-auto max-w-[960px] px-4 py-10">
      <h1 className="text-title font-medium">Development state gallery</h1>
      <p className="mt-2 text-ink-2">Synthetic fixtures for visual QA. These routes only exist in <code>next dev</code>.</p>
      <ul className="mt-8 space-y-4">
        {SCREENS.map(screen => (
          <li key={screen}>
            <p className="font-medium">{screen}</p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-control">
              {(VARIANTS[screen] ?? ['scenario=data']).map(query => <li key={query}><Link className="text-action underline underline-offset-4" href={`/dev/states/${screen}?${query}`}>{query}</Link></li>)}
            </ul>
          </li>
        ))}
      </ul>
    </main>
  );
}
