'use strict';
process.env.QBO_ENVIRONMENT = 'production';
const test = require('node:test'), assert = require('node:assert/strict');
const { scenario } = require('./helpers/master-preparation-scenario');
const { remoteMasters } = require('./helpers/master-preparation-remote');
const { scope, ownerId, clone } = require('./helpers/master-transport-fixture');
const { hash } = require('../src/modules/business-calendar');
const { buildDraftDefinition, draftView } = require('../src/modules/blueprint-draft');
const { createMasterRuntime, createMasterStorageReadiness } = require('../src/modules/business-master-runtime');
const { describeMasterEntry, compileMasterEntry, prepareMasterPlan } = require('../src/modules/business-master-preparation-plan');
function runtimeFixture(t, flagship = false) {
  const h = scenario(); t.mock.method(Date, 'now', () => h.clock);
  if (flagship) {
    const old = h.source.view.draft, definition = buildDraftDefinition({ requestKey: '00000000-0000-0000-0000-000000000001', connectionId: scope.connectionId, baseHash: old.contentHash, business: { ...old.business, volumeProfile: 'flagship' }, mappings: old.mappings, masterBindings: old.masterBindings });
    h.data.Versions[0].definition = definition; h.data.Versions[0].contentHash = hash(definition);
    h.source.view.draft = draftView(h.data.Versions[0], scope.connectionId);
  }
  remoteMasters(h); h.workQueries = []; h.db.collection = name => ({ findOne: async (filter, options) => { h.workQueries.push({ name, filter, options }); return h.busyCollection === name ? { _id: 'earlier-work' } : null; }, find: () => ({ limit() { return this; }, toArray: async () => [] }) });
  h.readiness = 0;
  h.runtime = createMasterRuntime({ scope, ownerId, actorId: ownerId, models: h.models, connection: { db: h.db }, transaction: h.transaction, assertReady: async () => { h.readiness++; if (h.unprepared) throw Error('fixture master storage unavailable'); }, createClient: async () => h.client, environment: () => scope.environment, now: () => h.clock });
  h.input = { connectionId: scope.connectionId, baseHash: h.data.Versions[0].contentHash, inventoryStartDate: '2023-10-01' };
  h.prepare = async () => { const plan = await h.runtime.prepare(h.input); assert.equal(plan.runnable, true, JSON.stringify(plan.blockers)); return h.runtime.store.propose(plan, '10000000-0000-0000-0000-000000000001'); };
  h.approve = async () => h.runtime.store.approve(String(h.run()._id), h.run().planHash, true, await h.runtime.prepare(h.input));
  return h;
}
test('dedicated runtime construction does not read, create storage or start a worker', t => {
  const h = runtimeFixture(t); assert.equal(h.readiness, 0); assert.equal(h.workQueries.length, 0); assert.equal(h.sent.length, 0); assert.equal(h.data.MasterRuns.length, 0);
});
for (const flagship of [false, true]) test('composed runtime prepares and verifies the ' + (flagship ? 'flagship' : 'development') + ' master set through the original transport', async t => {
  const h = runtimeFixture(t, flagship); await h.prepare(); await h.approve(); const count = h.run().records.length;
  assert.equal(count, flagship ? 68 : 32); const result = await h.runtime.execute(String(h.run()._id));
  assert.equal(result.complete, true); assert.equal(result.acceptedRecords, count); assert.equal(h.sent.length, count); assert.equal(h.exactReads.length, count); assert.equal(h.writer().operationId, null);
  assert.ok(h.workQueries.some(row => row.name === 'operationruns')); assert.ok(h.workQueries.every(row => row.name !== 'masterpreparationruns')); assert.ok(h.workQueries.every(row => row.options.session.inTransaction()));
  assert.equal((await h.runtime.execute(String(h.run()._id))).complete, true); assert.equal(h.sent.length, count);
});
test('earlier financial and legacy work prevents approval and leaves no approval audit or writer claim', async t => {
  const h = runtimeFixture(t); await h.prepare();
  for (const name of ['operationruns', 'generationruns', 'aisessions', 'seedruns']) {
    h.busyCollection = name; const before = clone(h.data); await assert.rejects(h.approve(), /Earlier company work/); assert.deepEqual(h.data, before); assert.equal(h.sent.length, 0);
  }
});
test('the final inventory protected-period query rechecks current authority before sending', async t => {
  const h = runtimeFixture(t); await h.prepare(); await h.approve(); const original = h.onGET;
  h.onGET = async opts => { const value = await original(opts), row = h.run().records.find(item => item.state === 'reserved'); if (row?.entity === 'Item' && row.attempts.at(-1).payload.Type === 'Inventory' && /FROM Preferences/.test(new URL(opts.url).searchParams.get('query') || '')) h.data.Memberships[0].status = 'suspended'; return value; };
  const result = await h.runtime.execute(String(h.run()._id)); assert.equal(result.complete, false); assert.equal(h.remote.Item.some(row => row.Type === 'Inventory'), false); assert.equal(h.run().records.find(row => row.state === 'reserved').entity, 'Item'); assert.equal(h.writer().unresolved, null);
});
test('preparation rejects current membership loss and storage failures before any master create', async t => {
  const h = runtimeFixture(t); h.unprepared = true; await assert.rejects(h.runtime.prepare(h.input), /storage/); h.unprepared = false; h.data.Memberships[0].status = 'suspended'; await assert.rejects(h.runtime.prepare(h.input), /membership/); assert.equal(h.sent.length, 0); assert.equal(h.data.MasterRuns.length, 0);
});
test('owner preview shares exact create fields while unresolved account references remain descriptive', () => {
  const f = require('./helpers/business-master-preparation-fixture').fixture(), plan = prepareMasterPlan(f), verified = {};
  for (const entry of plan.entries) {
    const described = describeMasterEntry(plan, entry.ordinal), fields = JSON.parse(JSON.stringify(described.payload));
    for (const [key, value] of Object.entries(fields)) if (value?.plannedAccountRole) fields[key] = { value: verified[value.plannedAccountRole].qboId };
    assert.deepEqual(fields, compileMasterEntry(plan, entry.ordinal, verified).payload);
    if (entry.target === 'mapping') verified[entry.key] = { state: 'verified', ordinal: entry.ordinal, planHash: plan.planHash, qboId: String(100 + entry.ordinal) };
  }
  assert.throws(() => compileMasterEntry(plan, plan.entries.find(row => row.entity === 'Item').ordinal), /readback/);
});
test('master readiness requires fresh exact v4 and v5 receipts while caching only static collection inspection', async () => {
  let inspections = 0; const calls = [], session = { inTransaction: () => true }, models = { One: { collection: { name: 'one', indexes: async () => [] }, schema: { indexes: () => [] } } };
  const connection = { readyState: 1, db: { listCollections: () => ({ toArray: async () => { inspections++; return [{ name: 'one', type: 'collection' }]; } }), admin: () => ({ command: async () => ({ setName: 'isolated-fixture' }) }) } };
  const ready = createMasterStorageReadiness({ connection, models, scope, ownerId, inspectProfile: async () => [], assertProfile: async (_db, target, profile, currentSession) => { assert.deepEqual(target, { ...scope, ownerId }); calls.push({ profile, session: currentSession }); } });
  await ready({ session }); await ready({ session }); assert.equal(inspections, 1); assert.deepEqual(calls.map(row => row.profile), ['continual-business', 'master-preparation', 'continual-business', 'master-preparation']); assert.ok(calls.every(row => row.session === session));
  const refused = createMasterStorageReadiness({ connection, models, scope, ownerId, inspectProfile: async () => [], assertProfile: async (_db, _target, profile) => { if (profile === 'master-preparation') throw Error('fixture v5 receipt missing'); } }); await assert.rejects(refused(), { code: 'BUSINESS_STORAGE_UNPREPARED' });
});

test('current full-profile prerequisite drift blocks work even when historical setup receipts still match', async () => {
  const models = { One: { collection: { name: 'one', indexes: async () => [] }, schema: { indexes: () => [] } } }, connection = { readyState: 1, db: { listCollections: () => ({ toArray: async () => [{ name: 'one', type: 'collection' }] }), admin: () => ({ command: async () => ({ setName: 'fixture' }) }) } };
  for (const drift of [{ create: true, missingIndexes: [] }, { create: false, missingIndexes: [{ name: 'submission-key-unique' }] }]) {
    let receipts = 0;
    const ready = createMasterStorageReadiness({ connection, models, scope, ownerId, inspectProfile: async (_db, profile) => { assert.equal(profile, 'master-preparation'); return [drift]; }, assertProfile: async () => { receipts++; } });
    await assert.rejects(ready(), { code: 'BUSINESS_STORAGE_UNPREPARED' }); assert.equal(receipts, 0);
  }
});
