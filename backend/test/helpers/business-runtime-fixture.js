'use strict';
const assert = require('node:assert/strict');
const { createBusinessCompilationRuntime } = require('../../src/modules/business-compilation-runtime');
const { createBusinessVerificationRuntime } = require('../../src/modules/business-verification-runtime');
const { createBusinessRuntimeAccess } = require('../../src/modules/business-runtime-access');
const { createBusinessDispatcher } = require('../../src/modules/business-dispatch');
const { createBusinessDispatchReceiptReader } = require('../../src/modules/business-dispatch-receipt');
const { createBusinessStepStore } = require('../../src/modules/business-step-store');
const { createBusinessWriterFence } = require('../../src/modules/business-writer-fence');
const { createQboWriteGate } = require('../../src/modules/qbo-write-gate');
const { QBOClient } = require('../../src/modules/qbo-client');
const { hash, canonical } = require('../../src/modules/business-calendar');
const { fixture, scope, now, clone } = require('./business-transaction-fixtures');
const operationId = 'b'.repeat(24), ownerId = 'c'.repeat(24), actorId = 'd'.repeat(24);
const at = (row, path) => path.split('.').reduce((value, key) => value?.[key], row);
const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => key === '$or' ? value.some(option => matches(row, option)) : value instanceof Date ? new Date(at(row, key)).getTime() === value.getTime() : value && typeof value === 'object' ? ('$gte' in value ? at(row, key) >= value.$gte && at(row, key) < value.$lt : '$gt' in value ? at(row, key) > value.$gt : '$lte' in value ? at(row, key) <= value.$lte : '$lt' in value ? at(row, key) < value.$lt : '$in' in value ? value.$in.includes(at(row, key)) : '$exists' in value ? (at(row, key) !== undefined) === value.$exists : canonical(at(row, key)) === canonical(value)) : at(row, key) === value);
function harness() {
  const f = fixture('Estimate'), key = f.step.logicalKey, planHash = hash('plan'), baselineHash = hash('baseline'), blueprintHash = hash('blueprint');
  const h = { data: Object.fromEntries(['Policies', 'Writers', 'Receipts', 'Audits', 'Connections', 'Memberships', 'Runs', 'Calendars', 'Steps', 'Users', 'Plans', 'Intents', 'Evidence'].map(key => [key, []])), clock: now, sent: [], sequence: 0, allowed: true, actor: actorId, graphCalls: 0 };
  const run = { _id: operationId, contractVersion: 1, ...scope, businessKey: 'business', blueprintId: 'e'.repeat(24), planHash, blueprintHash, baselineHash, fromDate: '2026-10-01', throughDate: '2026-10-06', expectedCursor: '2026-09-30', expectedRevision: 0, expectedRecordSetHash: hash('records'), recordCount: 1, requiredAssertions: [{ key: 'records', evidenceType: 'record-readback', currency: 'CAD' }], writerRevision: 0, evidenceRevision: 0, status: 'running', approval: { actorId, planHash, fenceHash: hash('approved'), auditId: 'approval-audit', approvedAt: new Date(now).toISOString() } };
  h.data.Users.push({ _id: ownerId, role: 'supervisor' }, { _id: actorId, role: 'agent' });
  h.data.Runs.push(run);
  h.data.Calendars.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, businessKey: run.businessKey, blueprintId: run.blueprintId, blueprintHash, baseline: { status: 'verified', evidenceHash: baselineHash }, revision: 0, writerRevision: 0, currentOperationId: operationId, verifiedThrough: run.expectedCursor, stopRequested: false, pendingCommit: null });
  h.data.Writers.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, operationId, planHash, unresolved: null });
  h.data.Policies.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, state: 'active' });
  h.data.Connections.push({ _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' });
  h.data.Memberships.push({ _id: 'membership', userId: actorId, realmId: scope.realmId, role: 'lab-owner', status: 'active', permissionOverrides: [], businessSetupVersion: 0 });
  h.row = () => h.data.Steps[0]; h.writer = () => h.data.Writers[0];
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, {
    find(filter) { let maximum = Infinity, sort; const rows = () => { let values = h.data[name].filter(row => matches(row, filter)); if (sort) values.sort((a, b) => { for (const [key, direction] of Object.entries(sort)) { if (at(a, key) < at(b, key)) return -direction; if (at(a, key) > at(b, key)) return direction; } return 0; }); return values.slice(0, maximum); }; const query = { select() { return query; }, session() { return query; }, sort(value) { sort = value; return query; }, limit(value) { maximum = value; return query; }, maxTimeMS() { return query; }, lean() { return query; }, then(resolve, reject) { return Promise.resolve(clone(rows())).then(resolve, reject); }, cursor() { const values = rows(); let index = 0; return { next: async () => clone(values[index++] || null), close: async () => {} }; } }; return query; },
    findOne(filter) { const q = { select() { return q; }, sort() { return q; }, session() { return q; }, maxTimeMS() { return q; }, lean: async () => clone(h.data[name].find(row => matches(row, filter)) || null), then(resolve, reject) { return q.lean().then(resolve, reject); } }; return q; },
    findOneAndUpdate(filter, change, options) { return { select() { return this; }, lean: async () => { const row = h.data[name].find(row => matches(row, filter)); if (!row) return null; Object.assign(row, clone(change.$set || {})); for (const [key, value] of Object.entries(change.$inc || {})) row[key] = (row[key] ?? 0) + value; return clone(row); } }; },
    async create(rows, options) { assert.ok(options.session); for (const item of rows) { const row = clone(item); row._id ||= row.logicalKey; if (h.data[name].some(value => value._id === row._id)) throw new Error('duplicate identity'); h.data[name].push(row); } },
  }]));
  let queue = Promise.resolve();
  h.transaction = work => { const result = queue.then(async () => { const before = clone(h.data); try { return await work({ inTransaction: () => true }); } catch (error) { h.data = before; throw error; } }); queue = result.catch(() => {}); return result; };
  h.authorize = async () => { if (!h.allowed) throw new Error('permission revoked'); return { actorId: h.actor, ownerId }; };
  h.assertReady = async () => { if (h.notReady) throw new Error('storage unavailable'); };
  h.intent = { version: 1, scope, operationId, logicalKey: key, entity: f.step.entity, kind: 'create', planHash, fingerprint: hash(f.step), dependencies: f.step.dependencies, step: f.step, policy: f.policy };
  h.fixture = f; h.referenceRecords = clone(f.referenceEvidence);
  h.loadIntent = async () => clone(h.intent);
  h.reader = createBusinessDispatchReceiptReader({ ...h.models, transaction: h.transaction, authorize: h.authorize, assertReady: h.assertReady });
  h.writerFence = createBusinessWriterFence({ ...h.models, now: () => h.clock, assertIntegration: async () => {} });
  h.store = createBusinessStepStore({ ...h.models, transaction: h.transaction, loadIntent: h.loadIntent, authorize: h.authorize, assertReady: h.assertReady, fence: h.writerFence.fenceStep, now: () => h.clock, token: () => 'test-lease-' + String(++h.sequence).padStart(10, '0'),
    writeAudit: async (eventKey, details) => { if (h.failRecovery && details.phase === 'recover') throw new Error('receipt persistence unavailable'); return { eventKey, id: hash(eventKey).slice(0, 24) }; },
    loadGraphReadback: (...args) => h.verification.loadGraphReadback(...args),
    graphSnapshot: (...args) => h.verification.graphSnapshot(...args),
    loadRecovery: h.reader,
    loadReadback: async row => ({ version: 1, kind: 'business-readback', scope, logicalKey: key, entity: row.entity, qboId: row.qboId, fingerprint: row.fingerprint, compilationHash: row.dispatch.compilationHash, matchesIntent: true, observedHash: hash('saved body'), evidenceHash: hash('verified'), syncToken: '0', observedAt: new Date(h.clock).toISOString(), relationships: [] }),
  });
  h.steps = { ...h.store, verifyGraph: async (...args) => { h.graphCalls++; if (h.failGraph) return { complete: false, persisted: false }; await h.store.verifySaved(...args.slice(0, 2), args[2][0]); return { complete: true, persisted: true }; } };
  h.gate = createQboWriteGate({ ...h.models, transaction: h.transaction, assertReady: h.assertReady, now: () => h.clock });
  h.client = Object.create(QBOClient.prototype);
  Object.assign(h.client, { connection: clone(h.data.Connections[0]), realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, writeGate: h.gate, oauthClient: { makeApiCall: async opts => { h.sent.push(clone(opts)); if (h.onSend) return h.onSend(opts); return { status: 200, json: { Estimate: { Id: '1000', SyncToken: '0' } } }; } } });
  h.deps = { steps: h.steps, loadIntent: h.loadIntent, assertReady: h.assertReady, authorize: h.authorize, resolveClient: async () => h.client, now: () => h.clock,
  };
  h.deps.loadCompilationEvidence = async () => { if (h.onObserve) await h.onObserve(); const revision = h.writer().revision, values = clone({ referenceEvidence: f.referenceEvidence, parents: f.parents, observationFence: f.observationFence }); for (const value of [...values.referenceEvidence, ...values.parents]) { value.writerRevision = revision; value.observedAt = new Date(h.clock).toISOString(); } Object.assign(values.observationFence, { writerRevision: revision, observedAt: new Date(h.clock).toISOString() }); return values; };
  h.execute = options => createBusinessDispatcher(h.deps)(scope, operationId, key, options);
  return h;
}

module.exports = { harness, scope, operationId, ownerId, actorId };
