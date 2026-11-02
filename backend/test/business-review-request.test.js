'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requestReview,startRequestedReview,reviewRequestView,TERMINAL}=require('../src/modules/business-review-request');
const {createBusinessAgentStore}=require('../src/modules/business-agent-store');
const {reduceControl,DEFAULT_SETTINGS}=require('../src/modules/business-agent-policy');
const {hash}=require('../src/modules/business-calendar');
const {query,matches}=require('./replay/memory.cjs');
const now=Date.parse('2026-11-01T20:00:00Z'),scope={environment:'sandbox',realmId:'123',connectionId:'c'.repeat(24)},ownerId='a'.repeat(24);
function fixture(role='accountant'){
 let row={_id:hash(scope).slice(0,24),...scope,ownerId,revision:7,createdAt:new Date(now-10000),settings:{...DEFAULT_SETTINGS,monitoring:true,autonomous:true},leaseToken:'owned-worker',leaseExpiresAt:new Date(now+60000),activePass:role?{id:'exact-pass',role,startedAt:new Date(now-1000).toISOString()}:null,status:role?'reviewing':'monitoring',currentWork:'Useful retained work',reviewProgress:{passId:'exact-pass',attemptId:'exact-attempt'},lastError:'Keep the unresolved failure'};
 const events=[],audits=[];let queue=Promise.resolve();
 const write=(filter,change)=>{if(!matches(row,filter))return query([],true);Object.assign(row,structuredClone(change.$set||{}));for(const [k,v]of Object.entries(change.$inc||{}))row[k]=(row[k]||0)+v;return query([row],true);};
 const models={Agents:{findOne:f=>query(matches(row,f)?[row]:[],true),findOneAndUpdate:write},Events:{findOne:f=>query(events.filter(e=>matches(e,f)),true),create:async values=>events.push(...structuredClone(values))},Audits:{create:async values=>audits.push(...structuredClone(values))},Users:{updateOne:async()=>({matchedCount:1})},Connections:{updateOne:async()=>({matchedCount:1})},Memberships:{updateOne:async()=>({matchedCount:1})}};
 const transaction=work=>{const task=queue.then(()=>work({}));queue=task.catch(()=>{});return task;};
 const store=createBusinessAgentStore({models,connection:{},transaction,now:()=>now});
 const bound={scope,ownerId,actorId:ownerId,access:{authorize:async()=>{}}};
 const control=(key,command='run-now',expectedRevision=7)=>{const input={command,expectedRevision,requestKey:key,...(command==='run-now'?{expectedAgentId:row._id}:{})};return store.control(bound,input,r=>reduceControl(r,input,{scope},now,ownerId));};
 return {store,control,get row(){return row},events,audits};
}
test('two accepted retry clicks preserve the exact worker lease, generation, progress and failure',async()=>{
 const h=fixture(),original=structuredClone(h.row);
 const [a,b]=await Promise.all([h.control('first_request_0000001'),h.control('second_request_000001',undefined,6)]);
 assert.equal(a.controlReceipt.disposition,'already-running');assert.equal(b.controlReceipt.requestId,a.controlReceipt.requestId);
 assert.equal(h.row.revision,original.revision);assert.equal(h.row.leaseToken,original.leaseToken);assert.deepEqual(h.row.reviewProgress,original.reviewProgress);assert.equal(h.row.currentWork,original.currentWork);assert.equal(h.row.lastError,original.lastError);
 await h.store.current(original,'owned-worker');await h.store.update(original,'owned-worker',{currentWork:'Continued useful work'});
 assert.equal(h.audits.length,2);assert.equal(h.events.length,2);
 await h.control('pause_request_0000001','pause');assert.equal(h.row.revision,8);assert.equal(h.row.leaseToken,null);await assert.rejects(h.store.current(original,'owned-worker'),/lost its lease/);
});
test('same key replays its receipt, changed content collides, and exact receipt lookup is read-only',async()=>{
 const h=fixture();await h.control('first_request_0000001');const replay=await h.control('first_request_0000001');assert.equal(replay.controlReceipt.disposition,'replayed');assert.equal(h.audits.length,1);
 await assert.rejects(h.control('first_request_0000001','run-now',8),/already belongs/);
 const receipt=await h.store.reviewControlReceipt(h.row,'first_request_0000001');assert.equal(receipt.data.disposition,'already-running');assert.equal(await h.store.reviewControlReceipt(h.row,'unknown_request_0001'),null);assert.equal(h.audits.length,1);
});
test('specialist and synchronization workers queue one main review without losing their lease',async()=>{
 for(const role of ['inventory',null]){
  const h=fixture(role);h.row.lastError=null;const first=await h.control('first_request_0000001'),second=await h.control('second_request_000001');
  assert.equal(first.controlReceipt.disposition,'queued');assert.equal(second.controlReceipt.disposition,'already-queued');assert.equal(h.row.reviewRequest.passId,undefined);assert.equal(h.row.leaseToken,'owned-worker');
  const pass={id:'next-main-pass',role:'accountant',startedAt:new Date(now).toISOString()};
  await h.store.update(h.row,'owned-worker',{activePass:pass,reviewProgress:{passId:pass.id,attemptId:'next-attempt'},status:'reviewing'});
  assert.equal(h.row.reviewRequest.id,first.controlReceipt.requestId);assert.equal(h.row.reviewRequest.passId,pass.id);assert.equal(h.row.reviewRequest.attemptId,'next-attempt');
 }
});
test('expired leases queue recovery instead of joining an orphaned review',()=>{
 const h=fixture();h.row.leaseExpiresAt=new Date(now-1);const r=requestReview(h.row,{requestKey:'request-key'},now);assert.equal(r.request.state,'queued');assert.equal(r.request.passId,undefined);
 assert.deepEqual(startRequestedReview({...h.row,reviewRequest:r.request},{id:'specialist',role:'inventory'},'attempt'),{});
});
for(const outcome of TERMINAL)test('exact durable outcome survives reload: '+outcome,async()=>{
 const h=fixture();await h.control('first_request_0000001');
 const event={at:new Date(now+1000),detail:'Exact recorded outcome',data:{outcome,attemptId:'exact-attempt'}};
 const a=await reviewRequestView(structuredClone(h.row),{now,outcomeFor:async(row,r)=>{assert.equal(r.passId,'exact-pass');assert.equal(r.attemptId,'exact-attempt');return event;}});
 assert.equal(a.state,outcome);assert.equal(a.pending,false);assert.equal(a.detail,event.detail);
});
test('limits, lost lease, paused controls and unavailable result reads never claim completion',async()=>{
 const h=fixture();await h.control('first_request_0000001');
 assert.equal((await reviewRequestView(h.row,{now})).state,'running');
 assert.equal((await reviewRequestView(h.row,{now,usagePause:{detail:'Limit resets later'}})).state,'waiting');
 assert.equal((await reviewRequestView(h.row,{now,outcomeFor:async()=>{throw Error('storage')}})).state,'unavailable');
 h.row.leaseToken=null;assert.equal((await reviewRequestView(h.row,{now})).state,'interrupted');
 h.row.settings.autonomous=false;assert.equal((await reviewRequestView(h.row,{now})).state,'cancelled');
});

