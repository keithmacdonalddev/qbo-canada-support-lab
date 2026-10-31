'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { emptyStockState, calculateGeneralStockCost, summarizeStockState } = require('../src/modules/business-stock-cost');
const { replayStockRecords, stockPostingCost, checkPurchaseReceipts } = require('../src/modules/business-stock-general');
const { postingsOf, compareLedger } = require('../src/modules/general-write-postings');
const { checkGeneralWrite } = require('../src/modules/general-write-guards');
const scope = { environment: 'sandbox', realmId: '123456', connectionId: 'a'.repeat(24) };
const identity = { itemKey: 'stock-one', itemId: '101', assetAccountId: '9', costAccountId: '10' };
const opening = () => emptyStockState({ scope, rootHash: hash('accepted zero root'), throughDate: '2026-09-30', items: [identity] });
const period = { fromDate: '2026-10-01', throughDate: '2026-10-31' };
const item = { Id: '101', Active: true, Type: 'Inventory', TrackQtyOnHand: true, QtyOnHand: 0, AssetAccountRef: { value: '9' }, ExpenseAccountRef: { value: '10' }, IncomeAccountRef: { value: '11' } };
const inventory = { enabled: true, entities: { Invoice: true, SalesReceipt: true, Bill: true, Purchase: true, PurchaseOrder: true, Estimate: true } };
function record(entity, id, day, qty, price, extras = {}) {
  const buy = ['Bill', 'Purchase'].includes(entity), type = buy ? 'ItemBasedExpenseLineDetail' : 'SalesItemLineDetail';
  return { Id: id, SyncToken: '0', TxnDate: day, CurrencyRef: { value: 'CAD' }, GlobalTaxCalculation: 'TaxExcluded', ...(buy ? { VendorRef: { value: '30' } } : { CustomerRef: { value: '1' } }),
    ...(entity === 'Purchase' ? { PaymentType: 'Cash', AccountRef: { value: '50' } } : {}),
    ...(['SalesReceipt', 'RefundReceipt'].includes(entity) ? { DepositToAccountRef: { value: '50' } } : {}),
    Line: [{ Id: '1', Amount: qty * price, DetailType: type, [type]: { Qty: qty, UnitPrice: price, ItemRef: { value: '101' }, TaxCodeRef: { value: buy ? '8' : '7' } } }], ...extras };
}
const replay = records => { const basis = { opening: opening(), records, period }; return { ...basis, replay: replayStockRecords(basis) }; };
const pair = (entity, record) => ({ entity, record });
function context(basis) { return { inventory, get: entity => entity === 'Item' ? item : null, receivables: '12', payables: '13', undepositedFunds: '50', stockCost: (entity, record, index) => stockPostingCost(basis, entity, record, index), taxAccount: () => '14' }; }
function local(extra = []) {
  const map = new Map([['Item:101', item], ['Customer:1', { Id: '1', Active: true }], ['Vendor:30', { Id: '30', Active: true }], ['Account:50', { Id: '50', AccountType: 'Bank', Active: true }], ['Account:9', { Id: '9', AccountSubType: 'Inventory', Active: true }], ['TaxCode:7', { Id: '7' }], ['TaxCode:8', { Id: '8' }], ...extra]);
  return { get: (entity, id) => map.get(entity + ':' + id), owned: () => true, map };
}
const op = (entity, value, ref = 'stock') => { const { Id, SyncToken, ...payload } = value; return { ref, entity, op: 'create', payload }; };
const guard = (operations, basis, copy = local(), inv = inventory) => checkGeneralWrite({ proposal: { operations }, local: copy, context: { day: '2026-10-01', inventory: inv, stock: basis, taxCodes: { sales: ['7'], purchases: ['8'] } } });
const messages = result => result.problems.map(row => row.message).join(' | ');

