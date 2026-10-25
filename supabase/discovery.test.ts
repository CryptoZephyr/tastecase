import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { checksum, CreateDiscoveryJobRequestSchema, PinnedDiscoveryInputSchema, discoveryAttemptId } from '@tastecase/contracts';
import { assertLocalTestDatabase, runMigrations } from '../apps/api/src/migrate.js';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55432/tastecase_test';
assertLocalTestDatabase(connectionString);

test('Gate 2 SQL: immutable evidence, isolation, budgets, recovery and cancellation', async t => {
  const client = new pg.Client({ connectionString }); await client.connect();
  let serial = 0;
  async function fails(sql: string, params: unknown[] = [], code = '23514') {
    const savepoint = `discovery_${serial++}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try { await assert.rejects(client.query(sql, params), (e: unknown) => e instanceof Error && 'code' in e && e.code === code); }
    finally { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await client.query(`RELEASE SAVEPOINT ${savepoint}`); }
  }
  const project = randomUUID(); const owner = randomUUID(); const otherProject = randomUUID(); const otherOwner = randomUUID();
  const catalogId = randomUUID(); const taskId = randomUUID(); const job = randomUUID(); const credential = randomUUID();
  const createdAt = new Date().toISOString(); const anchorA = randomUUID(); const anchorB = randomUUID();
  const mappingIds=[randomUUID(),randomUUID()];
  const mappings=['one','two'].map((catalogEntryId,index) => ({ schema_version:'1.0.0',id:mappingIds[index],projectId:project,catalogVersionId:catalogId,catalogEntryId,qlooEntityId:randomUUID(),confirmedBy:owner,createdAt }));
  const catalogPayload = { schema_version: '1.0.0', id: catalogId, label: 'Synthetic Gate 2 SQL catalog', entries: [{ id: 'one', name: 'Synthetic One' }, { id: 'two', name: 'Synthetic Two' }, { id: 'unmapped', name: 'Synthetic Unmapped' }] };
  const taskPayload = { schema_version: '1.0.0', id: taskId, label: 'Synthetic SQL task', catalogVersionId: catalogId,
    syntheticBrief: { provenance: 'synthetic', label: 'Fictional lunch', text: 'An explicitly fictional lunch.' }, syntheticInterests: [],
    constraints: { partySize: 2, dietaryRequirements: ['vegetarian'], accessibilityRequirements: [], requiredCuisines: [], excludedEntryIds: [] } };
  const targetInput = { schema_version: '1.0.0', projectId: project, catalog: { ...catalogPayload, projectId: project, checksum: checksum(catalogPayload), createdAt },
    task: { ...taskPayload, projectId: project, checksum: checksum(taskPayload), createdAt }, mappings, eligibleCatalogEntryIds: ['one','two','unmapped'] };
  const request = CreateDiscoveryJobRequestSchema.parse({ schema_version: '1.0.0', id: job, catalogVersionId: catalogId, taskVersionId: taskId,
    mappingConfirmationIds: mappingIds, eligibleCatalogEntryIds: targetInput.eligibleCatalogEntryIds, assistantVersion: 'synthetic-v1',
    budgets: { qlooAttempts: 4, modelDecisions: 1, targetAttempts: 3, retriesPerOperation: 2 }, profiles: [
      { id: 'a', label: 'Synthetic A', provenance: 'public_synthetic', anchors: [{ id: anchorA, label: 'Public Music A', kind: 'music', confirmedEntityId: randomUUID() }] },
      { id: 'b', label: 'Synthetic B', provenance: 'public_synthetic', anchors: [{ id: anchorB, label: 'Public Film B', kind: 'film' }] },
    ] });
  const input = PinnedDiscoveryInputSchema.parse({ schema_version: '1.0.0', request, targetInput });
  const insertJob = `INSERT INTO public.discovery_jobs(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '900 seconds')`;
  const jobParams = (id=job, projectId=project, data: unknown = input) => [id,projectId,catalogId,taskId,JSON.stringify(data),checksum(data),createdAt];
  let lease = randomUUID();
  const claim = async (seconds=60) => (await client.query('SELECT * FROM public.claim_discovery_job($1,$2,$3)', [lease,seconds,project])).rows;
  const reserve = (id: string, kind: string, operation: string, ordinal=0, allowUncertain=false) => client.query('SELECT * FROM public.reserve_discovery_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9)', [project,job,lease,id,kind,operation,ordinal,checksum(operation),allowUncertain]);
  const advance = (state: string, checkpoint=0, data: unknown={ evidenceIds: [], candidateIds: [] }, release=false) => client.query('SELECT * FROM public.advance_discovery_job($1,$2,$3,$4,$5,$6,NULL,0,$7)', [project,job,lease,state,checkpoint,JSON.stringify(data),release]);
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tastecase:migrations'))");
    await client.query("SET LOCAL tastecase.local_test='on'");
    await client.query(await readFile(new URL('./local-test-bootstrap.sql', import.meta.url),'utf8'));
    await client.query(await readFile(new URL('./migrations/202610130001_gate1_foundation.sql', import.meta.url),'utf8'));
    const migration = await readFile(new URL('./migrations/202610130002_discovery.sql',import.meta.url),'utf8');
    await client.query(migration); await client.query(migration);
    const httpMigration = await readFile(new URL('./migrations/202610180001_qloo_http_receipts.sql',import.meta.url),'utf8');
    await client.query(httpMigration); await client.query(httpMigration);
    const explanationMigration = await readFile(new URL('./migrations/202610260001_qloo_rank_explanations.sql',import.meta.url),'utf8');
    await client.query(explanationMigration); await client.query(explanationMigration);
    await client.query('INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,$3),($4,$5,$6)', [project,owner,'Synthetic discovery SQL',otherProject,otherOwner,'Other synthetic SQL']);
    await client.query('INSERT INTO public.catalog_versions(id,project_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5)', [catalogId,project,JSON.stringify(catalogPayload),checksum(catalogPayload),createdAt]);
    await client.query('INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)', [taskId,project,catalogId,JSON.stringify(taskPayload),checksum(taskPayload),createdAt]);
    for (const mapping of mappings) await client.query('INSERT INTO public.mapping_confirmations(id,project_id,catalog_version_id,catalog_entry_id,qloo_entity_id,confirmed_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[mapping.id,project,catalogId,mapping.catalogEntryId,mapping.qlooEntityId,owner,createdAt]);
    await client.query('INSERT INTO public.runner_credentials(id,project_id,label,token_hash) VALUES($1,$2,$3,$4)',[credential,project,'Synthetic runner',checksum(randomUUID())]);
    await client.query('SET LOCAL ROLE service_role');
    await client.query(insertJob,jobParams());
    await client.query('RESET ROLE');
    await t.test('repeat-safe migration; service-role insert initialises state and composite versions reject cross-project input', async () => {
      assert.equal((await client.query('SELECT state FROM public.discovery_job_state WHERE job_id=$1',[job])).rows[0].state,'queued');
      await fails(insertJob,jobParams(randomUUID(),otherProject), '23503');
      await fails('UPDATE public.discovery_jobs SET input_checksum=$2 WHERE id=$1',[job,'0'.repeat(64)]);
      await fails('DELETE FROM public.discovery_jobs WHERE id=$1',[job]);
    });
    await t.test('forced RLS denies another owner, anonymous users, writes and worker RPC', async () => {
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner]);
      assert.equal((await client.query('SELECT id FROM public.discovery_jobs WHERE id=$1',[job])).rowCount,1);
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[otherOwner]);
      for (const table of ['discovery_jobs','discovery_job_state','discovery_provider_attempts','discovery_tool_evidence','discovery_anchor_resolutions','discovery_anchor_confirmations','discovery_candidates','discovery_job_targets','discovery_target_dispatches']) {
        assert.equal((await client.query(`SELECT project_id FROM public.${table} WHERE project_id=$1`,[project])).rowCount,0);
      }
      await fails('SELECT * FROM public.claim_discovery_job($1)',[lease],'42501');
      await fails("UPDATE public.discovery_job_state SET state='ranking' WHERE job_id=$1",[job],'42501');
      await client.query('SET LOCAL ROLE anon'); await fails('SELECT * FROM public.discovery_jobs',[],'42501'); await client.query('RESET ROLE');
      assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_class WHERE relname LIKE 'discovery_%' AND relkind='r' AND relrowsecurity AND relforcerowsecurity")).rows[0].count,11);
    });
    await t.test('atomic claim skips active lease; reservation is idempotent and checksum collision fails', async () => {
      assert.equal((await claim()).length,1); assert.equal((await claim()).length,0);
      const id = discoveryAttemptId(job,'resolve-a',0);
      await reserve(id,'qloo','resolve-a'); await reserve(id,'qloo','resolve-a');
      assert.equal((await client.query('SELECT qloo_attempts FROM public.discovery_job_state WHERE job_id=$1',[job])).rows[0].qloo_attempts,1);
      await fails('SELECT * FROM public.reserve_discovery_attempt($1,$2,$3,$4,$5,$6,0,$7)',[project,job,lease,id,'qloo','resolve-a','0'.repeat(64)],'23505');
      await client.query('SELECT * FROM public.dispatch_discovery_attempt($1,$2,$3,$4)',[project,job,lease,id]);
    });
    await t.test('expired worker recovery fences old writes, keeps uncertain dispatch charged and never accepts it twice', async () => {
      const oldLease=lease;
      await client.query('SELECT * FROM public.renew_discovery_lease($1,$2,$3,1)',[project,job,lease]);
      await client.query('SELECT pg_sleep(1.1)'); lease=randomUUID(); assert.equal((await claim()).length,1);
      const id=discoveryAttemptId(job,'resolve-a',0);
      assert.equal((await client.query('SELECT status FROM public.discovery_provider_attempts WHERE id=$1',[id])).rows[0].status,'uncertain');
      await fails("SELECT * FROM public.finish_discovery_attempt($1,$2,$3,$4,'accepted')",[project,job,oldLease,id],'40001');
      await fails('SELECT * FROM public.reserve_discovery_attempt($1,$2,$3,$4,$5,$6,1,$7)',[project,job,lease,discoveryAttemptId(job,'resolve-a',1),'qloo','resolve-a',checksum('resolve-a')]);
      await reserve(discoveryAttemptId(job,'resolve-a',1),'qloo','resolve-a',1,true);
      assert.equal((await client.query('SELECT qloo_attempts FROM public.discovery_job_state WHERE job_id=$1',[job])).rows[0].qloo_attempts,2);
    });
    await t.test('only flagged transient retries; persisted backoff prevents immediate redispatch and auth never retries', async () => {
      const id=discoveryAttemptId(job,'resolve-a',1);
      await client.query('SELECT * FROM public.dispatch_discovery_attempt($1,$2,$3,$4)',[project,job,lease,id]);
      await client.query("SELECT * FROM public.finish_discovery_attempt($1,$2,$3,$4,'error',true,'transient','RATE_LIMIT',1)",[project,job,lease,id]);
      assert.ok((await client.query('SELECT available_at>clock_timestamp() AS waiting FROM public.discovery_job_state WHERE job_id=$1',[job])).rows[0].waiting);
      await fails('SELECT * FROM public.reserve_discovery_attempt($1,$2,$3,$4,$5,$6,2,$7)',[project,job,lease,discoveryAttemptId(job,'resolve-a',2),'qloo','resolve-a',checksum('resolve-a')]);
      await client.query('SELECT pg_sleep(1.1)');
      const retry=discoveryAttemptId(job,'resolve-a',2); await reserve(retry,'qloo','resolve-a',2);
      await client.query('SELECT * FROM public.dispatch_discovery_attempt($1,$2,$3,$4)',[project,job,lease,retry]);
      await client.query("SELECT * FROM public.finish_discovery_attempt($1,$2,$3,$4,'accepted')",[project,job,lease,retry]);
      // A separate operation exercises auth; auth failure has no retry even if a caller asks.
      const auth=discoveryAttemptId(job,'auth',0); await reserve(auth,'qloo','auth');
      await client.query('SELECT * FROM public.dispatch_discovery_attempt($1,$2,$3,$4)',[project,job,lease,auth]);
      await fails("SELECT * FROM public.finish_discovery_attempt($1,$2,$3,$4,'error',true,'auth','AUTH')",[project,job,lease,auth]);
      await client.query("SELECT * FROM public.finish_discovery_attempt($1,$2,$3,$4,'error',false,'auth','AUTH')",[project,job,lease,auth]);
      await fails('SELECT * FROM public.reserve_discovery_attempt($1,$2,$3,$4,$5,$6,1,$7)',[project,job,lease,discoveryAttemptId(job,'auth',1),'qloo','auth',checksum('auth')]);
      await fails('SELECT * FROM public.reserve_discovery_attempt($1,$2,$3,$4,$5,$6,0,$7)',[project,job,lease,randomUUID(),'qloo','extra',checksum('extra')]);
    });
    const evidenceId=randomUUID(); const contrastId=randomUUID(); const rankIds=[randomUUID(),randomUUID()];
    const facts={ kind:'facts',rankingEvidenceIds:rankIds,contrasts:[{ id:contrastId,entryIds:['one','two'],orders:{a:['one','two'],b:['two','one']} }],missingEntryIds:[],unmappedEntryIds:['unmapped'] };
    const putEvidence='SELECT * FROM public.put_discovery_evidence($1,$2,$3,$4,NULL,$5,$6)';
    await t.test('HTTP receipts allow only bounded numeric diagnostics and retain legacy evidence compatibility',async()=>{
      const receipt={maxAttempts:2,attempts:1,cacheHits:0,requests:[{endpoint:'/entities',status:429,retryAfterSeconds:600}]};
      const data={kind:'resolve',anchorId:anchorB,providerStatus:'needs_input',candidates:[],http:receipt};
      const id=randomUUID();await client.query(putEvidence,[project,job,lease,id,JSON.stringify(data),checksum(data)]);
      assert.deepEqual((await client.query('SELECT data FROM public.discovery_tool_evidence WHERE id=$1',[id])).rows[0].data,data);
      const invalid=[null,[],{...receipt,body:'Fixture unsafe'}, {...receipt,headers:{'X-Api-Key':'Fixture unsafe'}},
        {...receipt,maxAttempts:3},{...receipt,attempts:2},{...receipt,attempts:'1'},{...receipt,cacheHits:0.5},
        {...receipt,requests:[{...receipt.requests[0],endpoint:'/entities?key=Fixture'}]},
        {...receipt,requests:[{...receipt.requests[0],requestId:'Fixture unsafe'}]},
        {...receipt,requests:[{...receipt.requests[0],status:'429'}]},
        {...receipt,requests:[{...receipt.requests[0],status:99}]},
        {...receipt,requests:[{...receipt.requests[0],retryAfterSeconds:-1}]},
        {...receipt,requests:[{...receipt.requests[0],retryAfterSeconds:0.5}]},
        {...receipt,requests:[{endpoint:'/entities',status:429}]},
      ];
      for(const http of invalid) {const bad={...data,http};await fails(putEvidence,[project,job,lease,randomUUID(),JSON.stringify(bad),checksum(bad)]);}
      const unknownResponse={...data,http:{...receipt,requests:[{endpoint:'/entities',status:null,retryAfterSeconds:null}]}};
      await client.query(putEvidence,[project,job,lease,randomUUID(),JSON.stringify(unknownResponse),checksum(unknownResponse)]);
    });
    await t.test('rank explanations accept bounded evidence and reject unknown tag types or extra keys',async()=>{
      const anchorConfirmationId=(await client.query('SELECT id FROM public.discovery_anchor_confirmations WHERE project_id=$1 AND job_id=$2 AND anchor_id=$3',[project,job,anchorA])).rows[0].id as string;
      const rank={kind:'rank',providerStatus:'ok',profileId:'a',scope:'full',requestedEntryIds:['one','two'],orderedEntryIds:['one','two'],missingEntryIds:[],unmappedEntryIds:['unmapped'],mappingConfirmationIds:mappingIds,anchorConfirmationIds:[anchorConfirmationId],
        affinities:[{entryId:'one',affinity:0.82,interests:[{anchorConfirmationId,score:0.63}]}],
        entryTags:[{entryId:'one',tags:[{type:'urn:tag:cuisine:qloo',name:'Synthetic cuisine'}]}],
      };
      await client.query(putEvidence,[project,job,lease,randomUUID(),JSON.stringify(rank),checksum(rank)]);
      const unknownType={...rank,entryTags:[{entryId:'one',tags:[{type:'urn:tag:unknown',name:'Synthetic cuisine'}]}]};
      await fails(putEvidence,[project,job,lease,randomUUID(),JSON.stringify(unknownType),checksum(unknownType)]);
      const extraKey={...rank,entryTags:[{entryId:'one',tags:[{type:'urn:tag:cuisine:qloo',name:'Synthetic cuisine',extra:'Fixture'}]}]};
      await fails(putEvidence,[project,job,lease,randomUUID(),JSON.stringify(extraKey),checksum(extraKey)]);
    });
    await t.test('immutable normalised evidence idempotence and checksum conflict; checkpoints cannot go backwards', async () => {
      for (const [index,profileId] of ['a','b'].entries()) {
        const rank={ kind:'rank',providerStatus:'ok',profileId,scope:'full',requestedEntryIds:['one','two'],orderedEntryIds:index===0?['one','two']:['two','one'],missingEntryIds:[],unmappedEntryIds:['unmapped'],mappingConfirmationIds:mappingIds,anchorConfirmationIds:[],
          ...(index===0?{http:{maxAttempts:2,attempts:1,cacheHits:0,requests:[{endpoint:'/v2/insights',status:200,retryAfterSeconds:null}]}}:{}),
        };
        await client.query(putEvidence,[project,job,lease,rankIds[index],JSON.stringify(rank),checksum(rank)]);
        await fails(putEvidence,[project,job,lease,randomUUID(),JSON.stringify({...rank,orderedEntryIds:['one','outside']}),checksum('bad')]);
        await fails(putEvidence,[project,job,lease,randomUUID(),JSON.stringify({...rank,unmappedEntryIds:[]}),checksum('bad')]);
      }
      await client.query(putEvidence,[project,job,lease,evidenceId,JSON.stringify(facts),checksum(facts)]);
      await client.query(putEvidence,[project,job,lease,evidenceId,JSON.stringify(facts),checksum(facts)]);
      await fails(putEvidence,[project,job,lease,evidenceId,JSON.stringify(facts),'0'.repeat(64)],'23505');
      await fails('UPDATE public.discovery_tool_evidence SET data=data WHERE id=$1',[evidenceId]);
      await advance('ranking',2,{evidenceIds:[evidenceId],candidateIds:[]});
      await fails('SELECT * FROM public.advance_discovery_job($1,$2,$3,$4,1,$5)',[project,job,lease,'resolving',JSON.stringify({evidenceIds:[evidenceId],candidateIds:[]})]);
    });
    await t.test('confirmation candidates cannot forge another anchor, project owner or unseen ID', async () => {
      assert.equal((await client.query('SELECT confirmed_by FROM public.discovery_anchor_confirmations WHERE job_id=$1 AND anchor_id=$2',[job,anchorA])).rows[0].confirmed_by,owner);
      await fails('INSERT INTO public.discovery_anchor_confirmations(id,project_id,job_id,anchor_id,entity_id,confirmed_by) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),project,job,anchorB,randomUUID(),owner]);
      await fails('INSERT INTO public.discovery_anchor_confirmations(id,project_id,job_id,anchor_id,entity_id,confirmed_by) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),project,job,anchorB,randomUUID(),otherOwner]);
    });
    const candidateId=randomUUID();
    const candidate={ contrast:facts.contrasts[0],briefs:{ a:taskPayload.syntheticBrief,b:taskPayload.syntheticBrief,constraints:taskPayload.constraints,eligibleCatalogEntryIds:targetInput.eligibleCatalogEntryIds },
      evidenceIds:[evidenceId],targetAttemptIds:[],proposedExpectation:{classification:'advisory',automaticFailure:false,humanReviewRequired:true,contrastId,rationale:'Synthetic observed reversal for review'},limitations:['Aggregate evidence is advisory; incomplete traces cannot prove missing tools.'] };
    await t.test('candidate constraints and advisory classification fixed; reopening keeps immutable proposed finding', async () => {
      const sql='SELECT * FROM public.put_discovery_candidate($1,$2,$3,$4,$5,$6)';
      await client.query(sql,[project,job,lease,candidateId,JSON.stringify(candidate),checksum(candidate)]);
      await client.query(sql,[project,job,lease,candidateId,JSON.stringify(candidate),checksum(candidate)]);
      const changed={...candidate,briefs:{...candidate.briefs,constraints:{...taskPayload.constraints,partySize:1}}};
      await fails(sql,[project,job,lease,randomUUID(),JSON.stringify(changed),checksum(changed)]);
      await fails(sql,[project,job,lease,candidateId,JSON.stringify(candidate),'0'.repeat(64)],'23505');
      assert.equal((await client.query('SELECT content FROM public.discovery_candidates WHERE project_id=$1 AND id=$2',[project,candidateId])).rows[0].content.proposedExpectation.classification,'advisory');
    });
    const scheduled=discoveryAttemptId(job,'target:a:0:0:full',0); const queued=discoveryAttemptId(job,'target:b:0:0:full',0);
    const schedule='SELECT * FROM public.schedule_discovery_target($1,$2,$3,$4,$5,$6,$7,$8,0,0,\'full\')';
    await t.test('deterministic scheduling reserves once; constraints/catalog cannot drift and composite associations reject cross-project', async () => {
      const params=[project,job,lease,scheduled,taskId,JSON.stringify(targetInput),checksum(targetInput),'a'];
      await client.query(schedule,params); await client.query(schedule,params);
      await client.query(schedule,[project,job,lease,queued,taskId,JSON.stringify(targetInput),checksum(targetInput),'b']);
      assert.equal((await client.query('SELECT target_attempts FROM public.discovery_job_state WHERE job_id=$1',[job])).rows[0].target_attempts,2);
      const changed={...targetInput,eligibleCatalogEntryIds:['one','two']};
      await fails('SELECT * FROM public.schedule_discovery_target($1,$2,$3,$4,$5,$6,$7,$8,1,0,\'full\')',[project,job,lease,randomUUID(),taskId,JSON.stringify(changed),checksum(changed),'a']);
      await fails('INSERT INTO public.discovery_job_targets(attempt_id,project_id,job_id,catalog_version_id,profile_id,round,repeat,variant) VALUES($1,$2,$3,$4,\'a\',1,0,\'full\')',[randomUUID(),otherProject,job,catalogId],'23503');
    });
    await t.test('cancellation blocks queued/reclaim dispatches but retains already leased results and labels', async () => {
      const targetLease=randomUUID();
      await client.query("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[scheduled,randomUUID(),credential]);
      await client.query('SELECT pg_sleep(1.1)');
      await client.query("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1",[scheduled,targetLease,credential]);
      assert.equal((await client.query('SELECT target_attempts FROM public.discovery_job_state WHERE job_id=$1',[job])).rows[0].target_attempts,3);
      assert.equal((await client.query('SELECT public.discovery_target_claimable($1) AS claimable',[scheduled])).rows[0].claimable,false);
      assert.equal((await client.query('SELECT public.discovery_target_claimable($1) AS claimable',[queued])).rows[0].claimable,true);
      await client.query('SELECT * FROM public.cancel_discovery_job($1,$2)',[project,job]);
      await fails("UPDATE public.target_attempts SET status='leased',lease_id=$2,lease_credential_id=$3,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1",[queued,randomUUID(),credential]);
      await fails('SELECT * FROM public.reserve_discovery_attempt($1,$2,$3,$4,$5,$6,0,$7)',[project,job,lease,randomUUID(),'model','select',checksum('select')],'40001');
      const result={schema_version:'1.0.0',outcome:'success',output:{recommendations:[{catalogEntryId:'one',name:'Synthetic One'}]},trace:{completeness:'partial',events:[]}};
      await client.query("UPDATE public.target_attempts SET status='completed',result=$2,result_checksum=$3,completed_at=clock_timestamp() WHERE id=$1",[scheduled,JSON.stringify(result),checksum(result)]);
      assert.equal((await client.query('SELECT count(*)::int AS count FROM public.discovery_target_dispatches WHERE job_id=$1',[job])).rows[0].count,2);
      assert.equal((await client.query('SELECT state FROM public.discovery_job_state WHERE job_id=$1',[job])).rows[0].state,'cancelled');
    });
  } finally { await client.query('ROLLBACK'); await client.end(); }
});

test('two actual connections claim concurrently and enforce budgets across recovery',async()=>{
  const pool=new pg.Pool({connectionString,max:2}); const a=new pg.Client({connectionString}); const b=new pg.Client({connectionString});
  const project=randomUUID(); const owner=randomUUID(); const catalogId=randomUUID(); const taskId=randomUUID(); const jobs=[randomUUID(),randomUUID()];
  const leases=[randomUUID(),randomUUID()]; const createdAt=new Date().toISOString();
  const catalogPayload={schema_version:'1.0.0',id:catalogId,label:'Synthetic concurrency fixture',entries:[{id:'one',name:'Synthetic One'},{id:'two',name:'Synthetic Two'}]};
  const taskPayload={schema_version:'1.0.0',id:taskId,catalogVersionId:catalogId,label:'Synthetic concurrency task',syntheticBrief:{provenance:'synthetic',label:'Fictional',text:'Explicitly synthetic concurrency fixture.'},syntheticInterests:[],constraints:{partySize:2,dietaryRequirements:[],accessibilityRequirements:[],requiredCuisines:[],excludedEntryIds:[]}};
  // Other connections cannot see rollback-only inserts. This labelled, cancelled
  // immutable fixture remains; no existing fixture is changed or deleted.
  try {
    await runMigrations(pool,{localTestBootstrap:true,databaseUrl:connectionString});
    assert.deepEqual(await runMigrations(pool,{databaseUrl:connectionString}),[]);
    await a.connect(); await b.connect(); await a.query('BEGIN');
    await a.query('INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,$3)',[project,owner,'Synthetic Gate 2 concurrency verification']);
    await a.query('INSERT INTO public.catalog_versions(id,project_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5)',[catalogId,project,JSON.stringify(catalogPayload),checksum(catalogPayload),createdAt]);
    await a.query('INSERT INTO public.task_versions(id,project_id,catalog_version_id,content,checksum,created_at) VALUES($1,$2,$3,$4,$5,$6)',[taskId,project,catalogId,JSON.stringify(taskPayload),checksum(taskPayload),createdAt]);
    for(const job of jobs){
      const request=CreateDiscoveryJobRequestSchema.parse({schema_version:'1.0.0',id:job,catalogVersionId:catalogId,taskVersionId:taskId,mappingConfirmationIds:[],eligibleCatalogEntryIds:['one','two'],assistantVersion:'synthetic',budgets:{qlooAttempts:1},profiles:[{id:'a',provenance:'public_synthetic',label:'A',anchors:[{id:randomUUID(),label:'Public music',kind:'music'}]},{id:'b',provenance:'public_synthetic',label:'B',anchors:[{id:randomUUID(),label:'Public film',kind:'film'}]}]});
      const input=PinnedDiscoveryInputSchema.parse({schema_version:'1.0.0',request,targetInput:{schema_version:'1.0.0',projectId:project,catalog:{...catalogPayload,projectId:project,checksum:checksum(catalogPayload),createdAt},task:{...taskPayload,projectId:project,checksum:checksum(taskPayload),createdAt},mappings:[],eligibleCatalogEntryIds:['one','two']}});
      await a.query("INSERT INTO public.discovery_jobs(id,project_id,catalog_version_id,task_version_id,pinned_input,input_checksum,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '900 seconds')",[job,project,catalogId,taskId,JSON.stringify(input),checksum(input),createdAt]);
    }
    await a.query('COMMIT'); await a.query('BEGIN'); await b.query('BEGIN');
    const claims=await Promise.all([a.query('SELECT * FROM public.claim_discovery_job($1,60,$2)',[leases[0],project]),b.query('SELECT * FROM public.claim_discovery_job($1,60,$2)',[leases[1],project])]);
    assert.equal(claims[0].rowCount,1); assert.equal(claims[1].rowCount,1); assert.notEqual(claims[0].rows[0].job_id,claims[1].rows[0].job_id);
    await a.query('COMMIT'); await b.query('COMMIT');
    const job: string=claims[0].rows[0].job_id; const lease: string=claims[0].rows[0].lease_id;
    const reserve='SELECT * FROM public.reserve_discovery_attempt($1,$2,$3,$4,\'qloo\',$5,0,$6)';
    const reservations=await Promise.allSettled([a.query(reserve,[project,job,lease,randomUUID(),'rank-a',checksum('rank-a')]),b.query(reserve,[project,job,lease,randomUUID(),'rank-b',checksum('rank-b')])]);
    assert.equal(reservations.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(reservations.filter(result=>result.status==='rejected' && result.reason.code==='23514').length,1);
    await b.query('SELECT * FROM public.cancel_discovery_job($1,$2)',[project,claims[1].rows[0].job_id]);
    await a.query('SELECT * FROM public.renew_discovery_lease($1,$2,$3,1)',[project,job,lease]); await a.query('SELECT pg_sleep(1.1)');
    const recovered=(await b.query('SELECT * FROM public.claim_discovery_job($1,60,$2)',[randomUUID(),project])).rows[0];
    assert.equal(recovered.job_id,job); assert.equal(recovered.qloo_attempts,1);
    await assert.rejects(a.query('SELECT * FROM public.advance_discovery_job($1,$2,$3,\'ranking\',0,$4)',[project,job,lease,JSON.stringify({evidenceIds:[],candidateIds:[]})]),(e: unknown)=>e instanceof Error && 'code' in e && e.code==='40001');
    await assert.rejects(b.query(reserve,[project,job,recovered.lease_id,randomUUID(),'restart-extra',checksum('extra')]),(e: unknown)=>e instanceof Error && 'code' in e && e.code==='23514');
    assert.equal((await b.query('SELECT status FROM public.discovery_provider_attempts WHERE job_id=$1',[job])).rows[0].status,'interrupted');
  } finally {
    await a.query('ROLLBACK').catch(()=>undefined); await b.query('ROLLBACK').catch(()=>undefined);
    for(const job of jobs) await pool.query('SELECT * FROM public.cancel_discovery_job($1,$2)',[project,job]).catch(()=>undefined);
    await a.end(); await b.end(); await pool.end();
  }
});
