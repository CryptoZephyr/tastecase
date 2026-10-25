import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  SCHEMA_VERSION, CatalogVersionSchema, CreateCatalogVersionRequestSchema,
  CreateTaskVersionRequestSchema, RankingEvidenceSchema, TargetInputSchema,
  checksum, computeDiscoveryFacts, discoveryAttemptId,
  type TargetInput, type RankingEvidence,
} from '@tastecase/contracts';
import { OfficialQlooAdapter, OpenRouterDecisionAdapter, normalizeRank, type RankRequest } from '@tastecase/worker';
import { createConfiguredAdapter, OPENROUTER_MODEL } from '@tastecase/runner';
import { boundedJson } from '../apps/worker/src/decision.js';
import { localSecrets, redactText } from '../packages/runner/src/safety.js';

const modelUrl = 'https://openrouter.ai/api/v1/chat/completions';
const catalogNames = [
  'Eataly - Flatiron', 'Red Rooster Harlem', "Katz's Delicatessen",
  'Le Bernardin', 'Gramercy Tavern', 'Via Carota', 'Union Square Cafe',
] as const;
const anchorNames = ['Radiohead', 'Taylor Swift', 'The Grand Budapest Hotel'] as const;
const recordedRankFiles = ['expanded-rank-radiohead.json', 'expanded-rank-taylor-swift.json', 'expanded-rank-the-grand-budapest-hotel.json'] as const;
export const trialDefinitions = [
  { anchors: [0, 1], phase: 'calibration' },
  { anchors: [0, 2], phase: 'new_pair' },
  { anchors: [1, 2], phase: 'new_pair' },
] as const;
export const budgets = { qloo: 4, selection: 6, target: 6 } as const;

const fixtureCatalog = z.array(z.object({ name: z.string(), qloo_id: z.uuid() })).min(7);
const fixtureResolutions = z.array(z.object({
  entity: z.string(), envelope: z.object({ results: z.array(z.object({ entity_id: z.uuid() })) }),
}));
const baselineResponse = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).length(1), usage: z.object({ cost: z.number().optional() }).optional() });
const selectedPairResponse = z.strictObject({ selectedPairId: z.string().nullable() });
const recordedRankSchema = z.object({ input: z.strictObject({ options: z.array(z.uuid()), option_type: z.literal('place'), signals: z.array(z.uuid()) }), envelope: z.unknown() });

export function verifiedRecording(record: unknown, request: RankRequest) {
  const { input, envelope } = recordedRankSchema.parse(record);
  if (JSON.stringify(input.options) !== JSON.stringify(request.options.map(option => option.entityId))
    || JSON.stringify(input.signals) !== JSON.stringify(request.anchors.map(anchor => anchor.entityId))) {
    throw new TypeError('Recorded ranking does not match the pinned request');
  }
  const normalized = normalizeRank(envelope, request, 64_000);
  if (!['ok', 'partial'].includes(normalized.providerStatus)) throw new TypeError('Recorded ranking is unavailable');
  return normalized;
}

export function eligiblePairs(entries: readonly { id: string }[]) {
  const pairs: { id: string; entryIds: [string, string] }[] = [];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const first = entries[i], second = entries[j];
    if (!first || !second) continue;
    pairs.push({ id: `pair-${pairs.length + 1}`, entryIds: [first.id, second.id] });
  }
  return pairs;
}

export function parseGenericSelection(value: unknown, pairIds: readonly string[]) {
  const selection = selectedPairResponse.parse(value).selectedPairId;
  if (selection !== null && !pairIds.includes(selection)) throw new TypeError('Generic model selected an unsupported pair');
  return selection;
}

export function reusedRanking(rank: RankingEvidence, profileId: 'a' | 'b') {
  return RankingEvidenceSchema.parse({ ...rank, profileId });
}

export function shuffleCards<T extends { id: string }>(cards: readonly T[], seed: string) {
  return [...cards].sort((a, b) => createHash('sha256').update(`${seed}:${a.id}`).digest('hex')
    .localeCompare(createHash('sha256').update(`${seed}:${b.id}`).digest('hex')));
}

