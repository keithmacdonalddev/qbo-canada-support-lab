'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createGeneralUnsentRetirement } = require('../src/modules/general-write-unsent');
const { createGeneralCloseGate } = require('../src/modules/general-write-close-gate');
const { createGeneralWriteService } = require('../src/modules/general-write-service');
const { collectBusinessBlockers } = require('../src/modules/business-error-detail');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, clock = () => Date.parse('2026-11-01T03:16:00Z');
const valueAt = (row, key) => key.split('.').reduce((v, k) => v?.[k], row);
const match = (row, filter) => Object.entries(filter).every(([key, value]) => key === '$or' ? value.some(f => match(row, f)) : value && typeof value === 'object' && '$in' in value ? value.$in.includes(valueAt(row,key)) : String(valueAt(row,key)) === String(value));
const query = get => ({ select(){return this;}, sort(){return this;}, limit(){return this;}, maxTimeMS(){return this;}, session(){return this;}, lean:async()=>structuredClone(get()) });
function fixture(overrides = {}) {
  const run = { _id:'b'.repeat(24), ...scope, ownerId:'c'.repeat(24), actorId:'c'.repeat(24), contract:'general-write-v1', status:'prepared', revision:4, day:'2026-10-31', plan:{operations:[{ref:'deposit',op:'create',entity:'Deposit',payload:{TxnDate:'2026-10-31'}}],layers:[['deposit']]}, items:{}, owned:[], dirty:[], batches:[{index:0,attempt:1,requestId:'d'.repeat(32),state:'sending',sends:0,items:[{ref:'deposit',entity:'Deposit',op:'create',operation:'create',payload:{TxnDate:'2026-10-31'}}]}], ...overrides };
  const rows = [run], receipts = [], writers = [{...scope,unresolved:null,resourceClaims:[]}], audits = [];
  const table = values => ({find: filter=>query(()=>values.filter(r=>match(r,filter))),findOne:filter=>query(()=>values.find(r=>match(r,filter))||null),create:async docs=>values.push(...structuredClone(docs))});
  const Runs = {...table(rows), findOneAndUpdate:(filter,update)=>query(()=>{const row=rows.find(r=>match(r,filter));if(!row)return null;Object.assign(row,structuredClone(update.$set||{}));row.revision+=(update.$inc?.revision||0);return row;})};
  const models={GeneralWriteRuns:Runs,Receipts:table(receipts),Writers:table(writers),Audits:table(audits),GeneralDayCloses:table([]),Records:table([]),transaction:async work=>{const old=structuredClone(rows);try{return await work({inTransaction:()=>true});}catch(e){rows.splice(0,rows.length,...old);throw e;}}};
  return {run,rows,receipts,writers,audits,models,retirement:createGeneralUnsentRetirement({models,now:clock})};
}
const args={fromDate:'2026-10-31',throughDate:'2026-10-31',verifiedThrough:'2026-10-30',mappings:{},readLedger:async()=>{throw Error('unsent work must need no ledger');}};
test('prior-day zero-send requests expire exactly once, audit atomically, and no longer block real close entry',async()=>{
 const h=fixture();const gate=createGeneralCloseGate({models:h.models,copy:{read:async()=>null},now:clock});
 assert.deepEqual(await gate.assertPeriodReady(scope,args),{required:false,results:[]});
 assert.equal(h.rows[0].status,'expired-unsent');assert.equal(h.audits.length,1);assert.equal(h.audits[0].afterState.qboWrites,0);
 assert.equal(h.rows[0].batches[0].requestId,'d'.repeat(32));
 await gate.assertPeriodReady(scope,args);assert.equal(h.audits.length,1);
});
test('current-day unsent plans do not delay close and remain available',async()=>{
 const h=fixture({day:'2026-11-01'});const gate=createGeneralCloseGate({models:h.models,copy:{read:async()=>null},now:clock});
 assert.equal((await gate.assertPeriodReady(scope,args)).required,false);assert.equal(h.rows[0].status,'prepared');assert.equal(h.audits.length,0);
});
for(const kind of ['receipt','lost','sends','transport','unknown','item','writer','claim','dirty','owned'])test(kind+' evidence prevents expiry; unresolved dispatch still blocks close',async()=>{
 const h=fixture();
 if(kind==='receipt')h.receipts.push({...scope,kind:'general-write',general:{runId:h.run._id,batchIndex:0,requestId:'d'.repeat(32)},state:'possibly-sent'});
 if(kind==='lost')h.run.batches[0].state='lost';
 if(kind==='sends')h.run.batches[0].sends=1;
 if(kind==='transport')h.run.batches[0].transport={receiptId:'receipt'};
 if(kind==='unknown')h.run.status='unknown';
 if(kind==='item')h.run.items={deposit:{outcome:'unknown',entity:'Deposit'}};
 if(kind==='writer')h.writers[0].unresolved={runId:h.run._id};
 if(kind==='claim')h.writers[0].resourceClaims=[{runId:h.run._id}];
 if(kind==='dirty')h.run.dirty=[{date:'2026-10-30'}];
 if(kind==='owned')h.run.owned=[{key:'Deposit:123'}];
 assert.notEqual((await h.retirement.retire(scope,h.run)).status,'expired-unsent');assert.equal(h.audits.length,0);
 const gate=createGeneralCloseGate({models:h.models,copy:{read:async()=>null},now:clock});
 if(!['dirty','owned'].includes(kind))await assert.rejects(gate.assertPeriodReady(scope,args),/unsettled batch/);
});
test('audit failure rolls back expiry',async()=>{const h=fixture();h.models.Audits.create=async()=>{throw Error('audit unavailable');};const api=createGeneralUnsentRetirement({models:h.models,now:clock});await assert.rejects(api.retire(scope,h.run),/audit unavailable/);assert.equal(h.rows[0].status,'prepared');});
test('concurrent run update refuses retirement before audit',async()=>{const h=fixture();h.models.GeneralWriteRuns.findOneAndUpdate=()=>query(()=>null);await assert.rejects(h.retirement.retire(scope,h.run),/changed during unsent expiry/);assert.equal(h.audits.length,0);});
test('executing old unsent work returns replan without reaching transport or guards',async()=>{const h=fixture();let sent=0;const api=createGeneralWriteService({models:h.models,copy:{},now:clock,dispatchEnabled:()=>true,contextFor:async()=>{throw Error('no guard');},transport:{sendBatch:async()=>sent++}});const result=await api.execute({scope,ownerId:h.run.ownerId,actorId:h.run.actorId},h.run._id);assert.equal(result.status,'expired-unsent');assert.equal(result.next.action,'replan');assert.equal(result.next.day,'2026-11-01');assert.equal(sent,0);});
test('expired work and definite day-change refusals are absent from blocker list, unknown outcomes remain',()=>{const errorDetail={code:'QBO_WRITE_ADMISSION_DENIED',message:'The business day changed since this general write was prepared. Nothing was sent.',detail:{qboStage:'write_admission',outcomeUnknown:false}};const generalRuns=[{_id:'old',status:'prepared',errorDetail},{_id:'expired',status:'expired-unsent',errorDetail},{_id:'unknown',status:'unknown',errorDetail:{...errorDetail,code:'QBO_WRITE_OUTCOME_UNKNOWN',detail:{qboStage:'write_receipt',outcomeUnknown:true}}}];const result=collectBusinessBlockers({generalRuns,now:clock()});assert.deepEqual(result.flatMap(b=>b.sources.map(s=>s.id)),['unknown']);});
module.exports={fixture,scope,query,match};

