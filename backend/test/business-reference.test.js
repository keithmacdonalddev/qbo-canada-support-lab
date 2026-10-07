'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessReferenceReader, bindBusinessReference, verifyBusinessReference, referenceDefinition } = require('../src/modules/business-reference');
const { hash } = require('../src/modules/business-calendar');
const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) };
const now = Date.parse('2026-10-06T12:00:00.000Z');
const clone = value => structuredClone(value);
function observation(entity, fields = {}) {
  const record = { Id: '100', SyncToken: '0', Active: true, Name: 'fixture', ...fields };
  return { scope: clone(scope), entity, observedAt: new Date(now).toISOString(), record, recordHash: hash(record), source: { version: 1, kind: 'qbo-full-entity-get', scope: clone(scope), entity, id: record.Id, endpoint: entity.toLowerCase() + '/' + record.Id, recordHash: hash(record) } };
}
function setup(entity = 'Item', fields = { Type: 'Inventory', QtyOnHand: 12, IncomeAccountRef: { value: '600' } }) {
  const original = observation(entity, fields), binding = bindBusinessReference({ scope, key: 'chosen', entity, observed: original, now });
  const h = { original, binding, observed: clone(original), now };
  h.refresh = () => { h.observed.recordHash = hash(h.observed.record); h.observed.source.recordHash = h.observed.recordHash; };
  h.verify = () => verifyBusinessReference({ scope, binding: h.binding, observed: h.observed, now: h.now });
  return h;
}
test('definition bindings are company-scoped and preserve the original approved version', () => {
  const h = setup(); assert.equal(h.binding.syncToken, '0'); assert.equal(h.binding.definition.version, 1); assert.deepEqual(h.verify(), h.original.record);
  const foreign = referenceDefinition({ ...scope, realmId: '456' }, 'Item', h.original.record); assert.notEqual(foreign.hash, h.binding.definition.hash);
  assert.notEqual(referenceDefinition(scope, 'Account', h.original.record).hash, h.binding.definition.hash);
});
test('supported live balance and inventory fields can change without replacing immutable definitions', () => {
  for (const [entity, fields, changed] of [
    ['Customer', { Balance: 10, BalanceWithJobs: 15 }, { Balance: -25, BalanceWithJobs: -20 }],
    ['Vendor', { Balance: 10 }, { Balance: 20 }],
    ['Item', { Type: 'Inventory', QtyOnHand: 12 }, { QtyOnHand: 24 }],
    ['Account', { AccountType: 'Bank', CurrentBalance: 100, CurrentBalanceWithSubAccounts: 110 }, { CurrentBalance: 200, CurrentBalanceWithSubAccounts: 220 }],
  ]) {
    const h = setup(entity, fields), before = clone(h.binding); Object.assign(h.observed.record, changed, { SyncToken: '5', MetaData: { LastUpdatedTime: '2026-10-06T11:59:00Z' }, domain: 'QBO', sparse: false }); h.refresh();
    assert.deepEqual(h.verify(), h.observed.record); assert.deepEqual(h.binding, before); assert.notEqual(h.observed.recordHash, h.original.recordHash);
  }
});
test('metadata-only refresh works for employees and tax codes as well as other masters', () => {
  for (const entity of ['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'TaxCode']) { const h = setup(entity, {}); h.observed.record.SyncToken = '1'; h.observed.record.MetaData = { LastUpdatedTime: '2026-10-06T11:59:59Z' }; h.refresh(); assert.doesNotThrow(h.verify); }
});
test('all remaining fields are bound including unknown future provider fields', () => {
  for (const change of [r => { r.Type = 'Service'; }, r => { r.IncomeAccountRef.value = '999'; }, r => { r.Name = 'different product'; }, r => { r.TaxCodeRef = { value: '55' }; }, r => { r.UnrecognizedFutureSetting = true; }, r => { delete r.IncomeAccountRef; }]) {
    for (const version of ['0', '1']) { const h = setup(); change(h.observed.record); h.observed.record.SyncToken = version; h.refresh(); assert.throws(h.verify, /definition/); }
  }
});
test('customer project, parent, address, currency and tax treatment changes need new intent', () => {
  for (const change of [r => { r.IsProject = true; }, r => { r.ParentRef = { value: '99' }; }, r => { r.BillAddr = { CountrySubDivisionCode: 'BC' }; }, r => { r.CurrencyRef = { value: 'USD' }; }, r => { r.TaxExemptionReasonId = '1'; }]) { const h = setup('Customer', { CurrencyRef: { value: 'CAD' }, BillAddr: { CountrySubDivisionCode: 'ON' } }); change(h.observed.record); h.refresh(); assert.throws(h.verify, /definition/); }
});
test('tax-code rates and account destinations cannot change under a newer version', () => {
  const h = setup('TaxCode', { SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '50' } }] } }); h.observed.record.SalesTaxRateList.TaxRateDetail[0].TaxRateRef.value = '51'; h.observed.record.SyncToken = '1'; h.refresh(); assert.throws(h.verify, /definition/);
  const account = setup('Account', { AccountType: 'Bank', CurrencyRef: { value: 'CAD' } }); account.observed.record.AccountType = 'Expense'; account.refresh(); assert.throws(account.verify, /definition/);
});
test('snapshot of another company, entity, ID, record hash or old observation is rejected', () => {
  for (const change of [h => { h.observed.scope.realmId = '456'; }, h => { h.observed.scope.environment = 'production'; }, h => { h.observed.scope.connectionId = 'b'.repeat(24); }, h => { h.observed.entity = 'Account'; }, h => { h.observed.record.Id = '101'; h.refresh(); }, h => { h.observed.recordHash = hash('other'); }, h => { h.observed.observedAt = '2026-10-06T11:54:59.000Z'; }, h => { h.observed.observedAt = '2026-10-06T12:00:01.000Z'; }]) { const h = setup(); change(h); assert.throws(h.verify); }
});
test('record versions are canonical strings and never regress behind the approved version', () => {
  for (const version of [1, '01', '-1', '', '9'.repeat(65)]) { const h = setup(); h.observed.record.SyncToken = version; h.refresh(); assert.throws(h.verify); }
  const h = setup(); h.binding.syncToken = '2'; h.observed.record.SyncToken = '1'; h.refresh(); assert.throws(h.verify, /version/);
  const large = setup(); large.binding.syncToken = '9'.repeat(63); large.observed.record.SyncToken = '1' + '0'.repeat(63); large.refresh(); assert.doesNotThrow(large.verify);
});
test('partial, inactive and malformed live values cannot bypass definition comparison', () => {
  for (const change of [r => { r.Active = false; }, r => { delete r.Active; }, r => { r.sparse = true; }, r => { r.sparse = 'false'; }, r => { r.QtyOnHand = '24'; }, r => { r.QtyOnHand = null; }, r => { r.QtyOnHand = Infinity; }]) { const h = setup(); change(h.observed.record); if (Number.isFinite(h.observed.record.QtyOnHand) || h.observed.record.QtyOnHand !== Infinity) h.refresh(); assert.throws(h.verify); }
});
test('definition contract cannot be removed, changed or extended by caller exclusions', () => {
  for (const change of [b => { delete b.definition; }, b => { b.definition.version = 2; }, b => { b.definition.hash = hash('other'); }]) { const h = setup(); change(h.binding); assert.throws(h.verify); }
  const h = setup(); h.binding.definition.exclude = ['IncomeAccountRef']; h.observed.record.IncomeAccountRef.value = '999'; h.refresh(); assert.throws(h.verify, /definition/);
});
test('definition observations are bounded and preparation itself requires fresh exact source evidence', () => {
  const observed = observation('Item', { Description: 'x'.repeat(256001) }); assert.throws(() => bindBusinessReference({ scope, key: 'item', entity: 'Item', observed, now }), /budget/);
  const stale = observation('Account'); stale.observedAt = '2026-10-06T11:00:00.000Z'; assert.throws(() => bindBusinessReference({ scope, key: 'account', entity: 'Account', observed: stale, now }), /stale/);
  const wrong = observation('Item'); wrong.recordHash = hash('other'); assert.throws(() => bindBusinessReference({ scope, key: 'item', entity: 'Item', observed: wrong, now }));
});
test('same-name replacements cannot satisfy a retained exact record choice', () => {
  const h = setup(); h.observed.record.Id = '101'; h.refresh(); assert.throws(h.verify, /provenance|definition|version/);
});

