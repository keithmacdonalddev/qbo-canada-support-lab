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
  h.data.GeneralWriteRuns.push({ _id: runId, contract: 'general-write-v1', ...scope, ownerId, actorId: ownerId, agentAuthority: null, decisionKey: 'general-day-0001', day: '2026-12-02', status: 'sending', plan: { operations: [], layers: [['cust','vend']] }, batches: [{ index: 0, attempt: 1, requestId: 'e'.repeat(32), items, state: 'sending', sends: 1 }], items: {}, owned: [], dirty: [], revision: 3 });
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, {
    find(filter) { const query = { limit() { return query; }, session() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.data[name].filter(row => matches(row, filter))) }; return query; },
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
const answered = { status: 200, json: { BatchItemResponse: [{ bId: '1', Customer: { Id: '61', SyncToken: '0', DisplayName: 'Harbour Clinic', CurrencyRef: { value: 'CAD' } } }, { bId: '2', Fault: { type: 'ValidationFault', Error: [{ code: '6240', Message: 'Duplicate Name Exists Error' }] } }] } };

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
  await assert.rejects(other.preflight({ request, client: h.client }), /owns this company/);
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

test('settlement revision is reloaded and the successful run completes without losing items', async () => {
  const h = harness();
  const response = { status: 200, json: { BatchItemResponse: h.run().batches[0].items.map((item,n) => ({ bId: item.bId, [item.entity]: { ...item.payload, Id: String(61+n), SyncToken: '0', MetaData: {} } })) } };
  const transport = { sendBatch: async (scope, { batch }) => { const gate = h.gateFor(), ticket = await h.begin(gate,batch.sends); await gate.complete(ticket,h.request(),response,'tid-ok'); return response.json.BatchItemResponse; } };
  const service = createGeneralWriteService({ models:h.models,copy:h.copy,contextFor:async()=>h.context,transport,dispatchEnabled:()=>true,now:()=>h.clock });
  const result = await service.execute({scope,ownerId,actorId:ownerId},runId);
  assert.equal(result.status,'complete'); assert.equal(result.items.cust.outcome,'saved'); assert.equal(result.items.vend.outcome,'saved');
  assert.equal(h.run().batches[0].state,'answered'); assert.equal(h.writer().unresolved,null); assert.equal(h.data.Receipts.length,1);
});

test('an overnight lost response replays only its admitted identity and releases the writer', async () => {
  const h=harness(),gate=h.gateFor(),ticket=await h.begin(gate);
  await gate.failTransport(ticket,h.request(),{});
  h.clock+=86400000; h.context.day='2026-12-03';
  const replayGate=h.gateFor(),replay=await h.begin(replayGate,2);
  assert.equal(h.data.Receipts[1].general.requestId,h.data.Receipts[0].general.requestId);
  await replayGate.complete(replay,h.request(),answered,'overnight');
  assert.equal(h.writer().unresolved,null);
});

test('resumed saved batches rerun full balance, amount and inventory guards inside admission', async () => {
  for (const kind of ['balance','cap','inventory']) {
    const h=harness();
    h.records.set('Customer:1',{Id:'1',Active:true});
    h.records.set('Invoice:100',{Id:'100',SyncToken:'0',TxnDate:'2026-11-20',Balance:10,TotalAmt:100,CustomerRef:{value:'1'}});
    h.records.set('Account:50',{Id:'50',AccountType:'Bank',Active:true});
    h.records.set('Account:51',{Id:'51',AccountType:'Other Current Asset',AccountSubType:kind==='inventory'?'Inventory':'UndepositedFunds',Active:true});
    const item=kind==='balance'?{bId:'1',ref:'pay',op:'create',operation:'create',entity:'Payment',payload:{TxnDate:'2026-12-02',CustomerRef:{value:'1'},TotalAmt:50,Line:[{Amount:50,LinkedTxn:[{TxnId:'100',TxnType:'Invoice'}]}]}}:{bId:'1',ref:'move',op:'create',operation:'create',entity:'Transfer',payload:{TxnDate:'2026-12-02',Amount:kind==='cap'?10000000:50,FromAccountRef:{value:'50'},ToAccountRef:{value:'51'}}};
    h.run().batches[0].items=[item];h.run().batches[0].state='lost';h.run().plan.operations=[item];
    const runtime=createGeneralGateTransport({models:h.models,scope,runId,batchIndex:0,now:()=>h.clock,admissionGuard:input=>h.service.guardBatch(input)});
    await assert.rejects(runtime.admit({request:h.request(),receiptId:'receipt',dispatchKey:'dispatch',writer:h.writer(),ownerId,actorId:ownerId,session:{}}),kind==='balance'?/has \$10 open/:kind==='cap'?/moves at most/:/inventory asset account/);
    assert.equal(h.data.Receipts.length,0);assert.equal(h.writer().unresolved,null);
  }
});

