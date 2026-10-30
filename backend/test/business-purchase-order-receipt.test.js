'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { fixture, scope } = require('./helpers/business-transaction-fixtures');
const { bindBusinessReference } = require('../src/modules/business-reference');
const { POLICY, makeActivityBatch, buildBatchActivity, batchLifecycle, validateChoices } = require('../src/modules/business-activity-batch');
function receiving() {
  const f = fixture('Bill'), source = f.parents[0], d = f.step.details;
  d.vendorKey = 'stock-supplier-1'; d.lines[0].itemKey = 'workshop-stock-1'; d.lines[0].key = source.record.Line[0].Id; d.lines[0].unit = 'each'; d.dueDate = f.step.txnDate;
  d.activityBatch = { key: hash('receiving batch'), index: 0, stepKey: 'receive-bill', purpose: 'Receive the whole stock order at its original cost.' };
  d.purchaseOrderReceipt = { purchaseOrderId: source.qboId, source: { kind: 'managed', logicalKey: source.logicalKey, txnDate: source.record.TxnDate } };
  for (const [entity,key] of [['Vendor',d.vendorKey],['Item','workshop-stock-1']]) {
    const observed = f.referenceEvidence.find(row => row.entity === entity && (entity !== 'Item' || row.record.Type === 'Inventory'));
    const index = f.step.references.findIndex(row => row.entity === entity && row.id === observed.record.Id);
    f.step.references[index] = bindBusinessReference({ scope, entity, key, observed, now: f.now });
  }
  f.reapprove = () => { f.approve(); f.policy.lifecycle = batchLifecycle(f.step); }; f.reapprove(); return f;
}
test('receiving compiles an unpaid taxed inventory Bill with exact PO header and line links', () => {
  const f = receiving(), source = f.parents[0], body = JSON.parse(f.compile().request.body);
  assert.equal(body.TxnDate, f.step.txnDate); assert.equal(body.DueDate, f.step.txnDate); assert.equal(body.APAccountRef.value, '602');
  assert.deepEqual(body.LinkedTxn, [{ TxnId: source.qboId, TxnType: 'PurchaseOrder' }]);
  assert.deepEqual(body.Line, [{ Amount: 246, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '101' }, Qty: 12, UnitPrice: 20.5, TaxCodeRef: { value: '901' } }, LinkedTxn: [{ TxnId: source.qboId, TxnType: 'PurchaseOrder', TxnLineId: source.record.Line[0].Id }] }]);
  assert.equal(body.CheckPayment, undefined);
});
test('receiving refuses changed parties, over-quantity, partial receipts, costs, line IDs and missing ownership', () => {
  for (const change of [f => { f.parents[0].record.VendorRef.value = '99'; }, f => { f.step.details.lines[0].quantity++; f.step.details.lines[0].amountCents += 2050; f.step.details.baseAmountCents += 2050; }, f => { f.parents[0].record.Line[0].Received = 1; }, f => { f.step.details.lines[0].unitPriceCents++; f.step.details.lines[0].amountCents += 12; f.step.details.baseAmountCents += 12; }, f => { f.step.details.lines[0].key = '99'; }, f => { f.parents.length = 0; }]) {
    const f = receiving(); change(f); f.refresh(); f.reapprove(); assert.throws(f.compile);
  }
});
test('v1–v4 batches rebuild and none may claim receiving; duplicate orders and quantity overrides are refused', () => {
  const base = { decisionKey: 'receive-order-unit-test', purpose: 'Receive a complete stock purchase order today.', activities: [{ type: 'receive-purchase-order', purchaseOrderId: '11046', vendorKey: 'stock-supplier-1', source: { kind: 'adopted', logicalKey: hash('adopted PO'), txnDate: '2026-10-05' }, lines: [{ lineId: '1', itemKey: 'workshop-stock-1', quantity: 30, unitPriceCents: 2300 }], purpose: 'Stock delivered with the supplier invoice today.' }] };
  assert.ok(POLICY.version >= 5);
  const batch = makeActivityBatch({ scope, businessKey: 'test', day: '2026-10-06', choices: base }); assert.equal(buildBatchActivity(batch, scope, 'test').events.length, 1);
  const workflows = ['settled-service-sale','paid-operating-expense'];
  for (let version = 1; version <= 4; version++) {
    if (version === 2) workflows.push('collect-adopted-invoice','pay-adopted-bill');
    if (version === 3) workflows.push('paid-cash-expense','supplier-credit');
    if (version === 4) workflows.push('customer-credit','customer-refund','bank-transfer','journal-entry');
    const policy = { version, key: version === 1 ? 'non-stock-business-activity-v1' : 'business-activity-v' + version, maxActivities:12,maxQuantity:8,maxUnitPriceCents:100000,maxExpenseCents:1000000,...(version > 1 ? {maxSettlementCents:5000000}:{}),maxBatchCents:12000000,workflows:[...workflows] };
    assert.throws(() => buildBatchActivity({ ...batch, policyHash: hash(policy) }, scope, 'test'), /policy changed/);
    const old = makeActivityBatch({ scope, businessKey:'test', day:'2026-10-06', choices:{...base,activities:[{type:'paid-operating-expense',vendorKey:'overhead-supplier-1',category:'software',amountCents:500,purpose:'Pay the monthly software charge.'}]} });
    assert.equal(buildBatchActivity({...old,policyHash:hash(policy)},scope,'test').events.length,2);
  }
  assert.throws(() => validateChoices({...base,activities:[base.activities[0],base.activities[0]]}), /once/);
});

