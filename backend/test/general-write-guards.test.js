'use strict';
// Pure guards and entity guide of the general governed write tool (design:
// docs/plans/general-governed-write-tool-2026-10-31.md). No QuickBooks, no database.
const test = require('node:test'), assert = require('node:assert/strict');
const { checkGeneralWrite } = require('../src/modules/general-write-guards');
const { entitySchema, ENTITIES } = require('../src/modules/qbo-entity-schema');
const DAY = '2026-12-02';
function companyCopy(extra = []) {
  const rows = [
    ['Customer', { Id: '1', DisplayName: 'Harbour Clinic', Active: true, CurrencyRef: { value: 'CAD' } }],
    ['Customer', { Id: '2', DisplayName: 'Old Client', Active: false, CurrencyRef: { value: 'CAD' } }],
    ['Vendor', { Id: '30', DisplayName: 'Power Co', Active: true, CurrencyRef: { value: 'CAD' } }],
    ['Item', { Id: '40', Name: 'Field hour', Type: 'Service', Active: true }],
    ['Item', { Id: '41', Name: 'Filter kit', Type: 'Inventory', Active: true, QtyOnHand: 5 }],
    ['Account', { Id: '50', Name: 'Operating bank', AccountType: 'Bank', Active: true }],
    ['Account', { Id: '51', Name: 'Undeposited Funds', AccountType: 'Other Current Asset', AccountSubType: 'UndepositedFunds', Active: true }],
    ['Account', { Id: '52', Name: 'Utilities', AccountType: 'Expense', Active: true }],
    ['Account', { Id: '53', Name: 'Service income', AccountType: 'Income', Active: true }],
    ['TaxCode', { Id: '7', Name: 'HST ON', Active: true }],
    ['TaxCode', { Id: '8', Name: 'HST purchases', Active: true }],
    ['Invoice', { Id: '100', TxnDate: '2026-11-20', Balance: 113, TotalAmt: 113, CustomerRef: { value: '1' }, Line: [] }],
    ['Invoice', { Id: '101', TxnDate: '2026-10-15', Balance: 50, TotalAmt: 50, CustomerRef: { value: '1' }, Line: [] }],
    ['Payment', { Id: '200', TxnDate: '2026-12-01', TotalAmt: 40, DepositToAccountRef: { value: '51' }, Line: [{ Amount: 40, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] }],
    ['Payment', { Id: '201', TxnDate: '2026-12-01', TotalAmt: 25, DepositToAccountRef: { value: '51' }, LinkedTxn: [{ TxnId: '300', TxnType: 'Deposit' }], Line: [] }],
    ...extra,
  ];
  const map = new Map(rows.map(([entity, record]) => [entity + ':' + record.Id, record]));
  return { get: (entity, id) => map.get(entity + ':' + id) || null, owned: (entity, id) => !(entity === 'Invoice' && id === '101') };
}
const context = { day: DAY, verifiedThrough: '2026-12-01', protectedThrough: '2026-10-31', taxCodes: { sales: ['7'], purchases: ['8'] } };
const check = (operations, local = companyCopy()) => checkGeneralWrite({ proposal: { decisionKey: 'k', purpose: 'p', operations }, local, context });
const sale = (extra = {}) => ({ ref: 'inv1', op: 'create', entity: 'Invoice', payload: { TxnDate: DAY, DueDate: '2027-01-01', CustomerRef: { value: '1' }, GlobalTaxCalculation: 'TaxExcluded', Line: [{ Amount: 250, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: 2, UnitPrice: 125, TaxCodeRef: { value: '7' } } }], ...extra } });
const messages = result => result.problems.map(row => row.message).join(' | ');

test('a composed business day passes: terms invoice, partial payment, grouped deposit, bill on terms', () => {
  const result = check([
    sale(),
    { ref: 'pay1', op: 'create', entity: 'Payment', payload: { TxnDate: DAY, CustomerRef: { value: '1' }, TotalAmt: 60, Line: [{ Amount: 60, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] } },
    { ref: 'dep1', op: 'create', entity: 'Deposit', payload: { TxnDate: DAY, DepositToAccountRef: { value: '50' }, Line: [{ Amount: 40, LinkedTxn: [{ TxnId: '200', TxnType: 'Payment', TxnLineId: '0' }] }] } },
    { ref: 'bill1', op: 'create', entity: 'Bill', payload: { TxnDate: DAY, DueDate: '2027-01-01', VendorRef: { value: '30' }, GlobalTaxCalculation: 'TaxExcluded', Line: [{ Amount: 180, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '52' }, TaxCodeRef: { value: '8' } } }] } }
  ]);
  assert.equal(result.ok, true, messages(result));
  assert.deepEqual(result.plan.layers, [['inv1', 'pay1', 'dep1', 'bill1']]);
});

