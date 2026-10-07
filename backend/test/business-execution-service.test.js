'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessExecutionService } = require('../src/modules/business-execution-service');
const { harness, scope, operationId, actorId, ownerId } = require('./helpers/business-assembled-fixture');
const { hash } = require('../src/modules/business-calendar');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const user = { id: ownerId, actorId };
function setup() {
  const h = harness(); h.deferred = []; h.executions = 0;
  h.options = { models: h.models, transaction: h.transaction, assertReady: h.assertReady, now: () => h.clock,
    resolveContext: async () => ({ environment: scope.environment, connection: { realmId: scope.realmId, connectionId: scope.connectionId } }),
    runtimeFor: identity => { assert.equal(identity.operationId, operationId); assert.equal(identity.ownerId, ownerId); return { ...h.runtime, execute: async () => { h.executions++; return h.runtime.execute(); } }; },
    defer: work => h.deferred.push(work) };
  h.service = createBusinessExecutionService(h.options);
  h.body = { planHash: h.data.Runs[0].planHash, requestKey: 'fixture_request_0001' };
  h.flush = async (service = h.service) => { for (const work of h.deferred.splice(0)) work(); await service.idle(); };
  return h;
}
test('enqueue returns before provider calls; assembled worker verifies once and repeated requests do not create duplicates', async () => {
  const h = setup(); const first = await h.service.request(user, operationId, h.body);
  assert.equal(first.accepted, true); assert.equal(first.execution.pending, true); assert.equal(h.posts, 0);
  assert.equal((await h.service.request(user, operationId, h.body)).reused, true); assert.equal(h.deferred.length, 1);
  await h.flush(); assert.equal(h.posts, 1); assert.equal(h.data.Runs[0].executionRequest.result.complete, true);
  const view = await h.service.inspect(user, operationId); assert.equal(view.execution.pending, false); assert.equal(view.status, 'verified');
  assert.equal(JSON.stringify(view).includes('requestKey'), false); assert.equal(JSON.stringify(view).includes('leaseToken'), false);
  await h.service.request(user, operationId, h.body); await h.flush(); assert.equal(h.posts, 1); assert.equal(h.executions, 1);
});
test('saved pending work resumes in a fresh service; an active runtime lease defers recovery', async () => {
  const h = setup(); await h.service.request(user, operationId, h.body); h.service.close(); h.deferred = [];
  const run = h.data.Runs[0]; run.leaseToken = 'another-runtime-lease'; run.leaseExpiresAt = new Date(h.clock + 1000);
  const fresh = createBusinessExecutionService(h.options); await fresh.scan(); await h.flush(fresh); assert.equal(h.posts, 0);
  run.leaseToken = null; run.leaseExpiresAt = null; await fresh.scan(); await h.flush(fresh);
  assert.equal(h.posts, 1); assert.equal(h.data.Runs[0].executionRequest.result.complete, true); fresh.close();
});
test('revocation after enqueue prevents any provider request and retains a bounded error', async () => {
  const h = setup(); await h.service.request(user, operationId, h.body); h.data.Memberships[0].status = 'suspended'; await h.flush();
  assert.equal(h.sent.length, 0); assert.equal(h.data.Runs[0].executionRequest.pending, false); assert.equal(h.data.Runs[0].executionRequest.result.complete, false);
  assert.equal(h.data.Runs[0].executionRequest.result.error, 'The operation needs attention before it can continue.');
});
test('invalid bodies, unapproved plans and unavailable storage never enqueue', async () => {
  for (const mode of ['scope', 'hash', 'approval', 'storage']) {
    const h = setup(); const body = { ...h.body };
    if (mode === 'scope') body.realmId = '456'; if (mode === 'hash') body.planHash = hash('wrong');
    if (mode === 'approval') h.data.Runs[0].approval = null; if (mode === 'storage') h.notReady = true;
    await assert.rejects(h.service.request(user, operationId, body)); assert.equal(h.data.Runs[0].executionRequest, undefined); assert.equal(h.data.Audits.length, 0); assert.equal(h.deferred.length, 0);
  }
});
test('enqueue audit failure rolls back the durable request', async () => {
  const h = setup(); h.models.Audits.create = async () => { throw new Error('audit unavailable'); };
  await assert.rejects(h.service.request(user, operationId, h.body)); assert.equal(h.data.Runs[0].executionRequest, undefined); assert.equal(h.deferred.length, 0);
});
test('settlement compare-and-set failure rolls back its audit and stays recoverable without replaying QBO writes', async () => {
  const h = setup(); await h.service.request(user, operationId, h.body); const original = h.models.Runs.findOneAndUpdate;
  h.models.Runs.findOneAndUpdate = (filter, change, options) => change.$set?.executionRequest?.pending === false ? { lean: async () => null } : original(filter, change, options);
  await h.flush(); assert.equal(h.posts, 1); assert.equal(h.data.Runs[0].executionRequest.pending, true);
  assert.equal(h.data.Audits.filter(row => row.inputParams?.phase === 'settled').length, 0);
  h.models.Runs.findOneAndUpdate = original; await h.service.scan(); await h.flush();
  assert.equal(h.posts, 1); assert.equal(h.data.Runs[0].executionRequest.result.complete, true);
});
test('queued stop by another authorized actor is attributed to that actor and sends nothing', async () => {
  const h = setup(), stopper = '9'.repeat(24);
  h.data.Users.push({ _id: stopper, role: 'agent' }); h.data.Memberships.push({ ...h.data.Memberships[0], _id: 'stopper', userId: stopper });
  await h.service.request(user, operationId, h.body); await h.service.stop({ id: ownerId, actorId: stopper }, operationId); await h.flush();
  assert.equal(h.posts, 0); assert.equal(h.data.Runs[0].status, 'stopped');
  const audit = h.data.Audits.find(row => row.inputParams?.phase === 'settled'); assert.equal(audit.actorUserId, stopper); assert.equal(audit.inputParams.performedBy, stopper);
});
test('stop schedules a new durable recovery after an earlier blocked worker settled', async () => {
  const h = setup(); let stopCalls = 0;
  h.options.runtimeFor = () => ({ inspect: async () => ({ status: h.data.Runs[0].status }), execute: async () => { const run = h.data.Runs[0]; run.status = stopCalls ? 'stopped' : 'blocked'; return { state: stopCalls ? 'stopped' : 'recovery_required', complete: false }; }, stop: async () => { stopCalls++; } });
  h.service = createBusinessExecutionService(h.options); await h.service.request(user, operationId, h.body); await h.flush();
  const previousId = h.data.Runs[0].executionRequest.id; assert.equal(h.data.Runs[0].executionRequest.pending, false);
  await h.service.stop(user, operationId); assert.equal(h.data.Runs[0].executionRequest.pending, true); assert.notEqual(h.data.Runs[0].executionRequest.id, previousId);
  await h.flush(); assert.equal(h.data.Runs[0].executionRequest.result.state, 'stopped'); assert.equal(stopCalls, 2);
});
test('damaged older pending jobs cannot starve a later valid request', async () => {
  const h = setup(); await h.service.request(user, operationId, h.body); h.service.close(); h.deferred = [];
  for (let i = 1; i <= 3; i++) h.data.Runs.push({ ...structuredClone(h.data.Runs[0]), _id: String(i).repeat(24), executionRequest: { pending: true } });
  const fresh = createBusinessExecutionService(h.options); await fresh.scan(); await h.flush(fresh); assert.equal(h.posts, 0);
  await fresh.scan(); await h.flush(fresh); assert.equal(h.posts, 1); fresh.close();
});
test('scoped pages have stable cursors, exclude other companies and bound returned request metadata', async () => {
  const h = setup(); await h.service.request(user, operationId, h.body);
  h.data.Runs.push({ ...structuredClone(h.data.Runs[0]), _id: 'a'.repeat(24) }, { ...structuredClone(h.data.Runs[0]), _id: 'f'.repeat(24), realmId: '456' });
  const first = await h.service.list(user, { limit: 1 }); assert.equal(first.operations[0].operationId, operationId); assert.equal(first.next, operationId);
  const second = await h.service.list(user, { limit: 1, after: first.next }); assert.equal(second.operations[0].operationId, 'a'.repeat(24)); assert.equal(second.next, null);
  assert.equal(JSON.stringify(first).includes('requestKey'), false); await assert.rejects(h.service.list(user, { limit: 101 })); h.service.close();
});
test('inspection rechecks authority after runtime and queue reads', async () => {
  const h = setup(); h.options.runtimeFor = () => ({ inspect: async () => { h.data.Memberships[0].status = 'suspended'; return { status: 'approved' }; } });
  await assert.rejects(createBusinessExecutionService(h.options).inspect(user, operationId), /membership/);
});

