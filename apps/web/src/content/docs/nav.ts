/** Docs navigation data. Content lives in ./pages; layout lives in components/docs. */
export interface DocLink { group: string; slug: string; title: string; summary: string }
export interface DocGroup { slug: string; title: string; pages: DocLink[] }

const group = (slug: string, title: string, pages: [string, string, string][]): DocGroup => ({
  slug, title, pages: pages.map(([page, pageTitle, summary]) => ({ group: slug, slug: page, title: pageTitle, summary })),
});

export const DOC_GROUPS: DocGroup[] = [
  group('start', 'Start', [
    ['introduction', 'Introduction', 'What TasteCase does, who it serves and what it doesn’t claim.'],
    ['sample-walkthrough', 'Sample walkthrough', 'How to read one case, section by section.'],
    ['from-taste-to-test', 'From taste to test', 'How a cultural contrast becomes a reviewed release test.'],
  ]),
  group('using', 'Using', [
    ['projects', 'Projects', 'Private projects, setup and the next-step view.'],
    ['catalogs', 'Catalogs', 'Import immutable restaurant catalog versions.'],
    ['mapping-confirmation', 'Mapping confirmation', 'Confirm which Qloo entity each restaurant is.'],
    ['discovery', 'Discovery', 'Run a bounded job that finds a contrast worth testing.'],
    ['review', 'Review', 'Accept, edit, reject or defer a case with a rationale.'],
    ['suites', 'Suites', 'Publish approved cases as immutable versions.'],
    ['comparisons', 'Comparisons', 'Run two named releases against a published suite.'],
    ['exports', 'Exports and replay', 'Download the test pack and replay it locally.'],
  ]),
  group('architecture', 'Architecture', [
    ['cultural-evidence', 'Cultural evidence', 'What Qloo contributes and how its evidence is stored.'],
    ['agent-loop', 'Agent loop', 'How the discovery worker decides what to investigate.'],
    ['runner', 'Runner', 'The local program that calls your assistant.'],
    ['jobs', 'Jobs and recovery', 'Leases, checkpoints, budgets and restarts.'],
    ['version-pinning', 'Version pinning', 'Which inputs are frozen, and when.'],
  ]),
  group('reference', 'Reference', [
    ['adapter-schema', 'Adapter schema', 'The TargetAdapter interface and result shapes.'],
    ['artifact-schema', 'Artifact schema', 'Test pack, report and replay report versions.'],
    ['result-classes', 'Result classes', 'Expectation classes and outcomes, kept separate.'],
    ['error-codes', 'Error codes', 'API errors, HTTP statuses and runner exit codes.'],
    ['configuration', 'Configuration', 'Environment variables for the API, runner and web app.'],
  ]),
  group('security', 'Security', [
    ['project-isolation', 'Project isolation', 'How private projects stay private.'],
    ['credentials', 'Credentials', 'Owner sessions, runner tokens and provider keys.'],
    ['data-boundaries', 'Data boundaries', 'What goes to Qloo, to models and into exports.'],
    ['untrusted-inputs', 'Untrusted inputs', 'How model output and provider data are handled.'],
  ]),
  group('proof', 'Proof', [
    ['verified-evidence', 'Verified integration evidence', 'What has been checked, when and how.'],
    ['recorded-workflows', 'Recorded workflows', 'Recorded end-to-end runs available for inspection.'],
    ['case-yield', 'Case-yield evaluation', 'Whether Qloo-guided discovery finds more useful cases.'],
    ['current-limitations', 'Current limitations', 'Known gaps and boundaries, stated plainly.'],
  ]),
  group('help', 'Help', [
    ['troubleshooting', 'Troubleshooting', 'What each unavailable or error state means and what to do.'],
    ['faq', 'FAQ', 'Short answers to common questions.'],
  ]),
];

export const ALL_DOCS: DocLink[] = DOC_GROUPS.flatMap(row => row.pages);

export function findDoc(group: string, slug: string): DocLink | undefined {
  return ALL_DOCS.find(row => row.group === group && row.slug === slug);
}

export function neighbours(group: string, slug: string) {
  const index = ALL_DOCS.findIndex(row => row.group === group && row.slug === slug);
  return { previous: index > 0 ? ALL_DOCS[index - 1] : undefined, next: index >= 0 && index < ALL_DOCS.length - 1 ? ALL_DOCS[index + 1] : undefined };
}

export const docHref = (doc: { group: string; slug: string }) => `/docs/${doc.group}/${doc.slug}`;
