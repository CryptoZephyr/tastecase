export const routes = {
  home: '/',
  sample: '/sample',
  signIn: (next?: string, reason?: 'expired' | 'invalid_link' | 'signed_out') => {
    const params = new URLSearchParams();
    if (next) params.set('next', next);
    if (reason) params.set('reason', reason);
    const query = params.toString();
    return query ? `/sign-in?${query}` : '/sign-in';
  },
  docs: '/docs',
  doc: (group: string, slug: string) => `/docs/${group}/${slug}`,
  workflow: '/docs/start/from-taste-to-test',
  limitations: '/docs/proof/current-limitations',
  projects: '/projects',
  newProject: '/projects/new',
  project: (projectId: string) => `/projects/${projectId}`,
  setup: (projectId: string, step?: string) => `/projects/${projectId}/setup${step ? `#${step}` : ''}`,
  discover: (projectId: string) => `/projects/${projectId}/discover`,
  job: (projectId: string, jobId: string) => `/projects/${projectId}/discover/${jobId}`,
  cases: (projectId: string) => `/projects/${projectId}/cases`,
  case: (projectId: string, caseId: string) => `/projects/${projectId}/cases/${caseId}`,
  suites: (projectId: string) => `/projects/${projectId}/suites`,
  suite: (projectId: string, suiteId: string) => `/projects/${projectId}/suites/${suiteId}`,
  suiteVersion: (projectId: string, suiteId: string, versionId: string) => `/projects/${projectId}/suites/${suiteId}/versions/${versionId}`,
  comparisons: (projectId: string) => `/projects/${projectId}/comparisons`,
  newComparison: (projectId: string, suiteId?: string, versionId?: string) => {
    const params = new URLSearchParams();
    if (suiteId) params.set('suite', suiteId);
    if (versionId) params.set('version', versionId);
    const query = params.toString();
    return `/projects/${projectId}/comparisons/new${query ? `?${query}` : ''}`;
  },
  comparison: (projectId: string, comparisonId: string) => `/projects/${projectId}/comparisons/${comparisonId}`,
};

/** Only same-origin absolute paths are accepted as post-sign-in destinations. */
export function safeNext(value: string | null | undefined, fallback = routes.projects): string {
  if (!value || value.length > 4096 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, 'https://tastecase.invalid');
    if (url.origin !== 'https://tastecase.invalid') return fallback;
    // Do not let encoded separators become a protocol-relative destination on a later decode.
    let path = url.pathname;
    for (let count = 0; count < 4; count++) {
      if (path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path)) return fallback;
      const decoded = decodeURIComponent(path);
      if (decoded === path) return value;
      path = decoded;
    }
    return fallback;
  } catch { return fallback; }
}

export function describeDestination(path: string): string {
  if (path === routes.newProject) return 'create your first project and connect your assistant';
  if (/^\/projects\/[^/]+\/cases\/[^/]+/.test(path)) return 'the case you were reviewing';
  if (/^\/projects\/[^/]+\/setup/.test(path)) return 'your project setup';
  if (/^\/projects\/[^/]+/.test(path)) return 'your project';
  return 'your projects';
}
