'use strict';
const {hash}=require('./business-calendar');
const {PLAN,ATTEMPT,OBSERVATION,OUTCOME,assertUiPlan,assertUiReadback,fail,equal}=require('./business-ui-link-contract');
const {GESTURE,RECOVERY,EXTENSION,MAX_EVENTS,planId,readUiAuthority,assertRecoverySources}=require('./business-ui-link-correction');
const read=(Model,filter,session)=>Model.findOne(filter).session(session).maxTimeMS(3000).lean();
async function uiJournal({models,scope,authorityHash,pointer,session}){
 const {row:authority,p}=await readUiAuthority(models,scope,authorityHash,session,PLAN);assertUiPlan(p,Date.now());
 if(String(authority._id)!==planId(scope,p.logicalKey)||pointer?.kind!=='business-ui-link-correction'||pointer.authorityHash!==authorityHash||pointer.operationId!==p.operationId||pointer.logicalKey!==p.logicalKey||!Number.isSafeInteger(pointer.eventOrdinal)||pointer.eventOrdinal<1||pointer.eventOrdinal>MAX_EVENTS)fail('Exact retained UI journal pointer required');
 const {p:attempt}=await readUiAuthority(models,scope,pointer.actionId,session,ATTEMPT);
 if(attempt.authorityHash!==authorityHash||attempt.operationId!==p.operationId||attempt.logicalKey!==p.logicalKey||attempt.admittedAt!==pointer.admittedAt||!equal(attempt.allocation,p.allocation))fail('UI journal attempt identity changed');
 const events=[];let next=pointer.lastEventHash;
 for(let ordinal=pointer.eventOrdinal;ordinal>0;ordinal--){const {p:event}=await readUiAuthority(models,scope,next,session);if(![GESTURE,OBSERVATION,RECOVERY].includes(event.kind)||event.authorityHash!==authorityHash||event.actionId!==pointer.actionId||event.ordinal!==ordinal||event.operationId!==p.operationId||event.logicalKey!==p.logicalKey)fail('UI journal chain changed');events.unshift(event);next=event.previousEventHash;}
 if(next!==pointer.actionId)fail('UI journal lost its original attempt');
 const recoveries=events.filter(e=>e.kind===RECOVERY);if(recoveries.length>1)fail('Repeated UI draft recovery is forbidden');
 const recovery=recoveries[0];let draftId=pointer.actionId;
 if(recovery){const prior=events.filter(e=>e.ordinal<recovery.ordinal),gestures=prior.filter(e=>e.kind===GESTURE),pending=gestures.filter(e=>e.phase==='started'&&!gestures.some(x=>x.name===e.name&&x.phase==='completed'));
  if(pending.length!==1||pending[0].name!=='remove-original-duplicate-line'||gestures.some(e=>e.name==='save-existing-invoice')||recovery.historicalGestureCompleted!==false||recovery.abandonedGestureHash!==hash(pending[0]))fail('Discarded UI input history changed');
  assertRecoverySources(recovery.termination,p,pending[0],Date.parse(recovery.recordedAt));
  require('./business-ui-link-contract').assertUiUnchanged(p,recovery.after,Date.parse(recovery.recordedAt),recovery.termination.closedAt);
  const {p:extension}=await readUiAuthority(models,scope,recovery.extensionHash,session,EXTENSION);
  if(extension.authorityHash!==authorityHash||extension.actionId!==pointer.actionId||extension.oldMaxSdkGets!==p.allocation.maxSdkGets||extension.additionalSdkGets!==50||extension.newMaxSdkGets!==extension.oldMaxSdkGets+50||extension.aggregateMaxSdkGets!==p.allocation.previousCompanyRepairSdkGets+extension.newMaxSdkGets)fail('UI recovery grant changed');
  draftId=hash(recovery);if(pointer.draftId!==draftId||pointer.browserTargetId!==recovery.newTargetId)fail('Recovered UI target changed');
 }else if(pointer.draftId!==undefined||pointer.browserTargetId!==undefined)fail('Unexpected recovered UI pointer');
 const gestures=events.filter(e=>e.kind===GESTURE&&(e.draftId||pointer.actionId)===draftId),saves=events.filter(e=>e.kind===GESTURE&&e.name==='save-existing-invoice');
 if(saves.length!==2||saves[0].phase!=='started'||saves[1].phase!=='completed'||saves.some(e=>(e.draftId||pointer.actionId)!==draftId)||saves[1].ordinal<=saves[0].ordinal)fail('Exactly one completed real browser Save is required for UI lineage');
 for(const name of ['add-exact-estimate','copy-whole-estimate','save-existing-invoice']){const pair=gestures.filter(e=>e.name===name);if(pair.length!==2||pair[0].phase!=='started'||pair[1].phase!=='completed')fail('Complete one-shot UI gesture history required');}
 if(recovery&&gestures.some(e=>e.uiEvidence.browserTargetId!==recovery.newTargetId))fail('A recovered gesture targeted another browser tab');
 const observation=events.at(-1);
 if(observation.kind!==OBSERVATION||observation.draftId!==draftId||observation.classification!=='converted-records'||observation.pendingGestures?.length!==0||observation.ordinal<=saves[1].ordinal)fail('Fresh actual converted native records after completed Save required');
 const invariants=assertUiReadback(p,observation.after,Date.parse(observation.recordedAt),saves[1].recordedAt);
 if(!equal(invariants,observation.invariants))fail('Retained UI record invariants changed');
 return{p,attempt,events,observation,recovery,draftId,actionId:pointer.actionId,actionEvidenceHash:hash(observation)};
}
function uiFence(bundle,pointer,revision){return{scope:bundle.p.scope,operationId:bundle.p.operationId,revision,unresolved:pointer,quarantinedRepair:{version:1,kind:'known-observed-ui-link-correction',authorityHash:pointer.authorityHash,actionId:bundle.actionId,actionEvidenceHash:bundle.actionEvidenceHash,operationId:bundle.p.operationId,qboId:bundle.p.originalStep.qboId}};}
async function loadOwnedUiLinkLineage({models,scope,step,session}){
 const row=await read(models.Authorities,{_id:planId(scope,step.logicalKey),...scope,'payload.kind':PLAN},session);if(!row)return null;
 const authorityHash=row.contentHash,{p}=await readUiAuthority(models,scope,authorityHash,session,PLAN);
 if(p.originalStep.compilation.compilationHash!==step.compilation.compilationHash||p.originalStep.receipt.evidenceHash!==step.receipt.evidenceHash||p.originalStep.qboId!==step.qboId)fail('UI correction changed original accepted creation identity');
 const outcome=await read(models.Authorities,{...scope,'payload.kind':OUTCOME,'payload.planAuthorityHash':authorityHash},session);let bundle,outcomeHash=null;
 if(outcome){const {p:o}=await readUiAuthority(models,scope,outcome.contentHash,session,OUTCOME);if(o.planAuthorityHash!==authorityHash||o.logicalKey!==p.logicalKey||o.actionId!==o.writerFence?.unresolved?.actionId||o.graphSourceHash!==hash(o.graphSourceJson)||JSON.parse(o.graphSourceJson).evidenceHash!==o.graph?.evidenceHash)fail('Verified UI outcome changed');bundle=await uiJournal({models,scope,authorityHash,pointer:o.writerFence.unresolved,session});
  if(o.observationHash!==bundle.actionEvidenceHash||!equal(o.after,bundle.observation.after)||!equal(o.invariants,assertUiReadback(p,o.after,Date.parse(o.verifiedAt),bundle.observation.notBefore)))fail('Verified UI record evidence changed');
  require('./business-ui-link-contract').assertUiFinancialTiming(o.reports,o.parentLedgers,bundle.observation.recordedAt);
  require('./business-link-repair').assertRepairGraph(p,o.after,JSON.parse(o.graphSourceJson),o.writerFence,o.graphSteps,Date.parse(o.verifiedAt),o.policyHashes);require('./business-link-repair').assertReportSources(p,p.reports,o.reports,Date.parse(o.verifiedAt),false,o.parentLedgers);outcomeHash=outcome.contentHash;
 }else{const writer=await read(models.Writers,{...scope},session);if(String(writer?.operationId)!==p.operationId||writer?.planHash!==p.planHash)fail('Known observed UI conversion needs its exact held writer');bundle=await uiJournal({models,scope,authorityHash,pointer:writer.unresolved,session});}
 return{version:1,kind:'verified-owned-ui-link-correction',authorityHash,outcomeHash,actionId:bundle.actionId,actionEvidenceHash:bundle.actionEvidenceHash,compilationHash:step.compilation.compilationHash,creationReceiptHash:step.receipt.evidenceHash,qboId:step.qboId,stage:outcomeHash?'verified-outcome':'provisional-known-observed-read-only'};
}
module.exports={uiJournal,uiFence,loadOwnedUiLinkLineage};
