import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { computeDiscoveryFacts, RankingEvidenceSchema } from '@tastecase/contracts';
import { childEnvironment, normalizeRank, normalizeResolution, parseEnvelope, validateTools, OfficialQlooAdapter, QlooEntityTagsSchema, QLOO_HOST } from './qloo.js';
import { parseSelection, OpenRouterDecisionAdapter, boundedJson } from './decision.js';
import { UnknownDispatch, type RankRequest } from './types.js';
import { startDiscoveryWorker } from './main.js';

const request: RankRequest = {profileId:'a',scope:'full',options:[
  {entryId:'one',entityId:randomUUID(),confirmationId:randomUUID()},
  {entryId:'two',entityId:randomUUID(),confirmationId:randomUUID()},
],anchors:[{entityId:randomUUID(),confirmationId:randomUUID()}],unmappedEntryIds:['unmapped']};
const envelope = (status = 'ok', results: unknown[] = request.options.map(option=>({entity_id:option.entityId,name:`Synthetic ${option.entryId}`,type:'urn:entity:place'}))) => ({
  schema_version:'1.0-preview.1',operation:'rank',status,results,result_count:results.length,
  execution:{transport:'mcp',transport_name:'Qloo canonical MCP',correlation_id:'synthetic-test',duration_ms:1},
});
const entityArray = {type:'array',minItems:1,maxItems:10,items:{type:'string',minLength:1}};
const tools = () => ({tools:['qloo_rank','qloo_describe'].map(name=>({name,
  inputSchema:{type:'object',additionalProperties:false,required:name==='qloo_rank'?['options','option_type']:['entity'],
    properties:name==='qloo_rank'?{options:entityArray,signals:entityArray,option_type:{type:'string',enum:['place']}}:{entity:{type:'string'},type:{type:'string',enum:['artist','movie','brand']}}},
  outputSchema:{type:'object',required:['schema_version','operation','status','execution'],properties:{status:{anyOf:['ok','empty','needs_input','partial','degraded','error'].map(value=>({const:value}))}}},
}))});

test('standalone worker rejects hosted TLS overrides before opening any database or provider',async()=>{
  const names=['DATABASE_URL','OPENROUTER_API_KEY','QLOO_API_KEY'] as const;
  const prior=names.map(name=>process.env[name]);
  try {
    process.env.OPENROUTER_API_KEY='synthetic';process.env.QLOO_API_KEY='synthetic';
    for (const name of ['sslmode','sslrootcert','sslcert','sslkey']) {
      process.env.DATABASE_URL=`postgresql://synthetic@db.invalid/synthetic?${name}=synthetic`;
      await assert.rejects(startDiscoveryWorker(new AbortController().signal),/URL overrides/);
    }
  } finally {
    names.forEach((name,index)=>{const value=prior[index];if(value===undefined)delete process.env[name];else process.env[name]=value;});
  }
});

test('literal six statuses; no seventh vocabulary or malformed payload',()=>{
  for (const status of ['ok','empty','needs_input','partial','degraded','error']) {
    const value = {...envelope(status,[]),...(status==='error'?{error:{code:'QLOO_AUTH',layer:'qloo',retryable:false,recovery:'Synthetic correction'}}:{})};
    assert.equal(parseEnvelope(value,'rank',64000).status,status);
  }
  for (const value of [envelope('success'),{...envelope(),operation:'recommend'},envelope('empty'),{...envelope(),result_count:100},
    {...envelope(),results:'not-an-array'},envelope('error',[]),{...envelope(),execution:{transport:'direct'}}]) assert.throws(()=>parseEnvelope(value,'rank',64000));
});

test('omissions retain provider status and mapped/unmapped coverage, never zero affinity',()=>{
  const first = request.options[0]; assert.ok(first);
  const rank = normalizeRank(envelope('ok',[{entity_id:first.entityId,name:'Synthetic One'}]),request,64000);
  assert.deepEqual({status:rank.providerStatus,ordered:rank.orderedEntryIds,missing:rank.missingEntryIds,unmapped:rank.unmappedEntryIds},
    {status:'ok',ordered:['one'],missing:['two'],unmapped:['unmapped']});
});

