'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {businessErrorDetail,attachBusinessError,failureFields,definitionDifferences,collectBusinessBlockers,businessBlockersFor,escalateBusinessBlockers,MAX_BYTES,STUCK_MS}=require('../src/modules/business-error-detail');
const now=Date.parse('2026-10-31T22:00:00Z'),scope={environment:'production',realmId:'123',connectionId:'d'.repeat(24)},op='a'.repeat(24),key='b'.repeat(64);
const error=()=>Object.assign(new Error('The Item differs from approval.'),{code:'BUSINESS_REFERENCE_UNVERIFIED',stack:'Error: mismatch\n    at fail (C:\\Projects\\qbo\\backend\\src\\modules\\business-reference.js:14:20)\n    at verifyBusinessReference (C:\\Projects\\qbo\\backend\\src\\modules\\business-reference.js:75:21)',businessDetail:{entity:'Item',recordId:'9',differences:[{field:'IncomeAccountRef.value',approved:'10',current:'11'}],expectedVersion:'1',observedVersion:'2'}});
function query(rows,calls=[]){return {find(filter){calls.push(filter);return {select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>rows};}};}
test('captures the actual check, versions, record and bounded field differences',()=>{
 const d=businessErrorDetail(error(),{operationId:op,logicalKey:key});
 assert.equal(d.check.function,'verifyBusinessReference');assert.equal(d.check.file,'backend/src/modules/business-reference.js');assert.equal(d.check.line,75);assert.equal(d.entity,'Item');assert.equal(d.recordId,'9');assert.equal(d.operationId,op);assert.equal(d.logicalKey,key);assert.equal(d.detail.differences[0].current,'11');
});
test('normalization is stable across catch/result/JSON boundaries and distrusts arbitrary version-1 detail',()=>{
 const e=attachBusinessError(error(),{operationId:op,logicalKey:key}),d=e.errorDetail;
 assert.equal(businessErrorDetail(e),d);assert.deepEqual(businessErrorDetail(JSON.parse(JSON.stringify(d))),d);
 const unsafe={...d,detail:{apiKey:'private-value',nested:{authorization:'Bearer unsafe-token-value'},huge:'x'.repeat(50000)},check:{...d.check,authorization:'hidden'},unexpected:'private'};
 const safe=businessErrorDetail({errorDetail:unsafe});assert.ok(Buffer.byteLength(JSON.stringify(safe))<=MAX_BYTES);assert.ok(!JSON.stringify(safe).includes('private-value'));assert.ok(!JSON.stringify(safe).includes('unsafe-token-value'));assert.equal(safe.unexpected,undefined);assert.equal(safe.check.authorization,undefined);
});
test('difference snapshots redact credentials before renaming approved/current values and retain SyncToken versions',()=>{
 const diff=definitionDifferences({apiKey:'private-before',SyncToken:'1',IncomeAccountRef:{value:'10'}},{apiKey:'private-after',SyncToken:'2',IncomeAccountRef:{value:'11'}});
 assert.ok(!JSON.stringify(diff).includes('private-'));assert.ok(diff.some(d=>d.field==='SyncToken'&&d.approved==='1'&&d.current==='2'));assert.ok(diff.some(d=>d.field==='IncomeAccountRef.value'));
});
test('identical failures group with count and first/last time rather than restarting the deadline',()=>{
 const d=businessErrorDetail(error(),{operationId:op,logicalKey:key}),a=failureFields(null,d,{},now-20*60000),b=failureFields(a,d,{},now);
 assert.equal(b.errorHistory.length,1);assert.equal(b.errorHistory[0].count,2);assert.equal(b.errorHistory[0].firstAt,new Date(now-20*60000).toISOString());assert.equal(b.errorHistory[0].lastAt,new Date(now).toISOString());
 const blocks=collectBusinessBlockers({runs:[{_id:op,status:'blocked',...b,updatedAt:new Date(now)}],now});assert.equal(blocks.length,1);assert.equal(blocks[0].overdue,true);assert.equal(blocks[0].count,2);
});
test('a running step stalls after fifteen minutes even when the lease was just renewed',()=>{
 const row={_id:'step',operationId:op,logicalKey:key,state:'claimed',createdAt:new Date(now-STUCK_MS),updatedAt:new Date(now)};
 assert.equal(collectBusinessBlockers({steps:[row],now}).length,0);
 assert.equal(collectBusinessBlockers({steps:[row],now:now+1})[0].overdue,true);
 assert.equal(collectBusinessBlockers({steps:[{...row,state:'verified'}],now:now+1}).length,0);
});
test('run and step copies of the same error are counted once',()=>{
 const d=businessErrorDetail(error(),{operationId:op,logicalKey:key}),f=failureFields(null,d,{},now-20*60000);
 const blockers=collectBusinessBlockers({runs:[{_id:op,status:'blocked',...f}],steps:[{_id:'step',operationId:op,state:'claimed',...f}],now});assert.equal(blockers.length,1);assert.equal(blockers[0].count,1);
});
test('blocker reads scope every query and exclude retired/stopped historical steps except uncertain requests',async()=>{
 const runCalls=[],stepCalls=[],generalCalls=[];
 const result=await businessBlockersFor({scope,now,models:{Runs:query([{_id:op,status:'running',createdAt:new Date(now)}],runCalls),Steps:query([],stepCalls),GeneralWriteRuns:query([],generalCalls)}});
 assert.equal(result.blockers.length,0);for(const filter of [...runCalls,...stepCalls,...generalCalls])for(const k of Object.keys(scope))assert.equal(filter[k],scope[k]);
 assert.deepEqual(stepCalls[0].$or[0].operationId.$in,[op]);assert.deepEqual(stepCalls[0].$or[1].state.$in,['dispatched','unknown']);
});
test('overdue failures create one owner alert and one high-priority build item, updating both groups',async()=>{
 const d=businessErrorDetail(error(),{operationId:op,logicalKey:key});let row={_id:op,status:'blocked',...failureFields(null,d,{},now-20*60000)};
 const saved=new Map(),updates=[],agent={_id:'c'.repeat(24)};
 const store={models:{Runs:query([]),Steps:query([]),GeneralWriteRuns:query([]),Events:{updateOne:async(f,u)=>updates.push({f,u})}},event:async(r,kind,title,detail,data,session,id)=>{const k=kind+id;if(!saved.has(k))saved.set(k,{id:String(saved.size),kind,title,detail,data});return saved.get(k);}};
 store.models.Runs.find=filter=>{const q=query([row]).find(filter);return q;};
 await escalateBusinessBlockers({store,row:agent,scope,now});row={...row,...failureFields(row,d,{},now)};
 await escalateBusinessBlockers({store,row:agent,scope,now});
 assert.equal(saved.size,2);assert.equal(updates.length,4);const build=updates.at(-1).u.$set.data;assert.equal(build.priority,'high');assert.equal(build.count,2);assert.deepEqual(build.errorDetail,d);assert.equal(updates.at(-1).f.connectionId,scope.connectionId);
});
test('build list and management context preserve error details and recurrence evidence',()=>{
 const {openRequests,managementContext}=require('../src/modules/business-management-review'),{blockerBuild}=require('../src/modules/business-error-detail');
 const d=businessErrorDetail(error()),b=blockerBuild({key:'f'.repeat(64),errorDetail:d,count:4,firstAt:'first',lastAt:'last'});
 assert.deepEqual(openRequests([b])[0].errorDetail,d);assert.equal(openRequests([b])[0].count,4);
 const context=managementContext({requests:[b],nowMs:now});assert.deepEqual(context.capabilityRequests[0].errorDetail,d);
});
test('live feed shows failure detail and stops claiming that a blocked claim is sending',()=>{
 const {buildLiveFeed}=require('../src/modules/business-agent-live'),d=businessErrorDetail(error(),{operationId:op,logicalKey:key});
 const feed=buildLiveFeed({now,configured:true,settings:{monitoring:true},runs:[{_id:op,status:'blocked',createdAt:new Date(now-10000),updatedAt:new Date(now),recordCount:2,nextOrdinal:0,errorDetail:d}],steps:[{_id:'step',operationId:op,state:'claimed',entity:'Invoice',createdAt:new Date(now-10000),updatedAt:new Date(now),errorDetail:d}]});
 assert.equal(feed.sending,null);assert.notEqual(feed.state,'sending');const item=feed.items.find(i=>i.id==='step:step');assert.deepEqual(item.errorDetail,d);assert.equal(item.status,'attention');
});
test('blockers endpoint delegates through the existing protected router without writes',async()=>{
 const {createBusinessAgentRouter}=require('../src/routes/business-agent');let seen=null;
 const router=createBusinessAgentRouter({service:()=>({blockers:async user=>{seen=user;return {blockers:[]};}})}),route=router.stack.find(layer=>layer.route?.path==='/blockers');
 assert.ok(route.route.methods.get);assert.ok(router.stack[0].handle,'existing authentication remains mounted first');
 const req={user:{id:'owner'}},res={json(value){this.value=value;}};
 await route.route.stack[0].handle(req,res);assert.equal(seen,req.user);assert.deepEqual(res.value,{data:{blockers:[]}});
});