test('adopted PO source requires the adopted job and fresh financial content; compiler links it without a managed dependency', async () => {
  const { createPurchaseOrderReceiptReader, receiptChoice } = require('../src/modules/business-purchase-order-receipt');
  const { verifyPopulationFinancialContent } = require('../src/modules/business-readback');
  const f = receiving(), origin = fixture('PurchaseOrder'); origin.step.txnDate = '2026-10-05'; origin.approve();
  origin.policy.readbackTax = {version:1,totalTaxCents:3198,lines:[{rateId:'950',percent:13,taxableCents:24600,amountCents:3198}]};
  const compiled = origin.compile(), record = {...JSON.parse(compiled.request.body), Id:'1002',SyncToken:'0',POStatus:'Open',TotalAmt:277.98,TxnTaxDetail:{TotalTax:31.98,TaxLine:[{Amount:31.98,DetailType:'TaxLineDetail',TaxLineDetail:{TaxRateRef:{value:'950'},PercentBased:true,TaxPercent:13,NetAmountTaxable:246}}]}}; record.Line.forEach((line,index)=>{line.Id=String(index+1);});
  const receipt = {version:1,scope,entity:'PurchaseOrder',logicalKey:origin.step.logicalKey,source:'request-correlated-readback',qboId:record.Id,requestHash:compiled.request.requestHash,dispatchKey:hash('original imported dispatch'),evidenceHash:hash('original import receipt')};
  const observed = () => ({scope,entity:'PurchaseOrder',record:structuredClone(record),recordHash:hash(record),observedAt:new Date(f.now).toISOString()});
  const taxPolicy = {...origin.policy.readbackTax,status:'approved',scope,compilationHash:compiled.compilationHash,evidenceHash:hash(origin.policy)};
  const financialProof = verifyPopulationFinancialContent({compiled,receipt,observed:observed(),parents:[],children:[],taxPolicy,now:f.now});
  const job = {_id:'b'.repeat(24),status:'adopted',authorityHash:hash('adopted job')}, adoption={kind:'adopted-history',jobId:job._id,adoptionId:'c'.repeat(24),importedThrough:'2026-10-05'};
  const row={...scope,entity:'PurchaseOrder',logicalKey:origin.step.logicalKey,txnDate:'2026-10-05',authorityHash:job.authorityHash,state:'saved',qboId:record.Id,step:origin.step,policy:origin.policy,receipt,compilation:compiled,financialProof};
  const query=value=>({select(){return this;},maxTimeMS(){return this;},lean:async()=>value});
  const models={Steps:{findOne:()=>query(null)},Calendars:{findOne:()=>query({adoption})},PopulationJobs:{findOne:()=>query(job)},PopulationRecords:{findOne:()=>query(row)}};
  const read = createPurchaseOrderReceiptReader({models,readRecord:async()=>observed(),now:()=>f.now});
  const source = await read(scope,{purchaseOrderId:record.Id}); assert.equal(source.state,'financially-verified');
  const selection=receiptChoice(source,{'stock-supplier-1':'20','workshop-stock-1':'101'});
  f.step.details.purchaseOrderReceipt={purchaseOrderId:selection.purchaseOrderId,source:selection.source};f.step.details.references=[];f.step.dependencies=[];f.parents=[];
  f.purchaseOrder={...source,operationId:f.observationFence.operationId,writerRevision:4};f.reapprove();
  const bill = f.compile(); assert.deepEqual(bill.relationships,[]);assert.equal(JSON.parse(bill.request.body).Line[0].LinkedTxn[0].TxnLineId,'1');
  for(const mutate of [()=>{row.authorityHash=hash('other job');},()=>{row.financialProof.matchesFinancialIntent=false;},()=>{row.relationshipCheck={outcome:'error'};}]){
    row.authorityHash=job.authorityHash;row.financialProof.matchesFinancialIntent=true;row.relationshipCheck=null;mutate();await assert.rejects(read(scope,{purchaseOrderId:record.Id}));
  }
  row.authorityHash=job.authorityHash;row.financialProof.matchesFinancialIntent=true;row.relationshipCheck=null; record.Line[0].Received=1;await assert.rejects(read(scope,{purchaseOrderId:record.Id}));
  const { verifyBusinessContent } = require('../src/modules/business-readback');
  const savedBill = { ...JSON.parse(bill.request.body),Id:'2000',SyncToken:'0',TotalAmt:277.98,Balance:277.98,TxnTaxDetail:structuredClone(record.TxnTaxDetail) }; savedBill.Line.forEach((line,index)=>{line.Id=String(index+1);});
  const billReceipt = {...receipt,entity:'Bill',logicalKey:bill.logicalKey,qboId:'2000',requestHash:bill.request.requestHash};
  const billObserved = {scope,entity:'Bill',record:savedBill,recordHash:hash(savedBill),observedAt:new Date(f.now).toISOString()};
  record.POStatus='Closed'; record.Line[0].Received=12; record.LinkedTxn=[{TxnId:'2000',TxnType:'Bill'}];
  const check = () => verifyBusinessContent({compiled:bill,receipt:billReceipt,observed:billObserved,parents:[],descendants:[],taxPolicy:{...taxPolicy,compilationHash:bill.compilationHash,purchaseOrderReceipt:{original:{...row,createdAt:new Date(f.now),updatedAt:new Date(f.now)},observed:observed()}} /* a lean Mongo row carries Date timestamps */,now:f.now});
  assert.equal(check().matchesIntent,true);
  record.Line[0].Received=11;assert.throws(check,/received quantity/);record.Line[0].Received=12;
  record.POStatus='Open';assert.throws(check,/header/);record.POStatus='Closed';
  record.LinkedTxn=[];assert.throws(check,/link/);
});