test('rank explanations map scores and request anchors, while malformed and unrelated signals are omitted',()=>{
  const [first, second] = request.options;
  const anchor = request.anchors[0]; assert.ok(first); assert.ok(second); assert.ok(anchor);
  const raw = {
    ...envelope('ok', [
      { entity_id:first.entityId,name:'Synthetic One',affinity:0.82,explainability:{'signal.interests.entities':[
        {entity_id:anchor.entityId,score:0.63},{entity_id:randomUUID(),score:0.99},{entity_id:anchor.entityId,score:0.2},
      ]}},
      { entity_id:second.entityId,name:'Synthetic Two',affinity:1.2,explainability:'malformed'},
    ]),
    entityTags:[
      {entityId:first.entityId,tags:[{type:'urn:tag:cuisine:qloo',name:'Synthetic cuisine'}]},
      {entityId:randomUUID(),tags:[{type:'urn:tag:cuisine:qloo',name:'Outside'}]},
      {entityId:second.entityId,tags:[]},
    ],
  };
  const rank = normalizeRank(raw,request,64000);
  assert.deepEqual(rank.affinities,[{entryId:'one',affinity:0.82,interests:[{anchorConfirmationId:anchor.confirmationId,score:0.63}]}]);
  assert.deepEqual(rank.entryTags,[{entryId:'one',tags:[{type:'urn:tag:cuisine:qloo',name:'Synthetic cuisine'}]}]);
  const missing = normalizeRank(envelope('ok',[
    {entity_id:first.entityId,name:'Synthetic One',explainability:{'signal.interests.entities':[{entity_id:anchor.entityId,score:0.8}]}},
    {entity_id:second.entityId,name:'Synthetic Two',affinity:0.4,explainability:{broken:true}},
  ]),request,64000);
  assert.deepEqual(missing.affinities,[{entryId:'two',affinity:0.4,interests:[]}]);
  assert.equal('entryTags' in missing,false);
});

test('successful official resolution metadata need not include ambiguity issues',()=>{
  const rank = normalizeRank({...envelope(),resolution:{status:'resolved',inputs:[]}},request,64000);
  assert.equal(rank.providerStatus,'ok'); assert.deepEqual(rank.orderedEntryIds,['one','two']);
  const anchor={id:randomUUID(),label:'Synthetic public film',kind:'film' as const};
  assert.throws(()=>normalizeResolution({...envelope('needs_input',[]),operation:'describe',resolution:{status:'needs_input'}},anchor,64000));
});

test('official generic entity metadata does not invalidate typed, pinned results',()=>{
  const raw = {...envelope(),results:request.options.map(option=>({entity_id:option.entityId,name:'Synthetic Venue',type:'urn:entity'}))};
  assert.deepEqual(normalizeRank(raw,request,64000).orderedEntryIds,['one','two']);
  const anchor={id:randomUUID(),label:'Synthetic public film',kind:'film' as const};
  const resolved={...envelope(),operation:'describe',result_count:1,results:[{entity_id:randomUUID(),name:'Synthetic Film'}]};
  assert.equal(normalizeResolution(resolved,anchor,64000).candidates[0]?.kind,'film');
});

test('outside, duplicate, non-place and malformed IDs are rejected',()=>{
  const first = request.options[0]; assert.ok(first);
  for (const results of [ [{entity_id:randomUUID(),name:'Outside'}],
    [{entity_id:first.entityId,name:'One'},{entity_id:first.entityId.toUpperCase(),name:'Duplicate'}],
    [{entity_id:first.entityId,name:'Wrong type',type:'movie'}],[{entity_id:'unknown',name:'Malformed'}] ]) {
    assert.throws(()=>normalizeRank(envelope('ok',results),request,64000));
  }
});

test('entity tag transport metadata is strict and bounded to fifteen entities',()=>{
  const tag={type:'urn:tag:cuisine:qloo',name:'Fixture cuisine'};
  assert.equal(QlooEntityTagsSchema.safeParse([{entityId:randomUUID(),tags:[tag]}]).success,true);
  assert.equal(QlooEntityTagsSchema.safeParse([{entityId:randomUUID(),tags:[tag],extra:'Fixture'}]).success,false);
  assert.equal(QlooEntityTagsSchema.safeParse(Array.from({length:16},()=>({entityId:randomUUID(),tags:[tag]}))).success,false);
});

