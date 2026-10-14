import Link from 'next/link';
import { Callout, H2 } from '@/components/docs/doc-ui';
import type { DocSection } from './types';

export const start: DocSection = {
  introduction: {
    headings: [{ id: 'what', label: 'What TasteCase does' }, { id: 'who', label: 'Who it’s for' }, { id: 'qloo', label: 'Where Qloo helps' }, { id: 'not', label: 'What it can’t tell you' }],
    keywords: ['overview', 'about', 'product', 'getting started', 'what is tastecase', 'same model'],
    Body: () => (
      <>
        <p>TasteCase helps teams test an AI assistant that recommends restaurants. It finds cases worth checking, lets you decide what a good answer should do, and saves those checks for the next time you change your assistant.</p>
        <p><strong>Connect your assistant → find a case → review it → save a test → compare versions.</strong></p>
        <H2 id="what">What TasteCase does</H2>
        <p>Imagine two fictional diners visiting the same city. They have the same practical needs, but different interests: one listens to Radiohead, the other to Taylor Swift. Should your assistant give them the same restaurant suggestions? Maybe. TasteCase helps you inspect that question rather than guessing the answer.</p>
        <p>You supply a list of restaurants and the dinner request. TasteCase asks your assistant about both diners and saves the answers beside Qloo’s rankings. You review what happened and decide whether to keep the case as a test.</p>
        <p>Later, compare your current assistant with a changed version using those same saved tests. The two versions can use the same model with different prompts. You do not need two different models.</p>
        <H2 id="who">Who it’s for</H2>
        <p>Developers and testers building AI travel or dining concierges. TasteCase tests their assistant; it is not a restaurant-booking service for travellers.</p>
        <H2 id="qloo">Where Qloo helps</H2>
        <p>Qloo connects public cultural interests, such as music and films, with places. It helps TasteCase find restaurant pairs worth investigating. It does not decide what a particular person should like.</p>
        <p>Start with <Link href="/sample">Inspect a case</Link>. No account or model key is needed to read the saved example.</p>
        <H2 id="not">What it can’t tell you</H2>
        <ul>
          <li>A different ranking is not proof that your assistant is wrong.</li>
          <li>If Qloo has no evidence for a restaurant, that does not mean the diner dislikes it.</li>
          <li>An incomplete activity record cannot prove your assistant skipped a tool.</li>
          <li>We have not yet measured whether this finds more useful cases than ordinary test generation.</li>
        </ul>
      </>
    ),
  },
  'sample-walkthrough': {
    headings: [{ id: 'order', label: 'The question this case asks' }, { id: 'constraints', label: 'What stays the same' }, { id: 'finding', label: 'What happened — and what it means' }, { id: 'sections', label: 'Read the answers and rankings' }, { id: 'interactions', label: 'Look closer' }, { id: 'sample-status', label: 'A saved example, not a live run' }],
    keywords: ['public sample', 'inspect a case', 'case anatomy', 'profile a', 'profile b', 'Radiohead', 'Taylor Swift'],
    Body: () => (
      <>
        <p><Link href="/sample">Open the public example</Link> without signing in. The diners are fictional; the Qloo rankings and assistant answers came from a real run.</p>
        <H2 id="order">The question this case asks</H2>
        <p>Two diners want dinner in New York. Profile A likes Radiohead; Profile B likes Taylor Swift. Does that difference give us a useful test for a restaurant assistant?</p>
        <H2 id="constraints">What stays the same</H2>
        <p>Both requests are for two people in New York, choosing from the same three restaurants: Le Bernardin, Gramercy Tavern and Via Carota. No prices, dietary options, accessibility or availability were verified for this example.</p>
        <H2 id="finding">What happened — and what it means</H2>
        <p>Qloo put Gramercy Tavern ahead of Via Carota for Profile A, and reversed that order for Profile B. The assistant suggested Le Bernardin and Gramercy Tavern for both diners.</p>
        <p>That is a question worth reviewing, not an automatic failure. Giving both diners the same answer may be reasonable. The saved reviewer decision keeps the finding <strong>advisory</strong>: useful to inspect, but not a rule that fails a release.</p>
        <Callout kind="limitation">Qloo did not return Le Bernardin in these rankings. That is a gap in the evidence, not a negative opinion of the restaurant. The assistant’s activity record is also partial, so it cannot tell us everything the assistant did.</Callout>
        <p>The page calls that activity record a <strong>trace</strong>. “Partial” means it recorded only some of the assistant’s activity.</p>
        <H2 id="sections">Read the answers and rankings</H2>
        <ol>
          <li>Read the shared practical needs at the top.</li>
          <li>Check the finding and the evidence gaps.</li>
          <li>Compare each diner’s request with the assistant’s answer.</li>
          <li>Look at Qloo’s order for each diner. Compare order, not scores from separate requests.</li>
        </ol>
        <p>Profile A and Profile B always mean the two diners. They are not two assistant versions. This example captured one answer for each diner; it does not prove the assistant behaves the same way on every run.</p>
        <H2 id="interactions">Look closer</H2>
        <ul>
          <li>Select a restaurant to follow it across the answer and ranking panels.</li>
          <li>Use <strong>Inspect</strong> to open the saved evidence. On a phone, tap it.</li>
          <li>In cases with repeated runs, the attempt selector lets you browse saved answers. It never sends a new model request.</li>
        </ul>
        <H2 id="sample-status">A saved example, not a live run</H2>
        <Callout kind="recorded">The capture time tells you when this evidence was saved. The sample is read-only: visitors cannot change it, browse private projects or start provider calls. If the saved example cannot be loaded, the page says so rather than inventing results.</Callout>
        <p>To run your own cases, choose <strong>Bring your assistant</strong> and follow <Link href="/docs/using/projects">the project setup guide</Link>.</p>
      </>
    ),
  },
  'from-taste-to-test': {
    headings: [{ id: 'loop', label: 'The simple version' }, { id: 'investigate', label: '1. Find a case' }, { id: 'review', label: '2. Decide what to keep' }, { id: 'replay', label: '3. Test the next version' }, { id: 'classes', label: 'Understand the result labels' }],
    keywords: ['workflow', 'how it works', 'loop', 'release', 'suite', 'baseline', 'candidate'],
    Body: () => (
      <>
        <p>A case becomes a test when you decide what the assistant should do and save that expectation.</p>
        <H2 id="loop">The simple version</H2>
        <p>Connect your assistant, find an interesting case, review the answers, save the useful tests, then use them to compare your next version.</p>
        <H2 id="investigate">1. Find a case</H2>
        <p>You supply the restaurant list and practical needs. TasteCase uses public interests for two fictional diners. Qloo helps find a pair of restaurants that changes order between those diners, and your local runner asks your assistant about both.</p>
        <p>A runner is the small program that connects TasteCase to your assistant. Your model-provider key stays on the machine running it.</p>
        <H2 id="review">2. Decide what to keep</H2>
        <p>Read the answers and the evidence gaps. Accept the finding as something to keep reviewing, edit it into a specific check, reject it, or leave it for later. Write a short reason for your decision.</p>
        <p>For example, “only recommend restaurants from our list” is a check TasteCase can evaluate. “This music fan should enjoy this restaurant” is not a fact TasteCase can prove. Approving an interesting case is not the same as passing a test.</p>
        <H2 id="replay">3. Test the next version</H2>
        <p>Publish your approved cases as a <strong>suite</strong> — a named test collection with a saved version. Compare <strong>Baseline</strong> (your current assistant) with <strong>Candidate</strong> (the version you want to try). Both answer the same saved requests.</p>
        <p>You can download a test pack and rerun it on your own machine. That uses the saved inputs without asking Qloo for fresh rankings.</p>
        <H2 id="classes">Understand the result labels</H2>
        <p><strong>Passed</strong> and <strong>Failed</strong> apply to checks the system can evaluate. <strong>Advisory</strong> asks for your judgement. <strong>Unavailable</strong> means there is not enough evidence or a run did not finish — it never means passed. See <Link href="/docs/reference/result-classes">what each label means</Link>.</p>
      </>
    ),
  },
};
