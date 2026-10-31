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
  const query = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean: async () => copy(value) });
  return {
    rows,
    find: filter => query([...rows.values()].filter(row => match(row, filter))),
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
      const record = { ...structuredClone(body), Id: String(++sequence), SyncToken: '0', MetaData: { CreateTime: '2026-12-02T12:00:00Z', LastUpdatedTime: '2026-12-02T12:00:00Z' }, ...(item.entity === 'Invoice' ? { TotalAmt: net + tax, Balance: net + tax, TxnTaxDetail: { TotalTax: tax, TaxLine: [{ Amount: tax, TaxLineDetail: { TaxRateRef: { value: '8' } } }] } } : {}) };
      if (item.entity === 'Payment') for (const line of body.Line) { const invoice = records.get('Invoice:' + line.LinkedTxn[0].TxnId); invoice.Balance = Math.round((invoice.Balance - line.Amount) * 100) / 100; (invoice.LinkedTxn ||= []).push({ TxnType: 'Payment', TxnId: record.Id }); }
      records.set(item.entity + ':' + record.Id, record); return { [item.entity]: structuredClone(record) };
    }
    const current = records.get(item.entity + ':' + body.Id);
    if (current.SyncToken !== body.SyncToken) return { Fault: { type: 'ValidationFault', Error: [{ code: '5010', Message: 'Stale Object Error' }] } };
    const { sparse, ...fields } = body, next = { ...current, ...fields, SyncToken: String(Number(current.SyncToken) + 1) };
    records.set(item.entity + ':' + body.Id, next); return { [item.entity]: structuredClone(next) };
  };
  // QuickBooks dedupes a batch by requestid: a replay returns the original result.
  const answered = new Map();
  const transport = { failNext: null, lose: 0, sendBatch: async (s, { batch }) => {
    sent.push(structuredClone(batch));
    if (answered.has(batch.requestId)) return structuredClone(answered.get(batch.requestId));
    const response = batch.items.map(item => transport.failNext?.ref === item.bId ? (transport.failNext = null, { bId: item.bId, Fault: { type: 'ValidationFault', Error: [{ code: '6140', Message: 'Duplicate Document Number Error' }] } }) : { bId: item.bId, ...apply(item) });
    answered.set(batch.requestId, structuredClone(response));
    if (transport.lose > 0) { transport.lose--; throw Object.assign(new Error('socket hang up'), { lost: true }); }
    return response;
  } };
  const fetched = [];
  return { records, sent, transport, fetched, copy: { read: async (s, entity, id) => structuredClone(records.get(entity + ':' + id) || null), fetch: async (s, entity, id) => { fetched.push(entity + ':' + id); return structuredClone(records.get(entity + ':' + id) || null); } } };
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

test('a faulted item stops for correction while saved siblings stay saved on the open day', async () => {
  const h = company(), s = service(h);
  h.records.get('Invoice:100').TxnDate = DAY;
  const edit = { ref: 'terms', op: 'update', entity: 'Invoice', id: '100', payload: { DueDate: '2027-01-15' }, reason: 'The customer asked for a later due date on this imported invoice.' };
  const prepared = await s.api.prepare(bound, input('mixed-day-with-edit1', [invoiceOp, edit, { ...invoiceOp, ref: 'inv2', payload: { ...invoiceOp.payload, DocNumber: 'TDL-7' } }]));
  assert.deepEqual(prepared.plan.reverifyDates, []);
  h.transport.failNext = { ref: '3' };
  const result = await s.api.execute(bound, prepared.runId);
  assert.equal(result.status, 'needs-correction');
  assert.equal(result.items.inv1.outcome, 'saved'); assert.equal(result.items.terms.outcome, 'saved'); assert.equal(result.items.inv2.outcome, 'fault'); assert.equal(result.items.inv2.fault[0].code, '6140');
  assert.equal(s.dirty.length, 0);
  assert.equal(h.sent[0].items.find(item => item.payload.Id === '100').payload.SyncToken, '2', 'the update carries the copy’s current SyncToken');
  assert.equal(h.records.get('Invoice:100').DueDate, '2027-01-15');
});

