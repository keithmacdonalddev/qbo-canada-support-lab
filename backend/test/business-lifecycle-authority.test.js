'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/business-governance-fixture');
const {proposalView,buildDraftDefinition,validateDraftInput}=require('../src/modules/blueprint-draft');
const {masterRequirements}=require('../src/modules/business-master-data');
const {assertPublishedBusiness}=require('../src/modules/business-authority');
const {hash}=require('../src/modules/business-calendar');
const config=require('../src/config'),previous=config.qbo.environment;
test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
test('a newer version2 draft cannot silently change a published version1 business or its next operation',async()=>{
 const h=fixture();await h.publish();const original=structuredClone(h.data.Versions[0]),authorityHash=h.data.Authorities[0].contentHash;
 const definition={...structuredClone(original.definition),activityTemplateVersion:2},newer={...structuredClone(original),_id:'e'.repeat(24),version:2,definition,contentHash:hash(definition),auditId:'new-draft-audit'};h.data.Versions.push(newer);
 const prepared=await h.service.prepare(h.user,{requestKey:'lifecycle-pinned-old-business-0001',throughDate:'2026-10-06'}),plan=h.data.Plans.find(row=>row.operationId===prepared.operationId);
 assert.equal(plan.manifest.businessKey,'harbour-pine-v1');assert.equal(plan.manifest.blueprintHash,original.contentHash);assert.ok(h.data.Intents.every(row=>row.step.details.activityTemplateVersion===undefined));assert.deepEqual(h.data.Versions[0],original);assert.equal(h.data.Authorities[0].contentHash,authorityHash);assert.equal(h.posts,0);
});
test('published authority must agree with its exact saved template, even when its own payload hash is consistent',async()=>{
 const h=fixture();await h.publish();const authority=h.data.Authorities[0];authority.payload.activityTemplateVersion=2;authority.contentHash=hash(authority.payload);h.data.Calendars[0].authorityHash=authority.contentHash;h.data.Audits.find(row=>row._id===authority.auditId).afterState.authorityHash=authority.contentHash;
 await assert.rejects(assertPublishedBusiness({...h.models,scope:require('./helpers/business-governance-fixture').scope}),/published activity rules/);assert.equal(h.posts,0);
});
test('only missing version means the legacy schedule and draft changes retain unused explicit supplier IDs',()=>{
 const p=proposalView(),input={requestKey:'11111111-1111-4111-8111-111111111111',connectionId:'a'.repeat(24),baseHash:null,business:p.business,mappings:p.mappings,masterBindings:{'overhead-supplier-1':'101','overhead-supplier-2':'102','overhead-supplier-3':'103'}};
 for(const activityTemplateVersion of [null,0,4,'2','3',false])assert.throws(()=>validateDraftInput({...input,business:{...input.business,activityTemplateVersion}}),/supported business schedule/);
 const revised=buildDraftDefinition({...input,business:{...input.business,activityTemplateVersion:1}});assert.equal(revised.activityTemplateVersion,undefined);assert.deepEqual(revised.masterBindings,input.masterBindings);assert.equal(masterRequirements({...input.business,activityTemplateVersion:1}).filter(row=>row.key.startsWith('overhead-supplier')).length,0);
});

