'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const aiTools = require('../src/modules/ai-tools');
const { createBusinessAgentTools } = require('../src/modules/business-agent-tools');
const { agentToolCatalog } = require('../src/modules/business-agent-catalog');

const scope = { environment: 'production', realmId: '123456789', connectionId: '1'.repeat(24) };
const NOW = Date.parse('2026-10-31T12:00:00Z');

// In-memory stand-in for CompanySyncRecord covering the filter subset local reads send.
function values(doc, path) {
  const walk = (value, parts) => !parts.length ? [value] : Array.isArray(value) ? value.flatMap(item => walk(item, parts)) : value && typeof value === 'object' && Object.hasOwn(value, parts[0]) ? walk(value[parts[0]], parts.slice(1)) : [];
  return walk(doc, path.split('.')).flatMap(item => Array.isArray(item) ? item : [item]);
}
function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const found = values(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) return Object.entries(cond).every(([op, want]) => {
      if (op === '$regex') return found.some(item => typeof item === 'string' && new RegExp(want, cond.$options).test(item));
      if (op === '$options') return true;
      if (op === '$ne') return !found.includes(want);
      if (op === '$gte') return found.some(item => item >= want);
      if (op === '$lte') return found.some(item => item <= want);
      throw new Error('fake does not support ' + op);
    });
    return found.some(item => item === cond);
  });
}
function fakeRecords(docs) {
  const filters = [];
  const query = (filter, single) => {
    filters.push(filter);
    let sort = null, skip = 0, limit = Infinity;
    const run = () => {
      let rows = docs.filter(doc => matches(doc, filter));
      if (sort) rows = [...rows].sort((a, b) => { for (const [key, dir] of Object.entries(sort)) { const x = values(a, key)[0], y = values(b, key)[0]; if (x < y) return -dir; if (x > y) return dir; } return 0; });
      rows = rows.slice(skip, skip + limit).map(row => structuredClone(row));
      return single ? rows[0] || null : rows;
    };
    const chain = { select: () => chain, sort: value => { sort = value; return chain; }, skip: value => { skip = value; return chain; }, limit: value => { limit = value; return chain; }, maxTimeMS: () => chain, lean: () => chain, then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject) };
    return chain;
  };
  return { filters, find: filter => query(filter, false), findOne: filter => query(filter, true) };
}
let seq = 0;
const doc = (entity, record, extra = {}) => ({ _id: String(++seq), ...scope, entity, qboId: record.Id, deleted: false, changedAt: new Date(record.MetaData?.LastUpdatedTime || '2026-10-01T00:00:00Z'), record, ...extra });
const updated = day => ({ LastUpdatedTime: '2026-10-' + String(day).padStart(2, '0') + 'T10:00:00-07:00' });
function company() {
  return [
    doc('Customer', { Id: '1', DisplayName: 'Harbour Bakery', Balance: 345, Active: true, MetaData: updated(20) }),
    doc('Customer', { Id: '2', DisplayName: 'Harbourside Dental', Balance: 0, Active: false, MetaData: updated(21) }),
    doc('Customer', { Id: '3', DisplayName: 'Ridge Clinic', Balance: 60, Active: true, MetaData: updated(22) }),
    doc('Invoice', { Id: '100', DocNumber: 'INV-100', TxnDate: '2026-09-01', CustomerRef: { value: '1', name: 'Harbour Bakery' }, TotalAmt: 230, Balance: 0, MetaData: updated(5), LinkedTxn: [{ TxnId: '300', TxnType: 'Payment' }] }),
    doc('Invoice', { Id: '102', DocNumber: 'INV-102', TxnDate: '2026-10-10', CustomerRef: { value: '1', name: 'Harbour Bakery' }, TotalAmt: 345, Balance: 345, MetaData: updated(10) }),
    doc('Invoice', { Id: '103', DocNumber: 'INV-103', TxnDate: '2026-10-20', CustomerRef: { value: '3', name: 'Ridge Clinic' }, TotalAmt: 60, Balance: 60, MetaData: updated(20) }),
    doc('Payment', { Id: '300', TxnDate: '2026-09-25', TotalAmt: 230, CustomerRef: { value: '1', name: 'Harbour Bakery' }, Line: [{ Amount: 230, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }], MetaData: updated(6) }),
    doc('Bill', { Id: '600', TxnDate: '2026-10-03', VendorRef: { value: '9', name: 'Coastal Supply' }, TotalAmt: 80, Balance: 0, LinkedTxn: [{ TxnId: '700', TxnType: 'BillPaymentCheck' }], MetaData: updated(7) }),
    doc('BillPayment', { Id: '700', TxnDate: '2026-10-20', TotalAmt: 80, Line: [{ Amount: 80, LinkedTxn: [{ TxnId: '600', TxnType: 'Bill' }] }], MetaData: updated(20) }),
    doc('Preferences', { Id: '1', AccountingInfoPrefs: { ClassTrackingPerTxn: true } }),
    { ...doc('Customer', { Id: '1', DisplayName: 'Harbour Other Company', Active: true, MetaData: updated(30) }), realmId: '999' },
    doc('Customer', { Id: '4', DisplayName: 'Harbour Deleted', Active: true, MetaData: updated(29) }, { deleted: true }),
  ];
}
const current = entity => ({ entity, status: 'current', lastSuccessAt: '2026-10-31T11:58:00Z', freshUntil: '2026-10-31T12:08:00Z' });
const MIRRORED = ['Customer', 'Invoice', 'Payment', 'Bill', 'BillPayment', 'Preferences'];
function setup({ sources = MIRRORED.map(current), docs = company() } = {}) {
  const Records = fakeRecords(docs), live = [];
  const row = { _id: 'b'.repeat(24), ownerId: 'a'.repeat(24), grant: null, settings: { monitoring: true, syncIntervalSeconds: 30, instructions: '' }, syncView: { status: 'current', lastSuccessAt: '2026-10-31T11:58:00Z', sources } };
  const toolHandlers = Object.fromEntries(['lookupCustomer', 'lookupInvoice', 'searchEntities', 'getEntityDetail', 'getTransactionChain', 'runReport'].map(name => [name, async input => { live.push(name); return { success: true, data: { live: true, input } }; }]));
  const tools = createBusinessAgentTools({ row, scope, passId: 'local-pass', store: { models: { Records } }, access: { authorize: async () => {} }, clientFor: async () => ({ query: async () => ({}), apiCall: async () => ({}) }), guard: async () => {}, readTools: { toolDefinitions: aiTools.toolDefinitions, toolHandlers }, now: () => NOW, signal: new AbortController().signal });
  return { tools, live, Records };
}