test('crash after saving a batch but before counting a send remains provably unsent',async()=>{const h=fixture();delete h.run.batches[0].sends;assert.equal((await h.retirement.retire(scope,h.run)).status,'expired-unsent');assert.equal(h.audits.length,1);});

test('mixed saved non-posting records and expired unsent batches pass first close without a stale snapshot',async()=>{const h=fixture();const saved={Id:'44',SyncToken:'0',TxnDate:'2026-10-31',Line:[]};h.rows.push({_id:'e'.repeat(24),...scope,contract:'general-write-v1',day:'2026-10-31',status:'complete',revision:5,plan:{operations:[{ref:'quote',op:'create',entity:'Estimate',payload:saved}]},items:{quote:{op:'create',entity:'Estimate',outcome:'saved',qboId:'44',request:saved,record:saved}},batches:[],dirty:[]});const gate=createGeneralCloseGate({models:h.models,copy:{read:async(s,e,id)=>e==='Estimate'&&id==='44'?saved:null},now:clock});const ledger={Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',StartPeriod:'2026-10-31',EndPeriod:'2026-10-31'},Columns:{Column:['tx_date','txn_type','debt_amt','credit_amt'].map(ColType=>({ColType}))},Rows:{Row:[]}};const result=await gate.assertPeriodReady(scope,{...args,readLedger:async()=>ledger});assert.equal(result.results[0].ok,true);assert.equal(result.results[0].recordCount,1);assert.equal(h.audits.length,1);});
test('midnight during guardBatch retains the typed definite-unsent refusal',async()=>{const h=fixture();const api=createGeneralWriteService({models:h.models,copy:{read:async()=>null},now:clock,contextFor:async()=>({day:'2026-11-01'})});await assert.rejects(api.guardBatch({scope,run:{...h.run,plan:{operations:[]}},batch:{items:[]}}),e=>e.code==='GENERAL_WRITE_DAY_CHANGED'&&e.qboStage==='write_admission'&&e.outcomeUnknown===false);});
test('midnight during transport admission retires the exact unsent request without a retry',async()=>{const h=fixture();let at=Date.parse('2026-11-01T02:59:00Z'),calls=0;const api=createGeneralWriteService({models:h.models,copy:{},now:()=>at,dispatchEnabled:()=>true,contextFor:async()=>{throw Error('guard unexpected');},transport:{sendBatch:async()=>{calls++;at=clock();throw Object.assign(Error('day changed'),{code:'GENERAL_WRITE_DAY_CHANGED',qboStage:'write_admission',outcomeUnknown:false});}}});const result=await api.execute({scope},h.run._id);assert.equal(result.status,'expired-unsent');assert.equal(calls,1);assert.equal(h.rows[0].batches[0].sends,0);assert.equal(h.audits.length,1);});
test('unknown state with a stale definite day refusal stays a blocker',()=>{const blockers=collectBusinessBlockers({generalRuns:[{_id:'unknown',status:'unknown',errorDetail:{code:'GENERAL_WRITE_DAY_CHANGED',message:'Day changed',detail:{qboStage:'write_admission',outcomeUnknown:false}}}],now:clock()});assert.equal(blockers.length,1);});

test('Estimate receipt omission and CDC FreeFormAddress false close equally; true and economics remain distinct',()=>{const {sameProvenRecord}=require('../src/modules/general-write-close');const {hash}=require('../src/modules/business-calendar');const saved={Id:'11209',SyncToken:'0',TxnDate:'2026-10-31',Line:[{Amount:100,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:'40'}}}]};const expected=hash(saved);assert.equal(sameProvenRecord('Estimate',saved,{...saved,FreeFormAddress:false},expected),true);assert.equal(sameProvenRecord('Estimate',saved,{...saved,FreeFormAddress:true},expected),false);assert.equal(sameProvenRecord('Estimate',saved,{...saved,FreeFormAddress:false,Line:[{...saved.Line[0],Amount:101}]},expected),false);assert.equal(sameProvenRecord('Invoice',saved,{...saved,FreeFormAddress:false},expected),false);});

test('receipt calendar gate waits at Oct30 and releases after Oct31 closes',()=>{const {assertBatchPreparation}=require('../src/modules/business-activity-batch');const active={calendar:{verifiedThrough:'2026-10-30'}};const batch={day:'2026-11-01',activities:[{type:'receive-purchase-order'}]};assert.throws(()=>assertBatchPreparation(active,batch,clock()),/Inventory receiving waits for earlier open days/);active.calendar.verifiedThrough='2026-10-31';assert.doesNotThrow(()=>assertBatchPreparation(active,batch,clock()));});

test('midnight while preparing a new batch retires a wholly unsent plan',async()=>{const h=fixture({batches:[]});let at=Date.parse('2026-11-01T02:59:00Z');const api=createGeneralWriteService({models:h.models,copy:{read:async()=>null},now:()=>at,dispatchEnabled:()=>true,contextFor:async()=>{at=clock();return {day:'2026-11-01'};},transport:{sendBatch:async()=>{throw Error('transport must not run');}}});assert.equal((await api.execute({scope},h.run._id)).status,'expired-unsent');assert.equal(h.audits.length,1);});
