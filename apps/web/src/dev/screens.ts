export const SCREENS = ['sample', 'sign-in', 'projects', 'new-project', 'project', 'setup', 'discover', 'job', 'cases', 'case', 'suites', 'suite', 'suite-version', 'comparisons', 'new-comparison', 'comparison'] as const;
export type ScreenId = (typeof SCREENS)[number];
