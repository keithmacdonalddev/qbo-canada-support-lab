'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBusinessSetupService } = require('../src/modules/business-setup-service');
const { createCompanyJobAdmission } = require('../src/modules/company-job-admission');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, ownerId = 'b'.repeat(24), clone = value => structuredClone(value);
const at = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => value && typeof value === 'object' ? '$in' in value && value.$in.includes(at(row, key)) : at(row, key) === value);
function fixture() {
  const h = { data: { Policies: [], Writers: [], Receipts: [], Audits: [], Users: [{ _id: ownerId, role: 'agent' }], Connections: [{ _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }], Memberships: [{ userId: ownerId, realmId: scope.realmId, role: 'lab-owner', status: 'active' }] }, active: true, ready: true, storage: [], blockers: [], setups: [], jobs: [] };
  const models = Object.fromEntries(Object.keys(h.data).map(key => {
    const query = filter => ({ session() { return this; }, maxTimeMS() { return this; }, lean: async () => clone(h.data[key].find(row => matches(row, filter)) || null) });
    return [key, { findOne: query, create: async (rows, options) => { assert.ok(options.session); if (h.failAudit && key === 'Audits') throw new Error('audit failed'); h.data[key].push(...clone(rows)); return rows; }, updateOne: async (filter, update, options) => { assert.ok(options.session); const row = h.data[key].find(value => matches(value, filter)); if (!row) return { matchedCount: 0 }; for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v; Object.assign(row, clone(update.$set || {})); return { matchedCount: 1 }; }, findOneAndUpdate: (filter, update, options) => ({ lean: async () => { assert.ok(options.session); const row = h.data[key].find(value => matches(value, filter)); if (!row) return null; Object.assign(row, clone(update.$set || {})); for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v; return clone(row); } }) }];
  }));
  let queue = Promise.resolve();
  const transaction = work => { const result = queue.then(async () => { const before = clone(h.data), jobs = clone(h.jobs); try { const result = await work({ inTransaction: () => true }); if (h.loseReply) { h.loseReply = false; return Promise.reject(new Error('commit reply lost')); } return result; } catch (error) { h.data = before; h.jobs = jobs; throw error; } }); queue = result.catch(() => {}); return result; };
  const accessFor = () => ({ authorize: async () => { if (!h.active) throw Object.assign(new Error('Access revoked'), { status: 403, code: 'BUSINESS_ACCESS_DENIED' }); return { actorId: ownerId, ownerId }; } });
  const assertSetup = async (_db, target, profile) => { assert.equal(profile, 'continual-business'); assert.deepEqual(target, { ...scope, ownerId }); if (!h.ready) throw new Error('not prepared'); return { setupVersion: 4, planHash: 'c'.repeat(64) }; };
  const deps = { models, transaction, connection: { db: {}, getClient: () => ({}) }, accessFor, assertSetup, inspectStorage: async () => h.storage, legacyWork: async () => [...h.blockers], resolveContext: async () => ({ environment: scope.environment, connection: { connected: true, ...scope, companyName: 'Fixture' } }), previewSetup: async (...args) => { h.setups.push(args); return { planHash: 'd'.repeat(64), qboWrites: 0 }; }, applySetup: async (...args) => { h.setups.push(args); return { status: 'complete' }; } };
  h.service = createBusinessSetupService(deps); h.user = { id: ownerId }; h.models = models; h.transaction = transaction; h.accessFor = accessFor;
  h.prepare = () => h.service.prepareCoordination(h.user);
  h.record = input => h.service.recordPeriodControls(h.user, input || { closedThrough: null, reconciledThrough: null, evidenceNote: 'Owner reviewed the protected accounting dates.' });
  h.activate = async preparation => { if (!h.data.Policies[0]?.periodControl) await h.record(); return h.service.activateCoordination(h.user, { preparationEvidenceHash: preparation.preparationEvidenceHash }); };
  h.admit = createCompanyJobAdmission({ ...models, transaction, accessFor, environment: () => scope.environment, assertReady: async () => {} });
  h.job = () => h.admit({ _id: scope.connectionId, realmId: scope.realmId, userId: ownerId }, 'operations.execute', async session => { assert.ok(session.inTransaction()); h.jobs.push({ status: 'running' }); return true; });
  return h;
}
test('owner scope is server-derived; preview/apply cannot bootstrap a shared member', async () => {
  const h = fixture(); await h.service.preview(h.user); await h.service.apply(h.user, { planHash: 'd'.repeat(64) });
  assert.deepEqual(h.setups[0][1], { ...scope, ownerId }); assert.equal(h.setups[0][3], 'continual-business');
  await assert.rejects(h.service.preview({ id: ownerId, actorId: 'e'.repeat(24) }), /Only/);
  await assert.rejects(h.service.apply(h.user, { planHash: 'd'.repeat(64), realmId: '999' }), /exact/);
});
test('preparation, quiescence and activation are separate audited local transitions', async () => {
  const h = fixture(); const preparation = await h.prepare(); assert.equal(preparation.state, 'preparing'); assert.equal(h.data.Audits.length, 1); assert.equal(h.data.Writers[0].unresolved, null);
  await assert.rejects(h.job(), /coordination/); assert.equal(h.jobs.length, 0);
  h.blockers.push('legacy-worker'); await assert.rejects(h.activate(preparation), /earlier worker/); assert.equal(h.data.Policies[0].state, 'preparing');
  h.blockers = []; await h.activate(preparation); assert.equal(h.data.Policies[0].state, 'active'); assert.equal(h.data.Audits.length, 3);
  await h.job(); assert.equal(h.jobs.length, 1);
});
test('current storage/index drift, permission loss and unresolved receipts block activation', async () => {
  for (const change of [h => { h.storage = [{ create: true, missingIndexes: [] }]; }, h => { h.storage = [{ create: false, missingIndexes: ['unique'] }]; }, h => { h.active = false; }, h => { h.data.Receipts.push({ ...scope, state: 'unknown' }); }, h => { h.data.Writers[0].unresolved = { key: 'uncertain' }; }]) {
    const h = fixture(), p = await h.prepare(); change(h); await assert.rejects(h.activate(p)); assert.equal(h.data.Policies[0].state, 'preparing');
  }
});
test('audit failure rolls back coordination; changed connection is never overwritten', async () => {
  const h = fixture(); h.failAudit = true; await assert.rejects(h.prepare(), /audit/); assert.equal(h.data.Policies.length, 0); assert.equal(h.data.Writers.length, 0);
  h.failAudit = false; await h.prepare(); h.data.Policies[0].connectionId = 'f'.repeat(24); await assert.rejects(h.prepare(), /recovery/);
});
test('job claim conflicts with the preparing barrier and never queues work before activation', async () => {
  const h = fixture(), p = await h.prepare(); const result = await Promise.allSettled([h.job(), h.activate(p)]);
  assert.equal(result[0].status, 'rejected'); assert.equal(result[1].status, 'fulfilled'); assert.equal(h.jobs.length, 0);
  await h.job(); assert.equal(h.jobs.length, 1);
  h.active = false; await assert.rejects(h.job(), /revoked/); assert.equal(h.jobs.length, 1);
});