test('every generic guard refuses with a plain, per-operation reason', () => {
  const refuse = (operations, pattern, local) => { const result = check(operations, local); assert.equal(result.ok, false); assert.match(messages(result), pattern); };
  refuse([{ ...sale(), entity: 'TaxPayment' }], /not available/);
  refuse([{ ...sale(), op: 'void' }], /Name the QuickBooks id/);
  refuse([sale({ TxnDate: '2026-12-01' })], /Date new records 2026-12-02/);
  refuse([sale({ TotalAmt: 282.5 })], /TotalAmt is set by QuickBooks/);
  refuse([sale({ CustomerRef: { value: '2' } })], /inactive/);
  refuse([sale({ CustomerRef: { value: '999' } })], /not a Customer/);
  refuse([sale({ CustomerRef: { value: '30' } })], /not a Customer/);
  refuse([sale({ Line: [{ Amount: 250, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: 2, UnitPrice: 125, TaxCodeRef: { value: '8' } } }] })], /not in the published sales tax policy/);
  refuse([sale({ GlobalTaxCalculation: 'TaxInclusive' })], /TaxExcluded/);
  refuse([sale({ CurrencyRef: { value: 'USD' } })], /Only CAD/);
  refuse([sale({ Line: [{ Amount: 60000, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: 1, UnitPrice: 60000, TaxCodeRef: { value: '7' } } }] })], /at most \$50000 including tax/);
  // Over-applied payment, double deposit, already deposited payment.
  refuse([{ ref: 'pay1', op: 'create', entity: 'Payment', payload: { TxnDate: DAY, CustomerRef: { value: '1' }, TotalAmt: 120, Line: [{ Amount: 120, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] } }], /has \$113 open/);
  refuse([{ ref: 'pay1', op: 'create', entity: 'Payment', payload: { TxnDate: DAY, CustomerRef: { value: '1' }, TotalAmt: 50, Line: [{ Amount: 60, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] } }], /TotalAmt must equal/);
  refuse([{ ref: 'dep1', op: 'create', entity: 'Deposit', payload: { TxnDate: DAY, DepositToAccountRef: { value: '50' }, Line: [{ Amount: 25, LinkedTxn: [{ TxnId: '201', TxnType: 'Payment', TxnLineId: '0' }] }] } }], /already deposited/);
  refuse([{ ref: 'dep1', op: 'create', entity: 'Deposit', payload: { TxnDate: DAY, DepositToAccountRef: { value: '50' }, Line: [{ Amount: 10, LinkedTxn: [{ TxnId: '200', TxnType: 'Payment', TxnLineId: '0' }] }] } }], /full amount/);
  // Unbalanced journal; stock going negative.
  refuse([{ ref: 'je1', op: 'create', entity: 'JournalEntry', payload: { TxnDate: DAY, Line: [{ Amount: 10, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '52' } } }, { Amount: 9, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '53' } } }] } }], /must balance/);
  refuse([{ ref: 'sr1', op: 'create', entity: 'SalesReceipt', payload: { TxnDate: DAY, CustomerRef: { value: '1' }, DepositToAccountRef: { value: '50' }, GlobalTaxCalculation: 'TaxExcluded', Line: [{ Amount: 60, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '41' }, Qty: 6, UnitPrice: 10, TaxCodeRef: { value: '7' } } }] } }], /Inventory is not in general-write-v1/);
  // Protected history, and edits of records it did not create without a reason.
  refuse([{ ref: 'up1', op: 'update', entity: 'Invoice', id: '101', reason: 'Customer asked for a later due date.', payload: { DueDate: '2027-01-15' } }], /closed or reconciled period/);
  refuse([{ ref: 'up1', op: 'update', entity: 'Invoice', id: '101', payload: { DueDate: '2027-01-15' } }], /not created by the accountant: state a reason/);
  // Placeholders must point to earlier creates of the right type.
  refuse([{ ref: 'pay1', op: 'create', entity: 'Payment', payload: { TxnDate: DAY, CustomerRef: { value: '1' }, TotalAmt: 10, Line: [{ Amount: 10, LinkedTxn: [{ TxnId: { $ref: 'inv1' }, TxnType: 'Invoice' }] }] } }, sale()], /earlier create/);
  refuse([{ ref: 'prefs', op: 'update', entity: 'Preferences', id: '1', payload: { CurrencyPrefs: { MultiCurrencyEnabled: true } } }], /not a supported Preferences field|cannot be changed|not in the synced/);
});