test('a mismatched successful response keeps the general company barrier', async () => {
  const h=harness(),gate=h.gateFor(),ticket=await h.begin(gate);
  const wrong=clone(answered);wrong.json.BatchItemResponse[0].Customer.DisplayName='Wrong customer';
  const result=await gate.complete(ticket,h.request(),wrong,'wrong');
  assert.equal(result.outcome,'unknown');assert.equal(h.writer().unresolved.kind,'general-write');
});

test('a durable duplicate response stays unknown after restart while valid siblings are retained',async()=>{
  const h=harness(),gate=h.gateFor(),ticket=await h.begin(gate);
  const response={status:200,json:{BatchItemResponse:[{bId:'1',Customer:{...h.run().batches[0].items[0].payload,Id:'61',SyncToken:'0'}},{bId:'1',Customer:{...h.run().batches[0].items[0].payload,Id:'62',SyncToken:'0'}},{bId:'2',Vendor:{...h.run().batches[0].items[1].payload,Id:'63',SyncToken:'0'}}]}};
  await gate.complete(ticket,h.request(),response,'duplicate');
  let sends=0;
  const service=createGeneralWriteService({models:h.models,copy:h.copy,contextFor:async()=>h.context,transport:{sendBatch:async()=>{sends++;throw new Error('must not resend');}},dispatchEnabled:()=>true,now:()=>h.clock});
  const result=await service.execute({scope,ownerId,actorId:ownerId},runId);
  assert.equal(result.status,'unknown');assert.equal(result.items.cust.outcome,'unknown');assert.equal(result.items.vend.outcome,'saved');assert.equal(sends,0);assert.ok(h.writer().unresolved);
});

test('a balance consumed after preflight is refused at transactional admission',async()=>{
  const h=harness();h.records.set('Customer:1',{Id:'1',Active:true});
  const invoice={Id:'100',SyncToken:'0',TxnDate:'2026-11-20',Balance:100,TotalAmt:100,CustomerRef:{value:'1'}};
  h.records.set('Invoice:100',invoice);h.client.read=async(entity,id)=>({[entity[0].toUpperCase()+entity.slice(1)]:clone(h.records.get('Invoice:'+id))});
  const item={bId:'1',ref:'pay',op:'create',operation:'create',entity:'Payment',payload:{TxnDate:'2026-12-02',CustomerRef:{value:'1'},TotalAmt:50,Line:[{Amount:50,LinkedTxn:[{TxnId:'100',TxnType:'Invoice'}]}]}};
  h.run().batches[0].items=[item];h.run().plan.operations=[item];
  const gate=h.gateFor(),request=h.request(),evidence=await gate.preflight({request,client:h.client});
  invoice.Balance=10;
  await assert.rejects(gate.begin({request,ownerId,actorId:ownerId,workflow:{version:1,kind:'general-write',runId,batchIndex:0,sends:1},periodEvidence:evidence}),/differs from its fresh linked-record evidence|has \$10 open/);
  assert.equal(h.data.Receipts.length,0);assert.equal(h.writer().unresolved,null);
});

test('an oversized durable response without item proofs stays unknown after restart',async()=>{
  const h=harness(),gate=h.gateFor(),ticket=await h.begin(gate);
  const response={status:200,json:{BatchItemResponse:h.run().batches[0].items.map((item,n)=>({bId:item.bId,[item.entity]:{...item.payload,Id:String(61+n),SyncToken:'0'}})).concat(Array.from({length:29},(_,n)=>({bId:String(n+3),Customer:{Id:String(n+100),SyncToken:'0'}})))}};
  await gate.complete(ticket,h.request(),response,'oversized');
  assert.deepEqual(h.run().batches[0].transport.items,[]);
  let sends=0;const service=createGeneralWriteService({models:h.models,copy:h.copy,contextFor:async()=>h.context,transport:{sendBatch:async()=>{sends++;}},dispatchEnabled:()=>true,now:()=>h.clock});
  const result=await service.execute({scope,ownerId,actorId:ownerId},runId);
  assert.equal(result.status,'unknown');assert.equal(result.items.cust.outcome,'unknown');assert.equal(result.items.vend.outcome,'unknown');assert.equal(sends,0);assert.ok(h.writer().unresolved);
});

