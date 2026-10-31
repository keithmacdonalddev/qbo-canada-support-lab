'use strict';
// general-write-v1 service end to end against an in-memory company and a fake batch
// transport: preparation, held dispatch, ordered batches with $ref resolution, lost
// response replay, partial failure and dirty-period markers. No QuickBooks or database.
const test = require('node:test'), assert = require('node:assert/strict');
const { createGeneralWriteService } = require('../src/modules/general-write-service');
const DAY = '2026-12-02', scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const bound = { scope, ownerId: 'b'.repeat(24), actorId: 'b'.repeat(24) };
function fakeRuns() {
  const rows = new Map(), copy = value => structuredClone(value);
  const match = (row, filter) => Object.entries(filter).every(([key, want]) => key === 'owned' ? (row.owned || []).some(item => Object.entries(want.$elemMatch).every(([k, v]) => item[k] === v)) : row[key] === want);
  const query = value => ({ select() { return this; }, maxTimeMS() { return this; }, lean: async () => copy(value) });
  return {
    rows,
    findOne: filter => query([...rows.values()].find(row => match(row, filter)) || null),
    create: async ([row]) => { if (rows.has(row._id)) throw new Error('duplicate'); rows.set(row._id, { batches: [], items: {}, dirty: [], owned: [], revision: 0, lastError: null, ...copy(row) }); },
    findOneAndUpdate: (filter, update) => { const row = rows.get(filter._id); if (!row || row.revision !== filter.revision) return query(null); Object.assign(row, copy(update.$set)); row.revision++; return query(row); },
  };
}
function company() {
  const records = new Map([
    ['Customer:1', { Id: '1', DisplayName: 'Harbour Clinic', Active: true, CurrencyRef: { value: 'CAD' } }],
    ['Item:40', { Id: '40', Name: 'Field hour', Type: 'Service', Active: true }],
    ['TaxCode:7', { Id: '7', Active: true, SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '8' } }] } }],
    ['TaxRate:8', { Id: '8', RateValue: 15 }],
    ['Account:50', { Id: '50', AccountType: 'Bank', Active: true }],
    ['Invoice:100', { Id: '100', SyncToken: '2', TxnDate: '2026-11-20', DueDate: '2026-12-20', Balance: 115, TotalAmt: 115, CustomerRef: { value: '1' }, Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, TaxCodeRef: { value: '7' } } }], MetaData: {} }],
  ]);
  let sequence = 500;
  const sent = [];
  const apply = item => {
    const body = item.payload;
    if (item.operation === 'create') {
      const net = (body.Line || []).reduce((sum, line) => sum + (line.Amount || 0), 0), tax = body.Line?.some(line => line.SalesItemLineDetail) ? Math.round(net * 15) / 100 : 0;
      const record = { ...structuredClone(body), Id: String(++sequence), SyncToken: '0', MetaData: { CreateTime: '2026-12-02T12:00:00Z', LastUpdatedTime: '2026-12-02T12:00:00Z' }, ...(item.entity === 'Invoice' ? { TotalAmt: net + tax, Balance: net + tax, TxnTaxDetail: { TotalTax: tax } } : {}) };
      if (item.entity === 'Payment') for (const line of body.Line) { const invoice = records.get('Invoice:' + line.LinkedTxn[0].TxnId); invoice.Balance = Math.round((invoice.Balance - line.Amount) * 100) / 100; }
      records.set(item.entity + ':' + record.Id, record); return { [item.entity]: structuredClone(record) };
    }
    const current = records.get(item.entity + ':' + body.Id);
    if (current.SyncToken !== body.SyncToken) return { Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } };
    const { sparse, ...fields } = body, next = { ...current, ...fields, SyncToken: String(Number(current.SyncToken) + 1) };
    records.set(item.entity + ':' + body.Id, next); return { [item.entity]: structuredClone(next) };
  };
  // QuickBooks dedupes a batch by requestid: a replay returns the original result.
  const answered = new Map();
  const transport = { failNext: null, lose: 0, sendBatch: async (s, batch) => {
    sent.push(structuredClone(batch));
    if (answered.has(batch.requestId)) return structuredClone(answered.get(batch.requestId));
    const response = batch.items.map(item => transport.failNext?.ref === item.bId ? (transport.failNext = null, { bId: item.bId, Fault: { Error: [{ code: '6140', Message: 'Duplicate Document Number Error' }] } }) : { bId: item.bId, ...apply(item) });
    answered.set(batch.requestId, structuredClone(response));
    if (transport.lose > 0) { transport.lose--; throw Object.assign(new Error('socket hang up'), { lost: true }); }
    return response;
  } };
  return { records, sent, transport, copy: { read: async (s, entity, id) => structuredClone(records.get(entity + ':' + id) || null) } };
}
function service(h, { enabled = true, Runs = fakeRuns(), dirty = [] } = {}) {
  const models = { GeneralWriteRuns: Runs, Steps: { findOne: () => ({ select() { return this; }, maxTimeMS() { return this; }, lean: async () => null }) } };
  return { Runs, dirty, retained: [], api: createGeneralWriteService({ models, copy: h.copy, transport: h.transport, dispatchEnabled: () => enabled, contextFor: async () => ({ day: DAY, verifiedThrough: '2026-12-01', protectedThrough: '2026-10-31', taxCodes: { sales: ['7'], purchases: ['7'] }, taxPercent: { 7: 15 } }), markDirty: async (s, markers) => dirty.push(...markers), retain: async () => true }) };
}
const invoiceOp = { ref: 'inv1', op: 'create', entity: 'Invoice', payload: { TxnDate: DAY, DueDate: '2027-01-01', CustomerRef: { value: '1' }, GlobalTaxCalculation: 'TaxExcluded', Line: [{ Amount: 200, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: 2, UnitPrice: 100, TaxCodeRef: { value: '7' } } }] } };
const payOp = { ref: 'pay1', op: 'create', entity: 'Payment', payload: { TxnDate: DAY, CustomerRef: { value: '1' }, TotalAmt: 90, Line: [{ Amount: 90, LinkedTxn: [{ TxnId: { $ref: 'inv1' }, TxnType: 'Invoice' }] }] } };
const input = (decisionKey, operations, purpose = 'Bill today’s field visit on terms and record the deposit received.') => ({ decisionKey, purpose, operations });

