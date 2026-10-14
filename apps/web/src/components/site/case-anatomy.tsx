import { ArrowRight, Info } from 'lucide-react';
import { ClassBadge } from '@/components/ui/badge';
import { ProfileTag } from '@/components/case/labels';

const constraints = ['Party size', 'City', 'Budget per person', 'Dietary needs', 'Accessibility needs', 'Eligible restaurants'];

/**
 * Hero preview of how one case reads. It depicts structure only: there are no restaurant names,
 * counts, outputs or verdicts here because no recorded or live sample evidence is connected.
 */
export function CaseAnatomy() {
  return (
    <figure className="rounded-panel border border-rule bg-surface text-control" aria-labelledby="anatomy-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-5 py-3">
        <p id="anatomy-title" className="font-medium">How one case reads</p>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-info-bg px-2.5 py-0.5 text-meta font-medium text-info">
          <Info aria-hidden className="size-3.5" strokeWidth={2} /> Structure only · no results shown
        </span>
      </div>

      <div className="space-y-4 p-5">
        <p className="text-ink-2"><span className="font-medium text-ink">Task</span> · Dining recommendations from your own restaurant catalog</p>

        <div className="rounded-control bg-subtle p-3">
          <p className="text-meta font-medium text-ink">Shared constraints — identical for both profiles</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {constraints.map(item => <li key={item} className="rounded-full border border-rule bg-surface px-2 py-0.5 text-meta text-ink">{item}</li>)}
          </ul>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {(['a', 'b'] as const).map(profile => (
            <div key={profile} className="rounded-control border border-rule p-3">
              <ProfileTag profile={profile} />
              <p className="mt-2 text-meta text-ink-2">Synthetic brief</p>
              <p className="text-ink">{profile === 'a'
                ? 'A fictional diner described through public music, film or brand interests.'
                : 'A contrasting set of public interests with the same practical needs.'}</p>
              <p className="mt-2 text-meta text-ink-2">Your assistant’s recommendations for this brief, from the eligible catalog.</p>
            </div>
          ))}
        </div>

        <div className="rounded-control border border-rule p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Finding</span>
            <ClassBadge classification="advisory" />
          </div>
          <p className="mt-2 text-ink">Qloo orders two eligible restaurants differently for A and B. TasteCase checks whether your assistant’s answers changed too.</p>
          <p className="mt-2 text-meta text-ink-2">Beside every finding, before review: ranking coverage, missing or unranked candidates, trace completeness.</p>
        </div>

        <ol className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr]">
          <li className="rounded-control bg-subtle p-3">
            <p className="font-medium">Human review</p>
            <p className="text-meta text-ink-2">Accept, edit, reject or defer — with a rationale.</p>
          </li>
          <li aria-hidden className="hidden items-center text-ink-2 sm:flex"><ArrowRight className="size-4" strokeWidth={1.75} /></li>
          <li className="rounded-control bg-subtle p-3">
            <p className="font-medium">Saved test</p>
            <p className="text-meta text-ink-2">A suite version with its checksum, shown only after a publication receipt.</p>
          </li>
        </ol>
      </div>
    </figure>
  );
}