test('mirrored, current record types answer locally in the live tools’ shapes', async () => {
  const { tools, live, Records } = setup();
  const customers = await tools.execute('lookupCustomer', { name: 'harbour' });
  assert.equal(customers.source.answeredBy, 'synced-copy'); assert.equal(customers.source.syncedAt.Customer, '2026-10-31T11:58:00Z');
  assert.deepEqual(customers.data.customers.map(c => c.displayName), ['Harbour Bakery'], 'inactive, deleted and other-company customers are excluded');
  const all = await tools.execute('searchEntities', { type: 'Customer', query: 'HARBOUR', filters: { active: 'all' } });
  assert.deepEqual(all.data.records.map(r => r.id), ['2', '1'], 'case-insensitive, most recently updated first');
  const invoices = await tools.execute('searchEntities', { type: 'Invoice', filters: { customerId: '1', txnDateFrom: '2026-10-01' } });
  assert.deepEqual(invoices.data.records.map(r => [r.id, r.docNumber, r.balance, r.party.name]), [['102', 'INV-102', 345, 'Harbour Bakery']]);
  const paged = await tools.execute('searchEntities', { type: 'Invoice', limit: 2 });
  assert.deepEqual(paged.data.records.map(r => r.id), ['103', '102']); assert.equal(paged.data.nextStartPosition, 3);
  assert.deepEqual((await tools.execute('searchEntities', { type: 'Invoice', limit: 2, startPosition: 3 })).data.records.map(r => r.id), ['100']);
  const byDoc = await tools.execute('lookupInvoice', { docNumber: 'inv-10', customerName: 'ridge' });
  assert.deepEqual(byDoc.data.invoices.map(i => i.id), ['103']);
  const detail = await tools.execute('getEntityDetail', { type: 'Invoice', id: '100' });
  assert.equal(detail.data.record.LinkedTxn[0].TxnId, '300'); assert.equal(detail.source.answeredBy, 'synced-copy');
  assert.equal((await tools.execute('getEntityDetail', { type: 'Preferences', id: '1' })).data.record.AccountingInfoPrefs.ClassTrackingPerTxn, true);
  const chain = await tools.execute('getTransactionChain', { entityType: 'Bill', entityId: '600' });
  assert.deepEqual(chain.data.nodes.map(n => n.entity + ':' + n.id), ['Bill:600', 'BillPayment:700']);
  assert.deepEqual(Object.keys(chain.source.syncedAt).sort(), ['Bill', 'BillPayment']);
  const refused = await tools.execute('searchEntities', { type: 'Customer', filters: { txnDateFrom: '2026-10-01' } });
  assert.deepEqual(refused, { success: false, error: 'The txnDateFrom filter applies to transactions only, not Customer.', source: refused.source });
  assert.deepEqual(live, [], 'no QuickBooks read was made');
  for (const filter of Records.filters) assert.deepEqual([filter.environment, filter.realmId, filter.connectionId, filter.deleted], [scope.environment, scope.realmId, scope.connectionId, false]);
});