test('a saved response is stale once a later item changes the same record: the next batch re-reads it, and plan-wide over-application is refused', async () => {
  const pay = (ref, amount) => ({ ref, op: 'create', entity: 'Payment', payload: { TxnDate: DAY, CustomerRef: { value: '1' }, TotalAmt: amount, Line: [{ Amount: amount, LinkedTxn: [{ TxnId: { $ref: 'inv1' }, TxnType: 'Invoice' }] }] } });
  // 90 + 150 exceeds the new invoice's $230: refused before either payment is sent.
  const h = company(), s = service(h);
  const over = await s.api.prepare(bound, input('stale-parent-check-1', [invoiceOp, pay('pay1', 90), pay('pay2', 150)]));
  assert.equal(over.plan.batches, 3, 'two payments of one invoice never share a batch');
  const refused = await s.api.execute(bound, over.runId);
  assert.equal(refused.status, 'needs-correction'); assert.equal(refused.items.pay1, undefined); assert.match(refused.message, /has \$230 open; this plan applies \$240/);
  assert.equal(h.sent.length, 1);
  // 90 + 140 settles it exactly: after the first payment the invoice is read fresh, once.
  const k = company(), t = service(k);
  const exact = await t.api.prepare(bound, input('stale-parent-check-2', [invoiceOp, pay('pay1', 90), pay('pay2', 140)]));
  const done = await t.api.execute(bound, exact.runId);
  assert.equal(done.status, 'complete', JSON.stringify(done));
  assert.deepEqual(k.fetched, ['Invoice:' + done.items.inv1.qboId], 'one targeted fresh read of the changed invoice');
  assert.equal(k.records.get('Invoice:' + done.items.inv1.qboId).Balance, 0);
});

test('a saved mismatch cannot be retried as a new create identity', async () => {
  const h=company(),s=service(h),original=h.transport.sendBatch;
  h.transport.sendBatch=async (...args)=>{const response=await original(...args);response[0].Invoice.DueDate='2028-01-01';return response;};
  const prepared=await s.api.prepare(bound,input('mismatch-never-recreate',[invoiceOp]));
  assert.equal((await s.api.execute(bound,prepared.runId)).items.inv1.outcome,'mismatch');
  const retried=await s.api.execute(bound,prepared.runId);
  assert.equal(retried.status,'unknown');assert.equal(h.sent.length,1);assert.equal(s.Runs.rows.get(prepared.runId).batches.length,1);
});

test('a durable gate response is ingested after a crash without another transport send', async () => {
  const h=company(),s=service(h);const prepared=await s.api.prepare(bound,input('settled-response-crash',[invoiceOp]));
  const original=h.transport.sendBatch;
  h.transport.sendBatch=async(scope,{batch})=>{const response=await original(scope,{batch});const row=s.Runs.rows.get(prepared.runId);row.batches[0].transport={response,items:batch.items.map(item=>({bId:item.bId,outcome:'saved'}))};row.revision++;throw Object.assign(new Error('service lost acknowledgement'),{lost:true});};
  await s.api.execute(bound,prepared.runId);
  const result=await s.api.execute(bound,prepared.runId);
  assert.equal(result.status,'complete');assert.equal(h.sent.length,1);
});

test('unresolved pre-opening dirty markers refuse new general work against an old verified baseline', async () => {
  const { createGeneralWriteContext } = require('../src/modules/general-write-service');
  const session = {}, chain = value => ({ select() { return this; }, session(actual) { assert.equal(actual, session); return this; }, maxTimeMS() { return this; }, lean: async () => value });
  const context = createGeneralWriteContext({ now: () => Date.parse('2026-12-02T15:00:00Z'), models: {
    Calendars: { findOne: () => chain({ verifiedThrough: '2026-12-01', openingDate: '2026-11-01', baseline: { status: 'verified' } }) },
    Policies: { findOne: () => chain({ periodControl: {} }) },
    GeneralWriteRuns: { findOne: filter => { assert.equal(filter.dirty.$elemMatch.date.$lte, '2026-12-01'); return chain({ _id: 'old-dirty-run' }); } },
  } });
  await assert.rejects(context(scope, { get: () => null }, { session }), /General history invalidation is unresolved/);
});