test('matching projected records are rejected without exact full-read provenance', () => {
  for (const change of [source => undefined, source => ({ ...source, kind: 'query' }), source => ({ ...source, endpoint: 'query?query=select Id' }), source => ({ ...source, recordHash: hash('another read') }), source => ({ ...source, scope: { ...scope, realmId: '999' } })]) {
    const observed = observation('Customer', { CurrencyRef: { value: 'CAD' } }); observed.source = change(observed.source);
    assert.throws(() => bindBusinessReference({ scope, entity: 'Customer', key: 'customer', observed, now }), /provenance/);
    const h = setup('Customer', { CurrencyRef: { value: 'CAD' } }); h.observed.source = change(h.observed.source); assert.throws(h.verify, /provenance/);
  }
});
function readerHarness() {
  const h = { calls: [], authorizations: 0, clock: now, record: { Id: '100', SyncToken: '0', Active: true, Name: 'fixture', Type: 'Inventory', QtyOnHand: 12 } };
  h.client = { realmId: scope.realmId, connection: { _id: scope.connectionId, realmId: scope.realmId, status: 'active' }, apiBase: 'https://sandbox-quickbooks.api.intuit.com/v3/company/123',
    read: async (...args) => { h.calls.push(args); if (h.onRead) return h.onRead(); return h.body || { Item: h.record, time: '2026-10-06T12:00:00Z' }; },
  };
  h.reader = createBusinessReferenceReader({ resolveClient: async () => h.client, authorize: async () => { h.authorizations++; if (h.onAuthorize) return h.onAuthorize(); return { actorId: 'actor' }; }, now: () => h.clock });
  return h;
}
test('fixed reader uses the exact full GET and preserves all returned fields with bound provenance', async () => {
  const h = readerHarness(); h.record.UnrecognizedSetting = { value: true }; const observed = await h.reader(scope, 'Item', '100');
  assert.deepEqual(h.calls, [['item', '100']]); assert.equal(h.authorizations, 2); assert.deepEqual(observed.record, h.record); assert.equal(observed.source.endpoint, 'item/100'); assert.equal(observed.source.recordHash, hash(h.record));
  const binding = bindBusinessReference({ scope, entity: 'Item', key: 'stock', observed, now }); assert.deepEqual(verifyBusinessReference({ scope, binding, observed, now }), observed.record);
  h.record.Name = 'changed after reply'; assert.notEqual(observed.record.Name, h.record.Name);
});
test('reader refuses company, connection, environment or status mismatch before any GET', async () => {
  for (const change of [h => { h.client.realmId = '456'; }, h => { h.client.connection.realmId = '456'; }, h => { h.client.connection._id = 'f'.repeat(24); }, h => { h.client.apiBase = 'https://quickbooks.api.intuit.com/v3/company/123'; }, h => { h.client.connection.status = 'revoked'; }]) { const h = readerHarness(); change(h); await assert.rejects(h.reader(scope, 'Item', '100'), /connection/); assert.equal(h.calls.length, 0); }
});
test('reader never accepts query, partial, wrong-identity or unexpected provider envelopes', async () => {
  for (const body of [{ QueryResponse: { Item: [{ Id: '100', Active: true, SyncToken: '0' }] } }, { Item: { Id: '100', Active: true, SyncToken: '0', sparse: true } }, { Item: { Id: '101', Active: true, SyncToken: '0' } }, { Item: { Id: '100', Active: true, SyncToken: '0' }, Fault: {} }]) { const h = readerHarness(); h.body = body; await assert.rejects(h.reader(scope, 'Item', '100')); }
});
test('client or actor change after the GET discards returned reference evidence', async () => {
  const h = readerHarness(); h.onRead = () => { h.client.connection.status = 'revoked'; return { Item: h.record }; }; await assert.rejects(h.reader(scope, 'Item', '100'), /connection/);
  const g = readerHarness(); g.onAuthorize = () => ({ actorId: g.authorizations === 1 ? 'actor' : 'other' }); await assert.rejects(g.reader(scope, 'Item', '100'), /reader changed/);
});
test('cancelled and over-budget GETs never produce accepted full-read evidence', async () => {
  const controller = new AbortController(), h = readerHarness(); controller.abort(); await assert.rejects(h.reader(scope, 'Item', '100', { signal: controller.signal }), /cancelled/); assert.equal(h.calls.length, 0);
  const g = readerHarness(); g.onRead = () => { g.clock += 60001; return { Item: g.record }; }; await assert.rejects(g.reader(scope, 'Item', '100'), /budget/);
  const stalled = readerHarness(), cancelled = new AbortController(); let started, finish;
  const called = new Promise(resolve => { started = resolve; });
  stalled.onRead = () => new Promise(resolve => { finish = resolve; started(); });
  const pending = stalled.reader(scope, 'Item', '100', { signal: cancelled.signal }); await called; cancelled.abort(); await assert.rejects(pending, /cancelled/); finish({ Item: stalled.record }); assert.equal(stalled.authorizations, 1);
});
test('untrusted entity or identifier cannot select arbitrary endpoints', async () => {
  for (const [entity, id] of [['query', '100'], ['Item', '100?include=other'], ['Item/100', '100']]) { const h = readerHarness(); await assert.rejects(h.reader(scope, entity, id), /exact supported/); assert.equal(h.calls.length, 0); }
});
