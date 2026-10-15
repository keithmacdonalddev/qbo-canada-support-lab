'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,scope,ownerId,actorId}=require('./helpers/business-governance-fixture');
const {hash}=require('../src/modules/business-calendar');
const config=require('../src/config'),previous=config.qbo.environment;
test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
async function uncertain(entity,terminalKind='sdk-failure'){
 const h=fixture();await h.publish();const plan=await h.service.prepare(h.user,{requestKey:'uncertain-business-period-001',throughDate:'2026-10-15'});await h.service.approve(h.user,plan.operationId,{planHash:plan.planHash});
 h.afterPost=async(_opts,record)=>{const found=[...h.records.values()].find(row=>row.record===record);if(!entity || found.entity===entity){h.afterPost=null;h.candidate={entity:found.entity,id:record.Id};if(terminalKind==='http-response'){h.responseOverride={status:200,json:{unexpected:'ambiguous fixture response'}};return;}throw Object.assign(Error('Fixture lost network response'),{code:'ECONNRESET'});}};
 const result=await h.runtime(plan.operationId).execute();assert.equal(result.complete,false);const step=h.data.Steps.find(row=>row.dispatch && row.state==='dispatched');assert.ok(step,'unsettled original Step');
 const receipt=h.data.Receipts.find(row=>row.logicalKey===step.logicalKey&&row.dispatchKey===step.dispatch.key);assert.equal(receipt.state,'unknown');assert.equal(receipt.terminal.kind,terminalKind);assert.ok(receipt.terminal.auditId);
 h.plan=plan;h.step=step;h.transport=receipt;h.input={planHash:plan.planHash,logicalKey:step.logicalKey,qboId:h.candidate.id};return h;
}
const decision=(h,review)=>({...h.input,reviewHash:review.reviewHash,confirmOwnership:true,reason:'I identified this exact saved transaction from the failed attempt using the original request, creation details and support evidence.'});
test('terminal unknown attribution retains original transport, requires owner evidence and completes two adjacent periods without replay',async()=>{
 const h=await uncertain(),posts=h.posts,raw=structuredClone(h.transport.observed),terminal=structuredClone(h.transport.terminal);
 const review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input);assert.equal(review.qboWrites,0);assert.equal(review.provenance,'owner-attributed-readback');assert.ok(review.logicalRecordLookups<=21);assert.match(review.limitation,/do not prove/);assert.ok(review.original.sentAt<=review.original.endedAt);assert.equal(review.original.txnDate,review.record.txnDate);assert.deepEqual(review.original.lines.map(row=>row.amount),review.record.lines.map(row=>row.amount));
 const saved=await h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review));assert.equal(saved.attributed,true);assert.equal(h.posts,posts);assert.equal(h.step.state,'saved');assert.equal(h.step.verification,null);assert.equal(h.data.Writers[0].unresolved,null);assert.equal(h.transport.state,'unknown');assert.deepEqual(h.transport.observed,raw);assert.deepEqual(h.transport.terminal,terminal);assert.equal(h.data.Calendars[0].verifiedThrough,null);
 assert.equal((await h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review))).reused,true);assert.equal(h.posts,posts);
 assert.equal((await h.runtime(h.plan.operationId).execute()).complete,true);const firstPosts=h.posts;assert.ok(firstPosts>posts);
 const next=await h.service.prepare(h.user,{requestKey:'uncertain-business-period-002',throughDate:'2026-10-31'});await h.service.approve(h.user,next.operationId,{planHash:next.planHash});assert.equal((await h.runtime(next.operationId).execute()).complete,true);assert.equal(h.data.Calendars[0].verifiedThrough,'2026-10-31');assert.equal(h.data.Receipts.filter(row=>row.ownerRecovery).length,1);
});
test('unfinished request, missing terminal audit and operator cannot attribute a record',async()=>{
 for(const mode of ['unfinished','audit','operator']){const h=await uncertain();if(mode==='unfinished')h.transport.state='possibly-sent';if(mode==='audit')h.data.Audits=h.data.Audits.filter(row=>row._id!==h.transport.terminal.auditId);const before=h.posts;
 await assert.rejects(h.service.reviewUnknown(mode==='operator'?{id:ownerId,actorId}:h.user,h.plan.operationId,h.input));assert.equal(h.posts,before);assert.ok(h.data.Writers[0].unresolved);assert.equal(h.step.receipt,null);}
});
test('changed record, changed parent and changed authority cannot use a stale review',async()=>{
 for(const mode of ['record','parent','authority']){const h=await uncertain(mode==='parent'?'Invoice':undefined),review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input);if(mode==='record')h.records.get(h.candidate.entity.toLowerCase()+':'+h.candidate.id).record.SyncToken='999';if(mode==='parent'){const link=h.step.compilation.relationships[0];h.records.get(link.entity.toLowerCase()+':'+link.qboId).record.SyncToken='999';}if(mode==='authority')h.data.Calendars[0].authorityHash=hash('changed');await assert.rejects(h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review)));assert.ok(h.data.Writers[0].unresolved);assert.equal(h.step.receipt,null);}
});
test('cross-workflow and prior-owner creation evidence or unavailable ownership lookup blocks attribution',async()=>{
 for(const mode of ['step','receipt','reconciled','case','generation','seed','issuepack','master','unavailable']){const h=await uncertain(),id=h.input.qboId,entity=h.step.entity;
 if(mode==='step')h.data.Steps.push({_id:'other-step',environment:scope.environment,realmId:scope.realmId,connectionId:'f'.repeat(24),entity,qboId:id});
 if(mode==='receipt'||mode==='reconciled')h.data.Receipts.push({_id:hash('other-receipt'),environment:scope.environment,realmId:scope.realmId,connectionId:'f'.repeat(24),kind:'legacy',entity:entity.toLowerCase(),...(mode==='receipt'?{observed:{qboId:id}}:{reconciliation:{qboId:id}})});
 if(mode==='case')h.legacy.aiplans.push({_id:'old-case',userId:'f'.repeat(24),realmId:scope.realmId,steps:[{toolName:'createRecord',toolInput:{entityType:entity},result:{data:{id}}}]});
 if(mode==='generation')h.legacy.generationruns.push({_id:'old-generation',userId:'f'.repeat(24),realmId:scope.realmId,environment:scope.environment,steps:[{transaction:{entity},receipt:{Id:id}}]});
 if(mode==='seed'||mode==='issuepack')h.legacy[mode==='seed'?'seedruns':'issuepackruns'].push({_id:'old-run',userId:'f'.repeat(24),realmId:scope.realmId,createdEntities:[{entity,qboId:id}]});
 if(mode==='master')h.legacy.masterpreparationruns.push({_id:'old-master',ownerId:'f'.repeat(24),realmId:scope.realmId,environment:scope.environment,records:[{entity,qboId:id}]});
 if(mode==='unavailable')h.failOwnership='aiplans';await assert.rejects(h.service.reviewUnknown(h.user,h.plan.operationId,h.input),undefined,mode);assert.ok(h.data.Writers[0].unresolved,mode);assert.equal(h.step.receipt,null,mode);}
});
test('content mismatch, missing metadata and wrong QBO ID never permit replacement or replay',async()=>{
 for(const mode of ['marker','metadata','missing']){const h=await uncertain(),record=h.records.get(h.candidate.entity.toLowerCase()+':'+h.candidate.id).record;
 if(mode==='marker'){if(record.PrivateNote)record.PrivateNote+=' changed';else record.Description+=' changed';}if(mode==='metadata')delete record.MetaData;if(mode==='missing')h.input.qboId='999999';const posts=h.posts;await assert.rejects(h.service.reviewUnknown(h.user,h.plan.operationId,h.input));assert.equal(h.posts,posts);assert.ok(h.data.Writers[0].unresolved);}
});
test('atomic audit rollback and lost commit reply preserve an exact idempotent decision',async()=>{
 const h=await uncertain(),review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input),input=decision(h,review);h.failCreate='Audits';await assert.rejects(h.service.attributeUnknown(h.user,h.plan.operationId,input));assert.ok(h.data.Writers[0].unresolved);assert.equal(h.data.Steps.find(row=>row.logicalKey===h.input.logicalKey).receipt,null);h.failCreate=null;h.loseReply=true;await assert.rejects(h.service.attributeUnknown(h.user,h.plan.operationId,input));assert.equal((await h.service.attributeUnknown(h.user,h.plan.operationId,input)).reused,true);assert.equal(h.data.Receipts.find(row=>row._id===h.transport._id).state,'unknown');
});
test('owner-attributed parent and descendant remain valid in graph and tax review without rewriting transport history',async()=>{
 for(const entity of ['TimeActivity','Invoice','Payment']){const h=await uncertain(entity),review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input);await h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review));
 const tax=await h.service.reviewTaxChange(h.user,h.plan.operationId,{planHash:h.plan.planHash});assert.ok(tax.reviewHash);await h.service.approveTaxChange(h.user,h.plan.operationId,{planHash:h.plan.planHash,reviewHash:tax.reviewHash,reason:'Retain saved records and review remaining current Canadian tax expectations.'});assert.equal((await h.runtime(h.plan.operationId).execute()).complete,true,entity);assert.equal(h.transport.state,'unknown');}
});

