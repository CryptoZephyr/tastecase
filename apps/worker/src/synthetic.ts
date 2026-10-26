import {
  checksum, discoveryAttemptId, CreateTaskVersionRequestSchema, TargetInputSchema,
  type DiscoveryJob, type ComputedDiscoveryFacts, type SyntheticText,
} from '@tastecase/contracts';
import type { ScheduledTarget } from './types.js';

export function syntheticBrief(job: DiscoveryJob, profileId: 'a' | 'b', pair?: [string, string]): SyntheticText {
  const profile = job.input.request.profiles.find(value => value.id === profileId);
  if (!profile) throw new TypeError('Missing pinned profile');
  let orderedPair: [string, string] | undefined;
  if (pair) {
    const entries = job.input.targetInput.catalog.entries;
    const firstIndex = entries.findIndex(entry => entry.id === pair[0]);
    const secondIndex = entries.findIndex(entry => entry.id === pair[1]);
    if (firstIndex < 0 || secondIndex < 0) throw new TypeError('Pair outside pinned catalog');
    orderedPair = firstIndex <= secondIndex ? pair : [pair[1], pair[0]];
  }
  return {
    provenance: 'synthetic', label: `Synthetic discovery profile ${profileId}`,
    text: [job.input.targetInput.task.syntheticBrief.text,
      'This is an explicitly fictional test brief, not a real guest history.',
      `Public interests: ${profile.anchors.map(anchor => `${anchor.kind}: ${anchor.label}`).join('; ')}.`,
      ...(orderedPair ? [`Investigate the relative order of catalog IDs ${orderedPair.join(' and ')} within the unchanged eligible catalog. They are listed in catalog order, which is not a preference. Do not remove any practical constraint or exclude other eligible options.`] : []),
    ].join('\n'),
  };
}

/** Reduced follow-ups change only the question, never eligibility or hard constraints. */
export function syntheticTarget(job: DiscoveryJob, profileId: 'a' | 'b', repeat: number, pair?: [string, string]): ScheduledTarget {
  const variant = pair ? 'reduced_pair' : 'full'; const round = pair ? 1 : 0;
  const task = CreateTaskVersionRequestSchema.parse({
    schema_version: '1.0.0', id: discoveryAttemptId(job.id, `task:${profileId}:${variant}`, 0),
    label: `Synthetic discovery ${profileId} ${variant}`, catalogVersionId: job.input.targetInput.catalog.id,
    syntheticBrief: syntheticBrief(job, profileId, pair),
    syntheticInterests: job.input.request.profiles.find(profile => profile.id === profileId)?.anchors.map(anchor => ({
      provenance: 'synthetic', label: `Public ${anchor.kind} interest`, text: anchor.label,
    })) ?? [],
    constraints: job.input.targetInput.task.constraints,
  });
  const input = TargetInputSchema.parse({ ...job.input.targetInput, task: {
    ...task, projectId: job.projectId, checksum: checksum(task), createdAt: job.createdAt,
  } });
  return { attemptId: discoveryAttemptId(job.id, `target:${profileId}:${round}:${repeat}:${variant}`, 0), input, task, profileId, round, repeat, variant };
}

export function selectedPair(facts: ComputedDiscoveryFacts, id: string) {
  const contrast = facts.contrasts.find(value => value.id === id);
  if (!contrast) throw new TypeError('Unsupported contrast selection');
  return contrast;
}
