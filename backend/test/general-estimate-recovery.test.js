'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { buildGeneralBatch, classifyGeneralResponse } = require('../src/modules/general-write-transport');
const { createGeneralWriteService } = require('../src/modules/general-write-service');
const { sourceOf, packetOf, assertRepairedPair } = require('../src/modules/general-estimate-recovery');
const { createBlockerInspection } = require('../src/modules/business-blocker-inspection');
const clone = value => structuredClone(value);
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, ownerId = 'b'.repeat(24), clock = Date.parse('2026-11-02T05:00:00.000Z');
const {incident}=require('./helpers/general-estimate-fixture');
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
