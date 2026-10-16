'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,scope}=require('./helpers/business-governance-fixture');
const {createBusinessExecutionService}=require('../src/modules/business-execution-service');
const {AUTOMATIC_CREDITS_CODE,AUTOMATIC_CREDITS_MESSAGE}=require('../src/modules/qbo-write-period');
const config=require('../src/config'),previous=config.qbo.environment;
test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
async function prepared(){const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true,originalSdkTransport:true});await h.publish();const plan=await h.service.prepare(h.user,{requestKey:'credit-preference-period-001',throughDate:'2026-10-08'});await h.service.approve(h.user,plan.operationId,{planHash:plan.planHash});return{h,plan};}
function serviceFor(h){return createBusinessExecutionService({models:h.models,transaction:h.transaction,assertReady:h.assertReady,resolveContext:async()=>({environment:scope.environment,connection:{connected:true,...scope}}),accessFor:h.accessFor,runtimeFor:input=>h.runtime(input.operationId),now:()=>h.clock});}
test('normal owner execution retains an actionable proved-unsent refusal and only an explicit later request can continue',{timeout:120000},async()=>{
 const {h,plan}=await prepared(),service=serviceFor(h);let invoicePosts=0;h.beforePost=async opts=>{if(opts.url.endsWith('/invoice'))invoicePosts++;};h.autoApplyCredit=true;
 try{
  await service.request(h.user,plan.operationId,{planHash:plan.planHash,requestKey:'credit_refusal_owner_0001'});await service.idle();const refused=await service.inspect(h.user,plan.operationId);
  assert.equal(refused.status,'blocked');assert.equal(refused.execution.pending,false);assert.equal(refused.execution.result.code,AUTOMATIC_CREDITS_CODE);assert.equal(refused.execution.result.error,AUTOMATIC_CREDITS_MESSAGE);assert.equal(h.data.Runs[0].lastError,AUTOMATIC_CREDITS_MESSAGE);assert.equal(invoicePosts,0);assert.equal(h.data.Receipts.some(row=>row.entity==='invoice'),false);assert.equal(h.data.Calendars[0].verifiedThrough,null);assert.equal(h.data.Writers[0].unresolved,null);
  const audits=h.data.Audits.filter(row=>row.action==='Business dispatch proved never admitted');assert.equal(audits.length,1);assert.ok(audits[0].beforeState.dispatch.requestHash);assert.equal(audits[0].afterState.qboWrites,0);const accepted=h.data.Receipts.filter(row=>row.state==='saved').map(row=>({id:row._id,qboId:row.observed.qboId,requestHash:row.requestHash})),posts=h.posts;
  h.autoApplyCredit=false;await service.idle();assert.equal(h.posts,posts);assert.equal(invoicePosts,0,'A setting change cannot start another worker');
  await service.request(h.user,plan.operationId,{planHash:plan.planHash,requestKey:'credit_continue_owner_0002'});await service.idle();const completed=await service.inspect(h.user,plan.operationId);
  assert.equal(completed.status,'verified');assert.equal(completed.execution.result.complete,true);assert.equal(completed.execution.result.error,undefined);assert.equal(h.data.Calendars[0].verifiedThrough,'2026-10-08');assert.equal(h.posts,h.data.Plans[0].manifest.createCount);
  for(const original of accepted){const rows=h.data.Receipts.filter(row=>row._id===original.id);assert.equal(rows.length,1);assert.equal(rows[0].observed.qboId,original.qboId);assert.equal(rows[0].requestHash,original.requestHash);}
  const count=h.posts;await service.request(h.user,plan.operationId,{planHash:plan.planHash,requestKey:'credit_continue_owner_0002'});await service.idle();assert.equal(h.posts,count);
 }finally{service.close();await service.idle();}
});
test('an admitted transport failure carrying a preference-looking code cannot clear uncertainty or claim that nothing was sent',{timeout:120000},async()=>{
 const {h,plan}=await prepared();let failed=false;h.afterPost=async(opts)=>{if(!failed&&opts.url.endsWith('/invoice')){failed=true;throw Object.assign(Error('Fixture remote failure after accepted creation'),{code:AUTOMATIC_CREDITS_CODE,qboStage:'write_admission',outcomeUnknown:false});}};
 const runtime=h.runtime(plan.operationId),result=await runtime.execute();assert.equal(failed,true);assert.equal(result.complete,false);assert.equal(result.state,'recovery_required');assert.notEqual(result.error,AUTOMATIC_CREDITS_MESSAGE);assert.ok(h.data.Writers[0].unresolved?.transportConsumed);assert.equal(h.data.Receipts.filter(row=>row.entity==='invoice').length,1);assert.equal(h.data.Audits.filter(row=>row.action==='Business dispatch proved never admitted').length,0);const posts=h.posts;assert.equal((await runtime.execute()).complete,false);assert.equal(h.posts,posts);assert.equal(h.data.Calendars[0].verifiedThrough,null);
});
