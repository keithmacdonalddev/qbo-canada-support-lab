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