test('stop recovery tolerates completion releasing the calendar before its worker starts', async () => {
  const h = setup(); let stopCalls = 0;
  h.options.runtimeFor = () => ({ inspect: async () => ({ status: h.data.Runs[0].status }), stop: async () => { stopCalls++; if (h.data.Runs[0].status === 'verified') throw new Error('calendar released'); }, execute: async () => { if (h.data.Runs[0].status === 'verified') return { state: 'verified', complete: true }; h.data.Runs[0].status = 'blocked'; return { state: 'recovery_required', complete: false }; } });
  h.service = createBusinessExecutionService(h.options); await h.service.request(user, operationId, h.body); await h.flush();
  await h.service.stop(user, operationId); h.data.Runs[0].status = 'verified'; await h.flush();
  assert.equal(stopCalls, 1); assert.equal(h.data.Runs[0].executionRequest.pending, false); assert.equal(h.data.Runs[0].executionRequest.result.complete, true);
});
test('stop continues a real blocked operation after a saved record without another POST', async () => {
  const h = setup(); h.beforeProvider = async options => { if (options.method === 'GET' && options.url.endsWith('/estimate/1000')) throw new Error('read unavailable'); };
  await h.service.request(user, operationId, h.body); await h.flush();
  assert.equal(h.posts, 1); assert.equal(h.data.Runs[0].status, 'blocked'); assert.equal(h.data.Runs[0].executionRequest.pending, false);
  h.beforeProvider = null; await h.service.stop(user, operationId); await h.flush();
  assert.equal(h.posts, 1); assert.equal(h.data.Runs[0].status, 'stopped'); assert.equal(h.data.Runs[0].executionRequest.result.state, 'stopped');
});

