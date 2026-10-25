import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  checksum, CreateDiscoveryJobRequestSchema, PinnedDiscoveryInputSchema, RankingEvidenceSchema,
  QlooStatusSchema, NormalizedDiscoveryEvidenceSchema, DiscoveryCandidateContentSchema, DiscoveryAnchorConfirmationSchema, DiscoveryProviderAttemptSchema,
  computeDiscoveryFacts, validateModelContrastDecision, validateDiscoveryCandidate, discoveryAttemptId, isWeakContrast, MIN_CONTRAST_AFFINITY_GAP, REST_CONTRACTS,
} from './index.js';

const projectId=randomUUID(); const catalogId=randomUUID(); const taskId=randomUUID(); const jobId=randomUUID(); const ownerId=randomUUID();
const createdAt='2026-10-13T12:00:00.000Z';
const catalogPayload={schema_version:'1.0.0',id:catalogId,label:'Synthetic catalog',entries:[{id:'one',name:'Synthetic One'},{id:'two',name:'Synthetic Two'},{id:'omitted',name:'Synthetic Omitted'},{id:'unmapped',name:'Synthetic Unmapped',qlooEntityId:randomUUID()}]};
const taskPayload={schema_version:'1.0.0',id:taskId,label:'Synthetic task',catalogVersionId:catalogId,
  syntheticBrief:{provenance:'synthetic',label:'Fictional lunch',text:'This is an explicitly fictional lunch.'},syntheticInterests:[],
  constraints:{partySize:2,dietaryRequirements:['vegetarian'],accessibilityRequirements:['step-free'],requiredCuisines:[],excludedEntryIds:[],budgetPerPerson:{currency:'USD',amountMinor:5000}}};
const mappings=['one','two','omitted'].map(catalogEntryId=>({schema_version:'1.0.0',id:randomUUID(),projectId,catalogVersionId:catalogId,catalogEntryId,qlooEntityId:randomUUID(),confirmedBy:ownerId,createdAt}));
const request=CreateDiscoveryJobRequestSchema.parse({schema_version:'1.0.0',id:jobId,catalogVersionId:catalogId,taskVersionId:taskId,
  mappingConfirmationIds:mappings.map(mapping=>mapping.id),eligibleCatalogEntryIds:catalogPayload.entries.map(entry=>entry.id),assistantVersion:'synthetic-v1',profiles:[
    {id:'a',provenance:'public_synthetic',label:'Profile A',anchors:[{id:randomUUID(),kind:'music',label:'Public Music'}]},
    {id:'b',provenance:'public_synthetic',label:'Profile B',anchors:[{id:randomUUID(),kind:'film',label:'Public Film'}]},
  ]});
const input=PinnedDiscoveryInputSchema.parse({schema_version:'1.0.0',request,targetInput:{schema_version:'1.0.0',projectId,
  catalog:{...catalogPayload,projectId,checksum:checksum(catalogPayload),createdAt},task:{...taskPayload,projectId,checksum:checksum(taskPayload),createdAt},mappings,eligibleCatalogEntryIds:request.eligibleCatalogEntryIds}});
const a=RankingEvidenceSchema.parse({kind:'rank',providerStatus:'ok',profileId:'a',scope:'full',requestedEntryIds:['one','two','omitted'],orderedEntryIds:['one','two'],missingEntryIds:['omitted'],unmappedEntryIds:['unmapped'],mappingConfirmationIds:request.mappingConfirmationIds,anchorConfirmationIds:[]});
const b=RankingEvidenceSchema.parse({...a,profileId:'b',providerStatus:'partial',orderedEntryIds:['two','one']});
const facts=computeDiscoveryFacts(jobId,[randomUUID(),randomUUID()],a,b);
const withAffinities=(rank:typeof a,values:Record<string,number>)=>({...rank,affinities:Object.entries(values).map(([entryId,affinity])=>({entryId,affinity,interests:[]}))});

