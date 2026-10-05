'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectRefs, describeChanges, loadNames, parseAsks, plainError } = require('../src/modules/case-changes');

const deposit = (status, linkIds) => ({
  stepNumber: 1, toolName: 'createRecord', status,
  toolInput: { entityType: 'Deposit', record: { TxnDate: '2026-10-01', DepositToAccountRef: { value: '60' }, Line: linkIds.map((id, i) => ({ Amount: [226, 77.69][i], LinkedTxn: [{ TxnId: id, TxnType: 'Payment', TxnLineId: '0' }] })) } },
  ...(status === 'failed' ? { error: 'QBO API error (HTTP 400): Required param missing, need to supply the required value for the API' } : {}),
  ...(status === 'completed' ? { result: { success: true, data: { entityType: 'Deposit', id: '587', totalAmt: 303.69 } } } : {}),
});

const plans = [
  { _id: 'p1', status: 'failed', steps: [
    { stepNumber: 1, toolName: 'createRecord', status: 'completed',
      toolInput: { entityType: 'Invoice', record: { CustomerRef: { value: '62' }, TxnDate: '2026-09-21', DueDate: '2026-10-21', SalesTermRef: { value: '3' },
        Line: [{ Amount: 240, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '16' }, Qty: 5, UnitPrice: 48, TaxCodeRef: { value: '11' } } }] } },
      result: { success: true, data: { entityType: 'Invoice', id: '579', totalAmt: 271.2, docNumber: '1105' } } },
    { ...deposit('failed', ['{{step6.id}}', '{{step7.id}}']), stepNumber: 2 },
    { stepNumber: 3, toolName: 'createRecord', status: 'skipped',
      toolInput: { entityType: 'Transfer', record: { TxnDate: '2026-10-02', FromAccountRef: { value: '60' }, ToAccountRef: { value: '1150040007' }, Amount: 1000 } } },
  ] },
  { _id: 'p2', status: 'rejected', steps: [deposit('pending', ['584', '585'])] },
  { _id: 'p3', status: 'proposed', steps: [
    deposit('pending', ['584', '585']),
  ] },
];

const names = new Map([
  ['Customer:62', 'Alex Blakey'], ['Account:60', 'Chequing'], ['Account:1150040007', 'Savings'],
  ['Item:16', 'Trimming'], ['TaxCode:11', 'HST ON'], ['Term:3', 'Net 30'],
]);

test('changes read with names, amounts and status across proposals', () => {
  const view = describeChanges(plans, names);
  const invoice = view.changes.find((c) => c.entityType === 'Invoice');
  assert.equal(invoice.party, 'Alex Blakey');
  assert.equal(invoice.amount, 271.2);
  assert.equal(invoice.docNumber, '1105');
  assert.equal(invoice.status, 'done');
  assert.deepEqual(invoice.facts, ['5 × Trimming at $48.00', 'Tax HST ON', 'Terms Net 30']);

  const transfer = view.changes.find((c) => c.entityType === 'Transfer');
  assert.equal(transfer.party, 'Chequing → Savings');
  assert.equal(transfer.status, 'skipped');

  // The rejected proposal is left out; the failed deposit is still shown because
  // the later one has not been made yet.
  assert.equal(view.discardedProposals, 1);
  const deposits = view.changes.filter((c) => c.entityType === 'Deposit');
  assert.deepEqual(deposits.map((d) => d.status), ['failed', 'waiting']);
  assert.equal(deposits[0].error, 'QuickBooks rejected it: a required detail was missing.');
  assert.equal(deposits[1].party, 'Chequing');
  assert.deepEqual(deposits[1].facts, ['Combines 2 customer payments']);
});

test('a failed change made by a later proposal shows once, as made', () => {
  const done = plans.map((p) => (p._id === 'p3' ? { ...p, status: 'completed', steps: [deposit('completed', ['584', '585'])] } : p));
  const view = describeChanges(done, names);
  const deposits = view.changes.filter((c) => c.entityType === 'Deposit');
  assert.deepEqual(deposits.map((d) => d.status), ['done']);
  assert.equal(view.counts.retried, 1);
  assert.equal(view.counts.failed, 0);
});

test('without names, Ids still show and nothing breaks', () => {
  const view = describeChanges(plans);
  assert.equal(view.changes[0].party, 'customer #62');
});

