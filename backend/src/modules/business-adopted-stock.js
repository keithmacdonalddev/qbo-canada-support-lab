'use strict';
// FIFO stock carried from adopted population history. Lots are rebuilt by
// replaying the imported stock Bills and SalesReceipts from the accepted zero
// root, month by month, with the same calculator committed periods use. Nothing
// is inferred from current quantities. Pure reads of saved app records only.
const { hash, shift } = require('./business-calendar');
const { emptyStockState, calculateStockCost, validateStockState, summarizeStockState } = require('./business-stock-cost');
const RECEIPT_SOURCE = 'population-readback';
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/;
function fail(message) { throw Object.assign(Error(message), { status: 409, code: 'BUSINESS_STOCK_COST_UNVERIFIED' }); }
function money(value) { if (typeof value !== 'number' || !Number.isFinite(value)) fail('Imported stock cost needs an exact monetary value.'); const cents = Math.round(value * 100); if (!Number.isSafeInteger(cents) || cents < 0 || Math.abs(value * 100 - cents) > 1e-6) fail('Imported stock cost is not exact cents.'); return cents; }
const fiscalYear = (day, month) => Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) < month ? 1 : 0);
const monthEnd = day => { const [y, m] = day.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

function populationSource(scope, jobId, row, lineIndex) {
  if (!ID.test(jobId || '') || !HASH.test(row.logicalKey || '') || !HASH.test(row.compilation?.compilationHash || '') || !HASH.test(row.compilation?.request?.requestHash || '') || !row.receipt || !/^\d{1,30}$/.test(row.qboId || '')) fail('An imported stock record lacks its exact saved identity.');
  return { operationId: jobId, scopeHash: hash(scope), logicalKey: row.logicalKey, qboId: row.qboId, lineIndex, compilationHash: row.compilation.compilationHash, requestHash: row.compilation.request.requestHash, receiptHash: hash(row.receipt), receiptSource: RECEIPT_SOURCE };
}
// Stock lines of one saved population Bill or SalesReceipt, in calculator row shape.
function populationStockRows(scope, jobId, items, row) {
  if (row.state !== 'saved' || row.qboId !== row.receipt?.qboId || !['Bill', 'SalesReceipt'].includes(row.entity)) fail('Only saved imported stock bills and sales receipts can be replayed.');
  const body = JSON.parse(row.compilation.request.body), rows = [], ids = new Map(items.map(item => [item.itemId, item]));
  if (body.TxnDate !== row.txnDate || body.CurrencyRef?.value !== 'CAD' || !Array.isArray(body.Line)) fail('An imported stock record changed its date, currency or lines.');
  for (const [lineIndex, line] of body.Line.entries()) {
    const detail = line?.[line.DetailType], itemId = detail?.ItemRef?.value;
    if (!ids.has(itemId)) continue;
    if (line.DetailType !== (row.entity === 'Bill' ? 'ItemBasedExpenseLineDetail' : 'SalesItemLineDetail') || !Number.isSafeInteger(detail.Qty) || detail.Qty <= 0) fail('An imported stock line has an unsupported type or quantity.');
    rows.push({ entity: row.entity, txnDate: row.txnDate, itemId, quantity: detail.Qty, source: populationSource(scope, jobId, row, lineIndex), ...(row.entity === 'Bill' ? { unitCostCents: money(detail.UnitPrice) } : {}) });
  }
  return rows;
}

async function readPopulationStock(models, scope, jobId, items, { fromDate, through, session = null }) {
  const rows = [], ids = items.map(item => item.itemId);
  const query = { environment: scope.environment, realmId: scope.realmId, entity: { $in: ['Bill', 'SalesReceipt'] }, state: 'saved', txnDate: { $gte: fromDate, $lte: through } };
  for await (const row of models.Records.find(query).select('logicalKey entity txnDate state qboId receipt compilation').sort({ txnDate: 1, _id: 1 }).limit(50001).batchSize(50001).session(session).maxTimeMS(30000).lean()) {
    const body = row.compilation?.request?.body;
    if (typeof body !== 'string' || !ids.some(id => body.includes('"value":"' + id + '"'))) continue;
    rows.push(...populationStockRows(scope, jobId, items, row));
  }
  return rows;
}

// Replay every imported stock movement from the zero root through the adoption date.
async function replayAdoptedStock({ models, scope, root, jobId, through, session = null }) {
  let state = emptyStockState({ scope, rootHash: root.rootHash, throughDate: shift(root.openingDate, -1), items: root.items });
  const rows = await readPopulationStock(models, scope, jobId, state.items, { fromDate: root.openingDate, through, session });
  let costCents = 0, months = 0, purchaseCents = 0, costOfSalesCents = 0;
  while (state.throughDate < through) {
    const fromDate = shift(state.throughDate, 1), throughDate = [monthEnd(fromDate), through].sort()[0];
    const result = calculateStockCost(state, rows.filter(row => row.txnDate >= fromDate && row.txnDate <= throughDate), { fromDate, throughDate });
    if (fiscalYear(fromDate, root.fiscalYearStartMonth) === fiscalYear(through, root.fiscalYearStartMonth)) costCents += result.costOfSalesCents;
    purchaseCents += result.purchaseCents; costOfSalesCents += result.costOfSalesCents; state = result.closing; months++;
  }
  validateStockState(state, scope);
  const replay = { version: 1, jobId, through, months, lines: rows.length, purchaseCents, costOfSalesCents, stateHash: state.stateHash };
  const carry = { kind: 'adopted-history', rootHash: root.rootHash, throughDate: through, stateHash: state.stateHash, costCents, jobId, replayHash: hash(replay) };
  return { state, carry, replay, summary: summarizeStockState(state) };
}

// Purchase content for remaining lots that came from imported Bills, in the
// same shape loadPurchaseOrigins returns for committed-period lots.
async function adoptedPurchaseOrigin(models, scope, state, qboId, lots, { taxExpectation, session = null }) {
  const source = lots[0].source;
  const row = await models.Records.findOne({ environment: scope.environment, realmId: scope.realmId, entity: 'Bill', qboId, logicalKey: source.logicalKey, state: 'saved' }).session(session).maxTimeMS(3000).lean();
  if (!row) fail('A carried imported purchase is no longer saved.');
  const rows = populationStockRows(scope, source.operationId, state.items, row);
  for (const lot of lots) {
    const item = state.items.find(value => value.lots.includes(lot)), match = rows.find(value => value.source.lineIndex === lot.source.lineIndex && value.itemId === item.itemId);
    if (!match || hash(match.source) !== hash(lot.source) || match.txnDate !== lot.txnDate || match.quantity !== lot.originalQuantity || match.unitCostCents !== lot.unitCostCents) fail('A remaining imported purchase layer differs from its saved line.');
  }
  const tax = taxExpectation(row.policy, row.compilation);
  if (!tax) fail('The imported purchase tax expectation is unavailable.');
  return { qboId, source: populationSource(scope, source.operationId, row, 0), payload: JSON.parse(row.compilation.request.body), tax };
}

module.exports = { RECEIPT_SOURCE, populationSource, populationStockRows, readPopulationStock, replayAdoptedStock, adoptedPurchaseOrigin };
