'use strict';
process.env.QBO_ENVIRONMENT = 'production'; // Fixture SDK below intercepts every request; never network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { harness, clone, scope, ownerId } = require('./helpers/master-transport-fixture');
const { hash } = require('../src/modules/business-calendar');
const { assertMasterRun } = require('../src/modules/business-master-preparation-transport');
const { prepareMasterDispatchEvidence } = require('../src/modules/business-master-dispatch-evidence');
const { createQboWriteGate } = require('../src/modules/qbo-write-gate');
function rehash(value) { const { evidenceHash, ...content } = value; return { ...content, evidenceHash: hash(content) }; }
test('actual BSON run and receipt IDs admit and settle with atomic attempt and draft fencing', async () => {
  const h = harness(); assert.ok(h.run().connectionId instanceof Types.ObjectId); assertMasterRun(h.run(), scope, ownerId);
  const ticket = await h.begin(); assert.equal(ticket.kind, 'master-preparation'); assert.equal(h.data.Sequences[0].masterPreparationFence, 1);
  assert.equal(h.run().records[0].state, 'possibly-sent'); assert.equal(h.run().records[0].attempts[0].receiptId, ticket.receiptId); assert.equal(h.writer().unresolved.transportConsumed.receiptId, ticket.receiptId);
  h.data.Receipts[0].connectionId = new Types.ObjectId(scope.connectionId); h.data.Receipts[0].ownerId = new Types.ObjectId(ownerId);
  await h.gate.complete(ticket, h.request, { status: 200, json: { Account: { Id: '100', SyncToken: '0' } } }, 'fixture-trace');
  assert.equal(h.run().records[0].qboId, '100'); assert.equal(h.run().records[0].state, 'saved'); assert.equal(h.data.Receipts[0].state, 'saved'); assert.ok(h.writer().unresolved); assert.equal(h.run().records[0].readback, null);
});
test('original QBO client and simulated SDK save each accepted ID independently of later caller failure', async () => {
  const h = harness(); await h.send(); assert.equal(h.sent.length, 1); assert.equal(h.run().records[0].qboId, '100'); assert.equal(h.run().records[0].attempts[0].qboId, '100'); assert.equal(h.run().records[1].state, 'pending');
  await assert.rejects(h.send()); assert.equal(h.sent.length, 1);
});
test('an admission audit failure rolls back receipt, attempt, source sequence and writer barrier', async () => {
  const h = harness(); h.failAudit = true; const before = clone(h.data); await assert.rejects(h.send()); assert.deepEqual(h.data, before); assert.equal(h.sent.length, 0);
});
test('lost admission reply and failed postcommit callback both retain mandatory reverse correlation without dispatch', async () => {
  for (const configure of [h => { h.loseCommitReply = 1; }, h => { h.loseDispatchAck = true; }]) {
    const h = harness(); configure(h); await assert.rejects(h.send());
    assert.equal(h.sent.length, 0); assert.equal(h.run().records[0].state, 'possibly-sent'); assert.equal(h.data.Receipts[0].state, 'possibly-sent'); assert.equal(h.data.Receipts[0].workflow.runId, h.workflow.runId); assert.equal(h.run().records[0].attempts[0].receiptId, h.data.Receipts[0]._id); assert.ok(h.writer().unresolved);
    await assert.rejects(h.send()); assert.equal(h.sent.length, 0);
  }
});
test('lost response commit acknowledgement retains the accepted ID and exact saved receipt', async () => {
  const h = harness(); h.loseCommitReply = 2; await assert.rejects(h.send()); assert.equal(h.sent.length, 1); assert.equal(h.run().records[0].qboId, '100'); assert.equal(h.data.Receipts[0].state, 'saved'); assert.ok(h.writer().unresolved);
});
test('revoking owner after admission still permits identity settlement and prevents every later dispatch', async () => {
  const h = harness(); h.onSDK = async () => { h.data.Users[0].role = 'retired'; return { status: 200, json: { Account: { Id: '100', SyncToken: '0' } } }; };
  await h.send(); assert.equal(h.run().records[0].qboId, '100'); await assert.rejects(h.send()); assert.equal(h.sent.length, 1);
});
for (const [label, change] of [
  ['stopped run', h => { h.run().stopRequested = true; }],
  ['different worker', h => { h.run().leaseToken = 'other-worker-lease-00002'; }],
  ['expired worker', h => { h.run().leaseExpiresAt = new Date(h.clock); }],
  ['missing approval audit', h => { h.data.Audits = []; }],
  ['different approved plan', h => { h.run().approval.planHash = hash('other'); }],
  ['operator with case permission only', h => { h.data.Memberships[0].role = 'operator'; }],
  ['revoked current account', h => { h.data.Users[0].role = 'retired'; }],
  ['paused company policy', h => { h.data.Policies[0].state = 'preparing'; }],
  ['other company writer', h => { h.writer().operationId = '000000000000000000000099'; }],
  ['missing master storage', h => { h.notMasterReady = true; }],
  ['new draft version', h => { h.data.Versions.push({ ...clone(h.data.Versions[0]), _id: '000000000000000000000098', version: 2 }); h.data.Sequences[0].value = 2; }],
  ['changed draft content', h => { h.data.Versions[0].definition.volumeProfile = 'flagship'; }],
  ['draft save conflict', h => { h.conflictModel = 'Sequences'; }],
  ['master compare-and-swap conflict', h => { h.conflictModel = 'MasterRuns'; }],
  ['changed parent account type', h => { const p = h.run().records[0].attempts[0].preflight; p.selections.accountsReceivable.type = 'Bank'; h.run().records[0].attempts[0].preflight = rehash(p); }],
  ['changed protected-date choice', h => { const { contentHash, ...control } = h.data.Policies[0].periodControl; control.reconciledThrough = '2023-10-01'; h.data.Policies[0].periodControl = { ...control, contentHash: hash(control) }; }],
]) test(label + ' blocks before the SDK receives a create', async () => {
  const h = harness(); change(h); const before = clone(h.data); await assert.rejects(h.send()); assert.equal(h.sent.length, 0); assert.deepEqual(h.data, before);
});
test('default and financial runtimes cannot accept master correlation without the dedicated adapter', async () => {
  const h = harness(); h.gate = createQboWriteGate({ ...h.models, transaction: h.transaction, assertReady: async () => {}, now: () => h.clock });
  await assert.rejects(h.begin(), /dedicated/); assert.equal(h.data.Receipts.length, 0);
});
test('fresh preflight refuses drift in inventory, protection, taxability and Canadian prerequisites', () => {
  for (const change of [
    f => { f.setup.observations.inventoryTracking = false; },
    f => { f.setup.observations.closingDateVerified = false; },
    f => { f.setup.observations.closedThrough = '2023-10-01'; },
    f => { f.setup.options.taxCodes[0].taxable = false; },
    f => { f.setup.observations.homeCurrency = 'USD'; },
    f => { f.country.country = 'US'; },
    f => { f.setup.completeness.accounts = false; },
  ]) {
    const h = harness(), f = h.source; change(f);
    assert.throws(() => prepareMasterDispatchEvidence({ run: h.run(), ordinal: 0, requestHash: h.request.requestHash, setup: f.setup, country: f.country, controls: f.periodControl, now: h.clock })); assert.equal(h.sent.length, 0);
  }
});
test('aged evidence cannot be refreshed by changing its outer timestamp alone', async () => {
  const h = harness(); h.clock += 300001; h.run().leaseExpiresAt = new Date(h.clock + 300000); const p = h.run().records[0].attempts[0].preflight; p.observedAt = new Date(h.clock).toISOString(); h.run().records[0].attempts[0].preflight = rehash(p);
  await assert.rejects(h.send()); assert.equal(h.sent.length, 0);
});
test('terminal SDK uncertainty keeps the claim and barrier, while definite rejection preserves an explicit no-effect history', async () => {
  for (const unknown of [true, false]) {
    const h = harness(); h.onSDK = async () => { if (unknown) throw Object.assign(new Error('fixture transport ended'), { code: '500' }); return { status: 400, json: { Fault: { type: 'ValidationFault', Error: [{ code: '6000' }] } } }; };
    await assert.rejects(h.send()); assert.equal(h.sent.length, 1); assert.equal(h.run().claim, 'open'); assert.equal(h.run().state, 'blocked'); assert.equal(h.run().stopRequested, true); assert.equal(h.run().records[0].state, unknown ? 'unknown' : 'rejected'); assert.equal(h.data.Receipts[0].state, unknown ? 'unknown' : 'rejected');
    assert.equal(Boolean(h.writer().unresolved), unknown); assert.equal(h.writer().operationId, h.workflow.runId); if (unknown) assert.ok(h.data.Receipts[0].terminal?.contentHash);
    await assert.rejects(h.send()); assert.equal(h.sent.length, 1);
  }
});
test('proved-unsent history can rest pending without deleting any earlier attempt; unknown cannot', () => {
  const h = harness(), record = h.run().records[0]; record.attempts[0].state = 'proved-unsent'; record.state = 'pending'; assertMasterRun(h.run(), scope, ownerId); assert.equal(record.attempts.length, 1);
  record.attempts[0].state = 'unknown'; assert.throws(() => assertMasterRun(h.run(), scope, ownerId));
});

