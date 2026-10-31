'use strict';
// general-write-v1 fixtures before any live transport (design rev 3, build step 2): close
// verification, history invalidation, partial batch failure, lost responses, shared stock
// and the copy merge. Pure; no QuickBooks, database or services.
const test = require('node:test'), assert = require('node:assert/strict');
const { postingsOf, compareLedger, movementsOf } = require('../src/modules/general-write-postings');
const { classifyRecord, dirtyRange, earliestAffected, versionHash } = require('../src/modules/general-write-close');
const { itemOutcomes, blockedRefs } = require('../src/modules/general-write-recovery');
const { mergeDecision, isComplete, invalidatedParents } = require('../src/modules/general-write-merge');
const { checkGeneralWrite } = require('../src/modules/general-write-guards');
const { scheduleBatches } = require('../src/modules/general-write-scheduler');
const records = new Map([
  ['Item:40', { Id: '40', Type: 'Service', IncomeAccountRef: { value: '400' }, ExpenseAccountRef: { value: '500' } }],
  ['Item:41', { Id: '41', Type: 'Inventory', IncomeAccountRef: { value: '401' }, ExpenseAccountRef: { value: '501' }, AssetAccountRef: { value: '130' }, QtyOnHand: 5 }],
  ['Item:42', { Id: '42', Type: 'NonInventory', IncomeAccountRef: { value: '402' }, ExpenseAccountRef: { value: '502' } }],
]);
const ctx = { get: (entity, id) => records.get(entity + ':' + id) || null, receivables: '120', payables: '200', undepositedFunds: '125', taxAccount: (rateId, direction) => ({ sales: '210', purchases: '210' })[direction] + (rateId === '9' ? '-pst' : '') };
const invoice = (amount, date = '2026-12-02', extra = {}) => ({ Id: '700', SyncToken: '0', TxnDate: date, CustomerRef: { value: '1' }, Line: [{ Amount: amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: 1, UnitPrice: amount, TaxCodeRef: { value: '7' } } }], TxnTaxDetail: { TotalTax: amount * 0.15, TaxLine: [{ Amount: amount * 0.15, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '8' }, PercentBased: true, TaxPercent: 15 } }] }, ...extra });
const rows = map => [...map].map(([accountId, cents]) => ({ accountId, cents }));

test('posting rules derive every record’s postings from its own lines, and a wrong counterpart account fails', () => {
  const posted = postingsOf('Invoice', invoice(100), ctx);
  assert.deepEqual(Object.fromEntries(posted), { 400: -10000, 210: -1500, 120: 11500 });
  assert.equal(compareLedger(posted, rows(posted)).ok, true);
  // A balanced posting to the wrong income account is caught.
  const wrong = compareLedger(posted, [{ accountId: '999', cents: -10000 }, { accountId: '210', cents: -1500 }, { accountId: '120', cents: 11500 }]);
  assert.equal(wrong.ok, false); assert.deepEqual(wrong.differences.map(row => row.accountId).sort(), ['400', '999']);
  // Bills post expense and recoverable tax as debits, payables as a credit.
  const bill = { TxnDate: '2026-12-02', VendorRef: { value: '30' }, Line: [{ Amount: 80, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '610' }, TaxCodeRef: { value: '7' } } }], TxnTaxDetail: { TotalTax: 10.4, TaxLine: [{ Amount: 10.4, TaxLineDetail: { TaxRateRef: { value: '8' } } }] } };
  assert.deepEqual(Object.fromEntries(postingsOf('Bill', bill, ctx)), { 610: 8000, 210: 1040, 200: -9040 });
  // Payments, deposits (with a free interest line), transfers and journals.
  assert.deepEqual(Object.fromEntries(postingsOf('Payment', { TotalAmt: 60, Line: [{ Amount: 60, LinkedTxn: [{ TxnId: '700', TxnType: 'Invoice' }] }] }, ctx)), { 120: -6000, 125: 6000 });
  assert.deepEqual(Object.fromEntries(postingsOf('Payment', { TotalAmt: 0, Line: [{ Amount: 20, LinkedTxn: [{ TxnId: '700', TxnType: 'Invoice' }] }, { Amount: 20, LinkedTxn: [{ TxnId: '701', TxnType: 'CreditMemo' }] }] }, ctx)), {}, 'a zero-funds credit application posts nothing');
  assert.deepEqual(Object.fromEntries(postingsOf('Deposit', { DepositToAccountRef: { value: '100' }, Line: [{ Amount: 60, LinkedTxn: [{ TxnId: '800', TxnType: 'Payment' }] }, { Amount: 1.25, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '410' } } }] }, ctx)), { 125: -6000, 410: -125, 100: 6125 });
  assert.deepEqual(Object.fromEntries(postingsOf('Transfer', { Amount: 500, FromAccountRef: { value: '100' }, ToAccountRef: { value: '101' } }, ctx)), { 100: -50000, 101: 50000 });
  assert.deepEqual(Object.fromEntries(postingsOf('JournalEntry', { Line: [{ Amount: 30, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '610' } } }, { Amount: 30, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '400' } } }] }, ctx)), { 610: 3000, 400: -3000 });
  // Non-posting records are classified explicitly.
  for (const entity of ['Estimate', 'PurchaseOrder', 'TimeActivity', 'Customer', 'Attachable']) assert.equal(postingsOf(entity, { Line: [] }, ctx).size, 0, entity);
  // Inventory postings are outside general-write-v1.
  assert.throws(() => postingsOf('Invoice', { ...invoice(10), Line: [{ Amount: 10, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '41' }, Qty: 1, UnitPrice: 10, TaxCodeRef: { value: '7' } } }] }, ctx), /Inventory/);
});

