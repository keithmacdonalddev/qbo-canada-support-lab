'use strict';
// Sanitized native observations, not examples of writable ReimburseCharge payloads.
// QBO_JOB_B_REPLAY_FILE lets the same tests privately replay the original stored
// records without placing names, addresses or notes in tracked fixtures.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.QBO_JOB_B_REPLAY_FILE || require.resolve('./fixtures/billable-native-links.json'), 'utf8'));
const { createGeneralWriteService } = require('../src/modules/general-write-service');
const { matchesSavedRequest, itemOutcomes, historyMovements } = require('../src/modules/general-write-recovery');
const { preservesBillableState } = require('../src/modules/billable-charge-links');
const { entitySchema } = require('../src/modules/qbo-entity-schema');
const { classifyRecord } = require('../src/modules/general-write-close');
const { hash } = require('../src/modules/business-calendar');
const DAY = '2026-01-30', scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const bound = { scope, ownerId: 'b'.repeat(24), actorId: 'b'.repeat(24) };
const query = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean: async () => structuredClone(value) });
function harness() {
  const records = new Map(), rows = new Map(), reads = [];
  for (const record of fixture.invoices) records.set('Invoice:' + record.Id, structuredClone(record));
  for (const record of fixture.sources) records.set('Bill:' + record.Id, structuredClone(record));
  for (const id of ['19', '52']) records.set('Customer:' + id, { Id: id, Active: true, CurrencyRef: { value: 'CAD' } });
  records.set('Account:50', { Id: '50', Active: true, AccountType: 'Bank' });
  records.set('Account:51', { Id: '51', Active: true, AccountType: 'Expense' });
  records.set('TaxCode:11', { Id: '11', Active: true });
  let sends = 0, creates = 0;
  const Runs = { rows, findOne: filter => query(rows.get(filter._id) || null),
    create: async input => { creates++; for (const row of input) rows.set(row._id, structuredClone(row)); },
    findOneAndUpdate: (filter, update) => { const row = rows.get(filter._id); if (!row || row.revision !== filter.revision) return query(null); Object.assign(row, structuredClone(update.$set)); row.revision++; return query(row); },
  };
  const api = createGeneralWriteService({
    models: { GeneralWriteRuns: Runs, Steps: { findOne: () => query(null) } },
    copy: { read: async (s, entity, id) => { reads.push(entity + ':' + id); return structuredClone(records.get(entity + ':' + id) || null); } },
    contextFor: async () => ({ day: DAY, verifiedThrough: '2026-01-29', taxCodes: { sales: ['11'], purchases: ['11'] }, taxPercent: { 11: 13 } }),
    dispatchEnabled: () => true,
    transport: { sendBatch: async () => { sends++; throw new Error('No QBO send is permitted in this replay.'); } },
  });
  return { api, records, rows, reads, counts: () => ({ sends, creates }) };
}
function proposal(key, operation) { return { decisionKey: key, purpose: 'Preserve native billable expense invoice history.', operations: [operation] }; }
test('schema exposes the documented manual link boundary and does not enable a writable shape', () => {
  for (const entity of ['Invoice', 'Bill', 'Purchase']) {
    const guide = entitySchema(entity);
    assert.equal(guide.billableExpenses.apiWritable, false);
    assert.match(guide.billableExpenses.sourceChecks, /remaining billable amount/);
    assert.match(guide.billableExpenses.reason, /QuickBooks UI/);
  }
  assert.equal(entitySchema('Invoice').linkRules.header.includes('ReimburseCharge'), false);
  assert.equal(entitySchema('ReimburseCharge').found, false);
});
test('real native charge ids resolve to distinct source bills and already-billed lines; zero invoice amounts are retained', () => {
  const expected = { 399: ['350', '19'], 400: ['351', '19'], 402: ['382', '52'] };
  for (const [charge, [billId, customer]] of Object.entries(expected)) {
    const bill = fixture.sources.find(row => row.Id === billId);
    const invoice = fixture.invoices.find(row => row.LinkedTxn.some(link => link.TxnId === charge));
    const source = bill.Line.find(line => line.LinkedTxn?.some(link => link.TxnId === charge));
    const line = invoice.Line.find(row => row.LinkedTxn?.some(link => link.TxnId === charge));
    assert.equal(source[source.DetailType].BillableStatus, 'HasBeenBilled');
    assert.equal(source[source.DetailType].CustomerRef.value, customer);
    assert.equal(invoice.CustomerRef.value, customer);
    assert.equal(line.LinkedTxn[0].TxnLineId, source.Id);
    assert.notEqual(charge, billId);
  }
  assert.equal(fixture.invoices.find(row => row.Id === '401').Line[1].Amount, 0);
  assert.equal(fixture.invoices.find(row => row.Id === '405').Line[0].Amount, 0);
});
for (const invoice of fixture.invoices) {
  test('stored Invoice ' + invoice.Id + ' is refused as API link creation through live preparation', async () => {
    const h = harness(), payload = {};
    for (const key of ['CustomerRef', 'TxnDate', 'Line', 'LinkedTxn', 'GlobalTaxCalculation', 'CurrencyRef']) payload[key] = structuredClone(invoice[key]);
    const result = await h.api.prepare(bound, proposal('native-create-' + invoice.Id, { ref: 'invoice', entity: 'Invoice', op: 'create', payload }));
    assert.equal(result.status, 'refused');
    assert.ok(result.problems.some(row => /ReimburseCharge.*read-only/.test(row.message)));
    assert.deepEqual(h.counts(), { sends: 0, creates: 0 });
  });
  for (const [name, payload, op] of [
    ['replace-lines', { Line: [] }, 'update'], ['customer', { CustomerRef: { value: '52' } }, 'update'],
    ['drop-links', { LinkedTxn: [] }, 'update'], ['void', {}, 'void'], ['delete', {}, 'delete'],
  ]) test('stored Invoice ' + invoice.Id + ' protects native history against ' + name, async () => {
    const h = harness();
    const result = await h.api.prepare(bound, proposal('native-' + invoice.Id + '-' + name, { ref: 'invoice', entity: 'Invoice', op, id: invoice.Id, payload, reason: 'Exercise the native billable history guard offline.' }));
    assert.equal(result.status, 'refused');
    assert.ok(result.problems.some(row => /retains native billable expense links/.test(row.message)));
    assert.deepEqual(h.counts(), { sends: 0, creates: 0 });
  });
}
for (const source of fixture.sources) test('stored Bill ' + source.Id + ' cannot remove or reopen an already-billed source line', async () => {
  for (const op of ['update', 'delete']) {
    const h = harness(), payload = op === 'update' ? { Line: [] } : {};
    const result = await h.api.prepare(bound, proposal('billed-source-' + source.Id + '-' + op, { ref: 'bill', entity: 'Bill', id: source.Id, op, payload, reason: 'Exercise the billed expense source guard offline.' }));
    assert.equal(result.status, 'refused');
    assert.ok(result.problems.some(row => /native billable charge history/.test(row.message)));
    assert.deepEqual(h.counts(), { sends: 0, creates: 0 });
  }
});
function newExpense(status, customer = { value: '19' }) {
  return { ref: 'expense', entity: 'Purchase', op: 'create', payload: {
    TxnDate: DAY, PaymentType: 'Cash', AccountRef: { value: '50' }, GlobalTaxCalculation: 'TaxExcluded', CurrencyRef: { value: 'CAD' },
    Line: [{ Amount: 100, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: {
      AccountRef: { value: '51' }, TaxCodeRef: { value: '11' }, BillableStatus: status, ...(customer ? { CustomerRef: customer } : {}),
    } }],
  } };
}
test('supported billable expense creation still prepares; customer scope and completed billing cannot be fabricated', async () => {
  const h = harness();
  assert.equal((await h.api.prepare(bound, proposal('valid-billable-expense', newExpense('Billable')))).status, 'prepared');
  for (const [key, operation, message] of [
    ['missing-customer', newExpense('Billable', null), /source line needs CustomerRef/],
    ['foreign-customer', newExpense('Billable', { value: '99' }), /not a Customer/],
    ['fake-billing', newExpense('HasBeenBilled'), /cannot establish an invoice link/],
    ['bad-status', newExpense('BillingComplete'), /must be Billable or NotBillable/],
  ]) {
    const result = await h.api.prepare(bound, proposal('expense-' + key, operation));
    assert.equal(result.status, 'refused'); assert.ok(result.problems.some(row => message.test(row.message)));
  }
  assert.equal(h.counts().sends, 0);
});
test('billable source supports an earlier customer create and keeps currency/tax restrictions', async () => {
  const h = harness(), source = newExpense('Billable', { value: { $ref: 'new-customer' } });
  const input = proposal('earlier-billable-customer', source);
  input.operations.unshift({ ref: 'new-customer', op: 'create', entity: 'Customer', payload: { DisplayName: 'Offline billable customer', CurrencyRef: { value: 'CAD' } } });
  assert.equal((await h.api.prepare(bound, input)).status, 'prepared');
  for (const [key, change, message] of [
    ['currency', op => { op.payload.CurrencyRef.value = 'USD'; }, /Only CAD/],
    ['tax', op => { delete op.payload.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef; }, /Every.*TaxCodeRef/],
  ]) {
    const operation = newExpense('Billable'); change(operation);
    const result = await h.api.prepare(bound, proposal('billable-' + key, operation));
    assert.equal(result.status, 'refused'); assert.ok(result.problems.some(row => message.test(row.message)));
  }
});
function recovered(h, entity, before, response) {
  const id = entity.toLowerCase() + '-stored-response', payload = { Id: before.Id, SyncToken: before.SyncToken, sparse: true, PrivateNote: 'Offline native history recovery.' };
  const item = { bId: '1', ref: 'original', op: 'update', entity, id: before.Id, before, payload };
  const batch = { index: 0, attempt: 1, requestId: 'original-billable-request', state: 'sending', items: [item],
    transport: { receiptId: 'original-durable-receipt', items: [{ bId: '1', ref: 'original', outcome: 'saved' }], response: [{ bId: '1', [entity]: response }] } };
  h.rows.set(id, { _id: id, ...scope, contract: 'general-write-v1', ownerId: bound.ownerId, revision: 0, status: 'sending', day: DAY, items: {}, owned: [], dirty: [], batches: [batch], plan: { operations: [{ ...item, ref: 'original' }], layers: [['original']] } });
  return { id, item, batch };
}
for (const [entity, records] of [['Invoice', fixture.invoices], ['Bill', fixture.sources]]) for (const before of records) {
  test('stored ' + entity + ' ' + before.Id + ' recovers the original durable receipt without a send and preserves native state', async () => {
    const h = harness(), saved = { ...structuredClone(before), SyncToken: String(BigInt(before.SyncToken) + 1n), PrivateNote: 'Offline native history recovery.' };
    const original = recovered(h, entity, before, saved);
    assert.equal(itemOutcomes(original.batch, original.batch.transport.response).items[0].outcome, 'saved');
    assert.equal(matchesSavedRequest(original.item, saved), true);
    const result = await h.api.execute(bound, original.id);
    assert.equal(result.status, 'complete'); assert.equal(result.items.original.outcome, 'saved');
    assert.equal(h.counts().sends, 0); assert.equal(h.rows.get(original.id).batches.length, 1);
    assert.equal(h.rows.get(original.id).batches[0].requestId, 'original-billable-request');
    assert.equal(classifyRecord({ entity, current: before, evidence: { adopted: { proofHash: hash(before), record: before } } }).kind, 'adopted');
  });
  test('stored ' + entity + ' ' + before.Id + ' altered source/amount/customer/tax or duplicate billing fails native response preservation', async () => {
    const changes = [
      record => { record.LinkedTxn = []; }, record => { record.Line[0].LinkedTxn = []; },
      record => { record.Line[0].LinkedTxn[0].TxnLineId = '999'; },
      record => { record.Line[0].Amount += 1; }, record => { record.CustomerRef = { value: '999' }; },
      record => { record.CurrencyRef = { value: 'USD' }; },
      record => { record.TxnTaxDetail.TotalTax += 1; }, record => { record.LinkedTxn.push(structuredClone(record.LinkedTxn.find(link => link.TxnType === 'ReimburseCharge'))); },
    ];
    for (const change of changes) {
      const h = harness(), saved = { ...structuredClone(before), SyncToken: String(BigInt(before.SyncToken) + 1n), PrivateNote: 'Offline native history recovery.' };
      change(saved);
      assert.equal(preservesBillableState(before, saved), false);
      const original = recovered(h, entity, before, saved);
      assert.equal(matchesSavedRequest(original.item, saved), false);
      const result = await h.api.execute(bound, original.id);
      assert.equal(result.items.original.outcome, 'mismatch');
      await h.api.execute(bound, original.id);
      assert.equal(h.counts().sends, 0); assert.equal(h.rows.get(original.id).batches.length, 1);
      assert.equal(h.rows.get(original.id).batches[0].transport.receiptId, 'original-durable-receipt');
    }
  });
}
test('native invoice header ordering and later unrelated Payment links do not fabricate changes', () => {
  const before = fixture.invoices[0], current = structuredClone(before);
  current.LinkedTxn.reverse(); current.LinkedTxn.push({ TxnId: '999', TxnType: 'Payment' });
  assert.equal(preservesBillableState(before, current), true);
});
test('retained historical saved evidence cannot hide a lost native link', () => {
  const before = fixture.invoices[0], after = { ...structuredClone(before), SyncToken: '20' };
  after.Line[0].LinkedTxn = [];
  const run = { updatedAt: '2026-01-31T00:00:00Z', plan: { operations: [{ ref: 'invoice', entity: 'Invoice', op: 'update', id: before.Id, before }] },
    batches: [], items: { invoice: { outcome: 'saved', entity: 'Invoice', op: 'update', qboId: before.Id, before, record: after, request: { Id: before.Id } } } };
  assert.throws(() => historyMovements([run], '2026-01-30T00:00:00Z', {}), /differs from its original request/);
});