type Comparison = { trial: number; method: 'guided' | 'generic'; pair: [string, string] | null };
type TrialResult = { trial: number; phase: string; profiles: string[];
  rankings: { providerStatus: string; orderedEntryIds: string[]; missingEntryIds: string[] }[];
  supportedReversals: [string, string][]; guided: [string, string] | null; generic: [string, string] | null;
  guidedStatus: 'not_attempted' | 'selected' | 'abstained' | 'unavailable'; genericStatus: 'not_attempted' | 'selected' | 'abstained' | 'unavailable' };

export function reviewPacket<T extends { profile: string }>(
  comparisons: Comparison[], runId: string, entries: { id: string; name: string }[], anchors: { name: string }[],
  trials: Pick<TrialResult, 'rankings' | 'supportedReversals'>[], targets: T[],
) {
  const unique = new Map<string, { id: string; trial: number; pair: [string, string]; methods: Comparison['method'][] }>();
  for (const item of comparisons) {
    if (!item.pair) continue;
    const pair = [...item.pair].sort() as [string, string];
    const id = JSON.stringify([item.trial, pair]);
    const existing = unique.get(id);
    if (existing) {
      if (!existing.methods.includes(item.method)) existing.methods.push(item.method);
    } else unique.set(id, { id, trial: item.trial, pair, methods: [item.method] });
  }
  const shuffled = shuffleCards([...unique.values()], runId);
  const cards = shuffled.map((item, index) => {
    const definition = trialDefinitions[item.trial];
    const evidence = trials[item.trial];
    if (!definition || !evidence) throw new TypeError('Missing pinned trial for review');
    const profiles = definition.anchors.map(anchor => anchors[anchor]!.name);
    return { card: `Case ${index + 1}`, phase: definition.phase, profiles,
      question: `Is comparing ${item.pair.map(id => entries.find(entry => entry.id === id)!.name).join(' and ')} useful for testing this assistant?`,
      pair: item.pair, coverage: evidence.rankings.map(rank => ({ providerStatus: rank.providerStatus,
        rankedOptions: rank.orderedEntryIds.length, missingOptions: rank.missingEntryIds.length })),
      targetOutputs: targets.filter(t => new Set<string>(profiles).has(t.profile)),
      review: { useful: 'yes / no / defer', minutes: 'enter time spent', reason: 'why is this worth (or not worth) keeping?' },
    };
  });
  return { cards,
    sourceByCard: shuffled.flatMap((item, index) => item.methods.map(method => ({ card: `Case ${index + 1}`, method, trial: item.trial + 1 }))),
    evidenceByCard: shuffled.map((item, index) => ({ card: `Case ${index + 1}`,
      rankings: trials[item.trial]!.rankings, supportedReversals: trials[item.trial]!.supportedReversals })),
  };
}

export function serializePilotArtifact(value: unknown, secrets: readonly string[] = localSecrets(process.env)) {
  function containsCredential(item: unknown): boolean {
    if (typeof item === 'string') return redactText(item, secrets) !== item;
    if (Array.isArray(item)) return item.some(containsCredential);
    if (item && typeof item === 'object') return Object.entries(item).some(([key, entry]) => containsCredential(key) || containsCredential(entry));
    return false;
  }
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined || redactText(serialized, secrets) !== serialized || containsCredential(value)) {
    throw new TypeError('Pilot artifact contains credential-like content; no artifacts were written');
  }
  return serialized;
}

const brief = 'For a fictional dinner, recommend two restaurants from the supplied eligible New York catalog using exact IDs and reasons. Consider stated public interests but do not infer personal preferences, price, access, diet or availability. Unknown facts stay unknown.';

async function fixtures(directory: string) {
  const catalogSource = fixtureCatalog.parse(JSON.parse(await readFile(join(directory, 'expanded-catalog.json'), 'utf8')));
  const resolutionSource = fixtureResolutions.parse(JSON.parse(await readFile(join(directory, 'entity-resolution.json'), 'utf8')));
  const entries = catalogNames.map((name, index) => {
    const matches = catalogSource.filter(row => row.name === name);
    if (matches.length !== 1) throw new TypeError('The predeclared mapped catalog is not available');
    return { id: `venue-${index + 1}`, name, qlooId: matches[0]!.qloo_id };
  });
  const anchors = anchorNames.map((name, index) => {
    const matches = resolutionSource.filter(row => row.entity === name);
    const results = matches[0]?.envelope.results;
    if (matches.length !== 1 || results?.length !== 1) throw new TypeError('A predeclared public anchor is not confirmed');
    return { name, kind: index === 2 ? 'film' : 'music', qlooId: results[0]!.entity_id };
  });
  return { entries, anchors };
}

