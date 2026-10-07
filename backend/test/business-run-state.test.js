'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, scope, operationId, hash, clone } = require('./helpers/business-run-fixture');
async function claimed() { const h = harness(); await h.periods.reserve(operationId, scope); h.lease = await h.state.claim(scope, operationId); return h; }
test('claim is exclusive, expires durably and rejects the replaced worker', async () => {
  const h = await claimed(); await assert.rejects(h.state.claim(scope, operationId), /still holds/);
  h.clock += 600001; const next = await h.state.claim(scope, operationId); assert.notEqual(next.leaseToken, h.lease.leaseToken);
  await assert.rejects(h.state.renew(scope, operationId, h.lease.leaseToken), /lease changed/);
  await h.state.renew(scope, operationId, next.leaseToken);
});
test('progress requires the exact ordered manifest and current persisted graph evidence', async () => {
  const h = await claimed(), token = h.lease.leaseToken, key = h.entries[0].step.logicalKey;
  await assert.rejects(h.state.advance(scope, operationId, token, 0, key), /graph proof/);
  h.saveStep(key); await assert.rejects(h.state.advance(scope, operationId, token, 1, key), /next operation/);
  await assert.rejects(h.state.advance(scope, operationId, token, 0, h.entries[1].step.logicalKey), /plan changed/);
  const saved = await h.state.advance(scope, operationId, token, 0, key); assert.equal(saved.nextOrdinal, 1);
  await assert.rejects(h.state.advance(scope, operationId, token, 0, key), /next operation/);
});
test('audit failure rolls back progress and worker ownership', async () => {
  const h = await claimed(), before = clone(h.data); h.failAudit = true;
  await assert.rejects(h.state.renew(scope, operationId, h.lease.leaseToken), /audit/); assert.deepEqual(h.data, before);
});
test('changed company ownership, approval, blueprint or access prevents progress', async () => {
  for (const change of [h => { h.calendar().blueprintHash = hash('other'); }, h => { h.writer().operationId = 'd'.repeat(24); }, h => { h.run().approval = null; }, h => { h.allowed = false; }]) {
    const h = await claimed(); change(h); await assert.rejects(h.state.renew(scope, operationId, h.lease.leaseToken));
  }
});
test('stale proof, stopped calendar and unresolved write cannot advance', async () => {
  for (const change of [h => { h.data.Steps[0].verification.observedAt = '2026-10-05T12:00:00.000Z'; }, h => { h.calendar().stopRequested = true; }, h => { h.writer().unresolved = { key: hash('unknown') }; }, h => { h.data.Steps[0].verification.graphEvidenceHash = null; }]) {
    const h = await claimed(), key = h.entries[0].step.logicalKey; h.saveStep(key); change(h); await assert.rejects(h.state.advance(scope, operationId, h.lease.leaseToken, 0, key)); assert.equal(h.run().nextOrdinal, 0);
  }
});
test('an unrequested or unresolved stop cannot be recorded as stopped', async () => {
  const h = await claimed(); await assert.rejects(h.state.release(scope, operationId, h.lease.leaseToken, 'stopped'), /settle/);
  h.calendar().stopRequested = true; h.writer().unresolved = { key: hash('unknown') }; await assert.rejects(h.state.release(scope, operationId, h.lease.leaseToken, 'stopped'), /settle/);
});
test('corrupt completion receipts are not exposed as complete', async () => {
  const h = harness(); await h.execute(); h.run().verification.evidenceHash = 'invalid'; assert.equal((await h.state.inspect(scope, operationId)).completion, null);
});
