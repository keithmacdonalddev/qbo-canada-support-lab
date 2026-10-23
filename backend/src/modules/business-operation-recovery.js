'use strict';
const {hash,canonical}=require('./business-calendar');
const {assertRun,assertRunApproval}=require('./business-period-store');
const {assertPublishedBusiness}=require('./business-authority');
const {randomUUID}=require('node:crypto');
const ID=/^[a-f0-9]{24}$/,HASH=/^[a-f0-9]{64}$/;
const read=(Model,filter,session)=>Model.findOne(filter).session(session).maxTimeMS(3000).lean();
function fail(message){throw Object.assign(new Error(message),{status:409,code:'BUSINESS_RECOVERY_REVIEW_REQUIRED'});}
function createBusinessOperationRecovery({models,transaction,now,bind,fence,agentAuthority,Agents}){
 async function inspect(bound,operationId,input,mode,session){
  if(!ID.test(operationId||'')||!HASH.test(input.planHash||'')||!['resume','retry-rejected'].includes(mode))fail('Choose the exact saved operation and recovery.');
  const {scope}=bound,run=await read(models.Runs,{_id:operationId,...scope,planHash:input.planHash},session);assertRun(run,scope);assertRunApproval(run);
  if(agentAuthority&&(!run.agentAuthority||!require('./business-agent-authority').sameAuthority(run.agentAuthority,agentAuthority)))fail('Recovery belongs to a different agent authorization.');
   const current=await assertPublishedBusiness({...models,scope,manifest:run,session,fence:Boolean(session)}),calendar=current.calendar,writer=await read(models.Writers,{environment:scope.environment,realmId:scope.realmId},session);
  if(writer?.populationDelegation)fail('The original operation is held by its bulk population job.');
  if(!writer||String(writer.connectionId)!==scope.connectionId||String(writer.operationId)!==operationId||writer.planHash!==run.planHash||writer.unresolved!==null||String(calendar.currentOperationId)!==operationId||calendar.pendingCommit)fail('Settle the uncertain company request before reviewing recovery.');
  if(run.leaseToken&&(!Number.isFinite(new Date(run.leaseExpiresAt).getTime())||new Date(run.leaseExpiresAt).getTime()>now()))fail('An active worker must finish before recovery can be reviewed.');
  if(mode==='resume'&&run.executionRequest?.pending&&run.executionRequest.mode==='stop')fail('The saved stop request is still being recorded. Refresh after it settles before reviewing resume.');
  if(mode==='resume'?run.status!=='stopped'||calendar.stopRequested!==true:!['blocked','stopped'].includes(run.status))fail('The operation is not in the reviewed recovery state.');
  let step=null,receipt=null;
  if(mode==='retry-rejected'){
   if(!HASH.test(input.logicalKey||''))fail('Choose the exact rejected activity.');
   step=await read(models.Steps,{...scope,operationId,logicalKey:input.logicalKey,planHash:run.planHash,state:'rejected'},session);
   receipt=step?.rejection&&await read(models.Receipts,{_id:step.rejection.receiptId,...scope,kind:'business',operationId,logicalKey:input.logicalKey,state:'rejected',dispatchKey:step.dispatch?.key,requestHash:step.dispatch?.requestHash},session);
   const observed=receipt?.observed;
   if(!step||step.qboId||step.receipt||!receipt||!receipt.resultAuditId||observed?.outcome!=='rejected'||observed.httpStatus!==400||!HASH.test(observed.responseHash||'')||observed.qboId||observed.operation!=='create'||step.rejection.evidenceHash!==hash(observed)||!Array.isArray(observed.faultCodes)||!observed.faultCodes.length||observed.faultCodes.some(code=>!/^\d{1,8}$/.test(code))||!Number.isSafeInteger(step.attempts)||step.attempts>=20)fail('Only a fully audited ValidationFault with no saved record can receive a new attempt.');
   const audit=await read(models.Audits,{_id:receipt.resultAuditId,userId:bound.ownerId,realmId:scope.realmId,action:'QuickBooks write response recorded',outcome:'failure','inputParams.dispatchKey':receipt.dispatchKey,'inputParams.requestHash':receipt.requestHash,'afterState.outcome':'rejected','afterState.responseHash':observed.responseHash},session);if(!audit)fail('The rejected transport audit is unavailable.');
  }
  const state={version:1,scope,operationId,...(agentAuthority?{agentAuthority}:{}),planHash:run.planHash,mode,executionRevision:run.executionRevision,runWriterRevision:run.writerRevision,policyHead:run.policyAmendmentHash||null,writerRevision:writer.revision,calendarWriterRevision:calendar.writerRevision,stopRequested:calendar.stopRequested,nextOrdinal:run.nextOrdinal,rejected:step?{logicalKey:step.logicalKey,revision:step.revision,dispatchKey:step.dispatch.key,requestHash:step.dispatch.requestHash,receiptId:String(receipt._id),responseHash:receipt.observed.responseHash,faultCodes:receipt.observed.faultCodes,retryGeneration:step.retryGeneration||0}:null};
  return{run,calendar,writer,step,receipt,state,reviewHash:hash(state)};
 }
 async function review(user,operationId,input,mode){
  const wanted=mode==='resume'?'planHash':'logicalKey,planHash';if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).sort().join(',')!==wanted)fail('Choose the exact saved recovery action.');
  const bound=await bind(user,'operations.execute',true),current=await inspect(bound,operationId,input,mode);return{scope:bound.scope,operationId,mode,reviewHash:current.reviewHash,review:current.state,qboWrites:0,queuedContinuation:current.run.executionRequest?.pending===true};
 }
 async function approve(user,operationId,input,mode){
  const wanted=mode==='resume'?'planHash,reason,reviewHash':'logicalKey,planHash,reason,reviewHash';if(!ID.test(operationId||'')||!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).sort().join(',')!==wanted||!HASH.test(input.planHash||'')||!HASH.test(input.reviewHash||'')||typeof input.reason!=='string'||input.reason.trim().length<20||input.reason.length>2000)fail('Approve the exact saved recovery review with a reason.');
  const bound=await bind(user,'operations.execute',true),{scope,ownerId}=bound,auditId=hash({businessRecovery:mode,reviewHash:input.reviewHash}).slice(0,24);
  return transaction(async session=>{
   await fence(bound,session,'operations.execute');if(agentAuthority)await require('./business-agent-authority').fenceAgentAuthority({authority:agentAuthority,scope,ownerId,actorId:bound.actorId,Agents,session});const previous=await read(models.Audits,{_id:auditId,userId:ownerId,realmId:scope.realmId,action:'Business operation recovery approved',outcome:'success','afterState.mode':mode,'afterState.environment':scope.environment,'afterState.connectionId':scope.connectionId,'afterState.reviewHash':input.reviewHash,'afterState.reason':input.reason.trim(),'afterState.operationId':operationId,'afterState.planHash':input.planHash,...(mode==='retry-rejected'?{'beforeState.rejected.logicalKey':input.logicalKey}:{})},session);if(previous){if(hash(previous.beforeState)!==input.reviewHash)fail('The retained recovery review changed.');return{scope,operationId,approved:true,reused:true};}
   const current=await inspect(bound,operationId,input,mode,session);if(current.reviewHash!==input.reviewHash)fail('The saved operation changed after recovery review. Review it again.');
   if(current.step){const step=current.step,changed=await models.Steps.findOneAndUpdate({_id:step._id,...scope,operationId,planHash:current.run.planHash,state:'rejected',revision:step.revision,'dispatch.key':step.dispatch.key,receipt:null},{$set:{state:'claimed',dispatch:null,compilation:null,rejection:null,verification:null,leaseToken:randomUUID(),leaseExpiresAt:new Date(0),lastAuditId:auditId,retryHistory:[...(step.retryHistory||[]),{receiptId:String(current.receipt._id),dispatchKey:step.dispatch.key,responseHash:current.receipt.observed.responseHash,recoveryAuditId:auditId,retryGeneration:(step.retryGeneration||0)+1}]},$inc:{revision:1,retryGeneration:1}},{new:true,session}).lean();if(!changed)fail('The rejected attempt changed during recovery.');}
   const status=mode==='resume'?(current.run.nextOrdinal===current.run.recordCount?'awaiting-evidence':'blocked'):current.run.status;
   const run=await models.Runs.findOneAndUpdate({_id:operationId,...scope,status:current.run.status,executionRevision:current.run.executionRevision,writerRevision:current.run.writerRevision},{$set:{status,leaseToken:null,leaseExpiresAt:null,lastError:null,verificationCandidateHash:null},$inc:{executionRevision:1,writerRevision:1,evidenceRevision:1}},{new:true,session}).lean();
   const writer=await models.Writers.findOneAndUpdate({_id:current.writer._id,...scope,operationId,planHash:current.run.planHash,revision:current.writer.revision,unresolved:null},{$inc:{revision:1}},{new:true,session}).lean();
   const calendar=await models.Calendars.findOneAndUpdate({_id:current.calendar._id,...scope,currentOperationId:operationId,revision:current.calendar.revision,writerRevision:current.calendar.writerRevision,stopRequested:current.calendar.stopRequested,pendingCommit:null},{$set:{stopRequested:mode==='resume'?false:current.calendar.stopRequested},$inc:{writerRevision:1}},{new:true,session}).lean();if(!run||!writer||!calendar)fail('Operation ownership changed before recovery approval.');
   await models.Audits.create([{_id:auditId,userId:ownerId,realmId:scope.realmId,action:'Business operation recovery approved',actionType:agentAuthority?'ai_plan':'manual',outcome:'success',beforeState:current.state,afterState:{...scope,...(agentAuthority?{agentAuthority,approvalSource:'standing-owner-grant'}:{}),operationId,planHash:current.run.planHash,mode,reviewHash:input.reviewHash,reason:input.reason.trim(),qboWrites:0,queuedContinuation:run.executionRequest?.pending===true,...(current.step?{retainedRejectedAttempt:{dispatch:current.step.dispatch,rejection:current.step.rejection,compilationHash:current.step.compilation?.compilationHash},newRetryGeneration:(current.step.retryGeneration||0)+1}:{})}}],{session});
   return{scope,operationId,approved:true,reused:false,queuedContinuation:run.executionRequest?.pending===true};
  });
 }
 return{reviewResume:(u,id,input)=>review(u,id,input,'resume'),resume:(u,id,input)=>approve(u,id,input,'resume'),reviewRejected:(u,id,input)=>review(u,id,input,'retry-rejected'),retryRejected:(u,id,input)=>approve(u,id,input,'retry-rejected')};
}
module.exports={createBusinessOperationRecovery};
