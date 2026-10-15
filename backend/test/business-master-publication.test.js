'use strict';
process.env.QBO_ENVIRONMENT='production';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture:masterFixture,scope,ownerId}=require('./helpers/master-service-fixture');
const {fixture:governanceFixture}=require('./helpers/business-governance-fixture');
const {masterProgressHash}=require('../src/modules/business-master-receipt');
const {clone}=require('./helpers/master-transport-fixture');
for(const version of [1,2])test('exact newly prepared v'+version+' record IDs pass normal opening evidence, publication and calendar activation',async t=>{
 const master=masterFixture(t,{lifecycleVersion:version});await master.proposal();await master.approval();const id=String(master.run()._id);
 await master.service.execute(master.user,id,{planHash:master.run().planHash,reviewHash:masterProgressHash(master.run()),resume:false});await master.service.idle();assert.equal(master.sent.length,version===2?35:32);
 const ordinals=master.run().records.map(row=>row.ordinal),review=await master.service.applyReview(master.user,id,{ordinals});
 const result=await master.service.apply(master.user,id,{ordinals,reviewHash:review.review.reviewHash,requestKey:'30000000-0000-0000-0000-000000000001'});assert.equal(result.run.claim,'closed');
 const draft=clone(master.data.Versions.find(row=>String(row._id)===result.draft.id));
 // Transfer the immutable draft and independent simulated QBO snapshot to the
 // existing normal-publication fixture; no validator or app service is replaced.
 const h=governanceFixture({scope,ownerId,savedDraft:draft,openingCash:0});h.records.clear();
 for(const [entity,rows]of Object.entries(master.remote))if(!['Preferences','CompanyInfo'].includes(entity))for(const record of rows)h.records.set(entity.toLowerCase()+':'+record.Id,{entity,record:clone(record)});
 for(const id of ['5','6'])h.records.set('taxrate:'+id,{entity:'TaxRate',record:{Id:id,SyncToken:'0',Active:true,RateValue:13,EffectiveTaxRate:[{EffectiveDate:'2020-01-01T00:00:00-04:00',RateValue:13}]}});
 const original=clone(h.data.Versions[0]),published=await h.publish();assert.equal(published.published,true);assert.equal(h.posts,0);assert.deepEqual(h.data.Versions[0],original);assert.equal(h.data.Authorities.length,1);assert.equal(h.data.Calendars[0].openingDate,'2023-10-01');assert.equal(h.data.Calendars[0].verifiedThrough,null);
 const authority=h.data.Authorities[0].payload;assert.equal(authority.activityTemplateVersion,version);assert.equal(authority.blueprintHash,result.draft.contentHash);
 const preparedIds=new Set(master.run().records.map(row=>row.qboId));for(const id of Object.values(result.draft.masterBindings))assert.ok(preparedIds.has(id));
});
