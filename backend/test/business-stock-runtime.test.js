'use strict';
process.env.QBO_ENVIRONMENT='production';
const test = require('node:test'), assert = require('node:assert/strict');
const {fixture,policy,scope} = require('./helpers/business-stock-fixture');
const {hash,canonical} = require('../src/modules/business-calendar');
const {validateStockRoot} = require('../src/modules/business-stock-root');
const {draftView,buildDraftDefinition} = require('../src/modules/blueprint-draft');
async function prepared(h,throughDate,key) {const saved=await h.service.prepare(h.user,{requestKey:key,throughDate});await h.service.approve(h.user,saved.operationId,{planHash:saved.planHash,confirmProduction:true});return {saved,runtime:h.runtime(saved.operationId)};}
test('original owner-approved zero-stock masters publish an exact immutable cost root through the real reader', {timeout:120000}, async t => {
  const h=await fixture(t), before=h.posts, result=await h.publish(); assert.equal(result.published,true);assert.equal(h.posts,before);
  const root=h.data.Authorities[0].payload.stockRoot;assert.equal(root.items.length,5);assert.equal(root.origins.length,5);assert.equal(root.policyHash,hash(policy));assert.equal(root.zeroSource.items.length,5);assert.equal(root.zeroSource.transactionCount,0);
  assert.equal(validateStockRoot(root,scope,draftView(h.data.Versions[0],scope.connectionId)),root);assert.equal(h.events.filter(row=>row.method==='POST').length,0);
  for(const item of root.items){assert.equal(root.zeroSource.items.find(row=>row.Id===item.itemId).QtyOnHand,0);assert.ok(h.data.Receipts.some(row=>row._id===root.origins.find(row=>row.itemId===item.itemId).receiptId));}
});
test('normal stock period retains exact purchase layers, selected cost accounts and dormant products without duplicate writes', {timeout:120000}, async t => {
  const h=await fixture(t);await h.publish();const {saved,runtime}=await prepared(h,'2026-10-08','stock-normal-first-0001'),outcome=await runtime.execute();assert.equal(outcome.complete,true,JSON.stringify(outcome));
  const plan=h.data.Plans[0].manifest, evidence=h.data.Evidence.at(-1), result=(await runtime.inspect()).financialMovements.stockCosts;
  assert.ok(plan.requiredAssertions.some(row=>row.key==='stock-costs'));assert.equal(result.status,'passed');assert.equal(result.method,'FIFO');assert.equal(result.quantities.length,5);assert.ok(result.quantities.some(row=>row.quantity===0));assert.ok(result.checks.every(row=>row.differenceCents===0));
  assert.equal(evidence.proof.stockBasis.length,h.data.Intents.filter(row=>row.kind==='create'&&['Bill','SalesReceipt'].includes(row.step.entity)).reduce((sum,row)=>sum+row.step.details.lines.filter(line=>line.itemKey?.startsWith('workshop-stock-')).length,0));assert.equal(result.calculation.openingHash,plan.stockCostExpectation.opening.stateHash);assert.equal(h.data.Calendars[0].verifiedThrough,'2026-10-08');
  const posts=h.posts, original=canonical(evidence);assert.equal((await runtime.execute()).complete,true);assert.equal(h.posts,posts);assert.equal(canonical(h.data.Evidence.at(-1)),original);assert.equal(saved.planHash,h.data.Runs[0].planHash);
});
test('adjacent periods carry only the exact prior committed layers and preserve the original retained observation', {timeout:120000}, async t => {
  const h=await fixture(t);await h.publish();const first=await prepared(h,'2026-10-08','stock-carry-first-0001');assert.equal((await first.runtime.execute()).complete,true);
  const old=(await first.runtime.inspect()).financialMovements, next=await prepared(h,'2026-10-31','stock-carry-next-0001'), second=h.data.Plans.find(row=>row.operationId===next.saved.operationId).manifest.stockCostExpectation;
  assert.equal(second.carry.operationId,first.saved.operationId);assert.equal(second.opening.stateHash,old.stockCosts.calculation.closing.stateHash);assert.equal(second.opening.items.length,5);assert.equal((await next.runtime.execute()).complete,true);
  h.clock+=600000;assert.deepEqual((await first.runtime.inspect()).financialMovements,old);const result=(await next.runtime.inspect()).financialMovements.stockCosts;assert.equal(result.status,'passed');assert.ok(result.calculation.closing.items.some(item=>item.lots.some(lot=>old.stockCosts.calculation.closing.items.some(original=>original.lots.some(earlier=>earlier.lotKey===lot.lotKey)))),'unspent first-period purchase layers remain carried');
  const third=await prepared(h,'2026-11-08','stock-carry-new-month-0001');assert.equal((await third.runtime.execute()).complete,true);const november=(await third.runtime.inspect()).financialMovements.stockCosts;assert.ok(november.calculation.allocations.some(row=>row.consumed.some(lot=>old.stockCosts.calculation.closing.items.some(item=>item.lots.some(original=>original.lotKey===lot.lotKey)))),'the next monthly sales consume original earlier-month costs');
});
test('unwanted starting stock, owner-attributed masters and a missing original receipt cannot be accepted as a zero root', {timeout:120000}, async t => {
  const h=await fixture(t), baseline=await h.capture(), input={blueprintHash:h.data.Versions[0].contentHash,baselineId:baseline.id};
  const stock=[...h.records.values()].find(row=>row.entity==='Item'&&row.record.Type==='Inventory').record;stock.QtyOnHand=1;
  await assert.rejects(h.service.reviewPublication(h.user,input),/stock|inventory|opening/i);stock.QtyOnHand=0;
  const run=h.data.MasterRuns[0], row=run.records.find(row=>row.entity==='Item'&&row.readback?.fields?.Type==='Inventory'), attempt=row.attempts.at(-1), original=structuredClone(attempt);
  attempt.ownerAttribution={};await assert.rejects(h.service.reviewPublication(h.user,input),/original|attribution|stock/i);Object.keys(attempt).forEach(key=>delete attempt[key]);Object.assign(attempt,original);
  const index=h.data.Receipts.findIndex(receipt=>receipt._id===attempt.receiptId), removed=h.data.Receipts.splice(index,1)[0];await assert.rejects(h.service.reviewPublication(h.user,input),/receipt|master|stock/i);h.data.Receipts.push(removed);
  assert.equal(h.data.Authorities.length,0);assert.equal(h.posts,0);
});
