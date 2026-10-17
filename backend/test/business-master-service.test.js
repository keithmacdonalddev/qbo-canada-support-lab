'use strict';
process.env.QBO_ENVIRONMENT = 'production';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,scope,ownerId}=require('./helpers/master-service-fixture');
const {masterProgressHash}=require('../src/modules/business-master-receipt');
const {readDraftSetup}=require('../src/modules/blueprint-draft');
const {readBusinessMasters,inspectBusinessMasters}=require('../src/modules/business-master-data');
const {checkBlueprintMappings}=require('../src/modules/blueprint-mapping-check');
const {clone}=require('./helpers/master-transport-fixture');
const executionBody=h=>({planHash:h.run().planHash,reviewHash:masterProgressHash(h.run()),resume:false});
const pump=async predicate=>{for(let n=0;n<50&&!predicate();n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate(),'fixture reached its owned callback');};
async function approved(t,options){const h=fixture(t,options);await h.proposal();await h.approval();return h;}
test('normal owner actions create one verified set and explicitly apply IDs through normal draft validators',async t=>{
 const h=await approved(t),id=String(h.run()._id),initial=clone(h.data.Versions[0]);
 assert.equal(h.sent.length,0);const proposal=(await h.service.inspect(h.user,id)).run;assert.equal(proposal.counts.verifiedRecords,0);assert.equal(proposal.entries.length,32);assert.ok(proposal.entries.some(row=>row.fields.QtyOnHand===0));assert.equal('qboWrites' in proposal,false);
 const body=executionBody(h),started=await h.service.execute(h.user,id,body);assert.equal(started.workerClaimed,true);await h.service.idle();
 const completed=(await h.service.inspect(h.user,id)).run;assert.equal(completed.state,'complete');assert.equal(completed.counts.acceptedRecords,32);assert.equal(completed.counts.verifiedRecords,32);assert.equal(completed.admittedRequests,32);assert.equal(completed.unknownRequests,0);assert.ok(completed.records.every(row=>row.provenance==='request-correlated-master-readback'));assert.equal('qboWrites' in completed,false);
 await h.service.execute(h.user,id,body);await h.service.idle();assert.equal(h.sent.length,32);
 const ordinals=completed.records.map(row=>row.ordinal),review=(await h.service.applyReview(h.user,id,{ordinals})).review;
 const input={ordinals,reviewHash:review.reviewHash,requestKey:'20000000-0000-0000-0000-000000000001'},saved=await h.service.apply(h.user,id,input);assert.equal(saved.draft.version,2);assert.equal(saved.run.claim,'closed');assert.deepEqual(h.data.Versions[0],initial);
 const reads=h.qboReads.length,again=await h.service.apply(h.user,id,input);assert.equal(again.reused,true);assert.equal(again.draft.id,saved.draft.id);assert.equal(h.qboReads.length,reads);assert.equal(h.sent.length,32);
 const view={...scope,draft:saved.draft},setup=await readDraftSetup(h.client,scope,()=>h.clock),masters=await readBusinessMasters(h.client,scope,()=>h.clock),mapping=checkBlueprintMappings(view,setup,{connectionId:scope.connectionId,baseHash:saved.draft.contentHash});
 assert.equal(mapping.rows.filter(row=>row.status==='compatible').length,10);assert.equal(mapping.rows.filter(row=>row.status==='review_required').length,2);assert.equal(inspectBusinessMasters(view,masters).unresolved,0);
 const json=JSON.stringify(completed);for(const field of ['leaseToken','inventoryBefore','ownerAttribution','oauthClient','Authorization'])assert.equal(json.includes('"'+field+'"'),false);
});
test('proposal retry returns the original closed request without reading new company prerequisites',async t=>{
 const h=await approved(t),id=String(h.run()._id);await h.service.retain(h.user,id,{planHash:h.run().planHash,reviewHash:masterProgressHash(h.run()),confirmRetain:true});const reads=h.qboReads.length;
 const repeated=await h.proposal();assert.equal(repeated.existing,true);assert.equal(repeated.run.id,id);assert.equal(repeated.run.claim,'closed');assert.equal(h.qboReads.length,reads);
 await assert.rejects(h.service.prepare(h.user,{...h.body,inventoryStartDate:'2023-09-30'}),/different saved choices/);assert.equal(h.data.MasterRuns.length,1);
});
test('GET status and inspect never start or resume work, and storage preparation is an exact separate action',async t=>{
 const h=fixture(t);h.unprepared=true;const state=await h.service.status(h.user);assert.equal(state.storage.ready,false);assert.equal(state.run,null);assert.equal(h.qboReads.length,0);assert.equal(h.data.MasterRuns.length,0);
 const preview=await h.service.storagePreview(h.user);assert.equal(preview.preview.qboWrites,0);await h.service.storageApply(h.user,{planHash:preview.preview.planHash});assert.equal(h.setups[0][3],'master-preparation');assert.equal(h.setups[1][5],'master-preparation');assert.deepEqual(h.setups[0][1],{...scope,ownerId});assert.equal(h.sent.length,0);
 h.unprepared=false;await h.proposal();const reads=h.qboReads.length;await h.service.status(h.user);await h.service.inspect(h.user,String(h.run()._id));assert.equal(h.qboReads.length,reads);assert.equal(h.sent.length,0);assert.equal(h.run().approval,null);
});
test('current non-owner and read-only membership cannot invoke owner or storage decisions',async t=>{
 const h=fixture(t),actorId='a'.repeat(24);h.data.Users.push({_id:actorId,role:'agent'});h.data.Memberships.push({_id:'readonly-member',userId:actorId,realmId:scope.realmId,status:'active',role:'reviewer'});
 const member={id:ownerId,actorId};await assert.rejects(h.service.prepare(member,h.body));await assert.rejects(h.service.storagePreview(member));assert.equal(h.sent.length,0);assert.equal(h.setups.length,0);assert.equal(h.data.MasterRuns.length,0);
 h.data.Memberships[0].role='reviewer';await assert.rejects(h.proposal());await assert.rejects(h.service.storageApply(h.user,{planHash:'c'.repeat(64)}));assert.equal(h.setups.length,0);
});
test('strict inputs reject payload, scope, actor, proof and draft overrides before sending anything',async t=>{
 const h=fixture(t);for(const extra of [{payload:{}},{ownerId},{environment:'sandbox'},{actorId:ownerId},{readback:{}}])await assert.rejects(h.service.prepare(h.user,{...h.body,...extra}),{status:400});
 await assert.rejects(h.service.prepare(h.user,{...h.body,baseHash:'f'.repeat(64)}));assert.equal(h.qboReads.length,0);assert.equal(h.sent.length,0);
 await h.proposal();const id=String(h.run()._id);await assert.rejects(h.service.applyReview(h.user,id,{ordinals:[0],proofs:[]}),{status:400});await assert.rejects(h.service.approve(h.user,id,{planHash:h.run().planHash,productionConfirmed:'true'}),{status:400});await assert.rejects(h.service.inspect(h.user,'ABCDEF000000000000000001'));assert.equal(h.sent.length,0);
});
test('source change and active company work prevent fresh approval without saving authority',async t=>{
 const h=fixture(t);await h.proposal();h.busyCollection='operationruns';await assert.rejects(h.approval(),/Earlier company work/);assert.equal(h.run().approval,null);assert.equal(h.sent.length,0);
 h.busyCollection=null;h.data.Versions.push({...clone(h.data.Versions[0]),_id:'a'.repeat(24),version:2});h.data.Sequences[0].value=2;await assert.rejects(h.approval(),/changed|different|newer/);assert.equal(h.run().approval,null);
});
test('saved IDs await independent readback and retain their mandatory response audits in the public view',async t=>{
 const h=await approved(t),id=String(h.run()._id);h.changeRead=record=>({...record,Active:false});await h.service.execute(h.user,id,executionBody(h));await h.service.idle();const saved=(await h.service.inspect(h.user,id)).run;
 assert.equal(saved.records[0].state,'saved');assert.equal(saved.records[0].provenance,null);assert.equal(saved.counts.acceptedRecords,1);assert.equal(saved.counts.verifiedRecords,0);assert.equal(saved.actions.recoverAccepted,true);assert.equal(saved.admittedRequests,1);assert.equal('qboWrites' in saved,false);
 h.data.Audits=h.data.Audits.filter(row=>String(row._id)!==String(h.data.Receipts[0].resultAuditId));const incomplete=(await h.service.inspect(h.user,id)).run;assert.equal(incomplete.integrity,'needs-review');assert.equal(incomplete.counts.acceptedRecords,0);assert.equal(incomplete.actions.recoverAccepted,false);assert.equal(incomplete.records[0].provenance,null);
});
test('readback recovery works with automation paused, sends no POST and keeps Stop set',async t=>{
 const h=await approved(t),id=String(h.run()._id);h.changeRead=record=>({...record,Active:false});await h.service.execute(h.user,id,executionBody(h));await h.service.idle();h.changeRead=null;
 Object.assign(h.data.Users[0],{email:'tester@testdatalab.local',authVersion:1,accessPolicyVersion:1,automationAccessPolicyVersion:0});
 const state=await h.service.status(h.user);assert.equal(state.permissions.execute,false);assert.equal(state.permissions.recover,true);
 await h.service.recover(h.user,id,{planHash:h.run().planHash,reviewHash:masterProgressHash(h.run())});await h.service.idle();assert.equal(h.sent.length,1);assert.equal(h.run().records[0].state,'verified');assert.equal(h.run().stopRequested,true);assert.equal(h.writer().unresolved,null);
});
test('duplicate execution waits for the shared durable claim and cannot acknowledge a refused worker',async t=>{
 const callbacks=[],h=await approved(t,{defer:callback=>callbacks.push(callback)}),id=String(h.run()._id),body=executionBody(h);
 const first=h.service.execute(h.user,id,body);await pump(()=>callbacks.length===1);let duplicateSettled=false;const second=h.service.execute(h.user,id,body).then(value=>{duplicateSettled=true;return value;});await new Promise(resolve=>setImmediate(resolve));assert.equal(duplicateSettled,false);
 await h.service.stop(h.user,id,{});callbacks.shift()();const replies=await Promise.all([first,second]);await h.service.idle();assert.ok(replies.every(row=>row.workerClaimed===false));assert.equal(h.sent.length,0);assert.equal(h.run().stopRequested,true);
});
test('a repeated Stop supersedes a pending Continue even when the saved run was already stopped',async t=>{
 const callbacks=[],h=await approved(t,{defer:callback=>callbacks.push(callback)}),id=String(h.run()._id);await h.service.stop(h.user,id,{});const before=masterProgressHash(h.run()),pending=h.service.execute(h.user,id,{...executionBody(h),resume:true});await pump(()=>callbacks.length===1);await h.service.stop(h.user,id,{});assert.notEqual(masterProgressHash(h.run()),before);callbacks.shift()();assert.equal((await pending).workerClaimed,false);await h.service.idle();assert.equal(h.sent.length,0);assert.equal(h.run().stopRequested,true);
});
test('readback recovery binds the reviewed progress inside its claim transaction',async t=>{
 const callbacks=[],h=await approved(t,{defer:callback=>callbacks.push(callback)}),id=String(h.run()._id);h.changeRead=record=>({...record,Active:false});const started=h.service.execute(h.user,id,executionBody(h));await pump(()=>callbacks.length===1);callbacks.shift()();await started;await h.service.idle();h.changeRead=null;const reads=h.exactReads.length;
 const pending=h.service.recover(h.user,id,{planHash:h.run().planHash,reviewHash:masterProgressHash(h.run())});await pump(()=>callbacks.length===1);await h.service.stop(h.user,id,{});callbacks.shift()();assert.equal((await pending).workerClaimed,false);await h.service.idle();assert.equal(h.exactReads.length,reads);assert.equal(h.sent.length,1);assert.equal(h.run().records[0].state,'saved');
});
test('revocation during a public state read prevents metadata from being returned',async t=>{
 const h=fixture(t);await h.proposal();const original=h.models.Versions.findOne;h.models.Versions.findOne=function(...args){const query=original.apply(this,args),read=query.lean;query.lean=async()=>{const value=await read();h.data.Memberships[0].status='suspended';return value;};return query;};
 await assert.rejects(h.service.inspect(h.user,String(h.run()._id)),{status:403});assert.equal(h.sent.length,0);
});
test('owner attribution preserves unknown provenance and missing markers never become confirmed readback assurances',async t=>{
 const h=await approved(t),id=String(h.run()._id);h.afterCreate=async (record,entity)=>{h.remote[entity].find(value=>value.Id===record.Id).MetaData={CreateTime:new Date(h.clock).toISOString()};throw Object.assign(Error('fixture lost response'),{code:'500'});};await h.service.execute(h.user,id,executionBody(h));await h.service.idle();
 const unknown=(await h.service.inspect(h.user,id)).run;assert.equal(unknown.unknownRequests,1);assert.equal(unknown.counts.acceptedRecords,0);assert.equal(unknown.actions.attributeUnknown,true);assert.equal('qboWrites' in unknown,false);
 const row=h.run().records[0],review=(await h.service.attributionReview(h.user,id,{ordinal:0,qboId:h.remote.Account.at(-1).Id})).review;await h.service.attribute(h.user,id,{ordinal:0,qboId:review.qboId,reviewHash:review.reviewHash,confirmOwnership:true,reason:'I independently identified this exact master using the original request and company evidence.'});
 const identified=(await h.service.inspect(h.user,id)).run;assert.equal(identified.records[0].provenance,'owner-attributed-master-readback');assert.equal(identified.counts.ownerAttributedRecords,1);assert.equal(identified.counts.acceptedRecords,0);assert.equal(h.data.Receipts[0].state,'unknown');assert.equal(h.sent.length,1);
 delete h.run().records[0].attempts.at(-1).ownerAttribution;const bad=(await h.service.inspect(h.user,id)).run;assert.equal(bad.integrity,'needs-review');assert.equal(bad.records[0].provenance,null);assert.equal(bad.counts.acceptedRecords,0);assert.equal(bad.counts.verifiedRecords,0);assert.equal(bad.actions.execute,false);assert.equal(bad.actions.apply,false);
});
test('history pages retain exact IDs and cannot inject another company or cursor',async t=>{
 const h=fixture(t);await h.proposal();const seed=clone(h.run());for(let n=0;n<24;n++)h.data.MasterRuns.push({...clone(seed),_id:(n+10).toString(16).padStart(24,'0'),claim:'closed',state:'closed',records:[]});
 const first=await h.service.history(h.user,{before:null}),second=await h.service.history(h.user,{before:first.next});assert.equal(first.entries.length,20);assert.equal(second.entries.length,5);assert.equal(new Set([...first.entries,...second.entries].map(row=>row.id)).size,25);assert.equal(second.next,null);
 await assert.rejects(h.service.history(h.user,{before:null,realmId:'999'}),{status:400});await assert.rejects(h.service.history(h.user,{before:{}}),{status:400});
});

