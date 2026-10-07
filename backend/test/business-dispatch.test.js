'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessCompilationRuntime } = require('../src/modules/business-compilation-runtime');
const { createBusinessVerificationRuntime } = require('../src/modules/business-verification-runtime');
const { createBusinessRuntimeAccess } = require('../src/modules/business-runtime-access');
const { createBusinessDispatcher } = require('../src/modules/business-dispatch');
const { createBusinessDispatchReceiptReader } = require('../src/modules/business-dispatch-receipt');
const { createBusinessStepStore } = require('../src/modules/business-step-store');
const { createBusinessWriterFence } = require('../src/modules/business-writer-fence');
const { createQboWriteGate } = require('../src/modules/qbo-write-gate');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const { fixture, scope, now, clone } = require('./helpers/business-transaction-fixtures');
const config = require('../src/config');
const previousEnvironment = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; });
test.after(() => { config.qbo.environment = previousEnvironment; });
const operationId = 'b'.repeat(24), ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24);
const { harness } = require('./helpers/business-runtime-fixture');
test('compiler, step store, writer fence, QBO client, gate and receipt reader complete one exact dispatch', async () => {
  const h = harness(), result = await h.execute();
  assert.equal(result.state, 'verified'); assert.equal(result.complete, true); assert.equal(h.sent.length, 1); assert.equal(h.row().state, 'verified'); assert.equal(h.writer().unresolved, null);
  assert.equal(h.data.Receipts[0].state, 'saved'); assert.equal(h.data.Receipts[0].actorId, actorId); assert.equal(h.data.Audits.length, 2);
  assert.equal(h.sent[0].body, h.row().compilation.request.body); assert.equal(h.sent[0].url, 'https://sandbox-quickbooks.api.intuit.com/v3/company/123/estimate');
  await h.execute(); assert.equal(h.sent.length, 1); assert.equal(h.graphCalls, 2);
});
test('competing dispatchers cannot send the same activity twice', async () => {
  const h = harness(); const results = await Promise.allSettled([h.execute(), h.execute()]);
  assert.ok(results.some(value => value.status === 'fulfilled')); assert.equal(h.sent.length, 1); assert.equal(h.data.Receipts.length, 1);
});
test('lost dispatch acknowledgement never sends and later recovery never replays it', async () => {
  const h = harness(), begin = h.steps.beginDispatch;
  h.steps.beginDispatch = async (...args) => { await begin(...args); throw new Error('marker reply lost'); };
  await assert.rejects(h.execute(), /marker reply lost/); assert.equal(h.sent.length, 0); assert.equal(h.row().state, 'dispatched');
  const result = await h.execute(); assert.equal(result.state, 'recovery_required'); assert.equal(h.sent.length, 0);
});
test('lost response-storage acknowledgement recovers the saved receipt without repeating the POST', async () => {
  const h = harness(), complete = h.gate.complete;
  h.gate.complete = async (...args) => { await complete(...args); throw new Error('response receipt reply lost'); };
  const result = await h.execute(); assert.equal(result.state, 'verified'); assert.equal(h.sent.length, 1);
});
test('failed step settlement can resume from the transport receipt without creating again', async () => {
  const h = harness(); h.failRecovery = true;
  await assert.rejects(h.execute(), /receipt persistence/); assert.equal(h.sent.length, 1); assert.ok(h.writer().unresolved);
  h.failRecovery = false; assert.equal((await h.execute()).state, 'verified'); assert.equal(h.sent.length, 1);
});
test('unproven provider outcomes remain unresolved with no automatic resend', async () => {
  for (const response of [{ status: 429, json: {} }, { status: 200, json: { Estimate: { Id: '1000' } } }]) {
    const h = harness(); h.onSend = async () => response;
    assert.equal((await h.execute()).state, 'recovery_required'); assert.equal((await h.execute()).state, 'recovery_required'); assert.equal(h.sent.length, 1); assert.ok(h.writer().unresolved);
  }
});
test('explicit provider rejection remains rejected and does not become a new creation', async () => {
  const h = harness(); h.onSend = async () => ({ status: 400, json: { Fault: { type: 'ValidationFault', Error: [{ code: '6000' }] } } });
  assert.equal((await h.execute()).state, 'rejected'); assert.equal((await h.execute()).state, 'rejected'); assert.equal(h.sent.length, 1); assert.equal(h.writer().unresolved, null);
});
test('verification failure preserves the saved record and retry checks it without creating again', async () => {
  const h = harness(); h.failGraph = true; assert.equal((await h.execute()).state, 'unverified'); assert.equal(h.row().state, 'saved');
  h.failGraph = false; assert.equal((await h.execute()).state, 'verified'); assert.equal(h.sent.length, 1);
});
test('stop, changed client, readiness and missing create disposition block new requests', async () => {
  for (const mutate of [h => { h.data.Calendars[0].stopRequested = true; }, h => { h.client.connection.realmId = '999'; }, h => { h.notReady = true; }, h => { h.intent.kind = 'existing'; }, h => { delete h.intent.kind; }, h => { h.allowed = false; }]) {
    const h = harness(); mutate(h); await assert.rejects(h.execute()); assert.equal(h.sent.length, 0);
  }
});
test('cancellation before the marker prevents sending; cancellation after sending still settles the receipt', async () => {
  const before = harness(), c = new AbortController(); before.onObserve = async () => c.abort(); await assert.rejects(before.execute({ signal: c.signal }), /cancelled/); assert.equal(before.sent.length, 0); assert.equal(before.row().dispatch, null);
  const after = harness(), d = new AbortController(); after.onSend = async () => { d.abort(); return { status: 200, json: { Estimate: { Id: '1000', SyncToken: '0' } } }; };
  assert.equal((await after.execute({ signal: d.signal })).state, 'saved'); assert.equal(after.row().state, 'saved'); assert.equal(after.writer().unresolved, null); assert.equal(after.graphCalls, 0);
});
test('saved receipt requires original matching audits before it can release a writer', async () => {
  for (const mutate of [h => { h.data.Audits.pop(); }, h => { h.data.Audits[1].inputParams.environment = 'production'; }, h => { h.data.Receipts[0].observed.qboId = '999'; }, h => { h.data.Receipts[0].actorId = ownerId; }]) {
    const h = harness(); h.failRecovery = true; await assert.rejects(h.execute()); h.failRecovery = false; mutate(h);
    await assert.rejects(h.execute()); assert.equal(h.sent.length, 1); assert.ok(h.writer().unresolved);
  }
});