test('a stale or failed sync source falls back to a live QuickBooks read and says so', async () => {
  const { tools, live } = setup({ sources: MIRRORED.map(entity => entity === 'Invoice' ? { ...current(entity), status: 'stale' } : entity === 'Customer' ? { ...current(entity), status: 'error' } : current(entity)) });
  const invoices = await tools.execute('searchEntities', { type: 'Invoice', query: 'INV' });
  assert.equal(invoices.data.live, true); assert.equal(invoices.source.answeredBy, 'quickbooks-live'); assert.match(invoices.source.reason, /Invoice sync is stale/);
  assert.match((await tools.execute('lookupCustomer', { name: 'Harbour' })).source.reason, /Customer sync is error/);
  // A chain through a stale type is read live as a whole.
  assert.equal((await tools.execute('getTransactionChain', { entityType: 'Payment', entityId: '300' })).source.answeredBy, 'quickbooks-live');
  assert.equal((await tools.execute('getEntityDetail', { type: 'Bill', id: '600' })).source.answeredBy, 'synced-copy');
  assert.deepEqual(live, ['searchEntities', 'lookupCustomer', 'getTransactionChain']);
});

test('an unmirrored type or a record missing from the copy reads QuickBooks live; reports stay live', async () => {
  const { tools, live } = setup();
  const accounts = await tools.execute('searchEntities', { type: 'Account' });
  assert.equal(accounts.source.answeredBy, 'quickbooks-live'); assert.match(accounts.source.reason, /Account records are not synchronized yet/);
  const missing = await tools.execute('getEntityDetail', { type: 'Invoice', id: '999' });
  assert.equal(missing.source.answeredBy, 'quickbooks-live'); assert.match(missing.source.reason, /Invoice 999 is not in the synced copy/);
  const report = await tools.execute('runReport', { report: 'AgedReceivables' });
  assert.equal(report.source.answeredBy, 'quickbooks-live'); assert.match(report.source.reason, /computed by QuickBooks/);
  assert.deepEqual(live, ['searchEntities', 'getEntityDetail', 'runReport']);
  const definitions = new Map(tools.definitions.map(tool => [tool.name, tool.description]));
  assert.match(definitions.get('searchEntities'), /synced copy/); assert.match(definitions.get('runReport'), /queryCompanyData first/);
  assert.match(agentToolCatalog().tools.find(tool => tool.name === 'getEntityDetail').instructions, /result\.source says which answered/);
  assert.doesNotMatch(aiTools.toolDefinitions.find(tool => tool.name === 'searchEntities').description, /synced copy/, 'the legacy command center keeps its live tool text');
});
