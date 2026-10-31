'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompanyQuery, normalize } = require('../src/modules/business-company-query');
const { createBusinessAgentTools, validateArguments, EXTRA_TOOLS } = require('../src/modules/business-agent-tools');

const scope = { environment: 'production', realmId: '123456789', connectionId: '1'.repeat(24) };
const other = { ...scope, realmId: '999999999' };

// A small in-memory stand-in for the CompanySyncRecord model. It understands only the filter
// subset the query module sends (dotted equality with array traversal, $in, $eq/$gt/$gte/$lt/$lte,
// $or) and records every filter so scope enforcement can be checked.
function values(doc, path) {
  const walk = (value, parts) => !parts.length ? [value] : Array.isArray(value) ? value.flatMap(item => walk(item, parts)) : value && typeof value === 'object' && Object.hasOwn(value, parts[0]) ? walk(value[parts[0]], parts.slice(1)) : [];
  return walk(doc, path.split('.')).flatMap(item => Array.isArray(item) ? item : [item]);
}
function matchFilter(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some(item => matchFilter(doc, item));
    const found = values(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) return Object.entries(cond).every(([op, want]) => {
      if (op === '$in') return found.some(item => want.includes(item));
      if (op === '$eq') return found.includes(want);
      if (['$gt', '$gte', '$lt', '$lte'].includes(op)) return found.some(item => op === '$gt' ? item > want : op === '$gte' ? item >= want : op === '$lt' ? item < want : item <= want);
      throw new Error('fake does not support ' + op);
    });
    return found.some(item => String(item) === String(cond));
  });
}
function fakeRecords(docs) {
  const filters = [];
  return { filters, find(filter) {
    filters.push(filter);
    const chain = { select: () => chain, lean: () => chain, maxTimeMS: ms => { assert.ok(ms > 0 && ms <= 10000); return chain; }, batchSize: () => chain,
      cursor: () => ({ async *[Symbol.asyncIterator]() { for (const doc of docs) if (matchFilter(doc, filter)) yield structuredClone(doc); }, close: async () => {} }) };
    return chain;
  } };
}
let seq = 0;
const doc = (entity, record, extra = {}) => ({ _id: String(++seq), ...scope, entity, qboId: record.Id, deleted: false, lastObservedAt: new Date('2026-10-31T12:00:00Z'), record, ...extra });
const line = (item, qty, amount, klass) => ({ Amount: amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: item.value, name: item.name }, Qty: qty, ...(klass ? { ClassRef: { name: klass } } : {}) } });
const repairs = { value: '7', name: 'Field repairs' }, plan = { value: '8', name: 'Care plan' };
const link = (TxnType, TxnId) => ({ TxnId, TxnType });
function company() {
  return [
    doc('Customer', { Id: '1', DisplayName: 'Harbour Bakery', Active: true }),
    doc('Customer', { Id: '2', DisplayName: 'Ridge Clinic', Active: true }),
    doc('Estimate', { Id: '50', TxnDate: '2026-08-20', CustomerRef: { value: '1', name: 'Harbour Bakery' }, TotalAmt: 230, LinkedTxn: [link('Invoice', '100')] }),
    doc('Invoice', { Id: '100', DocNumber: 'INV-100', TxnDate: '2026-09-01', DueDate: '2026-09-15', CustomerRef: { value: '1', name: 'Harbour Bakery' }, TotalAmt: 230, Balance: 0, Line: [line(repairs, 2, 200, 'Service'), line(plan, 1, 30)], LinkedTxn: [link('Estimate', '50'), link('Payment', '300')] }),
    doc('Invoice', { Id: '101', DocNumber: 'INV-101', TxnDate: '2026-09-20', DueDate: '2026-10-05', CustomerRef: { value: '2', name: 'Ridge Clinic' }, TotalAmt: 115, Balance: 115, Line: [line(repairs, 1, 100)] }),
    doc('Invoice', { Id: '102', DocNumber: 'INV-102', TxnDate: '2026-10-10', DueDate: '2026-10-25', CustomerRef: { value: '1', name: 'Harbour Bakery' }, TotalAmt: 345, Balance: 345, Line: [line(repairs, 3, 300)] }),
    doc('Invoice', { Id: '103', DocNumber: 'INV-103', TxnDate: '2026-10-20', DueDate: '2026-11-04', CustomerRef: { value: '2', name: 'Ridge Clinic' }, TotalAmt: 60, Balance: 60, Line: [line(plan, 2, 60, 'Care')] }),
    doc('Payment', { Id: '300', TxnDate: '2026-09-25', CustomerRef: { value: '1', name: 'Harbour Bakery' }, TotalAmt: 230, Line: [{ Amount: 230, LinkedTxn: [link('Invoice', '100')] }] }),
    doc('Deposit', { Id: '400', TxnDate: '2026-09-26', TotalAmt: 230, Line: [{ Amount: 230, LinkedTxn: [link('Payment', '300')] }] }),
    doc('PurchaseOrder', { Id: '500', TxnDate: '2026-10-01', VendorRef: { value: '9', name: 'Coastal Supply' }, TotalAmt: 80, LinkedTxn: [link('Bill', '600')] }),
    doc('Bill', { Id: '600', TxnDate: '2026-10-03', DueDate: '2026-10-13', VendorRef: { value: '9', name: 'Coastal Supply' }, TotalAmt: 80, Balance: 0, Line: [{ Amount: 80, LinkedTxn: [link('PurchaseOrder', '500')] }], LinkedTxn: [link('BillPaymentCheck', '700')] }),
    doc('BillPayment', { Id: '700', TxnDate: '2026-10-20', VendorRef: { value: '9', name: 'Coastal Supply' }, TotalAmt: 80, Line: [{ Amount: 80, LinkedTxn: [link('Bill', '600')] }] }),
    // Never visible: another company's record and a deleted record.
    { ...doc('Invoice', { Id: '900', TxnDate: '2026-10-11', CustomerRef: { value: '1', name: 'Harbour Bakery' }, TotalAmt: 9999, Balance: 9999 }), ...other },
    doc('Invoice', { Id: '901', TxnDate: '2026-10-12', CustomerRef: { value: '1', name: 'Harbour Bakery' }, TotalAmt: 7777, Balance: 7777 }, { deleted: true }),
  ];
}
const view = { status: 'current', lastSuccessAt: '2026-10-31T11:55:00Z', sources: [{ entity: 'Invoice', status: 'current', lastSuccessAt: '2026-10-31T11:55:00Z', freshUntil: '2026-10-31T12:05:00Z' }, { entity: 'Payment', status: 'stale', lastSuccessAt: '2026-10-31T09:00:00Z' }] };
function setup(options = {}) {
  const Records = fakeRecords(options.docs || company());
  return { Records, query: createCompanyQuery({ Records, scope, freshness: () => view, businessDate: () => '2026-10-31', now: () => Date.parse('2026-10-31T12:00:00Z'), ...options }) };
}