test('name lookups are read-only queries limited to numeric Ids', async () => {
  const refs = collectRefs(plans);
  assert.ok(refs.get('Account').has('1150040007'));
  assert.ok(!refs.get('Payment') || ![...refs.get('Payment')].some((id) => id.includes('{')));
  const queries = [];
  const qbo = { async query(sql) { queries.push(sql); return { QueryResponse: { Customer: [{ Id: '62', DisplayName: 'Alex Blakey' }] } }; } };
  const found = await loadNames(qbo, refs);
  assert.equal(found.get('Customer:62'), 'Alex Blakey');
  assert.ok(queries.every((q) => /^SELECT \* FROM \w+ WHERE Id IN \('\d+'(, '\d+')*\) MAXRESULTS 100$/.test(q)));
});

test('QuickBooks errors read plainly', () => {
  assert.equal(plainError('QBO API error (HTTP 400): Duplicate Document Number Error'), 'QuickBooks rejected it: that document number is already used.');
  assert.equal(plainError(''), 'QuickBooks did not accept this change.');
});

test('older write tools read like the rest', () => {
  const view = describeChanges([{ _id: 'p', status: 'proposed', steps: [
    { stepNumber: 1, toolName: 'createInvoice', status: 'pending',
      toolInput: { customerRef: { id: '62', name: 'Alex Blakey' }, txnDate: '2026-09-21', lines: [{ amount: 240, itemRef: { id: '16', name: 'Trimming' } }] } },
    { stepNumber: 2, toolName: 'applyPayment', status: 'pending',
      toolInput: { customerRef: { id: '62', name: 'Alex Blakey' }, invoiceId: '570', amount: 226, txnDate: '2026-09-29' } },
  ] }]);
  assert.equal(view.changes[0].party, 'Alex Blakey');
  assert.equal(view.changes[0].amount, 240);
  assert.equal(view.changes[0].date, '2026-09-21');
  assert.equal(view.changes[1].amount, 226);
  assert.deepEqual(view.changes[1].facts, ['Applied to invoice #570']);
  assert.ok(collectRefs([{ steps: [{ toolName: 'createInvoice', toolInput: { customerRef: { id: '62' } } }] }]).get('Customer').has('62'));
});

test('a failure is not hidden behind an unrelated later success', () => {
  const bare = (status) => ({ stepNumber: 1, toolName: 'createRecord', status, toolInput: { entityType: 'Invoice', record: {} } });
  const view = describeChanges([
    { _id: 'a', status: 'failed', steps: [bare('failed')] },
    { _id: 'b', status: 'completed', steps: [bare('completed')] },
  ]);
  assert.equal(view.counts.failed, 1);
  assert.equal(view.counts.retried, 0);
});

test('steps still to run during a run are queued, not "not made"', () => {
  const view = describeChanges([{ _id: 'r', status: 'executing', steps: [
    { stepNumber: 1, toolName: 'createRecord', status: 'approved', toolInput: { entityType: 'Transfer', record: { Amount: 5 } } },
  ] }]);
  assert.equal(view.changes[0].status, 'queued');
  assert.equal(view.counts.notDone, 0);
});

test('name lookups stop at the time budget and report it', async () => {
  const qbo = { query: () => new Promise(() => {}) };
  const found = await loadNames(qbo, new Map([['Customer', new Set(['1'])]]), { budgetMs: 20 });
  assert.equal(found.complete, false);
});

test('the listed items of the opening request become the checklist', () => {
  const asks = parseAsks([
    'Fill these coverage gaps (batch 1). Use existing customers.',
    '',
    '1. Current receivables: 3 unpaid invoices to different customers, dated in the',
    '   last 2 weeks, due after today (Net 30).',
    '2. Transfer between two bank accounts',
    '',
    'Show the full plan before writing anything.',
  ].join('\n'));
  assert.deepEqual(asks, [
    { number: 1, title: 'Current receivables', detail: '3 unpaid invoices to different customers, dated in the last 2 weeks, due after today (Net 30).' },
    { number: 2, title: 'Transfer between two bank accounts', detail: '' },
  ]);
  assert.deepEqual(parseAsks('Fill these gaps:\n- Customers with payment terms\n'), [{ number: 1, title: 'Customers with payment terms', detail: '' }]);
  assert.deepEqual(parseAsks('Reproduce a partial payment on invoice 1001.'), []);
});

