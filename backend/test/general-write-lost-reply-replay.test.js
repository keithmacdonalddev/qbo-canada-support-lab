'use strict';
// The general-write-v1 batch transport through the real company write gate, on in-memory
// storage: receipt and writer barrier before sending, per-item period proof, per-item
// classification, settlement on the run, lost-response replay under the same requestid,
// and refusal of anything that is not the exact saved batch. No QuickBooks or database.
const test = require('node:test'), assert = require('node:assert/strict');
const { createQboWriteGate } = require('../src/modules/qbo-write-gate');
const { createGeneralGateTransport, buildGeneralBatch } = require('../src/modules/general-write-transport');
const { createGeneralWriteService } = require('../src/modules/general-write-service');
const { freezeWriteRequest } = require('../src/modules/qbo-write-contract');
const { controls } = require('./helpers/period-controls');
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.JOB_L_REPLAY_FILE || require.resolve('./fixtures/job-l-po-lost-reply.json'), 'utf8'));
const scope = { environment: fixture.run.environment, realmId: fixture.run.realmId, connectionId: String(fixture.run.connectionId) }, ownerId = String(fixture.run.ownerId), runId = fixture.run._id;
const clone = value => structuredClone(value);
const at = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && !(value instanceof Date) ? ('$in' in value ? value.$in.includes(at(row, key)) : '$lte' in value ? new Date(at(row,key)) <= value.$lte : '$ne' in value ? at(row,key) !== value.$ne : '$elemMatch' in value ? at(row,key)?.some(entry=>matches(entry,value.$elemMatch)) : '$exists' in value ? (at(row, key) !== undefined) === value.$exists : false) : at(row, key) === value);
function harness() {
  const h = { clock: Date.parse('2026-12-02T15:00:00.000Z'), data: { Policies: [], Writers: [], Receipts: [], Audits: [], Connections: [], Memberships: [], Runs: [], Calendars: [], Steps: [], Users: [], Agents: [], GeneralWriteRuns: [] } };
  h.data.Policies.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, state: 'active', periodControl: controls(scope, ownerId, h.clock) });
  h.data.Writers.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, operationId: null, planHash: null, unresolved: null });
  h.data.Connections.push({ _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' });
  h.data.Memberships.push({ _id: 'membership', userId: ownerId, realmId: scope.realmId, status: 'active', role: 'lab-owner', permissionOverrides: [], businessSetupVersion: 0 });
  h.data.Users.push({ _id: ownerId, role: 'agent', connectionSwitchVersion: 0 });
  const items = [{ bId: '1', ref: 'cust', op: 'create', entity: 'Customer', operation: 'create', payload: { DisplayName: 'Harbour Clinic', CurrencyRef: { value: 'CAD' } } }, { bId: '2', ref: 'vend', op: 'create', entity: 'Vendor', operation: 'create', payload: { DisplayName: 'Coastal Power', CurrencyRef: { value: 'CAD' } } }];
  h.data.GeneralWriteRuns.push({ _id: runId, contract: 'general-write-v1', ...scope, ownerId, actorId: ownerId, agentAuthority: null, decisionKey: 'general-day-0001', day: '2026-12-02', status: 'sending', plan: { operations: [], layers: [['cust','vend']] }, batches: [{ index: 0, attempt: 1, requestId: 'e'.repeat(32), items, state: 'sending', sends: 1 }], items: {}, owned: [], dirty: [], revision: 3 });
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, {
    find(filter) { const query = { sort() { return query; }, limit() { return query; }, session() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.data[name].filter(row => matches(row, filter))) }; return query; },
    findOne(filter) { const query = { select() { return query; }, sort() { return query; }, session() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.data[name].find(row => matches(row, filter)) || null) }; return query; },
    findOneAndUpdate(filter, change) { return { select() { return this; }, lean: async () => { const row = h.data[name].find(value => matches(value, filter)); if (!row) return null; Object.assign(row, clone(change.$set || {})); for (const [key, value] of Object.entries(change.$inc || {})) row[key] = (row[key] ?? 0) + value; return clone(row); } }; },
    async create(rows) { for (const row of rows) { if (h.data[name].some(value => value._id === row._id)) throw new Error('duplicate'); h.data[name].push(clone(row)); } },
  }]));
  let queue = Promise.resolve();
  h.transaction = work => { const result = queue.then(async () => { const before = clone(h.data); let output; try { output = await work({ inTransaction: () => true }); } catch (error) { h.data = before; throw error; } if(h.loseReply){h.loseReply=false;throw new Error('commit reply lost');} return output; }); queue = result.catch(() => {}); return result; };
  h.context = { day: '2026-12-02', verifiedThrough: '2026-12-01', protectedThrough: '2026-10-31', taxCodes: { sales: ['7'], purchases: ['7'] } };
  h.records = new Map();
  h.copy = { read: async (scope, entity, id) => clone(h.records.get(entity + ':' + id) || null) };
  h.service = createGeneralWriteService({ models: h.models, copy: h.copy, contextFor: async () => h.context, dispatchEnabled: () => true, now: () => h.clock });
  h.gateFor = (batchIndex = 0) => createQboWriteGate({ ...h.models, transaction: h.transaction, assertReady: async () => {}, now: () => h.clock, generalTransport: createGeneralGateTransport({ models: h.models, scope, runId, batchIndex, admissionGuard: input => h.service.guardBatch(input), now: () => h.clock }) });
  h.client = { read: async () => { throw new Error('no linked reads expected'); }, query: async () => ({ QueryResponse: { Preferences: [{ AccountingInfoPrefs: {}, SalesFormsPrefs: { AutoApplyCredit: false } }] } }) };
  h.run = () => h.data.GeneralWriteRuns[0]; h.writer = () => h.data.Writers[0];
  h.request = () => buildGeneralBatch(scope, h.run().batches[0]);
  h.begin = async (gate, sends = 1) => { const request = h.request(), evidence = await gate.preflight({ request, client: h.client }); return gate.begin({ request, ownerId, actorId: ownerId, workflow: { version: 1, kind: 'general-write', runId, batchIndex: 0, sends }, periodEvidence: evidence }); };
  return h;
}
function storedHarness() {
  const h = harness();
  h.transaction = async work => { const before = clone(h.data); try { return await work({}); } catch (error) { h.data = before; throw error; } };
  h.clock = Date.parse(fixture.run.updatedAt) + 120000;
  h.data.GeneralWriteRuns = [clone(fixture.run)];
  h.data.Writers = [clone(fixture.writer)];
  h.data.Receipts = [clone(fixture.receipt)];
  h.records.set('PurchaseOrder:11216', clone(fixture.mirror.record));
  const a = h.run().agentAuthority;
  h.data.Agents = [{ _id: a.agentId, ...scope, ownerId: a.ownerId, settings: { monitoring: true, autonomous: true }, grant: { id: a.grantId, authorityHash: a.authorityHash, ownerId: a.ownerId } }];
  let sends = 0;
  const transport = {
    sendBatch: async () => { sends++; throw new Error('A retained accepted PO must never dispatch'); },
    recoverBatch: async (s, { batch }) => h.gateFor().recoverGeneral({ request: buildGeneralBatch(s, batch), receiptId: batch.transport.receiptId, response: { status: 200, json: { BatchItemResponse: batch.transport.response } } }),
  };
  const service = createGeneralWriteService({ models: h.models, copy: h.copy, transport, dispatchEnabled: () => true, now: () => h.clock, contextFor: async () => { throw new Error('No new admission or plan is allowed'); } });
  return { h, service, sends: () => sends };
}