test('general FIFO receipts use largest same-day quantity first across unequal cost layers; Invoice and SalesReceipt use those costs', () => {
  const small = record('Bill', '201', '2026-10-01', 2, 6), large = record('Purchase', '202', '2026-10-01', 5, 8);
  const invoice = record('Invoice', '203', '2026-10-02', 6, 20), sale = record('SalesReceipt', '204', '2026-10-03', 0.5, 20);
  const records = [pair('Bill', small), pair('Purchase', large), pair('Invoice', invoice), pair('SalesReceipt', sale)], basis = replay(records);
  assert.deepEqual(basis.replay.calculation.allocations.map(row => row.amountCents), [4600, 300]);
  assert.equal(summarizeStockState(basis.replay.calculation.closing).valueCents, 300);
  assert.deepEqual(basis.replay.calculation, replay([...records].reverse()).replay.calculation);
  const postings = postingsOf('Invoice', invoice, context(basis));
  assert.deepEqual(Object.fromEntries(postings), { 9: -4600, 10: 4600, 11: -12000, 12: 12000 });
  assert.equal(compareLedger(postings, [{ accountId: '9', cents: -4600 }, { accountId: '10', cents: 4600 }, { accountId: '11', cents: -12000 }, { accountId: '12', cents: 12000 }]).ok, true);
  const wrong = new Map(postings); wrong.delete('10'); wrong.set('99', 4600);
  assert.equal(compareLedger(postings, [...wrong].map(([accountId, cents]) => ({ accountId, cents }))).ok, false);
  assert.deepEqual(Object.fromEntries(postingsOf('Bill', small, context(basis))), { 9: 1200, 13: -1200 });
  assert.deepEqual(Object.fromEntries(postingsOf('Purchase', large, context(basis))), { 9: 4000, 50: -4000 });
  assert.throws(() => stockPostingCost(basis, 'Invoice', { ...invoice, Line: [] }, 0), /exact current-version/);
});

test('master default off, per-entity flags, missing FIFO basis and negative-stock plan prefixes refuse', () => {
  const invoice = op('Invoice', record('Invoice', '203', '2026-10-01', 0.5, 20));
  const basis = { opening: opening(), records: [], period };
  assert.match(messages(guard([invoice], basis, local(), {})), /GENERAL_WRITE_INVENTORY_ENABLED/);
  assert.match(messages(guard([invoice], basis, local(), { enabled: true, entities: {} })), /entity allow-list/);
  assert.match(messages(guard([invoice], null)), /accepted FIFO opening/);
  assert.match(messages(guard([invoice], basis)), /negative stock/);
  const buy = op('Bill', record('Bill', '201', '2026-10-01', 1.5, 8), 'buy');
  assert.equal(guard([buy, invoice], basis).ok, true, messages(guard([buy, invoice], basis)));
  assert.match(messages(guard([invoice, buy], basis)), /negative stock/);
});

test('partial PO receipts retain received quantity only, validate supplier/item/line and reserve siblings', () => {
  const po = { Id: '400', POStatus: 'Open', TxnDate: '2026-09-28', VendorRef: { value: '30' }, Line: [{ Id: '1', ItemBasedExpenseLineDetail: { ItemRef: { value: '101' }, Qty: 10 } }], LinkedTxn: [{ TxnType: 'Bill', TxnId: '401' }] };
  const prior = record('Bill', '401', '2026-09-29', 4, 8); prior.Line[0].LinkedTxn = [{ TxnType: 'PurchaseOrder', TxnId: '400', TxnLineId: '1' }];
  const next = record('Bill', '402', '2026-10-01', 2.5, 8); next.Line[0].LinkedTxn = structuredClone(prior.Line[0].LinkedTxn);
  const copy = local([['PurchaseOrder:400', po], ['Bill:401', prior]]), entry = { entity: 'Bill', after: next };
  assert.equal(checkPurchaseReceipts([entry], copy), undefined);
  assert.throws(() => checkPurchaseReceipts([entry, entry, entry], copy), /remaining quantity/);
  delete prior.Line[0].LinkedTxn[0].TxnLineId;
  assert.throws(() => checkPurchaseReceipts([entry], copy), /previous partial receipt/);
  prior.Line[0].LinkedTxn[0].TxnLineId = '1';
  const priorLinks = prior.Line[0].LinkedTxn; delete prior.Line[0].LinkedTxn;
  assert.throws(() => checkPurchaseReceipts([entry], copy), /no complete forward/);
  prior.Line[0].LinkedTxn = priorLinks;
  assert.throws(() => checkPurchaseReceipts([{ ...entry, after: { ...next, VendorRef: { value: '99' } } }], copy), /supplier/);
  const basis = { opening: opening(), records: [], period }, accepted = guard([op('Bill', next)], basis, copy);
  assert.equal(accepted.ok, true, messages(accepted));
  const result = replay([pair('Bill', next)]).replay.calculation;
  assert.equal(result.purchaseCents, 2000); assert.equal(summarizeStockState(result.closing).quantity, 2.5);
});

