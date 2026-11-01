'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sameQboValue, matchesQboRequest } = require('../src/modules/qbo-semantic-compare');
const { classifyRecord, sameProvenRecord } = require('../src/modules/general-write-close');
const { generalRecordsFor } = require('../src/modules/general-write-day-close');
const { hash } = require('../src/modules/business-calendar');
const fixture = require('./fixtures/qbo-free-form-address.json');

for (const entity of ['SalesReceipt', 'Invoice', 'CreditMemo', 'RefundReceipt', 'Estimate']) {
  test(entity + ' treats only the root FreeFormAddress default as absent/false', () => {
    const saved = { Id: '1', SyncToken: '0', Line: [] };
    const current = { ...saved, FreeFormAddress: false };
    assert.equal(sameQboValue(saved, current, { entity }), true);
    assert.equal(sameQboValue(current, saved, { entity }), true);
    assert.equal(sameProvenRecord(entity, saved, current, hash(saved)), true);
    assert.equal(matchesQboRequest(current, saved, { entity }), true);
    assert.equal(matchesQboRequest(saved, current, { entity }), true);
    for (const value of [undefined, false]) {
      const withoutTrue = { ...saved, ...(value === undefined ? {} : { FreeFormAddress: value }) };
      const withTrue = { ...saved, FreeFormAddress: true };
      assert.equal(sameQboValue(withoutTrue, withTrue, { entity }), false);
      assert.equal(sameQboValue(withTrue, withoutTrue, { entity }), false);
      assert.equal(matchesQboRequest(withTrue, withoutTrue, { entity }), false);
      assert.equal(sameProvenRecord(entity, withoutTrue, withTrue, hash(withoutTrue)), false);
    }
    assert.equal(sameQboValue({ Extension: {} }, { Extension: { FreeFormAddress: false } }, { entity }), false);
    assert.equal(matchesQboRequest({ Extension: { FreeFormAddress: false } }, { Extension: {} }, { entity }), false);
    assert.equal(sameQboValue(saved, { ...saved, Unknown: false }, { entity }), false);
  });
}

test('FreeFormAddress normalization requires a known sales-form entity', () => {
  for (const entity of [undefined, 'Bill', 'PurchaseOrder', 'Customer', 'Payment']) {
    assert.equal(sameQboValue({}, { FreeFormAddress: false }, { entity }), false);
    assert.equal(matchesQboRequest({ FreeFormAddress: false }, {}, { entity }), false);
  }
});

for (const row of fixture.records) {
  test('stored SalesReceipt ' + row.id + ' replays through live record gathering and classification', async () => {
    assert.equal(Object.hasOwn(row.saved, 'FreeFormAddress'), false);
    assert.equal(row.current.FreeFormAddress, false);
    assert.equal(row.saved.SyncToken, '0');
    assert.equal(row.current.SyncToken, '0');
    const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
    const run = { _id: fixture.provenance.runId, ...scope, status: 'complete', day: row.saved.TxnDate,
      plan: { operations: [{ ref: 'receipt', op: 'create', entity: row.entity, payload: row.request }] },
      items: { receipt: { entity: row.entity, op: 'create', outcome: 'saved', qboId: row.id, request: row.request, record: row.saved } }, batches: [], dirty: [] };
    const query = { select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean: async () => [run] };
    const gathered = await generalRecordsFor({ Runs: { find: () => query }, scope, day: row.saved.TxnDate,
      copy: { read: async (_scope, entity, id) => { assert.equal(entity, row.entity); assert.equal(id, row.id); return structuredClone(row.current); } } });
    assert.equal(gathered.records.length, 1);
    const record = gathered.records[0];
    assert.equal(classifyRecord(record).kind, 'accountant');
    assert.equal(matchesQboRequest(row.request, row.current, { entity: row.entity }), true);
    const changed = mutate => { const current = structuredClone(row.current); mutate(current); return classifyRecord({ ...record, current }).kind; };
    for (const mutate of [
      r => { r.FreeFormAddress = true; },
      r => { r.Line[0].Amount += 0.01; },
      r => { r.TotalAmt += 0.01; },
      r => { r.CustomerRef.value = '999999'; },
      r => { r.DepositToAccountRef.value = '999999'; },
      r => { r.Line[0].SalesItemLineDetail.ItemRef.value = '999999'; },
      r => { r.Line[0].SalesItemLineDetail.TaxCodeRef.value = '999999'; },
      r => { r.TxnTaxDetail.TotalTax += 0.01; },
      r => { r.CurrencyRef.value = 'USD'; },
      r => { r.SyncToken = '-1'; },
    ]) assert.equal(changed(mutate), 'external-change');
    assert.equal(sameProvenRecord(row.entity, row.saved, row.current, hash('forged')), false);
  });
}