function nextAttempt(h, reviewed) {
  const { dispatchKeyFor } = require('../src/modules/business-master-preparation-transport'), record = h.run().records[0], previous = record.attempts.at(-1);
  const number = previous.number + 1, decision = { version: 1, scope, runId: h.workflow.runId, ownerId, planHash: h.run().planHash, ordinal: 0, priorAttempt: previous.number, priorDispatchKey: previous.dispatchKey, priorState: previous.state, nextAttempt: number, confirmedAt: new Date(h.clock).toISOString(), auditId: '000000000000000000000012' };
  record.state = 'reserved'; record.attempts.push({ ...clone(previous), number, dispatchKey: dispatchKeyFor(h.workflow.runId, 0, number), state: 'reserved', receiptId: null, qboId: null, outcome: null, retryApproval: reviewed ? { ...decision, contentHash: hash(decision) } : null });
  h.run().state = 'running'; h.run().stopRequested = false; h.workflow.attempt = number;
  if (reviewed) h.data.Audits.push({ _id: decision.auditId, userId: ownerId, realmId: scope.realmId, action: 'Business master no-effect retry approved', outcome: 'success', afterState: { runId: decision.runId, planHash: decision.planHash, decisionHash: hash(decision) } });
}
test('a fresh attempt requires an owner decision and actual mandatory-receipt absence for the old unsent identity', async () => {
  for (const [reviewed, staleReceipt, allowed] of [[false, false, false], [true, true, false], [true, false, true]]) {
    const h = harness(); h.run().records[0].attempts[0].state = 'proved-unsent'; h.run().records[0].state = 'pending'; nextAttempt(h, reviewed);
    if (staleReceipt) h.data.Receipts.push({ _id: 'stale-receipt', ...scope, dispatchKey: 'different-key', workflow: { kind: 'master-preparation', runId: h.workflow.runId, ordinal: 0, attempt: 1 }, state: 'possibly-sent' });
    if (allowed) { await h.send(); assert.equal(h.sent.length, 1); assert.equal(h.data.Receipts[0].workflow.attempt, 2); assert.equal(h.run().records[0].attempts[0].state, 'proved-unsent'); }
    else { await assert.rejects(h.send()); assert.equal(h.sent.length, 0); }
  }
});
test('a reviewed rejection retry needs the exact prior definite refusal, retaining both attempt identities', async () => {
  for (const changed of [false, true]) {
    const h = harness(); h.onSDK = async () => ({ status: 400, json: { Fault: { type: 'ValidationFault', Error: [{ code: '6000' }] } } }); await assert.rejects(h.send());
    const originalDispatchKey = h.data.Receipts[0].dispatchKey; nextAttempt(h, true); h.onSDK = null;
    if (changed) h.data.Receipts[0].state = 'unknown';
    if (changed) { await assert.rejects(h.send()); assert.equal(h.sent.length, 1); }
    else { await h.send(); assert.equal(h.sent.length, 2); assert.equal(h.data.Receipts.length, 2); assert.notEqual(h.data.Receipts[1].dispatchKey, originalDispatchKey); assert.equal(h.run().records[0].attempts[0].state, 'rejected'); assert.equal(h.run().records[0].attempts[1].qboId, '100'); }
  }
});
