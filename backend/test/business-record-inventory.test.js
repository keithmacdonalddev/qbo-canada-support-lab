'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBusinessInventoryReader, validateInventoryObservation, inventorySummary, compactInventoryRecord, TYPES } = require('../src/modules/business-record-inventory');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, actorId = 'b'.repeat(24), ownerId = 'c'.repeat(24);
function harness() {
  const h = { clock: Date.parse('2026-10-06T12:00:00.000Z'), calls: [], authorityCalls: 0, rows: Object.fromEntries(TYPES.map(type => [type, []])) };
  h.rows.Customer = [{ Id: '1', SyncToken: '0', Active: false, DisplayName: 'Private fixture name', PrimaryEmailAddr: { Address: 'private@example.invalid' } }];
  h.rows.Invoice = [{ Id: '2', SyncToken: '1', TxnDate: '2026-09-01', TotalAmt: 50, Line: [{ Amount: 50, Description: 'private line description' }] }];
  h.client = Object.create(QBOClient.prototype);
  Object.assign(h.client, { connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
    assert.equal(options.method, 'GET'); const url = new URL(options.url);
    if (url.pathname.includes('/reports/')) return { status: 200, json: structuredClone(h.reports[url.pathname.split('/').at(-1)]) };
    const query = url.searchParams.get('query');
    const match = /^SELECT \* FROM (\w+)( WHERE Active IN \(true, false\))? ORDERBY Id ASC STARTPOSITION (\d+) MAXRESULTS 1000$/.exec(query); assert.ok(match, query);
    const type = match[1], start = Number(match[3]); h.calls.push({ type, start, query });
    if (h.onRead) await h.onRead({ type, start, query });
    const rows = structuredClone(h.rows[type].slice(start - 1, start + 999));
    let body = { QueryResponse: { [type]: rows, startPosition: start, maxResults: rows.length, totalCount: rows.length } }; // QuickBooks counts each page
    if (h.response) body = h.response(body, { type, start });
    return { status: 200, json: body };
  } } });
  h.access = { authorize: async (requested, action) => { assert.deepEqual(requested, scope); assert.equal(action, 'baseline.capture'); h.authorityCalls++; if (h.revoked) throw new Error('permission revoked'); return { actorId, ownerId: h.changedOwner ? actorId : ownerId }; }, resolveClient: async () => h.client };
  h.read = options => createBusinessInventoryReader({ access: h.access, now: () => h.clock, ...h.readerOptions })(scope, options);
  return h;
}
test('both complete scans agree and retained data excludes names, addresses and accounting lines', async () => {
  const h = harness(), source = await h.read(), summary = inventorySummary(source, scope);
  assert.equal(h.calls.length, TYPES.length * 2); assert.deepEqual(new Set(h.calls.slice(0, TYPES.length).map(row => row.type)), new Set(TYPES));
  assert.equal(source.records.Invoice[0].contentHash, hash(h.rows.Invoice[0])); assert.equal(summary.count, 2); assert.equal(summary.atomic, false); assert.equal(summary.ownership, 'unverified');
  assert.equal(summary.entities.find(row => row.entity === 'Customer').inactive, 1); assert.equal(summary.entities.find(row => row.entity === 'Invoice').earliestDate, '2026-09-01');
  assert.equal(summary.records, undefined); assert.equal(JSON.stringify(source).includes('private'), false); assert.equal(source.records.Customer[0].active, false);
  assert.ok(h.calls.filter(row => ['Customer','Vendor','Item','Account'].includes(row.type)).every(row => row.query.includes('Active IN (true, false)')));
  assert.ok(h.calls.filter(row => !['Customer','Vendor','Item','Account'].includes(row.type)).every(row => !row.query.includes('WHERE')));
});
test('exact full pages require an exhausting empty page in each pass', async () => {
  const h = harness(); h.rows.Customer = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i + 1), SyncToken: '0', Active: true }));
  const result = await h.read(); assert.equal(result.records.Customer.length, 1000); assert.deepEqual(h.calls.filter(row => row.type === 'Customer').map(row => row.start), [1, 1001, 1, 1001]);
});
test('same-count edits, changed versions, dates, active states and identity replacement invalidate observation', async () => {
  for (const mutate of [h => { h.rows.Invoice[0].TotalAmt = 51; }, h => { h.rows.Invoice[0].SyncToken = '2'; }, h => { h.rows.Invoice[0].TxnDate = '2026-09-02'; }, h => { h.rows.Customer[0].Active = true; }, h => { h.rows.Invoice[0].Id = '3'; }]) {
    const h = harness(); h.onRead = async () => { if (h.calls.length === TYPES.length + 1) mutate(h); }; await assert.rejects(h.read(), /changed between inventory/);
  }
});
test('bad envelopes, warnings, wrong pages, sparse and missing fields cannot be silently treated as empty', async () => {
  for (const response of [() => ({}), () => ({ QueryResponse: null }), b => ({ ...b, warnings: [] }), b => ({ QueryResponse: { ...b.QueryResponse, Warnings: [] } }), b => ({ QueryResponse: { ...b.QueryResponse, startPosition: 2 } }), b => ({ QueryResponse: { ...b.QueryResponse, maxResults: 99 } }), () => ({ QueryResponse: { Customer: null } }), () => ({ QueryResponse: { Customer: [{ Id: '1', SyncToken: '0', sparse: true, Active: true }], startPosition: 1 } }), () => ({ QueryResponse: { Customer: [{ Id: '1', Active: true }], startPosition: 1 } }), () => ({ QueryResponse: { Customer: [], totalCount: 1 } })]) {
    const h = harness(); h.response = (body, info) => info.type === 'Customer' ? response(body) : body; await assert.rejects(h.read());
  }
});
test('repeated page identities and record/response size limits fail closed', async () => {
  const repeated = harness(); repeated.rows.Customer.push(structuredClone(repeated.rows.Customer[0])); await assert.rejects(repeated.read(), /repeated/);
  const large = harness(); large.rows.Invoice[0].PrivateNote = 'x'.repeat(1000001); await assert.rejects(large.read(), /budget/);
  const page = harness(); page.rows.Invoice = Array.from({ length: 10 }, (_, i) => ({ Id: String(i + 1), SyncToken: '0', TxnDate: '2026-09-01', Note: 'x'.repeat(900000) })); await assert.rejects(page.read(), /budget/);
});
test('wrong scope or substituted client methods never dispatch queries', async () => {
  for (const mutate of [h => { h.client.connection.realmId = '456'; }, h => { h.client.connection.userId = actorId; }, h => { h.client.query = async () => ({}); }, h => { h.client.connection.status = 'revoked'; }]) {
    const h = harness(); mutate(h); await assert.rejects(h.read(), /client/); assert.equal(h.calls.length, 0);
  }
});
test('per-page revocation and owner changes stop subsequent dispatch', async () => {
  for (const key of ['revoked', 'changedOwner']) { const h = harness(); h.onRead = async () => { h[key] = true; }; await assert.rejects(h.read(), /revoked|authority/); assert.ok(h.calls.length <= 2); }
});
test('cancellation bounds a hung read and prevents later pages; late results are discarded', async () => {
  const h = harness(), stop = new AbortController(); stop.abort(); await assert.rejects(h.read({ signal: stop.signal }), /cancelled/); assert.equal(h.calls.length, 0);
  const blocked = harness(), controller = new AbortController(); blocked.onRead = () => { controller.abort(); return new Promise(() => {}); }; await assert.rejects(blocked.read({ signal: controller.signal }), /cancelled/); assert.ok(blocked.calls.length <= 2);
  const late = harness(); late.onRead = async () => { late.clock += 180001; }; await assert.rejects(late.read(), /three minutes/);
});
test('retained manifest integrity, complete type coverage and scan intervals are revalidated', async () => {
  const source = await harness().read();
  for (const mutate of [s => { delete s.records.Transfer; }, s => { s.records.Customer[0].active = true; }, s => { s.scans[1].count++; }, s => { s.scans[1].startedAt = '2026-10-05T12:00:00.000Z'; }, s => { s.scope.realmId = '456'; }, s => { s.coverage.pop(); }]) {
    const changed = structuredClone(source); mutate(changed); const { sourceHash, ...raw } = changed; changed.sourceHash = hash(raw); assert.throws(() => validateInventoryObservation(changed, scope));
  }
});
module.exports = { harness };


