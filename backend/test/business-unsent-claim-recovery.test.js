'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../src/modules/business-calendar');
const {readApprovalReports}=require('../src/modules/business-approval-report-evidence');
const {createBusinessUnknownRecovery}=require('../src/modules/business-unknown-recovery');
const {createBusinessStepStore}=require('../src/modules/business-step-store');
const {createBusinessDispatcher}=require('../src/modules/business-dispatch');
const {QBOClient}=require('../src/modules/qbo-client');
const {fixture}=require('./helpers/business-governance-fixture');
const clone=value=>structuredClone(value);
function data(){
 if(process.env.JOB_Y_REPLAY)return require(process.env.JOB_Y_REPLAY);
 const scope={realmId:'123',environment:'sandbox',connectionId:'a'.repeat(24)},ownerId='b'.repeat(24),operationId='c'.repeat(24),logicalKey=hash('estimate');
 const agentAuthority={version:1,agentId:'d'.repeat(24),grantId:hash('grant'),authorityHash:hash('authority'),ownerId};
 const manifest={activityBatch:{day:'2026-10-31'},records:[{step:{entity:'Estimate'}}]},planHash=hash(manifest),approvedAt='2026-10-31T23:41:43.540Z';
 const sources={version:3,scope,period:{fromDate:'2026-10-31',throughDate:'2026-10-31'},startedAt:'2026-10-31T23:41:42.828Z',observedAt:'2026-10-31T23:41:42.840Z',accounts:[],reports:{}};
 const payload={version:2,requiredReports:[],kind:'business-approval-reports',scope,operationId,planHash,actorId:ownerId,ownerId,period:sources.period,sourceHash:hash(sources),sources};
 const pointer={version:1,sourceVersion:3,evidenceHash:hash(payload),sourceHash:payload.sourceHash,observedAt:sources.observedAt};
 const audit={_id:'e'.repeat(24),userId:ownerId,realmId:scope.realmId,action:'Business operation evidence recorded',actionType:'ai_plan',outcome:'success',inputParams:{eventKey:'business-plan:'+operationId+':approved',...scope,details:{...scope,operationId,planHash,actorId:ownerId,phase:'approved',decisionSource:'agent-standing-authority',reportEvidenceHash:pointer.evidenceHash,reportSourceHash:pointer.sourceHash}}};
 const operation={_id:operationId,contractVersion:1,...scope,createdBy:ownerId,authorityHash:agentAuthority.authorityHash,agentAuthority,planId:'f'.repeat(24),planHash,blueprintHash:hash('blueprint'),baselineHash:hash('baseline'),expectedRecordSetHash:hash('records'),expectedRevision:1,recordCount:1,expectedCursor:null,fromDate:'2026-10-31',throughDate:'2026-10-31',requiredAssertions:[{key:'records',evidenceType:'record-readback',currency:'CAD'}],status:'blocked',leaseToken:null,leaseExpiresAt:null,executionRequest:{pending:false,requestedAt:'2026-10-31T23:43:28.676Z'},approval:{actorId:ownerId,planHash,agentAuthority,decisionSource:'agent-standing-authority',fenceHash:hash('fence'),auditId:audit._id,approvedAt,reportEvidence:pointer}};
 const candidate={_id:'1'.repeat(24),contractVersion:1,...scope,candidateHash:pointer.evidenceHash,payload,actorId:ownerId,auditId:'2'.repeat(24)};
 const observation={_id:candidate.auditId,userId:ownerId,realmId:scope.realmId,action:'Business approval report observation retained',actionType:'manual',outcome:'success',afterState:{...scope,operationId,planHash,reportEvidenceHash:pointer.evidenceHash,reportSourceHash:pointer.sourceHash,observedAt:pointer.observedAt,reports:0}};
 const step={_id:'3'.repeat(24),contractVersion:1,...scope,operationId,planHash,logicalKey,entity:'Estimate',fingerprint:hash('intent'),dependencies:[],state:'claimed',revision:1,attempts:1,leaseToken:'original-worker-token',leaseExpiresAt:'2026-10-31T23:46:47.274Z',dispatch:null,compilation:null,receipt:null,verification:null,rejection:null};
 delete payload.sources.reports;
 return {operation,step,candidate,audit,observation,plan:{_id:operation.planId,...scope,planHash,manifest},writer:{...scope,operationId,planHash,unresolved:null},intent:null};
}
function harness(input=data()){
 const d=clone(input),scope=Object.fromEntries(['realmId','environment','connectionId'].map(k=>[k,String(d.operation[k])])),h=fixture({scope,ownerId:String(d.operation.createdBy)});
 h.clock=Date.parse('2026-10-31T23:47:47.274Z');
 Object.assign(h.data,{Runs:[d.operation],Steps:[d.step],Writers:[d.writer],Audits:[d.audit,d.observation],Candidates:[d.candidate],Plans:[d.plan],Authorities:[],Receipts:[]});
 const bound={scope,ownerId:String(d.operation.createdBy)};
 const recovery=createBusinessUnknownRecovery({models:h.models,now:()=>h.clock,bind:async()=>bound});
 const reports=()=>readApprovalReports({models:h.models,run:d.operation,ownerId:bound.ownerId});
 const pending=()=>recovery.automaticRecoveryPending({},String(d.operation._id),{planHash:d.operation.planHash});
 const loadIntent=async()=>({version:1,kind:'create',scope,operationId:String(d.operation._id),logicalKey:d.step.logicalKey,planHash:d.operation.planHash,fingerprint:d.step.fingerprint,entity:d.step.entity,dependencies:d.step.dependencies,...(d.intent?{step:d.intent.step,policy:d.intent.policy}:{})});
 const store=createBusinessStepStore({Steps:h.models.Steps,loadIntent,authorize:async()=>({actorId:bound.ownerId}),assertReady:async()=>{},transaction:h.transaction,now:()=>h.clock,loadRecovery:async()=>{throw Error('No transport recovery expected');},loadReadback:async()=>{throw Error('No readback expected');},fence:async input=>{assert.equal(d.writer.unresolved,null);return {scope,operationId:String(d.operation._id),planHash:d.operation.planHash,phase:input.phase,fenceHash:hash('fence')};},writeAudit:async(eventKey,details,session)=>{await h.models.Audits.create([{_id:hash(eventKey).slice(0,24),eventKey,details}],{session});return {eventKey,id:hash(eventKey).slice(0,24)};}});
 return {d,h,scope,reports,pending,store,loadIntent};
}
test('minimized non-posting approval is verified without changing stored data; tampered evidence still fails',async()=>{
 const k=harness(),before=clone(k.h.data);assert.equal((await k.reports()).reports,0);assert.deepEqual(k.h.data,before);
 for(const mutate of [d=>d.candidate.payload.sources.accounts.push({id:'bad'}),d=>d.candidate.payload.requiredReports.push('TrialBalance'),d=>d.candidate.payload.sources.reports={unexpected:{}},d=>d.audit.inputParams.details.reportSourceHash=hash('wrong'),d=>d.observation.afterState.reports=1,d=>d.operation.approval.reportEvidence.sourceHash=hash('wrong')]){const k=harness();mutate(k.d);assert.deepEqual(await k.reports(),{status:'unavailable',authorization:false,code:'BUSINESS_APPROVAL_REPORT_UNVERIFIED'});}
});
test('new candidates preserve empty reports through the actual Mongoose serializer',()=>{
 const Candidate=require('../src/models/BusinessCandidate'),d=data();d.candidate.payload.sources.reports={};const doc=new Candidate(d.candidate);const saved=doc.toObject();assert.deepEqual(saved.payload.sources.reports,{});assert.equal(hash(saved.payload),d.candidate.candidateHash);
});
test('expired unsent claim is detected with a stable identity, reclaimed once and its old worker fenced',async()=>{
 const live=harness();live.h.clock=Date.parse('2026-10-31T23:43:31Z');assert.equal((await live.pending()).pending,false);await assert.rejects(live.store.claim(live.scope,String(live.d.operation._id),live.d.step.logicalKey,300000),/busy/);
 const k=harness(),a=await k.pending();assert.equal(a.pending,true);assert.equal((await k.pending()).at,a.at);
 k.d.operation.executionRequest.requestKey=hash({operationId:String(k.d.operation._id),phase:'auto-recovery-continue',at:a.at});assert.equal((await k.pending()).pending,false);
 delete k.d.operation.executionRequest.requestKey;const previous=k.d.step.leaseToken;
 const fresh=await k.store.claim(k.scope,String(k.d.operation._id),k.d.step.logicalKey,300000);assert.notEqual(fresh.leaseToken,previous);assert.equal(k.h.data.Steps[0].attempts,2);
 await assert.rejects(k.store.releaseClaim(k.scope,String(k.d.operation._id),k.d.step.logicalKey,{leaseToken:previous,revision:1}),/no longer owns/);
 assert.equal((await k.pending()).pending,false);
});
test('live claims, sent or saved evidence, uncertain writers and exhausted attempts never auto-reclaim',async()=>{
 const mutations=[k=>k.d.step.leaseExpiresAt=new Date(k.h.clock+1),k=>k.d.step.leaseExpiresAt='invalid',k=>k.d.step.dispatch={key:hash('sent')},k=>k.d.step.compilation={},k=>k.d.step.receipt={},k=>k.d.step.qboId='9',k=>k.d.step.verification={},k=>k.d.step.rejection={},k=>k.d.step.attempts=20,k=>k.d.step.state='unknown',k=>k.d.writer.unresolved={key:hash('unknown')},k=>{k.d.operation.leaseToken='live-run';k.d.operation.leaseExpiresAt=new Date(k.h.clock+1);},k=>k.d.operation.executionRequest.pending=true,k=>k.d.writer.populationDelegation={jobId:'bulk'}];
 for(const mutate of mutations){const k=harness();mutate(k);assert.equal((await k.pending()).pending,false);}
 for(const field of ['dispatch','compilation','receipt','qboId','verification','rejection']){const k=harness();k.d.step[field]=field==='qboId'?'9':{};await assert.rejects(k.store.claim(k.scope,String(k.d.operation._id),k.d.step.logicalKey,300000),/busy/);}
});
if(process.env.JOB_Y_REPLAY)test('exact stored Estimate follows live dispatcher through reclaimed claim to compilation without transport',async()=>{
 const k=harness();await k.reports();assert.equal((await k.pending()).pending,true);
 const client=Object.assign(Object.create(QBOClient.prototype),{realmId:k.scope.realmId,connection:{_id:k.scope.connectionId,realmId:k.scope.realmId,status:'active',userId:String(k.d.operation.createdBy)}});
 Object.defineProperty(client,'apiBase',{value:'https://quickbooks.api.intuit.com/v3/company/'+k.scope.realmId});
 let reached=false;
 const dispatch=createBusinessDispatcher({steps:k.store,loadIntent:k.loadIntent,loadCompilationEvidence:async()=>{reached=true;throw Error('OFFLINE_REPLAY_BEFORE_TRANSPORT');},resolveClient:async()=>client,authorize:async()=>({actorId:String(k.d.operation.createdBy)}),assertReady:async()=>{},now:()=>k.h.clock});
 await assert.rejects(dispatch(k.scope,String(k.d.operation._id),k.d.step.logicalKey),/OFFLINE_REPLAY_BEFORE_TRANSPORT/);assert.equal(reached,true);assert.equal(k.h.data.Steps[0].attempts,2);assert.equal(k.h.posts,0);
});
test('a slice review explicitly moves past failed recovery to independent work',()=>{
 const prompt=require('../src/modules/business-agent-engine').systemPrompt('accountant');assert.match(prompt,/independent work first/);assert.match(prompt,/at most once in a review/);assert.match(prompt,/SAME review/);
});

test('exact blocked recovery state schedules independent activity despite eight failed reviews',()=>{
 const d=data(),c=require('../src/modules/business-agent-cadence'),now=Date.parse('2026-10-31T23:47:47.274Z');
 const operationId=String(d.operation._id),current={operationId,status:'blocked',agentAuthority:d.operation.agentAuthority};
 const decision=c.decide({now,agent:{id:d.operation.agentAuthority.agentId,ownerId:d.operation.agentAuthority.ownerId,grant:{id:d.operation.agentAuthority.grantId,authorityHash:d.operation.agentAuthority.authorityHash}},business:{verifiedThrough:'2026-10-30',currentOperation:current,blockers:[{code:'current-operation'}]},today:{day:'2026-10-31',saved:85,target:220,behind:122,inFlight:1,open:[current],dueSlot:{records:60}},owned:[current],state:{day:'2026-10-31',lastKind:'recovery',misses:8,lastReviewAt:new Date(now-60000).toISOString()}});
 assert.equal(decision.kind,'slice');assert.equal(decision.callModel,true);assert.match(decision.reason,/independent work/);
});
