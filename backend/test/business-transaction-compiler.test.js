'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { fixture, scope, clone } = require('./helpers/business-transaction-fixtures');
for (const entity of ['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment']) test('compiles exact ' + entity + ' fixture without granting execution permission', () => {
  const f = fixture(entity), result = f.compile(), payload = JSON.parse(result.request.body);
  assert.equal(result.entity, entity); assert.equal(result.request.entity, entity.toLowerCase()); assert.equal(result.authorized, false); assert.equal(payload.TxnDate, '2026-10-06'); assert.equal(payload.Id, undefined); assert.equal(payload.SyncToken, undefined);
  assert.deepEqual(result, f.compile()); assert.equal(result.relationships.length, f.parents.length);
  if (['Estimate', 'Invoice', 'SalesReceipt', 'PurchaseOrder', 'Bill'].includes(entity)) { assert.equal(payload.GlobalTaxCalculation, 'TaxExcluded'); assert.equal(payload.Line[0].Amount, f.step.details.lines[0].amountCents / 100); }
  if (entity === 'Invoice') { assert.equal(payload.LinkedTxn.length, 2); assert.equal(payload.Line[0].LinkedTxn[0].TxnLineId, '1'); }
  if (entity === 'Bill') { assert.equal(payload.LinkedTxn[0].TxnId, '1002'); assert.equal(payload.Line[0].LinkedTxn[0].TxnLineId, '1'); }
  if (entity === 'TimeActivity') { assert.equal(payload.ItemRef.value, '100'); assert.equal(payload.Hours, 2); assert.equal(payload.Minutes, 0); assert.equal(payload.LinkedTxn, undefined); }
  if (entity === 'Payment') { assert.equal(payload.TotalAmt, 282.5); assert.equal(payload.ProcessPayment, false); assert.equal(payload.DepositToAccountRef.value, '603'); }
  if (entity === 'BillPayment') { assert.equal(payload.TotalAmt, 277.98); assert.equal(payload.ProcessBillPayment, false); assert.equal(payload.CheckPayment.BankAccountRef.value, '600'); }
  if (entity === 'Deposit') { assert.equal(payload.CustomerRef, undefined); assert.equal(payload.Line[0].Amount, 282.5); assert.equal(payload.Line[0].LinkedTxn[0].TxnType, 'Payment'); assert.equal(payload.Line[0].DepositLineDetail, undefined); }
});
test('approval binds company, locale, economics, references and exact content', () => {
  for (const change of [f => { f.policy.status = 'draft'; }, f => { f.policy.scope = { ...scope, realmId: '456' }; }, f => { f.policy.country = 'US'; }, f => { f.step.details.lines[0].unitPriceCents += 100; }, f => { f.step.references[0].id = '99'; }, f => { f.policy.tax.calculation = 'TaxInclusive'; }, f => { f.policy.tax.salesTax = '901'; }]) { const f = fixture(); change(f); assert.throws(f.compile); }
});
test('references must be fresh, active, valid-version, exact-company and complete', () => {
  for (const change of [f => { f.referenceEvidence[0].observedAt = '2026-10-06T11:54:59.000Z'; }, f => { f.referenceEvidence[0].scope = { ...scope, connectionId: 'f'.repeat(24) }; }, f => { f.referenceEvidence[0].record.Active = false; f.refresh(); }, f => { f.referenceEvidence[0].record.SyncToken = '01'; f.refresh(); }, f => { f.referenceEvidence.pop(); }, f => { f.referenceEvidence.push(clone(f.referenceEvidence[0])); }, f => { f.referenceEvidence[0].record.CurrencyRef.value = 'USD'; f.refresh(); }]) { const f = fixture(); change(f); assert.throws(f.compile); }
});
test('source evidence must match exact dependency intent and cannot cross companies or dates', () => {
  for (const change of [f => { f.parents[0].state = 'saved'; }, f => { f.parents[0].fingerprint = hash('changed'); }, f => { f.parents[0].scope = { ...scope, realmId: '456' }; }, f => { f.parents[0].record.TxnDate = '2026-10-07'; f.refresh(); }, f => { f.parents[0].record.Id = '2000'; f.refresh(); }, f => { f.parents[0].record.CustomerRef.value = '99'; f.refresh(); }, f => { f.parents[0].observedAt = '2026-10-06T11:54:59.000Z'; }]) { const f = fixture(); change(f); assert.throws(f.compile); }
});
test('line quantities and cents must reconcile exactly before compiling', () => {
  for (const change of [f => { f.step.details.lines[0].quantity = 3; }, f => { f.step.details.lines[0].quantity = Infinity; }, f => { f.step.details.lines[0].amountCents = 25000.5; }, f => { f.step.details.baseAmountCents = 25001; }]) { const f = fixture('Estimate'); change(f); assert.throws(() => { f.approve(); f.compile(); }); }
});
test('full settlements use saved tax-inclusive totals and reject already-paid balances', () => {
  for (const entity of ['Payment', 'BillPayment']) {
    const f = fixture(entity); f.parents[0].record.Balance -= 1; f.refresh(); assert.throws(f.compile, /settled/);
    const g = fixture(entity); delete g.parents[0].record.Balance; g.refresh(); assert.throws(g.compile, /missing/);
  }
});
test('source control accounts and funding destinations cannot silently change', () => {
  const payment = fixture('Payment'); payment.parents[0].record.ARAccountRef.value = '99'; payment.refresh(); assert.throws(payment.compile, /account/);
  const bill = fixture('BillPayment'); bill.parents[0].record.APAccountRef.value = '99'; bill.refresh(); assert.throws(bill.compile, /account/);
  const deposit = fixture('Deposit'); deposit.parents[0].record.DepositToAccountRef.value = '600'; deposit.refresh(); assert.throws(deposit.compile, /undeposited/);
});
test('already-deposited or unapplied receipts cannot be deposited again', () => {
  for (const change of [f => { f.parents[0].record.LinkedTxn = [{ TxnType: 'Deposit', TxnId: '8' }]; }, f => { f.parents[0].record.UnappliedAmt = 1; }]) { const f = fixture('Deposit'); change(f); f.refresh(); assert.throws(f.compile, /undeposited/); }
});
test('bill conversion requires actual unconsumed PO line evidence', () => {
  for (const change of [f => { delete f.parents[0].record.Line[0].Received; }, f => { f.parents[0].record.Line[0].Received = 1; }, f => { f.parents[0].record.Line[0].ItemBasedExpenseLineDetail.Qty = 6; }, f => { f.parents[0].record.POStatus = 'Closed'; }, f => { f.parents[0].record.LinkedTxn = [{ TxnType: 'Bill', TxnId: '9' }]; }]) { const f = fixture('Bill'); change(f); f.refresh(); assert.throws(f.compile); }
});
test('time and invoiced hours must match their saved sources', () => {
  const invoice = fixture(); invoice.parents[1].record.Hours = 7; invoice.refresh(); assert.throws(invoice.compile, /hours/);
  const time = fixture('TimeActivity'); time.step.details.hours = 3; time.approve(); assert.throws(time.compile, /quoted/);
  const wrongItem = fixture('TimeActivity'); wrongItem.parents[0].record.Line[0].SalesItemLineDetail.ItemRef.value = '99'; wrongItem.refresh(); assert.throws(wrongItem.compile, /quoted/);
});
test('discount and unknown source financial lines cannot be silently dropped', () => {
  for (const entity of ['Invoice', 'TimeActivity', 'SalesReceipt', 'Bill']) { const f = fixture(entity); f.parents[0].record.Line.push({ Amount: -10, DetailType: 'DiscountLineDetail', DiscountLineDetail: { PercentBased: false } }); f.refresh(); assert.throws(f.compile, /unsupported monetary/); }
  const f = fixture(); f.parents[0].record.Line.push({ Amount: 250, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} }); f.refresh(); assert.doesNotThrow(f.compile);
  f.parents[0].record.Line[1].Amount = 240; f.refresh(); assert.throws(f.compile, /unsupported monetary/);
});
test('stock sales require current quantity and unchanged product accounts', () => {
  for (const change of [record => { record.QtyOnHand = 0; }, record => { delete record.QtyOnHand; }, record => { record.AssetAccountRef.value = '99'; }]) { const f = fixture('SalesReceipt'); change(f.referenceEvidence.find(value => value.record.Id === '101').record); f.refresh(); assert.throws(f.compile); }
});
test('future dates use Halifax rather than the next UTC day', () => {
  const f = fixture('Estimate'); f.now = Date.parse('2026-10-07T01:00:00.000Z'); f.step.txnDate = '2026-10-07'; f.policy.throughDate = '2026-10-07'; f.approve();
  for (const value of [...f.referenceEvidence, f.observationFence]) value.observedAt = new Date(f.now).toISOString();
  assert.throws(f.compile, /elapsed period/);
});
test('dependency swaps and altered detail relationships are refused even with new policy approval', () => {
  const f = fixture(); f.step.details.references = []; f.approve(); assert.throws(f.compile, /dependencies changed/);
  const g = fixture(); g.step.dependencies.push(clone(g.step.dependencies[0])); g.parents.push(clone(g.parents[0])); g.approve(); assert.throws(g.compile);
});

