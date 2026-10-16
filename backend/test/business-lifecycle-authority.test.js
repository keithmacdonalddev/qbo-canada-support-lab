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
