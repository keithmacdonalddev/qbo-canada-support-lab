'use strict';
process.env.QBO_ENVIRONMENT = 'production';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scenario } = require('./helpers/master-preparation-scenario');
const { remoteMasters } = require('./helpers/master-preparation-remote');
const { scope, ownerId, clone } = require('./helpers/master-transport-fixture');
const { createMasterPreparationRunner } = require('../src/modules/business-master-preparation-runner');
const { readDraftSetup } = require('../src/modules/blueprint-draft');
async function fixture(t, options = {}) {
  const h = scenario(); t.mock.method(Date, 'now', () => h.clock); remoteMasters(h); await h.propose(); await h.approve();
  h.execute = createMasterPreparationRunner({ scope, ownerId, store: h.store, authorize: h.access.authorize, clientFor: async () => h.client, readPolicy: async () => clone(h.data.Policies[0]), now: () => h.clock, ...options }); return h;
}
test('actual worker reads fresh setup and country, saves every ordinal and performs independent exact-ID GETs', async t => {
  const h = await fixture(t), result = await h.execute(String(h.run()._id));
  assert.equal(result.complete, true); assert.equal(result.acceptedRecords, 32); assert.equal(result.verifiedRecords, 32); assert.equal(h.sent.length, 32); assert.equal(h.exactReads.length, 32); assert.equal(h.writer().operationId, null); assert.equal(h.run().claim, 'open');
  assert.equal(h.remote.Item.filter(row => row.Type === 'Inventory').length, 5); assert.ok(h.remote.Item.filter(row => row.Type === 'Inventory').every(row => row.QtyOnHand === 0 && row.InvStartDate === '2023-10-01'));
  const again = await h.execute(String(h.run()._id)); assert.equal(again.complete, true); assert.equal(h.sent.length, 32);
});
test('fresh GET incompatibility prevents later creates even when the POST body looked correct', async t => {
  const h = await fixture(t); h.changeRead = record => ({ ...record, Active: false }); const result = await h.execute(String(h.run()._id));
  assert.equal(result.complete, false); assert.equal(result.needsReview, true); assert.equal(h.sent.length, 1); assert.equal(h.run().records[0].state, 'saved'); assert.equal(h.run().records[0].qboId, '100'); assert.ok(h.writer().unresolved); assert.equal(h.exactReads.length, 1);
  await h.execute(String(h.run()._id)); assert.equal(h.sent.length, 1);
});
test('stop during an admitted POST settles that accepted record through GET then prevents the next ordinal', async t => {
  const h = await fixture(t); h.afterCreate = async () => h.store.stop(String(h.run()._id)); const result = await h.execute(String(h.run()._id));
  assert.equal(result.state, 'stopped'); assert.equal(result.complete, false); assert.equal(result.acceptedRecords, 1); assert.equal(result.verifiedRecords, 1); assert.equal(h.sent.length, 1); assert.equal(h.writer().unresolved, null); assert.equal(h.writer().operationId, String(h.run()._id)); assert.equal(h.run().leaseToken, null);
});
test('a known accepted ID survives lost response acknowledgement and can be verified without a repeated POST', async t => {
  const h = await fixture(t); let once = false; h.afterCreate = async () => { if (!once) { once = true; h.loseCommitReply = h.commits + 1; } }; const result = await h.execute(String(h.run()._id));
  assert.equal(result.complete, true); assert.equal(h.sent.length, 32); assert.equal(h.exactReads.length, 32); assert.equal(h.run().records[0].attempts.length, 1);
});
test('a newer draft during setup reading stops before any create', async t => {
  const h = await fixture(t);
  h.execute = createMasterPreparationRunner({ scope, ownerId, store: h.store, authorize: h.access.authorize, clientFor: async () => h.client, readPolicy: async () => clone(h.data.Policies[0]), now: () => h.clock, readSetup: async (...args) => { const observed = await readDraftSetup(...args); h.data.Versions.push({ ...clone(h.data.Versions[0]), _id: '000000000000000000000099', version: 2 }); h.data.Sequences[0].value = 2; return observed; } });
  const result = await h.execute(String(h.run()._id)); assert.equal(result.complete, false); assert.equal(h.sent.length, 0); assert.equal(h.run().records[0].attempts.length, 0); assert.equal(h.run().leaseToken, null);
});
test('the worker refuses a substitute transport before reading or posting accounting data', async t => {
  const h = await fixture(t, { clientFor: async () => ({ apiCall: async () => { throw new Error('Must not be called'); } }) }), result = await h.execute(String(h.run()._id));
  assert.equal(result.complete, false); assert.equal(h.sent.length, 0); assert.equal(h.exactReads.length, 0); assert.equal(h.run().leaseToken, null);
});