test('current postings follow the after-state, period movements are date-allocated differences (R2-1)', () => {
  // Update $100 -> $150: current GL must show the $150 invoice; the day moves by +$50.
  const before = invoice(100), after = invoice(150);
  const current = postingsOf('Invoice', after, ctx);
  assert.equal(current.get('120'), 17250); assert.equal(compareLedger(current, rows(current)).ok, true);
  assert.equal(compareLedger(current, rows(postingsOf('Invoice', before, ctx))).ok, false, 'stale $100 GL rows fail the current check');
  assert.deepEqual(movementsOf('Invoice', before, after, ctx).filter(row => row.accountId === '120'), [{ date: '2026-12-02', accountId: '120', cents: 5750 }]);
  // Delete: no current rows expected; the date moves by -$100 (gross).
  assert.equal(postingsOf('Invoice', null, ctx).size, 0); assert.equal(compareLedger(new Map(), []).ok, true);
  assert.equal(compareLedger(new Map(), rows(postingsOf('Invoice', before, ctx))).ok, false, 'rows left behind by a delete fail');
  assert.deepEqual(movementsOf('Invoice', before, null, ctx).find(row => row.accountId === '120'), { date: '2026-12-02', accountId: '120', cents: -11500 });
  // Date move A -> B: A loses the invoice, B gains it.
  const moved = movementsOf('Invoice', invoice(100, '2026-11-20'), invoice(100, '2026-12-02'), ctx).filter(row => row.accountId === '120');
  assert.deepEqual(moved, [{ date: '2026-11-20', accountId: '120', cents: -11500 }, { date: '2026-12-02', accountId: '120', cents: 11500 }]);
});

test('completeness is version-aware: own settlements explain a parent change, anything else is external (R1-2)', () => {
  const proved = invoice(100, '2026-12-01', { Balance: 115 }), paid = { ...proved, SyncToken: '1', Balance: 55, LinkedTxn: [{ TxnId: '900', TxnType: 'Payment' }] };
  const own = new Set(['Payment:900']);
  assert.equal(classifyRecord({ entity: 'Invoice', current: proved, evidence: { accountant: { versionHash: versionHash(proved), record: proved } } }).kind, 'accountant');
  assert.equal(classifyRecord({ entity: 'Invoice', current: paid, evidence: { accountant: { versionHash: versionHash(proved), record: proved } }, ownSettlements: own }).kind, 'accountant');
  assert.equal(classifyRecord({ entity: 'Invoice', current: paid, evidence: { accountant: { versionHash: versionHash(proved), record: proved } }, ownSettlements: new Set() }).kind, 'external-change', 'a payment the accountant did not make is external');
  const edited = { ...proved, SyncToken: '1', DueDate: '2027-02-01' };
  assert.equal(classifyRecord({ entity: 'Invoice', current: edited, evidence: { fixed: { observedHash: versionHash(proved), record: proved } }, ownSettlements: own }).kind, 'external-change', 'historical verification never clears an external edit');
  // Adopted history settled by the accountant's own collection stays adopted.
  assert.equal(classifyRecord({ entity: 'Invoice', current: paid, evidence: { adopted: { proofHash: versionHash(proved), record: proved } }, ownSettlements: own }).kind, 'adopted');
  assert.equal(classifyRecord({ entity: 'Invoice', current: null, deleted: true, evidence: { accountant: { versionHash: versionHash(proved), record: proved } } }).kind, 'external-change');
  assert.equal(classifyRecord({ entity: 'Bill', current: { Id: '5', TxnDate: '2026-12-02' } }).kind, 'external-change');
});