test('default baseline service composes both actual readers and retains their original matching evidence', async () => {
  const { fixture, ownerId, actorId } = require('./helpers/business-baseline-fixture');
  const { createBusinessBaselineService } = require('../src/modules/business-baseline-service');
  const base = fixture(), h = harness(); h.reports = require('./helpers/business-report-fixtures').fixture({ critical: true });
  h.reports.TrialBalance.Rows.Row[0].ColData[0].id = '1'; h.reports.TrialBalance.Rows.Row[1].ColData[0].id = '2';
  h.rows.Account = base.source.accounts.map(row => ({ ...row, Active: true }));
  const { readReports, readInventory, ...dependencies } = base.deps;
  const service = createBusinessBaselineService({ ...dependencies, models: base.models,
    resolveContext: async () => ({ environment: scope.environment, connection: { connected: true, ...scope } }), accessFor: () => h.access });
  const result = await service.capture({ id: ownerId, actorId }, base.input);
  assert.equal(result.inventory.status, 'matching-scans'); assert.equal(result.inventory.count, 4); assert.equal(result.evaluation.status, 'checks-passed');
  assert.equal(base.data.Baselines.length, 1); assert.equal(base.data.Audits.length, 1); assert.equal(result.accepted, false);
  assert.equal(base.data.Baselines[0].inventorySources.version, 2); assert.equal(result.inventory.version, 2); assert.equal(base.data.Audits[0].afterState.inventoryVersion, 2);
  assert.deepEqual(base.data.Baselines[0].inventorySources.records.Account.map(row => row.contentHash), h.rows.Account.map(hash));
});

