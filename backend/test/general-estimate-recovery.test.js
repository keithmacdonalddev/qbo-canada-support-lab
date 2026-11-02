'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { buildGeneralBatch, classifyGeneralResponse } = require('../src/modules/general-write-transport');
const { createGeneralWriteService } = require('../src/modules/general-write-service');
const { sourceOf, packetOf, assertRepairedPair } = require('../src/modules/general-estimate-recovery');
const { createBlockerInspection } = require('../src/modules/business-blocker-inspection');
const clone = value => structuredClone(value);
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, ownerId = 'b'.repeat(24), clock = Date.parse('2026-11-02T05:00:00.000Z');
function incident(invoiceId = '11331', estimateId = '11217') {
  const line = { Amount: 250, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: 2, UnitPrice: 125, TaxCodeRef: { value: '7' } } };
  const payload = { TxnDate: '2026-11-02', DueDate: '2026-12-02', CustomerRef: { value: '1' }, CurrencyRef: { value: 'CAD' }, GlobalTaxCalculation: 'TaxExcluded', Line: [line], LinkedTxn: [{ TxnId: estimateId, TxnType: 'Estimate' }] };
  const original = { ...clone(payload), Id: invoiceId, SyncToken: '0', DocNumber: 'INV-' + invoiceId, TotalAmt: 285, Balance: 285, Line: [{ ...clone(line), Id: '1' }], MetaData: { CreateTime: '2026-11-02T04:00:00Z', LastUpdatedTime: '2026-11-02T04:00:00Z' }, TxnTaxDetail: { TotalTax: 35, TaxLine: [{Amount:35,DetailType:'TaxLineDetail',TaxLineDetail:{TaxRateRef:{value:'8'},TaxPercent:14,NetAmountTaxable:250}}] } }; delete original.LinkedTxn;
  const estimate = { Id: estimateId, SyncToken: '0', TxnDate: '2026-11-01', CustomerRef: clone(payload.CustomerRef), CurrencyRef: clone(payload.CurrencyRef), GlobalTaxCalculation: 'TaxExcluded', TxnStatus: 'Pending', TotalAmt: 285, TxnTaxDetail: { TotalTax: 35, TaxLine: [{Amount:35,DetailType:'TaxLineDetail',TaxLineDetail:{TaxRateRef:{value:'8'},TaxPercent:14,NetAmountTaxable:250}}] }, Line: [{ ...clone(line), Id: '1' }], MetaData: clone(original.MetaData) };
  const sent = { bId: '1', ref: 'invoice', op: 'create', operation: 'create', entity: 'Invoice', payload: clone(payload) };
  const batch = { index: 0, attempt: 1, requestId: 'd'.repeat(32), state: 'answered', sends: 1, items: [sent] };
  const response = [{ bId: '1', Invoice: clone(original) }], request = buildGeneralBatch(scope, batch), observed = classifyGeneralResponse(scope, batch, { status: 200, json: { BatchItemResponse: response } });
  const receipt = { _id: hash('receipt'), ...scope, ownerId, actorId: ownerId, kind: 'general-write', state: 'saved', requestHash: request.requestHash, observed, general: { runId: 'c'.repeat(24), batchIndex: 0, requestId: batch.requestId } };
  batch.transport = { receiptId: receipt._id, outcome: 'saved', response, items: observed.items };
  const run = { _id: 'c'.repeat(24), ...scope, ownerId, actorId: ownerId, contract: 'general-write-v1', status: 'needs-correction', day: '2026-11-02', agentAuthority: null, plan: { operations: [{ ref: 'invoice', op: 'create', entity: 'Invoice', payload: clone(payload) }], layers: [['invoice']] }, batches: [batch], items: { invoice: { outcome: 'mismatch', entity: 'Invoice', op: 'create', attempt: 1, qboId: invoiceId, version: '0', request: clone(payload), record: clone(original) } }, revision: 0, owned: [{ key: 'Invoice:' + invoiceId, ref: 'invoice', op: 'create' }], dirty: [] };
  const quotePayload={TxnDate:estimate.TxnDate,CustomerRef:clone(estimate.CustomerRef),CurrencyRef:clone(estimate.CurrencyRef),GlobalTaxCalculation:estimate.GlobalTaxCalculation,TxnStatus:'Pending',Line:[clone(line)]};
  const quoteSent={bId:'1',ref:'quote',op:'create',operation:'create',entity:'Estimate',payload:quotePayload},quoteBatch={index:0,attempt:1,requestId:'9'.repeat(32),state:'answered',sends:1,items:[quoteSent]},quoteResponse=[{bId:'1',Estimate:clone(estimate)}];
  const quoteRun={_id:'e'.repeat(24),...scope,ownerId,actorId:ownerId,contract:'general-write-v1',status:'complete',day:estimate.TxnDate,revision:0,dirty:[],owned:[{key:'Estimate:'+estimateId,ref:'quote',op:'create'}],plan:{operations:[{ref:'quote',entity:'Estimate',op:'create',payload:quotePayload}]},batches:[quoteBatch],items:{quote:{outcome:'saved',entity:'Estimate',op:'create',attempt:1,qboId:estimateId,request:clone(quotePayload),record:clone(estimate)}}};
  const quoteReceipt={_id:hash('quote-receipt'),...scope,ownerId,actorId:ownerId,kind:'general-write',state:'saved',requestHash:buildGeneralBatch(scope,quoteBatch).requestHash,observed:classifyGeneralResponse(scope,quoteBatch,{status:200,json:{BatchItemResponse:quoteResponse}}),general:{runId:quoteRun._id,batchIndex:0,requestId:quoteBatch.requestId}};quoteBatch.transport={receiptId:quoteReceipt._id,outcome:'saved',response:quoteResponse};
  const writer={_id:'company',...scope,revision:0,operationId:null,planHash:null,unresolved:null,resourceClaims:[]};
  let sends = 0, nativeReads = 0, after = false, nativeShape=false, changing = false, overlap=false, race=false, revoked=false;
  const repaired = () => { const record=({ ...clone(original), SyncToken: '1', LinkedTxn: clone(payload.LinkedTxn), MetaData: { ...original.MetaData, LastUpdatedTime: '2026-11-02T04:30:00Z' } });if(nativeShape){record.Line[0].Id='2';record.Line[0].LinkedTxn=[{TxnId:estimateId,TxnType:'Estimate',TxnLineId:'1'}];}return record;};
  const linkedEstimate = () => ({ ...clone(estimate), TxnStatus: 'Closed', LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] });
  const current = entity => clone(entity === 'Invoice' ? (after ? repaired() : original) : after ? linkedEstimate() : estimate);
  const query = value => ({ select(){return this;},sort(){return this;},limit(){return this;},session(){return this;},maxTimeMS(){return this;},lean:async()=>clone(value) });
  const models={GeneralWriteRuns:{find:filter=>query(filter.owned?[quoteRun]:[run,quoteRun]),findOne:filter=>query(filter._id===run._id?run:filter._id===quoteRun._id?quoteRun:null),findOneAndUpdate:(filter,update)=>{if(filter.revision!==run.revision)return query(null);Object.assign(run,clone(update.$set));run.revision++;return query(run);}},Receipts:{find:()=>query(overlap?[{state:'unknown'}]:[]),findOne:filter=>query(filter.environment===scope.environment&&filter.realmId===scope.realmId&&filter.connectionId===scope.connectionId?(filter._id===receipt._id?receipt:filter._id===quoteReceipt._id?quoteReceipt:null):null)},Writers:{findOne:()=>query(writer),findOneAndUpdate:(filter,update)=>{if(filter.revision!==writer.revision)return query(null);writer.revision+=update.$inc.revision;return query(writer);}},Runs:{findOne:()=>query(null)}};
  models.Users={findOne:()=>query({_id:ownerId,role:'agent',connectionSwitchVersion:0}),findOneAndUpdate:()=>query({connectionSwitchVersion:1})};models.Memberships={findOne:()=>query({_id:'member',userId:ownerId,role:'lab-owner',status:'active'}),findOneAndUpdate:()=>query({_id:'member'})};
  const service = () => createGeneralWriteService({ models, now:()=>clock, dispatchEnabled:()=>false, transaction:async work=>{const originalRun=clone(run),originalWriter=clone(writer);try{return await work({inTransaction:()=>true});}catch(error){Object.assign(run,originalRun);Object.assign(writer,originalWriter);throw error;}},authorizeRecovery:async()=>{if(revoked)throw Error('Owner authority revoked');}, contextFor:async()=>{throw Error('No new preparation');}, copy: { read:async(_scope,entity)=>current(entity), fetch:async(_scope,entity)=>{nativeReads++;const record=current(entity);if(changing&&nativeReads>2&&entity==='Invoice')record.Balance--;if(race&&nativeReads===4){writer.revision++;overlap=true;}return record;} }, transport: { sendBatch:async()=>{sends++;throw Error('No dispatch');} } });
  return { run, quoteRun, quoteReceipt, receipt, original, estimate, models, service, overlap:()=>{overlap=true;},race:()=>{race=true;},revoke:()=>{revoked=true;}, current, repaired, linkedEstimate, source:()=>sourceOf(run,'invoice',receipt), repair:()=>{after=true;},nativeRepair:()=>{after=true;nativeShape=true;}, drift:()=>{changing=true;}, counts:()=>({sends,nativeReads}), execute:()=>service().execute({scope,ownerId,actorId:ownerId},run._id) };
}
test('the two observed saved invoice shapes retain original identities and do not retry an API conversion', async () => {
  for(const [invoice,estimate] of [['11331','11217'],['11332','11218']]) {
    const h=incident(invoice,estimate), before=clone(h.run.batches), receipt=clone(h.receipt);
    for(let i=0;i<3;i++){const result=await h.execute();assert.equal(result.status,'needs-correction');assert.equal(result.items.invoice.next.action,'native-repair-required');assert.equal(result.items.invoice.next.recovery.invoiceId,invoice);assert.equal(result.items.invoice.next.recovery.estimateId,estimate);}
    assert.deepEqual(h.counts(),{sends:0,nativeReads:0});assert.deepEqual(h.run.batches,before);assert.deepEqual(h.receipt,receipt);assert.deepEqual(h.run.items.invoice.record,h.original);
  }
});
test('a restarted recovery accepts only the same actually repaired reciprocal pair and leaves original receipts intact', async () => {
  const h=incident(), before=clone(h.run.batches), receipt=clone(h.receipt);await h.execute();h.repair();
  const result=await h.execute();assert.equal(result.status,'complete');assert.equal(result.items.invoice.qboId,'11331');assert.deepEqual(h.counts(),{sends:0,nativeReads:4});assert.deepEqual(h.run.batches,before);assert.deepEqual(h.receipt,receipt);assert.deepEqual(h.run.items.invoice.originalSavedRecord,h.original);assert.equal(h.run.items.invoice.reconciliation.accountingReportVerified,false);
  const reads=h.counts().nativeReads;await h.execute();assert.equal(h.counts().nativeReads,reads);
});
test('tampered original receipt, request, returned fields, scope, or unknown siblings never establish saved recovery', () => {
  for(const change of [h=>h.receipt.observed.items[0].responseHash='0'.repeat(64),h=>h.receipt.ownerId='f'.repeat(24),h=>h.receipt.connectionId='f'.repeat(24),h=>h.receipt.general.requestId='f'.repeat(32),h=>h.run.plan.operations[0].payload.Line[0].Amount++,h=>h.run.items.invoice.request.Line[0].Amount++,h=>h.run.items.invoice.record.TotalAmt++,h=>h.run.items.other={outcome:'unknown'}]){const h=incident();change(h);assert.equal(h.source(),null);}
});
test('missing backlink, duplicate link, wrong customer, changed tax, amounts, lines, document number or payments stay held', () => {
  for(const change of [(i,e)=>delete e.LinkedTxn,(i,e)=>e.LinkedTxn.push(clone(e.LinkedTxn[0])),(i,e)=>e.CustomerRef.value='2',(i)=>i.TxnTaxDetail.TotalTax++,(i)=>i.TotalAmt++,(i)=>i.Line.push(clone(i.Line[0])),(i)=>i.Line[0].Id='2',(i)=>i.DocNumber='changed',(i)=>i.Balance--,(i)=>i.LinkedTxn.push({TxnId:'9',TxnType:'Payment'}),(i)=>i.SyncToken='0',(i)=>delete i.MetaData.LastUpdatedTime]){const h=incident(),source=h.source(),i=h.repaired(),e=h.linkedEstimate();assert.ok(source);change(i,e);assert.equal(assertRepairedPair(source,i,e),false);}
});
test('a changing native record cannot be reconciled from an earlier matching read', async () => {
  const h=incident();h.repair();h.drift();assert.equal((await h.execute()).status,'needs-correction');assert.equal(h.run.items.invoice.outcome,'mismatch');assert.equal(h.counts().sends,0);
});
test('inspection authenticates the exact general-write source without native reads or exposing record bodies', async () => {
  const h=incident(), inspect=createBlockerInspection({models:h.models,scope,now:()=>clock}), result=await inspect(h.run._id);
  assert.equal(result.success,true);assert.equal(result.data.qboRequests,0);assert.equal(result.data.estimateRecovery[0].invoiceId,'11331');assert.equal(result.data.capabilityKey,'general-native-estimate-conversion');assert.ok(!JSON.stringify(result).includes('SalesItemLineDetail'));assert.deepEqual(h.counts(),{sends:0,nativeReads:0});
});

