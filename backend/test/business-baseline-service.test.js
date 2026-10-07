'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBusinessBaselineService } = require('../src/modules/business-baseline-service');
const { fixture, scope, actorId, ownerId, blueprintId } = require('./helpers/business-baseline-fixture');
const user = { id: ownerId, actorId, role: 'supervisor' };
function setup() {
  const h = fixture(); h.connected = true;
  h.service = createBusinessBaselineService({ ...h.deps, models: h.models,
    resolveContext: async supplied => { assert.deepEqual(supplied, user); return { environment: scope.environment, connection: { connected: h.connected, ...scope } }; },
    accessFor: identity => { assert.equal(identity.actorId, actorId); assert.equal(identity.ownerId, ownerId); return h.access; },
  }); return h;
}
test('production baseline composition retains and retrieves selected observations without activation dependencies', async () => {
  const h = setup(), first = await h.service.list(user);
  assert.equal(first.canCapture, true); assert.equal(first.blueprint.id, blueprintId); assert.equal(first.records.length, 0);
  const result = await h.service.capture(user, h.input);
  const saved = await h.service.inspect(user, result.id); assert.equal(saved.evidenceHash, result.evidenceHash); assert.equal(saved.accepted, false);
  const page = await h.service.list(user); assert.equal(page.records.length, 1); assert.equal(page.records[0].id, result.id);
  assert.equal(h.data.Baselines.length, 1); assert.equal(h.data.Audits.length, 1);
});
test('read-only viewers see observation history while capture stays denied', async () => {
  const h = setup(); await h.service.capture(user, h.input); h.canCapture = false;
  const page = await h.service.list(user); assert.equal(page.canCapture, false); assert.equal(page.records.length, 1);
  await assert.rejects(h.service.capture(user, h.input), /permission/); assert.equal(h.reads, 1);
});
test('unprepared storage or disconnected company does not fall back to live reads', async () => {
  for (const field of ['ready', 'connected']) { const h = setup(); h[field] = false; await assert.rejects(h.service.list(user)); await assert.rejects(h.service.capture(user, h.input)); assert.equal(h.reads, 0); assert.equal(h.writes, 0); }
});
test('missing or changed saved draft never becomes a capture-ready plan', async () => {
  const h = setup(); h.data.Versions = []; const result = await h.service.list(user); assert.equal(result.blueprint, null); assert.equal(result.canCapture, false);
  const changed = setup(); changed.data.Versions[0].definition.calendar.openingDate = '2026-09-01'; await assert.rejects(changed.service.list(user), /review/);
});

test('incomplete setup blocks capture but does not hide existing permitted history', async () => {
  const h = setup(); await h.service.capture(user, h.input); h.setupIncomplete = true;
  const page = await h.service.list(user); assert.equal(page.canCapture, false); assert.match(page.captureBlockReason, /setup incomplete/); assert.equal(page.records.length, 1);
  await assert.rejects(h.service.capture(user, h.input), /setup incomplete/); assert.equal(h.reads, 1);
});
