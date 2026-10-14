'use client';

import { ArrowRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { ButtonLink } from '@/components/ui/button';
import { Time } from '@/components/ui/data';
import { PageHeader } from '@/components/ui/page';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useApi } from '@/lib/api/context';
import type { Project } from '@/lib/api/types';
import { useResource } from '@/lib/api/use-resource';
import { routes } from '@/lib/routes';
import { loadProjectFacts, nextAction } from '@/lib/view/project-facts';

function ProjectSummary({ project }: { project: Project }) {
  const api = useApi();
  const facts = useResource(() => loadProjectFacts(api, project.id), [api, project.id]);
  return (
    <li className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between md:p-5">
      <div className="min-w-0">
        <Link href={routes.project(project.id)} className="text-body font-medium text-ink underline-offset-4 hover:underline break-words">{project.name}</Link>
        <p className="text-meta text-ink-2">Created <Time iso={project.createdAt} /></p>
      </div>
      <div className="text-control md:max-w-[50%] md:text-right">
        {facts.status === 'loading' ? <Skeleton className="h-4 w-48 md:ml-auto" /> : null}
        {facts.status === 'error' ? <span className="text-ink-2">Next step unavailable — open the project to retry.</span> : null}
        {facts.status === 'ready' ? (() => {
          const next = nextAction(project.id, facts.data);
          return <Link href={next.href} className="inline-flex items-center gap-1.5 font-medium text-action underline-offset-4 hover:underline">Next: {next.title}<ArrowRight aria-hidden className="size-4" strokeWidth={1.75} /></Link>;
        })() : null}
      </div>
    </li>
  );
}

export function ProjectsScreen() {
  const api = useApi();
  const projects = useResource(() => api.projects.list(), [api]);
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-8 md:px-8">
      <PageHeader title="Projects" description="Each project is private to your account: its catalog, runner, cases, suites and comparisons."
        actions={<ButtonLink href={routes.newProject} icon={<Plus aria-hidden className="size-4" strokeWidth={1.75} />}>New project</ButtonLink>} />
      <div className="mt-8">
        {projects.status === 'loading' ? <SkeletonRows label="Loading your projects" /> : null}
        {projects.status === 'error' ? <ErrorState error={projects.error} what="your projects" onRetry={projects.reload} retrying={projects.reloading} /> : null}
        {projects.status === 'ready' && projects.data.length === 0 ? (
          <EmptyState title="No projects yet" action={<ButtonLink href={routes.newProject}>Create your first project</ButtonLink>}>
            <p>A project holds one assistant’s test work: connect its runner, import your restaurant catalog, then discover cases worth testing.</p>
          </EmptyState>
        ) : null}
        {projects.status === 'ready' && projects.data.length > 0 ? (
          <>
            {projects.error ? <ErrorState className="mb-4" error={projects.error} what="the latest project list" onRetry={projects.reload} retrying={projects.reloading} /> : null}
            <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
              {projects.data.map(project => <ProjectSummary key={project.id} project={project} />)}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