test('an active unknown write prevents native recovery reads and a last-GET race cannot clear the mismatch',async()=>{
  const active=incident();active.repair();active.overlap();assert.equal((await active.execute()).status,'needs-correction');assert.equal(active.counts().nativeReads,0);
  const racing=incident();racing.repair();racing.race();await assert.rejects(racing.execute(),/writer changed|unresolved/);assert.equal(racing.run.items.invoice.outcome,'mismatch');assert.equal(racing.counts().sends,0);
  const revoked=incident();revoked.repair();revoked.revoke();await assert.rejects(revoked.execute(),/authority revoked/);assert.equal(revoked.run.items.invoice.outcome,'mismatch');assert.equal(revoked.counts().nativeReads,0);
});

test('reconciliation explains the source Estimate through actual general record gathering and day-close evaluation',async()=>{
  const h=incident();h.repair();await h.execute();
  const {generalRecordsFor}=require('../src/modules/general-write-day-close'),{evaluateDay}=require('../src/modules/general-write-close');
  const gathered=await generalRecordsFor({Runs:h.models.GeneralWriteRuns,scope,day:'2026-11-01',through:'2026-11-02',models:h.models,now:()=>clock,copy:{read:async(s,entity)=>h.current(entity)}});
  const ctx={receivables:'120',get:()=>({Type:'Service',IncomeAccountRef:{value:'400'}}),taxAccount:()=> '210'};
  const ledger={'Invoice:11331':[{accountId:'120',cents:28500},{accountId:'400',cents:-25000},{accountId:'210',cents:-3500}]};
  const result=evaluateDay({records:gathered.records,ledger,ctx,fromDate:'2026-11-01',throughDate:'2026-11-02'});assert.equal(result.ok,true,JSON.stringify(result));
  assert.ok(gathered.records.find(row=>row.entity==='Estimate').evidence.accountant.estimateConversion);
  assert.equal(h.quoteRun.items.quote.record.TxnStatus,'Pending');assert.equal(h.quoteRun.items.quote.request.TxnStatus,'Pending');
  h.run.items.invoice.reconciliation.sourceEstimate.recordHash='0'.repeat(64);
  const bad=await generalRecordsFor({Runs:h.models.GeneralWriteRuns,scope,day:'2026-11-01',models:h.models,now:()=>clock,copy:{read:async(s,entity)=>h.current(entity)}});
  assert.equal(evaluateDay({records:bad.records,ledger:{},ctx,fromDate:'2026-11-01'}).ok,false,'missing authentic source proof cannot clear the Estimate change');
});

