'use strict';
const {hash,canonical}=require('./business-calendar');
const {PLAN,ATTEMPT,OBSERVATION,OUTCOME,PROVENANCE,assertUiPlan,uiPeriodGuardRequest,assertUiReadback,assertUiUnchanged,fail,equal}=require('./business-ui-link-contract');
const {REVERSE_PLAN,NO_EFFECT}=require('./business-link-repair-contract');
const {createBusinessLinkRepair,loadRepairPlan,assertSavedRepairReceipt,assertNoEffectOutcome,dispatchKeyFor,stateSignature,assertReportSources,assertRepairGraph}=require('./business-link-repair');
const read=(Model,filter,session)=>Model.findOne(filter).session(session).maxTimeMS(3000).lean();
const plain=v=>JSON.parse(JSON.stringify(v)),HASH=/^[a-f0-9]{64}$/;
const GESTURE='business-ui-link-correction-gesture',RECOVERY='business-ui-link-draft-recovery',EXTENSION='business-ui-link-read-extension',MAX_EVENTS=20;
const NAMES=['add-exact-estimate','copy-whole-estimate','remove-original-duplicate-line','save-existing-invoice'];
const planId=(scope,logicalKey)=>hash({scope,kind:PLAN,logicalKey}).slice(0,24);
function auditState(payload,contentHash){return{kind:payload.kind,authorityHash:contentHash,operationId:payload.operationId,logicalKey:payload.logicalKey,actorProvenance:PROVENANCE};}
// This runtime has no QBO POST adapter. Browser gestures are independently journaled,
// never represented as SDK responses. Every partial/unknown result keeps the lock.
function assertRecoverySources(t,p,pending,now){
 const sources=t.sources,original=sources?.originalUi,interrupted=sources?.interruption,closed=sources?.closure,next=sources?.newTarget;
 if(!sources||!original||!interrupted||!closed||!next||hash(interrupted)!==t.interruptionArtifactHash||hash(closed)!==t.closedTargetArtifactHash||hash(next)!==t.newTargetArtifactHash||original.uiEvidence?.artifactHash!==pending.uiEvidence.artifactHash||hash(original.nativeObservation)!==original.uiEvidence.artifactHash||!equal(original.uiEvidence,pending.uiEvidence)||interrupted.authorityHash!==t.authorityHash||interrupted.actionId!==t.actionId||interrupted.targetTab!==t.oldTargetId||interrupted.url!=='https://qbo.intuit.com/app/invoice?txnId='+p.before.invoice.record.Id||interrupted.attemptedGesture!==pending.name||interrupted.outcome!=='input-dispatch-timeout-uncertain'||!equal(interrupted.scope,p.scope)||closed.targetTab!==t.oldTargetId||closed.authorityHash!==t.authorityHash||!equal(closed.scope,p.scope)||closed.nativeAction!=='qboTab.close()'||closed.returnedSuccessfully!==true||closed.closedTargetAbsent!==true||closed.saveAttempted!==false||closed.observedAt!==t.closedAt||!Array.isArray(closed.followingBrowserTabs)||closed.followingBrowserTabs.some(tab=>!tab||typeof tab.id!=='string'||tab.id===t.oldTargetId))fail('Actual interruption and closed-target source artifacts do not reproduce the exact pending gesture');
 if(next.targetTab!==t.newTargetId||next.companyId!==p.scope.realmId||next.invoiceId!==p.before.invoice.record.Id||next.estimateId!==p.before.estimate.record.Id||next.url!=='https://qbo.intuit.com/app/invoice?txnId='+p.before.invoice.record.Id||next.actorProvenance!==PROVENANCE||next.savedRecordUnchanged!==true||!Number.isFinite(Date.parse(next.observedAt))||new Date(Date.parse(next.observedAt)).toISOString()!==next.observedAt||Date.parse(next.observedAt)<Date.parse(t.closedAt)||Date.parse(next.observedAt)>now||now-Date.parse(next.observedAt)>300000)fail('Exact post-closure new browser target company/source controls are required');
}
async function readUiAuthority(models,scope,contentHash,session,kind){
 const {Authorities,Audits}=models;
  const row=await read(Authorities,{...scope,contentHash},session),p=row?.payload;
  if(!row||row.contractVersion!==1||hash(p)!==contentHash||!equal(p.scope,scope)||String(row.actorId)!==p.ownerId||(kind&&p.kind!==kind)||p.actorProvenance!==PROVENANCE)fail('Exact append-only agent browser evidence unavailable');
  const a=await read(Audits,{_id:row.auditId},session);
  if(!a||String(a.userId)!==p.ownerId||a.realmId!==scope.realmId||a.action!=='Agent browser company correction evidence recorded'||a.actionType!=='ai_executed'||a.aiDriven!==true||a.tool!=='browser'||a.outcome!==(p.kind===OUTCOME?'success':'partial')||!equal(a.afterState,auditState(p,contentHash)))fail('Exact browser provenance audit unavailable');
  return{row,p};
 }