test('attribution keeps a settled stop and requires separate reviewed resume',async()=>{
 const h=await uncertain();h.data.Calendars[0].stopRequested=true;h.data.Runs[0].status='stopped';const review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input);await h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review));assert.equal(h.data.Calendars[0].stopRequested,true);assert.equal(h.data.Runs[0].status,'stopped');const posts=h.posts;assert.equal((await h.runtime(h.plan.operationId).execute()).complete,false);assert.equal(h.posts,posts);
 const resume=await h.service.reviewResume(h.user,h.plan.operationId,{planHash:h.plan.planHash});await h.service.resume(h.user,h.plan.operationId,{planHash:h.plan.planHash,reviewHash:resume.reviewHash,reason:'The exact unknown request was attributed and saved; continue the same retained operation.'});assert.equal((await h.runtime(h.plan.operationId).execute()).complete,true);
});
test('concurrent exact confirmations create one decision and cannot overwrite the terminal receipt with a later completion',async()=>{
 const h=await uncertain(),review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input),input=decision(h,review),observed=structuredClone(h.transport.observed);
 const results=await Promise.all([h.service.attributeUnknown(h.user,h.plan.operationId,input),h.service.attributeUnknown(h.user,h.plan.operationId,input)]);assert.equal(results.filter(row=>row.reused).length,1);assert.equal(h.data.Authorities.filter(row=>row.payload.kind==='owner-attributed-business-creation').length,1);
 const ticket={coordinated:true,scope,receiptId:h.transport._id,dispatchKey:h.transport.dispatchKey,ownerId,actorId:ownerId};await assert.rejects(h.client.writeGate.complete(ticket,h.step.compilation.request,{status:200,json:{[h.step.entity]:{Id:'999999',SyncToken:'0'}}}));assert.deepEqual(h.transport.observed,observed);assert.equal(h.transport.state,'unknown');assert.equal(h.step.qboId,h.input.qboId);
});
test('changed claim or revoked owner denies stale confirmation and no graph failure permits a subsequent POST',async()=>{
 for(const mode of ['claim','owner','graph']){const h=await uncertain(),review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input),posts=h.posts;
 if(mode==='claim'){h.step.revision++;h.step.leaseToken='replacement-claim-123456';await assert.rejects(h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review)));}
 if(mode==='owner'){h.data.Memberships[0].role='reviewer';await assert.rejects(h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review)));}
 if(mode==='graph'){await h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review));const record=h.records.get(h.candidate.entity.toLowerCase()+':'+h.candidate.id).record;record.PrivateNote='External change after owner attribution';assert.equal((await h.runtime(h.plan.operationId).execute()).complete,false);}
 assert.equal(h.posts,posts,mode);assert.equal(h.data.Calendars[0].verifiedThrough,null,mode);}
});
test('Explorer origin preserves owner attribution and tampered evidence is incomplete rather than a confirmed create response',async()=>{
 const h=await uncertain(),review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input);h.clock+=60000;await h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review));
 const {readRecordOrigin}=require('../src/modules/record-origin'),db={collection:name=>({aggregate:()=>({toArray:async()=>name==='operationsteps'?[h.step]:[]})})},args={db,attributionModels:h.models,userId:ownerId,...scope,entity:h.step.entity,id:h.input.qboId};
 const origin=await readRecordOrigin(args);assert.equal(origin.complete,true);assert.equal(origin.sources[0].kind,'business_owner_attribution');assert.equal(origin.sources[0].provenance,'owner-attributed-readback');assert.match(origin.sources[0].limitation,/remains unknown/);assert.notEqual(origin.sources[0].createdAt,origin.sources[0].attributedAt);assert.equal(JSON.stringify(origin).includes('MetaData'),false);
 h.data.Authorities.find(row=>row.payload.kind==='owner-attributed-business-creation').payload.reason+=' changed';const changed=await readRecordOrigin(args);assert.equal(changed.complete,false);assert.equal(changed.sources.length,0);const posts=h.posts;assert.equal((await h.runtime(h.plan.operationId).execute()).complete,false);assert.equal(h.posts,posts);
});