test('current revision review refreshes audit hashes while preserving accepted opening and completed evidence', {timeout:120000}, async()=>{
 const h=fixture({activityTemplateVersion:2,continuity:true,copyOnWriteTransactions:true});await h.publish();
 const p=await h.service.prepare(h.user,{requestKey:'meaning-continuity-period-0001',throughDate:'2026-10-06'});await h.service.approve(h.user,p.operationId,{planHash:p.planHash});const done=await h.runtime(p.operationId).execute();assert.equal(done.complete,true);
 const retained=JSON.stringify({baseline:h.data.Baselines,plan:h.data.Plans,evidence:h.data.Evidence}),draft=h.saveRevision({displayName:'Current business instructions'}),input={blueprintId:draft._id,blueprintHash:draft.contentHash,effectiveFrom:'2026-10-07'};
 const review=await h.service.reviewContinuity(h.user,input),body={...input,reviewHash:hash('stale observation review'),reason:'Current owner instructions preserve all original records and opening balances.'};
 const posts=h.posts,result=await h.service.applyContinuity(h.user,body);assert.equal(result.applied,true);assert.equal(h.posts,posts);assert.equal(JSON.stringify({baseline:h.data.Baselines,plan:h.data.Plans,evidence:h.data.Evidence}),retained);
 const head=h.data.Authorities.at(-1);assert.equal(head.payload.continuity.reviewHash,hash(head.payload.continuity.review));assert.notEqual(head.payload.continuity.reviewHash,body.reviewHash);assert.equal((await h.service.applyContinuity(h.user,body)).reused,true);
 const old={...structuredClone(h.data.Runs[0]),expectedCursor:h.data.Calendars[0].verifiedThrough};await assertPublishedBusiness({...h.models,scope:require('./helpers/business-governance-fixture').scope,manifest:old});
 await assert.rejects(assertPublishedBusiness({...h.models,scope:require('./helpers/business-governance-fixture').scope,manifest:{...old,baselineHash:hash('other opening')}}));
 assert.equal(review.qboWrites,0);
});
test('future business policy can change routing while physical stock and retained identities stay fixed',()=>{
 const {stableBusiness}=require('../src/modules/business-authority-lineage'),p=proposalView(),previous={business:p.business,mappings:{...p.mappings,operatingBank:'1'},masterBindings:{'field-client-001':'10'}},next=structuredClone(previous);next.mappings.operatingBank='2';next.business.activityTemplateVersion=3;stableBusiness(previous,next);next.masterBindings['field-client-001']='11';assert.throws(()=>stableBusiness(previous,next),/Retain/);
});

test('new occurrence windows use current instructions while pre-change obligations retain their origins',async()=>{
 const h=fixture({activityTemplateVersion:2,continuity:true});await h.publish();
 const original=h.data.Authorities[0],root=original.payload,scope=require('./helpers/business-governance-fixture').scope,d=h.saveRevision({displayName:'Current meaning'}),effectiveFrom='2026-10-07';
 const review={version:1,scope,previousAuthorityHash:original.contentHash,lineageHash:hash([{authorityHash:original.contentHash,blueprintId:root.blueprintId,blueprintHash:root.blueprintHash,effectiveFrom:root.openingDate}]),blueprintId:d._id,blueprintHash:d.contentHash,effectiveFrom,verifiedThrough:'2026-10-06'},reviewHash=hash(review);
 const payload={...structuredClone(root),version:2,blueprintId:d._id,blueprintHash:d.contentHash,continuity:{version:1,sequence:1,parentAuthorityHash:original.contentHash,rootAuthorityHash:original.contentHash,effectiveFrom,reviewHash,review}},contentHash=hash(payload);
 h.data.Authorities.push({_id:'e'.repeat(24),contractVersion:2,...scope,payload,contentHash,auditId:'f'.repeat(24)});h.data.Audits.push({_id:'f'.repeat(24),userId:root.ownerId,realmId:scope.realmId,action:'Future business revision accepted',outcome:'success',afterState:{authorityHash:contentHash,parentAuthorityHash:original.contentHash,blueprintHash:d.contentHash,baselineHash:root.baselineHash,inventoryHash:root.inventoryHash,reviewHash,effectiveFrom,verifiedThrough:'2026-10-06'}});Object.assign(h.data.Calendars[0],{authorityHash:contentHash,blueprintId:d._id,blueprintHash:d.contentHash});
 const old={authorityHash:original.contentHash,blueprintHash:root.blueprintHash,baselineHash:root.baselineHash,expectedCursor:h.data.Calendars[0].verifiedThrough,throughDate:'2026-10-10',entries:[{kind:'create',step:{details:{origin:{occurrence:'2026-10-06'}}}}]};
 await assertPublishedBusiness({...h.models,scope,manifest:old});const legacy={...old,throughDate:'2026-10-06',entries:[{kind:'create',step:{details:{}}}]};await assertPublishedBusiness({...h.models,scope,manifest:legacy});await assert.rejects(assertPublishedBusiness({...h.models,scope,manifest:{...legacy,throughDate:'2026-10-08'}}),/occurrence origins/);old.entries[0].step.details.origin.occurrence='2026-10-08';await assert.rejects(assertPublishedBusiness({...h.models,scope,manifest:old}),/current instructions/);
});