test('current reference routing is returned without rewriting historical binding; identity errors retain diagnostics',()=>{
 const {bindBusinessReference,verifyBusinessReference}=require('../src/modules/business-reference'),{hash}=require('../src/modules/business-calendar');
 const observation=record=>({scope,entity:'Item',observedAt:new Date(now).toISOString(),record,recordHash:hash(record),source:{version:1,kind:'qbo-full-entity-get',scope,entity:'Item',id:record.Id,endpoint:'item/'+record.Id,recordHash:hash(record)}});
 const original=observation({Id:'9',SyncToken:'1',Active:true,Name:'Care',Type:'Service',IncomeAccountRef:{value:'10'}}),binding=bindBusinessReference({scope,key:'care-plan-1',entity:'Item',observed:original,now}),before=structuredClone(binding);
 const current={...observation({...original.record,SyncToken:'2',IncomeAccountRef:{value:'11'}}),definitionObservation:original};
 // Stage 1A (71b72f4) resolves current references; the compiler checks accounting purpose.
 assert.equal(verifyBusinessReference({scope,binding,observed:current,now}).IncomeAccountRef.value,'11');
 const other=observation({...current.record,Id:'99'});
 assert.throws(()=>verifyBusinessReference({scope,binding,observed:other,now}),e=>{const d=businessErrorDetail(e);assert.equal(d.detail.entity,'Item');assert.equal(d.detail.recordId,'9');assert.equal(d.detail.bindingKey,'care-plan-1');assert.equal(d.check.function,'verifyBusinessReference');return true;});assert.deepEqual(binding,before);
});
test('tax-rate refusal retains the selected rate/date and effective boundary',()=>{
 const {applicableRate}=require('../src/modules/business-tax-policy');
 assert.throws(()=>applicableRate({Id:'7',SyncToken:'2',Active:true,EffectiveTaxRate:[{EffectiveDate:'2027-01-01',RateValue:15}]},'2026-10-31'),e=>{const d=businessErrorDetail(e);assert.equal(d.detail.rateId,'7');assert.equal(d.detail.txnDate,'2026-10-31');assert.equal(d.check.function,'applicableRate');return true;});
});
test('deferred needs-check returns the exact saved diagnostic and release retains it',async()=>{
 const {createBusinessOperationRunner}=require('../src/modules/business-operation-runner'),d=businessErrorDetail(error(),{operationId:op,logicalKey:key});
 let current={status:'running',planHash:'c'.repeat(64),nextOrdinal:0,recordCount:1,leaseToken:'owned',deferredSteps:[]},released;
 const state={inspect:async()=>current,claim:async()=>current,renew:async()=>current,advance:async()=>current={...current,nextOrdinal:1,deferredSteps:[{ordinal:0,logicalKey:key}]},release:async(s,o,l,r,e)=>{released=e;return current={...current,leaseToken:null};}};
 const runner=createBusinessOperationRunner({state,plans:{page:async()=>({operationId:op,planHash:current.planHash,recordCount:1,offset:0,entries:[{kind:'create',step:{logicalKey:key,entity:'Invoice',dependencies:[]}}]})},steps:{verifyGraph:async()=>({})},dispatch:async()=>({state:'needs-check',errorDetail:d}),periods:{reserve:async()=>{},finish:async()=>{},repair:async()=>{}},prepareEvidence:async()=>({prepared:false})});
 const result=await runner(scope,op);assert.equal(result.state,'needs-check');assert.equal(result.errorDetail,d);assert.equal(released,d);
});
test('background execution retains the same structured refusal in executionRequest.result',async()=>{
 const fixture=require('./helpers/business-assembled-fixture'),{createBusinessExecutionService}=require('../src/modules/business-execution-service'),config=require('../src/config'),previous=config.qbo.environment;
 const h=fixture.harness(),queued=[],d=businessErrorDetail(error(),{operationId:fixture.operationId,logicalKey:key});config.qbo.environment='sandbox';
 const service=createBusinessExecutionService({models:h.models,transaction:h.transaction,assertReady:h.assertReady,now:()=>h.clock,defer:f=>queued.push(f),resolveContext:async()=>({environment:fixture.scope.environment,connection:{realmId:fixture.scope.realmId,connectionId:fixture.scope.connectionId}}),runtimeFor:()=>({execute:async()=>({state:'blocked',complete:false,errorDetail:d})})});
 try{await service.request({id:fixture.ownerId,actorId:fixture.actorId},fixture.operationId,{planHash:h.data.Runs[0].planHash,requestKey:'structured_failure_01'});for(const f of queued)f();await service.idle();assert.deepEqual(h.data.Runs[0].executionRequest.result.errorDetail,d);assert.deepEqual(h.data.Runs[0].errorDetail,d);assert.equal(h.sent.length,0);}finally{service.close();config.qbo.environment=previous;}
});