test('find filters any field path, including nested line fields, with sort, projection and paging', async () => {
  const { query } = setup();
  const open = await query.run({ mode: 'find', entities: ['Invoice'], where: [{ field: 'Balance', op: 'gt', value: 0 }, { field: 'TxnDate', op: 'gte', value: '2026-09-01' }, { field: 'TxnDate', op: 'lte', value: '2026-10-31' }], sort: [{ field: 'TotalAmt', direction: 'desc' }], fields: ['DocNumber', 'TotalAmt', 'CustomerRef.name'] });
  assert.deepEqual(open.data.rows.map(row => row.id), ['102', '101', '103']);
  assert.deepEqual(open.data.rows[0], { entity: 'Invoice', id: '102', DocNumber: 'INV-102', TotalAmt: 345, 'CustomerRef.name': 'Harbour Bakery' });
  assert.equal(open.data.total, 3); assert.equal(open.data.nextCursor, null);
  assert.equal(open.data.source, 'synced copy (no QuickBooks request)');
  const byItem = await query.run({ mode: 'find', entities: ['Invoice'], where: [{ field: 'Line.SalesItemLineDetail.ItemRef.value', op: 'eq', value: 8 }] });
  assert.deepEqual(byItem.data.rows.map(row => row.id), ['100', '103'], 'a numeric value matches the text id, element by element');
  const either = await query.run({ mode: 'find', entities: ['Invoice', 'Customer'], where: [{ anyOf: [{ field: 'CustomerRef.name', op: 'contains', value: 'ridge' }, { field: 'DisplayName', op: 'startsWith', value: 'harb' }] }] });
  assert.deepEqual(either.data.rows.map(row => row.entity + ':' + row.id), ['Customer:1', 'Invoice:101', 'Invoice:103']);
  const missing = await query.run({ mode: 'find', entities: ['Invoice'], where: [{ field: 'Line.SalesItemLineDetail.ClassRef.name', op: 'exists', value: false }, { field: 'DocNumber', op: 'nin', values: ['INV-101'] }] });
  assert.deepEqual(missing.data.rows.map(row => row.id), ['102']);
  const first = await query.run({ mode: 'find', entities: ['Invoice'], sort: [{ field: 'TxnDate' }], limit: 2 });
  assert.deepEqual(first.data.rows.map(row => row.id), ['100', '101']); assert.ok(first.data.nextCursor);
  const second = await query.run({ mode: 'find', entities: ['Invoice'], sort: [{ field: 'TxnDate' }], limit: 2, cursor: first.data.nextCursor });
  assert.deepEqual(second.data.rows.map(row => row.id), ['102', '103']); assert.equal(second.data.nextCursor, null);
  await assert.rejects(query.run({ mode: 'find', entities: ['Bill'], limit: 2, cursor: first.data.nextCursor }), /different query/);
  const whole = await query.run({ mode: 'find', entities: ['Payment'], fields: ['*'] });
  assert.equal(whole.data.rows[0].record.Line[0].LinkedTxn[0].TxnId, '100');
});

