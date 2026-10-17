'use strict';
const {hash,canonical}=require('./business-calendar');
const {PLAN,ATTEMPT,OBSERVATION,PROVENANCE,assertUiPlan,uiPeriodGuardRequest,assertUiReadback,assertUiUnchanged,fail,equal}=require('./business-ui-link-contract');
const {REVERSE_PLAN,NO_EFFECT}=require('./business-link-repair-contract');
const {createBusinessLinkRepair,loadRepairPlan,assertSavedRepairReceipt,assertNoEffectOutcome,dispatchKeyFor,stateSignature,assertReportSources}=require('./business-link-repair');
const read=(Model,filter,session)=>Model.findOne(filter).session(session).maxTimeMS(3000).lean();
const plain=v=>JSON.parse(JSON.stringify(v)),HASH=/^[a-f0-9]{64}$/;
const GESTURE='business-ui-link-correction-gesture';
const NAMES=['add-exact-estimate','copy-whole-estimate','remove-original-duplicate-line','save-existing-invoice'];
const planId=(scope,logicalKey)=>hash({scope,kind:PLAN,logicalKey}).slice(0,24);
function auditState(payload,contentHash){return{kind:payload.kind,authorityHash:contentHash,operationId:payload.operationId,logicalKey:payload.logicalKey,actorProvenance:PROVENANCE};}
// This runtime has no QBO POST adapter. Browser gestures are independently journaled,
// never represented as SDK responses. Every partial/unknown result keeps the lock.
function createBusinessUiLinkCorrection({models,transaction,assertReady,access,assertBusinessAuthority,loadTaxPolicy,now=()=>Date.now()}){
 const {Authorities,Audits,Runs,Calendars,Writers,Receipts,Policies,Users,Connections}=models||{};
 if([Authorities,Audits,Runs,Calendars,Writers,Receipts,Policies,Users,Connections].some(v=>!v))throw TypeError('Native browser correction storage required');
 const native=createBusinessLinkRepair({models,transaction,assertReady,access,assertBusinessAuthority,loadTaxPolicy,now});
 async function retain(payload,session,id){
  if(Buffer.byteLength(canonical(payload))>8000000)fail('Browser evidence capacity exceeded');
  const contentHash=hash(payload),auditId=hash({contentHash,event:'agent-browser-evidence'}).slice(0,24);
  await Authorities.create([{_id:id||hash({scope:payload.scope,contentHash}).slice(0,24),contractVersion:1,...payload.scope,contentHash,payload,actorId:payload.ownerId,auditId}],{session});
  await Audits.create([{_id:auditId,userId:payload.ownerId,realmId:payload.scope.realmId,action:'Agent browser company correction evidence recorded',actionType:'ai_executed',aiDriven:true,tool:'browser',outcome:'partial',afterState:auditState(payload,contentHash)}],{session});
  return{contentHash,auditId};
 }
 async function retained(scope,contentHash,session,kind){
  const row=await read(Authorities,{...scope,contentHash},session),p=row?.payload;
  if(!row||row.contractVersion!==1||hash(p)!==contentHash||!equal(p.scope,scope)||String(row.actorId)!==p.ownerId||(kind&&p.kind!==kind)||p.actorProvenance!==PROVENANCE)fail('Exact append-only agent browser evidence unavailable');
  const a=await read(Audits,{_id:row.auditId},session);
  if(!a||String(a.userId)!==p.ownerId||a.realmId!==scope.realmId||a.action!=='Agent browser company correction evidence recorded'||a.actionType!=='ai_executed'||a.aiDriven!==true||a.tool!=='browser'||a.outcome!=='partial'||!equal(a.afterState,auditState(p,contentHash)))fail('Exact browser provenance audit unavailable');
  return{row,p};
 }
 async function prior(p,session){
  const outcome=await read(Authorities,{...p.scope,contentHash:p.priorReverseNoEffectHash,'payload.kind':NO_EFFECT},session);
  if(!outcome)fail('Exact unsuccessful reverse-link source required');
  const prior=await loadRepairPlan({models,scope:p.scope,authorityHash:outcome.payload.planAuthorityHash,session,clock:now()});
  if(prior.p.kind!==REVERSE_PLAN)fail('Both distinct API attempts must already be consumed');
  const receipt=await read(Receipts,{_id:hash({scope:p.scope,dispatchKey:dispatchKeyFor(prior.authority.contentHash)}),...p.scope},session);
  await assertSavedRepairReceipt(models,p.scope,prior.p,prior.authority.contentHash,receipt,session);
  await assertNoEffectOutcome({models,scope:p.scope,p:prior.p,authority:prior.authority,row:receipt,outcome,session});
  if(!['ownerId','operationId','planHash','logicalKey','publishedAuthorityHash'].every(k=>p[k]===prior.p[k])||!equal(p.identities,prior.p.identities)||!equal(p.originalStep,prior.p.originalStep)||!['invoice','estimate','time','customer'].every(k=>equal(p.before[k].record,outcome.payload.after[k].record)))fail('Browser plan expands the original unchanged owned chain');
  const expected=structuredClone(prior.p.state);expected.run.writerRevision++;expected.run.evidenceRevision++;expected.calendar.writerRevision++;expected.writer.revision+=3;
  if(!equal(p.state,expected))fail('Original operation changed after unsuccessful API settlement');
  assertReportSources({...prior.p,reviewedAt:outcome.payload.verifiedAt,parentLedgers:outcome.payload.parentLedgers},outcome.payload.reports,p.reports,Date.parse(p.reviewedAt),false,p.parentLedgers);
 }
 async function workspace(p,session){
  const actor=await access.authorize(p.scope,'operations.execute',{session});if(actor.actorId!==p.ownerId||actor.ownerId!==p.ownerId)fail('Current exact owner workspace required');
  const user=await Users.findOne({_id:p.ownerId}).select('_id role connectionSwitchVersion').session(session).maxTimeMS(3000).lean(),version=user?.connectionSwitchVersion??0;
  if(!user||!Number.isSafeInteger(version)||!['agent','supervisor'].includes(user.role))fail('Workspace fence unavailable');
  if(!await Users.findOneAndUpdate({_id:user._id,role:user.role,connectionSwitchVersion:user.connectionSwitchVersion===undefined?{$exists:false}:version},{$inc:{connectionSwitchVersion:1}},{new:true,session}).select('_id').lean())fail('Workspace changed');
  const selected=await Connections.findOne({userId:p.ownerId,status:'active'}).sort({updatedAt:-1}).select('_id realmId').session(session).maxTimeMS(3000).lean();
  if(String(selected?._id)!==p.scope.connectionId||selected.realmId!==p.scope.realmId)fail('Selected company changed');
 }
 async function periodGuard(p,periodEvidence,session){
   const policy=await read(Policies,{environment:p.scope.environment,realmId:p.scope.realmId},session);
   if(!policy||policy.contractVersion!==1||policy.state!=='active'||String(policy.connectionId)!==p.scope.connectionId||!Number.isSafeInteger(policy.revision))fail('Active exact company write policy required');
   const proof=require('./qbo-write-period').assertWritePeriod(uiPeriodGuardRequest(p),periodEvidence,policy.periodControl,now(),p.ownerId);
   if(proof.evidence.records.length!==3||!['invoice','estimate','time'].every(k=>proof.evidence.records.some(r=>r.entity===p.before[k].entity&&r.id===p.before[k].record.Id&&r.syncToken===p.before[k].record.SyncToken&&r.recordHash===p.before[k].recordHash)))fail('Fresh protected-period records differ from reviewed native chain');
   if(!await Policies.findOneAndUpdate({_id:policy._id,revision:policy.revision,connectionId:p.scope.connectionId,state:'active'},{$inc:{revision:1}},{new:true,session}).lean())fail('Period policy changed before browser admission');
   return proof;
 }
 async function admission(p,periodEvidence){
  assertUiPlan(p,now(),true);assertReportSources(p,p.reports,p.reports,now(),true);
  return transaction(async session=>{
   const s=await native.state(p.scope,p.operationId,session,null,true);await workspace(p,session);
   if(!equal(stateSignature(s.run,s.calendar,s.writer),p.state)||s.run.authorityHash!==p.publishedAuthorityHash||!equal(p.period,{fromDate:s.run.fromDate,throughDate:s.run.throughDate})||p.currentDate!==require('./business-activity-preview').businessDate(new Date(now())))fail('Reviewed browser operation changed');
   const rows=await native.assertCreations(p,session);await prior(p,session);
   // A stronger current restriction than just TxnLineId: no accepted descendant
   // may reference this Invoice at all while its line identity can change.
   if(rows.some(row=>row.logicalKey!==p.logicalKey&&(row.compilation.relationships||[]).some(r=>r.entity==='Invoice'&&r.qboId===p.before.invoice.record.Id)))fail('A saved descendant already depends on this Invoice');
   if(await read(Authorities,{...p.scope,'payload.kind':PLAN,'payload.logicalKey':p.logicalKey},session))fail('This chain already has its one distinct browser correction authority');
   const proof=await periodGuard(p,periodEvidence,session);
   const plan=await retain(p,session,planId(p.scope,p.logicalKey)),authorityHash=plan.contentHash;
   const attempt={version:1,kind:ATTEMPT,scope:p.scope,ownerId:p.ownerId,operationId:p.operationId,logicalKey:p.logicalKey,actorProvenance:PROVENANCE,authorityHash,admittedAt:new Date(now()).toISOString(),periodProof:proof,allocation:p.allocation};
   const action=await retain(attempt,session),actionId=action.contentHash;
   const run=await Runs.findOneAndUpdate({_id:s.run._id,...p.scope,status:'blocked',writerRevision:s.run.writerRevision,evidenceRevision:s.run.evidenceRevision,executionRevision:s.run.executionRevision,leaseToken:null,'executionRequest.pending':false},{$inc:{writerRevision:1,evidenceRevision:1},$set:{verificationCandidateHash:null}},{new:true,session}).lean();
   const calendar=await Calendars.findOneAndUpdate({_id:s.calendar._id,...p.scope,writerRevision:s.calendar.writerRevision,currentOperationId:p.operationId,stopRequested:false,pendingCommit:null},{$inc:{writerRevision:1}},{new:true,session}).lean();
   const unresolved={kind:'business-ui-link-correction',authorityHash,actionId,operationId:p.operationId,logicalKey:p.logicalKey,eventOrdinal:0,lastEventHash:actionId,admittedAt:attempt.admittedAt};
   const writer=await Writers.findOneAndUpdate({_id:s.writer._id,...p.scope,revision:s.writer.revision,operationId:p.operationId,planHash:p.planHash,unresolved:null},{$inc:{revision:1},$set:{unresolved}},{new:true,session}).lean();
   if(!run||!calendar||!writer)fail('Original blocked operation changed during browser admission');
   return{status:'browser-action-held',authorityHash,actionId,writerRevision:writer.revision,admittedAt:attempt.admittedAt};
  });
 }
 async function held(scope,authorityHash,session){
  const {p}=await retained(scope,authorityHash,session,PLAN);assertUiPlan(p,now());
  const s=await native.state(scope,p.operationId,session,authorityHash),u=s.writer.unresolved;
  if(u.kind!=='business-ui-link-correction'||u.operationId!==p.operationId||u.logicalKey!==p.logicalKey||!Number.isSafeInteger(u.eventOrdinal)||u.eventOrdinal<0||u.eventOrdinal>12)fail('Exact held browser barrier unavailable');
  const {p:attempt}=await retained(scope,u.actionId,session,ATTEMPT);
  if(attempt.authorityHash!==authorityHash||attempt.admittedAt!==u.admittedAt||attempt.operationId!==p.operationId||!equal(attempt.allocation,p.allocation))fail('Browser attempt identity changed');
  const expected=structuredClone(p.state);expected.run.writerRevision++;expected.run.evidenceRevision++;expected.calendar.writerRevision++;expected.writer.revision+=1+u.eventOrdinal;
  if(!equal(stateSignature(s.run,s.calendar,s.writer),expected))fail('Original run/calendar/writer changed under browser action');
  const events=[];let next=u.lastEventHash;
  for(let ordinal=u.eventOrdinal;ordinal>0;ordinal--){const {p:event}=await retained(scope,next,session);if(![GESTURE,OBSERVATION].includes(event.kind)||event.authorityHash!==authorityHash||event.actionId!==u.actionId||event.ordinal!==ordinal||event.operationId!==p.operationId||event.logicalKey!==p.logicalKey)fail('Browser event chain changed');events.unshift(event);next=event.previousEventHash;}
  if(next!==u.actionId)fail('Browser event chain does not reach original admission');
  return{p,...s,attempt,events};
 }
 async function append(s,event,session){
  if(s.writer.unresolved.eventOrdinal>=12)fail('Browser journal capacity reached; retain the existing held pointer for read-only inspection/settlement');
  const u=s.writer.unresolved,p=s.p,payload={...event,version:1,scope:p.scope,ownerId:p.ownerId,operationId:p.operationId,logicalKey:p.logicalKey,actorProvenance:PROVENANCE,authorityHash:u.authorityHash,actionId:u.actionId,ordinal:u.eventOrdinal+1,previousEventHash:u.lastEventHash,recordedAt:new Date(now()).toISOString()};
  const retainedEvent=await retain(payload,session),unresolved={...plain(u),eventOrdinal:payload.ordinal,lastEventHash:retainedEvent.contentHash};
  const writer=await Writers.findOneAndUpdate({_id:s.writer._id,...p.scope,revision:s.writer.revision,'unresolved.actionId':u.actionId,'unresolved.lastEventHash':u.lastEventHash},{$inc:{revision:1},$set:{unresolved}},{new:true,session}).lean();
  if(!writer)fail('Held browser pointer changed before journal retention');
  return{status:'browser-action-held',authorityHash:u.authorityHash,actionId:u.actionId,eventHash:retainedEvent.contentHash,writerRevision:writer.revision,event:payload};
 }
 function artifact(value,p){if(!value||value.version!==1||value.companyId!==p.scope.realmId||value.invoiceId!==p.before.invoice.record.Id||value.estimateId!==p.before.estimate.record.Id||value.actorProvenance!==PROVENANCE||!HASH.test(value.artifactHash||'')||!Number.isFinite(Date.parse(value.observedAt))||Date.parse(value.observedAt)>now()||now()-Date.parse(value.observedAt)>300000)fail('Fresh exact native browser target artifact required');}
 async function gesture({scope,authorityHash,name,phase,uiEvidence,periodEvidence}){
  if(!NAMES.includes(name)||!['started','completed'].includes(phase))fail('Exact named browser gesture required');
  return transaction(async session=>{const s=await held(scope,authorityHash,session);artifact(uiEvidence,s.p);
   if(phase==='started'&&now()-Date.parse(s.attempt.admittedAt)>s.p.allocation.maxDurationMs)fail('Browser action window expired; inspect without another gesture');
   const gestures=s.events.filter(e=>e.kind===GESTURE),started=gestures.find(e=>e.name===name&&e.phase==='started'),done=gestures.find(e=>e.name===name&&e.phase==='completed');
   if(done||(phase==='started'&&started)||(phase==='completed'&&!started))fail('A browser gesture cannot be repeated or completed without retained admission');
   if(phase==='completed'&&Date.parse(uiEvidence.observedAt)<Date.parse(started.recordedAt))fail('Completion artifact predates its admitted gesture');
   if(phase==='started'){
    if(gestures.some(e=>e.name==='save-existing-invoice'))fail('Save is terminal; only native observation and settlement remain');
    await workspace(s.p,session);await periodGuard(s.p,periodEvidence,session);
    if(gestures.some(e=>e.phase==='started'&&!gestures.some(x=>x.name===e.name&&x.phase==='completed')))fail('An earlier browser gesture remains unknown');
    const completed=n=>gestures.some(e=>e.name===n&&e.phase==='completed');
    if(name==='add-exact-estimate'&&gestures.length||name==='copy-whole-estimate'&&!completed('add-exact-estimate'))fail('Browser gesture order changed');
    if(['remove-original-duplicate-line','save-existing-invoice'].includes(name)){
     const copy=gestures.find(e=>e.name==='copy-whole-estimate'&&e.phase==='completed'),check=s.events.filter(e=>e.kind===OBSERVATION).at(-1);
     if(!copy||!check||check.classification!=='unchanged'||check.ordinal<=copy.ordinal||now()-Date.parse(check.recordedAt)>300000||gestures.some(e=>e.phase==='completed'&&e.ordinal>check.ordinal))fail('Fresh four-record unchanged proof after Copy required before further editing or Save');
     assertUiUnchanged(s.p,check.after,now(),copy.recordedAt);
     if(name==='save-existing-invoice'&&uiEvidence.exactSingleOriginalEconomics!==true)fail('Visible exact single final financial line required before Save');
    }
   }
   return append(s,{kind:GESTURE,name,phase,uiEvidence},session);
  });
 }
 async function observe({scope,authorityHash,after}){
  return transaction(async session=>{const s=await held(scope,authorityHash,session),last=s.events.at(-1),boundary=last?.recordedAt||s.attempt.admittedAt;
   const pendingGestures=s.events.filter(e=>e.kind===GESTURE&&e.phase==='started'&&!s.events.some(x=>x.kind===GESTURE&&x.name===e.name&&x.phase==='completed')).map(e=>e.name);
   let classification='partial',invariants=null;try{invariants=assertUiUnchanged(s.p,after,now(),boundary);classification='unchanged';}catch{try{invariants=assertUiReadback(s.p,after,now(),boundary);classification='converted-records';}catch{for(const k of ['invoice','estimate','time','customer'])require('./business-link-repair-contract').observation(after[k],scope,s.p.before[k].entity,s.p.before[k].record.Id,now());if(Object.values(after).some(o=>Date.parse(o.observedAt)<Date.parse(boundary)))fail('Partial observation predates browser action boundary');}}
   // Every classification stays quarantined until separate reports/graph settlement.
   return append(s,{kind:OBSERVATION,classification,pendingGestures,after,invariants,notBefore:boundary},session);
  });
 }
 return{admission,gesture,observe,held};
}
module.exports={createBusinessUiLinkCorrection,PLAN,ATTEMPT,OBSERVATION,GESTURE,PROVENANCE,planId};
