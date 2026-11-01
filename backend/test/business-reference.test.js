'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessReferenceReader, bindBusinessReference, verifyBusinessReference, referenceDefinition, readAndVerifyBusinessReference } = require('../src/modules/business-reference');
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
  const h = setup(); assert.equal(h.binding.syncToken, '0'); assert.equal(h.binding.definition.version, 2); assert.deepEqual(h.verify(), h.original.record);
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
test('current full reference wins over old labels defaults prices and unknown fields', () => {
  for (const change of [r => { r.Type = 'Service'; }, r => { r.IncomeAccountRef.value = '999'; }, r => { r.Name = 'different product'; }, r => { r.TaxCodeRef = { value: '55' }; }, r => { r.UnrecognizedFutureSetting = true; }, r => { delete r.IncomeAccountRef; }]) {
    const h = setup(), before = clone(h.binding); change(h.observed.record); h.refresh();
    assert.equal(h.verify(), h.observed.record); assert.deepEqual(h.binding, before);
  }
});

test('reference resolution leaves typed transaction purpose checks to the compiler', () => {
  for (const change of [r => { r.IsProject = true; }, r => { r.ParentRef = { value: '99' }; }, r => { r.BillAddr = { CountrySubDivisionCode: 'BC' }; }, r => { r.CurrencyRef = { value: 'USD' }; }, r => { r.TaxExemptionReasonId = '1'; }]) {
    const h = setup('Customer', { CurrencyRef: { value: 'CAD' } }); change(h.observed.record); h.refresh(); assert.equal(h.verify(), h.observed.record);
  }
});

test('current tax and account definitions are returned for dated tax and routing validation', () => {
  for (const entity of ['TaxCode', 'TaxRate', 'Term', 'Account']) {
    const h = setup(entity, {}); h.observed.record.SyncToken = '3'; h.observed.record.FutureProviderField = { enabled: true }; h.refresh(); assert.equal(h.verify(), h.observed.record);
  }
});

test('snapshot of another company, entity, ID, record hash or old observation is rejected', () => {
  for (const change of [h => { h.observed.scope.realmId = '456'; }, h => { h.observed.scope.environment = 'production'; }, h => { h.observed.scope.connectionId = 'b'.repeat(24); }, h => { h.observed.entity = 'Account'; }, h => { h.observed.record.Id = '101'; h.refresh(); }, h => { h.observed.recordHash = hash('other'); }, h => { h.observed.observedAt = '2026-10-06T11:54:59.000Z'; }, h => { h.observed.observedAt = '2026-10-06T12:00:01.000Z'; }]) { const h = setup(); change(h); assert.throws(h.verify); }
});
test('record versions remain canonical; the historical version is not a current floor', () => {
  for (const version of [1, '01', '-1', '', '9'.repeat(65)]) { const h = setup(); h.observed.record.SyncToken = version; h.refresh(); assert.throws(h.verify); }
  const h = setup(); h.binding.syncToken = '2'; h.observed.record.SyncToken = '1'; h.refresh(); assert.equal(h.verify(), h.observed.record);
  const large = setup(); large.binding.syncToken = '9'.repeat(63); large.observed.record.SyncToken = '1' + '0'.repeat(63); large.refresh(); assert.doesNotThrow(large.verify);
});
test('partial, inactive and malformed live values cannot bypass definition comparison', () => {
  for (const change of [r => { r.Active = false; }, r => { r.status = 'Deleted'; }, r => { delete r.Active; }, r => { r.sparse = true; }, r => { r.sparse = 'false'; }, r => { r.QtyOnHand = '24'; }, r => { r.QtyOnHand = null; }, r => { r.QtyOnHand = Infinity; }]) { const h = setup(); change(h.observed.record); if (Number.isFinite(h.observed.record.QtyOnHand) || h.observed.record.QtyOnHand !== Infinity) h.refresh(); assert.throws(h.verify); }
});
test('historical definition hashes do not grant or gate current reference admission', () => {
  for (const change of [b => { delete b.definition; }, b => { b.definition.version = 3; }, b => { b.definition.hash = hash('other'); }]) { const h = setup(); change(h.binding); assert.equal(h.verify(), h.observed.record); }
  const h = setup(); h.binding.definition.exclude = ['Active']; h.observed.record.Active = false; h.refresh(); assert.throws(h.verify);
});