test('aggregate groups by fields and periods with sums, aging, unwound lines and payment timing', async () => {
  const { query } = setup();
  const monthly = await query.run({ mode: 'aggregate', entities: ['Invoice'], groupBy: [{ field: 'CustomerRef.name' }, { field: 'TxnDate', period: 'month' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'TotalAmt' }] });
  assert.deepEqual(monthly.data.groups.map(group => [group.key['CustomerRef.name'], group.key['TxnDate:month'], group.count, group['sum:TotalAmt']]),
    [['Harbour Bakery', '2026-09', 1, 230], ['Harbour Bakery', '2026-10', 1, 345], ['Ridge Clinic', '2026-09', 1, 115], ['Ridge Clinic', '2026-10', 1, 60]]);
  assert.deepEqual(monthly.data.totals, { count: 4, 'sum:TotalAmt': 750 });
  const aging = await query.run({ mode: 'aggregate', entities: ['Invoice'], where: [{ field: 'Balance', op: 'gt', value: 0 }], groupBy: [{ field: 'DueDate', bucket: 'aging' }], metrics: [{ op: 'sum', field: 'Balance' }], asOf: '2026-11-10' });
  assert.deepEqual(aging.data.groups.map(group => [group.key['DueDate:aging'], group['sum:Balance']]), [['1-30', 405], ['31-60', 115]]);
  assert.equal(aging.data.asOf, '2026-11-10');
  const items = await query.run({ mode: 'aggregate', entities: ['Invoice'], unwind: 'Line', groupBy: [{ field: 'Line.SalesItemLineDetail.ItemRef.name' }], metrics: [{ op: 'sum', field: 'Line.SalesItemLineDetail.Qty' }, { op: 'sum', field: 'Line.Amount' }, { op: 'countDistinct', field: 'CustomerRef.value' }], sort: [{ field: 'sum:Line.Amount', direction: 'desc' }] });
  assert.deepEqual(items.data.groups.map(group => [group.key['Line.SalesItemLineDetail.ItemRef.name'], group['sum:Line.SalesItemLineDetail.Qty'], group['sum:Line.Amount'], group['countDistinct:CustomerRef.value']]), [['Field repairs', 6, 600, 2], ['Care plan', 3, 90, 2]]);
  assert.equal(items.data.warning, undefined);
  const tagged = await query.run({ mode: 'aggregate', entities: ['Invoice'], groupBy: [{ field: 'Line.SalesItemLineDetail.ItemRef.name' }] });
  assert.match(tagged.data.warning, /Unwind/);
  const paying = await query.run({ mode: 'aggregate', entities: ['Invoice', 'Bill'], where: [{ field: 'Balance', op: 'eq', value: 0 }], groupBy: [{ field: '_entity' }], metrics: [{ op: 'avg', field: '_daysToPay' }, { op: 'max', field: '_daysLate' }, { op: 'max', field: '_paidDate' }] });
  assert.deepEqual(paying.data.groups.map(group => [group.key._entity, group['avg:_daysToPay'], group['max:_daysLate'], group['max:_paidDate']]), [['Bill', 17, 7, '2026-10-20'], ['Invoice', 24, 10, '2026-09-25']]);
  assert.deepEqual(paying.data.freshness.sources.map(row => row.entity), ['Invoice', 'Bill', 'Payment', 'BillPayment'], 'freshness covers the payment sources it read');
  const overdue = await query.run({ mode: 'aggregate', entities: ['Invoice'], where: [{ field: '_daysLate', op: 'gt', value: 0 }], groupBy: [{ field: 'CustomerRef.name' }], metrics: [{ op: 'max', field: '_daysLate' }] });
  assert.deepEqual(overdue.data.groups.map(group => [group.key['CustomerRef.name'], group['max:_daysLate']]), [['Harbour Bakery', 10], ['Ridge Clinic', 26]]);
  const weekly = await query.run({ mode: 'aggregate', entities: ['Invoice', 'Payment', 'Deposit'], groupBy: [{ field: 'TxnDate', period: 'week' }, { field: '_entity' }] });
  assert.deepEqual(weekly.data.groups[0].key, { 'TxnDate:week': '2026-08-31', _entity: 'Invoice' }, 'weeks start on Monday');
});