test('one execution refusal is counted once across release and settlement, and again on the next request',()=>{
 const d=businessErrorDetail(error()),request1={id:'request-one'},request2={id:'request-two'};
 const released=failureFields({executionRequest:request1},d,{},now-1000),settled=failureFields({...released,executionRequest:request1},d,{},now);
 assert.equal(settled.errorHistory[0].count,1);
 const retry=failureFields({...settled,executionRequest:request2},d,{},now+1000);assert.equal(retry.errorHistory[0].count,2);assert.equal(retry.errorHistory[0].firstAt,released.errorHistory[0].firstAt);
});

test('unrelated historical witness cannot substitute for complete current company provenance',()=>{
 const {bindBusinessReference,verifyBusinessReference}=require('../src/modules/business-reference'),{hash}=require('../src/modules/business-calendar');
 const observation=record=>({scope,entity:'Item',observedAt:new Date(now).toISOString(),record,recordHash:hash(record),source:{version:1,kind:'qbo-full-entity-get',scope,entity:'Item',id:record.Id,endpoint:'item/'+record.Id,recordHash:hash(record)}});
 const approved=observation({Id:'9',SyncToken:'1',Active:true,Name:'Care',Type:'Service',IncomeAccountRef:{value:'10'}}),binding={...bindBusinessReference({scope,key:'care-plan-1',entity:'Item',observed:approved,now}),definition:require('../src/modules/business-reference').referenceDefinition(scope,'Item',approved.record,1)};
 const wrong=observation({...approved.record,IncomeAccountRef:{value:'999'}}),current={...observation({...approved.record,SyncToken:'2',IncomeAccountRef:{value:'11'}}),definitionObservation:wrong};
 const before=structuredClone(binding);
 assert.equal(verifyBusinessReference({scope,binding,observed:current,now,resolveDefinitionObservation:()=>approved}),current.record);
 const untrusted={...current,source:{...current.source,scope:{...scope,realmId:'999'}}};
 assert.throws(()=>verifyBusinessReference({scope,binding,observed:untrusted,now,resolveDefinitionObservation:()=>approved}),e=>{const d=businessErrorDetail(e);assert.match(d.message,/provenance/);assert.equal(e.referenceDiagnostic.retainedDefinitionResolved,false);assert.equal(d.detail.differences?.length||0,0);return true;});
 assert.deepEqual(binding,before);
});