test('an older audited terminal HTTP response can be attributed while SDK failures require their explicit completion fact',async()=>{
 const h=await uncertain(undefined,'http-response');assert.equal(h.transport.observed.httpStatus,200);assert.equal(h.transport.observed.transportFailure,undefined);h.data.Audits=h.data.Audits.filter(row=>row._id!==h.transport.terminal.auditId);delete h.transport.terminal;
 const review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input);await h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review));assert.equal(h.transport.state,'unknown');assert.equal(h.step.receipt.source,'owner-attributed-readback');assert.equal((await h.runtime(h.plan.operationId).execute()).complete,true);
});

test('terminal completion survives a crashed worker before release; stale claims are revoked and an active worker is still excluded',async()=>{
 const h=await uncertain(),run=h.data.Runs[0];run.status='running';run.leaseToken='old-crashed-worker-123456';run.leaseExpiresAt=new Date(h.clock+60000);await assert.rejects(h.service.reviewUnknown(h.user,h.plan.operationId,h.input));run.leaseExpiresAt=new Date(h.clock-1);
 const review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input),oldStepLease=h.step.leaseToken;await h.service.attributeUnknown(h.user,h.plan.operationId,decision(h,review));assert.equal(run.status,'blocked');assert.equal(run.leaseToken,null);assert.notEqual(h.step.leaseToken,oldStepLease);assert.equal((await h.runtime(h.plan.operationId).execute()).complete,true);
});

test('recorded other-environment legacy activity is distinct from unknown historical ownership',async()=>{
 const h=await uncertain(),entity=h.step.entity,id=h.input.qboId;
 h.legacy.aiplans.push({_id:'other-environment-case',realmId:scope.realmId,steps:[{toolName:'createRecord',toolInput:{entityType:entity},result:{data:{id}},executionScope:{version:1,realmId:scope.realmId,environment:'production'}}]});
 h.legacy.generationruns.push({_id:'other-environment-generation',realmId:scope.realmId,environment:'production',steps:[{transaction:{entity},receipt:{Id:id}}]});
 const review=await h.service.reviewUnknown(h.user,h.plan.operationId,h.input);assert.ok(review.reviewHash);
 h.legacy.aiplans[0].steps[0].executionScope.environment='sandbox';await assert.rejects(h.service.reviewUnknown(h.user,h.plan.operationId,h.input));
});