test('supplier-only owner flow creates and applies six vendors without altering existing masters or filling stock',async t=>{
 const h=fixture(t,{lifecycleVersion:2}), {hash}=require('../src/modules/business-calendar');
 const version=h.data.Versions[0]; version.definition.masterBindings={'field-client-001':'901'}; version.contentHash=hash(version.definition); h.body.baseHash=version.contentHash; h.body.recordScope='suppliers';
 h.remote.Customer.push({Id:'901',DisplayName:'Existing field customer',Active:true,CurrencyRef:{value:'CAD'},SyncToken:'3'});
 const original=clone(version), customer=clone(h.remote.Customer), items=clone(h.remote.Item), accounts=clone(h.remote.Account);
 await h.proposal(); assert.equal(h.run().plan.recordScope,'suppliers'); assert.equal(h.run().records.length,6); await h.approval();
 const id=String(h.run()._id), body=executionBody(h); await h.service.execute(h.user,id,body); await h.service.idle();
 const completed=(await h.service.inspect(h.user,id)).run; assert.equal(completed.state,'complete'); assert.equal(completed.counts.verifiedRecords,6); assert.equal(completed.admittedRequests,6); assert.equal(h.remote.Vendor.length,6);
 assert.ok(completed.records.every(row=>row.entity==='Vendor'&&row.provenance==='request-correlated-master-readback'));
 const ordinals=completed.records.map(row=>row.ordinal), review=(await h.service.applyReview(h.user,id,{ordinals})).review;
 const apply={ordinals,reviewHash:review.reviewHash,requestKey:'30000000-0000-0000-0000-000000000001'}, saved=await h.service.apply(h.user,id,apply);
 assert.equal(saved.draft.masterBindings['field-client-001'],'901'); assert.equal(Object.keys(saved.draft.masterBindings).length,7); assert.ok(!Object.keys(saved.draft.masterBindings).some(key=>key.startsWith('workshop-stock')));
 assert.deepEqual(h.data.Versions[0],original); assert.deepEqual(h.remote.Customer,customer); assert.deepEqual(h.remote.Item,items); assert.deepEqual(h.remote.Account,accounts);
 await h.service.execute(h.user,id,body); await h.service.idle(); await h.service.apply(h.user,id,apply); await h.proposal(); assert.equal(h.sent.length,6);
 const {recordScope,...full}=h.body; await assert.rejects(h.service.prepare(h.user,full),/different saved choices/);
});
test('proposal reuse refuses a different record scope before returning an open run',async t=>{
 const h=fixture(t,{lifecycleVersion:2}); await h.proposal();
 await assert.rejects(h.service.prepare(h.user,{...h.body,recordScope:'suppliers'}),/different saved choices/);
 await assert.rejects(h.service.prepare(h.user,{...h.body,recordScope:'suppliers',requestKey:'30000000-0000-0000-0000-000000000002'}),/different records/);
 assert.equal(h.sent.length,0);assert.equal(h.data.MasterRuns.length,1);
});
