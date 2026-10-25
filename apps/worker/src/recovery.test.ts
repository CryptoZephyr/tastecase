import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { z } from 'zod';
import {
  checksum, CreateDiscoveryJobRequestSchema, CreateCatalogVersionRequestSchema,
  CreateTaskVersionRequestSchema, PinnedDiscoveryInputSchema, RankingEvidenceSchema,
  DiscoveryCandidateSchema, type DiscoveryJob, type ComputedDiscoveryFacts,
} from '@tastecase/contracts';
import { DiscoveryStore, PoolDatabase, type WorkerDatabase, type Queryable } from './store.js';
import { runDiscoveryOnce } from './engine.js';
import { parseSelection } from './decision.js';
import { syntheticTarget } from './synthetic.js';
import type { QlooAdapter, RankRequest, ProviderContext, Snapshot } from './types.js';

// Never allow the integration tests to bootstrap or mutate a hosted database.
const connectionString=process.env.WORKER_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55432/tastecase_test';
const url=new URL(connectionString);
if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname!=='/tastecase_test') throw new Error('Worker tests require the designated loopback test DB');

interface FixtureOptions { mapped?: number; unmapped?: boolean; unconfirmed?: boolean; reduce?: boolean; ageSeconds?: number; budgets?: Record<string,number> }
async function fixture(options: FixtureOptions={}) {
  const client=new pg.Client({connectionString}); await client.connect(); await client.query('BEGIN');
  const project=randomUUID(); const owner=randomUUID(); const catalogId=randomUUID(); const taskId=randomUUID(); const jobId=randomUUID(); const credential=randomUUID();
  const createdAt=new Date(Date.now()-(options.ageSeconds??0)*1000).toISOString();
  const entryIds=Array.from({length:options.mapped??2},(_,index)=>`entry-${index}`);
  const entries=[...entryIds,...(options.unmapped?['unmapped']:[])];
  const mappings=entryIds.map(catalogEntryId=>({schema_version:'1.0.0' as const,id:randomUUID(),projectId:project,catalogVersionId:catalogId,catalogEntryId,qlooEntityId:randomUUID(),confirmedBy:owner,createdAt}));
  const catalog=CreateCatalogVersionRequestSchema.parse({schema_version:'1.0.0',id:catalogId,label:'Synthetic worker recovery fixture',entries:entries.map(id=>({id,name:`Synthetic ${id}`,
    // A candidate hint is intentionally not a confirmation for the unmapped entry.
    ...(id==='unmapped'?{qlooEntityId:randomUUID()}:{}),
  }))});
  const task=CreateTaskVersionRequestSchema.parse({schema_version:'1.0.0',id:taskId,label:'Synthetic fixed-constraint dining task',catalogVersionId:catalogId,
    syntheticBrief:{provenance:'synthetic',label:'Fictional dinner',text:'Explicitly fictional dinner for two.'},syntheticInterests:[],
    constraints:{partySize:2,location:{city:'Synthetic city'},budgetPerPerson:{currency:'USD',amountMinor:5000},dietaryRequirements:['vegetarian'],accessibilityRequirements:['step-free'],requiredCuisines:[],excludedEntryIds:[]},
  });
  const request=CreateDiscoveryJobRequestSchema.parse({schema_version:'1.0.0',id:jobId,catalogVersionId:catalogId,taskVersionId:taskId,
    mappingConfirmationIds:mappings.map(mapping=>mapping.id),eligibleCatalogEntryIds:entries,assistantVersion:'synthetic-fixture-v1',reducePair:options.reduce??true,budgets:options.budgets??{},profiles:[
      {id:'a',label:'Synthetic A',provenance:'public_synthetic',anchors:[{id:randomUUID(),label:'Synthetic public music',kind:'music',confirmedEntityId:randomUUID()}]},
      {id:'b',label:'Synthetic B',provenance:'public_synthetic',anchors:[{id:randomUUID(),label:'Synthetic public film',kind:'film',...(options.unconfirmed?{}:{confirmedEntityId:randomUUID()})}]},
    ]});
  const input=PinnedDiscoveryInputSchema.parse({schema_version:'1.0.0',request,targetInput:{schema_version:'1.0.0',projectId:project,
    catalog:{...catalog,projectId:project,checksum:checksum(catalog),createdAt},task:{...task,projectId:project,checksum:checksum(task),createdAt},mappings,eligibleCatalogEntryIds:entries,
  }});
  try {
    // Migrations must already have been applied locally by the parent. No bootstrap here.
    await client.query('SELECT 1 FROM public.discovery_jobs LIMIT 0');
    await client.query('INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,$3)',[project,owner,'Synthetic worker integration fixture']);
    await client.query('INSERT INTO public.catalog_versions(id,project_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5)',[catalogId,project,JSON.stringify(catalog),checksum(catalog),createdAt]);
    await client.query('INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)',[taskId,project,catalogId,JSON.stringify(task),checksum(task),createdAt]);
    for (const mapping of mappings) await client.query('INSERT INTO public.mapping_confirmations(id,project_id,catalog_version_id,catalog_entry_id,qloo_entity_id,confirmed_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[mapping.id,project,catalogId,mapping.catalogEntryId,mapping.qlooEntityId,owner,createdAt]);
    await client.query('INSERT INTO public.runner_credentials(id,project_id,label,token_hash) VALUES($1,$2,$3,$4)',[credential,project,'Synthetic worker runner',checksum(randomUUID())]);
    await client.query('SET LOCAL ROLE service_role');
    await client.query(`INSERT INTO public.discovery_jobs(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at,deadline_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+$8*interval '1 second')`,[jobId,project,catalogId,taskId,JSON.stringify(input),checksum(input),createdAt,request.budgets.deadlineSeconds]);
  } catch (error) { await client.query('ROLLBACK'); await client.end(); throw error; }
  let serial=0;
  const database:WorkerDatabase={
    query:(sql,params)=>client.query<Record<string,unknown>>(sql,params),
    async transaction<T>(work:(db:Queryable)=>Promise<T>) {
      const name=`worker_${serial++}`; await client.query(`SAVEPOINT ${name}`);
      try {const result=await work(database);await client.query(`RELEASE SAVEPOINT ${name}`);return result;}
      catch(error){await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`);throw error;}
    },
  };
  const store=new DiscoveryStore(database);
  const snapshot=()=>store.load(project,jobId);
  const ready=async()=>{
    await client.query('RESET ROLE');
    await client.query('UPDATE public.discovery_job_state SET available_at=clock_timestamp(),revision=revision+1 WHERE project_id=$1 AND job_id=$2',[project,jobId]);
    await client.query('SET LOCAL ROLE service_role');
  };
  const completeTargets=async()=>{
    await client.query('RESET ROLE');
    const targets=(await client.query<{attempt_id:string;profile_id:string}>(`SELECT a.attempt_id,a.profile_id FROM public.discovery_job_targets a JOIN public.target_attempts t ON t.id=a.attempt_id
      WHERE a.project_id=$1 AND a.job_id=$2 AND t.status<>'completed'`,[project,jobId])).rows;
    for (const target of targets) {
      const lease=randomUUID();
      await client.query("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",[target.attempt_id,lease,credential]);
      const result={schema_version:'1.0.0',outcome:'success',output:{recommendations:[{catalogEntryId:entryIds[0],name:'Synthetic choice'}]},trace:{completeness:'partial',events:[]}};
      await client.query("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1",[target.attempt_id,JSON.stringify(result),checksum(result)]);
    }
    await client.query('SET LOCAL ROLE service_role'); await ready();
  };
  return {client,project,owner,jobId,input,store,snapshot,ready,completeTargets,
    close:async()=>{await client.query('ROLLBACK');await client.end();}};
}

function syntheticAdapters(config: { sameOrder?:boolean; omit?:boolean; weakAffinityGaps?:boolean; rank?: (request:RankRequest,context:ProviderContext)=>Promise<void>; error?:'auth'|'transient'; hallucinate?:boolean }={}) {
  const calls:RankRequest[]=[]; let resolves=0; let decisions=0; let closes=0;
  const qloo:QlooAdapter={
    async resolve(anchor) { resolves++; return {kind:'resolve',anchorId:anchor.id,providerStatus:'needs_input',candidates:[
      {entityId:randomUUID(),name:'Synthetic observed choice one',kind:anchor.kind},{entityId:randomUUID(),name:'Synthetic observed choice two',kind:anchor.kind},
    ]}; },
    async rank(request,context) {
      calls.push(request); await config.rank?.(request,context);
      let ordered=request.options.map(option=>option.entryId);
      if (!config.sameOrder && request.profileId==='b') ordered.reverse();
      if (config.omit) ordered=ordered.slice(0,1);
      return RankingEvidenceSchema.parse({kind:'rank',providerStatus:config.error?'error':'ok',profileId:request.profileId,scope:request.scope,
        requestedEntryIds:request.options.map(option=>option.entryId),orderedEntryIds:config.error?[]:ordered,
        missingEntryIds:request.options.filter(option=>config.error || !ordered.includes(option.entryId)).map(option=>option.entryId),unmappedEntryIds:request.unmappedEntryIds,
        mappingConfirmationIds:request.options.map(option=>option.confirmationId),anchorConfirmationIds:request.anchors.map(anchor=>anchor.confirmationId),
        ...(config.weakAffinityGaps?{affinities:request.options.map(option=>({entryId:option.entryId,
          affinity:request.profileId==='a'?(option.entryId==='entry-0'?0.77:0.7695):(option.entryId==='entry-0'?0.69:0.6899),interests:[]}))}:{}),
        ...(config.error?{error:{code:config.error==='auth'?'QLOO_AUTH':'QLOO_RATE_LIMIT',category:config.error,retryable:config.error==='transient'}}:{}),
      });
    },
    async close(){closes++;},
  };
  const adapters={qloo:()=>qloo,decision:{async select(facts:ComputedDiscoveryFacts){decisions++;return parseSelection({selectedContrastId:config.hallucinate?randomUUID():facts.contrasts[0]?.id??null},facts);}}};
  return {adapters,calls,get resolves(){return resolves;},get decisions(){return decisions;},get closes(){return closes;}};
}
const fullRequest=(snapshot:Snapshot,profileId:'a'|'b'):RankRequest=>({profileId,scope:'full',
  options:snapshot.job.input.targetInput.mappings.map(mapping=>({entryId:mapping.catalogEntryId,entityId:mapping.qlooEntityId,confirmationId:mapping.id})),
  anchors:snapshot.job.input.request.profiles.filter(profile=>profile.id===profileId).flatMap(profile=>profile.anchors).map(anchor=>{
    const confirmation=snapshot.confirmations.find(value=>value.anchorId===anchor.id);assert.ok(confirmation);
    return {entityId:confirmation.entityId,confirmationId:confirmation.id};
  }),unmappedEntryIds:[],
});

function captureStderr() {
  const original=console.error;const lines:string[]=[];
  console.error=(...values:unknown[])=>{lines.push(values.map(String).join(' '));};
  return {lines,restore:()=>{console.error=original;}};
}

test('local PostgreSQL: repeats, restart checkpoints, safe same-pair reduction and immutable reopening',async()=>{
  const f=await fixture(); const fake=syntheticAdapters();
  try {
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});
    let saved=await f.snapshot(); assert.equal(saved.job.state,'waiting_runner'); assert.equal(saved.targets.length,4);
    assert.deepEqual(saved.job.counters,{qlooAttempts:2,modelDecisions:1,targetAttempts:4,rounds:1});
    const ids=saved.targets.map(target=>target.attemptId).sort();
    await f.ready(); await runDiscoveryOnce(new DiscoveryStore(f.store.database),fake.adapters,{projectId:f.project});
    saved=await f.snapshot(); assert.deepEqual(saved.targets.map(target=>target.attemptId).sort(),ids); assert.equal(fake.calls.length,2);
    assert.equal(fake.decisions,1); assert.equal(saved.job.state,'waiting_runner');
    await f.completeTargets(); await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});
    saved=await f.snapshot(); assert.equal(saved.targets.length,6); assert.equal(saved.job.checkpoint,'investigation'); assert.equal(fake.calls.length,4);
    const pair=saved.evidence.find(evidence=>evidence.data.kind==='facts')?.data;
    assert.equal(pair?.kind,'facts');
    for (const request of fake.calls.filter(request=>request.scope==='reduced_pair')) assert.deepEqual(request.options.map(option=>option.entryId),['entry-0','entry-1']);
    const inputs=(await f.client.query<{pinned_input:typeof f.input.targetInput}>('SELECT t.pinned_input FROM public.target_attempts t JOIN public.discovery_job_targets d ON d.attempt_id=t.id WHERE d.project_id=$1',[f.project])).rows;
    for (const row of inputs) {
      assert.deepEqual(row.pinned_input.task.constraints,f.input.targetInput.task.constraints);
      assert.deepEqual(row.pinned_input.eligibleCatalogEntryIds,f.input.targetInput.eligibleCatalogEntryIds);
      assert.deepEqual(row.pinned_input.catalog,f.input.targetInput.catalog);
      assert.equal(row.pinned_input.task.syntheticBrief.provenance,'synthetic');
    }
    assert.equal(syntheticTarget(saved.job,'a',0).attemptId,saved.targets.find(target=>target.profileId==='a' && target.repeat===0 && target.variant==='full')?.attemptId);
    await f.completeTargets(); await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});
    saved=await new DiscoveryStore(f.store.database).load(f.project,f.jobId); assert.equal(saved.job.state,'awaiting_review'); assert.equal(saved.job.checkpoint,'saved');
    const row=(await f.client.query<{id:string;content:unknown;checksum:string;created_at:Date}>('SELECT id,content,checksum,created_at FROM public.discovery_candidates WHERE project_id=$1 AND job_id=$2',[f.project,f.jobId])).rows[0];assert.ok(row);
    const candidate=DiscoveryCandidateSchema.parse({schema_version:'1.0.0',id:row.id,projectId:f.project,jobId:f.jobId,content:row.content,checksum:row.checksum,createdAt:row.created_at.toISOString()});
    assert.equal(candidate.content.targetAttemptIds.length,6); assert.equal(candidate.content.proposedExpectation.automaticFailure,false);
    assert.ok(candidate.content.limitations.some(value=>value.includes('cannot prove missing tool calls')));
    assert.ok(candidate.content.limitations.some(value=>value.includes('identical')));
    assert.equal(await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project}),false);
  } finally {await f.close();}
});

test('no useful reversal and coverage omissions never become a taste failure or model-only contrast',async()=>{
  for (const config of [{sameOrder:true},{omit:true}]) {
    const f=await fixture({unmapped:true});const fake=syntheticAdapters(config);
    try {
      await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project}); const saved=await f.snapshot();
      assert.equal(saved.job.state,'no_useful_contrast'); assert.equal(fake.decisions,0);assert.equal(saved.targets.length,0);
      const facts=saved.evidence.find(evidence=>evidence.data.kind==='facts')?.data;assert.equal(facts?.kind,'facts');
      if (facts?.kind==='facts') assert.deepEqual(facts.unmappedEntryIds,['unmapped']);
      assert.ok(fake.calls.every(request=>!request.options.some(option=>option.entryId==='unmapped')));
    } finally {await f.close();}
  }
});

test('weak affinity reversals stop with the specific no-useful-contrast reason',async()=>{
  const f=await fixture();const fake=syntheticAdapters({weakAffinityGaps:true});
  const reason='No supported order reversal was observed among jointly covered fixed-catalog options after skipping reversals whose Qloo affinity gaps were under 0.01 for both profiles. Missing coverage is not negative preference.';
  try {
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project}); const saved=await f.snapshot();
    assert.equal(saved.job.state,'no_useful_contrast');assert.equal(saved.job.reason,reason);assert.ok(reason.length<=2000);
    assert.equal(fake.decisions,0);assert.equal(saved.targets.length,0);assert.equal(fake.calls.length,2);
    const facts=saved.evidence.find(evidence=>evidence.data.kind==='facts')?.data;
    assert.equal(facts?.kind,'facts');if (facts?.kind==='facts') assert.equal(facts.contrasts.length,0);
  } finally {await f.close();}
});

test('ambiguous public anchors require observed owner confirmation before ranking',async()=>{
  const f=await fixture({unconfirmed:true});const fake=syntheticAdapters();
  try {
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});let saved=await f.snapshot();assert.equal(saved.job.state,'needs_confirmation');assert.equal(fake.calls.length,0);
    const row=(await f.client.query<{id:string;anchor_id:string;candidates:{entityId:string}[]}>('SELECT id,anchor_id,candidates FROM public.discovery_anchor_resolutions WHERE project_id=$1 AND job_id=$2',[f.project,f.jobId])).rows[0];assert.ok(row);
    const entity=row.candidates[1]?.entityId;assert.ok(entity);
    await f.client.query('SELECT public.confirm_discovery_anchor($1,$2,$3,$4,$5,$6,$7)',[f.project,f.jobId,f.owner,randomUUID(),row.anchor_id,row.id,entity]);
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});saved=await f.snapshot();assert.equal(saved.job.state,'waiting_runner');assert.equal(fake.resolves,1);assert.equal(fake.calls.length,2);
    assert.ok(fake.calls.find(request=>request.profileId==='b')?.anchors.some(anchor=>anchor.entityId===entity));
  } finally {await f.close();}
});

test('more than ten mapped options is explicitly unsupported, not truncation or batched score merging',async()=>{
  const f=await fixture({mapped:11});const fake=syntheticAdapters();
  try {await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});const saved=await f.snapshot();assert.equal(saved.job.state,'unavailable');assert.match(saved.job.reason??'',/more than ten/);assert.equal(fake.calls.length,0);}
  finally {await f.close();}
});

test('model hallucinated contrast IDs are rejected and never schedule targets',async()=>{
  const f=await fixture();const fake=syntheticAdapters({hallucinate:true});
  try {await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});const saved=await f.snapshot();assert.equal(saved.job.state,'unavailable');assert.equal(saved.targets.length,0);assert.equal(saved.providerAttempts.find(attempt=>attempt.kind==='model')?.errorCode,'PROVIDER_INVALID_DATA');}
  finally {await f.close();}
});

test('provider Zod failures log only paths and codes',async()=>{
  const f=await fixture();const providerValue='SECRET-PROVIDER-VALUE-123';
  const fake=syntheticAdapters({rank:async()=>{
    z.object({providerField:z.number()}).parse({providerField:providerValue});
  }});
  const stderr=captureStderr();
  try {
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});
    assert.equal(stderr.lines.length,1);
    const event=JSON.parse(stderr.lines[0]!) as Record<string,unknown>;
    assert.equal(event.event,'discovery_provider_invalid_data');assert.equal(event.jobId,f.jobId);
    assert.equal(event.operationKey,'rank:full:a');assert.equal(event.kind,'qloo');assert.equal(event.errorClass,'ZodError');
    assert.deepEqual(event.detail,[{path:'providerField',code:'invalid_type'}]);
    assert.equal(stderr.lines[0]!.includes(providerValue),false);
    const saved=await f.snapshot();assert.equal(saved.job.state,'unavailable');
    assert.equal(saved.providerAttempts[0]?.errorCode,'PROVIDER_INVALID_DATA');
  } finally {stderr.restore();await f.close();}
});

test('provider SyntaxErrors log a null detail',async()=>{
  const f=await fixture();const fake=syntheticAdapters({rank:async()=>{throw new SyntaxError('Unexpected token in provider data');}});
  const stderr=captureStderr();
  try {
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});
    assert.equal(stderr.lines.length,1);
    const event=JSON.parse(stderr.lines[0]!) as Record<string,unknown>;
    assert.equal(event.operationKey,'rank:full:a');assert.equal(event.errorClass,'SyntaxError');assert.equal(event.detail,null);
  } finally {stderr.restore();await f.close();}
});

test('provider TypeError messages redact configured secrets and log cause classes only',async()=>{
  const f=await fixture();const secret='configured-provider-secret-123';
  const previous=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY=secret;
  const fake=syntheticAdapters({rank:async()=>{
    throw new TypeError(`Provider failure: ${secret}`,{cause:new Error(`Cause contained ${secret}`)});
  }});
  const stderr=captureStderr();
  try {
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});
    assert.equal(stderr.lines.length,1);
    const event=JSON.parse(stderr.lines[0]!) as Record<string,unknown>;
    assert.equal(event.operationKey,'rank:full:a');assert.equal(event.errorClass,'TypeError');
    assert.equal(event.detail,'Provider failure: [REDACTED]');assert.deepEqual(event.causeClasses,['Error']);
    assert.equal(stderr.lines[0]!.includes(secret),false);
  } finally {
    stderr.restore();
    if(previous===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=previous;
    await f.close();
  }
});

test('flagged transient backoff persists across worker restart; auth never retries',async()=>{
  for (const error of ['auth','transient'] as const) {
    const f=await fixture();const fake=syntheticAdapters({error});
    try {
      await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});const saved=await f.snapshot();
      assert.equal(fake.calls.length,1);assert.equal(saved.job.counters.qlooAttempts,1);
      assert.equal(saved.providerAttempts[0]?.errorCategory,error);
      assert.equal(saved.job.state,error==='auth'?'unavailable':'ranking');
      if (error==='transient') {assert.ok(Date.parse(saved.job.availableAt)>Date.now());assert.ok(saved.providerAttempts[0]?.nextDispatchAt);}
      assert.equal(await runDiscoveryOnce(new DiscoveryStore(f.store.database),fake.adapters,{projectId:f.project}),false);assert.equal(fake.calls.length,1);
    } finally {await f.close();}
  }
});

test('a bounded Qloo 429 receipt survives database reopening and never schedules an automatic retry',async()=>{
  const f=await fixture();const fake=syntheticAdapters({error:'transient'});
  const qloo=fake.adapters.qloo();const original=qloo.rank.bind(qloo);
  qloo.rank=async(request,context)=>({...await original(request,context),
    error:{code:'QLOO_RATE_LIMIT',category:'transient',retryable:false},
    http:{maxAttempts:2,attempts:1,cacheHits:0,requests:[{endpoint:'/entities',status:429,retryAfterSeconds:600}]},
  });
  try {
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});
    const reopened=new DiscoveryStore(f.store.database);const saved=await reopened.load(f.project,f.jobId);
    assert.equal(saved.job.state,'unavailable');assert.equal(saved.job.counters.qlooAttempts,1);
    const evidence=saved.evidence.find(value=>value.data.kind==='rank');assert.ok(evidence);
    assert.equal(evidence.checksum,checksum(evidence.data));
    assert.equal(evidence.data.kind==='rank' && evidence.data.http?.requests[0]?.retryAfterSeconds,600);
    assert.equal(saved.providerAttempts[0]?.retryable,false);assert.equal(saved.providerAttempts[0]?.nextDispatchAt,null);
    assert.equal(await runDiscoveryOnce(reopened,fake.adapters,{projectId:f.project}),false);
    assert.equal(fake.calls.length,1);assert.equal(fake.decisions,0);assert.equal(saved.targets.length,0);
  } finally {await f.close();}
});

test('eligible transient retry after persisted backoff consumes remaining budget across restart',async()=>{
  const f=await fixture({budgets:{qlooAttempts:2}});const fake=syntheticAdapters();
  try {
    const claimed=await f.store.claim(60,f.project);assert.ok(claimed);
    await f.store.advance(claimed.job,{state:'ranking',checkpoint:1,round:true});
    const request=fullRequest(claimed,'a');const id=await f.store.reserve(claimed.job,'rank:full:a','qloo',0,request,false);
    await f.store.dispatch(claimed.job,id);
    await f.store.complete(claimed.job,id,RankingEvidenceSchema.parse({kind:'rank',providerStatus:'error',profileId:'a',scope:'full',
      requestedEntryIds:request.options.map(option=>option.entryId),orderedEntryIds:[],missingEntryIds:request.options.map(option=>option.entryId),
      unmappedEntryIds:[],mappingConfirmationIds:request.options.map(option=>option.confirmationId),anchorConfirmationIds:request.anchors.map(anchor=>anchor.confirmationId),
      error:{code:'QLOO_RATE_LIMIT',category:'transient',retryable:true},
    }),1);
    await f.store.advance(claimed.job,{state:'ranking',checkpoint:1,release:true});
    assert.equal(await runDiscoveryOnce(new DiscoveryStore(f.store.database),fake.adapters,{projectId:f.project}),false);
    await f.client.query('SELECT pg_sleep(1.1)');
    await runDiscoveryOnce(new DiscoveryStore(f.store.database),fake.adapters,{projectId:f.project});
    const saved=await f.snapshot();assert.equal(saved.job.state,'budget_exhausted');assert.equal(saved.job.counters.qlooAttempts,2);
    assert.equal(fake.calls.length,1);assert.equal(saved.targets.length,0);
    assert.deepEqual(saved.providerAttempts.map(attempt=>[attempt.operationKey,attempt.tryNumber,attempt.status]),[['rank:full:a',0,'error'],['rank:full:a',1,'accepted']]);
    assert.equal(await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project}),false);
  } finally {await f.close();}
});

test('releasing or terminating a lease labels undispatched and unknown calls without refunds',async()=>{
  for (const stop of ['release','cancel','deadline'] as const) {
    const f=await fixture();
    try {
      const claimed=await f.store.claim(60,f.project);assert.ok(claimed);
      const reserved=await f.store.reserve(claimed.job,'synthetic-reserved','qloo',0,{synthetic:true},false);
      const dispatched=await f.store.reserve(claimed.job,'synthetic-dispatched','qloo',0,{synthetic:true},false);await f.store.dispatch(claimed.job,dispatched);
      if (stop==='cancel') await f.client.query('SELECT public.cancel_discovery_job($1,$2)',[f.project,f.jobId]);
      else await f.store.advance(claimed.job,{state:stop==='deadline'?'deadline_exceeded':'ranking',release:true});
      const saved=await f.snapshot();assert.equal(saved.job.counters.qlooAttempts,2);
      assert.equal(saved.providerAttempts.find(attempt=>attempt.id===reserved)?.status,'interrupted');
      assert.equal(saved.providerAttempts.find(attempt=>attempt.id===dispatched)?.status,'uncertain');
      assert.ok(saved.providerAttempts.every(attempt=>attempt.finishedAt!==null));
      await assert.rejects(f.store.complete(claimed.job,dispatched,{kind:'resolve',providerStatus:'empty',anchorId:f.input.request.profiles[0].anchors[0].id,candidates:[]}));
    } finally {await f.close();}
  }
});

test('real expired lease recovery resumes accepted rank and charges a visible opt-in unknown retry slot',async()=>{
  const f=await fixture();const fake=syntheticAdapters();
  try {
    const claim=await f.store.claim(60,f.project);assert.ok(claim);
    await f.store.advance(claim.job,{state:'ranking',checkpoint:1,round:true});
    const a=fullRequest(claim,'a');const b=fullRequest(claim,'b');
    const aId=await f.store.reserve(claim.job,'rank:full:a','qloo',0,a,false);await f.store.dispatch(claim.job,aId);
    const aEvidence=await f.store.complete(claim.job,aId,await fake.adapters.qloo().rank(a,{signal:new AbortController().signal,outputBytes:64000}));
    await f.store.advance(claim.job,{state:'ranking',checkpoint:1,evidenceIds:[aEvidence]});
    const bId=await f.store.reserve(claim.job,'rank:full:b','qloo',0,b,false);await f.store.dispatch(claim.job,bId);
    await f.store.renew(claim.job,1);await f.client.query('SELECT pg_sleep(1.1)');
    await runDiscoveryOnce(new DiscoveryStore(f.store.database),fake.adapters,{projectId:f.project,retryUncertain:true});
    const saved=await f.snapshot();assert.equal(saved.job.state,'waiting_runner');assert.equal(saved.job.counters.qlooAttempts,3);assert.equal(fake.calls.length,2);
    assert.equal(saved.providerAttempts.find(attempt=>attempt.id===bId)?.status,'uncertain');
    assert.equal(saved.providerAttempts.filter(attempt=>attempt.operationKey==='rank:full:a').length,1);
    assert.equal(saved.providerAttempts.find(attempt=>attempt.operationKey==='rank:full:b'&&attempt.tryNumber===1)?.status,'accepted');
    await assert.rejects(f.store.renew(claim.job),error=>error instanceof Error && 'code' in error && error.code==='40001');
  } finally {await f.close();}
});

test('unknown dispatch recovery is visible and not automatically repeated by default',async()=>{
  const f=await fixture();const fake=syntheticAdapters();
  try {
    const claim=await f.store.claim(60,f.project);assert.ok(claim);await f.store.advance(claim.job,{state:'ranking',checkpoint:1,round:true});
    const request=fullRequest(claim,'a');const id=await f.store.reserve(claim.job,'rank:full:a','qloo',0,request,false);await f.store.dispatch(claim.job,id);
    await f.store.renew(claim.job,1);await f.client.query('SELECT pg_sleep(1.1)');
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});const saved=await f.snapshot();assert.equal(saved.job.state,'unavailable');assert.equal(fake.calls.length,0);assert.equal(saved.providerAttempts[0]?.status,'uncertain');assert.equal(saved.job.counters.qlooAttempts,1);
  } finally {await f.close();}
});

test('budget-limited repeats stay paired and save a partial immutable candidate',async()=>{
  const f=await fixture({budgets:{targetAttempts:2}});const fake=syntheticAdapters();
  try {
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});let saved=await f.snapshot();assert.equal(saved.targets.length,2);assert.deepEqual(saved.targets.map(target=>target.profileId).sort(),['a','b']);
    await f.completeTargets();await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});saved=await f.snapshot();assert.equal(saved.job.state,'partial');assert.equal(saved.job.counters.targetAttempts,2);
    const row=(await f.client.query<{content:{limitations:string[]}}>('SELECT content FROM public.discovery_candidates WHERE project_id=$1 AND job_id=$2',[f.project,f.jobId])).rows[0];assert.ok(row?.content.limitations.some(value=>value.includes('2 of 4')));
  } finally {await f.close();}
});

test('cancellation aborts in-flight request, closes adapter and schedules no new work',async()=>{
  const f=await fixture();let observedAbort=false;
  const fake=syntheticAdapters({rank:async(_request,context)=>{
    await f.client.query('SELECT public.cancel_discovery_job($1,$2)',[f.project,f.jobId]);
    await new Promise<void>((_resolve,reject)=>context.signal.addEventListener('abort',()=>{observedAbort=true;reject(new Error('Synthetic aborted dispatch'));},{once:true}));
  }});
  try {
    await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project,heartbeatMilliseconds:25});const saved=await f.snapshot();assert.equal(saved.job.state,'cancelled');assert.equal(saved.targets.length,0);assert.ok(observedAbort);assert.equal(fake.closes,1);assert.equal(saved.job.counters.qlooAttempts,1);
    assert.equal(saved.providerAttempts[0]?.status,'uncertain');assert.ok(saved.providerAttempts[0]?.finishedAt);
  } finally {await f.close();}
});

test('an already-aborted worker does not claim or reserve a pinned job',async()=>{
  const f=await fixture();const fake=syntheticAdapters();
  try {
    assert.equal(await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project},AbortSignal.abort()),false);
    const saved=await f.snapshot();assert.equal(saved.job.state,'queued');assert.equal(saved.job.leaseId,null);assert.equal(saved.job.counters.qlooAttempts,0);assert.equal(fake.calls.length,0);assert.equal(fake.closes,0);
  } finally {await f.close();}
});

test('elapsed deadline is explicit and prevents external dispatch',async()=>{
  const f=await fixture({budgets:{deadlineSeconds:30},ageSeconds:31});const fake=syntheticAdapters();
  try {await runDiscoveryOnce(f.store,fake.adapters,{projectId:f.project});const saved=await f.snapshot();assert.equal(saved.job.state,'deadline_exceeded');assert.equal(fake.calls.length,0);assert.equal(saved.job.counters.qlooAttempts,0);}
  finally {await f.close();}
});

test('worker scoped load obeys forced RLS and target scheduling rejects cross-project tasks',async()=>{
  const f=await fixture();
  try {
    await f.client.query('SET LOCAL ROLE authenticated');await f.client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[randomUUID()]);
    await assert.rejects(f.snapshot(),/not found/);
    await f.client.query('RESET ROLE');await f.client.query('SET LOCAL ROLE service_role');
    const claim=await f.store.claim(60,f.project);assert.ok(claim);
    const target=syntheticTarget(claim.job,'a',0);
    await assert.rejects(f.store.schedule(claim.job,[{...target,input:{...target.input,projectId:randomUUID()}}],{state:'running_target'}));
    assert.equal((await f.snapshot()).targets.length,0);
  } finally {await f.close();}
});

test('two actual PostgreSQL connections atomically claim/fence and contend on durable budgets',async()=>{
  const f=await fixture({budgets:{qlooAttempts:1}});
  // This isolated, explicitly synthetic concurrency fixture must be visible to two connections.
  await f.client.query('COMMIT');
  const pool=new pg.Pool({connectionString,max:2});const store=new DiscoveryStore(new PoolDatabase(pool));
  let first:DiscoveryJob|undefined;
  try {
    const claims=await Promise.all([store.claim(60,f.project),store.claim(60,f.project)]);const claimed=claims.find(value=>value!==null);assert.ok(claimed);assert.equal(claims.filter(Boolean).length,1);first=claimed.job;
    await store.renew(first,1);await pool.query('SELECT pg_sleep(1.1)');const recovered=await store.claim(60,f.project);assert.ok(recovered);
    await assert.rejects(store.renew(first),error=>error instanceof Error&&'code' in error&&error.code==='40001');
    const reservations=await Promise.allSettled([store.reserve(recovered.job,'synthetic-race-a','qloo',0,{synthetic:true},false),store.reserve(recovered.job,'synthetic-race-b','qloo',0,{synthetic:true},false)]);
    assert.equal(reservations.filter(value=>value.status==='fulfilled').length,1);assert.equal((await store.load(f.project,f.jobId)).job.counters.qlooAttempts,1);
  } finally {
    await pool.query('SELECT public.cancel_discovery_job($1,$2)',[f.project,f.jobId]);await pool.end();await f.client.end();
  }
});
