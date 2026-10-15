'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { companyActiveWork, createMasterQuiescence } = require('../src/modules/company-active-work');
const scope = { environment: 'production', realmId: '123', connectionId: 'a'.repeat(24) };
test('master quiescence scans financial and legacy company work under the caller transaction without blocking its own claim', async () => {
  const calls = [], session = { inTransaction: () => true }, db = { collection: name => ({ findOne: async (filter, options) => { calls.push({ name, filter, options }); return null; } }) };
  await createMasterQuiescence(db)({ scope, session });
  assert.deepEqual(calls.map(row => row.name), ['seedruns', 'generationruns', 'issuepackruns', 'aisessions', 'aiplans', 'operationruns']);
  for (const row of calls) { assert.equal(row.filter.realmId, scope.realmId); assert.equal(row.options.session, session); assert.equal(row.options.maxTimeMS, 3000); assert.equal(row.filter.ownerId, undefined); assert.equal(row.filter.connectionId, undefined); }
  assert.equal(calls.at(-1).filter.environment, scope.environment); assert.ok(calls.at(-1).filter.$or[0].status.$in.includes('stopped')); assert.deepEqual(calls.at(-1).filter.$or[1], { 'executionRequest.pending': true });
  await assert.rejects(createMasterQuiescence(db)({ scope }), /transaction/);
});
test('coordination scans include authorized open master work and disclose exact blocker IDs', async () => {
  const calls = [], db = { collection: name => ({ findOne: async filter => { calls.push({ name, filter }); return name === 'masterpreparationruns' ? { _id: 'prior-master' } : null; } }) };
  assert.deepEqual(await companyActiveWork(db, scope), [{ collection: 'masterpreparationruns', id: 'prior-master' }]);
  const master = calls.at(-1); assert.equal(master.filter.claim, 'open'); assert.equal(master.filter.environment, scope.environment); assert.equal(master.filter.state.$in.includes('proposed'), false); assert.ok(master.filter.state.$in.includes('complete'));
});
test('any unfinished competing work or unavailable history refuses master admission', async () => {
  const session = { inTransaction: () => true };
  for (const blocker of ['seedruns', 'generationruns', 'issuepackruns', 'aisessions', 'aiplans', 'operationruns']) {
    const db = { collection: name => ({ findOne: async () => name === blocker ? { _id: 'earlier' } : null }) };
    await assert.rejects(createMasterQuiescence(db)({ scope, session }), /Earlier company work/);
  }
  await assert.rejects(createMasterQuiescence(null)({ scope, session }), /unavailable/);
});
