'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessCompilationRuntime } = require('../src/modules/business-compilation-runtime');
const { compileBusinessTransaction } = require('../src/modules/business-transaction-compiler');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const { fixture, scope, now, clone } = require('./helpers/business-transaction-fixtures');
const operationId = 'b'.repeat(24), ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24), planHash = hash('plan');
const entities = ['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment'];
function harness(entity = 'Estimate') {
  const f = fixture(entity); f.refresh(); f.approve();
  if (['Estimate', 'Invoice', 'SalesReceipt', 'PurchaseOrder', 'Bill'].includes(entity)) {
    const base = f.step.details.baseAmountCents, tax = Math.round(base * 0.13);
    f.policy.readbackTax = { version: 1, totalTaxCents: tax, lines: [{ rateId: '950', percent: 13, taxableCents: base, amountCents: tax }] };
  }
  const h = { f, clock: now, calls: [], queries: [], graphCalls: 0, fenceCalls: 0, active: 0, maximum: 0, graphComplete: true, allowed: true, actor: { actorId, ownerId }, deposits: [] };
  h.intent = { version: 1, scope, operationId, planHash, logicalKey: f.step.logicalKey, entity, kind: 'create', fingerprint: hash(f.step), step: clone(f.step), policy: clone(f.policy), dependencies: clone(f.step.dependencies) };
  h.client = Object.create(QBOClient.prototype);
  Object.defineProperty(h.client, 'apiBase', { value: 'https://sandbox-quickbooks.api.intuit.com/v3/company/123' });
  Object.assign(h.client, { connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
    assert.equal(options.method, 'GET'); h.calls.push(options.url); h.active++; h.maximum = Math.max(h.maximum, h.active);
    try {
      if (h.onRead) await h.onRead(options);
      if (options.url.includes('/query?')) {
        const query = new URL(options.url).searchParams.get('query'); h.queries.push(query); if (h.queryBody) return { status: 200, json: await h.queryBody(query) };
        return { status: 200, json: { QueryResponse: { Deposit: clone(h.deposits), startPosition: 1, maxResults: h.deposits.length } } };
      }
      const value = [...f.referenceEvidence, ...f.parents].find(value => options.url.endsWith('/' + value.entity.toLowerCase() + '/' + value.record.Id)); assert.ok(value, options.url);
      return { status: 200, json: { [value.entity]: clone(value.record) } };
    } finally { h.active--; }
  } } });
  h.authorize = async () => { if (!h.allowed) throw new Error('permission revoked'); return clone(h.actor); };
  h.deps = { scope, operationId, planHash, access: { authorize: h.authorize, resolveClient: async () => h.client }, plans: { loadIntent: async () => clone(h.intent) }, steps: {
    verifyGraph: async (_scope, op, roots) => { assert.deepEqual(_scope, scope); assert.equal(op, operationId); assert.deepEqual(roots, h.intent.dependencies.map(value => value.logicalKey)); h.graphCalls++; return { complete: h.graphComplete, persisted: h.graphComplete }; },
    evidence: async (_scope, op, key) => { assert.deepEqual(_scope, scope); assert.equal(op, operationId); const parent = f.parents.find(value => value.logicalKey === key); return { state: 'verified', fresh: true, qboId: parent.qboId, fingerprint: parent.fingerprint, verification: { kind: 'business-readback', observedHash: h.parentHash || parent.recordHash, syncToken: parent.record.SyncToken, observedAt: new Date(now).toISOString() } }; },
  }, verification: {
    readFence: async () => { h.fenceCalls++; if (h.onFence) await h.onFence(); return { scope, operationId, revision: h.writerRevision || 4, unresolved: null }; },
    readRecord: async (_scope, type, id, options) => { const { createBusinessTransactionReader } = require('../src/modules/business-reference'); return createBusinessTransactionReader({ authorize: h.authorize, resolveClient: async () => h.client, now: () => h.clock })(_scope, type, id, options); },
  }, assertReady: async () => {}, now: () => h.clock };
  h.read = signal => createBusinessCompilationRuntime(h.deps)({ scope, operationId, logicalKey: h.intent.logicalKey, intent: clone(h.intent), signal });
  return h;
}
for (const entity of entities) test('loads current observations and preflights ' + entity, async () => {
  const h = harness(entity), values = await h.read(), compiled = compileBusinessTransaction({ scope, step: h.intent.step, policy: h.intent.policy, ...values, now });
  assert.equal(compiled.entity, entity); assert.equal(values.referenceEvidence.length, h.f.referenceEvidence.length); assert.equal(values.parents.length, h.f.parents.length); assert.equal(values.observationFence.writerRevision, 4); assert.ok(h.maximum <= 3);
  assert.equal(h.graphCalls, h.f.parents.length ? 1 : 0); assert.equal(h.queries.length, entity === 'Deposit' ? 2 : 0);
  if (entity === 'Deposit') assert.equal(values.parents[0].availability.status, 'available');
});
test('intent changes, unsupported disposition and company overrides fail before QBO reads', async () => {
  const h = harness(), reader = createBusinessCompilationRuntime(h.deps), base = { scope, operationId, logicalKey: h.intent.logicalKey, intent: clone(h.intent) };
  for (const value of [{ ...base, scope: { ...scope, realmId: '999' } }, { ...base, operationId: 'e'.repeat(24) }, { ...base, intent: { ...base.intent, fingerprint: hash('other') } }]) await assert.rejects(reader(value));
  h.intent.kind = 'existing'; await assert.rejects(h.read()); assert.equal(h.calls.length, 0);
});
test('incomplete dependency graphs stop observations and cannot be used as proof', async () => {
  const h = harness('Invoice'); h.graphComplete = false; await assert.rejects(h.read(), /not completely verified/); assert.equal(h.calls.length, 0);
});
test('changed originating records fail despite a current stored verified status', async () => {
  const h = harness('Invoice'); h.parentHash = hash('old observed content'); await assert.rejects(h.read(), /changed after graph/);
});
test('changed approved master definitions and absent tax expectations prevent compilation', async () => {
  const h = harness(); h.f.referenceEvidence.find(value => value.entity === 'Customer').record.DisplayName = 'Changed'; await assert.rejects(h.read(), /approved definition/);
  const tax = harness(); delete tax.intent.policy.readbackTax; await assert.rejects(tax.read(), /tax expectations/);
});
test('writer changes, authority loss and observation deadline stop before dispatch', async () => {
  const writer = harness(); writer.onFence = () => { if (writer.fenceCalls === 2) writer.writerRevision = 5; }; await assert.rejects(writer.read(), /Company activity changed/);
  const permission = harness(); permission.onRead = () => { permission.allowed = false; }; await assert.rejects(permission.read(), /permission revoked/);
  const elapsed = harness(); elapsed.onRead = () => { elapsed.clock += 180001; }; await assert.rejects(elapsed.read(), /budget/);
});
test('cancelled compilation launches no provider calls', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(); await assert.rejects(h.read(controller.signal), /cancelled/); assert.equal(h.calls.length, 0);
});
const deposit = (id, paymentId) => ({ Id: id, SyncToken: '0', Line: [{ Amount: 282.5, ...(paymentId ? { LinkedTxn: [{ TxnId: paymentId, TxnType: 'Payment' }] } : { DepositLineDetail: { AccountRef: { value: '600' } } }) }] });
test('a payment linked to any deposit is unavailable even when its own UI link is absent', async () => {
  const h = harness('Deposit'); h.deposits = [deposit('9000', h.f.parents[0].qboId)]; await assert.rejects(h.read(), /already belongs/); assert.equal(h.queries.length, 1);
});
test('deposit scans must be complete, non-sparse and unchanged across both observations', async () => {
  for (const body of [{}, { QueryResponse: { Warnings: { message: 'partial' } } }, { QueryResponse: { Deposit: [deposit('9000')], startPosition: 2, maxResults: 1 } }, { QueryResponse: { Deposit: [{ ...deposit('9000'), sparse: true }], startPosition: 1, maxResults: 1 } }, { QueryResponse: { Deposit: [deposit('9000'), deposit('9000')], startPosition: 1, maxResults: 2 } }, { QueryResponse: { Deposit: [], totalCount: 1 } }]) {
    const h = harness('Deposit'); h.queryBody = async () => body; await assert.rejects(h.read());
  }
  const h = harness('Deposit'); h.queryBody = async () => ({ QueryResponse: { Deposit: h.queries.length === 1 ? [] : [deposit('9000')], startPosition: 1, maxResults: h.queries.length === 1 ? 0 : 1 } }); await assert.rejects(h.read(), /changed during availability/);
});
test('deposit paging includes later pages and requires an identical complete second scan', async () => {
  const h = harness('Deposit'), firstPage = Array.from({ length: 1000 }, (_, index) => deposit(String(9000 + index)));
  h.queryBody = async query => { const start = Number(query.match(/STARTPOSITION (\d+)/)[1]), rows = start === 1 ? firstPage : [deposit('10000')]; return { QueryResponse: { Deposit: rows, startPosition: start, maxResults: rows.length, totalCount: 1001 } }; };
  const result = await h.read(); assert.equal(result.parents[0].availability.status, 'available'); assert.equal(h.queries.length, 4); assert.match(h.queries[1], /STARTPOSITION 1001/);
});
test('a changed payment after the deposit scan prevents availability proof', async () => {
  const h = harness('Deposit'); h.queryBody = async () => { if (h.queries.length === 2) h.f.parents[0].record.SyncToken = '1'; return { QueryResponse: {} }; };
  await assert.rejects(h.read(), /payment changed/);
});

test('malformed or unrecognized deposit lines cannot establish absence of payment links', async () => {
  for (const line of [null, {}, { Amount: 1 }, { Amount: 1, DetailType: 'AccountBasedExpenseLineDetail', DepositLineDetail: { AccountRef: { value: '600' } } }, { Amount: 1, LinkedTxn: [] }, { Amount: 1, LinkedTxn: [null] }, { Amount: 1, DepositLineDetail: { AccountRef: { value: 600 } } }, { Amount: 1, sparse: true, LinkedTxn: [{ TxnId: '9999', TxnType: 'Payment' }] }]) {
    const h = harness('Deposit'); h.deposits = [{ Id: '9000', SyncToken: '0', Line: [line] }]; await assert.rejects(h.read(), /deposit line|Deposit transaction links/);
  }
});
