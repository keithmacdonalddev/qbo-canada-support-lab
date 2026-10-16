'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const mongoose = require('mongoose'), { BSON } = require('mongodb');
const { hash } = require('../src/modules/business-calendar');
const { fixture } = require('./helpers/business-master-preparation-fixture');
const { clone, scope, ownerId } = require('./helpers/master-transport-fixture');
const { scenario } = require('./helpers/master-preparation-scenario');
const BlueprintVersion = require('../src/models/BlueprintVersion');
const MasterPreparationRun = require('../src/models/MasterPreparationRun');
const { assertMasterRun } = require('../src/modules/business-master-preparation-transport');
async function persisted(t, Model, value) {
  let sent;
  t.mock.method(Model.collection, 'insertOne', async document => { sent = BSON.deserialize(BSON.serialize(document)); return { acknowledged: true, insertedId: document._id }; });
  await Model.create(value); assert.ok(sent); assert.equal(mongoose.connection.readyState, 0); return sent;
}
function blueprint(value) { return { ...clone(value), createdBy: ownerId, requestKey: '11223344-1111-4111-8111-111111111111', requestHash: hash('original-draft-request'), auditId: '000000000000000000000099' }; }
for (const dated of [false, true]) test('real Mongoose insert preserves the complete ' + (dated ? 'dated' : 'original') + ' business fingerprint and empty bindings', async t => {
  const f = fixture({ activityTemplateVersion: 2, ...(dated ? { datedTax: { version: 1, regime: 'CA-NS-2025-postpaid', salesTax: '5', purchaseTax: '6' } } : {}) });
  assert.deepEqual(f.blueprint.definition.masterBindings, {});
  const sent = await persisted(t, BlueprintVersion, blueprint(f.blueprint));
  assert.deepEqual(sent.definition, f.blueprint.definition); assert.equal(hash(sent.definition), sent.contentHash); assert.deepEqual(sent.definition.masterBindings, {});
});
test('persisted native master plans retain empty source bindings and pass the original saved-draft fence', async t => {
  const h = scenario({ activityTemplateVersion: 2, datedTax: { version: 1, regime: 'CA-NS-2025-postpaid', salesTax: '5', purchaseTax: '6' } }); await h.propose();
  const draft = await persisted(t, BlueprintVersion, blueprint(h.source.blueprint)), run = await persisted(t, MasterPreparationRun, clone(h.run()));
  assert.deepEqual(run.plan.source.masterBindings, {}); assert.equal(assertMasterRun(run, scope, ownerId).planHash, h.run().planHash);
  h.data.Versions[0] = draft;
  await h.transaction(session => h.master.fenceSource(run, session));
  h.data.Versions[0].definition.publicSafeIdentity.displayName += ' changed';
  await assert.rejects(h.transaction(session => h.master.fenceSource(run, session)), /newer or changed business draft/);
  assert.equal(h.sent.length, 0);
});
