'use strict';
process.env.QBO_ENVIRONMENT = 'production';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/business-stock-fixture');
async function calendar(h, throughDate, key) {
  const plan = await h.service.prepare(h.user, { requestKey:key, throughDate });
  await h.service.approve(h.user,plan.operationId,{planHash:plan.planHash,confirmProduction:true});
  const result = await h.runtime(plan.operationId).execute(); assert.equal(result.complete,true,JSON.stringify(result)); return plan;
}
async function batch(h, choices) {
  const plan = await h.service.prepareActivityBatch(h.user,choices);
  await h.service.approve(h.user,plan.operationId,{planHash:plan.planHash,confirmProduction:true});
  const result = await h.runtime(plan.operationId).execute(); assert.equal(result.complete,true,JSON.stringify(result)); return plan;
}
test('whole PO receiving retains exact FIFO through another batch, day close and next period', {timeout:120000}, async t => {
  const h = await fixture(t,{openingDate:'2026-11-01',omitUnreceivedPoQuantity:true}); h.clock = Date.parse('2026-11-03T15:00:00Z'); await h.publish();
  await calendar(h,'2026-11-02','receiving-starting-history');
  const options = await h.service.activityOptions(h.user); assert.ok(options.receivablePurchaseOrders.length);
  const {docNumber,remainingQuantity,...selection} = options.receivablePurchaseOrders[0];
  const choices = {decisionKey:'whole-order-receiving-0001',purpose:'Receive delivered workshop stock with the supplier invoice.',activities:[{type:'receive-purchase-order',...selection,purpose:'The whole purchase order arrived with its supplier bill.'}]};
  const posts = h.posts;
  for (const changed of [{...selection,purchaseOrderId:'999999'}, {...selection,vendorKey:'stock-supplier-3'}, {...selection,lines:selection.lines.map(line=>({...line,quantity:line.quantity+1}))}]) await assert.rejects(h.service.prepareActivityBatch(h.user,{...choices,activities:[{...choices.activities[0],...changed}]}));
  assert.equal(h.posts,posts);
  const received = await batch(h,choices), billStep = h.data.Steps.find(row=>String(row.operationId)===received.operationId&&row.entity==='Bill'), body = JSON.parse(billStep.compilation.request.body), po = h.records.get('purchaseorder:'+selection.purchaseOrderId).record;
  assert.equal(body.TxnDate,'2026-11-03'); assert.equal(po.POStatus,'Closed'); assert.deepEqual(body.Line.map(line=>line.LinkedTxn),selection.lines.map(line=>[{TxnId:selection.purchaseOrderId,TxnType:'PurchaseOrder',TxnLineId:line.lineId}]));
  let evidence = h.data.Evidence.find(row=>row.operationId===received.operationId), cost = evidence.proof.assertions.find(row=>row.key==='stock-costs').stockCosts;
  assert.equal(cost.status,'passed'); assert.equal(evidence.proof.stockBasis[0].unitCostCents,selection.lines[0].unitPriceCents);
  assert.equal(h.data.Calendars[0].verifiedThrough,'2026-11-02');
  await assert.rejects(h.service.prepareActivityBatch(h.user,{...choices,decisionKey:'whole-order-already-received'}));
  await batch(h,{decisionKey:'service-after-receiving-0001',purpose:'Collect a service visit while preserving today’s received inventory.',activities:[{type:'settled-service-sale',customerKey:'field-client-001',itemKey:'field-service-hour',quantity:1,unitPriceCents:12500,purpose:'Collected maintenance work completed today.'}]});
  // Closing a wider range must also reuse a receipt on its first still-open day.
  h.clock = Date.parse('2026-11-09T15:00:00Z'); const following = await calendar(h,'2026-11-08','receiving-following-period');
  const expected = h.data.Plans.find(row=>row.operationId===following.operationId).manifest.stockCostExpectation;
  assert.ok(expected.priorActivityRows.some(row=>row.source.qboId===billStep.qboId));
  assert.ok(expected.purchaseOrigins.some(row=>row.qboId===billStep.qboId),'starting purchase evidence includes the earlier same-day receipt');
  evidence = h.data.Evidence.at(-1); cost = evidence.proof.assertions.find(row=>row.key==='stock-costs').stockCosts;
  assert.equal(cost.status,'passed'); assert.ok(cost.checks.every(row=>row.differenceCents===0));
  h.clock = Date.parse('2026-11-10T15:00:00Z'); await calendar(h,'2026-11-09','receiving-carried-next-period');
});

test('receiving preflight refuses unequal costs alongside a same-day scheduled stock sale', () => {
  const { assertReceiptSaleCosts } = require('../src/modules/business-received-order-calendar');
  const day = '2026-11-06', receipts = [{ lines: [{ itemKey:'workshop-stock-1', unitPriceCents:2300 }] }];
  const activity = { events:[{logicalKey:'sale',entity:'SalesReceipt',txnDate:day,dependsOn:['bill']}], detailProposal:{byLogicalKey:{
    sale:{details:{lines:[{itemKey:'workshop-stock-1',unitPriceCents:4600}]}},
    bill:{details:{lines:[{itemKey:'workshop-stock-1',accountMapping:'inventoryAsset',unitPriceCents:2050}]}}
  }} };
  const opening = {items:[{itemKey:'workshop-stock-1',lots:[{unitCostCents:2050}]}]};
  const check = () => assertReceiptSaleCosts({receipts,day,activity,opening});
  assert.throws(check,error=>error.status===409 && error.code==='BUSINESS_PO_RECEIPT_UNVERIFIED');
  activity.detailProposal.byLogicalKey.bill.details.lines[0].unitPriceCents=2300;
  assert.throws(check,/unequal purchase costs/,'older FIFO layers still make same-day ordering ambiguous');
  opening.items[0].lots[0].unitCostCents=2300; assert.doesNotThrow(check,'equal purchase costs are supported regardless of sale price');
  receipts[0].lines[0].unitPriceCents=2400; activity.events[0].txnDate='2026-11-07'; assert.doesNotThrow(check,'a sale on a different day does not cause same-day ambiguity');
  activity.events[0].txnDate=day; receipts[0].lines[0].itemKey='workshop-stock-2'; assert.doesNotThrow(check,'another stock item does not conflict');
  receipts[0].lines[0].itemKey='workshop-stock-1';
  activity.prerequisites=[{logicalKey:'bill',entity:'Bill',txnDate:'2026-11-03',dependsOn:['po']},{logicalKey:'po',entity:'PurchaseOrder',txnDate:'2026-11-01',dependsOn:[]}];
  const adoptedCheck=()=>assertReceiptSaleCosts({receipts,day,activity,opening,adoptedThrough:'2026-11-02'});
  assert.doesNotThrow(adoptedCheck,'an inherited sale excluded from calendar execution does not block receiving');
  activity.prerequisites[1].txnDate='2026-11-03';assert.throws(adoptedCheck,/unequal purchase costs/,'a post-adoption managed sale still blocks ambiguous receiving');
});