async function genericSelect(key: string, prompt: unknown, pairIds: readonly string[]) {
  const response = await fetch(modelUrl, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: OPENROUTER_MODEL, temperature: 0, max_tokens: 2048,
      provider: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0 } },
      reasoning: { enabled: false, exclude: true }, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You propose a synthetic dining recommendation case for human review. Choose one pair of eligible catalog restaurants worth investigating for two fictional guests with different stated public cultural interests, while preserving their shared practical constraints. A different recommendation is not inherently good or bad. Select null if no pair is worth investigating. Reply only with JSON {"selectedPairId":"a listed pair id"} or {"selectedPairId":null}. Never invent facts.' },
        { role: 'user', content: JSON.stringify(prompt) },
      ],
    }),
  });
  if (!response.ok || response.redirected) { await response.body?.cancel(); throw new TypeError(`Generic selection unavailable (HTTP ${response.status})`); }
  const raw = await boundedJson(response, 64_000);
  if (JSON.stringify(raw).includes(key)) throw new TypeError('Unsafe generic selection');
  const envelope = baselineResponse.parse(raw);
  if (envelope.usage?.cost !== undefined && envelope.usage.cost !== 0) throw new TypeError('Provider reported a nonzero cost');
  const content = envelope.choices[0]!.message.content;
  if (content === null) throw new TypeError('Generic selection returned no content');
  return parseGenericSelection(JSON.parse(content), pairIds);
}

function createTarget(base: TargetInput, anchor: { name: string; kind: string }) {
  const task = CreateTaskVersionRequestSchema.parse({
    schema_version: SCHEMA_VERSION, id: randomUUID(), label: 'Fictional paired discovery brief',
    catalogVersionId: base.catalog.id, syntheticBrief: {
      provenance: 'synthetic', label: 'Fictional dinner', text: `${brief}\nThis is an explicitly fictional guest, not a personal history. Public interest: ${anchor.kind}: ${anchor.name}.`,
    }, syntheticInterests: [{ provenance: 'synthetic', label: `Public ${anchor.kind} interest`, text: anchor.name }],
    constraints: base.task.constraints,
  });
  return TargetInputSchema.parse({ ...base, task: { ...task, projectId: base.projectId, checksum: checksum(task), createdAt: base.task.createdAt } });
}

function formattedRecommendations(result: Awaited<ReturnType<ReturnType<typeof createConfiguredAdapter>['runWithUsage']>>) {
  const output = result.result;
  if (output.outcome !== 'success') throw new TypeError(`Target unavailable (${output.outcome}); no rerun is made`);
  return { recommendations: output.output.recommendations.map(value => ({ id: value.catalogEntryId ?? null, name: value.name, reason: value.reason ?? '' })),
    trace: output.trace.completeness, tokens: result.usage?.totalTokens ?? null };
}

