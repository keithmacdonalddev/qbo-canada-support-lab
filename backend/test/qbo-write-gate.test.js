'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQboWriteGate } = require('../src/modules/qbo-write-gate');
const { freezeWriteRequest } = require('../src/modules/qbo-write-contract');
const { hash } = require('../src/modules/business-calendar');
const { controls } = require('./helpers/period-controls');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const ownerId = 'b'.repeat(24), operationId = 'c'.repeat(24), logicalKey = hash('invoice');
const request = freezeWriteRequest(scope, 'POST', 'invoice', { TxnDate: '2026-10-06', CustomerRef: { value: '1' }, Line: [] });
const clone = value => structuredClone(value);
const at = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && !(value instanceof Date) ? ('$in' in value ? value.$in.includes(at(row, key)) : '$exists' in value ? (at(row, key) !== undefined) === value.$exists : false) : value instanceof Date ? new Date(at(row, key)).getTime() === value.getTime() : at(row, key) === value);
function harness(business = false, options = {}) {
  const h = { clock: Date.parse('2026-10-06T12:00:00.000Z'), data: { Policies: [], Writers: [], Receipts: [], Audits: [], Connections: [], Memberships: [], Runs: [], Calendars: [], Steps: [], Users: [], Agents: [] }, sequence: 0 };
  h.data.Policies.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, state: 'active', periodControl: controls(scope, ownerId, h.clock) });
  h.data.Writers.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, operationId: null, planHash: null, unresolved: null });
  h.data.Connections.push({ _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' });
  h.data.Memberships.push({ _id: 'membership', userId: ownerId, realmId: scope.realmId, status: 'active', role: 'lab-owner', permissionOverrides: [], businessSetupVersion: 0 });
  h.data.Users.push({ _id: ownerId, role: 'agent', connectionSwitchVersion: 0 });
  h.writer = () => h.data.Writers[0];
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, {
    find(filter) { const query = { limit() { return query; }, session() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.data[name].filter(row => matches(row, filter)).slice(0, 2)) }; return query; },
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
  h.gate = createQboWriteGate({ ...h.models, ...options, transaction: h.transaction, assertBusinessAuthority: async () => {}, now: () => h.clock, assertReady: async () => { if (h.notReady) throw new Error('not prepared'); }, nonce: () => String(++h.sequence) });
  h.rawGate = h.gate;
  h.periodClient = { query: async () => ({ QueryResponse: { Preferences: [{ AccountingInfoPrefs: {}, SalesFormsPrefs: { AutoApplyCredit: false } }] } }) };
  h.gate = { ...h.rawGate, begin: async input => h.rawGate.begin({ ...input, periodEvidence: input.periodEvidence === undefined ? await h.rawGate.preflight({ request: input.request, client: h.periodClient }) : input.periodEvidence }) };
  h.input = { request, ownerId, actorId: ownerId };
  if (business) {
    const dispatchKey = hash('dispatch'), planHash = hash('plan'), blueprintHash = hash('blueprint'), baselineHash = hash('baseline');
    h.input.permit = { scope, operationId, logicalKey, dispatchKey, requestHash: request.requestHash, dispatchRevision: 2, stepLeaseToken: 'lease' };
    Object.assign(h.writer(), { revision: 1, operationId, planHash, unresolved: { key: dispatchKey, logicalKey, requestHash: request.requestHash, actorId: ownerId, evidenceHash: hash('observations'), compilationHash: hash('compilation'), observationWriterRevision: 0, stepRevision: 2, observedAt: new Date(h.clock).toISOString() } });
    h.data.Runs.push({ _id: operationId, ...scope, planHash, approval: { actorId: ownerId, planHash, fenceHash: hash('approval fence'), auditId: 'approval-audit', approvedAt: new Date(h.clock).toISOString() }, blueprintHash, baselineHash, status: 'running', expectedCursor: '2026-09-30', expectedRevision: 1, writerRevision: 0, evidenceRevision: 1, verificationCandidateHash: hash('old proof') });
    h.data.Calendars.push({ _id: 'calendar', ...scope, currentOperationId: operationId, blueprintHash, baseline: { status: 'verified', evidenceHash: baselineHash }, verifiedThrough: '2026-09-30', revision: 1, writerRevision: 0, stopRequested: false, pendingCommit: null });
    h.data.Steps.push({ _id: 'step', ...scope, operationId, logicalKey, planHash, entity: 'Invoice', state: 'dispatched', revision: 2, leaseToken: 'lease', receipt: null, dispatch: { key: dispatchKey, requestHash: request.requestHash, evidenceHash: hash('observations'), compilationHash: hash('compilation'), observationWriterRevision: 0, observedAt: new Date(h.clock).toISOString() } });
  }
  return h;
}
const success = { status: 200, json: { Invoice: { Id: '100', SyncToken: '0' } } };
const rejection = { status: 400, json: { Fault: { type: 'ValidationFault', Error: [{ code: '6000', Message: 'fixture' }] } } };
test('unprepared companies cannot bypass explicit write coordination', async () => {
  const h = harness(); h.data.Policies = []; h.data.Writers = [];
  await assert.rejects(h.gate.begin(h.input), /explicit/); assert.equal(h.data.Receipts.length, 0);
  await assert.rejects(h.gate.begin({ ...h.input, permit: {} }), /explicit/);
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
  const h = harness(); h.input.actorId = 'e'.repeat(24);
  await assert.rejects(h.gate.begin(h.input), /workspace user/);
  h.data.Users.push({ _id: h.input.actorId, role: 'agent', connectionSwitchVersion: 0 });
  await assert.rejects(h.gate.begin(h.input), /company permission/);
  h.data.Memberships.push({ _id: 'shared-member', userId: h.input.actorId, realmId: scope.realmId, status: 'active', role: 'lab-owner', permissionOverrides: [] });
  const ticket = await h.gate.begin(h.input); assert.equal(h.data.Audits[0].actorUserId, h.input.actorId);
  await h.gate.complete(ticket, request, rejection); assert.equal(h.writer().unresolved, null);
  await assert.rejects(h.gate.begin({ ...h.input, request: freezeWriteRequest(scope, 'POST', 'batch', { BatchItemRequest: [] }) }), /batch/);
});

test('business admission checks execution authority for owners and supports explicit permission overrides', async () => {
  const h = harness(true); h.data.Memberships[0].role = 'reviewer';
  await assert.rejects(h.gate.begin(h.input), /company permission/); assert.equal(h.data.Receipts.length, 0);
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

const caseWorkflow={version:1,kind:'reproduction',sessionId:'1'.repeat(24),planId:'2'.repeat(24),stepNumber:3};
test('case recovery atomically settles only its correlated receipt, writer barrier and workflow callback',async()=>{
 const h=harness();const ticket=await h.gate.begin({...h.input,workflow:caseWorkflow});await h.gate.complete(ticket,request,{status:429,json:{}});
 const dispatch={version:1,scope,receiptId:ticket.receiptId,dispatchKey:ticket.dispatchKey,requestHash:ticket.requestHash};
 const input={scope,ownerId,actorId:ownerId,workflow:caseWorkflow,dispatch,decision:{status:'completed',result:{reconciled:'found',data:{id:'100'}}}};
 const before=clone(h.data);await assert.rejects(h.gate.settleCase(input,async()=>{throw new Error('case save failed');}),/case save/);assert.deepEqual(h.data,before);
 let saves=0;await h.gate.settleCase(input,async session=>{assert.ok(session.inTransaction());saves++;return true;});assert.equal(saves,1);assert.equal(h.writer().unresolved,null);assert.equal(h.data.Receipts[0].state,'saved');assert.equal(h.data.Receipts[0].reconciliation.qboId,'100');
 await h.gate.begin(h.input);
});
test('case recovery cannot clear another case, an unidentified barrier, a changed connection or a business writer',async()=>{
 for(const change of [i=>{i.workflow={...caseWorkflow,stepNumber:4};},i=>{i.dispatch.requestHash=hash('other');},(_i,h)=>{h.data.Connections[0].status='revoked';},(_i,h)=>{h.writer().operationId=operationId;}]){
  const h=harness();const ticket=await h.gate.begin({...h.input,workflow:caseWorkflow});await h.gate.complete(ticket,request,{status:429,json:{}});const input={scope,ownerId,actorId:ownerId,workflow:caseWorkflow,dispatch:{version:1,scope,receiptId:ticket.receiptId,dispatchKey:ticket.dispatchKey,requestHash:ticket.requestHash},decision:{status:'failed',result:{reconciled:'not_found'}}};change(input,h);let saved=false;await assert.rejects(h.gate.settleCase(input,async()=>{saved=true;}));assert.equal(saved,false);assert.ok(h.writer().unresolved);
 }
});

test('lost dispatch persistence and known response receipts recover without another QBO write',async()=>{
 for(const known of [false,true]){
  const h=harness(),ticket=await h.gate.begin({...h.input,workflow:caseWorkflow});
  await h.gate.complete(ticket,request,known?success:{status:429,json:{}});
  let saved=0;await h.gate.settleCase({scope,ownerId,actorId:ownerId,workflow:caseWorkflow,decision:{status:'completed',result:{reconciled:'found',data:{id:'100'}}}},async()=>{saved++;});
  assert.equal(saved,1);assert.equal(h.writer().unresolved,null);assert.equal(h.data.Receipts.length,1);
  // A retry of the same workflow uses the retained result, never a new dispatch.
  await h.gate.settleCase({scope,ownerId,actorId:ownerId,workflow:caseWorkflow,decision:{status:'completed',result:{reconciled:'found',data:{id:'100'}}}},async()=>{saved++;});assert.equal(saved,2);
 }
});
test('a known response cannot be replaced by a different recovered record',async()=>{const h=harness(),ticket=await h.gate.begin({...h.input,workflow:caseWorkflow});await h.gate.complete(ticket,request,success);await assert.rejects(h.gate.settleCase({scope,ownerId,actorId:ownerId,workflow:caseWorkflow,decision:{status:'completed',result:{reconciled:'found',data:{id:'999'}}}},async()=>{}),/contradicts/);});
test('clearing a case requires transport proof even if no pending case steps remain',async()=>{const h=harness();await h.gate.begin({...h.input,workflow:caseWorkflow});await assert.rejects(h.gate.assertCaseSettled({scope,ownerId,sessionId:caseWorkflow.sessionId}),/uncertain transport/);});
test('legacy transport rechecks permissions on every admission',async()=>{const h=harness(),ticket=await h.gate.begin(h.input);await h.gate.complete(ticket,request,success);h.data.Memberships[0].role='reviewer';await assert.rejects(h.gate.begin(h.input),/permission/);assert.equal(h.data.Receipts.length,1);});
test('correlated support work needs reproduction permission, rather than business execution permission',async()=>{const h=harness();h.data.Memberships[0].role='support-agent';const ticket=await h.gate.begin({...h.input,workflow:caseWorkflow});assert.ok(ticket.coordinated);await h.gate.complete(ticket,request,success);await assert.rejects(h.gate.begin(h.input),/permission/);});
test('actual case reconciliation settles receipt, barrier, audit and step in the same transaction',async()=>{
 const {createReconciler}=require('../src/modules/reproduction-reconcile');
 for(const mode of ['unknown','lost-dispatch','known-response','audit-failure','stale-step','missing-step']){
  const h=harness();const start=h.clock-30000;const record={Id:'100',SyncToken:'0',DisplayName:'Case fixture',MetaData:{CreateTime:new Date(h.clock-10000).toISOString()}};
  const created=freezeWriteRequest(scope,'POST','customer',{DisplayName:'Case fixture'});const ticket=await h.gate.begin({...h.input,request:created,workflow:caseWorkflow});
  await h.gate.complete(ticket,created,mode==='known-response'?{status:200,json:{Customer:record}}:{status:429,json:{}});
  const dispatch={version:1,scope,receiptId:ticket.receiptId,dispatchKey:ticket.dispatchKey,requestHash:ticket.requestHash};
  const step={_id:Math.floor(start/1000).toString(16).padStart(8,'0')+'0'.repeat(16),stepNumber:3,status:'executing',toolName:'createRecord',toolInput:{entityType:'Customer',record:{DisplayName:'Case fixture'}},...(mode==='lost-dispatch'?{}:{writeDispatch:dispatch})};
  const plan={_id:caseWorkflow.planId,sessionId:caseWorkflow.sessionId,userId:ownerId,steps:mode==='missing-step'?[]:[step]};
  const state={_id:caseWorkflow.sessionId,userId:ownerId,realmId:scope.realmId,mode:'reproduce',plans:[plan._id],reproduction:{status:'stopped',environment:scope.environment,connectionId:scope.connectionId,planId:plan._id,startedAt:new Date(start),outcomeUnknown:true}};
  const assign=(target,key,value)=>{const keys=key.split('.');let at=target;for(const k of keys.slice(0,-1))at=at[k]||={};at[keys.at(-1)]=value;};
  const reconciler=createReconciler({now:()=>h.clock,isActive:()=>false,config:{qbo:{environment:scope.environment}},
   Connection:{findOne:async()=>({_id:scope.connectionId})},createQBOClient:async()=>({query:async()=>({QueryResponse:{Customer:[record]}})}),
   AISession:{findOneAndUpdate:async()=>state,findOne:async()=>state,updateOne:async(_filter,change)=>{for(const[k,v]of Object.entries(change.$set||{}))assign(state,k,v);return{matchedCount:1};}},
   AIPlan:{find:async()=>[plan],updateOne:async(filter,change,options)=>{assert.ok(options.session.inTransaction());assert.equal(filter.userId,ownerId);if(mode==='stale-step')return{matchedCount:0};for(const[k,v]of Object.entries(change.$set))assign(step,k.replace('steps.$.',''),v);return{matchedCount:1};}},
   createAuditEntry:async(_owner,_realm,_action,details,options)=>{assert.ok(options.session.inTransaction());if(mode==='audit-failure')return null;await h.models.Audits.create([{_id:'case-reconciliation',afterState:details.afterState}],{session:options.session});return{_id:'case-reconciliation'};},
   settleWrite:(input,save)=>h.gate.settleCase(input,save),assertSettled:input=>h.gate.assertCaseSettled(input),
  });
  const result=await reconciler.reconcile({userId:ownerId,actorId:ownerId,sessionId:state._id});
  if(['audit-failure','stale-step','missing-step'].includes(mode)){assert.equal(result.outcomeUnknown,true,mode);assert.ok(h.writer().unresolved,mode);assert.equal(step.status,'executing',mode);assert.equal(h.data.Audits.some(a=>a._id==='case-reconciliation'),false,mode);}
  else{assert.equal(result.outcomeUnknown,false,mode);assert.equal(h.writer().unresolved,null,mode);assert.equal(step.status,'completed',mode);assert.equal(h.data.Receipts[0].state,'saved',mode);assert.ok(h.data.Audits.some(a=>a._id==='case-reconciliation'),mode);}
 }
});

test('case settlement rechecks the current owner and selected workspace', async () => {
  for (const change of [h => { h.data.Users = []; }, h => { h.data.Users[0].role = 'invalid'; }, h => { h.data.Connections.push({ _id: 'f'.repeat(24), realmId: '999', userId: ownerId, status: 'active', updatedAt: 9 }); }]) {
    const h = harness(), ticket = await h.gate.begin({ ...h.input, workflow: caseWorkflow });
    change(h); let saved = false;
    await assert.rejects(h.gate.settleCase({ scope, ownerId, actorId: ownerId, workflow: caseWorkflow, decision: { status: 'failed', result: { reconciled: 'not_found' } } }, async () => { saved = true; }));
    assert.equal(saved, false); assert.ok(h.writer().unresolved);
    await assert.rejects(h.gate.assertCaseSettled({ scope, ownerId, sessionId: caseWorkflow.sessionId }));
  }
});

test('period admission rejects missing proof and concurrent writer or policy changes',async()=>{
 for(const change of [h=>{h.writer().revision++;},h=>{h.data.Policies[0].revision++;},h=>{h.data.Policies[0].periodControl=controls(scope,ownerId,h.clock,'2026-10-05');}]){
  const h=harness(),periodEvidence=await h.rawGate.preflight({request,client:h.periodClient});change(h);
  await assert.rejects(h.rawGate.begin({...h.input,periodEvidence}),/changed during reading/);assert.equal(h.data.Receipts.length,0);
 }
 const h=harness();await assert.rejects(h.rawGate.begin(h.input),/changed during reading/);assert.equal(h.data.Receipts.length,0);
});
test('preflight refuses a writer changing while QBO preferences are being read',async()=>{
 const h=harness();h.periodClient.query=async()=>{h.writer().revision++;return{QueryResponse:{Preferences:[{AccountingInfoPrefs:{},SalesFormsPrefs:{AutoApplyCredit:false}}]}}};
 await assert.rejects(h.rawGate.preflight({request,client:h.periodClient}),/changed during reading/);assert.equal(h.data.Receipts.length,0);
});
test('a saved receipt retains the bounded period evidence and exact owner choices',async()=>{
 const h=harness();await h.gate.begin(h.input);const proof=h.data.Receipts[0].periodProof;
 assert.equal(proof.evidence.coordination.policyRevision,0);assert.equal(proof.controls.ownerId,ownerId);assert.equal(hash(proof.controls),hash(h.data.Policies[0].periodControl));
 assert.equal(proof.evidence.requestHash,request.requestHash);assert.equal(proof.evidence.observedAt,new Date(h.clock).toISOString());assert.ok(Buffer.byteLength(JSON.stringify(proof))<70000);
});

test('a delayed old permission cannot consume a newly prepared marker with the same request key',async()=>{
 const h=harness(true),old=structuredClone(h.input.permit);h.writer().unresolved.stepRevision=4;h.data.Steps[0].revision=4;h.data.Steps[0].leaseToken='fresh-lease';h.input.permit.dispatchRevision=4;h.input.permit.stepLeaseToken='fresh-lease';
 await assert.rejects(h.gate.begin({...h.input,permit:old}),/changed before sending/);assert.equal(h.data.Receipts.length,0);
 await h.gate.begin(h.input);assert.equal(h.data.Receipts.length,1);
});

test('final Production transport gate refuses absent or mismatched explicit plan consent',async()=>{
 for(const change of [null,{confirmed:false},{environment:'sandbox'},{realmId:'999'},{connectionId:'e'.repeat(24)},{actorId:'e'.repeat(24)},{planHash:hash('other')},{}]){
  const h=harness(true),productionScope={...scope,environment:'production'},current=h.data.Runs[0];for(const name of ['Policies','Writers','Runs','Calendars','Steps'])for(const row of h.data[name])row.environment='production';h.data.Policies[0].periodControl=controls(productionScope,ownerId,h.clock);h.input.request=freezeWriteRequest(productionScope,'POST','invoice',{TxnDate:'2026-10-06',CustomerRef:{value:'1'},Line:[]});h.input.permit.scope=productionScope;h.input.permit.requestHash=h.input.request.requestHash;h.writer().unresolved.requestHash=h.input.request.requestHash;h.data.Steps[0].dispatch.requestHash=h.input.request.requestHash;
  if(change!==null)current.approval.productionConsent={confirmed:true,...productionScope,actorId:ownerId,planHash:current.planHash,...change};
  if(change&&Object.keys(change).length===0){const ticket=await h.gate.begin(h.input);assert.equal(ticket.coordinated,true);assert.equal(h.data.Receipts.length,1);}else{await assert.rejects(h.gate.begin(h.input),/Production/);assert.equal(h.data.Receipts.length,0);}
 }
});

test('reserved accounts cannot dispatch before recovery or while retained automation is paused',async()=>{
  for(const business of [false,true])for(const recovered of [false,true]){
    const h=harness(business);Object.assign(h.data.Users[0],{email:'tester@testdatalab.local',authVersion:recovered?1:0,accessPolicyVersion:recovered?1:0,automationAccessPolicyVersion:0});
    await assert.rejects(h.gate.begin(h.input),recovered?/automation is paused/:/private credential recovery/);assert.equal(h.data.Receipts.length,0);
  }
});


test('installed SDK blocks automatic use of an unrelated old credit before POST, and explicit false uses the existing single preference read',async()=>{
 const {QBOClient}=require('../src/modules/qbo-client'),OAuthClient=require('intuit-oauth'),config=require('../src/config'),previous=config.qbo.environment,{AUTOMATIC_CREDITS_CODE}=require('../src/modules/qbo-write-period');config.qbo.environment='sandbox';
 try{for(const value of [true,undefined,'false',0,null,false]){
  const h=harness(),oldCredit={Id:'500',SyncToken:'4',RemainingCredit:50},original=structuredClone(oldCredit),calls=[];
  const sdk=new OAuthClient({clientId:'fixture-client',clientSecret:'fixture-secret',environment:'sandbox',redirectUri:'http://fixture.invalid'});sdk.log=()=>{};sdk.setToken({access_token:'fixture-token'});
  sdk.axiosInstance=async(url,options)=>{calls.push({method:options.method,path:new URL(url).pathname});let data;
   if(options.method==='GET'){assert.match(new URL(url).searchParams.get('query'),/^SELECT \* FROM Preferences/);data={QueryResponse:{Preferences:[{AccountingInfoPrefs:{},SalesFormsPrefs:{AutoApplyCredit:value}}]}};}
   else{assert.equal(options.method,'POST');assert.ok(url.endsWith('/invoice'));if(value!==false){oldCredit.RemainingCredit=0;oldCredit.SyncToken='5';}data={Invoice:{Id:'100',SyncToken:'0'}};}
   return{status:200,statusText:'Fixture response',headers:{},data};
  };
  const client=Object.create(QBOClient.prototype);Object.assign(client,{connection:clone(h.data.Connections[0]),realmId:scope.realmId,_requestLog:[],_retryAfterUntil:0,_windowMs:60000,ensureFreshToken:async()=>{},writeGate:h.rawGate,oauthClient:sdk});assert.equal(client.oauthClient.makeApiCall,OAuthClient.prototype.makeApiCall);
  const send=()=>client.create('invoice',JSON.parse(request.body));
  if(value===false){assert.equal((await send()).Invoice.Id,'100');assert.equal(calls.filter(row=>row.method==='POST').length,1);assert.equal(h.data.Receipts[0].state,'saved');assert.equal(h.data.Receipts[0].periodProof.evidence.version,2);assert.equal(h.data.Receipts[0].periodProof.evidence.autoApplyCredit,false);}
  else{await assert.rejects(send(),error=>error.code===AUTOMATIC_CREDITS_CODE&&error.qboStage==='write_admission'&&error.outcomeUnknown===false);assert.equal(calls.filter(row=>row.method==='POST').length,0);assert.equal(h.data.Receipts.length,0);assert.equal(h.writer().unresolved,null);assert.equal(h.data.Audits.length,0);}
  assert.deepEqual(oldCredit,original);assert.equal(calls.filter(row=>row.method==='GET').length,1);
 }}finally{config.qbo.environment=previous;}
});
test('current begin refuses rehashed downgraded or missing credit preference proof without consuming the writer',async()=>{
 for(const change of [row=>{row.version=1;delete row.autoApplyCredit;},row=>{delete row.autoApplyCredit;},row=>{row.autoApplyCredit=true;},row=>{row.autoApplyCredit=0;}]){
  const h=harness(),evidence=await h.rawGate.preflight({request,client:h.periodClient});change(evidence);delete evidence.evidenceHash;evidence.evidenceHash=hash(evidence);const before=clone(h.data);
  await assert.rejects(h.rawGate.begin({...h.input,periodEvidence:evidence}));assert.deepEqual(h.data,before);assert.equal(h.data.Receipts.length,0);
 }
});
test('original v1 transport receipts remain readable when current preferences would refuse new invoices',async()=>{
 const {createBusinessDispatchReceiptReader}=require('../src/modules/business-dispatch-receipt'),h=harness(true);h.data.Steps[0].dispatch.actorId=ownerId;const ticket=await h.gate.begin(h.input);await h.gate.complete(ticket,request,success);
 const row=h.data.Receipts[0],old=row.periodProof.evidence;old.version=1;delete old.autoApplyCredit;delete old.evidenceHash;old.evidenceHash=hash(old);row.periodProof.evidenceHash=old.evidenceHash;
 let queries=0;h.periodClient.query=async()=>{queries++;return{QueryResponse:{Preferences:[{AccountingInfoPrefs:{},SalesFormsPrefs:{AutoApplyCredit:true}}]}}};
 const reader=createBusinessDispatchReceiptReader({...h.models,transaction:h.transaction,assertReady:async()=>{},authorize:async()=>({actorId:ownerId,ownerId})});const result=await reader({...scope,operationId,logicalKey,entity:'Invoice',state:'dispatched',dispatch:h.data.Steps[0].dispatch});assert.equal(result.status,'found');assert.equal(result.receipt.qboId,'100');assert.equal(queries,0);assert.equal(row.periodProof.evidence.version,1);
 await assert.rejects(h.rawGate.preflight({request,client:h.periodClient}));assert.equal(queries,1);assert.equal(row.state,'saved');
});

function populationRepairFixture(){
 let h;const transport={admit:async({writer,receiptId,dispatchKey,request,session})=>{assert.ok(session);assert.equal(writer.populationDelegation.jobId,operationId);assert.equal(writer.unresolved,null);if(h.data.Receipts.some(r=>r._id===receiptId))throw Error('repair already consumed');return{kind:'population-link-repair',key:dispatchKey,requestHash:request.requestHash,transportConsumed:{receiptId}};},settle:async()=>{h.settled=(h.settled||0)+1;}};
 h=harness(false,{populationRepairTransport:transport});h.writer().populationDelegation={jobId:operationId};h.input={request:freezeWriteRequest(scope,'POST','invoice',{Id:'100',SyncToken:'0',sparse:true,LinkedTxn:[{TxnId:'10',TxnType:'Estimate'}]}),ownerId,actorId:ownerId,workflow:{version:1,kind:'population-link-repair',authorityHash:hash('exact repair')}};
 h.periodClient.read=async(entity,id)=>({[entity==='invoice'?'Invoice':'Estimate']:{Id:id,SyncToken:'0',TxnDate:'2026-10-06'}});return h;
}
test('dedicated population repair keeps saved or unknown updates held and preserves native receipts',async()=>{for(const response of [{status:200,json:{Invoice:{Id:'100',SyncToken:'1'}}},{status:503,json:{}}]){const h=populationRepairFixture(),ticket=await h.gate.begin(h.input);assert.equal(ticket.kind,'population-link-repair');assert.equal(h.data.Receipts[0].operation,'update');assert.equal(h.data.Receipts[0].workflow.authorityHash,h.input.workflow.authorityHash);await h.gate.complete(ticket,h.input.request,response);assert.ok(h.writer().unresolved);assert.equal(h.settled,1);assert.equal(h.data.Audits.length,response.status===200?2:3);await assert.rejects(h.gate.begin(h.input));assert.equal(h.data.Receipts.length,1);}});
test('population repair needs a dedicated adapter, exact owner and Invoice update; ordinary writes stay fenced',async()=>{
 const missing=harness();missing.writer().populationDelegation={jobId:operationId};const input=populationRepairFixture().input;await assert.rejects(missing.rawGate.begin(input),/dedicated/);
 for(const mutate of [h=>h.input.actorId='e'.repeat(24),h=>h.input.permit={},h=>h.input.request=request,h=>h.input.request=freezeWriteRequest(scope,'POST','estimate',{Id:'10',SyncToken:'0'})]){const h=populationRepairFixture();mutate(h);await assert.rejects(h.gate.begin(h.input));assert.equal(h.data.Receipts.length,0);}
 const h=populationRepairFixture();await assert.rejects(h.gate.begin({...h.input,workflow:null}),/delegated/);assert.equal(h.data.Receipts.length,0);
});
test('definite repair rejection releases only its barrier but cannot reset the consumed authority',async()=>{const h=populationRepairFixture(),ticket=await h.gate.begin(h.input);await h.gate.complete(ticket,h.input.request,rejection);assert.equal(h.writer().unresolved,null);assert.equal(h.writer().populationDelegation.jobId,operationId);assert.equal(h.data.Receipts[0].state,'rejected');await assert.rejects(h.gate.begin(h.input),/consumed/);assert.equal(h.data.Receipts.length,1);});

test('repair batches require their complete dedicated adapter and retain their native receipt barrier',async()=>{let calls=0;const authorityHash=hash('repair batch'),batchRequest=freezeWriteRequest(scope,'POST','batch?requestid=repair-batch-123456',{BatchItemRequest:[{bId:'1',operation:'update',Invoice:{Id:'100',SyncToken:'0',sparse:true}}]}),transport={preflight:async({coordination})=>({coordination}),assertPeriod:()=>({evidenceHash:hash('batch periods')}),receiptEvidence:async()=>({kind:'population-link-repair-batch'}),admit:async x=>({kind:'population-link-repair',key:x.dispatchKey,transportConsumed:{receiptId:x.receiptId}}),classify:async()=>{calls++;return{entity:'batch',operation:'create',outcome:'saved',httpStatus:200,responseHash:hash('response'),items:[{bId:'1',outcome:'saved',operation:'update',qboId:'100',syncToken:'1'}]};},settle:async()=>{}};const h=harness(false,{populationRepairTransport:transport});h.writer().populationDelegation={jobId:'d'.repeat(24)};const input={request:batchRequest,ownerId,actorId:ownerId,workflow:{version:1,kind:'population-link-repair',authorityHash}},ticket=await h.gate.begin(input);await h.gate.complete(ticket,batchRequest,{status:200,json:{}},'tid');assert.equal(calls,1);assert.equal(h.data.Receipts[0].kind,'population-link-repair');assert.equal(h.data.Receipts[0].population.kind,'population-link-repair-batch');assert.ok(h.writer().unresolved);await assert.rejects(h.gate.begin({...input,actorId:'e'.repeat(24)}));assert.throws(()=>harness(false,{populationTransport:{},populationRepairTransport:transport}),/one exact batch/);const noAdapter=harness();await assert.rejects(noAdapter.gate.begin(input));});

function agentHarness() {
  const h = harness(true), authority = { version: 1, agentId: 'e'.repeat(24), grantId: hash('standing grant'), authorityHash: hash('published business'), ownerId };
  const run = h.data.Runs[0]; Object.assign(run, { createdBy: ownerId, authorityHash: authority.authorityHash, agentAuthority: authority });
  Object.assign(run.approval, { agentAuthority: authority, decisionSource: 'agent-standing-authority' });
  h.data.Steps[0].dispatch.policyHash = hash('policy'); h.writer().unresolved.policyHash = hash('policy');
  h.data.Agents.push({ _id: authority.agentId, ...scope, ownerId, settings: { monitoring: true, autonomous: true }, grant: { id: authority.grantId, authorityHash: authority.authorityHash, ownerId }, dispatchRevision: 0 });
  return h;
}
test('agent pause and changed standing grant fence native admission before a receipt or SDK request exists', async () => {
  for (const mutate of [h => { h.data.Agents[0].settings.autonomous = false; }, h => { h.data.Agents[0].settings.monitoring = false; }, h => { h.data.Agents[0].grant.id = hash('replaced grant'); }, h => { h.data.Agents[0].grant.authorityHash = hash('other policy'); }, h => { h.data.Agents[0].connectionId = 'f'.repeat(24); }]) {
    const h = agentHarness(); mutate(h); await assert.rejects(h.gate.begin(h.input), /paused|authorization changed/);
    assert.equal(h.data.Receipts.length, 0); assert.equal(h.data.Audits.length, 0); assert.equal(h.data.Agents[0].dispatchRevision, 0);
  }
});
test('agent work consumes standing authorization in the same accounting transaction and can settle after Pause', async () => {
  const h = agentHarness(), ticket = await h.gate.begin(h.input);
  assert.equal(h.data.Agents[0].dispatchRevision, 1); assert.equal(h.data.Receipts.length, 1);
  h.data.Agents[0].settings.autonomous = false;
  assert.equal((await h.gate.complete(ticket, request, success)).outcome, 'saved');
  assert.equal(h.data.Receipts[0].state, 'saved');
});
test('agent origin and exact approval provenance cannot be stripped or forged', async () => {
  for (const mutate of [h => { delete h.data.Runs[0].approval.agentAuthority; }, h => { h.data.Runs[0].approval.decisionSource = 'manual'; }, h => { h.data.Runs[0].createdBy = 'f'.repeat(24); }, h => { h.data.Runs[0].agentAuthority = { ...h.data.Runs[0].agentAuthority, extra: true }; }]) {
    const h = agentHarness(); mutate(h); await assert.rejects(h.gate.begin(h.input)); assert.equal(h.data.Receipts.length, 0);
  }
});