test('later linked activity cannot reuse a recent stored parent pass as current completion', async () => {
  const h = harness(); await h.execute();
  assert.equal((await h.store.evidence(scope, operationId, h.intent.logicalKey)).fresh, true);
  // Simulate a later child changing the company after this saved parent proof.
  // Evidence remains within five minutes, but the current graph no longer matches.
  h.writer().revision++; h.failGraph = true;
  const result = await h.execute();
  assert.equal(result.state, 'unverified'); assert.equal(result.complete, false);
  assert.equal(h.graphCalls, 2); assert.equal(h.sent.length, 1);
});

test('actual company membership rules authorize dispatch and a later suspension prevents continuation', async () => {
  const h = harness();
  const access = createBusinessRuntimeAccess({ actorId, ownerId, ...h.models, Memberships: h.models.Memberships, Users: h.models.Users, Connections: h.models.Connections, environment: () => 'sandbox', createClient: async () => h.client });
  h.deps.authorize = access.authorize;
  assert.equal((await h.execute()).state, 'verified'); assert.equal(h.sent.length, 1);
  h.data.Memberships[0].status = 'suspended';
  await assert.rejects(h.execute(), /membership/); assert.equal(h.sent.length, 1);
});

test('concrete compilation and verification runtimes persist dispatch proof and invalidate changed QBO content', async () => {
  const h = harness();
  h.intent.policy.readbackTax = { version: 1, totalTaxCents: 3250, lines: [{ rateId: '950', percent: 13, taxableCents: 25000, amountCents: 3250 }] };
  h.verification = createBusinessVerificationRuntime({ scope, operationId, planHash: h.intent.planHash, Steps: h.models.Steps, transaction: h.transaction, assertReady: h.assertReady, access: { authorize: h.authorize, resolveClient: async () => h.client }, writerFence: h.writerFence, plans: { loadIntent: h.loadIntent }, now: () => h.clock });
  h.steps.verifyGraph = h.store.verifyGraph;
  h.deps.loadCompilationEvidence = createBusinessCompilationRuntime({ scope, operationId, planHash: h.intent.planHash, access: { authorize: h.authorize, resolveClient: async () => h.client }, plans: { loadIntent: h.loadIntent }, steps: h.steps, verification: h.verification, assertReady: h.assertReady, now: () => h.clock });
  let record, posts = 0, gets = 0;
  h.onSend = async opts => {
    if (opts.method === 'POST') {
      posts++; record = { ...JSON.parse(opts.body), Id: '1000', SyncToken: '0', TotalAmt: 282.5, TxnStatus: 'Pending', TxnTaxDetail: { TotalTax: 32.5, TaxLine: [{ Amount: 32.5, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '950' }, PercentBased: true, TaxPercent: 13, NetAmountTaxable: 250 } }] } };
      record.Line.forEach((line, index) => { line.Id = String(index + 1); });
    } else {
      assert.equal(opts.method, 'GET');
      const reference = h.referenceRecords.find(value => opts.url.endsWith('/' + value.entity.toLowerCase() + '/' + value.record.Id));
      if (reference) return { status: 200, json: { [reference.entity]: clone(reference.record) } };
      assert.match(opts.url, /estimate\/1000$/); gets++;
    }
    return { status: 200, json: { Estimate: clone(record) } };
  };
  const result = await h.execute();
  assert.equal(result.complete, true); assert.equal(h.row().state, 'verified'); assert.ok(h.row().verification.graphEvidenceHash); assert.equal(posts, 1); assert.equal(gets, 1);
  record.Line[0].Amount = 251; record.TotalAmt = 283.5; record.SyncToken = '1';
  const changed = await h.execute();
  assert.equal(changed.complete, false); assert.equal(h.row().state, 'saved'); assert.equal(h.row().verification, null); assert.equal(posts, 1); assert.equal(gets, 2);
});