test('stored PO11216 reply is automatically attributed on the existing wake with zero resends', async () => {
  const { h, service, sends } = storedHarness();
  const { recheckGeneralWrites } = require('../src/modules/general-write-recovery');
  // Invoke the same recovery callback used before history checks on each wake.
  let guards = 0;
  const result = await recheckGeneralWrites({ scope, models: h.models, now: () => h.clock, service, guard: async () => { guards++; } });
  assert.equal(result[0].ok, true, JSON.stringify({result,error:h.run().errorDetail})); assert.equal(guards, 1);
  assert.equal(sends(), 0);
  assert.equal(h.data.Receipts.length, 1); assert.equal(h.data.Receipts[0].state, 'saved');
  assert.equal(h.writer().unresolved, null);
  assert.equal(h.writer().resourceClaims.length, 0);
  assert.equal(h.run().batches[0].requestId, fixture.run.batches[0].requestId);
  assert.equal(h.run().batches[0].sends, 1);
  assert.equal(h.data.Receipts[0].dispatchKey, fixture.receipt.dispatchKey);
  const item = h.run().items['winter-access-order'];
  assert.equal(item.qboId, '11216'); assert.equal(item.outcome, 'saved');
  assert.equal(h.run().status, 'complete');assert.equal(item.errorDetail,undefined);
  assert.ok(h.run().owned.some(row => row.key === 'PurchaseOrder:11216'));
  assert.equal(h.run().batches[0].state, 'answered');
  const again = await service.execute({ scope, ownerId, actorId: ownerId, agentAuthority: fixture.run.agentAuthority }, runId);
  assert.equal(again.items['winter-access-order'].qboId, '11216');assert.equal(sends(), 0);
});

