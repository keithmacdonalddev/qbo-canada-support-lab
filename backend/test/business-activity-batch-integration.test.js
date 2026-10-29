'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,ownerId,actorId}=require('./helpers/business-governance-fixture');
const config=require('../src/config');const previous=config.qbo.environment;test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
function choice(index){return{decisionKey:'same-day-business-decision-'+index,purpose:'A real modeled customer service job completed and collected during this work pass.',activities:[{type:'settled-service-sale',customerKey:'field-client-001',itemKey:'field-service-hour',quantity:1+index,unitPriceCents:12500+index*100,purpose:'Completed customer maintenance service, collected payment and deposited it.'}]};}
async function calendar(h,throughDate,key){const p=await h.service.prepare(h.user,{requestKey:key,throughDate});await h.service.approve(h.user,p.operationId,{planHash:p.planHash});const result=await h.runtime(p.operationId).execute();assert.equal(result.complete,true,JSON.stringify(result));return p;}
async function throughYesterday(h){await h.publish();await calendar(h,'2026-10-31','initial-october-period-001');await calendar(h,'2026-11-30','initial-november-period-001');}
test('two same-day batches execute through real compiler, receipts, reports and writer without advancing history',{timeout:120000},async()=>{
 const h=fixture({activityTemplateVersion:2});await throughYesterday(h);const calendarState=h.data.Calendars[0],lastVerified=calendarState.lastVerifiedOperationId,revision=calendarState.revision;let writes=h.posts;
 for(const index of [1,2]){
  const input=choice(index),prepared=await h.service.prepareActivityBatch(h.user,input);assert.equal(h.posts,writes);assert.equal((await h.service.prepareActivityBatch(h.user,input)).reused,true);
  const run=h.data.Runs.find(row=>row._id===prepared.operationId);assert.equal(run.fromDate,'2026-12-01');assert.equal(run.expectedCursor,'2026-11-30');assert.ok(run.activityBatch);
  await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash});const runtime=h.runtime(prepared.operationId),result=await runtime.execute();assert.equal(result.complete,true,JSON.stringify(result));assert.equal(h.posts,writes+5);writes=h.posts;
  assert.equal(h.data.Calendars[0].verifiedThrough,'2026-11-30');assert.equal(h.data.Calendars[0].lastVerifiedOperationId,lastVerified);assert.equal(h.data.Calendars[0].revision,revision+index);assert.equal(h.data.Calendars[0].lastActivityOperationId,prepared.operationId);assert.equal(h.data.Writers[0].operationId,null);
  assert.equal((await runtime.inspect()).completion.kind,'additional-activity');assert.equal((await runtime.execute()).complete,true);assert.equal(h.posts,writes);
  const changed=structuredClone(input);changed.activities[0].quantity++;await assert.rejects(h.service.prepareActivityBatch(h.user,changed),/different work/);
 }
 await calendar(h,'2026-12-01','close-december-first-after-activity');assert.equal(h.data.Calendars[0].verifiedThrough,'2026-12-01');await assert.rejects(h.service.prepareActivityBatch(h.user,choice(3)));
});
test('retained history, current operation and non-owner do not permit a supplemental bypass',{timeout:120000},async()=>{
 const h=fixture({activityTemplateVersion:2});await h.publish();await assert.rejects(h.service.prepareActivityBatch({id:ownerId,actorId},choice(1)),error=>error.status===403);await assert.rejects(h.service.prepareActivityBatch(h.user,choice(1)));assert.equal(h.posts,0);
 await throughYesterday(h).catch(error=>{throw error;});
 const first=await h.service.prepareActivityBatch(h.user,choice(1));await h.service.approve(h.user,first.operationId,{planHash:first.planHash});
 const runtime=h.runtime(first.operationId);h.afterPost=async()=>{h.afterPost=null;await runtime.stop();};const result=await runtime.execute();assert.equal(result.state,'stopped');assert.equal(h.data.Calendars[0].verifiedThrough,'2026-11-30');const posts=h.posts;
 await assert.rejects(h.service.prepareActivityBatch(h.user,choice(2)));assert.equal(h.posts,posts);
});
