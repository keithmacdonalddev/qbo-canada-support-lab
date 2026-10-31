'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBusinessAgentStore}=require('../src/modules/business-agent-store');
const cadence=require('../src/modules/business-agent-cadence');
const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)},day='2026-12-02',agentId='b'.repeat(24),clock=Date.parse(day+'T15:00:00Z');
function fixture(general){
  const sessions=[];const chain=rows=>({select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},session(value){sessions.push(value);return this;},lean:async()=>structuredClone(rows)});
  const models={Agents:{},Events:{},Runs:{find:()=>chain([])},Plans:{find:()=>chain([])},Receipts:{find:()=>chain([])},GeneralWriteRuns:{find:filter=>{assert.equal(filter.day,day);assert.equal(filter['agentAuthority.agentId'],agentId);return chain(general);}}};
  return {store:createBusinessAgentStore({models,connection:{},transaction:async work=>work({}),now:()=>clock}),sessions};
}
const plan={operations:[{ref:'inv',op:'create'},{ref:'pay',op:'create'},{ref:'later',op:'create'}]};
test('general writes count saved records and unresolved reservations once toward the daily ceiling',async()=>{
  const run={_id:'run',status:'unknown',decisionKey:'general-day',createdAt:new Date(clock),plan,items:{inv:{outcome:'saved',entity:'Invoice'},pay:{outcome:'mismatch',entity:'Payment'}},batches:[{items:[{bId:'1',ref:'inv',entity:'Invoice'}],transport:{items:[{bId:'1',outcome:'saved'}]}}]};
  const h=fixture([run]),session={inTransaction:()=>true};
  const facts=await h.store.todayActivity(scope,agentId,day,{fresh:true,session});
  const today=cadence.summarizeToday({rhythm:{...cadence.dayRhythm(day),target:1,ceiling:3},...facts,now:clock});
  assert.equal(today.saved,2);assert.equal(today.reserved,1);assert.equal(today.ceilingReached,true);assert.equal(facts.receipts.length,2);assert.ok(h.sessions.every(value=>value===session));
  run.status='complete';run.items.later={outcome:'saved',entity:'Bill'};
  const done=cadence.summarizeToday({rhythm:cadence.dayRhythm(day),...await h.store.todayActivity(scope,agentId,day,{fresh:true}),now:clock});
  assert.equal(done.saved,3);assert.equal(done.reserved,0);
});

test('unsent held general plans expire and definite refused items do not reserve the whole day',async()=>{
  const h=fixture([{_id:'held',status:'held',createdAt:new Date(clock-86400000),plan,items:{},batches:[]},{_id:'faulted',status:'needs-correction',createdAt:new Date(clock),plan,items:{inv:{outcome:'saved',entity:'Invoice'},pay:{outcome:'fault',entity:'Payment'}},batches:[{state:'answered',items:[]}]}]);
  const today=cadence.summarizeToday({rhythm:cadence.dayRhythm(day),...await h.store.todayActivity(scope,agentId,day,{fresh:true}),now:clock});
  assert.equal(today.saved,1);assert.equal(today.reserved,0);
});