test('placeholders build dependency layers, and history edits inside verified periods are flagged for re-verification', () => {
  const result = check([
    sale(),
    { ref: 'pay1', op: 'create', entity: 'Payment', payload: { TxnDate: DAY, CustomerRef: { value: '1' }, TotalAmt: 100, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: { $ref: 'inv1' }, TxnType: 'Invoice' }] }] } },
    { ref: 'up1', op: 'update', entity: 'Invoice', id: '100', payload: { DueDate: '2026-12-20' } },
  ]);
  assert.equal(result.ok, true, messages(result));
  assert.deepEqual(result.plan.layers, [['inv1', 'up1'], ['pay1']]);
  assert.deepEqual(result.plan.reverifyDates, ['2026-11-20']);
  assert.deepEqual(result.plan.externalEdits, []);
});

test('the entity guide answers every allow-listed entity and states the Canadian tax rules', () => {
  for (const entity of Object.keys(ENTITIES)) { const guide = entitySchema(entity, { taxCodes: { sales: ['7'], purchases: ['8'] } }); assert.equal(guide.found, true); assert.ok(guide.operations.length && guide.notes.length, entity); }
  const invoice = entitySchema('Invoice', { taxCodes: { sales: ['7'] } });
  assert.deepEqual(invoice.publishedTaxCodes, ['7']); assert.match(invoice.notes.join(' '), /TaxExcluded/); assert.ok(invoice.readOnly.includes('TotalAmt'));
  assert.ok(!entitySchema('Payment').readOnly.includes('TotalAmt'));
  assert.equal(entitySchema('TaxPayment').found, false);
  assert.match(entitySchema('Preferences').notes.join(' '), /[Mm]ulticurrency/);
});

test('batches respect shared resources, not only references: stock items, open balances and updated records', () => {
  const { scheduleBatches } = require('../src/modules/general-write-scheduler');
  const local = companyCopy();
  const line = (detail, item, qty) => ({ Amount: qty * 10, DetailType: detail, [detail]: { ItemRef: { value: item }, Qty: qty, UnitPrice: 10, TaxCodeRef: { value: '7' } } });
  const ops = [
    { ref: 'buy', op: 'create', entity: 'Bill', payload: { Line: [line('ItemBasedExpenseLineDetail', '41', 10)] } },
    { ref: 'sell', op: 'create', entity: 'SalesReceipt', payload: { Line: [line('SalesItemLineDetail', '41', 12)] } },
    { ref: 'pay-a', op: 'create', entity: 'Payment', payload: { Line: [{ Amount: 10, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] } },
    { ref: 'pay-b', op: 'create', entity: 'Payment', payload: { Line: [{ Amount: 10, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] } },
    { ref: 'edit', op: 'update', entity: 'Invoice', id: '100', payload: { DueDate: '2026-12-30' } },
    { ref: 'service', op: 'create', entity: 'Invoice', payload: { Line: [line('SalesItemLineDetail', '40', 1)] } },
  ];
  const { batches, resources } = scheduleBatches(ops, local);
  assert.deepEqual(batches, [['buy', 'pay-a', 'service'], ['sell', 'pay-b'], ['edit']]);
  assert.deepEqual(resources.sell, ['stock:41']); assert.deepEqual(resources.edit, ['record:Invoice:100']);
  // At most 30 items per batch.
  const many = Array.from({ length: 65 }, (_, n) => ({ ref: 'c' + n, op: 'create', entity: 'Customer', payload: { DisplayName: 'Client ' + n } }));
  assert.deepEqual(scheduleBatches(many, local).batches.map(batch => batch.length), [30, 30, 5]);
  // The guards refuse tax overrides wherever QuickBooks computes tax.
  const result = check([sale({ Line: [{ Amount: 250, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: 2, UnitPrice: 125, TaxCodeRef: { value: '7' }, TaxInclusiveAmt: 282.5 } }] })]);
  assert.equal(result.ok, false); assert.match(messages(result), /QuickBooks computes tax/);
  // A deposit may carry a free line (for example bank interest) besides linked receipts.
  const deposit = check([{ ref: 'dep1', op: 'create', entity: 'Deposit', payload: { TxnDate: DAY, DepositToAccountRef: { value: '50' }, Line: [{ Amount: 40, LinkedTxn: [{ TxnId: '200', TxnType: 'Payment', TxnLineId: '0' }] }, { Amount: 1.25, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '53' } } }] } }]);
  assert.equal(deposit.ok, true, messages(deposit));
});