for (const operation of ['update', 'delete']) test('overnight lost saved ' + operation + ' replays its admitted receipt after the target changes or disappears', async () => {
  const h = harness();
  const original = { Id: '61', SyncToken: '0', DisplayName: 'Harbour Clinic' };
  const item = { bId: '1', ref: 'change', op: operation, operation, entity: 'Customer', id: '61', before: original, payload: { Id: '61', SyncToken: '0', ...(operation === 'update' ? { sparse: true, DisplayName: 'Harbour Clinic Ltd' } : {}) } };
  h.run().batches[0].items = [item];
  let current = original, reads = 0;
  h.client.read = async () => { reads++; return current ? { Customer: clone(current) } : {}; };
  const gateFor = () => createQboWriteGate({ ...h.models, transaction: h.transaction, assertReady: async () => {}, now: () => h.clock, generalTransport: createGeneralGateTransport({ models: h.models, scope, runId, batchIndex: 0, admissionGuard: async () => {}, now: () => h.clock }) });
  const gate = gateFor(), request = h.request(), ticket = await h.begin(gate);
  current = operation === 'update' ? { ...original, SyncToken: '1', DisplayName: 'Harbour Clinic Ltd' } : null;
  await gate.failTransport(ticket, request, {});
  h.clock += 86400000;
  reads = 0;
  const replayGate = gateFor(), replay = await h.begin(replayGate, 2);
  assert.equal(reads, 0, 'recovery must not require the pre-write target to still exist unchanged');
  assert.equal(h.data.Receipts[1].periodProof.replay.receiptId, ticket.receiptId);
  assert.equal(h.data.Receipts[1].general.requestId, h.data.Receipts[0].general.requestId);
  const result = await replayGate.complete(replay, request, { status: 200, json: { BatchItemResponse: [{ bId: '1', Customer: current || { Id: '61', status: 'Deleted' } }] } }, 'recovered');
  assert.equal(result.outcome, 'saved');
  assert.equal(h.writer().unresolved, null);
});

for (const operation of ['update','delete']) test('an overnight lost '+operation+' response replays the exact admitted request after its target changes',async()=>{
  const h=harness(),before={Id:'100',SyncToken:'0',TxnDate:'2026-12-02',Amount:50,FromAccountRef:{value:'50'},ToAccountRef:{value:'51'}};
  h.records.set('Transfer:100',before);
  for(const id of ['50','51'])h.records.set('Account:'+id,{Id:id,AccountType:'Bank',Active:true});
  h.data.Steps.push({environment:scope.environment,realmId:scope.realmId,entity:'Transfer',qboId:'100',state:'verified'});
  const item={bId:'1',ref:'move',op:operation,operation,entity:'Transfer',id:'100',before:clone(before),payload:{Id:'100',SyncToken:'0',...(operation==='update'?{Amount:60,sparse:true}:{})}};
  h.run().batches[0].items=[item];h.run().plan.operations=[{...item,payload:operation==='update'?{Amount:60}:{}}];
  h.client.read=async()=>({Transfer:clone(h.records.get('Transfer:100'))});
  const gate=h.gateFor(),request=h.request(),ticket=await h.begin(gate);
  const record=operation==='update'?{...before,Amount:60,SyncToken:'1'}:{Id:'100',status:'Deleted'};
  if(operation==='update')h.records.set('Transfer:100',record);else h.records.delete('Transfer:100');
  await gate.failTransport(ticket,request,{});
  h.clock+=86400000;h.context.day='2026-12-03';h.client.read=async()=>{throw Error('an admitted replay must not require the old target version');};
  const replayGate=h.gateFor(),replay=await h.begin(replayGate,2);
  assert.equal(h.data.Receipts[1].requestHash,h.data.Receipts[0].requestHash);
  assert.equal(h.data.Receipts[1].periodProof.replay.receiptId,h.data.Receipts[0]._id);
  assert.deepEqual(h.data.Receipts[1].periodProof.proofs,h.data.Receipts[0].periodProof.proofs);
  await replayGate.complete(replay,request,{status:200,json:{BatchItemResponse:[{bId:'1',Transfer:record}]}},'recovered');
  assert.equal(h.writer().unresolved,null);assert.equal(h.data.Receipts[1].state,'saved');
});

