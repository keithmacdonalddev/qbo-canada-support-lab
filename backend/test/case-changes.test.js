'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectRefs, describeChanges, loadNames, plainError } = require('../src/modules/case-changes');

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