function linkedBill(){return{Id:'900',SyncToken:'1',TxnDate:'2026-09-01',TotalAmt:30,LinkedTxn:[{TxnId:'902',TxnType:'BillPayment',TxnLineId:'2'},{TxnId:'901',TxnType:'PurchaseOrder',TxnLineId:'1'}],Line:[{Id:'1',Amount:10},{Id:'2',Amount:20}]};}
test('v2 accepts only reordered complete Bill-level link members and leaves original v1 bytes and source objects unchanged',async()=>{
 const raw=linkedBill(),before=structuredClone(raw),reversed={...raw,LinkedTxn:[...raw.LinkedTxn].reverse()};assert.equal(compactInventoryRecord('Bill',raw).contentHash,hash(raw));assert.notEqual(compactInventoryRecord('Bill',raw).contentHash,compactInventoryRecord('Bill',reversed).contentHash);assert.equal(compactInventoryRecord('Bill',raw,2).contentHash,compactInventoryRecord('Bill',reversed,2).contentHash);assert.deepEqual(raw,before);assert.notEqual(compactInventoryRecord('Invoice',raw,2).contentHash,compactInventoryRecord('Invoice',reversed,2).contentHash);
 for(const version of [1,2]){const h=harness();h.readerOptions={version};h.rows.Bill=[linkedBill()];h.onRead=async()=>{if(h.calls.length===TYPES.length+1)h.rows.Bill[0].LinkedTxn.reverse();};if(version===1)await assert.rejects(h.read(),/changed between inventory/);else{const observed=await h.read();assert.equal(observed.version,2);assert.equal(inventorySummary(observed,scope).version,2);assert.equal(validateInventoryObservation(observed,scope).count,3);}}
});
test('v2 still refuses changed link values, types, multiplicity, absent fields, line order and versions',async()=>{
 for(const mutate of [r=>r.LinkedTxn[0].TxnId='999',r=>r.LinkedTxn[0].TxnId=902,r=>r.LinkedTxn.push({...r.LinkedTxn[0]}),r=>delete r.LinkedTxn[0].TxnLineId,r=>r.LinkedTxn[0].Additional='changed',r=>r.Line.reverse(),r=>r.SyncToken='2']){const h=harness();h.readerOptions={version:2};h.rows.Bill=[linkedBill()];h.onRead=async()=>{if(h.calls.length===TYPES.length+1)mutate(h.rows.Bill[0]);};await assert.rejects(h.read(),/changed between inventory/);}
});
test('inventory version and policy are paired; unsupported or relabelled observations cannot pass',async()=>{
 const h=harness();h.readerOptions={version:2};const observed=await h.read(),old=await harness().read();for(const [version,policy]of [[1,observed.policy],[2,old.policy],[3,observed.policy]]){const changed={...observed,version,policy};const{sourceHash,...body}=changed;changed.sourceHash=hash(body);assert.throws(()=>validateInventoryObservation(changed,scope));}assert.throws(()=>createBusinessInventoryReader({access:h.access,version:'2'}),/version/);
});
