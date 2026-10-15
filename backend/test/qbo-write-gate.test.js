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
  h.gate = createQboWriteGate({ ...h.models, transaction: h.transaction, now: () => h.clock, assertReady: async () => { if (h.notReady) throw new Error('not prepared'); }, nonce: () => String(++h.sequence) });
  h.input = { request, ownerId, actorId: ownerId };
  if (business) {
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
