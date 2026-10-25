import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  canonicalJson, checksum, computeDiscoveryFacts, discoveryAttemptId, validateModelContrastDecision,
  RankingEvidenceSchema, ResolutionEvidenceSchema, ComputedDiscoveryFactsSchema, validateDiscoveryCandidate,
  NormalizedDiscoveryEvidenceSchema, type NormalizedDiscoveryEvidence, type ComputedDiscoveryFacts,
} from '@tastecase/contracts';
import { DiscoveryStore } from './store.js';
import {
  StopWork, UnknownDispatch, evidenceFor, type Snapshot, type QlooAdapter, type DecisionAdapter,
  type RankRequest, type ProviderContext, type TargetObservation,
} from './types.js';
import { syntheticBrief, syntheticTarget, selectedPair } from './synthetic.js';

const terminal = new Set(['awaiting_review','no_useful_contrast','unavailable','partial','budget_exhausted','deadline_exceeded','cancelled','failed']);
export interface WorkerOptions {
  projectId?: string; leaseSeconds?: number; pollMilliseconds?: number; heartbeatMilliseconds?: number;
  /** Unknown outcomes are not automatically retryable. An explicit opt-in creates a new charged slot. */
  retryUncertain?: boolean;
}
export interface WorkerAdapters { qloo: () => QlooAdapter; decision: DecisionAdapter }

function providerSecretValues() {
  return Object.entries(process.env).flatMap(([name,value]) =>
    value && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL)/i.test(name) ? [value] : []);
}

function redactProviderDetail(value: string) {
  let redacted = value;
  for (const secret of providerSecretValues()) {
    for (const representation of new Set([secret,JSON.stringify(secret).slice(1,-1)])) {
      redacted = redacted.split(representation).join('[REDACTED]');
    }
  }
  return redacted.replace(/tc_runner_[A-Za-z0-9_-]{43}/g,'[REDACTED]')
    .replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [REDACTED]');
}

