'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessVerificationRuntime } = require('../src/modules/business-verification-runtime');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const { reconcileBusinessGraph, createBusinessGraphReader, MAX_BYTES } = require('../src/modules/business-graph-readback');
const { sample, bindParent, scope, now, clone } = require('./helpers/business-readback-fixtures');
function saved(entity, id, configure) { const h = sample(entity, configure); h.observed.record.Id = id; h.receipt.qboId = id; h.refresh(); return h; }
function entry(h) {
  const c = h.compiled;
  return { intent: { version: 1, scope, operationId: 'b'.repeat(24), planHash: hash('operation plan'), logicalKey: c.logicalKey, entity: c.entity, fingerprint: c.intentHash, ...clone(h.intent), policy: { ...clone(h.intent.policy), ...(h.taxPolicy ? { readbackTax: { version: 1, totalTaxCents: h.taxPolicy.totalTaxCents, lines: clone(h.taxPolicy.lines) } } : {}) } }, step: { contractVersion: 1, ...scope, operationId: 'b'.repeat(24), planHash: hash('operation plan'), logicalKey: c.logicalKey, entity: c.entity, fingerprint: c.intentHash, state: 'saved', revision: 4, qboId: h.receipt.qboId,
    dependencies: c.relationships.map(link => ({ logicalKey: link.logicalKey, entity: link.entity, fingerprint: link.fingerprint })), compilation: clone(c), dispatch: { key: h.receipt.dispatchKey, requestHash: h.receipt.requestHash, compilationHash: c.compilationHash, evidenceHash: c.evidenceHash }, receipt: clone(h.receipt) }, observed: clone(h.observed), taxPolicy: clone(h.taxPolicy) };
}
function graph(kind = 'sales') {
  let activities;
  if (kind === 'sales') {
    const estimate = saved('Estimate', '5001'), time = saved('TimeActivity', '5002', f => bindParent(f, 0, estimate));
    const invoice = saved('Invoice', '5003', f => { bindParent(f, 0, estimate); bindParent(f, 1, time); });
    const payment = saved('Payment', '5004', f => bindParent(f, 0, invoice));
    const deposit = saved('Deposit', '5005', f => bindParent(f, 0, payment));
    estimate.observed.record.LinkedTxn = [{ TxnType: 'Invoice', TxnId: '5003' }];
    time.observed.record.BillableStatus = 'HasBeenBilled'; time.observed.record.LinkedTxn = [{ TxnType: 'Invoice', TxnId: '5003' }];
    invoice.observed.record.Balance = 0; invoice.observed.record.LinkedTxn.push({ TxnType: 'Payment', TxnId: '5004' });
    payment.observed.record.LinkedTxn = [{ TxnType: 'Deposit', TxnId: '5005' }];
    activities = [estimate, time, invoice, payment, deposit];
  } else {
    const po = saved('PurchaseOrder', '6001'), bill = saved('Bill', '6002', f => bindParent(f, 0, po));
    const sale = saved('SalesReceipt', '6003', f => bindParent(f, 0, bill)), payment = saved('BillPayment', '6004', f => bindParent(f, 0, bill));
    po.observed.record.Line[0].Received = 12; po.observed.record.POStatus = 'Closed'; po.observed.record.LinkedTxn = [{ TxnType: 'Bill', TxnId: '6002' }];
    bill.observed.record.Balance = 0; bill.observed.record.LinkedTxn.push({ TxnType: 'BillPayment', TxnId: '6004' });
    activities = [po, bill, sale, payment];
  }
  for (const h of activities) { h.observed.record.SyncToken = '1'; h.refresh(); }
  return { scope, roots: [activities[0].compiled.logicalKey], entries: activities.map(entry), now };
}
function harness(value = graph()) {
  const h = { value, clock: now, actor: { actorId: 'owner' }, writer: { scope, revision: 12, operationId: 'b'.repeat(24), unresolved: null }, reads: [], queryCount: 0, opened: 0, closed: 0, retained: [], active: 0, maxActive: 0 };
  h.models = { find(filter) {
    h.queryCount++; let session, maximum = Infinity;
    const query = { select() { return query; }, session(v) { session = v; return query; }, limit(v) { maximum = v; return query; }, maxTimeMS(v) { assert.equal(v, 10000); return query; }, lean() { return query; }, cursor(options) {
      assert.ok(session); assert.equal(options.batchSize, 1); h.opened++;
      const rows = value.entries.map(e => e.step).filter(row => row.environment === filter.environment && row.realmId === filter.realmId && (!filter.logicalKey || filter.logicalKey.$in.includes(row.logicalKey)) && (!filter['dependencies.logicalKey'] || row.dependencies.some(link => filter['dependencies.logicalKey'].$in.includes(link.logicalKey))) && (!filter.state || filter.state.$in.includes(row.state))).slice(0, maximum);
      let i = 0, closed = false;
      return { next: async () => { if (h.onNext) await h.onNext(); return closed ? null : clone(rows[i++] || null); }, close: async () => { if (!closed) { closed = true; h.closed++; } } };
    } }; return query;
  } };
  h.dependencies = { Steps: h.models, transaction: async work => work({ snapshot: true }), assertReady: async () => {}, authorize: async () => { if (h.onAuthorize) await h.onAuthorize(); return h.actor; }, readFence: async () => { if (h.onFence) await h.onFence(); return clone(h.writer); }, now: () => h.clock,
    readRecord: async (_scope, entity, qboId, options) => { assert.deepEqual(_scope, scope); h.reads.push(entity + ':' + qboId); h.active++; h.maxActive = Math.max(h.maxActive, h.active); try { if (h.onRead) await h.onRead(entity, qboId, options); return clone(value.entries.find(e => e.step.entity === entity && e.step.qboId === qboId).observed); } finally { h.active--; } },
    loadTaxPolicy: async (_scope, compiled) => clone(value.entries.find(e => e.step.logicalKey === compiled.logicalKey).taxPolicy) };
  h.reader = () => createBusinessGraphReader(h.dependencies)({ scope, roots: value.roots, signal: h.signal }); return h;
}
for (const kind of ['sales', 'purchase']) test('reconciles complete ' + kind + ' chain in two passes with exact current versions', () => {
  const h = graph(kind), result = reconcileBusinessGraph(h); assert.equal(result.complete, true, JSON.stringify(result.failures)); assert.equal(result.recordCount, h.entries.length); assert.equal(result.persisted, false);
  for (const record of result.records) { assert.equal(record.proof.kind, 'business-readback'); assert.equal(record.proof.syncToken, '1'); assert.equal(record.proof.matchesIntent, true); }
  const shuffled = { ...h, entries: [...h.entries].reverse() }; assert.equal(reconcileBusinessGraph(shuffled).evidenceHash, result.evidenceHash);
});
test('mismatched financial content prevents the affected graph from passing', () => {
  const h = graph(), invoice = h.entries.find(e => e.step.entity === 'Invoice'); invoice.observed.record.Balance = 1; invoice.observed.recordHash = hash(invoice.observed.record);
  const result = reconcileBusinessGraph(h); assert.equal(result.complete, false); assert.ok(result.failures.some(e => e.entity === 'Invoice' && e.issues.some(x => /balance/.test(x)))); assert.ok(result.records.every(r => r.proof === null));
});
test('unknown external transaction links cannot become managed descendants', () => {
  const h = graph(), invoice = h.entries.find(e => e.step.entity === 'Invoice'); invoice.observed.record.LinkedTxn.push({ TxnType: 'Payment', TxnId: '9999' }); invoice.observed.recordHash = hash(invoice.observed.record);
  const result = reconcileBusinessGraph(h); assert.equal(result.complete, false); assert.ok(result.failures.some(e => e.issues.includes('An unplanned transaction link is present.')));
});
test('missing sources, duplicate IDs, altered receipts and unapproved tax are not complete evidence', () => {
  for (const change of [h => { h.entries.shift(); }, h => { h.entries.push(clone(h.entries[0])); }, h => { h.entries[0].step.receipt.requestHash = hash('other'); }, h => { h.entries[0].step.connectionId = 'c'.repeat(24); }, h => { h.entries[0].step.state = 'unknown'; }]) { const h = graph(); change(h); assert.throws(() => reconcileBusinessGraph(h)); }
  const h = graph(); h.entries[2].taxPolicy = null; assert.equal(reconcileBusinessGraph(h).complete, false);
});
test('the root set must be valid and all supplied records related to a requested root', () => {
  const h = graph(); assert.throws(() => reconcileBusinessGraph({ ...h, roots: [] })); assert.throws(() => reconcileBusinessGraph({ ...h, roots: [h.roots[0], h.roots[0]] }));
  h.entries.push(...graph('purchase').entries); assert.throws(() => reconcileBusinessGraph(h), /Unrelated/);
  h.roots.push(graph('purchase').roots[0]); assert.equal(reconcileBusinessGraph(h).complete, true);
});
test('reader discovers the full connected chain in storage and uses no more than three read workers', async () => {
  const h = harness(); h.value.roots = [h.value.entries[2].step.logicalKey];
  h.onRead = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const result = await h.reader(); assert.equal(result.complete, true); assert.equal(h.reads.length, 5); assert.equal(new Set(h.reads).size, 5); assert.equal(h.maxActive, 3); assert.equal(h.active, 0); assert.equal(h.opened, h.closed); assert.ok(h.opened > 0); assert.equal(result.writerFence.revision, 12);
});
test('known unresolved children block before any provider read', async () => {
  const h = harness(); h.value.entries.at(-1).step.state = 'dispatched'; await assert.rejects(h.reader(), /unresolved/); assert.equal(h.reads.length, 0); assert.equal(h.opened, h.closed);
});
test('a foreign connection child is not silently omitted', async () => {
  const h = harness(); h.value.entries.at(-1).step.connectionId = 'c'.repeat(24); await assert.rejects(h.reader(), /unresolved/); assert.equal(h.reads.length, 0); assert.equal(h.opened, h.closed);
});
test('writer changes and revoked read authority discard the completed observations', async () => {
  const h = harness(); h.onRead = async () => { h.writer.revision = 13; }; await assert.rejects(h.reader(), /changed while/);
  const g = harness(); g.onRead = async () => { g.actor = null; }; await assert.rejects(g.reader(), /changed while/); assert.equal(g.active, 0);
});
test('cancellation during final fence cannot return a completed proof', async () => {
  const h = harness(), controller = new AbortController(); h.signal = controller.signal; let calls = 0;
  h.onFence = async () => { if (++calls === 2) controller.abort(); };
  await assert.rejects(h.reader(), error => error.code === 'BUSINESS_GRAPH_CANCELLED'); assert.equal(h.active, 0); assert.equal(h.opened, h.closed);
});
test('cancellation closes a storage cursor and does not start provider reads', async () => {
  const h = harness(), controller = new AbortController(); h.signal = controller.signal;
  h.onNext = async () => { controller.abort(); };
  await assert.rejects(h.reader(), error => error.code === 'BUSINESS_GRAPH_CANCELLED'); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.opened, h.closed); assert.equal(h.reads.length, 0);
});
test('read deadline aborts pending workers without producing proof', async () => {
  const h = harness(); h.onRead = async () => { h.clock += 180001; };
  await assert.rejects(h.reader(), error => error.code === 'BUSINESS_GRAPH_EXPIRED'); assert.equal(h.active, 0); assert.ok(h.reads.length <= 3);
});
test('one failed read cancels peers and prevents further queued requests', async () => {
  const h = harness(); let first = true;
  h.onRead = async (_entity, _id, { signal }) => { if (first) { first = false; throw new Error('provider unavailable'); } await new Promise((_, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); };
  await assert.rejects(h.reader(), /provider unavailable/); assert.equal(h.active, 0); assert.ok(h.reads.length <= 3);
});
test('oversized observations are rejected as they arrive instead of accumulating the whole graph', async () => {
  const h = harness(); h.dependencies.readRecord = async (_scope, entity, qboId) => { h.reads.push(qboId); return { ...clone(h.value.entries.find(e => e.step.entity === entity && e.step.qboId === qboId).observed), unrelated: 'x'.repeat(MAX_BYTES + 1) }; };
  await assert.rejects(h.reader(), /size budget/); assert.ok(h.reads.length <= 3);
});

test('preparation returns only bounded storage metadata without provider reads', async () => {
  const h = harness(), reader = createBusinessGraphReader(h.dependencies);
  const result = await reader({ scope, roots: h.value.roots, mode: 'prepare' });
  assert.equal(result.prepared, true); assert.equal(result.kind, 'business-graph-preparation'); assert.equal(result.recordCount, 5); assert.equal(h.reads.length, 0); assert.equal(h.opened, h.closed);
  assert.equal(result.evidenceHash, hash({ version: 1, scope, roots: result.roots, records: result.records, writerFence: result.writerFence }));
  for (const record of result.records) { assert.equal(Object.hasOwn(record, 'compilation'), false); assert.equal(Object.hasOwn(record, 'proof'), false); assert.equal(Object.hasOwn(record, 'observed'), false); }
});
test('expected writer snapshot must match before any graph provider reads', async () => {
  const h = harness(); await assert.rejects(createBusinessGraphReader(h.dependencies)({ scope, roots: h.value.roots, expectedWriterFence: { scope, revision: 11, operationId: h.writer.operationId } }), /changed before/); assert.equal(h.reads.length, 0);
});

for (const kind of ['sales', 'purchase']) test('concrete verification runtime reads complete ' + kind + ' chain from QBO client and original plans', async () => {
  const h = harness(graph(kind)), ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24);
  h.models.findOne = filter => { const query = { select() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.value.entries.find(entry => entry.step.logicalKey === filter.logicalKey && entry.step.connectionId === filter.connectionId)?.step || null) }; return query; };
  const client = Object.create(QBOClient.prototype), gets = [];
  Object.defineProperty(client, 'apiBase', { value: 'https://sandbox-quickbooks.api.intuit.com/v3/company/123' });
  Object.assign(client, { connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
    assert.equal(options.method, 'GET'); gets.push(options.url);
    const entry = h.value.entries.find(value => options.url.endsWith('/' + value.step.entity.toLowerCase() + '/' + value.step.qboId)); assert.ok(entry);
    return { status: 200, json: { [entry.step.entity]: clone(entry.observed.record) } };
  } } });
  const runtime = createBusinessVerificationRuntime({ scope, operationId: h.writer.operationId, planHash: hash('operation plan'), Steps: h.models, transaction: h.dependencies.transaction, assertReady: h.dependencies.assertReady, access: { authorize: async () => ({ actorId, ownerId }), resolveClient: async () => client }, writerFence: { graphSnapshot: async () => ({ scope, operationId: h.writer.operationId, revision: h.writer.revision }) }, plans: { loadIntent: async (_scope, op, key) => { assert.deepEqual(_scope, scope); assert.equal(op, h.writer.operationId); return clone(h.value.entries.find(entry => entry.step.logicalKey === key).intent); } }, now: () => h.clock });
  const result = await runtime.loadGraphReadback({ scope, roots: h.value.roots });
  assert.equal(result.complete, true); assert.equal(result.persisted, false); assert.equal(result.recordCount, h.value.entries.length); assert.equal(new Set(gets).size, h.value.entries.length); assert.equal(h.opened, h.closed);
  delete h.value.entries[0].intent.policy.readbackTax;
  const incomplete = await runtime.loadGraphReadback({ scope, roots: h.value.roots });
  assert.equal(incomplete.complete, false); assert.ok(incomplete.failures.some(value => value.issues.some(issue => /tax/.test(issue)))); assert.equal(h.opened, h.closed);
});