test('preparation guards and saves the plan; a key is bound to its content; dispatch stays held while disabled', async () => {
  const h = company(), s = service(h, { enabled: false });
  const refused = await s.api.prepare(bound, input('refused-key-0001', [{ ...invoiceOp, payload: { ...invoiceOp.payload, TxnDate: '2026-11-30' } }]));
  assert.equal(refused.status, 'refused'); assert.ok(refused.problems.some(row => /Date new records 2026-12-02/.test(row.message)), JSON.stringify(refused.problems)); assert.equal(s.Runs.rows.size, 0);
  const prepared = await s.api.prepare(bound, input('terms-and-deposit-01', [invoiceOp, payOp]));
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.plan.batches, 2);
  assert.equal((await s.api.prepare(bound, input('terms-and-deposit-01', [invoiceOp, payOp]))).reused, true);
  await assert.rejects(s.api.prepare(bound, input('terms-and-deposit-01', [invoiceOp])), /already names different work/);
  const held = await s.api.execute(bound, prepared.runId);
  assert.equal(held.status, 'held'); assert.match(held.message, /not enabled/); assert.equal(h.sent.length, 0);
});

test('execution sends batches in resource order, resolves $ref ids, and replays a lost response with the same identity', async () => {
  const h = company(), s = service(h);
  const prepared = await s.api.prepare(bound, input('terms-and-deposit-02', [invoiceOp, payOp]));
  h.transport.lose = 1;
  const lost = await s.api.execute(bound, prepared.runId);
  assert.equal(lost.status, 'unknown'); assert.equal(h.sent.length, 1);
  const done = await s.api.execute(bound, prepared.runId);
  assert.equal(done.status, 'complete', JSON.stringify(done));
  assert.equal(h.sent.length, 3); assert.equal(h.sent[1].requestId, h.sent[0].requestId, 'the lost batch is replayed with its original requestid');
  assert.deepEqual(h.sent[1].items, h.sent[0].items);
  const invoiceId = done.items.inv1.qboId;
  assert.equal(h.sent[2].items[0].payload.Line[0].LinkedTxn[0].TxnId, invoiceId);
  assert.equal(h.records.get('Invoice:' + invoiceId).Balance, 140);
  const row = s.Runs.rows.get(prepared.runId);
  assert.deepEqual(row.owned.map(item => item.op), ['create', 'create']);
  assert.equal(row.batches[0].state, 'answered');
  assert.equal([...h.records.keys()].filter(key => key.startsWith('Invoice:')).length, 2, 'the replay created nothing twice');
});

test('a faulted item stops for correction while saved siblings stay saved; history edits mark dirty periods before sending', async () => {
  const h = company(), s = service(h);
  const edit = { ref: 'terms', op: 'update', entity: 'Invoice', id: '100', payload: { DueDate: '2027-01-15' }, reason: 'The customer asked for a later due date on this imported invoice.' };
  const prepared = await s.api.prepare(bound, input('mixed-day-with-edit1', [invoiceOp, edit, { ...invoiceOp, ref: 'inv2', payload: { ...invoiceOp.payload, DocNumber: 'TDL-7' } }]));
  assert.deepEqual(prepared.plan.reverifyDates, ['2026-11-20']);
  h.transport.failNext = { ref: '3' };
  const result = await s.api.execute(bound, prepared.runId);
  assert.equal(result.status, 'needs-correction');
  assert.equal(result.items.inv1.outcome, 'saved'); assert.equal(result.items.terms.outcome, 'saved'); assert.equal(result.items.inv2.outcome, 'fault'); assert.equal(result.items.inv2.fault[0].code, '6140');
  assert.equal(s.dirty.length, 1); assert.equal(s.dirty[0].date, '2026-11-20');
  assert.equal(h.sent[0].items.find(item => item.payload.Id === '100').payload.SyncToken, '2', 'the update carries the copy’s current SyncToken');
  assert.equal(h.records.get('Invoice:100').DueDate, '2027-01-15');
});