function causeClassNames(error: TypeError) {
  if (error.cause === undefined) return undefined;
  const names: string[] = [];
  const seen = new Set<unknown>();
  let cause: unknown = error.cause;
  while (cause !== undefined && !seen.has(cause) && names.length < 8) {
    seen.add(cause);
    if (cause === null) names.push('Null');
    else if (typeof cause === 'object' || typeof cause === 'function') {
      const constructorName = Object.getPrototypeOf(cause)?.constructor?.name;
      names.push(typeof constructorName === 'string' && /^[A-Za-z_$][\w$]*$/.test(constructorName) ? constructorName : 'Object');
    } else {
      names.push(typeof cause === 'string' ? 'String' : typeof cause === 'number' ? 'Number' : typeof cause === 'boolean' ? 'Boolean' : typeof cause);
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return names;
}

function logProviderInvalidData(
  jobId: string, operationKey: string, kind: 'qloo' | 'model', error: TypeError | z.ZodError | SyntaxError,
) {
  const errorClass = error instanceof z.ZodError ? 'ZodError' : error instanceof SyntaxError ? 'SyntaxError' : 'TypeError';
  const detail = error instanceof z.ZodError
    ? error.issues.slice(0,10).map(issue => ({path:issue.path.join('.'),code:issue.code}))
    : error instanceof SyntaxError ? null : redactProviderDetail(error.message.slice(0,160));
  const causes = error instanceof TypeError ? causeClassNames(error) : undefined;
  console.error(JSON.stringify({
    event:'discovery_provider_invalid_data',jobId,operationKey,kind,errorClass,detail,
    ...(causes ? {causeClasses:causes} : {}),
  }));
}

function rankRequest(snapshot: Snapshot, profileId: 'a' | 'b', pair?: [string,string]): RankRequest {
  const input = snapshot.job.input.targetInput;
  const mapped = input.mappings.filter(mapping => input.eligibleCatalogEntryIds.includes(mapping.catalogEntryId));
  const requested = pair ?? input.eligibleCatalogEntryIds.filter(id => mapped.some(mapping => mapping.catalogEntryId === id));
  const profile = snapshot.job.input.request.profiles.find(profile => profile.id === profileId);
  if (!profile) throw new TypeError('Missing pinned profile');
  const anchors = profile.anchors.map(anchor => {
    const confirmation = snapshot.confirmations.find(value => value.anchorId === anchor.id);
    if (!confirmation) throw new StopWork('needs_confirmation','Public anchors require owner confirmation.');
    return {entityId:confirmation.entityId,confirmationId:confirmation.id};
  });
  return {profileId,scope:pair ? 'reduced_pair' : 'full',options:requested.map(entryId => {
    const mapping = mapped.find(mapping => mapping.catalogEntryId === entryId);
    if (!mapping) throw new TypeError('Reduction outside mapped catalog');
    return {entryId,entityId:mapping.qlooEntityId,confirmationId:mapping.id};
  }),anchors,unmappedEntryIds:input.eligibleCatalogEntryIds.filter(id => !mapped.some(mapping => mapping.catalogEntryId === id))};
}

/** A bounded operation always reopens the ledger before reserving or dispatching. */
async function operation(
  store: DiscoveryStore, snapshot: Snapshot, key: string, kind: 'qloo' | 'model', request: unknown,
  run: (context: ProviderContext) => Promise<NormalizedDiscoveryEvidence>, signal: AbortSignal, retryUncertain: boolean,
) {
  const {job} = snapshot;
  const accepted = evidenceFor(snapshot,key);
  if (accepted) return accepted;
  const history = snapshot.providerAttempts.filter(attempt => attempt.operationKey === key && attempt.kind === kind).sort((a,b) => a.tryNumber-b.tryNumber);
  const previous = history.at(-1);
  const uncertain = previous?.status === 'uncertain';
  const interrupted = previous?.status === 'interrupted';
  if (previous && previous.requestChecksum !== checksum(request)) throw new TypeError('Operation checksum conflict');
  if (previous?.status === 'accepted') throw new StopWork('failed','Accepted provider result is missing its immutable evidence.');
  if (previous?.status === 'error' && !previous.retryable) {
    const evidence = snapshot.evidence.find(evidence => evidence.attemptId === previous.id);
    if (evidence) return evidence;
    throw new StopWork('unavailable','Provider access or output was unavailable; no automatic retry is permitted.');
  }
  if (uncertain && !retryUncertain) throw new StopWork('unavailable','An interrupted provider dispatch has an unknown outcome and remains charged; no automatic repeat was made.');
  if (previous?.status === 'dispatched' || previous?.status === 'reserved') throw new UnknownDispatch();
  const tryNumber = previous ? previous.tryNumber+1 : 0;
  if (tryNumber > job.input.request.budgets.retriesPerOperation) throw new StopWork('unavailable','The bounded provider retry allowance is exhausted.');
  if (previous?.nextDispatchAt && Date.parse(previous.nextDispatchAt)>Date.now()) {
    throw new StopWork(job.state,'Waiting for persisted provider backoff.',Math.min(300,Math.max(1,Math.ceil((Date.parse(previous.nextDispatchAt)-Date.now())/1000))));
  }
  const counter = kind === 'qloo' ? 'qlooAttempts' : 'modelDecisions';
  if (job.counters[counter] >= job.input.request.budgets[counter]) throw new StopWork('budget_exhausted',`The reserved ${counter} budget is exhausted.`);
  signal.throwIfAborted();
  const id = await store.reserve(job,key,kind,tryNumber,request,interrupted || (uncertain && retryUncertain));
  signal.throwIfAborted(); await store.dispatch(job,id);
  let value: NormalizedDiscoveryEvidence;
  try {
    value = NormalizedDiscoveryEvidenceSchema.parse(await run({signal,outputBytes:job.input.request.budgets.outputBytes})); signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof TypeError || error instanceof z.ZodError || error instanceof SyntaxError) {
      const code = error.message === 'MODEL_AUTH' ? 'MODEL_AUTH' : error.message === 'MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE' : 'PROVIDER_INVALID_DATA';
      logProviderInvalidData(job.id,key,kind,error);
      await store.fail(job,id,code === 'MODEL_AUTH' ? 'auth' : code === 'PROVIDER_INVALID_DATA' ? 'invalid_input' : 'unavailable',code);
      throw new StopWork('unavailable','Provider access, schema compatibility or output validation was unavailable. No taste verdict was made.');
    }
    throw new UnknownDispatch();
  }
  const evidenceId = await store.complete(job,id,value,Math.min(300,30*2**tryNumber));
  const reloaded = await store.load(job.projectId,job.id);
  const saved = reloaded.evidence.find(evidence => evidence.id === evidenceId);
  if (!saved) throw new TypeError('Missing committed provider evidence');
  if ('error' in value && value.error?.retryable) {
    if (tryNumber >= job.input.request.budgets.retriesPerOperation) throw new StopWork('unavailable','Flagged transient provider error exhausted the bounded retry allowance.');
    throw new StopWork(job.state,'Waiting for persisted flagged transient provider backoff.',Math.min(300,30*2**tryNumber));
  }
  if ('error' in value && value.error) throw new StopWork('unavailable','Provider access or execution is unavailable; no automatic retry is permitted. Accepted evidence remains recorded.');
  return saved;
}

function successIds(target: TargetObservation) {
  if (target.result?.outcome !== 'success') return null;
  return target.result.output.recommendations.map(recommendation => recommendation.catalogEntryId ?? null);
}

async function saveFinding(store: DiscoveryStore, snapshot: Snapshot, facts: ComputedDiscoveryFacts, contrastId: string, extra: string[] = []) {
  const job = snapshot.job; const contrast = selectedPair(facts,contrastId);
  const limitations = [
    'Aggregate Qloo evidence is advisory, not an individual preference or an automatic correctness failure. Human review is required.',
    'Scores from separate affinity queries are not combined or subtracted. Missing or unmapped coverage is unavailable, never negative preference.',
    `Missing mapped coverage: ${facts.missingEntryIds.length}; unmapped eligible options: ${facts.unmappedEntryIds.length}.`,
    'No exactly-once provider dispatch or billing guarantee is made; interrupted attempts remain visible and charged.',
    ...extra,
  ];
  const full = snapshot.targets.filter(target => target.variant === 'full');
  const intendedFull = job.input.request.repeatCount*2;
  if (full.length<intendedFull) limitations.push(`Only ${full.length} of ${intendedFull} intended full-profile repeats fit the remaining target budget.`);
  const unfinished = snapshot.targets.filter(target => target.status !== 'completed');
  if (unfinished.length) limitations.push(`${unfinished.length} scheduled target attempts are unfinished. No result is inferred for them.`);
  if (snapshot.targets.some(target => target.result?.outcome !== 'success')) limitations.push('At least one target result is unavailable, malformed or unfinished; it is an execution gap, not a taste pass or failure.');
  if (snapshot.targets.some(target => target.result?.trace.completeness !== 'complete')) limitations.push('Incomplete or unavailable traces cannot prove missing tool calls.');
  if (snapshot.targets.some(target => target.uncertainDispatches)) limitations.push('At least one target dispatch has an uncertain interrupted history; runner recovery may have repeated a provider call.');
  const a = full.filter(target => target.profileId==='a').map(successIds); const b = full.filter(target => target.profileId==='b').map(successIds);
  if (a.length && b.length && a.every(ids => ids !== null) && b.every(ids => ids !== null)) {
    limitations.push(canonicalJson(a) === canonicalJson(b)
      ? 'Observed full-profile recommendation sequences were identical. This may be legitimate and remains advisory.'
      : 'Observed full-profile recommendation sequences differed. This is a descriptive observation, not proof of correct personalisation.');
  }
  const candidate = validateDiscoveryCandidate({contrast,briefs:{a:syntheticBrief(job,'a'),b:syntheticBrief(job,'b'),
    constraints:job.input.targetInput.task.constraints,eligibleCatalogEntryIds:job.input.targetInput.eligibleCatalogEntryIds},
    evidenceIds:job.checkpointData.evidenceIds,targetAttemptIds:snapshot.targets.map(target=>target.attemptId),
    proposedExpectation:{classification:'advisory',automaticFailure:false,humanReviewRequired:true,contrastId,
      rationale:'Review whether the authorised assistant handles these explicit synthetic interests under the same practical constraints. The observed Qloo order reversal suggests a case to inspect, not an approved assertion.'},
    limitations,
  },job.input,facts);
  const partial = extra.length>0 || full.length<intendedFull || unfinished.length>0 || snapshot.targets.some(target => target.result?.outcome !== 'success')
    || facts.missingEntryIds.length>0 || facts.unmappedEntryIds.length>0;
  await store.saveCandidate(job,discoveryAttemptId(job.id,`candidate:${contrastId}`,0),candidate,{
    state:partial ? 'partial' : 'awaiting_review',checkpoint:6,release:true,
    reason:partial ? 'An immutable advisory finding was saved with explicit execution or coverage gaps for later human review.' : 'An immutable advisory finding was saved for later human review.',
  });
}

/** No framework/in-memory queue: each pass reads durable checkpoints and the dispatch ledger. */
async function execute(store: DiscoveryStore, initial: Snapshot, qloo: QlooAdapter, decision: DecisionAdapter, signal: AbortSignal, options: WorkerOptions) {
  let snapshot = initial;
  const reload = async () => { snapshot = await store.load(initial.job.projectId,initial.job.id); signal.throwIfAborted(); return snapshot; };
  const call = (key: string, kind: 'qloo' | 'model', request: unknown, work: (context: ProviderContext) => Promise<NormalizedDiscoveryEvidence>) =>
    operation(store,snapshot,key,kind,request,work,signal,options.retryUncertain ?? false);
  if (snapshot.job.checkpoint==='pinned') {
    await store.advance(snapshot.job,{state:'resolving'}); await reload();
    let confirmationNeeded = false;
    for (const profile of snapshot.job.input.request.profiles) for (const anchor of profile.anchors) {
      if (snapshot.confirmations.some(confirmation=>confirmation.anchorId===anchor.id)) continue;
      const evidence = await call(`resolve:${anchor.id}`,'qloo',anchor,context=>qloo.resolve(anchor,context));
      const resolution = ResolutionEvidenceSchema.parse(evidence.data);
      await store.advance(snapshot.job,{state:'resolving',evidenceIds:[evidence.id]}); await reload();
      if (resolution.error || !resolution.candidates.length || !['ok','partial','needs_input'].includes(resolution.providerStatus)) throw new StopWork('unavailable','A public anchor could not be resolved with supported evidence.');
      confirmationNeeded = true;
    }
    if (confirmationNeeded) throw new StopWork('needs_confirmation','Choose the intended observed public anchor candidates. The worker cannot confirm on behalf of the owner.');
    await store.advance(snapshot.job,{state:'ranking',checkpoint:1,round:true}); await reload();
  }
  if (snapshot.job.checkpoint==='anchors') {
    const request = rankRequest(snapshot,'a');
    if (request.options.length>10) throw new StopWork('unavailable','Unsupported: more than ten mapped eligible options. Separate affinity calls cannot be merged as common-scale scores.');
    if (request.options.length<2) throw new StopWork('unavailable','Insufficient owner-confirmed mapped coverage for a pair contrast; unmapped options remain eligible and unavailable.');
    if (new Set(request.options.map(option=>option.entityId)).size !== request.options.length) throw new StopWork('unavailable','Multiple eligible catalog entries share one confirmed Qloo entity; fixed-catalog ranking is ambiguous.');
    for (const profileId of ['a','b'] as const) {
      const rank = rankRequest(snapshot,profileId);
      const evidence = await call(`rank:full:${profileId}`,'qloo',rank,context=>qloo.rank(rank,context));
      RankingEvidenceSchema.parse(evidence.data);
      await store.advance(snapshot.job,{state:'ranking',evidenceIds:[evidence.id]}); await reload();
    }
    const a = evidenceFor(snapshot,'rank:full:a'); const b = evidenceFor(snapshot,'rank:full:b');
    if (!a || !b) throw new StopWork('unavailable','Both accepted full-profile rankings are required; unavailable evidence cannot support a contrast.');
    const facts = computeDiscoveryFacts(snapshot.job.id,[a.id,b.id],RankingEvidenceSchema.parse(a.data),RankingEvidenceSchema.parse(b.data));
    const id = discoveryAttemptId(snapshot.job.id,'facts',0);
    await store.database.transaction(async client => {
      await store.putEvidence(snapshot.job,id,null,facts,client);
      await store.advance(snapshot.job,{state:'selecting',checkpoint:2,evidenceIds:[id]},client);
    });
    await reload();
  }
  const facts = ComputedDiscoveryFactsSchema.parse(snapshot.evidence.find(evidence=>evidence.data.kind==='facts')?.data);
  if (facts.unsupportedReason) throw new StopWork('unavailable','Provider status does not support software-computed order contrasts. Coverage remains recorded.');
  if (!facts.contrasts.length) throw new StopWork('no_useful_contrast','No supported order reversal was observed among jointly covered fixed-catalog options. Missing coverage is not negative preference.');
  if (snapshot.job.checkpoint==='ranks') {
    const evidence = await call('select','model',facts,async context=>validateModelContrastDecision(await decision.select(facts,context),facts));
    await store.advance(snapshot.job,{state:'running_target',checkpoint:3,evidenceIds:[evidence.id]}); await reload();
  }
  const selection = evidenceFor(snapshot,'select');
  const selected = validateModelContrastDecision(selection?.data,facts).selectedContrastId;
  if (selected===null) throw new StopWork('no_useful_contrast','Nova Micro selected no useful supported contrast; no target finding was invented.');
  const contrast = selectedPair(facts,selected);
  if (snapshot.job.checkpoint==='selection') {
    const count = Math.min(snapshot.job.input.request.repeatCount,Math.floor((snapshot.job.input.request.budgets.targetAttempts-snapshot.job.counters.targetAttempts)/2));
    if (count<1) throw new StopWork('budget_exhausted','The remaining budget cannot reserve a complete paired target run.');
    const targets = Array.from({length:count},(_,repeat)=>['a','b'].map(profile=>syntheticTarget(snapshot.job,profile==='a' ? 'a' : 'b',repeat))).flat();
    await store.schedule(snapshot.job,targets,{state:'waiting_runner',checkpoint:4,release:true,delaySeconds:15,
      reason:'Paired explicit synthetic attempts are queued for the authorised local runner.'}); return;
  }
  const full = snapshot.targets.filter(target=>target.variant==='full');
  if (full.some(target=>target.status!=='completed')) {
    if (full.some(target=>target.status!=='completed' && !target.claimable)) { await saveFinding(store,snapshot,facts,selected,['Runner recovery cannot dispatch within the remaining reservation budget.']); return; }
    throw new StopWork('waiting_runner','Waiting for the authorised runner; queued or leased work is not a target result.',15);
  }
  if (snapshot.job.checkpoint==='targets' && snapshot.job.input.request.reducePair) {
    const budget = snapshot.job.input.request.budgets;
    const existingReduced = ['a','b'].filter(profile=>evidenceFor(snapshot,`rank:reduced:${profile}`)).length;
    if (snapshot.job.counters.qlooAttempts+2-existingReduced>budget.qlooAttempts || snapshot.job.counters.targetAttempts+2>budget.targetAttempts || budget.rounds<2) {
      await saveFinding(store,snapshot,facts,selected,['The requested two-place follow-up was not dispatched because the remaining Qloo, target or round budget cannot cover a paired investigation.']); return;
    }
    if (snapshot.job.state!=='investigating') {
      await store.advance(snapshot.job,{state:'investigating',round:snapshot.job.counters.rounds<2}); await reload();
    }
    for (const profileId of ['a','b'] as const) {
      const rank = rankRequest(snapshot,profileId,contrast.entryIds);
      const evidence = await call(`rank:reduced:${profileId}`,'qloo',rank,context=>qloo.rank(rank,context));
      await store.advance(snapshot.job,{state:'investigating',evidenceIds:[evidence.id]}); await reload();
      const observed = RankingEvidenceSchema.parse(evidence.data);
      if (!['ok','partial'].includes(observed.providerStatus) || canonicalJson(observed.orderedEntryIds)!==canonicalJson(contrast.orders[profileId])) {
        await saveFinding(store,snapshot,facts,selected,['The same observed two-place pair did not retain both full-profile orders with supported coverage in the reduced Qloo follow-up. No reduced target contrast is inferred.']); return;
      }
    }
    await store.schedule(snapshot.job,['a','b'].map(profile=>syntheticTarget(snapshot.job,profile==='a'?'a':'b',0,contrast.entryIds)),{
      state:'waiting_runner',checkpoint:5,release:true,delaySeconds:15,
      reason:'The same observed pair was retained by the reduced Qloo follow-up. Target questions retain all practical constraints and eligible options.',
    }); return;
  }
  const reduced = snapshot.targets.filter(target=>target.variant==='reduced_pair');
  if (reduced.some(target=>target.status!=='completed')) {
    if (reduced.some(target=>target.status!=='completed' && !target.claimable)) { await saveFinding(store,snapshot,facts,selected,['Reduced target dispatch cannot resume within budget.']); return; }
    throw new StopWork('waiting_runner','Waiting for the authorised runner to finish the same-pair follow-up.',15);
  }
  await saveFinding(store,snapshot,facts,selected);
}

/** One atomically claimed job. Safe to embed in the persistent API process or a separate worker entry point. */
export async function runDiscoveryOnce(store: DiscoveryStore, adapters: WorkerAdapters, options: WorkerOptions = {}, parentSignal?: AbortSignal): Promise<boolean> {
  if (parentSignal?.aborted) return false;
  const snapshot = await store.claim(options.leaseSeconds ?? 60,options.projectId ?? null);
  if (!snapshot) return false;
  const controller = new AbortController(); const qloo = adapters.qloo();
  const signal = parentSignal ? AbortSignal.any([controller.signal,parentSignal]) : controller.signal;
  const deadline = setTimeout(()=>controller.abort(),Math.max(0,Date.parse(snapshot.job.deadlineAt)-Date.now()));
  let stopped = false;
  const heartbeat = (async () => {
    try {
      while (!stopped && !signal.aborted) {
        await sleep(options.heartbeatMilliseconds ?? 1000,undefined,{signal});
        if (!stopped) await store.renew(snapshot.job,options.leaseSeconds ?? 60);
      }
    } catch { if (!stopped) controller.abort(); }
  })();
  try {
    signal.throwIfAborted();
    if (Date.parse(snapshot.job.deadlineAt)<=Date.now()) throw new StopWork('deadline_exceeded','The pinned discovery deadline has elapsed.');
    await execute(store,snapshot,qloo,adapters.decision,signal,options);
  } catch (error) {
    const current = await store.load(snapshot.job.projectId,snapshot.job.id);
    const job = current.job;
    if (!terminal.has(job.state) && job.leaseId===snapshot.job.leaseId && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt)>Date.now()) {
      if (Date.parse(job.deadlineAt)<=Date.now()) await store.advance(job,{state:'deadline_exceeded',release:true,reason:'The pinned discovery deadline elapsed; outstanding requests were aborted.'});
      else if (error instanceof StopWork) await store.advance(job,{state:error.state,reason:error.safeReason,delaySeconds:error.delaySeconds,release:true});
      else if (error instanceof UnknownDispatch || signal.aborted) await store.advance(job,{state:job.state,release:true,delaySeconds:30,
        reason:'Worker interruption or unknown provider dispatch outcome. The reserved attempt remains charged and will be marked interrupted or uncertain on recovery.'});
      else await store.advance(job,{state:'failed',release:true,reason:'Worker invariant or persistence validation failed. No taste assertion was made.'});
    }
    // A lost/terminal lease is not ours to mutate. Do not log exception objects or private payloads.
  } finally {
    stopped = true; controller.abort(); clearTimeout(deadline); await heartbeat; await qloo.close();
  }
  return true;
}

export async function runDiscoveryLoop(store: DiscoveryStore, adapters: WorkerAdapters, signal: AbortSignal, options: WorkerOptions = {}) {
  while (!signal.aborted) {
    const worked = await runDiscoveryOnce(store,adapters,options,signal);
    if (!worked) {
      try { await sleep(options.pollMilliseconds ?? 1000,undefined,{signal}); } catch { if (!signal.aborted) throw new Error('Discovery polling interrupted'); }
    }
  }
}