test('a remote create followed by terminal SDK uncertainty is never guessed from names or automatically reissued', async t => {
  const h = await fixture(t); h.afterCreate = async () => { throw Object.assign(new Error('fixture SDK transport ended after remote create'), { code: '500' }); };
  const result = await h.execute(String(h.run()._id)); assert.equal(result.complete, false); assert.equal(result.acceptedRecords, 0); assert.equal(h.sent.length, 1); assert.equal(h.remote.Account.length, 4); assert.equal(h.run().records[0].state, 'unknown'); assert.equal(h.run().records[0].qboId, null); assert.ok(h.writer().unresolved); assert.ok(h.data.Receipts[0].terminal); assert.equal(h.exactReads.length, 0);
  await h.execute(String(h.run()._id)); assert.equal(h.sent.length, 1); assert.equal(h.remote.Account.length, 4);
});

test('Stop during the final admitted create still completes and releases the settled writer', async t => {
  const h = await fixture(t); h.afterCreate = async () => { if (h.sent.length === 32) await h.store.stop(String(h.run()._id)); };
  const result = await h.execute(String(h.run()._id)); assert.equal(result.complete, true); assert.equal(h.sent.length, 32); assert.equal(h.exactReads.length, 32); assert.equal(h.writer().operationId, null); assert.equal(h.writer().unresolved, null);
});
for (const change of ['membership', 'connection']) test('current ' + change + ' revocation during POST prevents even the accepted-ID GET', async t => {
  const h = await fixture(t); h.afterCreate = async () => { if (change === 'membership') h.data.Memberships[0].status = 'suspended'; else h.data.Connections[0].status = 'disconnected'; };
  const result = await h.execute(String(h.run()._id)); assert.equal(result.complete, false); assert.equal(result.failure.code, 'access'); assert.equal(h.sent.length, 1); assert.equal(h.exactReads.length, 0); assert.equal(h.run().records[0].state, 'saved'); assert.equal(h.run().records[0].qboId, '100'); assert.ok(h.writer().unresolved); assert.equal(h.run().leaseToken, null);
});
test('revocation during setup prevents the country read and any create', async t => {
  const h = await fixture(t); const original = h.onGET; let reads = 0;
  h.onGET = async opts => { reads++; const result = await original(opts); h.data.Memberships[0].status = 'suspended'; return result; };
  const result = await h.execute(String(h.run()._id)); assert.equal(result.failure.code, 'access'); assert.equal(h.sent.length, 0); assert.ok(reads <= 3); assert.equal(h.exactReads.length, 0); assert.equal(h.run().records[0].attempts.length, 0);
});
test('worker preserves an actionable bounded failure without SDK text', async t => {
  const h = await fixture(t); h.onSDK = async () => { throw new Error('secret fixture must never enter saved evidence'); };
  const result = await h.execute(String(h.run()._id)); assert.equal(result.failure.code, 'dispatch'); assert.deepEqual(h.run().lastFailure, result.failure); assert.equal(JSON.stringify(h.data.Audits).includes('secret fixture'), false); assert.equal(JSON.stringify(result).includes('secret fixture'), false);
});

test('revocation after a full first page never sends a second setup page', async t => {
  const h = await fixture(t); const original = h.onGET; const queries = [];
  h.onGET = async opts => {
    const sql = new URL(opts.url).searchParams.get('query'); queries.push(sql);
    if (/FROM Account/.test(sql)) { h.data.Memberships[0].status = 'suspended'; return { status: 200, json: { QueryResponse: { Account: Array.from({ length: 1000 }, (_, n) => ({ Id: String(n + 1000) })) } } }; }
    return original(opts);
  };
  const result = await h.execute(String(h.run()._id)); assert.equal(result.failure.code, 'access'); assert.equal(queries.filter(sql => /FROM Account/.test(sql)).length, 1); assert.equal(queries.some(sql => /STARTPOSITION 1001/.test(sql)), false); assert.equal(queries.some(sql => /FROM CompanyInfo/.test(sql)), false); assert.equal(h.sent.length, 0);
});
