'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessVerificationRuntime } = require('../src/modules/business-verification-runtime');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const { sample, ENTITIES, scope, now, clone } = require('./helpers/business-readback-fixtures');
const config = require('../src/config');
const previousEnvironment = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; });
test.after(() => { config.qbo.environment = previousEnvironment; });
const operationId = 'b'.repeat(24), ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24), planHash = hash('approved operation');
function harness(entity = 'Estimate') {
  const sampleValue = sample(entity), compiled = sampleValue.compiled;
  const h = { sample: sampleValue, allowed: true, calls: [], clock: now, actor: { actorId, ownerId }, loaded: [], snapshots: [] };
  h.intent = { version: 1, scope, operationId, planHash, logicalKey: compiled.logicalKey, entity, fingerprint: compiled.intentHash, ...clone(sampleValue.intent) };
  if (sampleValue.taxPolicy) h.intent.policy.readbackTax = { version: 1, totalTaxCents: sampleValue.taxPolicy.totalTaxCents, lines: clone(sampleValue.taxPolicy.lines) };
  h.row = { operationId, planHash, fingerprint: compiled.intentHash, entity, state: 'saved', dispatch: { compilationHash: compiled.compilationHash, requestHash: compiled.request.requestHash } };
  h.Steps = { findOne(filter) { assert.deepEqual(filter, { ...scope, logicalKey: compiled.logicalKey }); const query = { select() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.row) }; return query; } };
  h.client = Object.create(QBOClient.prototype);
  Object.assign(h.client, { connection: { _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => { h.calls.push(options); if (h.onRead) await h.onRead(); return { status: 200, json: h.body || { [entity]: clone(h.sample.observed.record) } }; } } });
  h.authorize = async (_scope, action, options) => { assert.deepEqual(_scope, scope); assert.equal(action, 'operations.read'); if (!h.allowed) throw new Error('permission revoked'); if (h.onAuthorize) await h.onAuthorize(options); return clone(h.actor); };
  h.deps = { scope, operationId, planHash, Steps: h.Steps, transaction: async work => work({ inTransaction: () => true }), assertReady: async () => {}, access: { authorize: h.authorize, resolveClient: async () => h.client }, writerFence: { graphSnapshot: async input => { assert.ok(input.session); h.snapshots.push(input); return { scope, operationId, revision: 4 }; } }, plans: { loadIntent: async (_scope, op, key) => { assert.deepEqual(_scope, scope); h.loaded.push({ op, key }); return clone(h.intent); } }, now: () => h.clock };
  h.runtime = () => createBusinessVerificationRuntime(h.deps);
  return h;
}
for (const entity of ENTITIES) test('reads exact full ' + entity + ' through the original QBO client', async () => {
  const h = harness(entity), observed = await h.runtime().readRecord(scope, entity, h.sample.observed.record.Id);
  assert.equal(observed.recordHash, hash(observed.record)); assert.equal(observed.source.kind, 'qbo-full-entity-get');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'GET'); assert.equal(h.calls[0].url, 'https://sandbox-quickbooks.api.intuit.com/v3/company/123/' + entity.toLowerCase() + '/2000');
  assert.notEqual(observed.record, h.sample.observed.record);
});
test('transaction reads reject unsupported or arbitrary endpoints before network access', async () => {
  const h = harness();
  for (const [entity, id] of [['Account', '1'], ['invoice/1', '2'], ['Invoice', '../1'], ['Invoice', 1]]) await assert.rejects(h.runtime().readRecord(scope, entity, id));
  assert.equal(h.calls.length, 0);
});
test('transaction read rejects sparse, incorrect, malformed and oversized entity envelopes', async () => {
  for (const change of [
    h => { h.body = { Estimate: { ...h.sample.observed.record, sparse: true } }; },
    h => { h.body = { Estimate: { ...h.sample.observed.record, SyncToken: '01' } }; },
    h => { h.body = { Estimate: { ...h.sample.observed.record, Id: '9000' } }; },
    h => { h.body = { Estimate: h.sample.observed.record, QueryResponse: {} }; },
    h => { h.body = { Estimate: { ...h.sample.observed.record, Description: 'x'.repeat(256001) } }; },
    h => { h.body = { Estimate: { ...h.sample.observed.record, status: 'Deleted' } }; },
  ]) { const h = harness(); change(h); await assert.rejects(h.runtime().readRecord(scope, 'Estimate', '2000')); }
});
test('read rechecks actor, owner, scope, permission and elapsed time after the provider reply', async () => {
  for (const change of [h => { h.allowed = false; }, h => { h.actor.actorId = 'e'.repeat(24); }, h => { h.actor.ownerId = 'e'.repeat(24); }, h => { h.client.connection.status = 'revoked'; }, h => { h.clock += 60001; }]) {
    const h = harness(); h.onRead = () => change(h); await assert.rejects(h.runtime().readRecord(scope, 'Estimate', '2000'));
  }
});
test('read refuses substituted clients, wrong owners and already cancelled requests', async () => {
  for (const change of [h => { h.client = { ...h.client, read: async () => ({}) }; }, h => { h.client.connection.userId = 'e'.repeat(24); }, h => { h.client.apiCall = async () => ({}); }]) {
    const h = harness(); change(h); await assert.rejects(h.runtime().readRecord(scope, 'Estimate', '2000')); assert.equal(h.calls.length, 0);
  }
  const h = harness(), abort = new AbortController(); abort.abort();
  await assert.rejects(h.runtime().readRecord(scope, 'Estimate', '2000', { signal: abort.signal })); assert.equal(h.calls.length, 0);
});
test('cancellation releases the awaiting reader and never accepts a late provider result', async () => {
  const h = harness(), abort = new AbortController(); let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  h.onRead = () => new Promise(resolve => { finish = resolve; started(); });
  const pending = h.runtime().readRecord(scope, 'Estimate', '2000', { signal: abort.signal }); await began; abort.abort(); await assert.rejects(pending, /cancelled/); finish();
});
test('tax evidence is bound to the original immutable policy and exact compilation', async () => {
  const h = harness(), runtime = h.runtime(), tax = await runtime.loadTaxPolicy(scope, h.sample.compiled);
  assert.equal(tax.compilationHash, h.sample.compiled.compilationHash); assert.equal(tax.status, 'approved'); assert.equal(tax.totalTaxCents, 3250); assert.match(tax.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.loaded, [{ op: operationId, key: h.sample.compiled.logicalKey }]);
  h.sample.observed.record.TxnTaxDetail.TotalTax = 999; assert.deepEqual(await runtime.loadTaxPolicy(scope, h.sample.compiled), tax);
});
test('historical step loads its original plan rather than the current operation policy', async () => {
  const h = harness(); h.row.operationId = 'e'.repeat(24); h.intent.operationId = h.row.operationId; h.row.planHash = h.intent.planHash = hash('historical plan');
  await h.runtime().loadTaxPolicy(scope, h.sample.compiled); assert.equal(h.loaded[0].op, h.row.operationId);
});
test('missing approved tax stays unavailable; settlement and time need no tax expectation', async () => {
  const h = harness(); delete h.intent.policy.readbackTax;
  assert.equal(await h.runtime().loadTaxPolicy(scope, h.sample.compiled), null);
  for (const entity of ['Payment', 'Deposit', 'BillPayment', 'TimeActivity']) { const value = harness(entity); assert.equal(await value.runtime().loadTaxPolicy(scope, value.sample.compiled), null); }
});
test('changed intent, dispatch, scope or invalid tax policy cannot be verified', async () => {
  for (const change of [
    h => { h.row.state = 'unknown'; }, h => { h.row.dispatch.requestHash = hash('other'); }, h => { h.intent.policy.status = 'proposed'; }, h => { h.intent.step.details.lines[0].quantity += 1; },
    h => { h.intent.scope = { ...scope, realmId: '456' }; }, h => { h.intent.planHash = hash('other'); }, h => { h.intent.policy.readbackTax.totalTaxCents += 1; },
    h => { h.intent.policy.readbackTax.lines[0].percent = -1; }, h => { h.intent.policy.tax.salesTax = '999'; }, h => { h.intent.policy.readbackTax = null; },
  ]) { const h = harness(); change(h); await assert.rejects(h.runtime().loadTaxPolicy(scope, h.sample.compiled)); assert.equal(h.calls.length, 0); }
});
test('writer reads use transaction, current actor and the bound exact operation', async () => {
  const h = harness(), runtime = h.runtime(), fence = await runtime.readFence(scope);
  assert.equal(fence.unresolved, null); assert.equal(fence.revision, 4); assert.deepEqual(h.snapshots[0].intent, { operationId, planHash });
  await assert.rejects(runtime.readFence({ ...scope, realmId: '456' }));
  assert.throws(() => runtime.graphSnapshot({ scope, intent: { operationId: 'e'.repeat(24), planHash } }));
  assert.throws(() => runtime.loadGraphReadback({ scope: { ...scope, realmId: '456' }, roots: [h.sample.compiled.logicalKey] }));
});
