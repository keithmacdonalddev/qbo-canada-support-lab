'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBusinessInventoryReviewReader } = require('../src/modules/business-inventory-review');
const { compactInventoryRecord } = require('../src/modules/business-record-inventory');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, actorId = 'b'.repeat(24), ownerId = 'c'.repeat(24);
function harness(entity = 'Invoice') {
  const h = { clock: Date.parse('2026-10-06T12:00:00.000Z'), calls: [], originCalls: 0, row: entity === 'Customer' ? { Id: '20', SyncToken: '1', Active: false, DisplayName: 'Fixture' } : { Id: '20', SyncToken: '1', TxnDate: '2026-10-01', TotalAmt: 200 } };
  h.evidence = { baselineId: 'd'.repeat(24), scope, entity, evidenceHash: hash('baseline'), inventoryHash: hash('inventory'), observedAt: '2026-10-05T12:00:00.000Z', record: compactInventoryRecord(entity, h.row) };
  h.client = Object.create(QBOClient.prototype);
  Object.assign(h.client, { connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
    assert.equal(options.method, 'GET'); const query = new URL(options.url).searchParams.get('query'); h.calls.push(query); if (h.onRead) await h.onRead();
    if (h.status) return { status: h.status, json: { Fault: { Error: [{ Message: 'Simulated QBO failure' }] } } };
    return { status: 200, json: h.response || { QueryResponse: { [entity]: h.absent ? [] : [h.row], startPosition: 1, maxResults: h.absent ? 0 : 1 } } };
  } } });
  h.access = { authorize: async (requested, action) => { assert.deepEqual(requested, scope); assert.equal(action, 'baseline.review'); if (h.revoked) throw Object.assign(new Error('permission revoked'), { code: 'BUSINESS_ACCESS_DENIED', status: 403 }); return { actorId, ownerId }; }, resolveClient: async () => h.client };
  h.readOrigin = async input => { h.originCalls++; assert.equal(input.userId, ownerId); if (h.onOrigin) await h.onOrigin(); if (h.originError) throw new Error('private db failure'); return h.origin || { entity, id: '20', sources: [], complete: true, status: 'unknown', baseline: 'unclassified' }; };
  h.review = options => createBusinessInventoryReviewReader({ access: h.access, readOrigin: h.readOrigin, now: () => h.clock })(h.evidence, options);
  return h;
}
test('comparison uses the original query representation and exposes compact evidence without adoption', async () => {
  const h = harness(), result = await h.review(); assert.equal(result.comparison, 'matches'); assert.equal(result.captured.contentHash, undefined); assert.equal(result.current.contentHash, undefined); assert.equal(result.current.TotalAmt, undefined); assert.equal(result.writeAllowed, false); assert.equal(result.ownership, 'unclassified');
  assert.equal(result.captured.observedAt, h.evidence.observedAt); assert.equal(result.current.observedAt, new Date(h.clock).toISOString()); assert.equal(result.origin.status, 'unknown');
  assert.deepEqual(h.calls, ["SELECT * FROM Invoice WHERE Id = '20' MAXRESULTS 2"]);
});
test('inactive records are explicitly included and remain inactive in comparison', async () => { const h = harness('Customer'), result = await h.review(); assert.equal(result.comparison, 'matches'); assert.equal(result.current.active, false); assert.match(h.calls[0], /Active IN \(true, false\)/); });
test('version differences, content differences and empty query results remain distinct', async () => {
  const version = harness(); version.row.SyncToken = '2'; assert.equal((await version.review()).comparison, 'different-version');
  const content = harness(); content.row.TotalAmt++; assert.equal((await content.review()).comparison, 'different-content');
  const absent = harness(); absent.absent = true; const result = await absent.review(); assert.equal(result.comparison, 'not-returned'); assert.equal(result.current, null); assert.equal(result.ownership, 'unclassified');
});
test('ambiguous, partial, wrong-record and warning responses do not become comparisons', async () => {
  for (const response of [{ QueryResponse: { Invoice: null } }, { QueryResponse: { Invoice: [{ Id: '99', SyncToken: '1', TxnDate: '2026-10-01' }], startPosition: 1 } }, { QueryResponse: { Invoice: [], totalCount: 1 } }, { QueryResponse: {}, Warning: [] }, { QueryResponse: { Warnings: [] } }, { QueryResponse: { Invoice: [{ Id: '20', SyncToken: '1', TxnDate: '2026-10-01', sparse: true }], startPosition: 1 } }]) { const h = harness(); h.response = response; await assert.rejects(h.review()); assert.equal(h.originCalls, 0); }
});
test('origin failure or mismatched evidence is explicit and cannot erase a valid current read', async () => {
  const h = harness(); h.originError = true; const result = await h.review(); assert.equal(result.comparison, 'matches'); assert.equal(result.origin.complete, false); assert.equal(result.origin.status, 'unavailable'); assert.equal(JSON.stringify(result).includes('private db'), false);
  const other = harness(); other.origin = { entity: 'Bill', id: '20', sources: [], complete: true, status: 'unknown' }; assert.equal((await other.review()).origin.status, 'unavailable');
});
test('scope and transport substitution fail before provider reads', async () => { for (const mutate of [h => { h.client.connection.userId = actorId; }, h => { h.client.connection.realmId = '456'; }, h => { h.client.query = async () => ({}); }]) { const h = harness(); mutate(h); await assert.rejects(h.review(), /client/); assert.equal(h.calls.length, 0); } });
test('revocation after QBO or creation history discards the result', async () => {
  for (const hook of ['onRead', 'onOrigin']) { const h = harness(); h[hook] = async () => { h.revoked = true; }; await assert.rejects(h.review(), /revoked/); }
});
test('aborted or late comparisons return no record and start no later reads', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(); await assert.rejects(h.review({ signal: controller.signal }), /cancelled/); assert.equal(h.calls.length, 0);
  const late = harness(); late.onRead = async () => { late.clock += 60001; }; await assert.rejects(late.review(), /one minute/); assert.equal(late.originCalls, 0);
  const hung = harness(), stop = new AbortController(); hung.onOrigin = () => { stop.abort(); return new Promise(() => {}); }; await assert.rejects(hung.review({ signal: stop.signal }), /cancelled/);
});

test('service resolves only audited captured records before using the default live reader', async () => {
  const base = require('./helpers/business-baseline-fixture').fixture(), h = harness();
  const { createBusinessBaselineService } = require('../src/modules/business-baseline-service');
  const service = createBusinessBaselineService({ ...base.deps, models: base.models,
    resolveContext: async () => ({ environment: scope.environment, connection: { connected: true, ...scope } }),
    accessFor: () => ({ ...base.access, resolveClient: async () => h.client }), readOrigin: h.readOrigin });
  const user = { id: ownerId, actorId }, saved = await service.capture(user, base.input);
  await assert.rejects(service.review(user, saved.id, 'Invoice', '999'), /not in the captured/); assert.equal(h.calls.length, 0);
  const page = await service.inventory(user, saved.id, { entity: 'Invoice' }); assert.equal(page.records[0].id, '20'); assert.equal(page.records[0].contentHash, undefined);
  const result = await service.review(user, saved.id, 'Invoice', '20'); assert.equal(result.comparison, 'different-content'); assert.equal(h.calls.length, 1); assert.equal(result.entity, 'Invoice'); assert.equal(result.baselineId, saved.id);
  base.data.Audits = []; await assert.rejects(service.review(user, saved.id, 'Invoice', '20'), /audit/); assert.equal(h.calls.length, 1);
});