test('history edits dirty every close from the earliest affected date through the cursor (R1-3)', () => {
  assert.equal(earliestAffected(invoice(100, '2026-11-20'), invoice(100, '2026-12-02')), '2026-11-20');
  assert.deepEqual(dirtyRange({ markers: [{ earliestDate: '2026-11-25' }, { earliestDate: '2026-11-20' }], verifiedThrough: '2026-12-01', openingDate: '2026-11-01' }), { from: '2026-11-20', through: '2026-12-01', baseline: false, markers: 2 });
  assert.deepEqual(dirtyRange({ markers: [{ earliestDate: '2026-10-15' }], verifiedThrough: '2026-12-01', openingDate: '2026-11-01' }), { from: '2026-11-01', through: '2026-12-01', baseline: true, markers: 1 });
  assert.equal(dirtyRange({ markers: [{ earliestDate: '2026-12-02' }], verifiedThrough: '2026-12-01', openingDate: '2026-11-01' }), null, 'an open day is not dirty history');
  // The guards report the dates a change dirties; a linked source is protected, not dirty.
  const copy = new Map([['Invoice:100', { Id: '100', SyncToken: '3', TxnDate: '2026-11-20', Balance: 50, TotalAmt: 50, CustomerRef: { value: '1' }, Line: [] }], ['Payment:300', { Id: '300', SyncToken: '0', TxnDate: '2026-11-25', TotalAmt: 50, CustomerRef: { value: '1' }, Line: [{ Amount: 50, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] }]]);
  const local = { get: (entity, id) => copy.get(entity + ':' + id) || null, owned: () => true };
  const result = checkGeneralWrite({ proposal: { operations: [{ ref: 'undo', op: 'delete', entity: 'Payment', id: '300' }] }, local, context: { day: '2026-12-02', verifiedThrough: '2026-12-01', protectedThrough: '2026-10-31', taxCodes: { sales: ['7'], purchases: ['8'] } } });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.deepEqual(result.plan.reverifyDates, ['2026-11-25']); assert.equal(result.plan.operations[0].targetVersion, '0'); assert.equal(result.plan.operations[0].before.TotalAmt, 50);
});

test('partial batch failure and lost responses keep exact transport identity; unknown items hold a barrier (R1-6)', () => {
  const batch = { requestId: 'a'.repeat(32), items: [
    { bId: '1', ref: 'cust', op: 'create', entity: 'Customer', payload: { DisplayName: 'Harbour Clinic' } },
    { bId: '2', ref: 'inv', op: 'create', entity: 'Invoice', payload: { DocNumber: 'TDL-1' } },
    { bId: '3', ref: 'edit', op: 'update', entity: 'Invoice', targetVersion: '3', payload: { DueDate: '2027-01-01' } },
    { bId: '4', ref: 'note', op: 'create', entity: 'Attachable', payload: { Note: 'Call back Monday' } },
    { bId: '5', ref: 'gone', op: 'delete', entity: 'Payment', payload: {} },
  ] };
  const lost = itemOutcomes(batch, null);
  assert.equal(lost.lost, true); assert.deepEqual(lost.next, { action: 'replay', requestId: batch.requestId, bIds: ['1', '2', '3', '4', '5'] });
  const result = itemOutcomes(batch, [
    { bId: '1', Customer: { Id: '61', SyncToken: '0', DisplayName: 'Harbour Clinic' } },
    { bId: '2', Fault: { Error: [{ code: '6140', Message: 'Duplicate Document Number Error' }] } },
    { bId: '3', Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } },
  ]);
  const by = Object.fromEntries(result.items.map(row => [row.ref, row]));
  assert.equal(by.cust.outcome, 'saved'); assert.equal(by.inv.next.action, 'correct'); assert.equal(by.edit.next.action, 'refresh-and-new-attempt');
  assert.equal(by.note.outcome, 'unknown'); assert.equal(by.note.next.action, 'unresolved', 'an attachment without a marker has no reliable correlation');
  assert.equal(by.gone.next.action, 'unresolved', 'a delete cannot be told apart from an external delete');
  // Later items sharing a resource with an unresolved item, or depending on a failed one, wait.
  const blocked = blockedRefs(result.items, { cust: [], inv: [], edit: ['record:Invoice:100'], note: ['record:Invoice:700'], gone: ['record:Payment:300', 'record:Invoice:100'], pay: ['record:Invoice:100'], memo: ['record:Invoice:700'], free: [] }, { pay: [], memo: [], free: ['cust'], other: ['inv'] });
  assert.deepEqual(blocked, ['memo', 'pay']);
});