test('links follow LinkedTxn both ways from the local copy', async () => {
  const { query } = setup();
  const sale = await query.run({ mode: 'links', entities: ['Invoice'], ids: ['100'], depth: 2 });
  assert.deepEqual(sale.data.nodes.map(node => node.entity + ':' + node.id + '@' + node.depth).sort(), ['Deposit:400@2', 'Estimate:50@1', 'Invoice:100@0', 'Payment:300@1']);
  const edges = sale.data.edges.map(edge => edge.from + '>' + edge.to);
  assert.ok(edges.includes('Payment:300>Invoice:100') && edges.includes('Invoice:100>Payment:300') && edges.includes('Deposit:400>Payment:300') && edges.includes('Estimate:50>Invoice:100'));
  const purchase = await query.run({ mode: 'links', entities: ['PurchaseOrder'], where: [{ field: 'VendorRef.name', op: 'eq', value: 'Coastal Supply' }], depth: 3 });
  assert.deepEqual(purchase.data.nodes.map(node => node.entity + ':' + node.id).sort(), ['Bill:600', 'BillPayment:700', 'PurchaseOrder:500']);
  assert.ok(purchase.data.edges.some(edge => edge.from === 'Bill:600' && edge.to === 'BillPayment:700' && edge.txnType === 'BillPaymentCheck'));
  const shallow = await query.run({ mode: 'links', entities: ['Invoice'], ids: ['100'], depth: 1 });
  assert.equal(shallow.data.nodes.some(node => node.entity === 'Deposit'), false);
});