test('replacing pending execution with stop retains an audit of the superseded request', async () => {
  const h = setup(); h.options.runtimeFor = () => ({ stop: async () => {}, inspect: async () => ({ status: 'blocked' }), execute: async () => ({ state: 'recovery_required', complete: false }) }); h.service = createBusinessExecutionService(h.options);
  await h.service.request(user, operationId, h.body); h.data.Runs[0].status = 'blocked'; const oldId = h.data.Runs[0].executionRequest.id;
  await h.service.stop(user, operationId);
  const superseded = h.data.Audits.find(row => row.inputParams?.phase === 'superseded'); assert.equal(superseded.inputParams.requestId, oldId); assert.equal(superseded.actorUserId, actorId); assert.notEqual(h.data.Runs[0].executionRequest.id, oldId);
  h.service.close();
});

test('read views include server scope and current execution capability without granting operator writes', async () => {
  const h = setup(); const owner = await h.service.list(user); assert.deepEqual(owner.scope, scope); assert.equal(owner.permissions.execute, true);
  h.data.Memberships[0].role = 'operator'; const read = await h.service.inspect(user, operationId); assert.deepEqual(read.scope, scope); assert.deepEqual(read.permissions, { execute: false, stop: false });
  assert.equal((await h.service.list(user)).permissions.execute, false); await assert.rejects(h.service.request(user, operationId, h.body), error => error.status === 403);
});

test('lost acknowledgement followed by a settled blocked run continues once with a fresh key', async () => {
  const { requestBusinessOperation } = await import('../../frontend/src/lib/business-operation-request.mjs');
  const h = setup(), keys = new Map(), identity = operationId + ':' + h.body.planHash;
  h.options.runtimeFor = () => ({ inspect: async () => ({ operationId, planHash: h.body.planHash, status: h.data.Runs[0].status }), execute: async () => { h.data.Runs[0].status = 'blocked'; return { state: 'blocked', complete: false }; } }); h.service = createBusinessExecutionService(h.options);
  await h.service.request(user, operationId, h.body); await h.flush(); keys.set(identity, h.body.requestKey);
  let posts = 0; const api = { post: async (_path, body) => { posts++; return { data: { data: await h.service.request(user, operationId, body) } }; }, get: async () => ({ data: { data: await h.service.inspect(user, operationId) } }) };
  const result = await requestBusinessOperation({ api, operation: { operationId, planHash: h.body.planHash }, keys, ...scope, newKey: () => 'fixture_continuation_0002' });
  assert.equal(posts, 2); assert.equal(result.execution.pending, true); assert.equal(result.reused, false); assert.equal(keys.get(identity), 'fixture_continuation_0002'); h.service.close();
});
