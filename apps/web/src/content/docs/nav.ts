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
    ['from-taste-to-test', 'From taste to test', 'Find a case, decide what to check and reuse it next time.'],
  ]),
  group('using', 'Using', [
    ['projects', 'Projects', 'Private projects, setup and the next-step view.'],
    ['catalogs', 'Catalogs', 'Add the restaurants your assistant may recommend.'],
    ['mapping-confirmation', 'Check restaurant matches', 'Make sure Qloo found the right place.'],
    ['discovery', 'Discovery', 'Find a restaurant pair worth checking, within your call limits.'],
    ['review', 'Review', 'Decide what to keep, change or leave for later.'],
    ['suites', 'Suites', 'Collect approved tests and save a fixed version.'],
    ['comparisons', 'Comparisons', 'Compare your current and changed assistant on the same tests.'],
    ['exports', 'Exports and replay', 'Download the test pack and replay it locally.'],
  ]),
  group('architecture', 'Architecture', [
    ['cultural-evidence', 'How Qloo helps', 'Where the rankings come from and what they cannot prove.'],
    ['agent-loop', 'How a case is found', 'From interest matches to saved assistant answers.'],
    ['runner', 'Runner', 'The local program that calls your assistant.'],
    ['jobs', 'Jobs and recovery', 'How saved progress and call limits work after an interruption.'],
    ['version-pinning', 'Keeping tests unchanged', 'Why old results keep their original inputs.'],
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
    ['credentials', 'Credentials', 'Sign-in, runner passwords and model keys.'],
    ['data-boundaries', 'What gets shared', 'What Qloo, models and downloaded files receive.'],
    ['untrusted-inputs', 'Handling outside data', 'How answers and provider messages are checked.'],
  ]),
  group('proof', 'Proof', [
    ['verified-evidence', 'What we’ve tested', 'Completed checks, real runs and remaining gaps.'],
    ['recorded-workflows', 'Saved examples', 'Open a recorded case without starting another run.'],
    ['case-yield', 'Does this find better tests?', 'What we know and what we have not measured.'],
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