test('definition observations are bounded and preparation itself requires fresh exact source evidence', () => {
  const observed = observation('Item', { Description: 'x'.repeat(256001) }); assert.throws(() => bindBusinessReference({ scope, key: 'item', entity: 'Item', observed, now }), /budget/);
  const stale = observation('Account'); stale.observedAt = '2026-10-06T11:00:00.000Z'; assert.throws(() => bindBusinessReference({ scope, key: 'account', entity: 'Account', observed: stale, now }), /stale/);
  const wrong = observation('Item'); wrong.recordHash = hash('other'); assert.throws(() => bindBusinessReference({ scope, key: 'item', entity: 'Item', observed: wrong, now }));
});
test('same-name replacements cannot satisfy a retained exact record choice', () => {
  const h = setup(); h.observed.record.Id = '101'; h.refresh(); assert.throws(h.verify, /provenance|identity/);
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

function serviceFields() { return { Type: 'Service', UnitPrice: 149, IncomeAccountRef: { value: '126', name: 'Income display' }, SalesTaxCodeRef: { value: '16', name: 'Tax display' }, Taxable: true }; }
test('canonical Item and TaxCode definitions match live, mirror and saved shapes in both directions', () => {
  for (const [entity, fields] of [['Item', serviceFields()], ['TaxCode', { Taxable: true, SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '34', name: 'Tax rate display' }, TaxTypeApplicable: 'TaxOnAmount' }] } }]]) {
    const mirror = observation(entity, fields), live = clone(mirror);
    live.record.SyncToken = '2'; live.record.domain = 'QBO'; live.record.sparse = false;
    live.record.MetaData = { LastUpdatedTime: '2026-10-06T11:59:59Z' };
    live.record.LastUpdatedTime = '2026-10-06T11:59:59Z';
    const dropLabels = value => { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { if (/Ref$/.test(key)) delete child.name; dropLabels(child); } };
    dropLabels(live.record); live.recordHash = hash(live.record); live.source.recordHash = live.recordHash;
    for (const [before, after] of [[mirror, live], [live, mirror]]) {
      const binding = bindBusinessReference({ scope, entity, key: 'chosen', observed: before, now }); binding.syncToken = '0';
      assert.deepEqual(verifyBusinessReference({ scope, binding, observed: after, now }), after.record);
    }
  }
});
test('Item 44 reference default drift needs no creation or approval witness', () => {
  const h = setup('Item', serviceFields()); h.binding.id = '44'; h.observed.record.Id = '44'; h.observed.source.id = '44'; h.observed.source.endpoint = 'item/44';
  for (const value of [undefined, null, false]) {
    delete h.observed.record.DeferredRevenue; if (value !== undefined) h.observed.record.DeferredRevenue = value;
    delete h.observed.record.IncomeAccountRef.name; h.refresh(); assert.equal(h.verify(), h.observed.record);
  }
  h.observed.definitionObservation = { recordHash: hash('invalid old witness') }; assert.equal(h.verify(), h.observed.record);
});

test('forced live Item reads keep live quantities and a fresh mirror witness for saved v1 bindings', async () => {
  const h = readerHarness(), mirror = observation('Item', { ...serviceFields(), QtyOnHand: 2 });
  mirror.source = { version: 1, kind: 'qbo-current-mirror', scope, entity: 'Item', id: '100', recordHash: mirror.recordHash, generation: 'current', completedAt: new Date(now - 1000).toISOString(), freshUntil: new Date(now + 60000).toISOString() };
  h.record = { ...clone(mirror.record), QtyOnHand: 9 }; delete h.record.IncomeAccountRef.name;
  h.reader = createBusinessReferenceReader({ resolveClient: async () => h.client, authorize: async () => ({ actorId: 'actor' }), now: () => now, observationStore: { read: async () => clone(mirror) } });
  const observed = await h.reader(scope, 'Item', '100', { live: true });
  const binding = { ...bindBusinessReference({ scope, entity: 'Item', key: 'chosen', observed: mirror, now }), definition: referenceDefinition(scope, 'Item', mirror.record, 1) };
  assert.equal(observed.record.QtyOnHand, 9); assert.equal(observed.source.kind, 'qbo-full-entity-get');
  assert.equal(verifyBusinessReference({ scope, binding, observed, now }).QtyOnHand, 9); assert.equal(h.calls.length, 1);
  assert.equal(observed.definitionObservation, undefined, 'current full read does not load an old definition witness');
});