// Caller-to-classifier regression: the only transport and stores here are in-memory.
function settlementClose(h, s, invoiceId, paymentId) {
  const { createGeneralCloseGate } = require('../src/modules/general-write-close-gate');
  h.records.get('Item:40').IncomeAccountRef = { value: '400' };
  const closes = [], query = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean: async () => structuredClone(value) });
  const models = {
    GeneralWriteRuns: s.Runs,
    Steps: { find: () => query([]) },
    Records: { find: () => query([{ qboId: '210', record: { AccountSubType: 'GlobalTaxPayable' } }]) },
    GeneralDayCloses: { findOne: () => query(null), create: async ([row]) => closes.push(row) },
  };
  const entry = (type, id, debit, credit) => ({ type: 'Data', ColData: [{ value: DAY }, { value: type, id }, { value: debit }, { value: credit }] });
  const section = (id, Row) => ({ type: 'Section', Header: { ColData: [{ id }] }, Rows: { Row } });
  // Independent expected postings: invoice $200 + $30 tax, full $230 collection.
  const readLedger = async () => ({ Header: { ReportName: 'GeneralLedger', ReportBasis: 'Accrual', StartPeriod: DAY, EndPeriod: DAY },
    Columns: { Column: ['tx_date', 'txn_type', 'debt_amt', 'credit_amt'].map(ColType => ({ ColType })) },
    Rows: { Row: [section('120', [entry('Invoice', invoiceId, '230.00', ''), entry('Payment', paymentId, '', '230.00')]),
      section('400', [entry('Invoice', invoiceId, '', '200.00')]), section('210', [entry('Invoice', invoiceId, '', '30.00')]),
      section('125', [entry('Payment', paymentId, '230.00', '')])] } });
  const gate = createGeneralCloseGate({ models, copy: h.copy });
  return { closes, close: () => gate.assertPeriodReady(scope, { fromDate: DAY, throughDate: DAY, verifiedThrough: '2026-12-01', mappings: { accountsReceivable: '120', undepositedFunds: '125' }, readLedger }) };
}

test('an invoice created then fully paid through the general tool passes calendar close', async () => {
  const h = company(), s = service(h), payment = structuredClone(payOp);
  payment.payload.TotalAmt = 230; payment.payload.Line[0].Amount = 230;
  const prepared = await s.api.prepare(bound, input('general-paid-invoice-close', [invoiceOp, payment]));
  const done = await s.api.execute(bound, prepared.runId);
  assert.equal(done.status, 'complete');
  assert.equal(h.records.get('Invoice:' + done.items.inv1.qboId).Balance, 0);
  const gate = settlementClose(h, s, done.items.inv1.qboId, done.items.pay1.qboId);
  assert.equal((await gate.close()).results[0].ok, true);
  assert.deepEqual(gate.closes[0].records.map(row => row.kind), ['accountant', 'accountant']);
});

test('an invoice created through the general tool but paid externally still fails calendar close', async () => {
  const h = company(), s = service(h);
  const prepared = await s.api.prepare(bound, input('external-paid-invoice-close', [invoiceOp]));
  const done = await s.api.execute(bound, prepared.runId), invoiceId = done.items.inv1.qboId;
  const payment = structuredClone(payOp.payload);
  payment.TotalAmt = 230; payment.Line[0].Amount = 230; payment.Line[0].LinkedTxn[0].TxnId = invoiceId;
  const [response] = await h.transport.sendBatch(scope, { batch: { requestId: 'external-payment', items: [{ bId: '1', operation: 'create', entity: 'Payment', payload: payment }] } });
  const gate = settlementClose(h, s, invoiceId, response.Payment.Id);
  await assert.rejects(gate.close(), /Invoice changed after it was proved/);
  assert.equal(gate.closes[0].ok, false);
});

