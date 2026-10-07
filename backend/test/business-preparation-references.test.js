'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express'), http = require('node:http'), jwt = require('jsonwebtoken');
const config = require('../src/config');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const { bindPreparedOperationReferences } = require('../src/modules/business-preparation-references');
const { validateReferenceBinding } = require('../src/modules/business-reference');
const { createBusinessPlanRouter } = require('../src/routes/business-plan');
const { fixture, now } = require('./helpers/business-preparation-fixture');
const ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24);
function harness() {
  const f = fixture(), prepared = f.prepare(), scope = prepared.scope;
  const h = { f, prepared, scope, clock: now.getTime(), sent: [], active: 0, maximum: 0, authorizations: 0, actor: { actorId, ownerId } };
  h.records = new Map(prepared.steps.flatMap(step => step.references).filter(ref => ref.status === 'resolved').map(ref => [ref.entity.toLowerCase() + '/' + ref.id, { entity: ref.entity, record: { Id: ref.id, SyncToken: ref.syncToken, Active: true, Name: 'Fixture master ' + ref.id, PrivateAddr: { Line1: 'Fixture private address' } } }]));
  h.client = Object.create(QBOClient.prototype);
  Object.defineProperty(h.client, 'apiBase', { value: 'https://sandbox-quickbooks.api.intuit.com/v3/company/123' });
  Object.assign(h.client, { connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
    assert.equal(options.method, 'GET'); h.sent.push(options.url); h.active++; h.maximum = Math.max(h.maximum, h.active);
    try {
      if (h.onSend) await h.onSend(options);
      const path = new URL(options.url).pathname.split('/').slice(-2).join('/'), selected = h.records.get(path);
      assert.ok(selected, path);
      return { status: 200, json: { [selected.entity]: structuredClone(selected.record) } };
    } finally { h.active--; }
  } } });
  h.authorize = async requested => { assert.deepEqual(requested, scope); h.authorizations++; if (h.onAuthorize) await h.onAuthorize(); return structuredClone(h.actor); };
  h.bind = (options = {}) => bindPreparedOperationReferences(h.prepared, { authorize: h.authorize, resolveClient: async () => h.client, now: () => h.clock, ...options });
  return h;
}
test('real preparation binds complete GET definitions once per distinct record with at most three concurrent reads', async () => {
  const h = harness(), original = structuredClone(h.prepared);
  h.onSend = () => new Promise(resolve => setImmediate(resolve));
  const result = await h.bind();
  assert.equal(h.sent.length, h.records.size); assert.equal(new Set(h.sent).size, h.records.size); assert.equal(h.maximum, 3);
  for (const step of result.steps) for (const ref of step.references) {
    if (ref.status === 'resolved') validateReferenceBinding(ref);
    else assert.equal(ref.definition, undefined);
  }
  assert.equal(result.referenceDefinitions.distinctRecords, h.records.size); assert.notEqual(result.operationHash, original.operationHash);
  const { operationHash, preparedAt, readyToExecute, persisted, summary, limitations, ...payload } = result;
  assert.equal(operationHash, hash(payload)); assert.equal(readyToExecute, false); assert.equal(persisted, false);
  assert.deepEqual(result.earlierRequirements, original.earlierRequirements); assert.deepEqual(result.remaining, original.remaining);
  assert.deepEqual(result.steps.map(step => step.blockers), original.steps.map(step => step.blockers));
  assert.deepEqual(h.prepared, original); assert.equal(JSON.stringify(result).includes('Fixture private address'), false);
});
test('changed, inactive, sparse and wrong-identity full records cannot become accepted definitions', async () => {
  for (const change of [r => { r.SyncToken = '1'; }, r => { r.Active = false; }, r => { r.sparse = true; }, r => { r.Id = '99999'; }]) {
    const h = harness(); change(h.records.values().next().value.record); await assert.rejects(h.bind());
    assert.ok(h.sent.length <= 3);
  }
});
test('tampered or stale preparations fail before any full record GET', async () => {
  for (const change of [h => { h.prepared.steps[0].references[0].id = '99999'; }, h => { h.clock += 300001; }, h => { h.clock--; }, h => { h.prepared.readyToExecute = true; }]) {
    const h = harness(); change(h); await assert.rejects(h.bind()); assert.equal(h.sent.length, 0);
  }
});
test('permission, actor, owner and connection changes discard the whole preparation', async () => {
  for (const change of [h => { h.actor.actorId = 'e'.repeat(24); }, h => { h.actor.ownerId = 'e'.repeat(24); }, h => { h.client.connection.status = 'revoked'; }, h => { h.onAuthorize = () => { throw new Error('permission revoked'); }; }]) {
    const h = harness(); h.onSend = async () => { change(h); }; await assert.rejects(h.bind()); assert.ok(h.sent.length <= 3);
  }
});
test('foreign client, owner or replaced read methods fail before any company GET', async () => {
  for (const change of [h => { h.client.connection.userId = 'e'.repeat(24); }, h => { h.client.realmId = '456'; }, h => { h.client.read = async () => ({}); }, h => { h.client.apiCall = async () => ({}); }]) {
    const h = harness(); change(h); await assert.rejects(h.bind()); assert.equal(h.sent.length, 0);
  }
});
test('cancellation and read deadlines return without waiting for stalled provider replies', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(); await assert.rejects(h.bind({ signal: controller.signal }), /cancelled/); assert.equal(h.sent.length, 0);
  const g = harness(), stop = new AbortController(); let started; const called = new Promise(resolve => { started = resolve; }), finishes = [];
  g.onSend = () => new Promise(resolve => { finishes.push(resolve); started(); });
  const pending = g.bind({ signal: stop.signal }); await called; stop.abort(); await assert.rejects(pending, /cancelled/); for (const finish of finishes) finish();
  const late = harness(); late.onSend = async () => { late.clock += 180001; }; await assert.rejects(late.bind(), /budget/); assert.ok(late.sent.length <= 3);
});
test('unresolved record choices never trigger full GETs or lose their blockers', async () => {
  const h = harness(); h.f.view.draft.masterBindings = {}; h.f.view.draft.mappings = {}; h.prepared = h.f.prepare();
  const result = await h.bind(); assert.equal(h.sent.length, 0); assert.equal(result.referenceDefinitions.distinctRecords, 0); assert.deepEqual(result.steps, h.prepared.steps);
});
async function route(h, mode, work) {
  const user = { id: ownerId, role: 'supervisor' }; // authenticate derives the owner actor in this route fixture
  const context = { environment: h.scope.environment, connection: { connected: true, connectionId: h.scope.connectionId, realmId: h.scope.realmId }, membership: { permissions: ['blueprint.read', 'operations.preview', 'qbo_data.read'] } };
  if (mode === 'read-only') context.membership.permissions = ['blueprint.read', 'qbo_data.read'];
  let reads = 0;
  const accessFor = input => {
    assert.deepEqual(input, { actorId: ownerId, ownerId }); if (h.onAccess) h.onAccess();
    return { authorize: async (scope, action) => { assert.deepEqual(scope, h.scope); assert.equal(action, 'operations.preview'); if (mode === 'permission-change' && h.sent.length) throw Object.assign(new Error('Permission changed'), { code: 'BUSINESS_ACCESS_DENIED', status: 403 }); return { actorId: ownerId, ownerId }; } };
  };
  const service = { contextFor: async (_user, permission) => {
    assert.ok(context.membership.permissions.includes(permission));
    if (mode === 'permission-change' && h.sent.length) throw Object.assign(new Error('Permission changed'), { businessPlanError: true, status: 403 });
    return structuredClone(context);
  }, read: async () => { reads++; return mode === 'plan-change' && reads > 2 ? { ...h.f.view, draft: { ...h.f.view.draft, contentHash: hash('new plan') } } : structuredClone(h.f.view); }, save: async () => { throw new Error('Unexpected storage write'); } };
  const app = express(); app.use(express.json()); app.use((_req, res, next) => { if (h.onClose) res.once('close', h.onClose); next(); }); app.use('/plan', createBusinessPlanRouter({ service, accessFor, historyFor: () => ({ history: async (scope, roots) => {
      if (mode === 'history-unavailable') throw Object.assign(new Error('Fixture storage not prepared'), { code: 'BUSINESS_STORAGE_UNPREPARED', status: 409 });
      const step = h.prepared.steps.find(value => value.dependencies.length === 0);
      const entries = mode === 'history-current' ? [{ logicalKey: step.logicalKey, entity: step.entity, fingerprint: hash(step), operationId: 'e'.repeat(24), planHash: hash('original plan'), state: 'verified', qboId: '1000', step, policy: { privateOriginalNote: 'not for public output' } }] : [];
      const value = { version: 1, scope, roots, entries, missing: roots.filter(key => !entries.some(entry => entry.logicalKey === key)), observedAt: new Date().toISOString(), requiresCurrentReadback: true };
      return { ...value, sourceHash: hash(value) };
    } }), qboFor: async () => h.client,
    readSetup: async () => ({ ...structuredClone(h.f.setup), observedAt: new Date().toISOString() }), readMasters: async () => { if (h.onMasters) await h.onMasters(); return { ...structuredClone(h.f.masters), observedAt: new Date().toISOString() }; },
  }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await work((options = {}) => fetch('http://127.0.0.1:' + server.address().port + '/plan/operation-preview', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt.sign(user, config.jwtSecret), 'Content-Type': 'application/json' }, body: JSON.stringify(h.f.input), ...options })); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
test('authenticated existing route returns full bindings for operators and structural preview for read-only viewers', async () => {
  for (const mode of ['operator', 'read-only']) {
    const h = harness(); await route(h, mode, async request => {
      const response = await request(); assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('cache-control'), 'no-store'); const data = (await response.json()).data;
      assert.equal(data.readyToExecute, false); assert.equal(data.persisted, false);
      assert.equal(h.sent.length, mode === 'operator' ? h.records.size : 0);
      assert.equal(Boolean(data.referenceDefinitions), mode === 'operator');
    });
  }
});
test('route discards bindings after saved-plan or permission drift and keeps local failures distinct from QBO failures', async () => {
  for (const [mode, expected] of [['plan-change', 409], ['permission-change', 403], ['version-change', 409], ['upstream', 502]]) {
    const h = harness();
    if (mode === 'version-change') h.records.values().next().value.record.SyncToken = '1';
    if (mode === 'upstream') h.onSend = async () => { throw Object.assign(new Error('Fixture provider forbidden'), { status: 403, intuit_tid: 'fixture-trace' }); };
    await route(h, mode, async request => { const response = await request(); assert.equal(response.status, expected, await response.clone().text()); assert.equal((await response.json()).data, undefined); });
  }
});

