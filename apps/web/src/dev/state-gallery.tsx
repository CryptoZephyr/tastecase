'use client';

/**
 * Development-only state gallery. Rendered exclusively by `*.dev.tsx` pages, which `next build`
 * excludes, so these synthetic fixture screens can't ship as product content.
 */
import { FlaskConical } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { AppHeader } from '@/components/app/app-header';
import { ProjectFrame } from '@/components/app/project-frame';
import { SessionGate } from '@/components/app/session';
import { CaseScreen } from '@/components/screens/case-screen';
import { CasesScreen } from '@/components/screens/cases-screen';
import { ComparisonScreen } from '@/components/screens/comparison-screen';
import { ComparisonsScreen } from '@/components/screens/comparisons-screen';
import { DiscoverScreen } from '@/components/screens/discover-screen';
import { JobScreen } from '@/components/screens/job-screen';
import { NewComparisonScreen } from '@/components/screens/new-comparison-screen';
import { NewProjectScreen } from '@/components/screens/new-project-screen';
import { ProjectHomeScreen } from '@/components/screens/project-home-screen';
import { ProjectsScreen } from '@/components/screens/projects-screen';
import { SampleScreen } from '@/components/screens/sample-screen';
import { SetupScreen } from '@/components/screens/setup-screen';
import { SignInScreen } from '@/components/screens/sign-in-screen';
import { SuiteScreen } from '@/components/screens/suite-screen';
import { SuiteVersionScreen } from '@/components/screens/suite-version-screen';
import { SuitesScreen } from '@/components/screens/suites-screen';
import { ApiProvider } from '@/lib/api/context';
import type { DiscoveryJob } from '@/lib/api/types';
import { fixtureApi, type FixtureOptions, type Scenario } from '@/test/fixture-api';
import { ids } from '@/test/fixtures';
import type { ScreenId } from './screens';


function Banner() {
  return (
    <p role="note" className="flex items-center gap-2 bg-advisory-bg px-4 py-2 text-meta font-medium text-advisory">
      <FlaskConical aria-hidden className="size-4" strokeWidth={1.75} /> Development fixture — synthetic data, not a TasteCase result. This screen doesn’t exist in production builds.
    </p>
  );
}

function Private({ children, project = true }: { children: ReactNode; project?: boolean }) {
  return (
    <SessionGate>
      <AppHeader />
      <main id="main">{project ? <ProjectFrame projectId={ids.project}>{children}</ProjectFrame> : children}</main>
    </SessionGate>
  );
}

export function StateGallery({ screen, params }: { screen: ScreenId; params: Record<string, string | undefined> }) {
  const options: FixtureOptions = {
    scenario: (params.scenario as Scenario | undefined) ?? 'data',
    session: params.session as FixtureOptions['session'],
    jobState: params.job as DiscoveryJob['state'] | undefined,
    finalized: params.finalized !== 'false',
    caseVariant: params.variant as FixtureOptions['caseVariant'],
    mutation: params.mutation as FixtureOptions['mutation'],
  };
  const key = JSON.stringify(options);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key captures every option.
  const api = useMemo(() => fixtureApi(options), [key]);
  const p = ids.project;
  const body = (() => {
    switch (screen) {
      case 'sample': return <SampleScreen />;
      case 'sign-in': return <SignInScreen next={params.next} reason={params.reason} />;
      case 'projects': return <Private project={false}><ProjectsScreen /></Private>;
      case 'new-project': return <Private project={false}><NewProjectScreen /></Private>;
      case 'project': return <Private><ProjectHomeScreen projectId={p} /></Private>;
      case 'setup': return <Private><SetupScreen projectId={p} /></Private>;
      case 'discover': return <Private><DiscoverScreen projectId={p} /></Private>;
      case 'job': return <Private><JobScreen projectId={p} jobId={ids.job} /></Private>;
      case 'cases': return <Private><CasesScreen projectId={p} /></Private>;
      case 'case': return <Private><CaseScreen projectId={p} caseId={ids.case} /></Private>;
      case 'suites': return <Private><SuitesScreen projectId={p} /></Private>;
      case 'suite': return <Private><SuiteScreen projectId={p} suiteId={ids.suite} /></Private>;
      case 'suite-version': return <Private><SuiteVersionScreen projectId={p} suiteId={ids.suite} versionId={ids.suiteVersion} /></Private>;
      case 'comparisons': return <Private><ComparisonsScreen projectId={p} /></Private>;
      case 'new-comparison': return <Private><NewComparisonScreen projectId={p} suiteId={ids.suite} versionId={ids.suiteVersion} /></Private>;
      case 'comparison': return <Private><ComparisonScreen projectId={p} comparisonId={ids.comparison} /></Private>;
    }
  })();
  return <ApiProvider api={api}><Banner />{body}</ApiProvider>;
}
