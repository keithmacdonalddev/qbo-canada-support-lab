'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessAuditWriter } = require('../src/modules/business-runtime-audit');
const { harness, scope, actorId, ownerId, operationId } = require('./helpers/business-runtime-fixture');
const eventKey = 'business-run:' + operationId + ':1';
const details = { ...scope, actorId, operationId, phase: 'claim', nextOrdinal: 0 };
function setup() { const h = harness(); h.audit = createBusinessAuditWriter({ scope, actorId, ownerId, Audits: h.models.Audits, transaction: h.transaction, access: { authorize: async () => { if (h.denied) throw new Error('permission revoked'); return { actorId: h.actor, ownerId }; } } }); return h; }
test('audit preserves real actor/owner and exact idempotent metadata', async () => {
  const h = setup(); const first = await h.audit(eventKey, details), repeat = await h.audit(eventKey, details); assert.deepEqual(repeat, first); assert.equal(h.data.Audits.length, 1); assert.equal(h.data.Audits[0].userId, ownerId); assert.equal(h.data.Audits[0].actorUserId, actorId);
  await assert.rejects(h.audit(eventKey, { ...details, phase: 'different' }), /differs/); assert.equal(h.data.Audits.length, 1);
});
test('audit joins the caller transaction and rolls back with failed work', async () => {
  const h = setup(); await assert.rejects(h.transaction(async session => { await h.audit(eventKey, details, session); throw new Error('rollback'); }), /rollback/); assert.equal(h.data.Audits.length, 0);
  await assert.rejects(h.audit(eventKey, details, {}), /transaction/);
});
test('cross-company, secret, nested payload and revoked authority never persist audit', async () => {
  for (const value of [{ ...details, realmId: '456' }, { ...details, token: 'not-a-real-token' }, { ...details, phase: {} }]) { const h = setup(); await assert.rejects(h.audit(eventKey, value)); assert.equal(h.data.Audits.length, 0); }
  const h = setup(); h.denied = true; await assert.rejects(h.audit(eventKey, details), /revoked/); assert.equal(h.data.Audits.length, 0);
});
test('recovery records the current actor while retaining original committed actor metadata', async () => {
  const h = setup(); const originalActor = 'e'.repeat(24); await h.audit('business-period:' + operationId + ':committed', { ...details, actorId: originalActor });
  assert.equal(h.data.Audits[0].actorUserId, actorId); assert.equal(h.data.Audits[0].inputParams.details.actorId, originalActor);
});