test('actual generation start denied during preparation leaves no scope/run and succeeds after activation', async () => {
  const { createGenerationService } = require('../src/modules/generation-service');
  const h = fixture(), preparation = await h.prepare(); h.data.GenScopes = []; h.data.GenRuns = [];
  let writes = 0, launches = 0;
  const collection = key => {
    const query = fn => ({ sort() { return this; }, session(value) { assert.ok(value?.inTransaction()); return this; }, lean: async () => clone(fn()) });
    return { findById: id => query(() => h.data[key].find(row => row._id === id) || null), find: () => query(() => [...h.data[key]]), findOneAndUpdate: (filter, update, options) => query(() => {
      assert.ok(options.session?.inTransaction()); let row = h.data[key].find(value => value._id === filter._id);
      if (!row && options.upsert) { row = clone(update.$setOnInsert); h.data[key].push(row); }
      if (!row) return null; Object.assign(row, clone(update.$set || {})); writes++; return row;
    }) };
  };
  const service = createGenerationService({ Runs: collection('GenRuns'), Scopes: collection('GenScopes'), environment: 'sandbox', admitJob: h.admit, newId: () => 'e'.repeat(24), execute: async () => { launches++; } });
  const connection = { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId };
  await assert.rejects(service.start(connection, ownerId), /coordination/);
  assert.equal(writes, 0); assert.equal(h.data.GenRuns.length, 0); assert.equal(h.data.GenScopes.length, 0);
  await h.activate(preparation); const started = await service.start(connection, ownerId);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(started.status, 'in_progress'); assert.equal(launches, 1); assert.equal(h.data.GenRuns.length, 1); assert.equal(h.data.GenScopes.length, 1);
});
test('lost activation acknowledgement retries the saved active result while new work is running', async () => {
  const h = fixture(), preparation = await h.prepare(); await h.record(); h.loseReply = true;
  await assert.rejects(h.activate(preparation), /reply lost/); assert.equal(h.data.Policies[0].state, 'active');
  await h.job(); h.blockers = ['generationruns']; h.data.Writers[0].unresolved = { key: 'new-work' };
  const retry = await h.activate(preparation); assert.equal(retry.state, 'active'); assert.equal(retry.reused, true); assert.equal(h.data.Audits.length, 3);
});

