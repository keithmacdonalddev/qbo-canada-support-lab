'use strict';
// Activity policy v8 end to end on the simulated company (no live QuickBooks): service
// invoices and operating bills left open on payment terms, then collected and paid in
// part and in full on later days through the governed pipeline.
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/business-governance-fixture');
const batchTools = require('../src/modules/business-activity-batch');
const { hash } = require('../src/modules/business-calendar');
const config = require('../src/config'); const previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const DAY = 86400000;
async function calendar(h, throughDate, key) { const p = await h.service.prepare(h.user, { requestKey: key, throughDate }); await h.service.approve(h.user, p.operationId, { planHash: p.planHash }); const result = await h.runtime(p.operationId).execute(); assert.equal(result.complete, true, JSON.stringify(result)); return p; }
async function run(h, choices) { const p = await h.service.prepareActivityBatch(h.user, choices); await h.service.approve(h.user, p.operationId, { planHash: p.planHash }); const result = await h.runtime(p.operationId).execute(); assert.equal(result.complete, true, JSON.stringify(result)); return p; }
const record = (h, entity, id) => h.records.get(entity.toLowerCase() + ':' + id).record;
const created = (h, entity, operationId) => h.data.Steps.filter(row => String(row.operationId) === operationId && row.entity === entity).map(row => record(h, entity, row.qboId));
const cents = value => Math.round(value * 100);
const batch = (decisionKey, activities) => ({ decisionKey, purpose: 'Run the business over time: work on terms now, collect and pay as money moves.', activities });
const careOnTerms = { type: 'invoice-on-terms', customerKey: 'care-client-002', itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 25000, termsDays: 30, purpose: 'Monthly care plan billed on net 30 terms.' };
const fieldOnTerms = { type: 'invoice-on-terms', customerKey: 'field-client-001', itemKey: 'field-service-hour', quantity: 2, unitPriceCents: 9000, termsDays: 15, purpose: 'Field visit quoted, worked and billed on net 15.' };
const billOnTerms = { type: 'bill-on-terms', vendorKey: 'overhead-supplier-2', category: 'utilities', amountCents: 40000, termsDays: 30, purpose: 'Utilities bill received on net 30 terms.' };
async function december() { const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01' }); await h.publish(); await calendar(h, '2026-11-30', 'v8-lifecycle-november'); return h; }

test('policy v8 freezes v7 and refuses its new workflows under older policies', () => {
  assert.equal(batchTools.POLICY.version, 8);
  const v7 = [...batchTools.SAVED_POLICIES.values()].find(policy => policy.version === 7);
  assert.ok(v7 && !v7.workflows.includes('invoice-on-terms'));
  assert.throws(() => batchTools.validateChoices(batch('older-policy-terms', [careOnTerms]), v7), /not part of the saved activity policy/);
  assert.throws(() => batchTools.validateChoices(batch('bad-terms-days-01', [{ ...careOnTerms, termsDays: 10 }])), /payment terms/);
  // Settlement sources are derived by the server; the agent cannot save one directly.
  const collect = { type: 'collect-own-invoice', invoiceId: '10001', customerKey: 'care-client-002', amountCents: 100, purpose: 'Customer paid part of the invoice.' };
  const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
  assert.throws(() => batchTools.makeActivityBatch({ scope, businessKey: 'b'.repeat(64), day: '2026-12-02', choices: batch('own-collect-no-source', [collect]) }), /derived by the server/);
  const source = { logicalKey: 'c'.repeat(64), txnDate: '2026-12-02', sources: [{ logicalKey: 'c'.repeat(64), entity: 'Invoice', txnDate: '2026-12-02', dependsOn: [] }] };
  assert.throws(() => batchTools.makeActivityBatch({ scope, businessKey: 'b'.repeat(64), day: '2026-12-02', choices: batch('own-collect-today-src', [{ ...collect, source }]) }), /from today can be settled or converted tomorrow/);
  // A saved terms invoice cannot change its due date or terms.
  const built = batchTools.buildBatchActivity(batchTools.makeActivityBatch({ scope, businessKey: 'b'.repeat(64), day: '2026-12-01', choices: batch('terms-lifecycle-check', [careOnTerms]) }), scope, 'b'.repeat(64));
  const event = built.events[0], details = built.detailProposal.byLogicalKey[event.logicalKey].details;
  assert.equal(details.dueDate, '2026-12-31');
  const step = { entity: 'Invoice', txnDate: event.txnDate, dependencies: [], details };
  assert.equal(batchTools.batchLifecycle(step).paymentTerms.days, 30);
  assert.throws(() => batchTools.batchLifecycle({ ...step, details: { ...details, dueDate: '2027-01-15' } }), /payment terms changed/);
  assert.throws(() => batchTools.batchLifecycle({ ...step, details: { ...details, paymentTerms: { days: 45 } } }), /payment terms changed/);
  assert.notEqual(hash(v7), batchTools.POLICY_HASH);
});

test('terms invoices and bills stay open, then are collected and paid in part and in full on later days', { timeout: 600000 }, async () => {
  const h = await december();
  let posts = h.posts;
  const opened = await run(h, batch('v8-open-on-terms-001', [careOnTerms, fieldOnTerms, billOnTerms]));
  // Care invoice, field estimate + time + invoice, and one bill: no payment or deposit.
  assert.equal(h.posts, posts + 5);
  const invoices = created(h, 'Invoice', opened.operationId), [bill] = created(h, 'Bill', opened.operationId);
  assert.equal(invoices.length, 2); assert.equal(created(h, 'Payment', opened.operationId).length, 0); assert.equal(created(h, 'BillPayment', opened.operationId).length, 0);
  const care = invoices.find(row => !(row.LinkedTxn || []).length);
  const field = invoices.find(row => row !== care);
  assert.equal(care.TxnDate, '2026-12-01'); assert.equal(care.DueDate, '2026-12-31'); assert.equal(care.Balance, care.TotalAmt);
  assert.equal(field.DueDate, '2026-12-16'); assert.equal(field.Balance, field.TotalAmt);
  assert.equal(bill.DueDate, '2026-12-31'); assert.equal(bill.Balance, bill.TotalAmt);
  // Records from today are listed but cannot be settled until tomorrow.
  let options = await h.service.activityOptions(h.user);
  assert.equal(options.ownOpenInvoices.length, 2); assert.ok(options.ownOpenInvoices.every(row => row.eligible === false && /from today/.test(row.reason)), JSON.stringify(options.ownOpenInvoices));
  assert.equal(options.ownOpenBills.length, 1);
  await calendar(h, '2026-12-01', 'v8-close-december-first');

  // Day two: part of the care invoice is collected (then deposited); part of the bill is paid.
  h.clock += DAY;
  options = await h.service.activityOptions(h.user);
  const careChoice = options.ownOpenInvoices.find(row => row.invoiceId === care.Id), billChoice = options.ownOpenBills.find(row => row.billId === bill.Id);
  assert.ok(careChoice?.eligible, JSON.stringify(options.ownOpenInvoices)); assert.ok(billChoice?.eligible, JSON.stringify(options.ownOpenBills));
  assert.equal(careChoice.balanceCents, cents(care.TotalAmt)); assert.equal(careChoice.dueDate, '2026-12-31'); assert.equal(careChoice.termsDays, 30);
  const collectCare = amountCents => ({ type: 'collect-own-invoice', invoiceId: care.Id, customerKey: 'care-client-002', amountCents, purpose: 'The customer paid toward the care invoice.' });
  const payBill = amountCents => ({ type: 'pay-own-bill', billId: bill.Id, vendorKey: 'overhead-supplier-2', amountCents, purpose: 'Paid toward the utilities bill.' });
  posts = h.posts;
  // Refused before any write: over the open balance, another party, a forged source.
  await assert.rejects(h.service.prepareActivityBatch(h.user, batch('v8-over-collect-0001', [collectCare(cents(care.TotalAmt) + 1)])), /open balance of/);
  await assert.rejects(h.service.prepareActivityBatch(h.user, batch('v8-wrong-customer-01', [{ ...collectCare(100), customerKey: 'care-client-003' }])), /another customer/);
  await assert.rejects(h.service.prepareActivityBatch(h.user, batch('v8-forged-source-001', [{ ...collectCare(100), source: { logicalKey: 'd'.repeat(64), txnDate: '2026-12-01', sources: [{ logicalKey: 'd'.repeat(64), entity: 'Invoice', txnDate: '2026-12-01', dependsOn: [] }] } }])), /differs from your own original/);
  await assert.rejects(h.service.prepareActivityBatch(h.user, batch('v8-calendar-invoice-1', [{ type: 'collect-own-invoice', invoiceId: h.data.Steps.find(row => row.entity === 'Invoice' && String(row.operationId) !== opened.operationId).qboId, customerKey: 'care-client-002', amountCents: 100, purpose: 'Try to collect a scheduled invoice.' }])), /payment terms/);
  assert.equal(h.posts, posts);
  const partial = Math.round(cents(care.TotalAmt) * 0.4), billPart = 15000;
  const paidPart = await run(h, batch('v8-partial-settle-001', [collectCare(partial), payBill(billPart)]));
  assert.equal(h.posts, posts + 3);
  const [payment] = created(h, 'Payment', paidPart.operationId), [deposit] = created(h, 'Deposit', paidPart.operationId), [billPayment] = created(h, 'BillPayment', paidPart.operationId);
  assert.equal(cents(payment.TotalAmt), partial); assert.equal(payment.TxnDate, '2026-12-02'); assert.equal(payment.Line[0].LinkedTxn[0].TxnId, care.Id);
  assert.equal(cents(deposit.TotalAmt), partial);
  assert.equal(cents(billPayment.TotalAmt), billPart); assert.equal(billPayment.Line[0].LinkedTxn[0].TxnId, bill.Id);
  assert.equal(cents(record(h, 'Invoice', care.Id).Balance), cents(care.TotalAmt) - partial);
  assert.equal(cents(record(h, 'Bill', bill.Id).Balance), cents(bill.TotalAmt) - billPart);
  // A partly paid own invoice cannot be corrected.
  const correctable = (await h.service.activityOptions(h.user)).correctableRecords.find(row => row.target.qboId === care.Id);
  assert.ok(!correctable || correctable.eligible === false);
  await calendar(h, '2026-12-02', 'v8-close-december-second');

  // Day three: the remaining balances are settled in full; nothing more can be collected.
  h.clock += DAY;
  posts = h.posts;
  const rest = cents(care.TotalAmt) - partial, billRest = cents(bill.TotalAmt) - billPart;
  await run(h, batch('v8-final-settle-0001', [collectCare(rest), payBill(billRest)]));
  assert.equal(h.posts, posts + 3);
  assert.equal(record(h, 'Invoice', care.Id).Balance, 0); assert.equal(record(h, 'Bill', bill.Id).Balance, 0);
  options = await h.service.activityOptions(h.user);
  assert.ok(!options.ownOpenInvoices.some(row => row.invoiceId === care.Id)); assert.ok(!options.ownOpenBills.some(row => row.billId === bill.Id));
  assert.ok(options.ownOpenInvoices.some(row => row.invoiceId === field.Id && row.eligible));
  await assert.rejects(h.service.prepareActivityBatch(h.user, batch('v8-after-paid-00001', [collectCare(100)])), /open balance of 0 cents/);
  // Period verification still balances with every settlement counted once.
  await calendar(h, '2026-12-03', 'v8-close-december-third');
  assert.equal(h.data.Calendars[0].verifiedThrough, '2026-12-03');
});

test('a field estimate sent on its own is converted on a later day into time and an invoice on terms', { timeout: 600000 }, async () => {
  const h = await december();
  let posts = h.posts;
  const quote = { type: 'send-estimate', customerKey: 'field-client-003', quantity: 3, unitPriceCents: 9500, purpose: 'Quoted a three-hour repair the customer will schedule.' };
  const sent = await run(h, batch('v8-send-estimate-0001', [quote]));
  assert.equal(h.posts, posts + 1);
  const [estimate] = created(h, 'Estimate', sent.operationId);
  assert.equal(estimate.TxnStatus, 'Pending'); assert.equal(created(h, 'Invoice', sent.operationId).length, 0);
  let options = await h.service.activityOptions(h.user);
  assert.ok(options.ownOpenEstimates.some(row => row.estimateId === estimate.Id && row.eligible === false && /from today/.test(row.reason)), JSON.stringify(options.ownOpenEstimates));
  await calendar(h, '2026-12-01', 'v8-estimate-close-first');
  h.clock += DAY;
  options = await h.service.activityOptions(h.user);
  const listed = options.ownOpenEstimates.find(row => row.estimateId === estimate.Id);
  assert.ok(listed?.eligible, JSON.stringify(options.ownOpenEstimates)); assert.equal(listed.hours, 3); assert.equal(listed.unitPriceCents, 9500);
  const convert = { type: 'convert-own-estimate', estimateId: estimate.Id, customerKey: 'field-client-003', termsDays: 30, purpose: 'The customer accepted the quote; the work was done today.' };
  posts = h.posts;
  await assert.rejects(h.service.prepareActivityBatch(h.user, batch('v8-convert-wrong-cust', [{ ...convert, customerKey: 'field-client-004' }])), /another customer/);
  await assert.rejects(h.service.prepareActivityBatch(h.user, batch('v8-convert-forged-qty', [{ ...convert, quote: { itemKey: 'field-service-hour', quantity: 4, unitPriceCents: 9500 }, source: { logicalKey: 'e'.repeat(64), txnDate: '2026-12-01', sources: [{ logicalKey: 'e'.repeat(64), entity: 'Estimate', txnDate: '2026-12-01', dependsOn: [] }] } }])), /differs from your own original/);
  assert.equal(h.posts, posts);
  const converted = await run(h, batch('v8-convert-estimate-01', [convert]));
  assert.equal(h.posts, posts + 2);
  const [time] = created(h, 'TimeActivity', converted.operationId), [invoice] = created(h, 'Invoice', converted.operationId);
  assert.equal(time.TxnDate, '2026-12-02'); assert.equal(time.Hours, 3);
  assert.equal(invoice.TxnDate, '2026-12-02'); assert.equal(invoice.DueDate, '2027-01-01'); assert.equal(invoice.Balance, invoice.TotalAmt);
  assert.ok((invoice.LinkedTxn || []).some(link => link.TxnType === 'TimeActivity' && link.TxnId === time.Id));
  assert.equal(cents(invoice.TotalAmt), cents(estimate.TotalAmt));
  // Converted once: no longer listed, a second conversion is refused, and the new
  // invoice is collectable from tomorrow.
  options = await h.service.activityOptions(h.user);
  assert.ok(!options.ownOpenEstimates.some(row => row.estimateId === estimate.Id));
  await assert.rejects(h.service.prepareActivityBatch(h.user, batch('v8-convert-again-0001', [convert])));
  assert.ok(options.ownOpenInvoices.some(row => row.invoiceId === invoice.Id));
  await calendar(h, '2026-12-02', 'v8-estimate-close-second');
  assert.equal(h.data.Calendars[0].verifiedThrough, '2026-12-02');
});