test('an exact overnight replay still checks fresh QuickBooks closing preferences',async()=>{
  const h=harness(),item={bId:'1',ref:'move',op:'create',operation:'create',entity:'Transfer',payload:{TxnDate:'2026-12-02',Amount:50,FromAccountRef:{value:'50'},ToAccountRef:{value:'51'}}};
  for(const id of ['50','51'])h.records.set('Account:'+id,{Id:id,AccountType:'Bank',Active:true});
  h.run().batches[0].items=[item];h.run().plan.operations=[item];
  const gate=h.gateFor(),ticket=await h.begin(gate);await gate.failTransport(ticket,h.request(),{});
  h.clock+=86400000;h.client.query=async()=>({QueryResponse:{Preferences:[{AccountingInfoPrefs:{BookCloseDate:'2026-12-02'}}]}});
  await assert.rejects(h.begin(h.gateFor(),2),/closed or reconciled period/);
  assert.equal(h.data.Receipts.length,1);assert.ok(h.writer().unresolved);
});


function resourceBatch(h, index, invoice = String(100 + index), customer = String(10 + index)) {
  const item = { bId: '1', ref: 'payment-' + index, op: 'create', operation: 'create', entity: 'Payment', payload: { TxnDate: '2026-12-02', CustomerRef: { value: customer }, TotalAmt: 10, Line: [{ Amount: 10, LinkedTxn: [{ TxnId: invoice, TxnType: 'Invoice' }] }] } };
  const batch = { index, requestId: String(index + 1).padStart(32, '0'), items: [item], state: 'sending', sends: 1 };
  h.run().batches.push(batch);
  const request = buildGeneralBatch(scope, batch);
  const client = { ...h.client, read: async (entity, id) => ({ [entity[0].toUpperCase() + entity.slice(1)]: { Id: id, SyncToken: '0', TxnDate: '2026-11-20', CustomerRef: { value: customer }, TotalAmt: 10, Balance: 10 } }) };
  const gate = createQboWriteGate({ ...h.models, transaction: h.transaction, assertReady: async () => {}, now: () => h.clock, generalTransport: createGeneralGateTransport({ models: h.models, scope, runId, batchIndex: index, admissionGuard: async () => {}, now: () => h.clock }) });
  const preflight = () => gate.preflight({ request, client });
  const admit = periodEvidence => gate.begin({ request, ownerId, actorId: ownerId, workflow: { version: 1, kind: 'general-write', runId, batchIndex: index, sends: 1 }, periodEvidence });
  const begin = async () => admit(await preflight());
  const finish = ticket => gate.complete(ticket, request, { status: 200, json: { BatchItemResponse: [{ bId: '1', Payment: { ...item.payload, Id: String(500 + index), SyncToken: '0' } }] } });
  return { batch, request, gate, client, preflight, admit, begin, finish };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
test('two disjoint accountant batches are both admitted before either dispatch settles', async () => {
  const h = harness(), a = resourceBatch(h, 1), b = resourceBatch(h, 2);
  const [ta, tb] = await Promise.all([a.begin(), b.begin()]);
  assert.equal(h.data.Receipts.length, 2);
  assert.equal(h.writer().resourceClaims.filter(row => row.state === 'admitted').length, 2);
  await Promise.all([a.finish(ta), b.finish(tb)]);
  assert.deepEqual(h.writer().resourceClaims, []);
});
test('batches paying the same invoice queue in FIFO order and read fresh after grant', async () => {
  const h = harness(), a = resourceBatch(h, 1, '100', '10'), b = resourceBatch(h, 2, '100', '10'), c = resourceBatch(h, 3, '100', '10');
  const ta = await a.begin(), order = [];
  let bRead = false; b.client.read = async (entity, id) => { bRead = true; return { [entity[0].toUpperCase() + entity.slice(1)]: { Id: id, SyncToken: '1', TxnDate: '2026-11-20' } }; };
  const pb = b.begin().then(ticket => { order.push('b'); return ticket; });
  await tick(); const pc = c.begin().then(ticket => { order.push('c'); return ticket; });
  await tick(); assert.equal(bRead, false); assert.deepEqual(order, []);
  await a.finish(ta); const tb = await pb; assert.equal(bRead, true); assert.deepEqual(order, ['b']);
  await b.finish(tb); const tc = await pc; assert.deepEqual(order, ['b', 'c']); await c.finish(tc);
});
test('an unknown outcome holds only its resources and party/entity, leaving disjoint work free', async () => {
  const h = harness(), a = resourceBatch(h, 1), ta = await a.begin();
  await a.gate.failTransport(ta, a.request, {});
  const overlaps = resourceBatch(h, 2, '101', '99'), sameParty = resourceBatch(h, 3, '999', '11');
  await assert.rejects(overlaps.preflight(), /unknown request owns/);
  await assert.rejects(sameParty.preflight(), /unknown request owns/);
  const disjoint = resourceBatch(h, 4), td = await disjoint.begin(); await disjoint.finish(td);
  assert.equal(h.writer().resourceClaims.length, 1); assert.equal(h.writer().resourceClaims[0].state, 'unknown');
  h.clock += 86400000;
  await assert.rejects(overlaps.preflight(), /unknown request owns/);
});
test('company concurrency is capped at four requests and ended unknowns release their slots', async () => {
  const h = harness(), batches = [1,2,3,4,5].map(n => resourceBatch(h,n));
  const tickets = await Promise.all(batches.slice(0,4).map(b => b.begin()));
  let fifth = false; const waiting = batches[4].begin().then(t => { fifth = true; return t; });
  await tick(); assert.equal(fifth, false);
  await batches[0].gate.failTransport(tickets[0], batches[0].request, {});
  const last = await waiting; assert.equal(fifth, true);
  await Promise.all(batches.slice(1,4).map((b,i) => b.finish(tickets[i+1]))); await batches[4].finish(last);
  assert.equal(h.writer().resourceClaims.length, 1);
});
test('preflight or admission failures release only unsent reservations; policy changes remain fenced', async () => {
  const h = harness(), a = resourceBatch(h,1);
  const proof = await a.preflight(); h.data.Policies[0].revision++;
  await assert.rejects(a.admit(proof), /protected-period choices changed/);
  assert.deepEqual(h.writer().resourceClaims, []); assert.equal(h.data.Receipts.length,0);
  a.client.query = async () => { throw new Error('fixture'); };
  await assert.rejects(a.preflight(), /could not be verified/); assert.deepEqual(h.writer().resourceClaims, []);
});
test('history edits are exclusive against every disjoint admitted and queued batch', async () => {
  const h = harness(), a = resourceBatch(h,1), history = resourceBatch(h,2), later = resourceBatch(h,3);
  history.batch.items = [{ bId:'1',ref:'edit',op:'update',operation:'update',entity:'Invoice',id:'77',before:{Id:'77',SyncToken:'0',TxnDate:'2026-11-20'},payload:{Id:'77',SyncToken:'0',TxnDate:'2026-11-20',CustomerRef:{value:'90'},Line:[]} }];
  const request = buildGeneralBatch(scope,history.batch);
  const ta = await a.begin(); let gotHistory = false, gotLater = false;
  const ph = history.gate.preflight({request,client:history.client}).then(e => {gotHistory=true;return e;});
  await tick(); const pl = later.preflight().then(e=>{gotLater=true;return e;});
  await tick(); assert.equal(gotHistory,false); assert.equal(gotLater,false);
  await a.finish(ta); const evidence = await ph; assert.equal(gotHistory,true); assert.equal(gotLater,false);
  // Refuse an invalidated historical plan before transport, releasing its exclusive reservation.
  h.data.Policies[0].revision++;
  await assert.rejects(history.gate.begin({request,ownerId,actorId:ownerId,workflow:{version:1,kind:'general-write',runId,batchIndex:2,sends:1},periodEvidence:evidence}));
  const final = await later.admit(await pl); await later.finish(final);
});

test('a possibly-sent exact batch resumes after lost admission acknowledgement without losing resources', async () => {
  const h=harness(), gate=h.gateFor();
  // Simulate a transaction committed but the caller never obtained its ticket.
  const periodEvidence=await gate.preflight({request:h.request(),client:h.client}); h.loseReply=true;
  await assert.rejects(gate.begin({request:h.request(),ownerId,actorId:ownerId,workflow:{version:1,kind:'general-write',runId,batchIndex:0,sends:1},periodEvidence}),/commit reply lost/);
  assert.equal(h.data.Receipts[0].state,'possibly-sent');
  assert.equal(h.writer().resourceClaims[0].state,'admitted');
  const firstId=h.data.Receipts[0]._id, replayGate=h.gateFor(), replay=await h.begin(replayGate,2);
  assert.notEqual(replay.receiptId,firstId);
  assert.equal(h.data.Receipts.length,2);
  assert.equal(h.data.Receipts[1].general.requestId,h.data.Receipts[0].general.requestId);
  await replayGate.complete(replay,h.request(),answered,'recovered');
  assert.deepEqual(h.writer().resourceClaims,[]);
});
test('an old scalar unknown keeps its exact replay recovery and never admits unrelated work', async () => {
  const h=harness(),gate=h.gateFor(),ticket=await h.begin(gate);
  await gate.failTransport(ticket,h.request(),{});
  delete h.writer().resourceClaims; delete h.writer().resourceQueue;
  const before=clone(h.writer().unresolved);
  h.run().batches.push({index:1,requestId:'f'.repeat(32),items:[{...h.run().batches[0].items[0],payload:{DisplayName:'Different'}}],state:'sending',sends:1});
  const other=h.gateFor(1),request=buildGeneralBatch(scope,h.run().batches[1]);
  const evidence=await other.preflight({request,client:h.client});
  await assert.rejects(other.begin({request,ownerId,actorId:ownerId,workflow:{version:1,kind:'general-write',runId,batchIndex:1,sends:1},periodEvidence:evidence}),/owns this company/);
  assert.deepEqual(h.writer().unresolved,before);
  const replayGate=h.gateFor(),replay=await h.begin(replayGate,2);await replayGate.complete(replay,h.request(),answered,'legacy');
  assert.equal(h.writer().unresolved,null);
});
test('an exact unknown replay waits for a request slot beside four active disjoint batches', async () => {
  const h=harness(),original=resourceBatch(h,1),ticket=await original.begin();await original.gate.failTransport(ticket,original.request,{});
  const others=[2,3,4,5].map(n=>resourceBatch(h,n)),tickets=await Promise.all(others.map(b=>b.begin()));
  let ready=false; const proof=original.preflight().then(e=>{ready=true;return e;});
  await tick();assert.equal(ready,false);
  await others[0].finish(tickets[0]);await proof;assert.equal(ready,true);
  // Use the next deduplicated transport attempt, preserving original requestid.
  const replay=await original.gate.begin({request:original.request,ownerId,actorId:ownerId,workflow:{version:1,kind:'general-write',runId,batchIndex:1,sends:2},periodEvidence:await proof});
  await original.finish(replay);await Promise.all(others.slice(1).map((b,i)=>b.finish(tickets[i+1])));
});

test('a live original attempt cannot be replayed or lose ownership of its definite response', async () => {
  const h=harness(),gate=h.gateFor(),ticket=await h.begin(gate);
  await assert.rejects(h.begin(h.gateFor(),2),/in-flight request/);
  assert.equal(h.data.Receipts.length,1);
  await gate.complete(ticket,h.request(),answered,'original');
  assert.equal(h.data.Receipts[0].state,'saved');assert.deepEqual(h.writer().resourceClaims,[]);
});

test('disjoint service invoices sharing one Item dispatch together with fresh provider Type proof', async () => {
  for (const providerType of ['Service','Inventory']) {
    const h=harness();
    h.models.Records={findOne(){const q={session(){return q;},maxTimeMS(){return q;},lean:async()=>({record:{Id:'9',Type:'Service'}})};return q;}};
    const create=index=>{
      const b=resourceBatch(h,index);
      b.batch.items=[{bId:'1',ref:'sale-'+index,op:'create',operation:'create',entity:'Invoice',payload:{TxnDate:'2026-12-02',CustomerRef:{value:String(index)},Line:[{Amount:10,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:'9'},Qty:1,UnitPrice:10}}]}}];
      const request=buildGeneralBatch(scope,b.batch);b.client.read=async(entity,id)=>({Item:{Id:id,SyncToken:'0',Type:providerType}});
      return { ...b,request,begin:async()=>b.gate.begin({request,ownerId,actorId:ownerId,workflow:{version:1,kind:'general-write',runId,batchIndex:index,sends:1},periodEvidence:await b.gate.preflight({request,client:b.client})}) };
    };
    const a=create(1),b=create(2);
    if(providerType==='Inventory') {
      await assert.rejects(a.begin(),/no longer a verified service/);assert.equal(h.data.Receipts.length,0);assert.deepEqual(h.writer().resourceClaims,[]);
    } else {
      const [ta,tb]=await Promise.all([a.begin(),b.begin()]);assert.equal(h.data.Receipts.length,2);
      assert.ok(h.data.Receipts.every(row=>row.periodProof.proofs[0].evidence.coordination.sharedItems[0].type==='Service'));
      await Promise.all([a.gate.failTransport(ta,a.request,{}),b.gate.failTransport(tb,b.request,{})]);
    }
  }
});
