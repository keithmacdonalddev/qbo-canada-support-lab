'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { collectionReadiness } = require('../src/modules/business-collection-readiness');
const scope = { environment:'sandbox', realmId:'123456', connectionId:'a'.repeat(24) };
const query = value => ({select(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>value});
function fixture(){
  const run={_id:'b'.repeat(24),status:'retired',approval:null,nextOrdinal:0,activityBatch:{day:'2026-10-29',decisionKey:'old-collection-key'}};
  const state={runs:[run],effect:null};
  const none={findOne:()=>query(state.effect)};
  return {state,run,input:{scope,day:'2026-10-31',calendar:{adoption:{kind:'adopted-history',jobId:'job',importedThrough:'2026-10-17'},verifiedThrough:'2026-10-30',currentOperationId:'c'.repeat(24)},models:{Jobs:{findOne:()=>query({status:'adopted',authorityHash:'authority'})},PopulationRecords:{find:()=>query(Array.from({length:6},(_,i)=>({qboId:String(i+1)})))},Records:{find:()=>query([28386,16986,22686,28500,28386,34200].map((c,i)=>({qboId:String(i+1),summary:{balanceCents:c}})))},Runs:{find:()=>query(state.runs)},Receipts:none,Steps:none,Intents:none}}};
}
test('six eligible invoices and cleared key supersede stale notes while current operation still gates preparation',async()=>{
 const f=fixture(),value=await collectionReadiness(f.input);
 assert.equal(value.eligibleInvoiceCount,6);assert.equal(value.eligibleBalanceCents,159144);
 assert.deepEqual(value.reusableDecisionKeys,['old-collection-key']);assert.equal(value.readyForNewBatch,false);
 assert.match(value.message,/hold is cleared/);assert.match(value.message,/are usable again/);assert.match(value.message,/notes.*stale/);assert.match(value.message,/Finish any current operation first/);
 f.input.calendar.currentOperationId=null;assert.equal((await collectionReadiness(f.input)).readyForNewBatch,true);
});
test('saved effects, approvals, pending execution and any earlier used key prevent reusable-key advice',async()=>{
 for(const change of [f=>f.state.effect={_id:'effect'},f=>f.run.approval={at:'saved'},f=>f.run.executionRequest={pending:true},f=>f.run.nextOrdinal=1,f=>f.state.runs.push({...f.run,_id:'d'.repeat(24),status:'verified'})]){
  const f=fixture();change(f);assert.deepEqual((await collectionReadiness(f.input)).reusableDecisionKeys,[]);
 }
});

test('large adopted history checks only complete current due invoices against exact import proof',async()=>{
 const f=fixture(),calls=[],history=Array.from({length:2063},(_,i)=>({qboId:String(10000+i)}));
 const due=[{qboId:'10000',summary:{balanceCents:12345}},{qboId:'10001',summary:{balanceCents:23456}},{qboId:'99999',summary:{balanceCents:34567}}];
 f.input.models.Records.find=filter=>{calls.push({kind:'current',filter});return query(due);};
 f.input.models.PopulationRecords.find=filter=>{calls.push({kind:'imported',filter});const selected=filter.qboId?.$in;return query((selected?history.filter(row=>selected.includes(row.qboId)):history).slice(0,2001));};
 const value=await collectionReadiness(f.input);
 assert.equal(value.unavailable,undefined);assert.equal(value.eligibleInvoiceCount,2);assert.equal(value.eligibleBalanceCents,35801);
 assert.deepEqual(value.eligibleInvoices.map(row=>row.invoiceId),['10000','10001']);
 assert.deepEqual(calls.map(row=>row.kind),['current','imported']);
 const live=calls[0].filter,proof=calls[1].filter;
 for(const filter of [live,proof])for(const key of ['environment','realmId','connectionId'])assert.equal(filter[key],scope[key]);
 assert.equal(live.entity,'Invoice');assert.equal(live.deleted,false);assert.deepEqual(live['summary.balanceCents'],{$gt:0});assert.deepEqual(live['summary.dueDate'],{$lte:f.input.day});
 assert.equal(proof.authorityHash,'authority');assert.equal(proof.entity,'Invoice');assert.equal(proof.state,'saved');assert.equal(proof['financialProof.matchesFinancialIntent'],true);assert.deepEqual(proof['relationshipCheck.outcome'],{$ne:'error'});assert.deepEqual(proof.txnDate,{$lte:f.input.calendar.adoption.importedThrough});
 assert.deepEqual(proof.qboId,{$in:due.map(row=>row.qboId)});
});

test('zero eligible imports is known without enumerating the entire retained history',async()=>{
 const f=fixture();let importFilter;
 f.input.models.Records.find=()=>query([{qboId:'current-only',summary:{balanceCents:123}}]);
 f.input.models.PopulationRecords.find=filter=>{importFilter=filter;return query([]);};
 const value=await collectionReadiness(f.input);assert.equal(value.unavailable,undefined);assert.equal(value.eligibleInvoiceCount,0);assert.equal(value.eligibleBalanceCents,0);assert.deepEqual(value.eligibleInvoices,[]);assert.deepEqual(importFilter.qboId,{$in:['current-only']});
});

test('truncated current or retained-proof reads never claim collection readiness',async()=>{
 for(const stage of ['current','imported']){
  const f=fixture(),tooMany=Array.from({length:2001},(_,i)=>({qboId:String(i),summary:{balanceCents:1}}));let imports=0;
  f.input.models.Records.find=()=>query(stage==='current'?tooMany:[{qboId:'1',summary:{balanceCents:1}}]);
  f.input.models.PopulationRecords.find=()=>{imports++;return query(tooMany);};
  assert.deepEqual(await collectionReadiness(f.input),{unavailable:true});if(stage==='current')assert.equal(imports,0,'do not read import proof after an incomplete current set');
 }
});