test('inspectBlocker returns the retained structured run error unchanged alongside its own comparisons',async()=>{
 const {createBlockerInspection}=require('../src/modules/business-blocker-inspection'),d=businessErrorDetail(error(),{operationId:op,logicalKey:key});
 const chain=value=>({maxTimeMS(){return this;},sort(){return this;},limit(){return this;},lean:async()=>value});
 const models={Runs:{findOne:filter=>{assert.equal(filter.connectionId,scope.connectionId);return chain({_id:op,status:'blocked',planHash:'f'.repeat(64),executionRequest:{result:{errorDetail:d}}});}},Steps:{find:()=>chain([])},Intents:{findOne:()=>chain(null),find:()=>chain([])}};
 const result=await createBlockerInspection({models,scope,now:()=>now})(op);assert.deepEqual(result.data.errorDetail,d);assert.equal(result.data.qboRequests,0);assert.equal(result.data.readOnly,true);
});

test('twenty near-limit step errors keep inspection under budget with primary evidence unchanged',async()=>{
 const {createBlockerInspection}=require('../src/modules/business-blocker-inspection');
 const detail=businessErrorDetail({code:'BUSINESS_TEST_FAILURE',message:'m'.repeat(600),businessDetail:Object.fromEntries(Array.from({length:10},(_,i)=>['field'+i,'v'.repeat(300)]))},{operationId:op,check:{module:'m'.repeat(100),function:'f'.repeat(100),file:'backend/src/modules/'+ 'f'.repeat(140)+'.js',line:1}});
 const intents=Array.from({length:20},(_,i)=>({ordinal:i,logicalKey:i.toString(16).padStart(64,'0'),step:{entity:'Invoice',references:[]},policy:{}})),saved=intents.map(i=>({logicalKey:i.logicalKey,state:'needs-check',errorDetail:{...detail,logicalKey:i.logicalKey}}));
 const chain=value=>({maxTimeMS(){return this;},sort(){return this;},limit(){return this;},lean:async()=>value});
 const models={Runs:{findOne:()=>chain({_id:op,status:'blocked',planHash:'f'.repeat(64),executionRequest:{result:{errorDetail:detail}}})},Steps:{find:()=>chain(saved)},Intents:{findOne:()=>chain(intents[0]),find:()=>chain(intents)}};
 const result=await createBlockerInspection({models,scope,now:()=>now})(op);assert.ok(Buffer.byteLength(JSON.stringify(result.data))<=85000);assert.deepEqual(result.data.errorDetail,detail);assert.deepEqual(result.data.steps[0].errorDetail,saved[0].errorDetail);assert.ok(result.data.limitations.some(s=>s.includes('step diagnostics omitted')));
});