test('pre-send current reference retry is bounded and preserves exact provider faults', async () => {
  const h = setup(), options = [], original = clone(h.binding);
  const read = async (_s,_e,_i,opts) => { options.push(opts.live); return options.length === 1 ? { ...h.observed, observedAt: new Date(now-300001).toISOString() } : h.observed; };
  assert.equal(await readAndVerifyBusinessReference({read,scope,binding:h.binding,now:()=>now}),h.observed);
  assert.deepEqual(options,[false,true]); assert.deepEqual(h.binding,original);
  let calls=0; await assert.rejects(readAndVerifyBusinessReference({scope,binding:h.binding,now:()=>now,read:async()=>{calls++;return {...h.observed,observedAt:new Date(now-300001).toISOString()};}})); assert.equal(calls,2);
  const fault=Object.assign(new Error('Exact QBO fault'),{status:400,Fault:{Error:[{code:'2010',Message:'Exact QBO fault'}]}}); calls=0;
  await assert.rejects(readAndVerifyBusinessReference({scope,binding:h.binding,read:async()=>{calls++;throw fault;}}),e=>e===fault); assert.equal(calls,1);
});
test('invalid current mirror falls back once to exact scoped GET without old witness reads', async () => {
  const h = readerHarness(); let misses=0;
  const reader=createBusinessReferenceReader({resolveClient:async()=>h.client,authorize:async()=>({actorId:'actor'}),now:()=>now,observationStore:{read:async()=>{misses++;return observation('Item',{Active:false});},definition:async()=>{throw Error('historical witness must not be loaded');}}});
  assert.equal((await reader(scope,'Item','100')).source.kind,'qbo-full-entity-get'); assert.equal(misses,1); assert.equal(h.calls.length,1);
});

test('pre-send refresh never retries scope authority cancellation or deadline failures', async () => {
  const h=setup();
  for(const code of ['BUSINESS_REFERENCE_UNVERIFIED','BUSINESS_ACCESS_DENIED']){
    let calls=0;const error=Object.assign(new Error('reader denied'),{code});
    await assert.rejects(readAndVerifyBusinessReference({scope,binding:h.binding,read:async()=>{calls++;throw error;}}),e=>e===error);assert.equal(calls,1);
  }
  let calls=0,clock=now;await assert.rejects(readAndVerifyBusinessReference({scope,binding:h.binding,now:()=>clock,read:async()=>{calls++;clock+=60001;return h.observed;}}),/budget/);assert.equal(calls,1);
  calls=0;const stop=new AbortController();stop.abort();await assert.rejects(readAndVerifyBusinessReference({scope,binding:h.binding,signal:stop.signal,read:async()=>{calls++;return h.observed;}}),/cancelled/);assert.equal(calls,0);
});

test('current-reference drift still passes through real compiler accounting-purpose checks', () => {
  const {fixture}=require('./helpers/business-transaction-fixtures');
  const baseline=fixture('Estimate'); assert.doesNotThrow(baseline.compile);
  for(const [entity,change] of [
    ['Customer',r=>{r.CurrencyRef={value:'USD'};}], ['Customer',r=>{r.IsProject=true;}],
    ['Item',r=>{r.Type='NonInventory';}], ['Item',r=>{r.IncomeAccountRef={value:'999'};}],
    ['Account',r=>{r.AccountType='Expense';}]
  ]){
    const f=fixture('Estimate'), value=f.referenceEvidence.find(r=>r.entity===entity&&(entity!=='Account'||r.record.Id==='604')); change(value.record);f.refresh();assert.throws(f.compile,undefined,entity);
  }
  const f=fixture('Estimate');const item=f.referenceEvidence.find(r=>r.entity==='Item');item.record.UnitPrice=99999;item.record.UnknownDefault={active:true};f.refresh();
  assert.deepEqual(JSON.parse(f.compile().request.body).Line,JSON.parse(baseline.compile().request.body).Line,'explicit sale economics survive catalog-price drift');
});
test('TaxRate current reader supports one forced refresh for dated-tax consumers and preserves faults', async () => {
  const {QBOClient}=require('../src/modules/qbo-client'),{readBusinessTaxRecord}=require('../src/modules/business-observation-store');
  const client=Object.create(QBOClient.prototype); Object.defineProperty(client,'apiBase',{value:'https://sandbox-quickbooks.api.intuit.com/v3/company/123'});
  client.realmId=scope.realmId; client.connection={_id:scope.connectionId,realmId:scope.realmId,status:'active'};
  let cached=0;const record={Id:'1',SyncToken:'0',Active:true,RateValue:13};const store={read:async()=>{cached++;return {record};}};
  assert.deepEqual(await readBusinessTaxRecord(client,'TaxRate','1',{store}),{TaxRate:record});assert.equal(cached,1);
  const reader=readerHarness();reader.body={TaxRate:record};
  const full=createBusinessReferenceReader({resolveClient:async()=>reader.client,authorize:async()=>({actorId:'actor'}),now:()=>now,observationStore:{read:async()=>{throw Error('forced read must skip mirror');}}});
  assert.equal((await full(scope,'TaxRate','1',{live:true})).record.RateValue,13);
});

test('pre-send stalled readers reject cancellation without another read', async () => {
  const h=setup(), stop=new AbortController();let calls=0,ready,finish;
  const started=new Promise(resolve=>{ready=resolve;});
  const pending=readAndVerifyBusinessReference({scope,binding:h.binding,signal:stop.signal,read:()=>{calls++;ready();return new Promise(resolve=>{finish=resolve;});}});
  await started;stop.abort();await assert.rejects(pending,/cancelled/);assert.equal(calls,1);finish(h.observed);
});