async function main() {
  if (process.env.TASTECASE_BENCHMARK_LIVE !== '1') throw new TypeError('Explicit live pilot opt-in is required');
  const directory = process.env.TASTECASE_QLOO_FIXTURE_DIRECTORY;
  const key = process.env.OPENROUTER_API_KEY;
  const path = process.env.TASTECASE_BENCHMARK_OUTPUT_DIRECTORY;
  if (!path || !path.endsWith('/.local')) throw new TypeError('Output must be in an existing ignored .local directory');
  const source = process.env.TASTECASE_BENCHMARK_QLOO_SOURCE ?? 'live';
  if (!['live', 'historical_recording'].includes(source)) throw new TypeError('Unsupported Qloo evidence source');
  if (!directory || !key || source === 'live' && !process.env.QLOO_API_KEY) throw new TypeError('Existing confirmed fixtures and required provider keys are missing');
  const { entries, anchors } = await fixtures(directory);
  const now = new Date().toISOString();
  const runId = randomUUID();
  const projectId = randomUUID();
  const catalogRequest = CreateCatalogVersionRequestSchema.parse({ schema_version: SCHEMA_VERSION, id: randomUUID(), label: 'Fixed public NYC pilot catalog',
    entries: entries.map(({ id, name }) => ({ id, name, metadata: { city: 'New York', countryCode: 'US' } })) });
  const catalog = CatalogVersionSchema.parse({ ...catalogRequest, projectId, checksum: checksum(catalogRequest), createdAt: now });
  const task = CreateTaskVersionRequestSchema.parse({ schema_version: SCHEMA_VERSION, id: randomUUID(), label: 'Fixed fictional dinner task',
    catalogVersionId: catalog.id, syntheticBrief: { provenance: 'synthetic', label: 'Fictional dinner', text: brief }, syntheticInterests: [],
    constraints: { partySize: 2, location: { city: 'New York', countryCode: 'US' }, dietaryRequirements: [], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: [] },
  });
  const base = TargetInputSchema.parse({ schema_version: SCHEMA_VERSION, projectId, catalog,
    task: { ...task, projectId, checksum: checksum(task), createdAt: now }, eligibleCatalogEntryIds: entries.map(e => e.id),
    mappings: entries.map(e => ({ schema_version: SCHEMA_VERSION, id: randomUUID(), projectId,
      catalogVersionId: catalog.id, catalogEntryId: e.id, qlooEntityId: e.qlooId, confirmedBy: projectId, createdAt: now })),
  });
  const counts = { qloo: 0, guidedSelections: 0, genericSelections: 0, target: 0 };
  const previousId = process.env.TASTECASE_BENCHMARK_PRIOR_RUN_ID;
  if (previousId) {
    if (source !== 'live') throw new TypeError('Do not merge live provider counts into a retrospective study');
    z.uuid().parse(previousId);
    const previous = z.object({ status: z.literal('partial'), counts: z.strictObject({
      qloo: z.literal(1), guidedSelections: z.literal(0), genericSelections: z.literal(0), target: z.literal(0),
    }) }).parse(JSON.parse(await readFile(join(path, `discovery-pilot-${previousId}.json`), 'utf8')));
    counts.qloo = previous.counts.qloo;
  }
  const pairs = eligiblePairs(entries);
  const result: { runId: string; source: string; previousRunId: string | null; startedAt: string; catalogChecksum: string; taskChecksum: string; counts: typeof counts; qlooHttpAttempts: number | null; status: string; recordingChecksums: { profile: string; sha256: string }[]; rankingOperations: { profile: string; evidence: RankingEvidence }[]; trials: TrialResult[]; targets: { profile: string; inputChecksum: string; attempts: ReturnType<typeof formattedRecommendations>[] }[]; error?: string } = {
    runId, source, previousRunId: previousId ?? null, startedAt: now, catalogChecksum: catalog.checksum, taskChecksum: checksum(task), counts,
    qlooHttpAttempts: source === 'historical_recording' ? 0 : null, status: 'started', recordingChecksums: [], rankingOperations: [], trials: [], targets: [],
  };
  const qloo = new OfficialQlooAdapter();
  const decision = new OpenRouterDecisionAdapter(key);
  const target = createConfiguredAdapter({ env: { ...process.env, TASTECASE_MODEL_PROVIDER: 'openrouter' } });
  const rankCache = new Map<number, RankingEvidence>();
  const comparisons: Comparison[] = [];
  try {
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i]!;
      const request: RankRequest = { profileId: 'a', scope: 'full',
        options: entries.map(entry => ({ entryId: entry.id, entityId: entry.qlooId, confirmationId: randomUUID() })),
        anchors: [{ entityId: anchor.qlooId, confirmationId: randomUUID() }], unmappedEntryIds: [],
      };
      let rank: RankingEvidence;
      if (source === 'historical_recording') {
        const recorded = await readFile(join(directory, recordedRankFiles[i]!), 'utf8');
        rank = verifiedRecording(JSON.parse(recorded), request);
        result.recordingChecksums.push({ profile: anchor.name, sha256: createHash('sha256').update(recorded).digest('hex') });
      } else {
        if (counts.qloo >= budgets.qloo) throw new TypeError('Qloo budget exceeded');
        counts.qloo++;
        rank = await qloo.rank(request, { signal: AbortSignal.timeout(90_000), outputBytes: 64_000 });
      }
      rankCache.set(i, rank);
      result.rankingOperations.push({ profile: anchor.name, evidence: rank });
      if (!['ok', 'partial'].includes(rank.providerStatus)) throw new TypeError(`Qloo rank unavailable (${rank.providerStatus}${rank.error ? `: ${rank.error.code}` : ''})`);
    }
    for (const [trial, definition] of trialDefinitions.entries()) {
      const left = anchors[definition.anchors[0]]!, right = anchors[definition.anchors[1]]!;
      const a = reusedRanking(rankCache.get(definition.anchors[0])!, 'a');
      const b = reusedRanking(rankCache.get(definition.anchors[1])!, 'b');
      const facts = computeDiscoveryFacts(discoveryAttemptId(runId, `trial:${trial}`, 0), [randomUUID(), randomUUID()], a, b);
      if (counts.guidedSelections + counts.genericSelections >= budgets.selection) throw new TypeError('Selection budget exceeded');
      const trialResult: TrialResult = { trial: trial + 1, phase: definition.phase, profiles: [left.name, right.name],
        rankings: [a, b].map(rank => ({ providerStatus: rank.providerStatus, orderedEntryIds: rank.orderedEntryIds, missingEntryIds: rank.missingEntryIds })),
        supportedReversals: facts.contrasts.map(contrast => contrast.entryIds), guided: null, generic: null, guidedStatus: 'not_attempted', genericStatus: 'not_attempted' };
      result.trials.push(trialResult);
      counts.guidedSelections++;
      trialResult.guidedStatus = 'unavailable';
      const guidedId = (await decision.select(facts, { signal: AbortSignal.timeout(75_000), outputBytes: 64_000 })).selectedContrastId;
      trialResult.guided = facts.contrasts.find(value => value.id === guidedId)?.entryIds ?? null;
      trialResult.guidedStatus = trialResult.guided ? 'selected' : 'abstained';
      comparisons.push({ trial, method: 'guided', pair: trialResult.guided });
      counts.genericSelections++;
      trialResult.genericStatus = 'unavailable';
      const genericId = await genericSelect(key, {
        task: brief, profiles: [left, right].map(({ name, kind }) => ({ publicInterest: name, kind })),
        eligibleCatalog: entries.map(({ id, name }) => ({ id, name })),
        candidatePairs: pairs.map(pair => ({ id: pair.id, restaurants: pair.entryIds.map(id => entries.find(entry => entry.id === id)!.name) })),
      }, pairs.map(pair => pair.id));
      trialResult.generic = pairs.find(pair => pair.id === genericId)?.entryIds ?? null;
      trialResult.genericStatus = trialResult.generic ? 'selected' : 'abstained';
      comparisons.push({ trial, method: 'generic', pair: trialResult.generic });
    }
    for (let i = 0; i < anchors.length; i++) {
      if (counts.target + 2 > budgets.target) throw new TypeError('Target budget exceeded');
      const input = createTarget(base, anchors[i]!);
      const attempts: ReturnType<typeof formattedRecommendations>[] = [];
      result.targets.push({ profile: anchors[i]!.name, inputChecksum: checksum(input), attempts });
      for (let repeat = 0; repeat < 2; repeat++) {
        counts.target++;
        attempts.push(formattedRecommendations(await target.runWithUsage(input, { signal: AbortSignal.timeout(75_000) })));
      }
    }
    result.status = 'completed';
  } catch (error) {
    result.status = 'partial';
    result.error = error instanceof Error ? redactText(error.message, localSecrets(process.env)) : 'Unknown provider failure';
  } finally {
    await qloo.close();
  }
  const { cards, sourceByCard, evidenceByCard } = reviewPacket(comparisons, runId, entries, anchors, result.trials, result.targets);
  const artifacts = [serializePilotArtifact(result), serializePilotArtifact({
    warning: 'Stage 1: record usefulness, reason and minutes before opening the private evidence/key file. Stage 2: inspect ranking evidence and record evidence sufficiency separately. Missing coverage is unavailable, not dislike. No finding is automatically a failure or an approved test. Disclose any prior knowledge of attribution; blindness is not guaranteed.',
    runId, status: result.status, cards,
  }), serializePilotArtifact({ runId, sourceByCard, evidenceByCard })];
  for (const [index, name] of [`discovery-pilot-${runId}.json`, `discovery-pilot-review-${runId}.json`, `discovery-pilot-key-${runId}.json`].entries()) {
    await writeFile(join(path, name), artifacts[index]!, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ status: result.status, runId, requests: counts, cards: cards.length, ...result.error ? { error: result.error } : {} }));
  if (result.status !== 'completed') process.exitCode = 1;
}

if (import.meta.main) void main().catch(() => {
  console.error('Pilot setup or artifact validation failed; no rerun was made');
  process.exitCode = 1;
});