test('general quote context uses the published dated code for the open day and rejects the historical code', async t => {
  const authority = require('../src/modules/business-authority');
  const view = { mappings: { salesTax: '12', purchaseTax: '12' }, business: { openingDate: '2023-09-01', activityTemplateVersion: 2, datedTax: { version: 1, regime: 'CA-NS-2025-postpaid', salesTax: '16', purchaseTax: '16' } } };
  t.mock.method(authority, 'readPublishedBusiness', async () => ({ view }));
  const q = value => ({ session() { return this; }, select() { return this; }, maxTimeMS() { return this; }, lean: async () => value });
  const models = { Calendars: { findOne: () => q({ verifiedThrough: '2026-12-01' }) }, Policies: { findOne: () => q({ periodControl: {} }) }, GeneralWriteRuns: { findOne: () => q(null) } };
  const h = company(), detail = { TaxRateRef: { value: '34', name: 'HST' }, TaxTypeApplicable: 'TaxOnAmount' };
  h.records.set('TaxCode:16', { Id: '16', SyncToken: '0', Active: true, Taxable: true, SalesTaxRateList: { TaxRateDetail: [detail] }, PurchaseTaxRateList: { TaxRateDetail: [detail] } });
  h.records.set('TaxCode:12', { Id: '12', Active: true });
  h.records.set('TaxRate:34', { Id: '34', SyncToken: '0', Active: true, RateValue: 99, EffectiveTaxRate: [{ EffectiveDate: '2025-04-01T00:00:00-07:00', RateValue: 14 }] });
  const local = { get: (entity, id) => h.records.get(entity + ':' + id), owned: () => false, map: h.records };
  const contextFor = require('../src/modules/general-write-service').createGeneralWriteContext({ models, now: () => Date.parse(DAY + 'T16:00:00Z') });
  const context = await contextFor(scope, local);
  assert.deepEqual(context.taxCodes, { sales: ['16'], purchases: ['16'] }); assert.equal(context.taxPercent['16'], 14);
  const quotes = [1, 2, 3].map(i => { const op = structuredClone(invoiceOp); op.ref = 'quote' + i; op.entity = 'Estimate'; delete op.payload.DueDate; op.payload.Line[0].SalesItemLineDetail.TaxCodeRef.value = '16'; return op; });
  const check = operations => require('../src/modules/general-write-guards').checkGeneralWrite({ proposal: input('three-independent-quotes', operations), local, context });
  assert.equal(check(quotes).ok, true, JSON.stringify(check(quotes).problems));
  quotes[0].payload.Line[0].SalesItemLineDetail.TaxCodeRef.value = '12'; assert.equal(check(quotes).ok, false);
  h.records.get('TaxRate:34').EffectiveTaxRate[0].RateValue = 15;
  await assert.rejects(contextFor(scope, local), /differs from its approved policy/);
  h.records.get('TaxRate:34').EffectiveTaxRate = []; await assert.rejects(contextFor(scope, local), /history/);
  h.records.delete('TaxCode:16');
  assert.deepEqual((await contextFor(scope, local)).taxPercent, {}, 'unrelated nontax work need not load tax records');
});
test('general context selects historical codes before the transition without permitting both code sets', async t => {
  const authority = require('../src/modules/business-authority');
  const view = { mappings: { salesTax: '12', purchaseTax: '12' }, business: { openingDate: '2023-09-01', activityTemplateVersion: 2, datedTax: { version: 1, regime: 'CA-NS-2025-postpaid', salesTax: '16', purchaseTax: '16' } } };
  t.mock.method(authority, 'readPublishedBusiness', async () => ({ view }));
  const q = value => ({ session() { return this; }, select() { return this; }, maxTimeMS() { return this; }, lean: async () => value });
  const models = { Calendars: { findOne: () => q({ verifiedThrough: '2025-03-30' }) }, Policies: { findOne: () => q({ periodControl: {} }) }, GeneralWriteRuns: { findOne: () => q(null) } };
  const context = await require('../src/modules/general-write-service').createGeneralWriteContext({ models, now: () => Date.parse('2025-03-31T16:00:00Z') })(scope, { get: () => null, map: new Map() });
  assert.deepEqual(context.taxCodes, { sales: ['12'], purchases: ['12'] });
});

