'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash, canonical } = require('../src/modules/business-calendar');
const { invoiceReceivablesEvidence, verifyInvoiceReceivables } = require('../src/modules/business-receivables-route');
const { routingFixture } = require('./helpers/business-receivables-fixture');
const { fixture, clone, now } = require('./helpers/business-transaction-fixtures');
const { bindParent } = require('./helpers/business-readback-fixtures');
test('omitted Invoice AR is verified from exact ledger posting without changing raw record or request', () => {
  const { value, input } = routingFixture(), raw = canonical(value.observed.record), request = canonical(value.compiled);
  assert.equal(verifyInvoiceReceivables({ observed: value.observed, compiled: value.compiled, receipt: value.receipt, now }), '601');
  const proof = value.check(); assert.equal(proof.matchesIntent, true); assert.equal(proof.accountRouting.accountId, '601');
  assert.equal(canonical(value.observed.record), raw); assert.equal(canonical(value.compiled), request); assert.equal(value.observed.record.ARAccountRef, undefined);
  assert.equal(input.report.Rows.Row[0].Rows.Row[0].ColData[1].id, value.observed.record.Id);
});
test('foreign, stale, incomplete, changed and ambiguous ledger sources fail closed', () => {
  const changes = [
    i => { i.observed.scope.realmId = '456'; }, i => { i.observed.record.SyncToken = '1'; }, i => { i.observed.record.ARAccountRef = { value: '999' }; },
    i => { i.receipt.qboId = '999'; }, i => { i.receipt.requestHash = hash('different'); }, i => { i.compiled.compilationHash = hash('different'); },
    i => { i.accountBinding.id = '999'; }, i => { i.accountObserved.record.AccountType = 'Bank'; }, i => { i.beforeFence.revision++; },
    i => { i.reportObservedAt = new Date(now - 300001).toISOString(); }, i => { i.report.Header.ReportBasis = 'Cash'; }, i => { i.report.Header.Currency = 'USD'; },
    i => { i.report.Header.StartPeriod = '2026-10-01'; }, i => { i.report.Header.Option.push({ Name: 'Truncated', Value: 'true' }); },
    i => { i.report.Rows.Row[0].Header.ColData[0].id = '999'; }, i => { i.report.Rows.Row.push(clone(i.report.Rows.Row[0])); },
    i => { i.report.Rows.Row[0].Rows.Row[0].ColData[1].id = '999'; }, i => { i.report.Rows.Row[0].Rows.Row[0].ColData[1].value = 'Payment'; },
    i => { i.report.Rows.Row[0].Rows.Row[0].ColData[2].value = '1.00'; }, i => { i.report.Rows.Row[0].Rows.Row.push(clone(i.report.Rows.Row[0].Rows.Row[0])); },
    i => { i.report.Columns.Column.push({ ColType: 'txn_type' }); }, i => { i.report.Rows.Row[0].Rows.Row[0].Rows = {}; },
  ];
  for (const change of changes) { const { input } = routingFixture(); delete input.observed.accountRouting; change(input); assert.throws(() => invoiceReceivablesEvidence(input)); }
});
test('a copied routing hash cannot survive source or current raw record changes', () => {
  for (const change of [v => { v.observed.accountRouting.source.report.Rows.Row[0].Rows.Row[0].ColData[2].value = '1.00'; }, v => { v.observed.record.SyncToken = '1'; v.refresh(); }, v => { v.observed.accountRouting.accountId = '999'; }, v => { delete v.observed.accountRouting; }]) {
    const { value } = routingFixture(); change(value); assert.throws(() => value.check());
  }
});
test('explicit wrong AR remains a mismatch even with valid earlier missing-field evidence', () => {
  const { value } = routingFixture(); value.observed.record.ARAccountRef = { value: '999' }; value.refresh(); assert.equal(value.check().matchesIntent, false);
});
test('payment keeps an explicit approved AR reference using fresh ledger and persisted invoice proof', () => {
  const { value } = routingFixture(), f = fixture('Payment'); bindParent(f, 0, value);
  f.parents[0] = { ...f.parents[0], ...clone(value.observed), verification: value.check() }; f.refresh(); f.approve();
  const compiled = f.compile(), payload = JSON.parse(compiled.request.body); assert.equal(payload.ARAccountRef.value, '601'); assert.equal(payload.TotalAmt, value.observed.record.TotalAmt);
  const original = clone(f.parents[0]);
  for (const change of [p => { delete p.verification; }, p => { p.accountRouting.writerRevision++; }, p => { p.verification.accountRouting.receiptHash = hash('different'); }, p => { p.verification.observedAt = new Date(now - 300001).toISOString(); }]) { f.parents[0] = clone(original); change(f.parents[0]); assert.throws(() => f.compile()); }
});

test('a returned target does not excuse a report truncation warning or malformed unrelated row', () => {
  for (const cells of [[{ value: 'Unable to display more data. Please reduce the date range.' }, { value: '' }, { value: '' }], [{ value: '2026-10-06' }, null, { value: '0.00' }]]) {
    const { input } = routingFixture(); input.report.Rows.Row[0].Rows.Row.push({ type: 'Data', ColData: cells });
    assert.throws(() => invoiceReceivablesEvidence(input));
  }
});

test('payment replays the original routing observation after a later unchanged invoice read', () => {
  const { value, input } = routingFixture();
  value.observed.observedAt = new Date(now - 1000).toISOString();
  value.observed.accountRouting = invoiceReceivablesEvidence(input);
  const retained = clone(value.check()), f = fixture('Payment'); bindParent(f, 0, value);
  value.observed.observedAt = new Date(now).toISOString();
  value.observed.accountRouting = invoiceReceivablesEvidence(input);
  f.parents[0] = { ...f.parents[0], ...clone(value.observed), verification: retained }; f.refresh(); f.approve();
  assert.equal(JSON.parse(f.compile().request.body).ARAccountRef.value, '601');
  const original = clone(f.parents[0]);
  for (const change of [
    p => { p.verification.accountRouting.invoiceObservedAt = new Date(now - 300001).toISOString(); },
    p => { p.verification.accountRouting.invoiceObservedAt = new Date(now + 1).toISOString(); },
    p => { p.verification.accountRouting.invoiceObservedAt = p.observedAt; },
    p => { p.record.SyncToken = '1'; p.syncToken = '1'; p.recordHash = hash(p.record); },
    p => { p.observedAt = new Date(now - 300001).toISOString(); },
    p => { p.observedAt = new Date(now - 2000).toISOString(); },
  ]) { f.parents[0] = clone(original); change(f.parents[0]); assert.throws(() => f.compile()); }
});
