'use strict';
// The general-write-v1 batch transport through the real company write gate, on in-memory
// storage: receipt and writer barrier before sending, per-item period proof, per-item
// classification, settlement on the run, lost-response replay under the same requestid,
// and refusal of anything that is not the exact saved batch. No QuickBooks or database.
const test = require('node:test'), assert = require('node:assert/strict');
const { createQboWriteGate } = require('../src/modules/qbo-write-gate');
const { createGeneralGateTransport, buildGeneralBatch } = require('../src/modules/general-write-transport');
const { freezeWriteRequest } = require('../src/modules/qbo-write-contract');
const { controls } = require('./helpers/period-controls');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, ownerId = 'b'.repeat(24), runId = 'd'.repeat(24);
const clone = value => structuredClone(value);
const at = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && !(value instanceof Date) ? ('$in' in value ? value.$in.includes(at(row, key)) : '$exists' in value ? (at(row, key) !== undefined) === value.$exists : false) : at(row, key) === value);
function harness() {
  const h = { clock: Date.parse('2026-12-02T15:00:00.000Z'), data: { Policies: [], Writers: [], Receipts: [], Audits: [], Connections: [], Memberships: [], Runs: [], Calendars: [], Steps: [], Users: [], Agents: [], GeneralWriteRuns: [] } };
  h.data.Policies.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, state: 'active', periodControl: controls(scope, ownerId, h.clock) });
  h.data.Writers.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, operationId: null, planHash: null, unresolved: null });
  h.data.Connections.push({ _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' });
  h.data.Memberships.push({ _id: 'membership', userId: ownerId, realmId: scope.realmId, status: 'active', role: 'lab-owner', permissionOverrides: [], businessSetupVersion: 0 });
  h.data.Users.push({ _id: ownerId, role: 'agent', connectionSwitchVersion: 0 });
  const items = [{ bId: '1', ref: 'cust', op: 'create', entity: 'Customer', operation: 'create', payload: { DisplayName: 'Harbour Clinic', CurrencyRef: { value: 'CAD' } } }, { bId: '2', ref: 'vend', op: 'create', entity: 'Vendor', operation: 'create', payload: { DisplayName: 'Coastal Power', CurrencyRef: { value: 'CAD' } } }];
  h.data.GeneralWriteRuns.push({ _id: runId, contract: 'general-write-v1', ...scope, ownerId, actorId: ownerId, agentAuthority: null, decisionKey: 'general-day-0001', day: '2026-12-02', status: 'sending', plan: { operations: [] }, batches: [{ index: 0, attempt: 1, requestId: 'e'.repeat(32), items, state: 'sending', sends: 1 }], items: {}, owned: [], dirty: [], revision: 3 });
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, {
    find(filter) { const query = { limit() { return query; }, session() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.data[name].filter(row => matches(row, filter))) }; return query; },
    findOne(filter) { const query = { select() { return query; }, sort() { return query; }, session() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.data[name].find(row => matches(row, filter)) || null) }; return query; },
    findOneAndUpdate(filter, change) { return { select() { return this; }, lean: async () => { const row = h.data[name].find(value => matches(value, filter)); if (!row) return null; Object.assign(row, clone(change.$set || {})); for (const [key, value] of Object.entries(change.$inc || {})) row[key] = (row[key] ?? 0) + value; return clone(row); } }; },
    async create(rows) { for (const row of rows) { if (h.data[name].some(value => value._id === row._id)) throw new Error('duplicate'); h.data[name].push(clone(row)); } },
  }]));
  let queue = Promise.resolve();
  h.transaction = work => { const result = queue.then(async () => { const before = clone(h.data); try { return await work({ inTransaction: () => true }); } catch (error) { h.data = before; throw error; } }); queue = result.catch(() => {}); return result; };
  h.gateFor = (batchIndex = 0) => createQboWriteGate({ ...h.models, transaction: h.transaction, assertReady: async () => {}, now: () => h.clock, generalTransport: createGeneralGateTransport({ models: h.models, scope, runId, batchIndex, now: () => h.clock }) });
  h.client = { read: async () => { throw new Error('no linked reads expected'); }, query: async () => ({ QueryResponse: { Preferences: [{ AccountingInfoPrefs: {}, SalesFormsPrefs: { AutoApplyCredit: false } }] } }) };
  h.run = () => h.data.GeneralWriteRuns[0]; h.writer = () => h.data.Writers[0];
  h.request = () => buildGeneralBatch(scope, h.run().batches[0]);
  h.begin = async (gate, sends = 1) => { const request = h.request(), evidence = await gate.preflight({ request, client: h.client }); return gate.begin({ request, ownerId, actorId: ownerId, workflow: { version: 1, kind: 'general-write', runId, batchIndex: 0, sends }, periodEvidence: evidence }); };
  return h;
}
const answered = { status: 200, json: { BatchItemResponse: [{ bId: '1', Customer: { Id: '61', SyncToken: '0', DisplayName: 'Harbour Clinic' } }, { bId: '2', Fault: { type: 'ValidationFault', Error: [{ code: '6240', Message: 'Duplicate Name Exists Error' }] } }] } };