test('shared stock and before-image links order batches; inventory itself is gated off in v1 (R1-4, R2-2)', () => {
  const copy = new Map([['Item:41', { Id: '41', Type: 'Inventory', QtyOnHand: 5 }], ['Payment:300', { Id: '300', Line: [{ Amount: 50, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] }]]);
  const local = { get: (entity, id) => copy.get(entity + ':' + id) || null };
  const line = (detail, qty) => ({ Amount: qty, DetailType: detail, [detail]: { ItemRef: { value: '41' }, Qty: qty } });
  const { batches } = scheduleBatches([
    { ref: 'buy', op: 'create', entity: 'Bill', payload: { Line: [line('ItemBasedExpenseLineDetail', 3)] } },
    { ref: 'sell', op: 'create', entity: 'SalesReceipt', payload: { Line: [line('SalesItemLineDetail', 7)] } },
    // Removing the link from payment 300 still claims invoice 100, so the later payment waits.
    { ref: 'unlink', op: 'update', entity: 'Payment', id: '300', payload: { Line: [] } },
    { ref: 'repay', op: 'create', entity: 'Payment', payload: { Line: [{ Amount: 50, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] } },
  ], local);
  assert.deepEqual(batches, [['buy', 'unlink'], ['sell', 'repay']]);
  const guards = checkGeneralWrite({ proposal: { operations: [{ ref: 'buy', op: 'create', entity: 'Bill', payload: { TxnDate: '2026-12-02', VendorRef: { value: '30' }, GlobalTaxCalculation: 'TaxExcluded', Line: [{ Amount: 3, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '41' }, Qty: 0.5, TaxCodeRef: { value: '8' } } }] } }] }, local: { ...local, get: (entity, id) => entity === 'Vendor' ? { Id: id, Active: true } : entity === 'TaxCode' ? { Id: id } : local.get(entity, id), owned: () => true }, context: { day: '2026-12-02', taxCodes: { sales: [], purchases: ['8'] } } });
  assert.equal(guards.ok, false); assert.match(guards.problems.map(row => row.message).join(' '), /Inventory is not in general-write-v1/);
});

test('the copy merge replaces a row only with a complete entity, and refreshes a stale parent at equal version (R2-3)', () => {
  const full = { ...invoice(100, '2026-12-01'), MetaData: { LastUpdatedTime: '2026-12-01T10:00:00Z' }, Balance: 115 };
  assert.equal(isComplete('Invoice', full), true);
  assert.equal(mergeDecision('Invoice', { record: full }, { record: { Id: '700', SyncToken: '1', PrivateNote: 'changed' } }).action, 'fetch', 'a sparse update response never replaces the full record');
  assert.equal(mergeDecision('Invoice', { record: full }, { record: { ...full, SyncToken: '1' } }).action, 'replace');
  assert.equal(mergeDecision('Invoice', { record: { ...full, SyncToken: '2' } }, { record: { ...full, SyncToken: '1' } }).action, 'keep');
  // A settlement changed the balance without changing the token or timestamp.
  const settled = { ...full, Balance: 55, LinkedTxn: [{ TxnId: '900', TxnType: 'Payment' }] };
  assert.equal(mergeDecision('Invoice', { record: full }, { record: settled, readStartedAt: '2026-12-02T10:00:01Z' }).action, 'keep', 'equal version over a row that is not stale');
  assert.equal(mergeDecision('Invoice', { record: full, staleSince: '2026-12-02T10:00:00Z' }, { record: settled, readStartedAt: '2026-12-02T09:59:59Z' }).action, 'keep', 'a read that began before the invalidation');
  assert.equal(mergeDecision('Invoice', { record: full, staleSince: '2026-12-02T10:00:00Z' }, { record: settled, readStartedAt: '2026-12-02T10:00:01Z' }).action, 'replace');
  assert.equal(mergeDecision('Invoice', { record: full }, { deleted: true }).action, 'tombstone');
  assert.deepEqual(invalidatedParents({ Line: [{ LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] }, { Line: [{ LinkedTxn: [{ TxnId: '101', TxnType: 'Invoice' }] }] }), ['Invoice:100', 'Invoice:101']);
});