test('observations cannot be reused at another writer revision or operation', () => {
  const f = fixture('Payment'); f.observationFence.writerRevision += 1; assert.throws(f.compile, /verified/);
  const g = fixture('Payment'); g.parents[0].operationId = 'c'.repeat(24); assert.throws(g.compile, /originating transaction/);
  const h = fixture('Payment'), compiled = h.compile();
  assert.equal(compiled.dispatchEvidence.writerRevision, 4); assert.equal(compiled.dispatchEvidence.intentHash, hash(h.step)); assert.equal(compiled.dispatchEvidence.operationId, h.observationFence.operationId);
});
test('deposit requires explicit availability evidence and never infers it from absent links', () => {
  for (const change of [f => { delete f.parents[0].availability; }, f => { f.parents[0].availability.writerRevision = 3; }, f => { f.parents[0].availability.recordHash = hash('other'); }, f => { f.parents[0].availability.status = 'unknown'; }]) { const f = fixture('Deposit'); change(f); assert.throws(f.compile, /availability/); }
});

test('availability proof is separately company-scoped, fresh and included in dispatch expiry', () => {
  const f = fixture('Deposit'); f.parents[0].availability.scope = { ...scope, realmId: '456' }; assert.throws(f.compile, /availability/);
  const g = fixture('Deposit'); g.parents[0].availability.observedAt = '2026-10-06T11:54:59.000Z'; assert.throws(g.compile, /availability/);
  const h = fixture('Deposit'); h.parents[0].availability.observedAt = '2026-10-06T11:59:00.000Z'; assert.equal(h.compile().dispatchEvidence.observedAt, h.parents[0].availability.observedAt);
});
test('inventory availability covers combined quantities across repeated product lines', () => {
  const f = fixture('SalesReceipt'), first = f.step.details.lines[0];
  first.quantity = 6; first.amountCents = 24600;
  f.step.details.lines.push({ ...first, key: 'second', quantity: 7, amountCents: 28700 }); f.step.details.baseAmountCents = 53300;
  const source = f.parents[0].record.Line[0]; source.Amount = 123; source.ItemBasedExpenseLineDetail.Qty = 6;
  const second = clone(source); second.Id = '2'; second.Amount = 143.5; second.ItemBasedExpenseLineDetail.Qty = 7; f.parents[0].record.Line.push(second);
  const item = f.referenceEvidence.find(value => value.record.Id === '101').record; item.QtyOnHand = 10;
  f.approve(); f.refresh(); assert.throws(f.compile, /stock availability/);
  item.QtyOnHand = 13; f.refresh(); assert.doesNotThrow(f.compile);
});