function createBusinessUiLinkCorrection({models,transaction,assertReady,access,assertBusinessAuthority,loadTaxPolicy,now=()=>Date.now()}){
 const {Authorities,Audits,Runs,Calendars,Writers,Receipts,Policies,Users,Connections}=models||{};
 if([Authorities,Audits,Runs,Calendars,Writers,Receipts,Policies,Users,Connections].some(v=>!v))throw TypeError('Native browser correction storage required');
 const native=createBusinessLinkRepair({models,transaction,assertReady,access,assertBusinessAuthority,loadTaxPolicy,now});
 async function retain(payload,session,id){
  if(Buffer.byteLength(canonical(payload))>8000000)fail('Browser evidence capacity exceeded');
  const contentHash=hash(payload),auditId=hash({contentHash,event:'agent-browser-evidence'}).slice(0,24);
  await Authorities.create([{_id:id||hash({scope:payload.scope,contentHash}).slice(0,24),contractVersion:1,...payload.scope,contentHash,payload,actorId:payload.ownerId,auditId}],{session});
  await Audits.create([{_id:auditId,userId:payload.ownerId,realmId:payload.scope.realmId,action:'Agent browser company correction evidence recorded',actionType:'ai_executed',aiDriven:true,tool:'browser',outcome:payload.kind===OUTCOME?'success':'partial',afterState:auditState(payload,contentHash)}],{session});
  return{contentHash,auditId};
 }
 const retained=(scope,contentHash,session,kind)=>readUiAuthority(models,scope,contentHash,session,kind);
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
  if(u.kind!=='business-ui-link-correction'||u.operationId!==p.operationId||u.logicalKey!==p.logicalKey||!Number.isSafeInteger(u.eventOrdinal)||u.eventOrdinal<0||u.eventOrdinal>MAX_EVENTS)fail('Exact held browser barrier unavailable');
  const {p:attempt}=await retained(scope,u.actionId,session,ATTEMPT);
  if(attempt.authorityHash!==authorityHash||attempt.admittedAt!==u.admittedAt||attempt.operationId!==p.operationId||!equal(attempt.allocation,p.allocation))fail('Browser attempt identity changed');
  const expected=structuredClone(p.state);expected.run.writerRevision++;expected.run.evidenceRevision++;expected.calendar.writerRevision++;expected.writer.revision+=1+u.eventOrdinal;
  if(!equal(stateSignature(s.run,s.calendar,s.writer),expected))fail('Original run/calendar/writer changed under browser action');
  const events=[];let next=u.lastEventHash;
  for(let ordinal=u.eventOrdinal;ordinal>0;ordinal--){const {p:event}=await retained(scope,next,session);if(![GESTURE,OBSERVATION,RECOVERY].includes(event.kind)||event.authorityHash!==authorityHash||event.actionId!==u.actionId||event.ordinal!==ordinal||event.operationId!==p.operationId||event.logicalKey!==p.logicalKey)fail('Browser event chain changed');events.unshift(event);next=event.previousEventHash;}
  if(next!==u.actionId)fail('Browser event chain does not reach original admission');
  const recoveries=events.filter(e=>e.kind===RECOVERY);if(recoveries.length>1)fail('Only one closed-target draft recovery is allowed');
  const recovery=recoveries[0]||null;
  if(recovery){const {p:extension}=await retained(scope,recovery.extensionHash,session,EXTENSION);if(u.draftId!==hash(recovery)||u.browserTargetId!==recovery.newTargetId||extension.authorityHash!==authorityHash||extension.actionId!==u.actionId||extension.oldMaxSdkGets!==p.allocation.maxSdkGets||extension.additionalSdkGets!==50||extension.newMaxSdkGets!==p.allocation.maxSdkGets+50||extension.aggregateMaxSdkGets!==p.allocation.previousCompanyRepairSdkGets+extension.newMaxSdkGets||!HASH.test(extension.ledgerHash||'')||!Number.isSafeInteger(extension.sdkGetsConsumed)||extension.sdkGetsConsumed<0||extension.sdkGetsConsumed>extension.oldMaxSdkGets)fail('Exact additive draft recovery read extension unavailable');}
  else if(u.draftId!==undefined||u.browserTargetId!==undefined)fail('Unexpected draft recovery pointer');
  return{p,...s,attempt,events,recovery,draftId:recovery?hash(recovery):s.writer.unresolved.actionId};
 }
 async function append(s,event,session){
  if(s.writer.unresolved.eventOrdinal>=MAX_EVENTS)fail('Browser journal capacity reached; retain the existing held pointer for read-only inspection/settlement');
  const u=s.writer.unresolved,p=s.p,payload={...event,version:1,scope:p.scope,ownerId:p.ownerId,operationId:p.operationId,logicalKey:p.logicalKey,actorProvenance:PROVENANCE,authorityHash:u.authorityHash,actionId:u.actionId,ordinal:u.eventOrdinal+1,previousEventHash:u.lastEventHash,recordedAt:new Date(now()).toISOString()};
  const retainedEvent=await retain(payload,session),unresolved={...plain(u),eventOrdinal:payload.ordinal,lastEventHash:retainedEvent.contentHash,...(event.kind===RECOVERY?{draftId:retainedEvent.contentHash,browserTargetId:event.newTargetId}:{} )};
  const writer=await Writers.findOneAndUpdate({_id:s.writer._id,...p.scope,revision:s.writer.revision,'unresolved.actionId':u.actionId,'unresolved.lastEventHash':u.lastEventHash},{$inc:{revision:1},$set:{unresolved}},{new:true,session}).lean();
  if(!writer)fail('Held browser pointer changed before journal retention');
  return{status:'browser-action-held',authorityHash:u.authorityHash,actionId:u.actionId,eventHash:retainedEvent.contentHash,writerRevision:writer.revision,event:payload};
 }
 function artifact(value,p){if(!value||value.version!==1||value.companyId!==p.scope.realmId||value.invoiceId!==p.before.invoice.record.Id||value.estimateId!==p.before.estimate.record.Id||value.actorProvenance!==PROVENANCE||!HASH.test(value.artifactHash||'')||!Number.isFinite(Date.parse(value.observedAt))||Date.parse(value.observedAt)>now()||now()-Date.parse(value.observedAt)>300000)fail('Fresh exact native browser target artifact required');}
 async function gesture({scope,authorityHash,name,phase,uiEvidence,periodEvidence}){
  if(!NAMES.includes(name)||!['started','completed'].includes(phase))fail('Exact named browser gesture required');
  return transaction(async session=>{const s=await held(scope,authorityHash,session);artifact(uiEvidence,s.p);
   if(phase==='started'&&now()-Date.parse(s.attempt.admittedAt)>s.p.allocation.maxDurationMs)fail('Browser action window expired; inspect without another gesture');
   if(s.recovery&&uiEvidence.browserTargetId!==s.recovery.newTargetId)fail('Fresh draft gesture targets a different browser tab');
   const gestures=s.events.filter(e=>e.kind===GESTURE&&(e.draftId||s.writer.unresolved.actionId)===s.draftId),started=gestures.find(e=>e.name===name&&e.phase==='started'),done=gestures.find(e=>e.name===name&&e.phase==='completed');
   if(done||(phase==='started'&&started)||(phase==='completed'&&!started))fail('A browser gesture cannot be repeated or completed without retained admission');
   if(phase==='completed'&&Date.parse(uiEvidence.observedAt)<Date.parse(started.recordedAt))fail('Completion artifact predates its admitted gesture');
   if(phase==='started'){
    const needed={'add-exact-estimate':11,'copy-whole-estimate':9,'remove-original-duplicate-line':6,'save-existing-invoice':3}[name];if(MAX_EVENTS-s.writer.unresolved.eventOrdinal<needed)fail('Browser journal lacks room for the remaining required observations and terminal Save');
    if(s.events.some(e=>e.kind===GESTURE&&e.name==='save-existing-invoice'))fail('Save is terminal; only native observation and settlement remain');
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
   return append(s,{kind:GESTURE,draftId:s.draftId,name,phase,uiEvidence},session);
  });
 }
 async function observe({scope,authorityHash,after}){
  return transaction(async session=>{const s=await held(scope,authorityHash,session),last=s.events.at(-1),boundary=last?.recordedAt||s.attempt.admittedAt;
   const current=s.events.filter(e=>(e.draftId||s.writer.unresolved.actionId)===s.draftId);const pendingGestures=current.filter(e=>e.kind===GESTURE&&e.phase==='started'&&!current.some(x=>x.kind===GESTURE&&x.name===e.name&&x.phase==='completed')).map(e=>e.name);
   let classification='partial',invariants=null;try{invariants=assertUiUnchanged(s.p,after,now(),boundary);classification='unchanged';}catch{try{invariants=assertUiReadback(s.p,after,now(),boundary);classification='converted-records';}catch{for(const k of ['invoice','estimate','time','customer'])require('./business-link-repair-contract').observation(after[k],scope,s.p.before[k].entity,s.p.before[k].record.Id,now());if(Object.values(after).some(o=>Date.parse(o.observedAt)<Date.parse(boundary)))fail('Partial observation predates browser action boundary');}}
   // Every classification stays quarantined until separate reports/graph settlement.
   return append(s,{kind:OBSERVATION,draftId:s.draftId,classification,pendingGestures,after,invariants,notBefore:boundary},session);
  });
 }
 async function recoverDraft({scope,authorityHash,after,termination,extension}){
  return transaction(async session=>{const s=await held(scope,authorityHash,session),u=s.writer.unresolved;
   if(s.recovery||MAX_EVENTS-u.eventOrdinal<12||s.events.some(e=>e.kind===GESTURE&&e.name==='save-existing-invoice')||now()-Date.parse(s.attempt.admittedAt)>s.p.allocation.maxDurationMs)fail('No saved, repeated or expired draft recovery is allowed');
   const gestures=s.events.filter(e=>e.kind===GESTURE),pending=gestures.filter(e=>e.phase==='started'&&!gestures.some(x=>x.name===e.name&&x.phase==='completed'));
   if(pending.length!==1||pending[0].name!=='remove-original-duplicate-line'||!gestures.some(e=>e.name==='copy-whole-estimate'&&e.phase==='completed'))fail('Only the exact interrupted unsaved original-line removal can recover');
   const t=termination,closed=Date.parse(t?.closedAt);
   if(!t||t.version!==1||!equal(t.scope,scope)||t.authorityHash!==authorityHash||t.actionId!==u.actionId||t.interruptedGestureHash!==hash(pending[0])||t.interruption!=='input-dispatch-timeout-uncertain'||!/^\d{1,20}$/.test(t.oldTargetId||'')||!/^\d{1,20}$/.test(t.newTargetId||'')||t.oldTargetId===t.newTargetId||t.closeReturnedSuccessfully!==true||t.oldTargetAbsent!==true||t.noSaveAttempted!==true||!HASH.test(t.interruptionArtifactHash||'')||!HASH.test(t.closedTargetArtifactHash||'')||!HASH.test(t.newTargetArtifactHash||'')||!Number.isFinite(closed)||closed<Date.parse(pending[0].recordedAt)||closed>now())fail('Actual closed old target and distinct new target evidence required');
   assertRecoverySources(t,s.p,pending[0],now());
   const invariants=assertUiUnchanged(s.p,after,now(),t.closedAt);await workspace(s.p,session);await native.assertCreations(s.p,session);
   if(!extension||extension.version!==1||extension.oldMaxSdkGets!==s.p.allocation.maxSdkGets||extension.additionalSdkGets!==50||extension.newMaxSdkGets!==s.p.allocation.maxSdkGets+50||extension.aggregateMaxSdkGets!==s.p.allocation.previousCompanyRepairSdkGets+extension.newMaxSdkGets||!HASH.test(extension.ledgerHash||'')||!Number.isSafeInteger(extension.sdkGetsConsumed)||extension.sdkGetsConsumed<0||extension.sdkGetsConsumed>extension.oldMaxSdkGets)fail('Exact additive recovery allowance required');
   const grant=await retain({...extension,version:1,kind:EXTENSION,scope,ownerId:s.p.ownerId,operationId:s.p.operationId,logicalKey:s.p.logicalKey,actorProvenance:PROVENANCE,authorityHash,actionId:u.actionId,recordedAt:new Date(now()).toISOString()},session,hash({scope,authorityHash,kind:EXTENSION}).slice(0,24));
   return append(s,{kind:RECOVERY,newTargetId:t.newTargetId,oldTargetId:t.oldTargetId,termination:t,extensionHash:grant.contentHash,after,invariants,abandonedGestureHash:hash(pending[0]),historicalGestureCompleted:false},session);
  });
 }
 async function graphSnapshot({scope,intent,session,authorityHash}){
  const s=await held(scope,authorityHash,session);if(intent.operationId!==s.p.operationId||intent.planHash!==s.p.planHash)fail('Browser graph cannot change original operation');
  const bundle=await require('./business-ui-link-lineage').uiJournal({models,scope,authorityHash,pointer:plain(s.writer.unresolved),session});
  assertUiReadback(s.p,bundle.observation.after,now(),bundle.observation.notBefore);
  return require('./business-ui-link-lineage').uiFence(bundle,plain(s.writer.unresolved),s.writer.revision);
 }
 async function finalize({scope,authorityHash,after,reports,parentLedgers=[],graph}){
  const prepared=await transaction(async session=>{const s=await held(scope,authorityHash,session);return{p:s.p,rows:await native.assertCreations(s.p,session)};});
  const policyHashes={};for(const key of [prepared.p.logicalKey,...prepared.p.originalStep.compilation.relationships.map(x=>x.logicalKey)]){const row=prepared.rows.find(x=>x.logicalKey===key);policyHashes[key]=hash(await loadTaxPolicy(scope,row.compilation));}
  return transaction(async session=>{
   const s=await held(scope,authorityHash,session),p=s.p,bundle=await require('./business-ui-link-lineage').uiJournal({models,scope,authorityHash,pointer:plain(s.writer.unresolved),session});
   if(!equal(after,bundle.observation.after))fail('Final browser proof differs from retained post-Save native observations');
   require('./business-ui-link-contract').assertUiFinancialTiming(reports,parentLedgers,bundle.observation.recordedAt);
   const invariants=assertUiReadback(p,after,now(),bundle.observation.notBefore),financial=assertReportSources(p,p.reports,reports,now(),false,parentLedgers),rows=await native.assertCreations(p,session),writerFence=await graphSnapshot({scope,intent:{operationId:p.operationId,planHash:p.planHash},session,authorityHash});
   const graphSteps=assertRepairGraph(p,after,graph,writerFence,rows,now(),policyHashes),graphSourceJson=JSON.stringify(graph),graphSourceHash=hash(graphSourceJson);
   if(await read(Authorities,{...scope,'payload.kind':OUTCOME,'payload.planAuthorityHash':authorityHash},session))fail('The UI conversion already has its one retained final outcome');
   const payload={version:1,kind:OUTCOME,scope,ownerId:p.ownerId,operationId:p.operationId,logicalKey:p.logicalKey,actorProvenance:PROVENANCE,planAuthorityHash:authorityHash,actionId:bundle.actionId,observationHash:bundle.actionEvidenceHash,compilationHash:p.originalStep.compilation.compilationHash,creationReceiptHash:p.originalStep.receipt.evidenceHash,qboId:p.originalStep.qboId,verifiedAt:new Date(now()).toISOString(),invariants,after,reports,parentLedgers,financial,writerFence,graphSteps,policyHashes,graph:{version:graph.version,evidenceHash:graph.evidenceHash,complete:graph.complete,recordCount:graph.recordCount,writerFence},graphSourceJson,graphSourceHash};
   const retainedOutcome=await retain(payload,session,hash({scope,kind:OUTCOME,planAuthorityHash:authorityHash}).slice(0,24));
   const released=await Writers.findOneAndUpdate({_id:s.writer._id,...scope,revision:s.writer.revision,operationId:p.operationId,planHash:p.planHash,'unresolved.actionId':bundle.actionId,'unresolved.lastEventHash':bundle.actionEvidenceHash},{$inc:{revision:1},$set:{unresolved:null}},{new:true,session}).lean();
   if(!released)fail('Exact known-observed browser pointer changed before final settlement');
   return{status:'verified',authorityHash:retainedOutcome.contentHash,planAuthorityHash:authorityHash,actionId:bundle.actionId,observationHash:bundle.actionEvidenceHash,financial,graphEvidenceHash:graph.evidenceHash,originalOperationPreserved:true};
  });
 }
 return{admission,gesture,observe,held,recoverDraft,graphSnapshot,finalize};
}
module.exports={createBusinessUiLinkCorrection,PLAN,ATTEMPT,OBSERVATION,GESTURE,RECOVERY,EXTENSION,MAX_EVENTS,PROVENANCE,planId,readUiAuthority,assertRecoverySources};
