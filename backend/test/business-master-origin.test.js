'use strict';
process.env.QBO_ENVIRONMENT='production';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,scope,ownerId}=require('./helpers/master-service-fixture');
const {readRecordOrigin,originPipelines,LIMIT}=require('../src/modules/record-origin');
const {masterProgressHash}=require('../src/modules/business-master-receipt');
const {clone}=require('./helpers/master-transport-fixture');
async function created(t,{unknown=false,saved=false}={}){
 const h=fixture(t);await h.proposal();await h.approval();const id=String(h.run()._id);
 if(saved)h.changeRead=record=>({...record,Active:false});
 h.afterCreate=async(record,entity)=>{if(unknown){h.remote[entity].find(row=>row.Id===record.Id).MetaData={CreateTime:new Date(h.clock).toISOString()};throw Object.assign(Error('fixture terminal unknown'),{code:'500'});}await h.service.stop(h.user,id,{});};
 await h.service.execute(h.user,id,{planHash:h.run().planHash,reviewHash:masterProgressHash(h.run()),resume:false});await h.service.idle();
 if(unknown){const review=await h.service.attributionReview(h.user,id,{ordinal:0,qboId:'100'});await h.service.attribute(h.user,id,{ordinal:0,qboId:'100',reviewHash:review.review.reviewHash,reason:'Owner independently identified this account using exact original request and company evidence.',confirmOwnership:true});}
 h.origin=async(run=h.run(),extra={})=>readRecordOrigin({userId:ownerId,...scope,entity:'Account',id:'100',attributionModels:h.models,db:{collection:name=>({aggregate:()=>({toArray:async()=>name==='masterpreparationruns'?[clone(run)]:extra[name]||[]})})}});return h;
}
test('master origin search is exact owner/company/environment scoped and bounded',()=>{
 const job=originPipelines({userId:ownerId,...scope,entity:'Account',id:'100'}).find(row=>row.key==='master_preparation');assert.deepEqual(job.pipeline[0].$match,{ownerId,realmId:scope.realmId,environment:scope.environment,records:{$elemMatch:{entity:'Account',qboId:'100'}}});assert.equal(job.pipeline[2].$limit,LIMIT+1);assert.equal(job.pipeline[3].$project.plan,1);assert.equal(originPipelines({userId:ownerId,...scope,entity:'Invoice',id:'100'}).some(row=>row.key==='master_preparation'),false);
});
test('verified prepared master origin survives retained closure without exposing private source fields',async t=>{
 const h=await created(t),id=String(h.run()._id);await h.service.retain(h.user,id,{planHash:h.run().planHash,reviewHash:masterProgressHash(h.run()),confirmRetain:true});const reads=h.qboReads.length,result=await h.origin();assert.equal(result.status,'recorded');assert.equal(result.sources[0].kind,'master_preparation');assert.equal(result.sources[0].provenance,'request-correlated-master-readback');assert.equal(result.sources[0].role,'operatingBank');assert.equal(result.baseline,'unclassified');assert.equal(h.qboReads.length,reads);
 const text=JSON.stringify(result);for(const key of ['plan','inventoryBefore','leaseToken','readback','payload','ownerAttribution'])assert.equal(text.includes('"'+key+'"'),false);
});
test('accepted response is distinct from independently verified master readback',async t=>{
 const h=await created(t,{saved:true}),result=await h.origin();assert.equal(result.status,'recorded');assert.equal(result.sources[0].provenance,'request-correlated-master-response');assert.match(result.sources[0].limitation,/readback still needs recovery/);
});
test('owner-attributed origin preserves the unknown original result and requires the complete audited marker',async t=>{
 const h=await created(t,{unknown:true}),result=await h.origin();assert.equal(result.sources[0].kind,'master_owner_attribution');assert.equal(result.sources[0].provenance,'owner-attributed-master-readback');assert.match(result.sources[0].limitation,/remains unknown/);assert.equal(h.data.Receipts[0].state,'unknown');
 delete h.run().records[0].attempts.at(-1).ownerAttribution;const missing=await h.origin();assert.equal(missing.complete,false);assert.equal(missing.sources.length,0);
});
test('missing audit, wrong returned scope and conflicting creation sources cannot become complete origin',async t=>{
 const h=await created(t),original=clone(h.run());
 for(const mutate of [row=>{row.ownerId='f'.repeat(24);},row=>{row.environment='sandbox';},row=>{row.records[0].qboId='999';}]){const row=clone(original);mutate(row);const result=await h.origin(row);assert.equal(result.complete,false);assert.equal(result.sources.length,0);}
 const conflict=await h.origin(original,{seedruns:[{_id:'a'.repeat(24)}]});assert.equal(conflict.complete,false);assert.ok(conflict.incompleteSources.includes('master_preparation'));
 h.data.Audits=h.data.Audits.filter(row=>String(row._id)!==String(h.data.Receipts[0].resultAuditId));const result=await h.origin(original);assert.equal(result.complete,false);assert.equal(result.sources.length,0);
});