test('changes carry the ask they answer; a lone ask takes everything', () => {
  const step = (n, goal) => ({ stepNumber: n, toolName: 'createRecord', status: 'pending',
    toolInput: { entityType: 'Transfer', goal, record: { TxnDate: '2026-10-02', Amount: n } } });
  const two = describeChanges([{ _id: 'g', status: 'proposed', steps: [step(1, 2), step(2, 9), step(3)] }], new Map(), { request: '1. A\n2. B' });
  assert.equal(two.asks.length, 2);
  assert.deepEqual(two.changes.map((c) => c.goal), [2, null, null]);
  const one = describeChanges([{ _id: 'g', status: 'proposed', steps: [step(1)] }], new Map(), { request: '- Only this' });
  assert.equal(one.changes[0].goal, 1);
});

test('a deposit lists its payments, and a made payment says what is left owing', () => {
  const payment = (n, invoiceId, id) => ({ stepNumber: n, toolName: 'createRecord', status: 'completed',
    toolInput: { entityType: 'Payment', record: { CustomerRef: { value: '62' }, TotalAmt: 100, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }] } },
    result: { success: true, data: { entityType: 'Payment', id } } });
  const balances = new Map([['Invoice:570', 0], ['Invoice:569', 712.5]]);
  const found = Object.assign(new Map([['Invoice:570', '111058'], ['Invoice:569', '111057']]), { balances });
  const view = describeChanges([
    { _id: 'a', status: 'completed', steps: [payment(1, '570', '584'), payment(2, '569', '585')] },
    { _id: 'b', status: 'completed', steps: [{ ...deposit('completed', ['584', '{{step3.id}}']), stepNumber: 1 }] },
  ], found);
  assert.deepEqual(view.changes[0].facts, ['Applied to invoice 111058, now paid in full']);
  assert.deepEqual(view.changes[1].facts, ['Applied to invoice 111057, $712.50 still owing']);
  // 584 was made by change a:1; step 3 of proposal b does not exist, so it is dropped.
  assert.deepEqual(view.changes.find((c) => c.entityType === 'Deposit').includes, ['a:1']);
});

test('a payment not yet made does not claim a balance', () => {
  const found = Object.assign(new Map(), { balances: new Map([['Invoice:570', 0]]) });
  const view = describeChanges([{ _id: 'w', status: 'proposed', steps: [
    { stepNumber: 1, toolName: 'createRecord', status: 'pending', toolInput: { entityType: 'Payment', record: { TotalAmt: 5, Line: [{ Amount: 5, LinkedTxn: [{ TxnId: '570', TxnType: 'Invoice' }] }] } } },
  ] }], found);
  assert.deepEqual(view.changes[0].facts, ['Applied to invoice #570']);
});

test('name lookups also keep invoice and bill balances', async () => {
  const qbo = { async query() { return { QueryResponse: { Invoice: [{ Id: '569', DocNumber: '111057', Balance: 712.5 }] } }; } };
  const found = await loadNames(qbo, new Map([['Invoice', new Set(['569'])]]));
  assert.equal(found.get('Invoice:569'), '111057');
  assert.equal(found.balances.get('Invoice:569'), 712.5);
});

test('only the first list and its top-level items count, with their written numbers', () => {
  const nested = parseAsks('1. Deposits:\n  - payment from A\n  - payment from B\n2. Transfer\n\nRules:\n- Use existing customers');
  assert.deepEqual(nested.map((a) => [a.number, a.title]), [[1, 'Deposits'], [2, 'Transfer']]);
  assert.equal(nested[0].detail, 'Payment from A; payment from B');
  assert.deepEqual(parseAsks('3. Third\n4. Fourth').map((a) => a.number), [3, 4]);
  assert.deepEqual(parseAsks('  - one\n  - two').map((a) => a.title), ['one', 'two']);
});

test('a payment being edited is not tucked under a deposit', () => {
  const view = describeChanges([{ _id: 'e', status: 'proposed', steps: [
    { stepNumber: 1, toolName: 'updateRecord', status: 'pending', toolInput: { entityType: 'Payment', id: '584', changes: { PrivateNote: 'x' } } },
    { ...deposit('pending', ['584']), stepNumber: 2 },
  ] }]);
  assert.equal(view.changes.find((c) => c.entityType === 'Deposit').includes, undefined);
});