test('disconnect during initial master reads prevents the later full-definition reads', { timeout: 5000 }, async () => {
  const h = harness(); let started, release, closed, finished;
  const masterStarted = new Promise(resolve => { started = resolve; });
  const connectionClosed = new Promise(resolve => { closed = resolve; });
  const bindingAttempted = new Promise(resolve => { finished = resolve; });
  h.onMasters = () => new Promise(resolve => { release = resolve; started(); });
  h.onClose = closed; h.onAccess = () => setImmediate(finished);
  await route(h, 'operator', async request => {
    const controller = new AbortController(), pending = request({ signal: controller.signal });
    await masterStarted; controller.abort(); await assert.rejects(pending, /abort/i); await connectionClosed;
    release(); await bindingAttempted; assert.equal(h.sent.length, 0);
  });
});

test('preparation identifies saved current work before new full GETs and leaves unavailable history explicit', async () => {
  for (const mode of ['history-current', 'history-unavailable']) {
    const h = harness(); await route(h, mode, async request => {
      const response = await request(); assert.equal(response.status, 200, await response.clone().text()); const data = (await response.json()).data;
      assert.equal(data.savedHistory.status, mode === 'history-current' ? 'resume_required' : 'unavailable');
      assert.equal(data.savedHistory.provesAbsence, false); assert.equal(data.savedHistory.currentReadback, false); assert.equal(data.readyToExecute, false);
      assert.equal(h.sent.length, mode === 'history-current' ? 0 : h.records.size);
      if (mode === 'history-current') assert.ok(data.steps.some(step => step.blockers.some(blocker => blocker.kind === 'existing_activity' && blocker.operationId === 'e'.repeat(24))));
      assert.equal(JSON.stringify(data).includes('not for public output'), false);
    });
  }
});
