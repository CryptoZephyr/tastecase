import Link from 'next/link';
import { Callout, Code, H2, Table } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const using: DocSection = {
  projects: {
    headings: [{ id: 'private', label: 'Your work is private' }, { id: 'setup', label: 'Set up your first project' }, { id: 'next', label: 'What to do next' }, { id: 'return', label: 'Come back to saved work' }],
    keywords: ['create project', 'setup', 'runner credential', 'bring your assistant', 'getting started'],
    Body: () => (
      <>
        <p>A project is the home for one assistant’s tests: its restaurant list, saved cases and version comparisons.</p>
        <H2 id="private">Your work is private</H2>
        <p>Sign in and choose <strong>Bring your assistant</strong> to create a project. Only its owner can open it. Sharing a private link does not give someone else access.</p>
        <H2 id="setup">Set up your first project</H2>
        <ol>
          <li><strong>Connect your assistant.</strong> Create a runner credential, keep the token safe, and follow the setup commands on your machine. The runner is the small program that sends your assistant’s answers back to TasteCase.</li>
          <li><strong>Add your restaurants.</strong> Import the list your assistant is allowed to recommend from. TasteCase calls this your catalog.</li>
          <li><strong>Check the Qloo matches.</strong> Confirm that each matched place is the restaurant you meant.</li>
          <li><strong>Describe the task.</strong> Write the fictional dinner request and practical needs, such as city, party size and budget.</li>
          <li><strong>Choose your limits.</strong> Set how many provider calls and assistant runs discovery may use.</li>
        </ol>
        <p>A step is complete only after it is saved. Creating a token alone does not connect your runner: run the handshake command and wait for confirmation. The recorded connection time proves it connected then, not that it is still online.</p>
        <p>For the exact commands and settings, see <Link href="/docs/architecture/runner">Runner setup</Link> and <Link href="/docs/reference/configuration#runner">the configuration reference</Link>.</p>
        <H2 id="next">What to do next</H2>
        <p>The project overview points you to the next unfinished step. Once setup is complete, start discovery. For an existing project, use Resume to reopen saved work.</p>
        <H2 id="return">Come back to saved work</H2>
        <p>You can reopen the same project, case or comparison from its link. Signing out does not delete it. Sign back in with the same account.</p>
      </>
    ),
  },
  catalogs: {
    headings: [{ id: 'shape', label: 'Prepare your restaurant list' }, { id: 'versions', label: 'Old tests keep the old list' }, { id: 'limits', label: 'Size limits' }],
    keywords: ['restaurants', 'import', 'json', 'catalog version'],
    Body: () => (
      <>
        <p>Your catalog is the list of restaurants the assistant may choose from. TasteCase uses your list, not a live web search.</p>
        <H2 id="shape">Prepare your restaurant list</H2>
        <p>Each restaurant needs an ID that stays the same and a name. You can also add its location, cuisines and facts you have checked, such as dietary options or party-size limits. The setup screen accepts a JSON list.</p>
        <Code label="Example format, not verified restaurant data" code={`[{
  "id": "your-restaurant-id",
  "name": "Restaurant name",
  "metadata": { "city": "City", "countryCode": "US" }
}]`} />
        <p>Do not guess missing facts. An unknown dietary or accessibility feature stays unknown. Adding a Qloo ID is only a proposed match until you confirm it.</p>
        <H2 id="versions">Old tests keep the old list</H2>
        <p>Importing a changed list creates a new version. Earlier tests keep the restaurant list they were created with, so you can still understand their results.</p>
        <H2 id="limits">Size limits</H2>
        <p>A catalog can contain up to 500 restaurants. A single discovery job can rank at most 10 matched restaurants.</p>
      </>
    ),
  },
  'mapping-confirmation': {
    headings: [{ id: 'why', label: 'Why check the match?' }, { id: 'how', label: 'Confirm the right place' }, { id: 'unmapped', label: 'If there is no match' }],
    keywords: ['qloo entity', 'mapping', 'ambiguous', 'match'],
    Body: () => (
      <>
        <H2 id="why">Why check the match?</H2>
        <p>Two restaurants can have similar names. Before using Qloo’s evidence, confirm that its place record refers to the restaurant in your list. TasteCase does not approve a guess for you.</p>
        <H2 id="how">Confirm the right place</H2>
        <p>Choose <strong>Confirm this match</strong> for the right result, or enter the correct Qloo entity ID. A confirmation belongs to that restaurant-list version and cannot be edited afterwards.</p>
        <p>During discovery, you also confirm public interests such as an artist or film. Even a single search result needs your confirmation.</p>
        <H2 id="unmapped">If there is no match</H2>
        <p>Your assistant can still recommend an eligible restaurant without a Qloo match. TasteCase shows the missing evidence clearly. No match does not mean a bad restaurant or a diner’s dislike.</p>
      </>
    ),
  },
  discovery: {
    headings: [{ id: 'inputs', label: 'Choose what to test' }, { id: 'stages', label: 'What happens next' }, { id: 'budgets', label: 'Keep the run small' }, { id: 'states', label: 'Understand the stopping point' }, { id: 'cancel', label: 'Stop a run' }],
    keywords: ['discovery job', 'budgets', 'profiles', 'public interests', 'needs confirmation', 'waiting runner'],
    Body: () => (
      <>
        <H2 id="inputs">Choose what to test</H2>
        <p>Select your saved task and restaurant list. Add two fictional diner profiles, each with one to five public music, film or brand interests. Both keep the same practical needs. Choose your assistant’s version label and how many times to repeat each request.</p>
        <p>The optional two-restaurant follow-up focuses on the interesting pair. The task, practical needs and eligible restaurant list stay unchanged once discovery starts.</p>
        <H2 id="stages">What happens next</H2>
        <ol>
          <li>You confirm the public-interest matches.</li>
          <li>Qloo ranks the restaurants for each diner.</li>
          <li>TasteCase finds a pair whose order changes and selects a case to inspect.</li>
          <li>Your runner asks your assistant the saved requests and returns its answers.</li>
          <li>You open the case and decide what is worth keeping.</li>
        </ol>
        <p><strong>Needs confirmation</strong> means your input is needed. <strong>Waiting for runner</strong> means you need to run the connected program on your machine.</p>
        <H2 id="budgets">Keep the run small</H2>
        <p>Set call limits and a deadline before starting. Begin with a small restaurant list and few repeats. Qloo calls, case-selection calls and assistant answers each use their own allowance; your provider’s account limits apply too.</p>
        <Table head={['Setting', 'Default', 'Allowed range']} rows={[
          ['Qloo calls', '8', '1–20'], ['Case-selection calls', '2', '1–8'], ['Assistant runs', '6', '2–12'],
          ['Investigation rounds', '3', '1–6'], ['Time limit', '15 minutes', '30 seconds–1 hour'],
          ['Output size', '64,000 bytes', '1,024–262,144 bytes'], ['Retries per operation', '1', '0–2'],
        ]} />
        <p>A sent request may use your allowance even if its answer never arrives. TasteCase does not retry a rejected API key or silently switch to a paid model.</p>
        <H2 id="states">Understand the stopping point</H2>
        <p><strong>Ready for review</strong> means there is a case to open. <strong>No useful contrast</strong> is a valid outcome, not a broken run. <strong>Partial</strong> means some work was saved but the full plan did not finish.</p>
        <p>Other stopping points include an unavailable provider, used-up budget, deadline, cancellation or failure. Open any saved cases and read the gaps before deciding what to do next.</p>
        <H2 id="cancel">Stop a run</H2>
        <p>Cancel to stop new work. A request that was already sent may still finish; its result stays labelled with the cancelled run.</p>
      </>
    ),
  },
  review: {
    headings: [{ id: 'decisions', label: 'Choose what to do with the case' }, { id: 'expectations', label: 'Write a check you can explain' }, { id: 'conflicts', label: 'If your save needs attention' }, { id: 'receipts', label: 'Know when it is saved' }],
    keywords: ['accept', 'edit', 'reject', 'defer', 'rationale', 'policy', 'objective'],
    Body: () => (
      <>
        <H2 id="decisions">Choose what to do with the case</H2>
        <p>Read the requests, answers and evidence gaps first. Then choose a decision and write a short reason.</p>
        <Table head={['Decision', 'What it does']} rows={[
          ['Accept', 'Keep the finding as advisory: something to review, not an automatic failure rule.'],
          ['Edit', 'Write your own expectation or choose checks the system can evaluate.'],
          ['Reject', 'Do not include it in new tests. Keep the decision in history.'],
          ['Defer', 'Leave the decision for later. This is not approval.'],
        ]} />
        <H2 id="expectations">Write a check you can explain</H2>
        <ul>
          <li><strong>Objective check:</strong> only recommend allowed restaurants, avoid excluded ones, or return the expected answer format.</li>
          <li><strong>Approved policy:</strong> a rule you choose for one diner, such as including an option from a set, avoiding an option, or ordering two options when both appear.</li>
          <li><strong>Advisory:</strong> keep an interesting finding for human judgement.</li>
        </ul>
        <p>Choose from the supported checks. Writing a reason alone does not create an automatic rule, and accepting a finding is not a passed test.</p>
        <H2 id="conflicts">If your save needs attention</H2>
        <p>If a newer decision was saved while you were reviewing, load it before submitting again. Your draft stays in the tab, including when you need to sign back in. After an uncertain save, use the same-request retry rather than starting a new decision.</p>
        <H2 id="receipts">Know when it is saved</H2>
        <p>After a confirmed save, TasteCase shows the decision, reason and receipt. A checksum is a fingerprint of the saved content; it helps identify the exact record you are reopening.</p>
      </>
    ),
  },
  suites: {
    headings: [{ id: 'publish', label: 'Collect your approved tests' }, { id: 'immutable', label: 'Each publication keeps its own version' }, { id: 'limits', label: 'Size limits' }],
    keywords: ['suite version', 'publish', 'immutable', 'test collection'],
    Body: () => (
      <>
        <H2 id="publish">Collect your approved tests</H2>
        <p>A suite is a named collection of tests. Create one, select approved cases and publish it. TasteCase saves the expectations and evidence you approved for each case.</p>
        <p>If a selected case has changed or is no longer approved, publication stops so you can review it. It does not quietly publish an incomplete collection.</p>
        <H2 id="immutable">Each publication keeps its own version</H2>
        <p>Later edits do not rewrite published tests. Publish a new version when you want to change the collection. Old comparisons still point to the version they used.</p>
        <H2 id="limits">Size limits</H2>
        <p>Up to 50 cases per version, with a total saved size of 8 MiB.</p>
      </>
    ),
  },
  comparisons: {
    headings: [{ id: 'fixed', label: 'Use the same tests for both versions' }, { id: 'run', label: 'Run your current and changed assistant' }, { id: 'reading', label: 'Read what changed' }, { id: 'limits', label: 'Run limits' }],
    keywords: ['baseline', 'candidate', 'release', 'changes only', 'finalize', 'same model'],
    Body: () => (
      <>
        <H2 id="fixed">Use the same tests for both versions</H2>
        <p>Choose an exact published suite version and the cases to compare. Both assistants receive the same saved requests, restaurant list and practical needs. Each produces new answers; old discovery answers are not reused.</p>
        <p><strong>Profile A / Profile B</strong> mean the diners. <strong>Baseline / Candidate</strong> mean your current assistant and the changed version you want to try.</p>
        <H2 id="run">Run your current and changed assistant</H2>
        <p>You can use one model with two different prompts. Configure each version in your local assistant code, set its matching release label and run the runner for its queued work. Changing the label alone does not change the prompt or model.</p>
        <Code label="Bind a release label, then run one queued request" code={`export TASTECASE_ASSISTANT_VERSION="concierge-prompt-v1"
node packages/runner/dist/cli.js run-once`} />
        <p>The label must match the version chosen in TasteCase. A wrong or missing label cannot claim comparison work.</p>
        <H2 id="reading">Read what changed</H2>
        <p>When both versions finish, freeze the report to save it. You may also choose to freeze a partial report, but missing runs stay missing.</p>
        <p>Read rule outcomes separately from changed recommendations. A different answer is not automatically worse. Use <strong>Changes only</strong> to focus on restaurants that moved, appeared or disappeared.</p>
        <H2 id="limits">Run limits</H2>
        <p>A comparison supports up to 10 cases and 120 planned runs, with a deadline within one hour. Additional limits on reclaimed work are listed in <Link href="/docs/proof/current-limitations">Current limitations</Link>.</p>
      </>
    ),
  },
  exports: {
    headings: [{ id: 'contents', label: 'Download the tests' }, { id: 'replay', label: 'Rerun them on your machine' }, { id: 'exit', label: 'Understand the command result' }, { id: 'trust', label: 'Check the file you received' }],
    keywords: ['test pack', 'download', 'replay', 'checksum'],
    Body: () => (
      <>
        <H2 id="contents">Download the tests</H2>
        <p>A test pack contains the saved fictional requests, approved checks and references to the original evidence. It does not include model keys, raw Qloo responses, the assistant’s answer text or executable code. Treat it as private project data.</p>
        <H2 id="replay">Rerun them on your machine</H2>
        <p>Replay means running those downloaded tests again. You need your local model-provider settings, but no TasteCase login or runner token. Replay uses the saved inputs and does not ask Qloo for fresh evidence.</p>
        <Code label="Replace the file paths and quoted checksum placeholder" code={`export TASTECASE_ASSISTANT_VERSION="concierge-prompt-v2"
node packages/runner/dist/cli.js replay \\
  --pack ./tests.json --role candidate \\
  --pack-checksum '<trusted pack checksum>' --report ./new-report.json`} />
        <p>This command runs only Candidate. Baseline stays pending, so the report is partial. Use a new report filename each time; existing files are not overwritten.</p>
        <H2 id="exit">Understand the command result</H2>
        <Table head={['Code', 'Meaning']} rows={[['0', 'The selected version completed without a rule failure. Advisory findings still need review.'], ['2', 'An approved rule failed.'], ['4', 'A run was unavailable or did not finish.'], ['1', 'Check the input or configuration; the command may also have been cancelled.']]} />
        <H2 id="trust">Check the file you received</H2>
        <p>Keep the checksum shown after your signed-in download and use it with replay. It helps detect a changed file; a checksum stored inside the file alone is not proof of who created it.</p>
        <Callout kind="note">“Pack downloaded” means you received the file, not that you ran it. TasteCase cannot see a local replay unless you separately share its report.</Callout>
        <p>For exact file formats, see <Link href="/docs/reference/artifact-schema">Artifact schema</Link>.</p>
      </>
    ),
  },
};