test('billed source accounting cannot be reversed or moved to another party/account', async () => {
  const source = fixture.sources[0], h = harness();
  for (const payload of [{ VendorRef: { value: '999' } }, { APAccountRef: { value: '999' } }, { Credit: true }, { AccountRef: { value: '999' } }, { PaymentType: 'CreditCard' }]) {
    const result = await h.api.prepare(bound, proposal('billed-finance-' + Object.keys(payload)[0], { ref: 'bill', op: 'update', entity: 'Bill', id: source.Id, payload, reason: 'Prove no billed source accounting changes.' }));
    assert.equal(result.status, 'refused');
    assert.ok(result.problems.some(row => /native billable charge history/.test(row.message)));
    assert.equal(preservesBillableState(source, { ...structuredClone(source), ...payload }), false);
  }
});
test('an ordinary Invoice cannot acquire unexpected billable charges during response recovery', () => {
  const invoice = fixture.invoices[0], payload = { CustomerRef: structuredClone(invoice.CustomerRef), TxnDate: invoice.TxnDate };
  assert.equal(matchesSavedRequest({ entity: 'Invoice', op: 'create', payload }, invoice), false);
  const source = fixture.sources[0];
  assert.equal(matchesSavedRequest({ entity: 'Bill', op: 'create', payload: { VendorRef: structuredClone(source.VendorRef) } }, source), true, 'native charge creation on a billable source is allowed');
});

test('day-close gathering rejects corrupted retained native billable responses before trusting their hash', async () => {
  const { generalRecordsFor } = require('../src/modules/general-write-day-close');
  for (const [entity, records] of [['Invoice', fixture.invoices], ['Bill', fixture.sources]]) for (const before of records) {
    const current = { ...structuredClone(before), SyncToken: String(BigInt(before.SyncToken) + 1n) };
    const run = { _id: 'retained-native', plan: { operations: [{ ref: 'record', op: 'update', entity, id: before.Id, before }] },
      batches: [], dirty: [], items: { record: { outcome: 'saved', op: 'update', entity, qboId: before.Id, before, record: current, request: { Id: before.Id } } } };
    const Runs = { find: () => query([run]) }, copy = { read: async () => structuredClone(current) };
    const gathered = await generalRecordsFor({ Runs, scope, day: before.TxnDate, copy });
    assert.equal(gathered.records.length, 1);
    current.Line[0].LinkedTxn = [];
    await assert.rejects(generalRecordsFor({ Runs, scope, day: before.TxnDate, copy }), /native billable expense history/);
  }
});