test('activation and job claims require an explicit retained period choice',async()=>{
 const h=fixture(),p=await h.prepare();
 await assert.rejects(h.service.activateCoordination(h.user,{preparationEvidenceHash:p.preparationEvidenceHash}),/owner must record/);
 assert.equal(h.data.Policies[0].state,'preparing');assert.equal(h.data.Audits.length,1);
 await h.record();await h.activate(p);h.data.Policies[0].periodControl=null;await assert.rejects(h.job(),/owner must record/);assert.equal(h.jobs.length,0);
});
test('period choices are owner-only, elapsed, monotonic, audited and require a settled writer',async()=>{
 const h=fixture();await h.prepare();const input={closedThrough:'2026-09-30',reconciledThrough:null,evidenceNote:'Reviewed the September closing evidence.'};
 await assert.rejects(h.service.recordPeriodControls({id:ownerId,actorId:'e'.repeat(24)},input),/Only/);
 await assert.rejects(h.record({...input,closedThrough:'2099-01-01'}),/elapsed/);
 const first=await h.record(input);assert.equal(first.reused,false);assert.equal(h.data.Audits.length,2);assert.equal((await h.record(input)).reused,true);assert.equal(h.data.Audits.length,2);
 await assert.rejects(h.record({...input,closedThrough:'2026-09-01'}),/backwards/);
 h.data.Writers[0].unresolved={key:'unknown'};await assert.rejects(h.record({...input,reconciledThrough:'2026-09-30'}),/current operation/);h.data.Writers[0].unresolved=null;
 h.failAudit=true;const before=clone(h.data);await assert.rejects(h.record({...input,reconciledThrough:'2026-09-30'}),/audit/);assert.deepEqual(h.data,before);
});

test('occupied, uncertain and changed company writers refuse new jobs before creating a durable run', async () => {
  for (const fields of [{ operationId: 'e'.repeat(24), planHash: 'f'.repeat(64), workflowKind: 'master-preparation' }, { operationId: 'e'.repeat(24), planHash: 'f'.repeat(64) }, { unresolved: { key: 'unknown' } }, { connectionId: 'e'.repeat(24) }]) {
    const h = fixture(), preparation = await h.prepare(); await h.activate(preparation); Object.assign(h.data.Writers[0], fields);
    const before = clone(h.data); await assert.rejects(h.job(), /current company writer/); assert.deepEqual(h.data, before); assert.equal(h.jobs.length, 0);
  }
});