test('only official flagged transient errors retry; auth and arbitrary codes cannot',()=>{
  for (const [code,retryable,category] of [['QLOO_RATE_LIMIT',true,'transient'],['QLOO_AUTH',false,'auth'],['unexpected credential echo',false,'unavailable']] as const) {
    const result=normalizeRank({...envelope('error',[]),error:{code,layer:'qloo',retryable:true,recovery:'Never persisted'}},request,64000);
    assert.equal(result.error?.retryable,retryable); assert.equal(result.error?.category,category);
    if (category==='unavailable') assert.equal(result.error?.code,'QLOO_UNAVAILABLE');
  }
});

test('ambiguous describe candidates require owner selection and preserve same-kind IDs',()=>{
  const anchor={id:randomUUID(),label:'Synthetic public film',kind:'film' as const};
  const entity=randomUUID(); const raw={...envelope('needs_input',[]),operation:'describe',resolution:{issues:[{
    input:anchor.label,field:'entity',input_kind:'entity',kind:'ambiguous',candidates:[{id:entity,name:'Synthetic Film 1954',type:'urn:entity:movie'}],
  }]}};
  assert.deepEqual(normalizeResolution(raw,anchor,64000).candidates,[{entityId:entity,name:'Synthetic Film 1954',kind:'film'}]);
  assert.throws(()=>normalizeResolution(raw,{...anchor,kind:'brand'},64000));
  assert.throws(()=>normalizeResolution({...raw,resolution:{issues:[{...raw.resolution.issues[0],input:'Another anchor'}]}},anchor,64000));
});

test('live schema compatibility rejects missing tools, duplicate names and changed schemas',()=>{
  validateTools(tools());
  const changed=tools(); const first=changed.tools[0]; assert.ok(first);
  first.inputSchema.required=['unsupported']; assert.throws(()=>validateTools(changed));
  assert.throws(()=>validateTools({tools:[]}));
  assert.throws(()=>validateTools({tools:[...tools().tools,...tools().tools]}));
});

test('official adapter allowlist dispatches pinned IDs only and rejects >10 before calling',async()=>{
  const calls: {name:string;args:Record<string,unknown>}[]=[]; let closed=false;
  const adapter=new OfficialQlooAdapter(async()=>({listTools:async()=>tools(),callTool:async(name,args)=>{calls.push({name,args});return envelope();},close:async()=>{closed=true;}}));
  await adapter.rank(request,{signal:new AbortController().signal,outputBytes:64000});
  await assert.rejects(adapter.rank({...request,options:Array.from({length:11},(_,i)=>({entryId:`${i}`,entityId:randomUUID(),confirmationId:randomUUID()}))},{signal:new AbortController().signal,outputBytes:64000}));
  await adapter.close();
  assert.deepEqual(calls,[{name:'qloo_rank',args:{options:request.options.map(value=>value.entityId),option_type:'place',signals:request.anchors.map(value=>value.entityId)}}]);
  assert.ok(closed);
});

test('MCP child environment neutralises SDK inheritance and contains no DB/model/target credentials',()=>{
  const env=childEnvironment('synthetic-noncredential','/tmp/synthetic-home',['HOME','PATH','LOGNAME','USER','SHELL','TERM']);
  assert.deepEqual(Object.keys(env).sort(),['HOME','LOGNAME','PATH','QLOO_API_KEY','QLOO_BASE_URL','QLOO_HOME','QLOO_TRUSTED_BASE_URL','SHELL','TERM','USER'].sort());
  assert.equal(env.QLOO_BASE_URL,QLOO_HOST); assert.equal(env.USER,''); assert.equal(env.HOME,'/tmp/synthetic-home');
});

const rank=RankingEvidenceSchema.parse({kind:'rank',providerStatus:'ok',profileId:'a',scope:'full',requestedEntryIds:['one','two'],orderedEntryIds:['one','two'],missingEntryIds:[],unmappedEntryIds:[],mappingConfirmationIds:[],anchorConfirmationIds:[]});
const facts=computeDiscoveryFacts(randomUUID(),[randomUUID(),randomUUID()],rank,{...rank,profileId:'b',orderedEntryIds:['two','one']});
test('Model selection IDs are checked against software facts; model claims and prose are rejected',()=>{
  const id=facts.contrasts[0]?.id; assert.ok(id);
  assert.equal(parseSelection({selectedContrastId:id},facts).selectedContrastId,id);
  for (const value of [{selectedContrastId:randomUUID()},{selectedContrastId:id,classification:'failure'},{selectedContrastId:id,rationale:'Invented'},'one is disliked']) assert.throws(()=>parseSelection(value,facts));
});