test('a general batch is admitted with its receipt and writer barrier, then settled per item', async () => {
  const h = harness(), gate = h.gateFor(), ticket = await h.begin(gate);
  assert.equal(ticket.kind, 'general-write');
  const receipt = h.data.Receipts[0];
  assert.equal(receipt.kind, 'general-write'); assert.equal(receipt.state, 'possibly-sent'); assert.equal(receipt.general.requestId, 'e'.repeat(32));
  assert.deepEqual(receipt.general.items.map(item => [item.bId, item.entity, item.operation]), [['1', 'Customer', 'create'], ['2', 'Vendor', 'create']]);
  assert.equal(receipt.periodProof.kind, 'general-period-proof'); assert.equal(receipt.periodProof.proofs.length, 2);
  assert.equal(h.writer().unresolved.kind, 'general-write');
  // While the batch is unresolved no other company write is admitted.
  await assert.rejects(createQboWriteGate({ ...h.models, transaction: h.transaction, assertReady: async () => {}, now: () => h.clock }).begin({ request: freezeWriteRequest(scope, 'POST', 'customer', { DisplayName: 'Other' }), ownerId, actorId: ownerId, periodEvidence: { coordination: { policyRevision: h.data.Policies[0].revision, writerRevision: h.writer().revision, controlHash: h.data.Policies[0].periodControl.contentHash } } }));
  assert.equal(h.data.Receipts.length, 1, 'nothing else was admitted');
  const observed = await gate.complete(ticket, h.request(), answered, 'tid-1');
  assert.equal(observed.outcome, 'saved');
  assert.deepEqual(observed.items.map(item => [item.bId, item.outcome]), [['1', 'saved'], ['2', 'rejected']]);
  assert.equal(h.writer().unresolved, null, 'a settled batch releases the writer');
  assert.deepEqual(h.run().batches[0].transport.items.map(item => [item.bId, item.outcome, item.qboId || null]), [['1', 'saved', '61'], ['2', 'rejected', null]]);
});

test('a lost response keeps the barrier; only the same batch is replayed, as a new transport attempt', async () => {
  const h = harness(), gate = h.gateFor(), ticket = await h.begin(gate);
  await gate.failTransport(ticket, h.request(), { httpStatus: null });
  assert.equal(h.data.Receipts[0].state, 'unknown'); assert.equal(h.writer().unresolved.kind, 'general-write');
  // Another batch of the run cannot use the held writer; the same batch (same requestid) can.
  h.run().batches.push({ index: 1, attempt: 2, requestId: 'f'.repeat(32), items: [h.run().batches[0].items[0]], state: 'sending', sends: 1 });
  const other = h.gateFor(1), request = buildGeneralBatch(scope, h.run().batches[1]);
  await assert.rejects(other.begin({ request, ownerId, actorId: ownerId, workflow: { version: 1, kind: 'general-write', runId, batchIndex: 1, sends: 1 }, periodEvidence: await other.preflight({ request, client: h.client }) }), /owns this company/);
  const replay = await h.begin(h.gateFor(), 2);
  assert.notEqual(replay.receiptId, ticket.receiptId); assert.equal(h.data.Receipts[1].general.requestId, h.data.Receipts[0].general.requestId);
  assert.equal((await h.gateFor().complete(replay, h.request(), answered, 'tid-2')).outcome, 'saved');
  assert.equal(h.writer().unresolved, null);
});

test('only the exact saved batch of a sending run on its own business day is admitted', async () => {
  const h = harness();
  h.run().status = 'complete';
  await assert.rejects(h.begin(h.gateFor()), /not ready to send/);
  h.run().status = 'sending'; h.run().day = '2026-12-01';
  await assert.rejects(h.begin(h.gateFor()), /business day changed/);
  h.run().day = '2026-12-02';
  const gate = h.gateFor(), changed = freezeWriteRequest(scope, 'POST', 'batch?requestid=' + 'e'.repeat(32), { BatchItemRequest: [{ bId: '1', operation: 'create', Customer: { DisplayName: 'Someone Else' } }] });
  await assert.rejects(gate.preflight({ request: changed, client: h.client }), /differs from its saved identity|could not be verified/);
  // A general workflow cannot ride an ordinary single-record request.
  await assert.rejects(h.gateFor().begin({ request: freezeWriteRequest(scope, 'POST', 'customer', { DisplayName: 'X' }), ownerId, actorId: ownerId, workflow: { version: 1, kind: 'general-write', runId, batchIndex: 0, sends: 1 }, periodEvidence: {} }), /exact reviewed batch runtime/);
  assert.equal(h.data.Receipts.length, 0);
});