test('write denials retain the actual reason, stage and caller through saved and JSON boundaries',()=>{
 const {denied}=require('../src/modules/qbo-write-contract');
 for(const unknown of [false,true]){
  const e=denied('The exact saved general batch is not ready to send.',unknown);
  e.stack='Error: denied\n    at denied (C:\\Projects\\qbo\\backend\\src\\modules\\qbo-write-contract.js:7:20)\n    at Object.admit (C:\\Projects\\qbo\\backend\\src\\modules\\general-write-transport.js:143:12)';
  const d=attachBusinessError(e,{operationId:op,detail:{batch:0}}).errorDetail;
  assert.equal(d.code,unknown?'QBO_WRITE_OUTCOME_UNKNOWN':'QBO_WRITE_ADMISSION_DENIED');assert.equal(d.message,e.message);
  assert.equal(d.detail.batch,0);assert.equal(d.detail.qboStage,unknown?'write_receipt':'write_admission');assert.equal(d.detail.outcomeUnknown,unknown);
  assert.equal(d.check.function,'Object.admit');assert.equal(d.check.module,'general-write-transport');
  assert.deepEqual(businessErrorDetail(JSON.parse(JSON.stringify(d))),d);
  assert.equal(failureFields(null,e,{},now).errorDetail.message,e.message);
 }
 const arbitrary=businessErrorDetail(new Error('untrusted provider payload'));
 assert.equal(arbitrary.message,'Business work could not finish. Saved progress is retained.');
});