test('missing, malformed or backwards source Estimate metadata cannot establish recovery or closure',()=>{
 const {assertEstimateTransition}=require('../src/modules/general-estimate-recovery');
 for(const change of [e=>delete e.MetaData,e=>e.MetaData.LastUpdatedTime='invalid',e=>e.MetaData.LastUpdatedTime='2026-11-01T00:00:00Z',e=>e.MetaData.CreateTime='2026-11-01T00:00:00Z']){const h=incident(),current=h.linkedEstimate();change(current);assert.equal(assertEstimateTransition(h.estimate,current,'11331'),false);}
});
test('workspace selection or membership revoked at authoritative settlement preserves the original mismatch',async()=>{
 for(const model of ['Users','Memberships']){const h=incident();h.repair();h.models[model].findOneAndUpdate=()=>({lean:async()=>null});await assert.rejects(h.execute(),/workspace|permission/);assert.equal(h.run.items.invoice.outcome,'mismatch');assert.equal(h.counts().sends,0);}
});
test('missing transactional recovery adapters keep the saved mismatch without native reads',async()=>{
 const h=incident();h.repair();delete h.models.Writers;assert.equal((await h.execute()).status,'needs-correction');assert.equal(h.counts().nativeReads,0);
});

test('native whole-Estimate replacement proves the exact single financial line and retains original identities',async()=>{
 const h=incident();h.nativeRepair();assert.equal((await h.execute()).status,'complete');assert.equal(h.run.items.invoice.qboId,'11331');assert.equal(h.run.items.invoice.record.Line.length,1);assert.equal(h.run.items.invoice.record.Line[0].Id,'2');assert.equal(h.run.items.invoice.originalSavedRecord.Line[0].Id,'1');assert.equal(h.counts().sends,0);
 const {generalRecordsFor}=require('../src/modules/general-write-day-close');const gathered=await generalRecordsFor({Runs:h.models.GeneralWriteRuns,scope,day:'2026-11-01',models:h.models,now:()=>clock,copy:{read:async(s,entity)=>h.current(entity)}});assert.ok(gathered.records[0].evidence.accountant.estimateConversion);
});
test('native line replacement rejects another source, duplicate link, altered amounts and unavailable original source',()=>{
 for(const change of [i=>i.Line[0].LinkedTxn[0].TxnId='999',i=>i.Line[0].LinkedTxn.push(clone(i.Line[0].LinkedTxn[0])),i=>i.Line[0].LinkedTxn[0].TxnLineId='999',i=>i.Line[0].Amount++,i=>i.Line.push(clone(i.Line[0]))]){const h=incident();h.nativeRepair();const i=h.repaired();change(i);assert.equal(assertRepairedPair(h.source(),i,h.linkedEstimate(),h.estimate),false);}
 const h=incident();h.nativeRepair();assert.equal(assertRepairedPair(h.source(),h.repaired(),h.linkedEstimate()),false);
});

test('successful recovery with retained unsent work returns prepared without dispatching any sibling',async()=>{
 const h=incident();h.run.plan.operations.push({ref:'later-customer',op:'create',entity:'Customer',payload:{DisplayName:'Unsent fictional customer'}});h.repair();assert.equal((await h.execute()).status,'prepared');assert.equal(h.run.items.invoice.outcome,'saved');assert.equal(h.run.items['later-customer'],undefined);assert.equal(h.counts().sends,0);
});