for (const kind of ['body', 'request', '500', 'null-status', 'identity', 'duplicate-item']) test('retained attribution refuses ' + kind + ' evidence and keeps the receipt barrier', async () => {
  const { h, service, sends } = storedHarness();
  if (kind === 'body') h.run().batches[0].transport.response[0].PurchaseOrder.TotalAmt++;
  if (kind === 'request') h.run().batches[0].items[0].payload.PrivateNote += ' changed';
  if (kind === '500') h.data.Receipts[0].observed.httpStatus = 500;
  if (kind === 'null-status') h.data.Receipts[0].observed.httpStatus = null;
  if (kind === 'identity') h.data.Receipts[0].general.requestId = 'f'.repeat(32);
  if (kind === 'duplicate-item') { h.run().batches[0].transport.response.push(clone(h.run().batches[0].transport.response[0])); }
  await assert.rejects(service.execute({ scope, ownerId, actorId: ownerId }, runId));
  assert.equal(sends(), 0); assert.equal(h.data.Receipts[0].state, 'unknown'); assert.ok(h.writer().unresolved);
});

test('wake filters answered, owner and revoked-grant rows before applying its bounded limit', async () => {
  const { h } = storedHarness(), { recheckGeneralWrites } = require('../src/modules/general-write-recovery');
  let executed = 0,queries=0;
  h.models.GeneralWriteRuns.find = filter => {
    queries++;const uncertain=typeof filter.status==='object';
    if(uncertain){assert.deepEqual(filter.status,{$in:['unknown','sending']});assert.deepEqual(filter.batches,{$elemMatch:{state:{$ne:'answered'}}});}
    else{assert.equal(filter.status,'needs-correction');assert.deepEqual(filter.batches,{$elemMatch:{state:'answered','transport.outcome':'saved','items.entity':'PurchaseOrder'}});}
    for(const key of ['realmId','environment','connectionId'])assert.equal(filter[key],scope[key]);assert.equal(filter['agentAuthority.ownerId'],fixture.run.ownerId);
    assert.equal(filter['agentAuthority.grantId'], fixture.run.agentAuthority.grantId);
    assert.equal(filter['agentAuthority.agentId'], fixture.run.agentAuthority.agentId);
    assert.equal(filter['agentAuthority.authorityHash'], fixture.run.agentAuthority.authorityHash);
    assert.equal(filter.ownerId, fixture.run.ownerId);
    return { sort() { return this; }, limit(n) { assert.equal(n, uncertain?3:2);return this; }, maxTimeMS() { return this; }, lean: async () => uncertain?[clone(fixture.run)]:[] };
  };
  await recheckGeneralWrites({ scope, models: h.models, now: () => h.clock, service: { execute: async () => { executed++;return { status: 'complete' }; } } });
  assert.equal(executed, 1);assert.equal(queries,2);
  h.data.Agents[0].settings.autonomous = false;
  assert.deepEqual(await recheckGeneralWrites({ scope, models: h.models, now: () => h.clock, service: { execute: async () => { throw new Error('revoked'); } } }), []);
});

test('a hash-bound partial reply falls back only to the exact original batch replay', async () => {
  const { h } = storedHarness();
  const batch = h.run().batches[0], { hash } = require('../src/modules/business-calendar');
  batch.transport.response = [];
  h.data.Receipts[0].observed.responseHash = hash({ BatchItemResponse: [] });
  let sent = 0;
  const service = createGeneralWriteService({ models: h.models, copy: h.copy, contextFor: async () => { throw new Error('No new work'); }, dispatchEnabled: () => true, now: () => h.clock, transport: {
    recoverBatch: async (s, { batch }) => h.gateFor().recoverGeneral({ request: buildGeneralBatch(s,batch), receiptId: batch.transport.receiptId, response: { status:200, json:{BatchItemResponse:batch.transport.response} } }),
    sendBatch: async (s, { batch }) => { sent++; assert.equal(batch.requestId,fixture.run.batches[0].requestId);assert.deepEqual(batch.items,fixture.run.batches[0].items);throw Object.assign(new Error('lost again'),{lost:true}); },
  } });
  const result = await service.execute({scope,ownerId,actorId:ownerId},runId);
  assert.equal(sent,1);assert.equal(result.status,'unknown');assert.ok(h.writer().unresolved);assert.equal(h.data.Receipts[0].state,'unknown');
});