test('default and maximum budgets bound all dispatch classes; optional IDs are explicit owner confirmations',()=>{
  assert.deepEqual(request.budgets,{qlooAttempts:8,modelDecisions:2,targetAttempts:6,rounds:3,deadlineSeconds:900,outputBytes:64000,retriesPerOperation:1});
  for(const budgets of [{qlooAttempts:21},{modelDecisions:9},{targetAttempts:13},{rounds:7},{deadlineSeconds:3601},{outputBytes:262145},{retriesPerOperation:3}]) {
    assert.equal(CreateDiscoveryJobRequestSchema.safeParse({...request,budgets}).success,false);
  }
});
test('public synthetic anchor input rejects histories, PII fields, duplicate IDs and unsupported kinds',()=>{
  for(const anchor of [{...request.profiles[0].anchors[0],email:'synthetic@example.invalid'}, {...request.profiles[0].anchors[0],guestHistory:['Synthetic private history']},{...request.profiles[0].anchors[0],kind:'person'}]) {
    assert.equal(CreateDiscoveryJobRequestSchema.safeParse({...request,profiles:[{...request.profiles[0],anchors:[anchor]},request.profiles[1]]}).success,false);
  }
  assert.equal(CreateDiscoveryJobRequestSchema.safeParse({...request,profiles:[request.profiles[0],{...request.profiles[1],anchors:request.profiles[0].anchors}]}).success,false);
});
test('larger pinned catalogs can be queued but cannot masquerade as a supported single affinity rank',()=>{
  assert.equal(CreateDiscoveryJobRequestSchema.safeParse({...request,mappingConfirmationIds:Array.from({length:21},()=>randomUUID())}).success,true);
  assert.equal(RankingEvidenceSchema.safeParse({...a,requestedEntryIds:Array.from({length:11},(_,i)=>`entry-${i}`)}).success,false);
});
test('literal six-status vocabulary and malformed or extra ranking fields are rejected',()=>{
  for(const status of ['ok','empty','needs_input','partial','degraded','error']) assert.equal(QlooStatusSchema.parse(status),status);
  for(const status of ['success','ready','unavailable','unknown']) assert.equal(QlooStatusSchema.safeParse(status).success,false);
  assert.equal(NormalizedDiscoveryEvidenceSchema.safeParse({...a,rawResponse:{private:'Synthetic'}}).success,false);
  assert.equal(NormalizedDiscoveryEvidenceSchema.safeParse({...a,orderedEntryIds:'one'}).success,false);
});
test('ranking explanations accept bounded mapped scores and reject out-of-scope or duplicate references',()=>{
  const anchorConfirmationId=randomUUID();
  const explained={...a,anchorConfirmationIds:[anchorConfirmationId],
    affinities:[{entryId:'one',affinity:0.82,interests:[{anchorConfirmationId,score:0.63}]}],
    entryTags:[{entryId:'one',tags:[{type:'urn:tag:cuisine:qloo',name:'  Synthetic cuisine  '}]}]};
  const parsed=RankingEvidenceSchema.parse(explained);
  assert.equal(parsed.entryTags?.[0]?.tags[0]?.name,'Synthetic cuisine');
  assert.equal(RankingEvidenceSchema.safeParse({...explained,affinities:[{...explained.affinities[0]!,affinity:1.01}]}).success,false);
  assert.equal(RankingEvidenceSchema.safeParse({...explained,entryTags:[{entryId:'one',tags:[{type:'urn:tag:unknown',name:'Unknown'}]}]}).success,false);
  assert.equal(RankingEvidenceSchema.safeParse({...explained,affinities:[{...explained.affinities[0]!,entryId:'outside'}]}).success,false);
  assert.equal(RankingEvidenceSchema.safeParse({...explained,affinities:[{entryId:'one',affinity:0.5,interests:[{anchorConfirmationId:randomUUID(),score:0.4}]}]}).success,false);
  assert.equal(RankingEvidenceSchema.safeParse({...explained,affinities:[...explained.affinities!,{...explained.affinities[0]!}]}).success,false);
  assert.equal(RankingEvidenceSchema.safeParse({...explained,affinities:[{entryId:'one',affinity:0.5,interests:[
    {anchorConfirmationId,score:0.4},{anchorConfirmationId,score:0.3},
  ]}]}).success,false);
  assert.equal(RankingEvidenceSchema.safeParse({...explained,entryTags:[...explained.entryTags!,{...explained.entryTags[0]!}]}).success,false);
});
for(const [name,changes] of [
  ['duplicate ranked IDs',{orderedEntryIds:['one','one']}],['outside ranked IDs',{orderedEntryIds:['one','outside']}],
  ['unknown requested ID coverage',{orderedEntryIds:['one','two','other']}],['coverage omission',{missingEntryIds:[]}],
  ['invented missing entry',{missingEntryIds:['omitted','other']}],['unmapped requested entry',{unmappedEntryIds:['one']}],
  ['empty with rankings',{providerStatus:'empty'}],['needs input with rankings',{providerStatus:'needs_input'}],['error without metadata',{providerStatus:'error'}],
  ['score claims',{scores:[100,1]}],['oversized rank',{requestedEntryIds:Array.from({length:11},(_,i)=>String(i))}],
] as const) test(`normalised ranking rejects ${name}`,()=>assert.equal(RankingEvidenceSchema.safeParse({...a,...changes}).success,false));
test('a missing mapped venue and an unconfirmed catalog hint remain unavailable, never negative preference',()=>{
  assert.deepEqual(facts.missingEntryIds,['omitted']); assert.deepEqual(facts.unmappedEntryIds,['unmapped']);
  assert.deepEqual(facts.contrasts[0]?.orders,{a:['one','two'],b:['two','one']});
});
test('no contrast, degraded and empty evidence never invent a taste verdict',()=>{
  assert.equal(computeDiscoveryFacts(jobId,[randomUUID(),randomUUID()],a,{...b,orderedEntryIds:['one','two']}).contrasts.length,0);
  assert.equal(computeDiscoveryFacts(jobId,[randomUUID(),randomUUID()],a,{...b,providerStatus:'degraded'}).unsupportedReason,'provider_unavailable');
  assert.equal(computeDiscoveryFacts(jobId,[randomUUID(),randomUUID()],a,{...b,providerStatus:'empty',orderedEntryIds:[],missingEntryIds:b.requestedEntryIds}).contrasts.length,0);
});
const weak=(aValues:Record<string,number>,bValues:Record<string,number>)=>{
  const ra=withAffinities(a,aValues); const rb=withAffinities(b,bValues);
  const facts=computeDiscoveryFacts(jobId,[randomUUID(),randomUUID()],ra,rb);
  assert.equal(facts.contrasts.length,1);
  return isWeakContrast(facts.contrasts[0]!,ra,rb);
};
test('weak affinity gaps in both profiles mark the reversed pair weak',()=>{
  assert.equal(MIN_CONTRAST_AFFINITY_GAP,0.01);
  assert.equal(weak({one:0.8,two:0.795},{one:0.6,two:0.595}),true);
  assert.equal(weak({one:0.77,two:0.7695},{one:0.69,two:0.6899}),true);
});
test('a profile gap at the threshold keeps the reversed pair, including float rounding',()=>{
  assert.equal(weak({one:0.81,two:0.8},{one:0.69,two:0.6899}),false);
  assert.equal(weak({one:0.69,two:0.68},{one:0.56,two:0.57}),false);
  assert.equal(weak({one:0.69,two:0.68},{one:0.69,two:0.6899}),false);
});
test('missing affinity evidence keeps the reversed pair',()=>{
  assert.equal(weak({one:0.8},{one:0.69,two:0.6899}),false);
});
test('computed facts keep weak reversals so pinned historical evidence still validates',()=>{
  const evidenceIds:[string,string]=[randomUUID(),randomUUID()];
  const previousFacts=computeDiscoveryFacts(jobId,evidenceIds,a,b);
  const weakFacts=computeDiscoveryFacts(jobId,evidenceIds,
    withAffinities(a,{one:0.77,two:0.7695}),withAffinities(b,{one:0.69,two:0.6899}));
  assert.equal(JSON.stringify(weakFacts),JSON.stringify(previousFacts));
});
test('separate affinity calls cannot be merged or reduced and presented as a common full-catalog rank',()=>{
  assert.throws(()=>computeDiscoveryFacts(jobId,[randomUUID(),randomUUID()],a,{...b,scope:'reduced_pair',requestedEntryIds:['one','two'],missingEntryIds:[]}),/fixed mapped catalog/);
});
test('model may select only a computed contrast ID and cannot invent ranking/classification claims',()=>{
  const decision={kind:'model_decision',selectedContrastId:facts.contrasts[0]?.id,rationale:'Review the supported pair'};
  assert.equal(validateModelContrastDecision(decision,facts).selectedContrastId,decision.selectedContrastId);
  assert.throws(()=>validateModelContrastDecision({...decision,selectedContrastId:randomUUID()},facts),/unsupported/);
  assert.throws(()=>validateModelContrastDecision({...decision,classification:'failure'},facts));
});
test('candidate pair remains advisory with all practical constraints and eligible catalog fixed',()=>{
  const contrast=facts.contrasts[0]; assert.ok(contrast);
  const content={contrast,briefs:{a:taskPayload.syntheticBrief,b:taskPayload.syntheticBrief,constraints:taskPayload.constraints,eligibleCatalogEntryIds:request.eligibleCatalogEntryIds},
    evidenceIds:facts.rankingEvidenceIds,targetAttemptIds:[],proposedExpectation:{classification:'advisory',automaticFailure:false,humanReviewRequired:true,contrastId:contrast.id,rationale:'Aggregate observed order only'},limitations:['Human review required; no individual preference claim.']};
  assert.equal(validateDiscoveryCandidate(content,input,facts).proposedExpectation.automaticFailure,false);
  assert.throws(()=>validateDiscoveryCandidate({...content,briefs:{...content.briefs,constraints:{...taskPayload.constraints,dietaryRequirements:[]}}},input,facts),/remain fixed/);
  assert.throws(()=>validateDiscoveryCandidate({...content,briefs:{...content.briefs,eligibleCatalogEntryIds:['one','two']}},input,facts),/remain fixed/);
  assert.equal(DiscoveryCandidateContentSchema.safeParse({...content,proposedExpectation:{...content.proposedExpectation,classification:'fail'}}).success,false);
});
test('deterministic identities survive restart but separate retry slots and target profile/repeat scheduling',()=>{
  const id=discoveryAttemptId(jobId,'target:a:0:0:full',0);
  assert.equal(id,discoveryAttemptId(jobId,'target:a:0:0:full',0));
  assert.notEqual(id,discoveryAttemptId(jobId,'target:b:0:0:full',0));
  assert.notEqual(id,discoveryAttemptId(jobId,'target:a:0:1:full',0));
  assert.notEqual(discoveryAttemptId(jobId,'rank-a',0),discoveryAttemptId(jobId,'rank-a',1));
});
test('queue-time owner confirmation is displayable with no fabricated resolution evidence',()=>{
  assert.equal(DiscoveryAnchorConfirmationSchema.safeParse({schema_version:'1.0.0',id:randomUUID(),projectId,jobId,anchorId:request.profiles[0].anchors[0]?.id,resolutionId:null,entityId:randomUUID(),confirmedBy:ownerId,createdAt}).success,true);
});
test('discovery REST contracts are owner-only and contain no review/suite/export routes',()=>{
  const routes=REST_CONTRACTS.filter(route=>route.path.includes('discovery-jobs'));
  assert.equal(routes.length,7); assert.ok(routes.every(route=>route.auth==='owner'));
  assert.ok(routes.some(route=>route.path.endsWith('/evidence/:evidenceId')));
});

test('provider attempts retain explicit unknown outcomes rather than silently reporting success or retry',()=>{
  const attempt={id:randomUUID(),projectId,jobId,kind:'qloo',operationKey:'rank-a',tryNumber:0,requestChecksum:checksum('rank'),reservedLeaseId:randomUUID(),status:'uncertain',reservedAt:createdAt,dispatchedAt:createdAt,finishedAt:createdAt,retryable:false,errorCategory:null,errorCode:null,nextDispatchAt:null};
  assert.equal(DiscoveryProviderAttemptSchema.parse(attempt).status,'uncertain');
  assert.equal(DiscoveryProviderAttemptSchema.safeParse({...attempt,retryable:true}).success,false);
  assert.equal(DiscoveryProviderAttemptSchema.safeParse({...attempt,status:'error',retryable:true,errorCategory:'auth'}).success,false);
  assert.equal(DiscoveryProviderAttemptSchema.safeParse({...attempt,status:'error',retryable:true,errorCategory:'transient',nextDispatchAt:'2026-10-13T12:00:30.000Z'}).success,true);
});
