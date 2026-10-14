'use client';

import { Check, Circle } from 'lucide-react';
import { useState } from 'react';
import { ButtonLink } from '@/components/ui/button';
import { PageHeader, Section } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/skeleton';
import { CatalogStep } from '@/components/setup/catalog-step';
import { MappingStep } from '@/components/setup/mapping-step';
import { RunnerStep } from '@/components/setup/runner-step';
import { TaskStep } from '@/components/setup/task-step';
import { useApi } from '@/lib/api/context';
import { useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';
import { loadProjectFacts, setupSteps } from '@/lib/view/project-facts';

export const DEFAULT_BUDGETS = [
  ['Qloo calls', '8', 'Lookups and rankings, including bounded retries'],
  ['Model decisions', '2', 'Choosing one observed contrast, or none'],
  ['Assistant runs', '6', 'Runner dispatches, including reclaims'],
  ['Rounds', '3', 'Investigation rounds'],
  ['Deadline', '15 minutes', 'Wall-clock limit for the whole job'],
  ['Retries per operation', '1', 'Only for flagged transient errors'],
] as const;

function Checklist({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const api = useApi();
  const facts = useResource(() => loadProjectFacts(api, projectId), [api, projectId, refreshKey]);
  if (facts.status === 'loading') return <Skeleton className="h-24 w-full" />;
  if (facts.status === 'error') return <p className="text-control text-ink-2">Completion status is unavailable until project records load. Each step below shows its own status.</p>;
  return (
    <ol className="grid gap-1 sm:grid-cols-2 xl:grid-cols-5">
      {setupSteps(facts.data).map((step, index) => (
        <li key={step.id}>
          <a href={`#${step.id}`} className="flex min-h-11 items-start gap-2 rounded-control p-2 text-control hover:bg-white/60">
            {step.done ? <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-ink" strokeWidth={2} /> : <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" strokeWidth={1.75} />}
            <span>{index + 1}. {step.title}<span className="sr-only">{step.done ? ' — done' : ' — not done'}</span></span>
          </a>
        </li>
      ))}
    </ol>
  );
}

export function SetupScreen({ projectId }: { projectId: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey(key => key + 1);
  return (
    <div className="space-y-12">
      <div className="space-y-5">
        <PageHeader title="Setup" description="Connect the runner, import the catalog, confirm mappings and define the task. A step counts as done only when its record is saved in TasteCase." />
        <Checklist projectId={projectId} refreshKey={refreshKey} />
      </div>
      <RunnerStep projectId={projectId} />
      <CatalogStep projectId={projectId} onSaved={bump} />
      <MappingStep projectId={projectId} refreshKey={refreshKey} />
      <TaskStep projectId={projectId} refreshKey={refreshKey} />
      <Section id="budgets" title="5. Review call budgets" description="Every discovery job pins its own budgets and deadline. Calls are charged when reserved, even if the outcome is unknown — so budgets are firm limits, not estimates.">
        <div tabIndex={0} role="region" aria-label="Default discovery budgets" className="overflow-x-auto rounded-panel border border-rule bg-surface">
          <table className="w-full min-w-[32rem] text-left text-control">
            <caption className="sr-only">Default discovery budgets</caption>
            <thead className="bg-subtle text-meta text-ink-2"><tr><th scope="col" className="px-4 py-2 font-medium">Budget</th><th scope="col" className="px-4 py-2 font-medium">Default</th><th scope="col" className="px-4 py-2 font-medium">Covers</th></tr></thead>
            <tbody className="divide-y divide-rule">
              {DEFAULT_BUDGETS.map(([name, value, covers]) => <tr key={name}><td className="px-4 py-2 font-medium">{name}</td><td className="px-4 py-2">{value}</td><td className="px-4 py-2 text-ink-2">{covers}</td></tr>)}
            </tbody>
          </table>
        </div>
        <ButtonLink href={routes.discover(projectId)} variant="secondary" className="mt-4">Review budgets and start discovery</ButtonLink>
      </Section>
    </div>
  );
}