test('same-key unsent general retries cannot bypass the request budget or execute permission',async()=>{
  const generalModule=require('../src/modules/general-write-service'),original=generalModule.createDefaultGeneralWrite;
  let prepared=0,sends=0,authorized=0;
  generalModule.createDefaultGeneralWrite=()=>({prepare:async()=>({runId:'r',status:'prepared',reused:prepared++>0,admitted:false,plan:{operations:1}}),dispatchEnabled:()=>true,execute:async()=>{sends++;return{};}});
  try{
    const tools=require('../src/modules/business-agent-tools').createBusinessAgentTools({row:{_id:agentId,ownerId:'c'.repeat(24),grant:{id:'grant',authorityHash:'authority'},settings:{}},scope,user:{id:'c'.repeat(24)},guard:async()=>{},store:{business:async()=>({blockers:[]}),models:{}},access:{authorize:async(scope,permission)=>{if(permission==='operations.execute')authorized++;}},readTools:{toolDefinitions:[],toolHandlers:{}},todayFor:async()=>({target:100,ceiling:200,saved:0,reserved:1,reservedByRun:{r:1}}),requestsFor:async()=>({today:{attempts:{read:10000,query:0,report:0,sync:0,write:0}},month:{attempts:{read:10000,query:0,report:0,sync:0,write:0}}})});
    const input={decisionKey:'quota-retry',purpose:'Record a genuine customer addition.',operations:[{ref:'cust',op:'create',entity:'Customer',payload:{DisplayName:'Clinic'}}]};
    await assert.rejects(tools.execute('manageQboRecord',input),/request budget/);
    await assert.rejects(tools.execute('manageQboRecord',input),/request budget/);
    assert.equal(sends,0);assert.equal(authorized,2);
  }finally{generalModule.createDefaultGeneralWrite=original;}
});

test('general tool checks the full proposed record count against remaining daily capacity',async()=>{
  const generalModule=require('../src/modules/general-write-service'),original=generalModule.createDefaultGeneralWrite;let sends=0;
  generalModule.createDefaultGeneralWrite=()=>({prepare:async()=>({runId:'r',status:'prepared',admitted:false}),dispatchEnabled:()=>true,execute:async()=>{sends++;}});
  try{
    const tools=require('../src/modules/business-agent-tools').createBusinessAgentTools({row:{_id:agentId,ownerId:'c'.repeat(24),grant:{id:'grant',authorityHash:'authority'},settings:{}},scope,user:{id:'c'.repeat(24)},guard:async()=>{},store:{business:async()=>({blockers:[]}),models:{}},access:{authorize:async()=>{}},readTools:{toolDefinitions:[],toolHandlers:{}},todayFor:async()=>({target:2,ceiling:4,saved:3,reserved:2,reservedByRun:{r:2},ceilingReached:true})});
    await assert.rejects(tools.execute('manageQboRecord',{decisionKey:'quota-room',purpose:'Record two new customer additions.',operations:[{ref:'cust1',op:'create',entity:'Customer',payload:{DisplayName:'One'}},{ref:'cust2',op:'create',entity:'Customer',payload:{DisplayName:'Two'}}]}),/ceiling does not have room/);
    assert.equal(sends,0);
  }finally{generalModule.createDefaultGeneralWrite=original;}
});

test('general edits and deletions do not count as newly created daily records',async()=>{
  const run={_id:'changes',status:'complete',createdAt:new Date(clock),plan:{operations:[{ref:'edit',op:'update'},{ref:'gone',op:'delete'}]},items:{edit:{outcome:'saved',entity:'Invoice'},gone:{outcome:'deleted',entity:'Bill'}},batches:[{items:[]}]};
  const h=fixture([run]);const today=cadence.summarizeToday({rhythm:cadence.dayRhythm(day),...await h.store.todayActivity(scope,agentId,day,{fresh:true}),now:clock});
  assert.equal(today.saved,0);assert.equal(today.reserved,0);
});

test('daily creation totals exclude updates and deletions and do not claim ledger verification at service completion', async () => {
  const run = { _id: 'mixed', status: 'complete', createdAt: new Date(clock), plan: { operations: [{ ref: 'new', op: 'create', entity: 'Invoice' }, { ref: 'edit', op: 'update', entity: 'Bill' }, { ref: 'remove', op: 'delete', entity: 'Invoice' }] }, items: { new: { outcome: 'saved', entity: 'Invoice' }, edit: { outcome: 'saved', entity: 'Bill' }, remove: { outcome: 'deleted', entity: 'Invoice' } }, batches: [] };
  const h = fixture([run]), today = cadence.summarizeToday({ rhythm: cadence.dayRhythm(day), ...await h.store.todayActivity(scope, agentId, day, { fresh: true }), now: clock });
  assert.equal(today.saved, 1); assert.equal(today.verified, 0); assert.equal(today.reserved, 0);
});
