'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { replayAdoptedStock, populationStockRows, adoptedPurchaseOrigin } = require('../src/modules/business-adopted-stock');
const { validateStockState } = require('../src/modules/business-stock-cost');

const scope = { environment: 'production', realmId: '123', connectionId: 'c'.repeat(24) };
const jobId = 'j'.repeat(24).replace(/j/g, 'a');
const root = { rootHash: 'r'.repeat(64).replace(/r/g, 'b'), openingDate: '2026-08-01', fiscalYearStartMonth: 9, items: [{ itemKey: 'workshop-stock-1', itemId: '48', assetAccountId: '10', costAccountId: '11' }] };
let n = 0;
function record(entity, txnDate, qty, price) {
  n++;
  const line = entity === 'Bill' ? { DetailType: 'ItemBasedExpenseLineDetail', Amount: qty * price, ItemBasedExpenseLineDetail: { ItemRef: { value: '48' }, Qty: qty, UnitPrice: price } } : { DetailType: 'SalesItemLineDetail', Amount: qty * 50, SalesItemLineDetail: { ItemRef: { value: '48' }, Qty: qty, UnitPrice: 50 } };
  const body = JSON.stringify({ TxnDate: txnDate, CurrencyRef: { value: 'CAD' }, Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 5, AccountBasedExpenseLineDetail: { AccountRef: { value: '7' } } }, line] });
  return { environment: 'production', realmId: '123', entity, txnDate, state: 'saved', qboId: String(1000 + n), logicalKey: hash({ n }), receipt: { qboId: String(1000 + n) }, compilation: { compilationHash: hash({ c: n }), request: { requestHash: hash({ r: n }), body } }, policy: { p: n } };
}
const rows = [record('Bill', '2026-08-03', 10, 2), record('SalesReceipt', '2026-08-20', 4), record('Bill', '2026-09-02', 5, 3), record('SalesReceipt', '2026-09-10', 8), record('SalesReceipt', '2026-10-01', 1)];
function model(list) {
  const match = (row, q) => row.environment === q.environment && row.realmId === q.realmId && (!q.entity || (q.entity.$in ? q.entity.$in.includes(row.entity) : row.entity === q.entity)) && (!q.state || row.state === q.state) && (!q.txnDate || (row.txnDate >= q.txnDate.$gte && row.txnDate <= q.txnDate.$lte)) && (!q.qboId || row.qboId === q.qboId) && (!q.logicalKey || row.logicalKey === q.logicalKey);
  const chain = found => { const api = { select: () => api, sort: () => api, session: () => api, maxTimeMS: () => api, lean: () => api, cursor: () => found, then: (ok, ko) => Promise.resolve(found).then(ok, ko) }; return api; };
  return { find: q => chain(list.filter(row => match(row, q))), findOne: q => chain(list.find(row => match(row, q)) || null) };
}

test('imported stock replays month by month into FIFO lots with fiscal-year cost', async () => {
  const { state, carry, replay, summary } = await replayAdoptedStock({ models: { Records: model(rows) }, scope, root, jobId, through: '2026-10-17' });
  validateStockState(state, scope);
  assert.equal(replay.months, 3);
  assert.equal(replay.lines, 5);
  assert.equal(summary.quantity, 2);
  // FIFO: 10@2 then 5@3; sales 4 (Aug, at 2) + 8 (Sep: 6@2 + 2@3) + 1 (Oct, at 3) leave 2@3.
  assert.equal(summary.valueCents, 600);
  assert.equal(replay.costOfSalesCents, 800 + 1200 + 600 + 300);
  assert.equal(carry.costCents, 1200 + 600 + 300, 'only fiscal-year (from September) cost of sales is carried');
  assert.equal(carry.kind, 'adopted-history');
  assert.equal(state.items[0].lots[0].source.receiptSource, 'population-readback');
  const again = await replayAdoptedStock({ models: { Records: model(rows) }, scope, root, jobId, through: '2026-10-17' });
  assert.equal(again.carry.replayHash, carry.replayHash);
});

test('a sale without enough imported stock cannot be replayed', async () => {
  await assert.rejects(replayAdoptedStock({ models: { Records: model([record('SalesReceipt', '2026-08-02', 1)]) }, scope, root, jobId, through: '2026-08-31' }), /negative stock/);
});

test('imported stock lines must keep their saved identity, date and supported line type', () => {
  const bad = record('Bill', '2026-08-05', 1, 2);
  assert.throws(() => populationStockRows(scope, jobId, root.items, { ...bad, txnDate: '2026-08-06' }), /date/);
  assert.throws(() => populationStockRows(scope, jobId, root.items, { ...bad, receipt: { qboId: 'other' } }), /saved imported/);
  const wrongType = record('SalesReceipt', '2026-08-05', 1);
  assert.throws(() => populationStockRows(scope, jobId, root.items, { ...wrongType, entity: 'Bill' }), /unsupported type/);
});

test('a remaining imported purchase layer is checked against its saved bill and tax', async () => {
  const { state } = await replayAdoptedStock({ models: { Records: model(rows) }, scope, root, jobId, through: '2026-10-17' });
  const lots = state.items[0].lots, qboId = lots[0].source.qboId, tax = { version: 1, totalTaxCents: 0, lines: [] };
  const origin = await adoptedPurchaseOrigin({ Records: model(rows) }, scope, state, qboId, lots, { taxExpectation: () => tax });
  assert.equal(origin.qboId, qboId);
  assert.equal(origin.tax, tax);
  const changed = rows.map(row => row.qboId === qboId ? { ...row, compilation: { ...row.compilation, request: { ...row.compilation.request, body: row.compilation.request.body.replace('"UnitPrice":3', '"UnitPrice":4') } } } : row);
  await assert.rejects(adoptedPurchaseOrigin({ Records: model(changed) }, scope, state, qboId, lots, { taxExpectation: () => tax }), /differs/);
});
