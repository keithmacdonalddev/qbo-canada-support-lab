'use strict';
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { fixture, scope, ownerId, now } = require('./business-master-preparation-fixture');
const { hash } = require('../../src/modules/business-calendar');
const { prepareMasterPlan, compileMasterEntry } = require('../../src/modules/business-master-preparation-plan');
const { prepareMasterDispatchEvidence } = require('../../src/modules/business-master-dispatch-evidence');
const { createMasterPreparationTransport, dispatchKeyFor } = require('../../src/modules/business-master-preparation-transport');
const { createQboWriteGate } = require('../../src/modules/qbo-write-gate');
const { freezeWriteRequest } = require('../../src/modules/qbo-write-contract');
const { withWriteWorkflow } = require('../../src/modules/qbo-write-workflow');
const { QBOClient } = require('../../src/modules/qbo-client');
function clone(value) {
  if (value instanceof Types.ObjectId) return new Types.ObjectId(String(value));
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
const at = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => {
  if (key === '$or') return value.some(branch => matches(row, branch));
  if (key === '$and') return value.every(branch => matches(row, branch));
  const actual = at(row, key);
  if (value && typeof value === 'object' && !(value instanceof Types.ObjectId) && !(value instanceof Date)) {
    if ('$elemMatch' in value) return Array.isArray(actual) && actual.some(item => matches(item, value.$elemMatch));
    if ('$type' in value) return value.$type === 'string' && typeof actual === 'string';
    if ('$in' in value) return value.$in.some(item => String(actual) === String(item));
    if ('$lt' in value) return String(actual) < String(value.$lt);
    if ('$exists' in value) return (actual !== undefined) === value.$exists;
    return false;
  }
  return value === null ? actual == null : String(actual) === String(value);
});
function harness(options = {}) {
  const f = fixture(options), plan = prepareMasterPlan(f), runId = '000000000000000000000010', leaseToken = 'master-worker-lease-000001';
  const h = { source: f, clock: now, sent: [], commits: 0, data: Object.fromEntries(['MasterRuns', 'Versions', 'Sequences', 'Policies', 'Writers', 'Receipts', 'Audits', 'Connections', 'Memberships', 'Runs', 'Calendars', 'Steps', 'Users'].map(key => [key, []])) };
  const approval = { version: 1, scope, runId, ownerId, planHash: plan.planHash, approvedAt: new Date(now).toISOString(), productionConfirmed: true, auditId: '000000000000000000000011' };
  h.data.MasterRuns.push({ _id: new Types.ObjectId(runId), contractVersion: 1, ...scope, connectionId: new Types.ObjectId(scope.connectionId), ownerId: new Types.ObjectId(ownerId), sourceDraftId: new Types.ObjectId(plan.source.id), sourceDraftHash: plan.source.contentHash, planHash: plan.planHash, plan, claim: 'open', state: 'running', revision: 0, approval: { ...approval, contentHash: hash(approval) }, leaseToken, leaseExpiresAt: new Date(now + 300000), stopRequested: false, records: plan.entries.map(entry => ({ ordinal: entry.ordinal, key: entry.key, entity: entry.entity, state: 'pending', attempts: [], qboId: null, readback: null })) });
  h.data.Versions.push({ ...clone(f.blueprint), connectionId: new Types.ObjectId(scope.connectionId) }); h.data.Sequences.push({ _id: scope.realmId, value: 1, masterPreparationFence: 0 });
  h.data.Policies.push({ _id: 'production:123', contractVersion: 1, ...scope, revision: 0, state: 'active', periodControl: clone(f.periodControl) });
  h.data.Writers.push({ _id: 'production:123', contractVersion: 1, ...scope, revision: 0, operationId: runId, planHash: plan.planHash, workflowKind: 'master-preparation', unresolved: null });
  h.data.Connections.push({ _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' });
  h.data.Users.push({ _id: ownerId, role: 'agent', email: 'fixture@example.com', connectionSwitchVersion: 0 });
  h.data.Memberships.push({ _id: 'member', userId: ownerId, realmId: scope.realmId, status: 'active', role: 'lab-owner', permissionOverrides: [], businessSetupVersion: 0 });
  h.data.Audits.push({ _id: approval.auditId, userId: ownerId, realmId: scope.realmId, action: 'Business master preparation approved', outcome: 'success', afterState: { runId, planHash: plan.planHash, approvalHash: hash(approval) } });
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, {
    find(filter) { let maximum = Infinity, sort; const query = { limit(value) { maximum = value; return query; }, sort(value) { sort = value; return query; }, select() { return query; }, session() { return query; }, maxTimeMS() { return query; }, lean: async () => { const rows = h.data[name].filter(row => matches(row, filter)); if (sort) rows.sort((a,b) => { for (const [key,direction] of Object.entries(sort)) if (String(at(a,key)) !== String(at(b,key))) return (String(at(a,key)) < String(at(b,key)) ? -1 : 1) * direction; return 0; }); return clone(rows.slice(0,maximum)); } }; return query; },
    findOne(filter) { let sort; const query = { sort(value) { sort = value; return query; }, select() { return query; }, session() { return query; }, maxTimeMS() { return query; }, lean: async () => { const rows = h.data[name].filter(row => matches(row, filter)); if (sort) rows.sort((a, b) => { for (const [key, direction] of Object.entries(sort)) if (at(a, key) !== at(b, key)) return (at(a, key) < at(b, key) ? -1 : 1) * direction; return 0; }); return clone(rows[0] || null); } }; query.then = (resolve, reject) => query.lean().then(resolve, reject); return query; },
    findOneAndUpdate(filter, change, options) { return { select() { return this; }, lean: async () => { assert.ok(options.session?.inTransaction()); const row = h.data[name].find(value => matches(value, filter)); if (!row || h.conflictModel === name) return null; Object.assign(row, clone(change.$set || {})); for (const [key, value] of Object.entries(change.$inc || {})) row[key] = (row[key] ?? 0) + value; return clone(row); } }; },
    async updateOne(filter, change, options) { assert.ok(options.session?.inTransaction()); let row = h.data[name].find(value => matches(value, filter)); if (!row && options.upsert) { row = clone(filter); h.data[name].push(row); } if (!row) return { matchedCount: 0 }; Object.assign(row, clone(change.$set || {})); for (const [key, value] of Object.entries(change.$max || {})) row[key] = Math.max(row[key] ?? 0, value); for (const [key, value] of Object.entries(change.$inc || {})) row[key] = (row[key] ?? 0) + value; return { matchedCount: 1 }; },
    async create(rows, options) { assert.ok(options.session?.inTransaction()); if (name === 'Audits' && h.failAudit) throw new Error('fixture audit unavailable'); for (const row of rows) { if (h.data[name].some(value => String(value._id) === String(row._id))) throw new Error('duplicate fixture ID'); h.data[name].push(clone(row)); } return clone(rows); },
  }]));
  let queue = Promise.resolve();
  h.transaction = work => { const result = queue.then(async () => { const before = clone(h.data); let answer; try { answer = await work({ inTransaction: () => true }); } catch (error) { h.data = before; throw error; } h.commits++; if (h.loseCommitReply === h.commits) throw new Error('fixture commit acknowledgement lost'); return answer; }); queue = result.catch(() => {}); return result; };
  h.master = createMasterPreparationTransport({ ...h.models, assertReady: async () => { if (h.notMasterReady) throw new Error('master storage unavailable'); }, now: () => h.clock });
  h.gate = createQboWriteGate({ ...h.models, transaction: h.transaction, assertReady: async () => {}, masterTransport: h.master, now: () => h.clock });
  h.run = () => h.data.MasterRuns[0]; h.writer = () => h.data.Writers[0];
  h.compiled = compileMasterEntry(plan, 0); h.request = freezeWriteRequest(scope, 'POST', h.compiled.entity.toLowerCase(), h.compiled.payload);
  const preflight = prepareMasterDispatchEvidence({ run: h.run(), ordinal: 0, requestHash: h.request.requestHash, setup: f.setup, country: f.country, controls: f.periodControl, now });
  h.run().records[0] = { ...h.run().records[0], state: 'reserved', attempts: [{ number: 1, dispatchKey: dispatchKeyFor(runId, 0, 1), requestHash: h.request.requestHash, payload: clone(h.compiled.payload), preflight, leaseToken, state: 'reserved', receiptId: null, qboId: null, reservedAt: new Date(now) }] };
  h.workflow = { version: 1, kind: 'master-preparation', runId, ordinal: 0, attempt: 1, leaseToken };
  h.client = Object.create(QBOClient.prototype); Object.assign(h.client, { connection: clone(h.data.Connections[0]), realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, writeGate: h.gate, oauthClient: { makeApiCall: async opts => { if (opts.method === 'GET') { if (h.onGET) { const result = await h.onGET(opts); if (result) return result; } return { status: 200, json: { QueryResponse: { Preferences: [{ AccountingInfoPrefs: {} }] } } }; } h.sent.push(clone(opts)); if (h.onSDK) return h.onSDK(opts); return { status: 200, json: { Account: { Id: '100', SyncToken: '0', ...JSON.parse(opts.body) } } }; } } });
  h.begin = async () => h.gate.begin({ request: h.request, ownerId, actorId: ownerId, workflow: h.workflow, periodEvidence: await h.gate.preflight({ request: h.request, client: h.client }) });
  h.send = () => withWriteWorkflow(h.workflow, async dispatch => { h.ack = dispatch; if (h.loseDispatchAck) throw new Error('fixture callback failed'); }, () => h.client.create(h.compiled.entity.toLowerCase(), h.compiled.payload));
  return h;
}
module.exports = { harness, clone, scope, ownerId, now };
