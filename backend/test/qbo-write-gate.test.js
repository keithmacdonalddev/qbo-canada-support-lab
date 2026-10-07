'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQboWriteGate } = require('../src/modules/qbo-write-gate');
const { freezeWriteRequest } = require('../src/modules/qbo-write-contract');
const { hash } = require('../src/modules/business-calendar');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const ownerId = 'b'.repeat(24), operationId = 'c'.repeat(24), logicalKey = hash('invoice');
const request = freezeWriteRequest(scope, 'POST', 'invoice', { CustomerRef: { value: '1' }, Line: [] });
const clone = value => structuredClone(value);
const at = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && !(value instanceof Date) ? ('$in' in value ? value.$in.includes(at(row, key)) : '$exists' in value ? (at(row, key) !== undefined) === value.$exists : false) : value instanceof Date ? new Date(at(row, key)).getTime() === value.getTime() : at(row, key) === value);
function harness(business = false) {
  const h = { clock: Date.parse('2026-10-06T12:00:00.000Z'), data: { Policies: [], Writers: [], Receipts: [], Audits: [], Connections: [], Memberships: [], Runs: [], Calendars: [], Steps: [], Users: [] }, sequence: 0 };
  h.data.Policies.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, state: 'active' });
  h.data.Writers.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, operationId: null, planHash: null, unresolved: null });
  h.data.Connections.push({ _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' });
  h.data.Users.push({ _id: ownerId, role: 'agent', connectionSwitchVersion: 0 });
  h.writer = () => h.data.Writers[0];
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, {
    findOne(filter) { let order; const query = { select() { return query; }, sort(value) { order = value; return query; }, session() { return query; }, maxTimeMS() { return query; }, lean: async () => { const rows = h.data[name].filter(row => matches(row, filter)); if (order) rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); return clone(rows[0] || null); } }; return query; },
    findOneAndUpdate(filter, change, options) { return { select() { return this; }, lean: async () => {
      assert.ok(options.session); if (name === 'Users' && h.conflictUser === filter._id) return null; const row = h.data[name].find(row => matches(row, filter)); if (!row) return null;
      Object.assign(row, clone(change.$set || {})); for (const [key, value] of Object.entries(change.$inc || {})) row[key] = (row[key] ?? 0) + value;
      return clone(row);
    } }; },
    async create(rows, options) {
      assert.ok(options.session); if (name === 'Audits' && h.failAudit) throw new Error('audit unavailable');
      for (const row of rows) { if (h.data[name].some(value => value._id === row._id)) throw new Error('duplicate receipt'); h.data[name].push(clone(row)); }
    },
  }]));
  let queue = Promise.resolve();
  h.transaction = work => { const result = queue.then(async () => { const before = clone(h.data); let output; try { output = await work({ inTransaction: () => true }); } catch (error) { h.data = before; throw error; } if (h.loseReply) { h.loseReply = false; throw new Error('commit reply lost'); } return output; }); queue = result.catch(() => {}); return result; };
  h.gate = createQboWriteGate({ ...h.models, transaction: h.transaction, now: () => h.clock, assertReady: async () => { if (h.notReady) throw new Error('not prepared'); }, nonce: () => String(++h.sequence) });
  h.input = { request, ownerId, actorId: ownerId };
  if (business) {
    h.data.Memberships.push({ _id: 'membership', userId: ownerId, realmId: scope.realmId, status: 'active', role: 'lab-owner', permissionOverrides: [], businessSetupVersion: 0 });
    const dispatchKey = hash('dispatch'), planHash = hash('plan'), blueprintHash = hash('blueprint'), baselineHash = hash('baseline');
    h.input.permit = { scope, operationId, logicalKey, dispatchKey, requestHash: request.requestHash };
    Object.assign(h.writer(), { revision: 1, operationId, planHash, unresolved: { key: dispatchKey, logicalKey, requestHash: request.requestHash, actorId: ownerId, evidenceHash: hash('observations'), compilationHash: hash('compilation'), observationWriterRevision: 0, observedAt: new Date(h.clock).toISOString() } });
    h.data.Runs.push({ _id: operationId, ...scope, planHash, approval: { actorId: ownerId, planHash, fenceHash: hash('approval fence'), auditId: 'approval-audit', approvedAt: new Date(h.clock).toISOString() }, blueprintHash, baselineHash, status: 'running', expectedCursor: '2026-09-30', expectedRevision: 1, writerRevision: 0, evidenceRevision: 1, verificationCandidateHash: hash('old proof') });
    h.data.Calendars.push({ _id: 'calendar', ...scope, currentOperationId: operationId, blueprintHash, baseline: { status: 'verified', evidenceHash: baselineHash }, verifiedThrough: '2026-09-30', revision: 1, writerRevision: 0, stopRequested: false, pendingCommit: null });
    h.data.Steps.push({ _id: 'step', ...scope, operationId, logicalKey, planHash, entity: 'Invoice', state: 'dispatched', revision: 2, leaseToken: 'lease', receipt: null, dispatch: { key: dispatchKey, requestHash: request.requestHash, evidenceHash: hash('observations'), compilationHash: hash('compilation'), observationWriterRevision: 0, observedAt: new Date(h.clock).toISOString() } });
  }
  return h;
}
const success = { status: 200, json: { Invoice: { Id: '100', SyncToken: '0' } } };
const rejection = { status: 400, json: { Fault: { type: 'ValidationFault', Error: [{ code: '6000', Message: 'fixture' }] } } };
test('unprepared companies retain legacy path, but a business permission cannot bypass preparation', async () => {
  const h = harness(); h.data.Policies = []; h.data.Writers = [];
  assert.deepEqual(await h.gate.begin(h.input), { coordinated: false }); assert.equal(h.data.Receipts.length, 0);
  await assert.rejects(h.gate.begin({ ...h.input, permit: {} }), /prepared/);
});
test('preparing, damaged and reconnected coordination block before sending', async () => {
  for (const change of [h => { h.data.Policies[0].state = 'preparing'; }, h => { h.data.Writers = []; }, h => { h.data.Policies = []; }, h => { h.writer().connectionId = 'f'.repeat(24); }, h => { h.data.Connections[0].status = 'revoked'; }, h => { h.notReady = true; }]) {
    const h = harness(); change(h); await assert.rejects(h.gate.begin(h.input)); assert.equal(h.data.Receipts.length, 0);
  }
});
test('legacy admission records a barrier and audit atomically, preventing a concurrent writer', async () => {
  const h = harness(); const result = await Promise.allSettled([h.gate.begin(h.input), h.gate.begin(h.input)]);
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1); assert.equal(h.data.Receipts.length, 1); assert.equal(h.data.Audits.length, 1); assert.ok(h.writer().unresolved.transportConsumed);
  await h.gate.complete(result.find(row => row.status === 'fulfilled').value, request, success, 'trace');
  assert.equal(h.writer().unresolved, null); assert.equal(h.data.Receipts[0].state, 'saved'); assert.equal(h.data.Audits.length, 2);
});
test('audit failure rolls back admission; lost admission reply retains the possibly-sent barrier', async () => {
  const h = harness(); h.failAudit = true; const before = clone(h.data);
  await assert.rejects(h.gate.begin(h.input), /audit/); assert.deepEqual(h.data, before);
  h.failAudit = false; h.loseReply = true; await assert.rejects(h.gate.begin(h.input), /reply lost/);
  assert.equal(h.data.Receipts[0].state, 'possibly-sent'); assert.ok(h.writer().unresolved);
  await assert.rejects(h.gate.begin(h.input), /owns/);
});
test('unknown or incomplete responses retain the barrier and cannot be resent', async () => {
  for (const response of [{ status: 429, json: {} }, { status: 503, json: {} }, { status: 200, body: 'invalid' }, { json: success.json }, { status: 200, json: { Invoice: { Id: '100' } } }]) {
    const h = harness(), ticket = await h.gate.begin(h.input);
    assert.equal((await h.gate.complete(ticket, request, response)).outcome, 'unknown'); assert.ok(h.writer().unresolved);
    await assert.rejects(h.gate.begin(h.input), /owns/);
  }
});
test('response audit failure rolls back settlement and keeps the barrier', async () => {
  const h = harness(), ticket = await h.gate.begin(h.input), before = clone(h.data); h.failAudit = true;
  await assert.rejects(h.gate.complete(ticket, request, success), /audit/); assert.deepEqual(h.data, before);
});
test('exact business permission is consumed durably across competing processes', async () => {
  const h = harness(true), results = await Promise.allSettled([h.gate.begin(h.input), h.gate.begin(h.input)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(h.data.Receipts.length, 1);
  assert.equal(h.data.Runs[0].verificationCandidateHash, null);
  await h.gate.complete(results.find(row => row.status === 'fulfilled').value, request, success);
  assert.ok(h.writer().unresolved, 'step persistence must settle business success'); assert.equal(h.data.Steps[0].state, 'dispatched');
});
test('changed business content, ownership, stop state or calendar denies transport', async () => {
  for (const change of [h => { h.input.request = freezeWriteRequest(scope, 'POST', 'invoice', { different: true }); }, h => { h.writer().operationId = 'd'.repeat(24); }, h => { h.data.Calendars[0].stopRequested = true; }, h => { h.data.Calendars[0].revision += 1; }, h => { h.data.Runs[0].status = 'stopped'; }, h => { h.data.Steps[0].dispatch.requestHash = hash('other'); }]) {
    const h = harness(true); change(h); await assert.rejects(h.gate.begin(h.input)); assert.equal(h.data.Receipts.length, 0);
  }
});
test('known validation rejection ends the step without inventing a record or allowing replay', async () => {
  const h = harness(true), ticket = await h.gate.begin(h.input);
  const result = await h.gate.complete(ticket, request, rejection);
  assert.equal(result.outcome, 'rejected'); assert.equal(h.data.Steps[0].state, 'rejected'); assert.equal(h.data.Steps[0].receipt, null);
  assert.equal(h.data.Runs[0].status, 'blocked'); assert.equal(h.writer().unresolved, null); assert.equal(h.writer().operationId, operationId);
  assert.equal(h.data.Steps[0].rejection.receiptId, ticket.receiptId);
  await assert.rejects(h.gate.begin(h.input)); assert.equal(h.data.Receipts.length, 1);
});
test('stopped business request can settle rejection; failed audit cannot partially reject it', async () => {
  const h = harness(true), ticket = await h.gate.begin(h.input); h.data.Runs[0].status = 'stopped'; h.data.Calendars[0].stopRequested = true;
  const before = clone(h.data); h.failAudit = true; await assert.rejects(h.gate.complete(ticket, request, rejection), /audit/); assert.deepEqual(h.data, before);
  h.failAudit = false; await h.gate.complete(ticket, request, rejection); assert.equal(h.data.Runs[0].status, 'stopped'); assert.equal(h.writer().unresolved, null);
});
test('shared actor requires current company membership and batch is disabled for coordinated writes', async () => {
  const h = harness(); h.input.actorId = 'e'.repeat(24); await assert.rejects(h.gate.begin(h.input), /access/);
  h.data.Memberships.push({ userId: h.input.actorId, realmId: scope.realmId, status: 'active' });
  const ticket = await h.gate.begin(h.input); assert.equal(h.data.Audits[0].actorUserId, h.input.actorId);
  await h.gate.complete(ticket, request, rejection); assert.equal(h.writer().unresolved, null);
  await assert.rejects(h.gate.begin({ ...h.input, request: freezeWriteRequest(scope, 'POST', 'batch', { BatchItemRequest: [] }) }), /batch/);
});

test('business admission checks execution authority for owners and supports explicit permission overrides', async () => {
  const h = harness(true); h.data.Memberships[0].role = 'reviewer';
  await assert.rejects(h.gate.begin(h.input), /execution permission/); assert.equal(h.data.Receipts.length, 0);
  h.data.Memberships[0].permissionOverrides = ['operations.execute']; await h.gate.begin(h.input);
  assert.equal(h.data.Memberships[0].businessSetupVersion, 1);
});
test('permission loss after sending does not prevent exact response settlement', async () => {
  const h = harness(true), ticket = await h.gate.begin(h.input); h.data.Memberships[0].status = 'suspended';
  await h.gate.complete(ticket, request, rejection); assert.equal(h.data.Steps[0].state, 'rejected');
});

test('transport rejects a writer changed after observations and dispatch preparation', async () => {
  const h = harness(true); h.writer().revision += 1;
  await assert.rejects(h.gate.begin(h.input), /changed before sending/); assert.equal(h.data.Receipts.length, 0);
});

test('evidence expiry is rechecked at durable transport admission after any token wait', async () => {
  const h = harness(true); h.clock += 300001;
  await assert.rejects(h.gate.begin(h.input), /changed before sending/); assert.equal(h.data.Receipts.length, 0);
});

test('business transport cannot send based on running status with absent or altered approval', async () => {
  for (const change of [run => { run.approval = null; }, run => { run.approval.planHash = hash('other'); }, run => { run.approval.actorId = 'invalid'; }]) {
    const h = harness(true); change(h.data.Runs[0]);
    await assert.rejects(h.gate.begin(h.input), /durable approval/);
    assert.equal(h.data.Receipts.length, 0); assert.equal(h.data.Audits.length, 0); assert.equal(h.writer().unresolved.transportConsumed, undefined);
  }
});

test('business admission fences owner and shared actor against company switches', async () => {
  const h = harness(true), actorId = 'e'.repeat(24);
  h.input.actorId = actorId; h.writer().unresolved.actorId = actorId;
  h.data.Memberships[0].userId = actorId;
  h.data.Users.push({ _id: actorId, role: 'agent' });
  await h.gate.begin(h.input);
  assert.equal(h.data.Users.find(row => row._id === actorId).connectionSwitchVersion, 1);
  assert.equal(h.data.Users.find(row => row._id === ownerId).connectionSwitchVersion, 1);
});
test('workspace changes or user fence conflicts prevent receipts and roll back admission', async () => {
  for (const change of [
    h => { h.data.Users = []; },
    h => { h.data.Users[0].role = 'deleted'; },
    h => { h.data.Users[0].connectionSwitchVersion = -1; },
    h => { h.conflictUser = ownerId; },
    h => { h.data.Connections.push({ _id: 'f'.repeat(24), userId: ownerId, realmId: '456', status: 'active', updatedAt: 100 }); },
    h => {
      const actorId = 'e'.repeat(24); h.input.actorId = actorId; h.writer().unresolved.actorId = actorId;
      h.data.Memberships[0].userId = actorId; h.data.Users.push({ _id: actorId, role: 'agent', connectionSwitchVersion: 0 });
      h.data.Connections.push({ _id: 'f'.repeat(24), userId: actorId, realmId: '456', status: 'active' });
    },
    h => {
      const actorId = 'e'.repeat(24); h.input.actorId = actorId; h.writer().unresolved.actorId = actorId;
      h.data.Memberships[0].userId = actorId; h.data.Users.push({ _id: actorId, role: 'agent', connectionSwitchVersion: 0 }); h.conflictUser = actorId;
    },
  ]) {
    const h = harness(true); change(h); const before = clone(h.data);
    await assert.rejects(h.gate.begin(h.input), /workspace|connection changed/);
    assert.deepEqual(h.data, before); assert.equal(h.data.Receipts.length, 0); assert.equal(h.data.Audits.length, 0);
  }
});

test('durable worker leases reject missing, replaced or expired send permission', async () => {
  for (const change of [h => { delete h.input.permit.leaseToken; }, h => { h.input.permit.leaseToken = 'different-worker-token'; }, h => { h.data.Runs[0].leaseExpiresAt = new Date(h.clock - 1); }]) {
    const h = harness(true); h.data.Runs[0].leaseToken = 'current-worker-token'; h.data.Runs[0].leaseExpiresAt = new Date(h.clock + 600000); h.input.permit.leaseToken = 'current-worker-token'; change(h);
    await assert.rejects(h.gate.begin(h.input), /worker lease/); assert.equal(h.data.Receipts.length, 0);
  }
  const h = harness(true); h.data.Runs[0].leaseToken = h.input.permit.leaseToken = 'current-worker-token'; h.data.Runs[0].leaseExpiresAt = new Date(h.clock + 600000);
  await h.gate.begin(h.input); assert.equal(h.data.Receipts.length, 1);
});