test('company scope and deleted records are enforced server side on every read', async () => {
  const { query, Records } = setup();
  const all = await query.run({ mode: 'aggregate', entities: ['Invoice'], metrics: [{ op: 'count' }, { op: 'sum', field: 'TotalAmt' }] });
  assert.deepEqual(all.data.totals, { count: 4, 'sum:TotalAmt': 750 }, 'another company and a deleted copy are never counted');
  await query.run({ mode: 'links', entities: ['Invoice'], ids: ['100', '900'], depth: 2 });
  await query.run({ mode: 'find', entities: ['Invoice'], where: [{ field: 'realmId', op: 'eq', value: other.realmId }] });
  assert.ok(Records.filters.length > 3);
  for (const filter of Records.filters) assert.deepEqual({ environment: filter.environment, realmId: filter.realmId, connectionId: filter.connectionId, deleted: filter.deleted }, { ...scope, deleted: false });
  // Field paths address the QuickBooks record only, never the mirror's own scope fields.
  assert.equal((await query.run({ mode: 'find', entities: ['Invoice'], where: [{ field: 'realmId', op: 'exists' }] })).data.total, 0);
  const specialist = createCompanyQuery({ Records, scope, allowedEntities: ['Vendor', 'Bill'] });
  await assert.rejects(specialist.run({ mode: 'find', entities: ['Invoice'] }), error => error.status === 403);
  assert.throws(() => createCompanyQuery({ Records, scope: { realmId: scope.realmId } }), /concrete company scope/);
});

test('only whitelisted operators and plain field paths are accepted', async () => {
  const { query } = setup();
  const reject = (input, pattern) => assert.throws(() => normalize(input), error => error.code === 'BUSINESS_QUERY_REJECTED' && pattern.test(error.message));
  reject({ mode: 'find', entities: ['Invoice'], where: [{ field: 'TotalAmt', op: '$where', value: 'sleep(1)' }] }, /op must be/);
  reject({ mode: 'find', entities: ['Invoice'], where: [{ field: '$where', op: 'eq', value: 1 }] }, /field path/);
  reject({ mode: 'find', entities: ['Invoice'], where: [{ field: 'Line.$gt', op: 'eq', value: 1 }] }, /field path/);
  reject({ mode: 'find', entities: ['Invoice'], where: [{ field: '__proto__.polluted', op: 'eq', value: 1 }] }, /field path/);
  reject({ mode: 'find', entities: ['Invoice'], where: [{ field: 'TotalAmt', op: 'eq', value: { $gt: 0 } }] }, /single text/);
  reject({ mode: 'find', entities: ['Invoice'], where: [{ anyOf: [{ anyOf: [{ field: 'TotalAmt', op: 'eq', value: 1 }] }] }] }, /one level/);
  reject({ mode: 'aggregate', entities: ['Invoice'], metrics: [{ op: '$function', field: 'TotalAmt' }] }, /metrics/);
  reject({ mode: 'aggregate', entities: ['Invoice'], pipeline: [{ $lookup: {} }] }, /not used/);
  reject({ mode: 'find', entities: ['system.users'] }, /mirrored record types/);
  reject({ mode: 'find', entities: ['Invoice'], unwind: 'Line.LinkedTxn' }, /top-level array/);
  reject({ mode: 'find', entities: ['Invoice'], groupBy: [{ field: 'TxnDate' }] }, /not used in find/);
  reject({ mode: 'aggregate', entities: ['Invoice'], sort: [{ field: 'TotalAmt' }] }, /groupBy key or metric/);
  // Prototype names never resolve through inherited properties.
  assert.equal((await query.run({ mode: 'find', entities: ['Invoice'], where: [{ field: 'constructor', op: 'exists' }] })).data.total, 0);
  // The advertised tool contract rejects the same injections before the module runs.
  const contract = EXTRA_TOOLS.find(tool => tool.name === 'queryCompanyData').input_schema;
  assert.throws(() => validateArguments({ mode: 'find', entities: ['Invoice'], where: [{ field: 'TotalAmt', op: '$where' }] }, contract), /supported choices/);
  assert.throws(() => validateArguments({ mode: 'find', entities: ['Invoice'], where: [{ field: 'TotalAmt', op: 'eq', value: { $gt: 0 } }] }, contract), /must be string, number, boolean, null/);
  assert.throws(() => validateArguments({ mode: 'find', entities: ['Invoice'], $where: 'x' }, contract), /unsupported field/);
  validateArguments({ mode: 'find', entities: ['Invoice'], where: [{ field: 'Balance', op: 'eq', value: null }, { field: 'TotalAmt', op: 'gt', value: 10.5 }, { field: 'Active', op: 'eq', value: true }, { field: 'Id', op: 'in', values: ['1', 2] }] }, contract);
});

