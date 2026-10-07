'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { verifyBusinessContent, verifyBusinessReadback, createBusinessReadbackAdapter } = require('../src/modules/business-readback');
const { sample, bindParent, descendant, ENTITIES, scope, now, clone } = require('./helpers/business-readback-fixtures');
for (const entity of ENTITIES) test('reads exact saved ' + entity + ' content and closes verified parent relationships', () => {
  const h = sample(entity), proof = h.check(); assert.equal(proof.matchesIntent, true, JSON.stringify(proof.issues)); assert.equal(proof.kind, 'business-readback'); assert.equal(proof.compilationHash, h.compiled.compilationHash); assert.equal(proof.relationships.length, h.parents.length);
});
test('altered artifact metadata cannot substitute for the original compilation', () => {
  for (const change of [h => { h.compiled.intentHash = hash('other'); }, h => { h.compiled.relationships[0].qboId = '99'; }, h => { h.compiled.evidenceHash = hash('other'); }]) { const h = sample(); change(h); assert.throws(h.check, /artifact changed/); }
});
test('fresh scoped exact record and receipt evidence are mandatory', () => {
  for (const change of [h => { h.observed.scope = { ...scope, realmId: '456' }; }, h => { h.observed.record.Id = '99'; h.refresh(); }, h => { h.observed.record.SyncToken = 1; h.refresh(); }, h => { h.observed.observedAt = '2026-10-06T11:54:59.000Z'; }, h => { h.observed.record.PrivateNote = 'changed'; }, h => { h.receipt.scope = { ...scope, environment: 'production' }; }, h => { h.receipt.requestHash = hash('other'); }]) { const h = sample(); change(h); assert.throws(h.check); }
});
test('quantity, price, amount and exact PO line links must match', () => {
  for (const change of [r => { r.Line[0].ItemBasedExpenseLineDetail.Qty += 1; }, r => { r.Line[0].ItemBasedExpenseLineDetail.UnitPrice += 0.01; }, r => { r.Line[0].Amount += 0.01; }, r => { r.Line[0].LinkedTxn[0].TxnLineId = '2'; }, r => { delete r.Line[0].LinkedTxn; }, r => { r.Line.push(clone(r.Line[0])); }]) { const h = sample('Bill'); change(h.observed.record); h.refresh(); assert.equal(h.check().matchesIntent, false); }
});
test('subcent monetary values and unplanned accounting dimensions fail', () => {
  for (const change of [r => { r.Line[0].Amount += 0.00000005; }, r => { r.DepartmentRef = { value: '9' }; }, r => { r.Line[0].SalesItemLineDetail.CustomerRef = { value: '99' }; }, r => { r.Line[0].LinkedTxn.push({ TxnId: '9', TxnType: 'Estimate', TxnLineId: '1' }); }]) { const h = sample(); change(h.observed.record); h.refresh(); assert.equal(h.check().matchesIntent, false); }
});
test('approved tax rates and amounts are checked independently of arithmetic', () => {
  for (const change of [h => { h.taxPolicy = null; }, h => { h.taxPolicy.compilationHash = hash('other'); }, h => { h.observed.record.TxnTaxDetail.TotalTax += 1; h.observed.record.TotalAmt += 1; }, h => { h.observed.record.TxnTaxDetail.TaxLine[0].TaxLineDetail.TaxPercent = 14; }, h => { h.observed.record.TxnTaxDetail.TaxLine[0].TaxLineDetail.NetAmountTaxable = 249; }]) { const h = sample(); change(h); h.refresh(); assert.equal(h.check().matchesIntent, false); }
});
test('safe generated subtotal is permitted while extra financial lines are refused', () => {
  const h = sample(); h.observed.record.Line.push({ DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {}, Amount: 250 }); h.refresh(); assert.equal(h.check().matchesIntent, true);
  h.observed.record.Line.push({ DetailType: 'DiscountLineDetail', Amount: 0, DiscountLineDetail: {} }); h.refresh(); assert.equal(h.check().matchesIntent, false);
});
test('changed parent proofs cannot close the relationship graph', () => {
  for (const change of [h => { h.parents[0].record.SyncToken = '1'; h.parents[0].recordHash = hash(h.parents[0].record); }, h => { h.parents[0].verification.observedHash = hash('other'); }, h => { h.parents[0].verification.kind = 'business-content'; }, h => { h.parents[0].verification.observedAt = '2026-10-06T11:54:59.000Z'; }]) { const h = sample(); change(h); assert.throws(h.check, /verification/); }
});
test('content proof does not require closed parent graph and cannot claim readback kind', () => {
  const h = sample(); for (const parent of h.parents) { parent.state = 'saved'; delete parent.verification; }
  assert.equal(h.content().matchesIntent, true); assert.equal(h.content().kind, 'business-content'); assert.throws(h.check, /freshly verified/);
});
test('fresh invoice content can explain billed time before closing the invoice graph', () => {
  const time = sample('TimeActivity'), invoice = sample('Invoice', f => bindParent(f, 1, time));
  invoice.observed.record.Id = '3000'; invoice.receipt.qboId = '3000'; invoice.refresh();
  invoice.parents[1].state = 'saved'; delete invoice.parents[1].verification;
  time.observed.record.BillableStatus = 'HasBeenBilled'; time.observed.record.LinkedTxn = [{ TxnId: '3000', TxnType: 'Invoice' }]; time.refresh();
  time.descendants = [descendant(invoice)]; assert.equal(time.check().matchesIntent, true);
  const original = clone(time.descendants[0]);
  for (const change of [v => { v.record.Line[0].Amount += 1; v.recordHash = hash(v.record); }, v => { v.creationReceipt.scope = { ...scope, realmId: '456' }; }, v => { v.verification.compilationHash = hash('other'); }, v => { v.verification.matchesIntent = false; }, v => { v.verification.relationships[1].logicalKey = hash('other parent'); }, v => { v.verification.relationships[1].syncToken = '2'; }]) { time.descendants = [clone(original)]; change(time.descendants[0]); assert.throws(time.check); }
  time.descendants = []; assert.equal(time.check().matchesIntent, false);
});
test('invoice and bill balances must equal total less exact known settlement applications', () => {
  for (const entity of ['Invoice', 'Bill']) { const h = sample(entity); h.observed.record.Balance = 0; h.refresh(); assert.equal(h.check().matchesIntent, false); delete h.observed.record.Balance; h.refresh(); assert.throws(h.check, /monetary/); }
  const h = sample(), payment = sample('Payment', f => bindParent(f, 0, h));
  payment.observed.record.Id = '3000'; payment.receipt.qboId = '3000'; payment.refresh(); h.descendants = [descendant(payment)]; h.observed.record.LinkedTxn.push({ TxnId: '3000', TxnType: 'Payment' }); h.observed.record.Balance = 0; h.refresh(); assert.equal(h.check().matchesIntent, true);
  h.observed.record.Balance = 1; h.refresh(); assert.equal(h.check().matchesIntent, false);
});
test('PO API consumed quantity and state must match exact bill line applications', () => {
  const po = sample('PurchaseOrder'), bill = sample('Bill', f => bindParent(f, 0, po));
  bill.observed.record.Id = '3000'; bill.receipt.qboId = '3000'; bill.refresh(); po.descendants = [descendant(bill)]; po.observed.record.LinkedTxn = [{ TxnId: '3000', TxnType: 'Bill' }]; po.observed.record.Line[0].Received = 12; po.observed.record.POStatus = 'Closed'; po.refresh(); assert.equal(po.check().matchesIntent, true);
  po.observed.record.Line[0].Id = '9'; po.observed.record.Line[0].Received = 0; po.observed.record.POStatus = 'Open'; po.refresh(); assert.throws(po.check, /missing or ambiguous/);
  po.observed.record.Line[0].Id = '1'; po.observed.record.POStatus = 'Closed';
  po.observed.record.Line[0].Received = 5; po.refresh(); assert.equal(po.check().matchesIntent, false);
  po.observed.record.Line[0].Received = 12; po.observed.record.POStatus = 'Open'; po.refresh(); assert.equal(po.check().matchesIntent, false);
});
test('adapter binds stored receipt and compilation without laundering mismatched fields', async () => {
  const h = sample(), step = { ...scope, entity: h.compiled.entity, logicalKey: h.compiled.logicalKey, fingerprint: h.compiled.intentHash, qboId: h.receipt.qboId, dispatch: { key: h.receipt.dispatchKey, requestHash: h.receipt.requestHash, compilationHash: h.compiled.compilationHash }, receipt: clone(h.receipt) };
  const adapter = createBusinessReadbackAdapter({ loadCompilation: async () => h.compiled, readRecord: async () => h.observed, loadParents: async () => h.parents, loadDescendants: async () => h.descendants, loadTaxPolicy: async () => h.taxPolicy, now: () => now });
  assert.equal((await adapter(step)).matchesIntent, true);
  for (const change of [s => { s.receipt.dispatchKey = hash('other'); }, s => { s.receipt.qboId = '99'; }, s => { s.dispatch.compilationHash = hash('other'); }, s => { s.receipt.version = 2; }]) { const changed = clone(step); change(changed); await assert.rejects(adapter(changed)); }
});

test('root proof cannot extend the freshness of related content or completed parent proof', () => {
  const h = sample(); h.parents[0].verification.observedAt = '2026-10-06T11:55:01.000Z'; assert.equal(h.check().observedAt, h.parents[0].verification.observedAt);
  const time = sample('TimeActivity'), invoice = sample('Invoice', f => bindParent(f, 1, time));
  invoice.observed.record.Id = '3000'; invoice.receipt.qboId = '3000'; invoice.refresh();
  time.observed.record.BillableStatus = 'HasBeenBilled'; time.observed.record.LinkedTxn = [{ TxnId: '3000', TxnType: 'Invoice' }]; time.refresh();
  const child = descendant(invoice); child.verification.observedAt = '2026-10-06T11:55:01.000Z'; time.descendants = [child];
  assert.equal(time.check().observedAt, child.verification.observedAt);
});