test('returns restore stock and credit COGS only with separate native valuation evidence; payload values cannot enable returns', () => {
  for (const entity of ['CreditMemo', 'RefundReceipt']) {
    const value = record(entity, '205', '2026-10-03', 0.5, 20), records = [pair('Bill', record('Bill', '201', '2026-10-01', 2, 6)), pair('Invoice', record('Invoice', '203', '2026-10-02', 1, 20)), pair(entity, value)];
    assert.throws(() => replay(records), /independent native cost/);
    const returnValuations = { [hash({ entity, record: value, lineIndex: 0 })]: { recordHash: hash(value), evidenceHash: hash('native item-cost evidence, independent of compared GL'), unitCostCents: 600 } };
    const basis = { opening: opening(), records, period, returnValuations }; basis.replay = replayStockRecords(basis);
    assert.equal(basis.replay.calculation.purchaseCents, 1200); assert.equal(basis.replay.calculation.purchases.reduce((sum, row) => sum + row.amountCents, 0), 1200);
    assert.equal(basis.replay.calculation.costOfSalesCents, 300); assert.equal(summarizeStockState(basis.replay.calculation.closing).valueCents, 900);
    const ctx = context(basis); ctx.inventory = { enabled: true, entities: { [entity]: true } };
    assert.equal(postingsOf(entity, value, ctx).get('10'), -300); assert.equal(postingsOf(entity, value, ctx).get('9'), 300);
    assert.match(messages(guard([op(entity, { ...value, TxnDate: '2026-10-01' })], { opening: opening(), records: [], period })), /entity allow-list/);
  }
});

test('ambiguous ties, subcent allocation, supplier refunds, direct asset lines and historical stock edits stay held', () => {
  assert.throws(() => replay([pair('Bill', record('Bill', '201', '2026-10-01', 2, 6)), pair('Purchase', record('Purchase', '202', '2026-10-01', 2, 8))]), /ordering evidence/);
  assert.throws(() => replay([pair('Bill', record('Bill', '201', '2026-10-01', 1, 0.01)), pair('Invoice', record('Invoice', '203', '2026-10-02', 0.5, 20))]), /sub-cent/);
  const invoice = record('Invoice', '203', '2026-10-01', 1, 20), copy = local([['Invoice:203', invoice]]);
  assert.match(messages(guard([{ ref: 'edit', op: 'update', entity: 'Invoice', id: '203', payload: { PrivateNote: 'Keep stock quantity' } }], { opening: opening(), records: [], period }, copy)), /changes and removals/);
  const mixed = record('Bill', '201', '2026-10-01', 2, 6); mixed.Line.push({ Amount: 10, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '9' }, TaxCodeRef: { value: '8' } } });
  assert.match(messages(guard([op('Bill', mixed)], { opening: opening(), records: [], period })), /Direct inventory adjustments/);
  assert.throws(() => replay([pair('Purchase', { ...record('Purchase', '202', '2026-10-01', 2, 8), Credit: true })]), /supplier refunds/);
});