test('output is bounded by rows, bytes, scanned records and time', async () => {
  const many = Array.from({ length: 300 }, (_, index) => doc('Invoice', { Id: String(1000 + index), TxnDate: '2026-10-01', PrivateNote: 'x'.repeat(400), TotalAmt: 1, Balance: 1 }));
  const { query } = setup({ docs: many });
  assert.throws(() => normalize({ mode: 'find', entities: ['Invoice'], limit: 201 }), /limit must be/);
  const page = await query.run({ mode: 'find', entities: ['Invoice'], fields: ['PrivateNote'], limit: 200 });
  assert.ok(page.data.returned < 200 && page.data.returned > 0); assert.equal(page.data.total, 300); assert.ok(page.data.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(page.data.rows)) <= 30000);
  const next = await query.run({ mode: 'find', entities: ['Invoice'], fields: ['PrivateNote'], limit: 200, cursor: page.data.nextCursor });
  assert.equal(next.data.rows[0].id, String(1000 + page.data.returned), 'the cursor continues where the bounded page stopped');
  const big = setup({ docs: [doc('Invoice', { Id: '1', Memo: 'y'.repeat(9000) })] }).query;
  assert.match((await big.run({ mode: 'find', entities: ['Invoice'], fields: ['*'] })).data.rows[0].truncated, /larger/);
  const capped = setup({ docs: many, limits: { ...require('../src/modules/business-company-query').LIMITS, docs: 50 } }).query;
  await assert.rejects(capped.run({ mode: 'aggregate', entities: ['Invoice'] }), error => error.status === 422 && /more than 50 records/.test(error.message));
  let clock = 0;
  const slow = createCompanyQuery({ Records: fakeRecords(many), scope, now: () => (clock += 100), businessDate: () => '2026-10-31' });
  await assert.rejects(slow.run({ mode: 'find', entities: ['Invoice'] }), /longer than 8 seconds/);
});

test('the accountant tool reads only the synced copy and reports freshness', async () => {
  const Records = fakeRecords(company()); let live = 0;
  const row = { _id: 'b'.repeat(24), ownerId: 'a'.repeat(24), grant: null, settings: { monitoring: true, syncIntervalSeconds: 30, instructions: '' }, syncView: view };
  const make = role => createBusinessAgentTools({ row, role, scope, passId: 'query-pass', store: { models: { Records } }, access: { resolveClient: async () => { live++; return {}; } }, guard: async () => {}, readTools: { toolDefinitions: [], toolHandlers: {} }, now: () => Date.parse('2026-10-31T12:00:00Z'), signal: new AbortController().signal });
  const tools = make('accountant');
  assert.ok(tools.definitions.some(tool => tool.name === 'queryCompanyData'));
  const result = await tools.execute('queryCompanyData', { mode: 'aggregate', entities: ['Invoice'], where: [{ field: 'Balance', op: 'gt', value: 0 }], groupBy: [{ field: 'CustomerRef.name' }], metrics: [{ op: 'sum', field: 'Balance' }] });
  assert.equal(result.success, true); assert.equal(live, 0, 'no QuickBooks client is opened');
  assert.deepEqual(result.data.groups.map(group => group['sum:Balance']), [345, 175]);
  assert.equal(result.data.freshness.sources[0].entity, 'Invoice'); assert.equal(result.data.freshness.sources[0].lastSuccessAt, '2026-10-31T11:55:00Z');
  await assert.rejects(tools.execute('queryCompanyData', { mode: 'find', entities: ['Invoice'], where: [{ field: 'TotalAmt', op: 'regex', value: '.*' }] }), /supported choices/);
  await assert.rejects(make('payables').execute('queryCompanyData', { mode: 'find', entities: ['Invoice'] }), /another specialist/);
  assert.equal((await make('payables').execute('queryCompanyData', { mode: 'find', entities: ['Bill'] })).data.total, 1);
});