test('a request queued between terminal pass release and completion scheduling stays due now',async()=>{
 const h=fixture(),oldRow=structuredClone(h.row);await h.store.update(oldRow,'owned-worker',{activePass:null,status:'ready'});
 await h.control('late_queue_request_01');assert.equal(h.row.reviewRequest.state,'queued');
 await h.store.update(oldRow,'owned-worker',{nextDecisionAt:new Date(now+3600000),cadence:{kind:'on-schedule'},status:'ready'});
 assert.equal(new Date(h.row.nextDecisionAt).getTime(),now);
 await h.store.release(oldRow,'owned-worker',{nextWakeAt:new Date(now+3600000)});assert.equal(new Date(h.row.nextWakeAt).getTime(),now+1000);assert.equal(h.row.leaseToken,null);
});
test('queued requests respect daily ceilings and failed-before-start receipts stay failed after later monitoring',async()=>{
 const h=fixture(null);await h.control('capped_queue_request_01');
 await h.store.update(h.row,'owned-worker',{nextDecisionAt:new Date(now+3600000),cadence:{kind:'ceiling'}});
 assert.equal(new Date(h.row.nextDecisionAt).getTime(),now+3600000);
 const limited=await reviewRequestView(h.row,{now});assert.match(limited.detail,/daily review limit/);
 h.row.reviewRequest={...h.row.reviewRequest,state:'failed',error:'Exact start failure'};h.row.status='monitoring';h.row.lastError=null;
 const failed=await reviewRequestView(h.row,{now});assert.equal(failed.state,'failed');assert.equal(failed.detail,'Exact start failure');
});