test('recovery-only dispatch cannot create or launch graph verification', async () => {
  const h = harness(); await assert.rejects(h.execute({ recoveryOnly: true }), /Recovery cannot create/); assert.equal(h.sent.length, 0);
  await h.execute(); const calls = h.graphCalls;
  const recovered = await h.execute({ recoveryOnly: true }); assert.equal(recovered.state, 'saved'); assert.equal(recovered.complete, false); assert.equal(h.sent.length, 1); assert.equal(h.graphCalls, calls);
});

test('dispatcher carries its run lease through claim, marker and provider admission', async () => {
  const h = harness(), leaseToken = 'current-run-worker-000001';
  h.data.Runs[0].leaseToken = leaseToken; h.data.Runs[0].leaseExpiresAt = new Date(h.clock + 600000);
  await assert.rejects(h.execute(), /worker lease/); assert.equal(h.data.Steps.length, 0); assert.equal(h.sent.length, 0);
  assert.equal((await h.execute({ leaseToken })).complete, true); assert.equal(h.sent.length, 1);
});
test('takeover during compilation leaves no dispatched marker or provider request', async () => {
  const h = harness(), leaseToken = 'old-run-worker-00000001';
  h.data.Runs[0].leaseToken = leaseToken; h.data.Runs[0].leaseExpiresAt = new Date(h.clock + 600000);
  h.onObserve = async () => { h.data.Runs[0].leaseToken = 'replacement-worker-000001'; };
  await assert.rejects(h.execute({ leaseToken }), /worker lease/);
  assert.equal(h.row().state, 'claimed'); assert.equal(h.row().dispatch, null); assert.equal(h.writer().unresolved, null); assert.equal(h.sent.length, 0);
});