test('failed earlier close permits today general preparation and send, holds backdates and links, then verifies later', async t => {
  const { harness, scope: closeScope, operationId } = require('./helpers/business-run-fixture');
  const close = harness(); close.clock = Date.parse('2026-10-07T15:00:00Z'); close.evidenceReady = false;
  assert.equal((await close.execute()).state, 'awaiting-evidence');
  assert.equal(close.calendar().verifiedThrough, '2026-10-05'); assert.equal(close.calendar().currentOperationId, operationId); assert.equal(close.writer().operationId, null);
  const authority = require('../src/modules/business-authority');
  t.mock.method(authority, 'readPublishedBusiness', async () => ({ view: { mappings: { salesTax: '7', purchaseTax: '7' }, business: { openingDate: '2026-10-01', activityTemplateVersion: 2 } } }));
  const q = value => ({ session() { return this; }, select() { return this; }, maxTimeMS() { return this; }, lean: async () => value });
  const h = company(), Runs = fakeRuns(), models = { GeneralWriteRuns: Runs, Steps: { findOne: () => q(null) } };
  Object.assign(h.records.get('TaxRate:8'), { SyncToken: '0', Active: true, EffectiveTaxRate: [{ EffectiveDate: '2026-01-01', RateValue: 15 }] });
  h.records.get('TaxCode:7').SalesTaxRateList.TaxRateDetail[0].TaxTypeApplicable = 'TaxOnAmount';
  h.records.get('TaxCode:7').PurchaseTaxRateList = structuredClone(h.records.get('TaxCode:7').SalesTaxRateList);
  const contextFor = require('../src/modules/general-write-service').createGeneralWriteContext({ now: () => close.clock, models: { Calendars: close.models.Calendars, Policies: { findOne: () => q({ periodControl: {} }) }, GeneralWriteRuns: { findOne: () => q(null) } } });
  const api = createGeneralWriteService({ models, copy: h.copy, contextFor, transport: h.transport, dispatchEnabled: () => true, now: () => close.clock });
  const op = structuredClone(invoiceOp); op.payload.TxnDate = '2026-10-07'; op.payload.DueDate = '2026-11-06';
  const prepared = await api.prepare(bound, input('today-during-pending-close', [op])); assert.equal(prepared.status, 'prepared');
  assert.equal((await api.execute(bound, prepared.runId)).status, 'complete'); assert.equal(h.sent.length, 1);
  assert.equal(close.calendar().verifiedThrough, '2026-10-05'); assert.equal(close.run().status, 'awaiting-evidence');
  const backdate = structuredClone(op); backdate.payload.TxnDate = '2026-10-06';
  assert.equal((await api.prepare(bound, input('backdate-open-close-refused', [backdate]))).status, 'refused');
  h.records.get('Invoice:100').TxnDate = '2026-10-06';
  const edit = { ref: 'edit', op: 'update', entity: 'Invoice', id: '100', payload: { TxnDate: '2026-10-07' }, reason: 'Move the earlier invoice date into today.' };
  assert.equal((await api.prepare(bound, input('edit-open-close-refused', [edit]))).status, 'refused');
  const pay = { ref: 'pay', op: 'create', entity: 'Payment', payload: { TxnDate: '2026-10-07', CustomerRef: { value: '1' }, TotalAmt: 10, Line: [{ Amount: 10, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }] } };
  assert.equal((await api.prepare(bound, input('link-open-close-refused', [pay]))).status, 'refused');
  const stopped = await api.prepare(bound, input('prepared-before-owner-stop', [op])); close.calendar().stopRequested = true;
  await assert.rejects(api.guardBatch({ scope, run: Runs.rows.get(stopped.runId), batch: { items: [{ ...op, payload: op.payload }] } }), /stopped/);
  close.calendar().stopRequested = false; close.evidenceReady = true;
  assert.equal((await close.execute()).complete, true); assert.equal(close.calendar().verifiedThrough, '2026-10-06'); assert.equal(close.writes, 3);
});
test('general admission fences the calendar in its transaction so Stop cannot race an old snapshot', async t => {
  t.mock.method(require('../src/modules/business-authority'), 'readPublishedBusiness', async () => ({ view: { mappings: { salesTax: '7', purchaseTax: '7' }, business: { openingDate: '2026-10-01', activityTemplateVersion: 2 } } }));
  const session = { inTransaction: () => true }, calendar = { _id: 'sandbox:123', ...scope, verifiedThrough: '2026-11-30', revision: 2, writerRevision: 4, stopRequested: false, pendingCommit: null };
  const q = value => ({ session(actual) { assert.equal(actual, session); return this; }, select() { return this; }, maxTimeMS() { return this; }, lean: async () => value });
  let raced = false, touches = 0;
  const models = { Calendars: { findOne: () => q(calendar), findOneAndUpdate(filter, change, opts) {
    touches++; assert.equal(opts.session, session); assert.deepEqual(filter, { _id: calendar._id, ...scope, revision: 2, writerRevision: 4, verifiedThrough: '2026-11-30', stopRequested: false, pendingCommit: null }); assert.deepEqual(change, { $inc: { writerRevision: 1 } }); return q(raced ? null : calendar);
  } }, Policies: { findOne: () => q({ periodControl: {} }) }, GeneralWriteRuns: { findOne: () => q(null) } };
  const context = require('../src/modules/general-write-service').createGeneralWriteContext({ models, now: () => Date.parse(DAY + 'T15:00:00Z') });
  assert.equal((await context(scope, { get: () => null, map: new Map() }, { session })).calendarClosePending, true); assert.equal(touches, 1);
  raced = true; await assert.rejects(context(scope, { get: () => null, map: new Map() }, { session }), /changed or stopped/);
});
for (const retainedStatus of ['prepared', 'held']) test('a retained '+retainedStatus+' batch re-enters sending after a definite admission refusal', async () => {
  const h=company(), s=service(h), {denied}=require('../src/modules/qbo-write-contract');
  const prepared=await s.api.prepare(bound,input('retry-admission-'+retainedStatus,[invoiceOp]));
  const send=h.transport.sendBatch; let attempts=0, firstBatch;
  h.transport.sendBatch=async (scope,request)=>{
    const run=s.Runs.rows.get(prepared.runId);
    assert.equal(run.status,'sending','saved run must be eligible at exact gate admission');
    if(++attempts===1){firstBatch=structuredClone(request.batch);throw denied('The company resource is temporarily busy.');}
    assert.equal(request.batch.requestId,firstBatch.requestId);assert.deepEqual(request.batch.items,firstBatch.items);
    return send(scope,request);
  };
  await assert.rejects(s.api.execute(bound,prepared.runId),/temporarily busy/);
  const retained=s.Runs.rows.get(prepared.runId);
  assert.equal(retained.status,'prepared');assert.equal(retained.batches[0].sends,0);assert.equal(h.sent.length,0);
  assert.equal(retained.errorDetail.code,'QBO_WRITE_ADMISSION_DENIED');assert.match(retained.errorDetail.message,/temporarily busy/);
  retained.status=retainedStatus;
  assert.equal((await s.api.execute(bound,prepared.runId)).status,'complete');
  assert.equal(attempts,2);assert.equal(h.sent.length,1);assert.equal(retained.batches.length,1);
});
