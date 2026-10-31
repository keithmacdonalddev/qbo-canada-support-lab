'use strict';
// Saved settlement ownership is current, company-scoped and bound to its own parents.
// All stores and reports below are in memory; no dispatch, database or QBO connection.
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { generalRecordsFor } = require('../src/modules/general-write-day-close');
const { classifyRecord } = require('../src/modules/general-write-close');
const { createGeneralCloseGate } = require('../src/modules/general-write-close-gate');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, DAY = '2026-12-02';
const query = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean: async () => structuredClone(value) });
const savedInvoice = () => ({ Id: '700', SyncToken: '0', TxnDate: DAY, Balance: 115, CustomerRef: { value: '1' }, Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' } } }], TxnTaxDetail: { TaxLine: [{ Amount: 15, TaxLineDetail: { TaxRateRef: { value: '8' } } }] } });
const settlement = (entity = 'Payment', id = '900', target = 'Invoice', targetId = '700') => ({ Id: id, SyncToken: '0', TxnDate: '2026-12-01', TotalAmt: 115, Line: [{ Amount: 115, LinkedTxn: [{ TxnType: target, TxnId: targetId }] }] });
const runFor = (items, day = DAY) => ({ _id: 'general-run', ...scope, contract: 'general-write-v1', day, dirty: [], plan: { operations: Object.entries(items).map(([ref, item]) => ({ ref, op: item.op || 'create', entity: item.entity, id: item.qboId })) }, items });
const itemFor = (entity, record, extra = {}) => ({ entity, op: 'create', outcome: 'saved', qboId: record.Id, record, ...extra });
function harness({ items, current, fixed = [] }) {
  const run = runFor(items), closes = [], fixedQueries = [];
  const models = {
    GeneralWriteRuns: { find: filter => { assert.equal(filter.connectionId, scope.connectionId); assert.equal(filter.environment, scope.environment); assert.equal(filter.realmId, scope.realmId); return query([run]); } },
    GeneralDayCloses: { findOne: () => query(null), create: async ([row]) => closes.push(row) },
    Records: { find: () => query([{ qboId: '210', record: { AccountSubType: 'GlobalTaxPayable' } }]) },
    Steps: { find: filter => { fixedQueries.push(filter); return query(fixed.filter(row => ['environment', 'realmId', 'connectionId', 'state'].every(key => row[key] === filter[key]) && filter.$or.some(key => key.entity === row.entity && key.qboId === row.qboId))); } },
  };
  const copy = { read: async (s, entity, id) => structuredClone(entity === 'Item' ? { Id: id, Type: 'Service', IncomeAccountRef: { value: '400' } } : current.get(entity + ':' + id) || null) };
  const entry = (debit, credit) => ({ type: 'Data', ColData: [{ value: DAY }, { value: 'Invoice', id: '700' }, { value: debit }, { value: credit }] });
  const section = (id, row) => ({ type: 'Section', Header: { ColData: [{ id }] }, Rows: { Row: [row] } });
  const readLedger = async () => ({ Header: { ReportName: 'GeneralLedger', ReportBasis: 'Accrual', StartPeriod: DAY, EndPeriod: DAY }, Columns: { Column: ['tx_date', 'txn_type', 'debt_amt', 'credit_amt'].map(ColType => ({ ColType })) }, Rows: { Row: [section('120', entry('115.00', '')), section('400', entry('', '100.00')), section('210', entry('', '15.00'))] } });
  const gate = createGeneralCloseGate({ models, copy });
  return { closes, fixedQueries, gather: () => generalRecordsFor({ Runs: models.GeneralWriteRuns, scope, day: DAY, copy }), close: (read = readLedger) => gate.assertPeriodReady(scope, { fromDate: DAY, throughDate: DAY, verifiedThrough: '2026-12-01', mappings: { accountsReceivable: '120' }, readLedger: read }), readLedger };
}
function paidFixture(payment = settlement()) {
  const invoice = savedInvoice(), paid = { ...invoice, Balance: 0, LinkedTxn: [{ TxnType: 'Payment', TxnId: payment.Id }] };
  return { invoice, paid, items: { inv: itemFor('Invoice', invoice), pay: itemFor('Payment', payment) }, current: new Map([['Invoice:700', paid], ['Payment:' + payment.Id, payment]]) };
}
function fixedStep(payment) {
  return { ...scope, entity: 'Payment', qboId: payment.Id, state: 'verified', revision: 1, receipt: { qboId: payment.Id }, dispatch: { compilationHash: 'b'.repeat(64) }, verification: { kind: 'business-readback', compilationHash: 'b'.repeat(64), observedHash: hash(payment), relationships: [{ entity: 'Invoice', qboId: '700' }] } };
}

test('saved general payments, credits, supplier payments and deposits retain exact application targets', async () => {
  const items = {}, current = new Map();
  for (const [i, entity] of ['Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'Deposit'].entries()) {
    const record = settlement(entity, String(900 + i));
    items[entity] = itemFor(entity, record); current.set(entity + ':' + record.Id, record);
  }
  const gathered = await harness({ items, current }).gather();
  assert.equal(gathered.records.length, 0, 'settlements are outside the closing date');
  assert.deepEqual(gathered.ownSettlements, Object.values(items).map(item => ({ key: item.entity + ':' + item.qboId, targets: ['Invoice:700'] })).sort((a, b) => a.key.localeCompare(b.key)));
});

test('a saved own payment from another date can explain its original invoice at close', async () => {
  const h = harness(paidFixture());
  assert.equal((await h.close()).results[0].ok, true);
  assert.equal(h.fixedQueries.length, 0, 'general evidence does not need a fixed workflow lookup');
});

for (const change of ['reassigned', 'amount changed', 'missing', 'void operation', 'void status', 'void note', 'deleted', 'unknown', 'mismatch', 'unapplied']) {
  test('an out-of-range general settlement is not trusted when ' + change, async () => {
    const original = settlement(), f = paidFixture(original), item = f.items.pay;
    if (change === 'reassigned') { item.record = settlement('Payment', '900', 'Invoice', '701'); }
    if (change === 'amount changed') f.current.set('Payment:900', { ...original, TotalAmt: 230, SyncToken: '1' });
    if (change === 'missing') f.current.delete('Payment:900');
    if (change === 'void operation') item.op = 'void';
    if (change === 'void status') { item.record = { ...original, status: 'Voided' }; f.current.set('Payment:900', item.record); }
    if (change === 'void note') { item.record = { ...original, PrivateNote: 'Voided by operator' }; f.current.set('Payment:900', item.record); }
    if (change === 'deleted') { item.op = 'delete'; item.outcome = 'deleted'; }
    if (['unknown', 'mismatch'].includes(change)) item.outcome = change;
    if (change === 'unapplied') { item.record = { ...original, Line: [] }; f.current.set('Payment:900', item.record); }
    const h = harness(f);
    assert.deepEqual((await h.gather()).ownSettlements, []);
    await assert.rejects(h.close(), /Invoice changed after it was proved/);
  });
}

test('an own deposit explains its payment version before that payment explains its invoice', async () => {
  const f = paidFixture(), deposit = { ...settlement('Deposit', '901', 'Payment', '900'), DepositToAccountRef: { value: '100' } };
  f.items.deposit = itemFor('Deposit', deposit); f.current.set('Deposit:901', deposit);
  f.current.set('Payment:900', { ...f.items.pay.record, SyncToken: '1', DepositToAccountRef: { value: '100' }, LinkedTxn: [{ TxnType: 'Deposit', TxnId: '901' }] });
  const h = harness(f);
  assert.deepEqual((await h.gather()).ownSettlements.map(row => row.key), ['Deposit:901', 'Payment:900']);
  assert.equal((await h.close()).results[0].ok, true);
});

test('target-bound ownership cannot explain a different parent even when the settlement ID is owned', () => {
  const original = savedInvoice(), current = { ...original, Balance: 0, LinkedTxn: [{ TxnType: 'Payment', TxnId: '900' }] };
  const evidence = { accountant: { record: original, versionHash: hash(original) } };
  assert.equal(classifyRecord({ entity: 'Invoice', current, evidence, ownSettlements: new Map([['Payment:900', new Set(['Invoice:701'])]]) }).kind, 'external-change');
});

test('a verified fixed-workflow settlement of the same company and parent passes general close', async () => {
  const payment = settlement(), f = paidFixture(payment); delete f.items.pay;
  const h = harness({ ...f, fixed: [fixedStep(payment)] });
  assert.equal((await h.close()).results[0].ok, true);
  assert.deepEqual(h.fixedQueries[0], { ...scope, state: 'verified', $or: [{ entity: 'Payment', qboId: '900' }] });
});

for (const change of ['unverified', 'other connection', 'other company', 'other environment', 'other parent', 'changed current record']) {
  test('fixed-workflow settlement evidence fails for ' + change, async () => {
    const payment = settlement(), f = paidFixture(payment), step = fixedStep(payment); delete f.items.pay;
    if (change === 'unverified') step.state = 'saved';
    if (change === 'other connection') step.connectionId = 'c'.repeat(24);
    if (change === 'other company') step.realmId = '456';
    if (change === 'other environment') step.environment = 'production';
    if (change === 'other parent') step.verification.relationships[0].qboId = '701';
    if (change === 'changed current record') f.current.set('Payment:900', { ...payment, TotalAmt: 50 });
    await assert.rejects(harness({ ...f, fixed: [step] }).close(), /Invoice changed after it was proved/);
  });
}

test('fixed settlement proof changes during the ledger read cannot produce a close', async () => {
  const payment = settlement(), f = paidFixture(payment), step = fixedStep(payment); delete f.items.pay;
  const h = harness({ ...f, fixed: [step] });
  await assert.rejects(h.close(async () => { const report = await h.readLedger(); step.revision++; return report; }), /changed while the ledger was read/);
  assert.equal(h.closes.length, 0);
});

test('out-of-range current settlement changes during the ledger read invalidate the snapshot', async () => {
  const f = paidFixture(), h = harness(f);
  await assert.rejects(h.close(async () => { const report = await h.readLedger(); f.current.set('Payment:900', { ...f.items.pay.record, TotalAmt: 50 }); return report; }), /changed while the ledger was read/);
  assert.equal(h.closes.length, 0);
});