test('saved parent versions retain canonical string types', () => {
  const f = fixture('Payment'); f.parents[0].record.SyncToken = 1; f.parents[0].syncToken = 1; f.refresh();
  assert.throws(f.compile, /originating transaction/);
});

test('current inventory and balances may advance without rewriting the exact approved step', () => {
  const f = fixture('SalesReceipt'), before = f.compile(), approvedStep = clone(f.step), approvedPolicy = clone(f.policy);
  for (const evidence of f.referenceEvidence) { evidence.record.SyncToken = '1'; evidence.record.MetaData = { LastUpdatedTime: '2026-10-06T11:59:00Z' }; }
  f.referenceEvidence.find(value => value.entity === 'Item' && value.record.Id === '101').record.QtyOnHand = 24;
  f.referenceEvidence.find(value => value.entity === 'Customer').record.Balance = 123.45;
  f.referenceEvidence.find(value => value.entity === 'Account' && value.record.Id === '600').record.CurrentBalance = 9876.54;
  f.refresh(); const after = f.compile();
  assert.equal(after.intentHash, before.intentHash); assert.equal(after.request.requestHash, before.request.requestHash);
  assert.notEqual(after.evidenceHash, before.evidenceHash); assert.deepEqual(f.step, approvedStep); assert.deepEqual(f.policy, approvedPolicy);
  f.referenceEvidence.find(value => value.entity === 'Item' && value.record.Id === '101').record.QtyOnHand = 11; f.refresh(); assert.throws(f.compile, /stock availability/);
});
test('same or newer version cannot conceal changed master definitions or a removed approval binding', () => {
  for (const change of [f => { f.referenceEvidence.find(value => value.entity === 'Item' && value.record.Id === '101').record.IncomeAccountRef.value = '999'; }, f => { f.referenceEvidence.find(value => value.entity === 'Customer').record.IsProject = true; }, f => { delete f.step.references[0].definition; f.approve(); }]) {
    const f = fixture('SalesReceipt'); change(f); f.refresh(); assert.throws(f.compile, /definition/);
  }
});