test('legacy equal-cost carries retain hash ordering and general replay explicitly versions its new order', () => {
  const { calculateStockCost, validateStockState, lotKeyFor } = require('../src/modules/business-stock-cost');
  const source = key => ({ operationId: 'b'.repeat(24), scopeHash: hash(scope), logicalKey: hash(key), qboId: key, lineIndex: 0, compilationHash: hash('compiled' + key), requestHash: hash('request' + key), receiptHash: hash('receipt' + key), receiptSource: 'request-correlated-readback' });
  const rows = ['201', '202'].sort((a, b) => lotKeyFor(scope, '101', source(a)).localeCompare(lotKeyFor(scope, '101', source(b)))).map((key, index) => ({ entity: 'Bill', txnDate: '2026-10-01', itemId: '101', quantity: index ? 5 : 2, unitCostCents: 600, source: source(key) }));
  const legacy = calculateStockCost(opening(), rows, period), current = calculateGeneralStockCost(opening(), rows, period);
  assert.equal(legacy.closing.orderingVersion, undefined); assert.equal(current.closing.orderingVersion, 2);
  assert.deepEqual(legacy.closing.items[0].lots.map(lot => lot.lotKey), rows.map(row => lotKeyFor(scope, '101', row.source)).sort());
  assert.deepEqual(current.closing.items[0].lots.map(lot => lot.originalQuantity), [5, 2]);
  assert.doesNotThrow(() => validateStockState(legacy.closing));
  const next = { fromDate: '2026-11-01', throughDate: '2026-11-01' };
  assert.deepEqual(calculateGeneralStockCost(legacy.closing, [], next).closing.items[0].lots.map(lot => lot.originalQuantity), [5, 2]);
  const sale = { entity: 'SalesReceipt', txnDate: next.fromDate, itemId: '101', quantity: 1, source: source('203') };
  assert.equal(calculateGeneralStockCost(legacy.closing, [sale], next).costOfSalesCents, 600);
  const largeOpening = emptyStockState({ scope, rootHash: hash('large accepted root'), throughDate: '2026-09-30', items: [identity, { ...identity, itemKey: 'stock-two', itemId: '102' }] });
  const largeRows = rows.map((row, index) => ({ ...row, itemId: index ? '102' : '101', quantity: 600000 }));
  assert.equal(summarizeStockState(calculateStockCost(largeOpening, largeRows, period).closing).quantity, 1200000);
});

test('complete-day stock reader checks empty-source freshness, pending writes, item routing and final quantities', async t => {
  const { readGeneralStockContext, STOCK_ENTITIES } = require('../src/modules/business-stock-general');
  const history = require('../src/modules/business-stock-history');
  t.mock.method(history, 'readCommittedStockOpening', async () => ({ state: opening() }));
  const query = value => ({ session() { return this; }, maxTimeMS() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value });
  const sources = Object.fromEntries(['Item', ...STOCK_ENTITIES].map(entity => [entity, { entity, status: 'current', phase: 'incremental', generation: 'generation-one', mode: 'cdc', lastSuccessAt: new Date(Date.now() - 1000), since: new Date(Date.now() - 2000), everyMs: 60000 }]));
  const liveItem = { ...item, InvStartDate: '2026-09-01' }, agent = { sync: { sources } };
  let pending = null;
  const models = { Agents: { findOne: () => query(structuredClone(agent)) }, Receipts: { findOne: filter => query(pending && (pending.entity !== 'batch' || filter.$or?.some(row => row.entity === 'batch')) ? pending : null) }, Records: { find: filter => query(filter.entity === 'Item' ? [{ qboId: '101', record: liveItem }] : []) } };
  const input = { models, scope, active: { value: { stockRoot: { zeroSource: { items: [{ Id: '101', InvStartDate: '2026-09-01' }] } } } }, day: '2026-10-01', observations: { read: async () => ({ record: liveItem }) } };
  assert.equal((await readGeneralStockContext(input)).replay.calculation.costOfSalesCents, 0);
  sources.Purchase.lastSuccessAt = new Date(Date.now() - 300000);
  await assert.rejects(readGeneralStockContext(input), /freshness/);
  sources.Purchase.lastSuccessAt = new Date(Date.now() - 1000); pending = { state: 'saved' };
  await assert.rejects(readGeneralStockContext(input), /coverage watermark/);
  pending = { entity: 'batch', kind: 'general-write', general: { items: [{ entity: 'Invoice' }] } };
  await assert.rejects(readGeneralStockContext(input), /coverage watermark/);
  pending = null; liveItem.ExpenseAccountRef = { value: '99' };
  await assert.rejects(readGeneralStockContext(input), /routing/);
  liveItem.ExpenseAccountRef = { value: '10' }; liveItem.QtyOnHand = 1;
  await assert.rejects(readGeneralStockContext(input), /on-hand/);
});