test('diagnostic build history resolves, reopens on recurrence, then resolves again without deleting evidence',async()=>{
 const {model}=require('./replay/memory.cjs'),{fold}=require('../src/modules/business-capability-review');
 let clock=now;const runs=[],saved=new Map(),d=businessErrorDetail(error(),{operationId:op});
 const failed=()=>({_id:op,...scope,status:'blocked',...failureFields(null,d,{},clock-20*60000)});
 const models={Runs:model(runs),Steps:model([]),GeneralWriteRuns:model([]),Agents:model([]),GeneralDayCloses:model([]),Events:{updateOne:async(f,u)=>{const row=saved.get(f._id);if(row)Object.assign(row,u.$set)}}};
 const store={models,capabilityRequests:async()=>[...saved.values()].filter(e=>e.kind==='capability-request'||e.kind==='capability-review').map(e=>({id:e._id,kind:e.kind,at:e.at,...e.data})),event:async(row,kind,title,detail,data,session,key)=>{const id=kind+':'+key;if(!saved.has(id))saved.set(id,{_id:id,...scope,kind,title,detail,data,at:new Date(clock).toISOString()});return{id,...saved.get(id)};}};
 const agent={_id:'c'.repeat(24)};runs.push(failed());await escalateBusinessBlockers({store,row:agent,scope,now:clock});
 assert.equal(fold(await store.capabilityRequests())[0].status,'open');
 clock+=1000;runs.splice(0);await escalateBusinessBlockers({store,row:agent,scope,now:clock});assert.equal(fold(await store.capabilityRequests())[0].status,'resolved');
 clock+=1000;runs.push(failed());await escalateBusinessBlockers({store,row:agent,scope,now:clock});assert.equal(fold(await store.capabilityRequests())[0].status,'reopened');
 clock+=1000;runs.splice(0);await escalateBusinessBlockers({store,row:agent,scope,now:clock});assert.equal(fold(await store.capabilityRequests())[0].status,'resolved');
 assert.equal([...saved.values()].filter(e=>e.kind==='capability-request').length,1);assert.equal([...saved.values()].filter(e=>e.kind==='capability-review').length,3);
 const before=saved.size;await escalateBusinessBlockers({store,row:agent,scope,now:clock});assert.equal(saved.size,before);
});
test('incomplete diagnostic stores cannot close historical build requests',async()=>{
 const d=businessErrorDetail(error(),{operationId:op}),{fingerprint}=require('../src/modules/business-error-detail');let changes=0;
 const store={models:{Runs:query([]),Steps:query([]),GeneralWriteRuns:query([])},capabilityRequests:async()=>[{kind:'capability-request',key:'business-blocker-'+fingerprint(d),status:'open',errorDetail:d}],event:async()=>{changes++;}};
 await escalateBusinessBlockers({store,row:{_id:'agent'},scope,now});assert.equal(changes,0);
});

test('known retained native-origin failures preserve static reasons with exact-code matching and existing bounds',()=>{for(const code of ['GENERAL_CALENDAR_FULFILLMENT_UNVERIFIED','GENERAL_TIME_ESTIMATE_HELD']){const message='The exact retained origin proof is unavailable. '+ 'x'.repeat(800);const d=businessErrorDetail(Object.assign(new Error(message),{code}));assert.equal(d.message,message.slice(0,600));assert.ok(Buffer.byteLength(JSON.stringify(d))<=MAX_BYTES);const unknown=businessErrorDetail(Object.assign(new Error('untrusted near-prefix detail'),{code:code+'_OTHER'}));assert.equal(unknown.message,'Business work could not finish. Saved progress is retained.');}});
