'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBusinessAgentStore}=require('../src/modules/business-agent-store');
test('older unanswered owner decisions precede newer answered history and responses use the exact lookup variable',async()=>{
 const agentId='a'.repeat(24),at=new Date('2026-10-23T10:00:00Z');
 const decisions=Array.from({length:25},(_,i)=>({_id:String(i+1).padStart(24,'0'),agentId,kind:'decision',role:'accountant',title:'Decision '+i,detail:'Retained evidence',at:new Date(at.getTime()+i*1000),data:{}}));
 const responses=decisions.slice(1).map((d,i)=>({_id:String(100+i).padStart(24,'0'),agentId,kind:'decision-response',role:'owner',title:'Owner accepted',detail:'Accepted by owner',at:d.at,data:{decisionId:d._id,choice:'accept'}}));
 const Events={collection:{name:'fixture_events'},aggregate(pipeline){return{option:async()=>{
  const lookup=pipeline.find(p=>p.$lookup).$lookup;assert.equal(lookup.let.decisionId,'$_id');
  const operands=lookup.pipeline[0].$match.$expr.$eq;
  const result=decisions.map(d=>{const resolve=(term,r)=>term==='$$decisionId'?d._id:term.split('.').reduce((v,k)=>v?.[k],{$data:r.data,$decisionId:r.decisionId});const joined=responses.filter(r=>resolve(operands[0],r)===resolve(operands[1],r));return{...d,responses:joined,answered:joined.length>0};});
  result.sort((a,b)=>Number(a.answered)-Number(b.answered)||b.at-a.at);return result.slice(0,20);
 }}}};
 const store=createBusinessAgentStore({models:{Agents:{},Events},connection:{},transaction:async work=>work({})});
 const result=await store.decisions({_id:agentId});assert.equal(result[0].id,decisions[0]._id);assert.equal(result[0].status,'pending');assert.equal(result[1].status,'accept');assert.equal(result[1].response.detail,'Accepted by owner');
});

// Continuous-business Phase 1 (Sol review findings 1–2): fresh admission counts and unfinished owned work.
test('today counts are cached for display only; fresh reads and forgetToday bypass the cache',async()=>{
 let reads=0;const chain=rows=>({select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>rows});
 const store=createBusinessAgentStore({models:{Agents:{},Events:{},Runs:{find:()=>{reads++;return chain([]);}},Plans:{find:()=>chain([])},Receipts:{find:()=>chain([])}},connection:{},transaction:async work=>work({}),now:()=>0});
 const scope={environment:'production',realmId:'1',connectionId:'c'.repeat(24)};
 await store.todayActivity(scope,'a','2026-10-30');await store.todayActivity(scope,'a','2026-10-30');assert.equal(reads,1);
 await store.todayActivity(scope,'a','2026-10-30',{fresh:true});assert.equal(reads,2,'admission never trusts the display cache');
 store.forgetToday();await store.todayActivity(scope,'a','2026-10-30');assert.equal(reads,3);
});
test('unfinished owned operations are found whether or not they hold the calendar slot',async()=>{
 let query;const chain=rows=>({select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>rows});
 const row={_id:'7'.repeat(24),status:'approved',fromDate:'2026-10-30',throughDate:'2026-10-30',activityBatch:{day:'2026-10-30'},agentAuthority:{agentId:'a'},executionRequest:null,nextOrdinal:0};
 const store=createBusinessAgentStore({models:{Agents:{},Events:{},Runs:{find:value=>{query=value;return chain([row]);}}},connection:{},transaction:async work=>work({})});
 const runs=await store.unfinishedRuns({environment:'production',realmId:'1',connectionId:'c'.repeat(24)},'a');
 assert.deepEqual([...query.status.$in].sort(),['approved','awaiting-evidence','blocked','committing','reserved','running','stopped']);assert.equal(query['agentAuthority.agentId'],'a');
 assert.deepEqual(runs,[{operationId:'7'.repeat(24),status:'approved',planHash:null,fromDate:'2026-10-30',throughDate:'2026-10-30',day:'2026-10-30',agentAuthority:{agentId:'a'},executionPending:false,completedRecords:0,holdsSlot:false,disposition:'continue'}]);
});

// GPT-6.1 Sol round-2 review (2026-10-30) findings 1 and 3.
test('unfinished work is filtered by grant in the query and classified from saved effects',async()=>{
 const chain=rows=>({select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>rows});
 const found=value=>({maxTimeMS:async()=>value});
 const rows=[
  {_id:'1'.repeat(24),status:'stopped',planHash:'p'.repeat(64),agentAuthority:{agentId:'a',grantId:'g'},nextOrdinal:0},
  {_id:'2'.repeat(24),status:'stopped',planHash:'p'.repeat(64),agentAuthority:{agentId:'a',grantId:'g'},nextOrdinal:0},
  {_id:'3'.repeat(24),status:'blocked',planHash:'p'.repeat(64),agentAuthority:{agentId:'a',grantId:'g'},nextOrdinal:2},
  {_id:'4'.repeat(24),status:'stopped',planHash:'p'.repeat(64),agentAuthority:{agentId:'a',grantId:'g'},nextOrdinal:1},
  {_id:'5'.repeat(24),status:'approved',planHash:'p'.repeat(64),agentAuthority:{agentId:'a',grantId:'g'},executionRequest:{pending:true},nextOrdinal:0},
 ];
 let query;
 const models={Agents:{},Events:{},Runs:{find:value=>{query=value;return chain(rows);}},
  Calendars:{findOne:()=>chain({currentOperationId:'3'.repeat(24)})},Writers:{findOne:()=>chain({operationId:null})},
  Receipts:{exists:filter=>found(String(filter.operationId)==='4'.repeat(24)?{_id:'r'}:null)},
  Steps:{exists:filter=>found(String(filter.operationId)==='2'.repeat(24)?{_id:'s'}:null)}};
 const store=createBusinessAgentStore({models,connection:{},transaction:async work=>work({})});
 const runs=await store.unfinishedRuns({environment:'production',realmId:'1',connectionId:'c'.repeat(24)},'a',{id:'g',authorityHash:'h'});
 assert.equal(query['agentAuthority.grantId'],'g');assert.equal(query['agentAuthority.authorityHash'],'h','older grants are excluded before the limit');
 assert.deepEqual(runs.map(run=>[run.operationId[0],run.disposition,run.holdsSlot]),[['1','unsent',false],['2','stranded',false],['3','continue',true],['4','stranded',false],['5','active',false]]);
});
