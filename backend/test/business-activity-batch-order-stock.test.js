'use strict';
// Activity policy v8: a stock purchase order raised today, received in full on a later
// day through the existing receiving workflow (simulated company, no live QuickBooks).
process.env.QBO_ENVIRONMENT = 'production';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/business-stock-fixture');
async function calendar(h, throughDate, key) {
  const plan = await h.service.prepare(h.user, { requestKey: key, throughDate });
  await h.service.approve(h.user, plan.operationId, { planHash: plan.planHash, confirmProduction: true });
  const result = await h.runtime(plan.operationId).execute(); assert.equal(result.complete, true, JSON.stringify(result)); return plan;
}
async function batch(h, choices) {
  const plan = await h.service.prepareActivityBatch(h.user, choices);
  await h.service.approve(h.user, plan.operationId, { planHash: plan.planHash, confirmProduction: true });
  const result = await h.runtime(plan.operationId).execute(); assert.equal(result.complete, true, JSON.stringify(result)); return plan;
}
// Reordered at the published unit costs: the FIFO proof cannot yet order a same-day
// receipt and sale of one item at different costs (an existing, separate limitation).
test('a stock purchase order is raised, posts nothing, and is received in full the next day', { timeout: 300000 }, async t => {
  const h = await fixture(t, { openingDate: '2026-11-01', omitUnreceivedPoQuantity: true }); h.clock = Date.parse('2026-11-03T15:00:00Z'); await h.publish();
  await calendar(h, '2026-11-02', 'order-stock-starting-history');
  const order = { type: 'order-stock', vendorKey: 'stock-supplier-2', lines: [{ itemKey: 'workshop-stock-1', quantity: 12, unitPriceCents: 2050 }, { itemKey: 'workshop-stock-3', quantity: 4, unitPriceCents: 2550 }], purpose: 'Reorder workshop stock running low after this week’s jobs.' };
  const choices = { decisionKey: 'order-workshop-stock-0001', purpose: 'Keep workshop stock available for scheduled field jobs.', activities: [order] };
  const posts = h.posts;
  for (const changed of [{ vendorKey: 'overhead-supplier-1' }, { lines: [{ itemKey: 'field-service-hour', quantity: 1, unitPriceCents: 100 }] }, { lines: [order.lines[0], order.lines[0]] }, { lines: [{ ...order.lines[0], quantity: 501 }] }]) await assert.rejects(h.service.prepareActivityBatch(h.user, { ...choices, decisionKey: 'order-stock-invalid-' + posts, activities: [{ ...order, ...changed }] }));
  assert.equal(h.posts, posts);
  const ordered = await batch(h, choices);
  assert.equal(h.posts, posts + 1);
  const step = h.data.Steps.find(row => String(row.operationId) === ordered.operationId && row.entity === 'PurchaseOrder'), po = h.records.get('purchaseorder:' + step.qboId).record;
  assert.equal(po.TxnDate, '2026-11-03'); assert.equal(po.POStatus, 'Open');
  assert.deepEqual(po.Line.filter(line => line.DetailType === 'ItemBasedExpenseLineDetail').map(line => [line.ItemBasedExpenseLineDetail.Qty, line.Amount]), [[12, 246], [4, 102]]);
  // Today's order cannot be received until its day is verified.
  assert.ok(!(await h.service.activityOptions(h.user)).receivablePurchaseOrders.some(row => row.purchaseOrderId === step.qboId));
  h.clock = Date.parse('2026-11-04T15:00:00Z'); await calendar(h, '2026-11-03', 'order-stock-close-order-day');
  const choice = (await h.service.activityOptions(h.user)).receivablePurchaseOrders.find(row => row.purchaseOrderId === step.qboId);
  assert.ok(choice, 'the managed order is receivable'); assert.equal(choice.source.kind, 'managed'); assert.equal(choice.remainingQuantity, 16);
  const { docNumber, remainingQuantity, ...selection } = choice;
  const received = await batch(h, { decisionKey: 'receive-ordered-stock-001', purpose: 'Receive the reordered workshop stock with its supplier bill.', activities: [{ type: 'receive-purchase-order', ...selection, purpose: 'The ordered stock arrived with the supplier invoice.' }] });
  const billStep = h.data.Steps.find(row => String(row.operationId) === received.operationId && row.entity === 'Bill');
  assert.ok(billStep); assert.equal(h.records.get('purchaseorder:' + step.qboId).record.POStatus, 'Closed');
  const cost = h.data.Evidence.find(row => row.operationId === received.operationId).proof.assertions.find(row => row.key === 'stock-costs').stockCosts;
  assert.equal(cost.status, 'passed');
  h.clock = Date.parse('2026-11-05T15:00:00Z'); await calendar(h, '2026-11-04', 'order-stock-close-receipt-day');
});