test('The decision model uses only computed facts, strict ID-only schema and free-only OpenRouter routing',async()=>{
  let url=''; let redirect: RequestRedirect | undefined; let body: Record<string,unknown>={}; const id=facts.contrasts[0]?.id;
  const mock: typeof fetch=async(input,init)=>{url=String(input);redirect=init?.redirect;body=JSON.parse(String(init?.body)) as Record<string,unknown>;return Response.json({choices:[{message:{content:JSON.stringify({selectedContrastId:id})}}]});};
  const adapter=new OpenRouterDecisionAdapter('synthetic-noncredential',mock);
  assert.equal(JSON.stringify(adapter).includes('synthetic-noncredential'),false);
  assert.equal((await adapter.select(facts,{signal:new AbortController().signal,outputBytes:64000})).selectedContrastId,id);
  assert.equal(url,'https://openrouter.ai/api/v1/chat/completions'); assert.equal(body.model,'nvidia/nemotron-3.5-super-vl:free'); assert.equal(body.tools,undefined);assert.equal(redirect,'error');
  assert.deepEqual(body.provider,{allow_fallbacks:false,require_parameters:true,max_price:{prompt:0,completion:0,request:0}});
  assert.deepEqual(body.reasoning,{enabled:false,exclude:true});
  assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.max_tokens,2048);
});

test('OpenRouter auth does not retry; transport errors remain unknown; streaming size is bounded',async()=>{
  let calls=0;
  const auth=new OpenRouterDecisionAdapter('synthetic-noncredential',async()=>{calls++;return new Response(null,{status:401});});
  await assert.rejects(auth.select(facts,{signal:new AbortController().signal,outputBytes:64000}),/MODEL_AUTH/); assert.equal(calls,1);
  const network=new OpenRouterDecisionAdapter('synthetic-noncredential',async()=>{throw new TypeError('Network error with private text');});
  await assert.rejects(network.select(facts,{signal:new AbortController().signal,outputBytes:64000}),UnknownDispatch);
  await assert.rejects(boundedJson(new Response('x'.repeat(100)),10),/budget/);
});

test('OpenRouter decision failures never fall back, retry or retain provider errors',async()=>{
  for (const status of [402,429,500,503]) {
    let calls=0;
    const adapter=new OpenRouterDecisionAdapter('synthetic-private-key',async()=>{calls++;return new Response('synthetic-private-key upstream private error',{status});});
    await assert.rejects(adapter.select(facts,{signal:new AbortController().signal,outputBytes:64000}),/^TypeError: MODEL_UNAVAILABLE$/);
    assert.equal(calls,1);
  }
  assert.throws(()=>new OpenRouterDecisionAdapter(''));
  assert.throws(()=>new OpenRouterDecisionAdapter('invalid\nkey'));
});

test('OpenRouter decisions support null and reject malformed, unsupported and credential-bearing JSON',async()=>{
  const key='synthetic-private-key';
  const make=(content:string)=>new OpenRouterDecisionAdapter(key,async()=>Response.json({choices:[{message:{content}}]}));
  const context={signal:new AbortController().signal,outputBytes:64000};
  assert.equal((await make('{"selectedContrastId":null}').select(facts,context)).selectedContrastId,null);
  for (const content of ['not JSON',JSON.stringify({selectedContrastId:randomUUID()}),JSON.stringify({selectedContrastId:null,rationale:key})]) {
    await assert.rejects(make(content).select(facts,context),/^TypeError: Invalid model selection$/);
  }
  const controller=new AbortController();controller.abort();let calls=0;
  const adapter=new OpenRouterDecisionAdapter(key,async()=>{calls++;return Response.json({});});
  await assert.rejects(adapter.select(facts,{signal:controller.signal,outputBytes:64000}));assert.equal(calls,0);
});
