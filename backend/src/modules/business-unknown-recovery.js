'use strict';
const { randomUUID } = require('node:crypto');
const { hash, canonical } = require('./business-calendar');
const { assertRun, assertRunApproval } = require('./business-period-store');
const { assertPublishedBusiness } = require('./business-authority');
const { validateOperationEntry } = require('./business-operation-plan-store');
const { effectiveBusinessPolicy } = require('./business-policy-amendment');
const { validateBaselineObservation } = require('./business-baseline');
const { validateCompilation, verifyBusinessContent } = require('./business-readback');
const { createBusinessTransactionReader } = require('./business-reference');
const { taxExpectation } = require('./business-verification-runtime');
const { assertNoLegacyOwnership } = require('./business-recovery-ownership');
const { SOURCE, ACTION, terminalUnknown, attributionReceipt, attributionAudit, assertOwnerAttribution } = require('./business-owner-attribution');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/, QID = /^\d{1,30}$/;
const CLOCK_TOLERANCE_MS = 15 * 60 * 1000;
const read = (Model,filter,session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
function fail(message) { throw Object.assign(new Error(message), { status:409, code:'BUSINESS_UNKNOWN_REVIEW_REQUIRED' }); }
function exact(input, keys) { if (!input || Object.getPrototypeOf(input)!==Object.prototype || Object.keys(input).sort().join(',')!==keys.sort().join(',')) fail('Use the exact saved activity, candidate ID and owner decision without scope overrides.'); }
function recordSummary(record,taxCents) {
  const get=path=>path.split('.').reduce((value,key)=>value?.[key],record);
  const fields=['CustomerRef','VendorRef','EmployeeRef','ItemRef','ARAccountRef','APAccountRef','DepositToAccountRef','DepositAccountRef','BankAccountRef','PaymentMethodRef','CheckPayment.BankAccountRef','CreditCardPayment.CCAccountRef'];
  return {txnDate:record.TxnDate,dueDate:record.DueDate || null,marker:record.PrivateNote ?? record.Description ?? null,total:record.TotalAmt ?? (record.Line?.length ? (record.Line.reduce((sum,line)=>sum+Math.round((line.Amount || 0)*100),0)+(taxCents || 0))/100 : null),tax:taxCents==null?record.TxnTaxDetail?.TotalTax ?? null:taxCents/100,choices:fields.filter(key=>get(key)?.value).map(key=>({label:key.replace(/Ref$/, '').replaceAll('.', ' / '),id:get(key).value})),lines:(record.Line || []).map(line=>{const detail=line[line.DetailType] || {};return {itemId:detail.ItemRef?.value || null,accountId:detail.AccountRef?.value || null,billableStatus:detail.BillableStatus || null,quantity:detail.Qty ?? null,unitPrice:detail.UnitPrice ?? null,amount:line.Amount ?? null,taxCodeId:detail.TaxCodeRef?.value || null};}),links:[...(record.LinkedTxn || []),...(record.Line || []).flatMap(line=>line.LinkedTxn || [])].map(link=>({entity:link.TxnType,id:link.TxnId,lineId:link.TxnLineId || null})),time:record.Hours!=null?{hours:record.Hours,minutes:record.Minutes ?? 0,billableStatus:record.BillableStatus}:null};
}
function createBusinessUnknownRecovery({models,connection,transaction,now,bind,fence}) {
  async function inspect(bound, operationId, input, session) {
    const {scope,ownerId}=bound;
    const run=await read(models.Runs,{_id:operationId,...scope,planHash:input.planHash},session); assertRun(run,scope); assertRunApproval(run);
    const active=await assertPublishedBusiness({...models,scope,manifest:run,session,fence:Boolean(session)});
    const calendar=active.calendar, writer=await read(models.Writers,{environment:scope.environment,realmId:scope.realmId},session);
    const policy=await read(models.Policies,{environment:scope.environment,realmId:scope.realmId},session);
    if (!['reserved','running','blocked','stopped'].includes(run.status) || (run.leaseToken && (!Number.isFinite(new Date(run.leaseExpiresAt).getTime()) || new Date(run.leaseExpiresAt).getTime()>now()))) fail('Wait for the active worker to finish and the operation to stop before reviewing attribution.');
    if (!writer || !policy || String(writer.connectionId)!==scope.connectionId || String(policy.connectionId)!==scope.connectionId || !['active','preparing'].includes(policy.state) || String(writer.operationId)!==operationId || writer.planHash!==run.planHash || String(calendar.currentOperationId)!==operationId || calendar.pendingCommit) fail('The exact operation must still own the company writer and calendar.');
    const step=await read(models.Steps,{...scope,operationId,planHash:run.planHash,logicalKey:input.logicalKey},session);
    if (!step || !['dispatched','unknown'].includes(step.state) || step.receipt || step.qboId || !step.dispatch || !step.compilation) fail('This activity does not have an unsettled creation request.');
    const request=validateCompilation(step.compilation), d=step.dispatch;
    if (step.compilation.logicalKey!==step.logicalKey || step.compilation.entity!==step.entity || step.compilation.intentHash!==step.fingerprint || step.compilation.compilationHash!==d.compilationHash || request.requestHash!==d.requestHash || canonical(request.scope)!==canonical(scope)) fail('The original compiled request changed.');
    const receiptId=hash({scope,dispatchKey:d.key}), barrier=writer.unresolved;
    if (!barrier || barrier.key!==d.key || barrier.logicalKey!==step.logicalKey || barrier.requestHash!==d.requestHash || barrier.transportConsumed?.receiptId!==receiptId) fail('The exact original request must still hold the company barrier.');
    const receipt=await read(models.Receipts,{_id:receiptId,...scope},session), terminal=await terminalUnknown(models,scope,step,receipt,session);
    if (receipt.ownerRecovery || String(receipt.ownerId)!==ownerId || terminal.endedAt>new Date(now()).toISOString()) fail('The unknown attempt already has a decision or lacks a valid terminal observation.');
    const plan=await read(models.Plans,{_id:run.planId,...scope,operationId,planHash:run.planHash},session);
    const intent=await read(models.Intents,{...scope,planId:run.planId,planHash:run.planHash,logicalKey:step.logicalKey},session);
    if (!plan || hash(plan.manifest)!==run.planHash || !intent || canonical(validateOperationEntry(intent,scope,run.fromDate,run.throughDate))!==canonical(plan.manifest.records[intent.ordinal]) || intent.kind!=='create' || hash(intent.step)!==step.fingerprint || canonical(intent.step.dependencies)!==canonical(step.dependencies)) fail('The original immutable activity is unavailable.');
    const originalPolicy=await effectiveBusinessPolicy(models,scope,{...run,policyAmendmentHash:d.policyAmendmentHash || null},intent,session);
    if (d.policyHash && hash(originalPolicy)!==d.policyHash) fail('The policy bound at the original dispatch changed.');
    const baseline=await read(models.Baselines,{_id:active.value.baselineId,...scope},session); validateBaselineObservation(baseline);
    if (baseline.evidenceHash!==run.baselineHash || hash(baseline.inventorySources.records)!==active.value.inventoryHash || !Array.isArray(baseline.inventorySources.records[step.entity])) fail('The complete accepted inventory is unavailable.');
    if (baseline.inventorySources.records[step.entity].some(row=>row.id===input.qboId)) fail('This record existed in the accepted opening inventory and cannot be attributed to a later creation.');
    const company={environment:scope.environment,realmId:scope.realmId};
    const owners=await models.Steps.find({...company,entity:step.entity,qboId:input.qboId}).limit(2).session(session).maxTimeMS(3000).lean();
    const receipts=await models.Receipts.find({...company,entity:step.entity.toLowerCase(),$or:[{'observed.qboId':input.qboId},{'reconciliation.qboId':input.qboId},{'ownerRecovery.qboId':input.qboId}]}).limit(3).session(session).maxTimeMS(3000).lean();
    if (owners.length || receipts.some(row=>String(row._id)!==receiptId)) fail('This physical record already belongs to another managed or legacy request.');
    await assertNoLegacyOwnership(connection?.db,scope,step.entity,input.qboId,session);
    const state={version:1,scope,ownerId,operationId,planHash:run.planHash,logicalKey:step.logicalKey,entity:step.entity,qboId:input.qboId,authorityHash:run.authorityHash,policyHead:run.policyAmendmentHash || null,originalPolicyHash:hash(originalPolicy),policyRevision:policy.revision,writerRevision:writer.revision,barrierHash:hash(barrier),calendarRevision:calendar.revision,calendarWriterRevision:calendar.writerRevision,stopRequested:calendar.stopRequested,runStatus:run.status,executionRevision:run.executionRevision,runWriterRevision:run.writerRevision,evidenceRevision:run.evidenceRevision,runLeaseHash:hash({token:run.leaseToken || null,expiresAt:run.leaseExpiresAt ? new Date(run.leaseExpiresAt).toISOString() : null}),stepRevision:step.revision,stepLeaseHash:hash(step.leaseToken || null),dispatchHash:hash(d),receiptId,terminalHash:terminal.contentHash,observedHash:hash(receipt.observed)};
    return {run,calendar,writer,policy,step,receipt,terminal,originalPolicy,state};
  }
  async function observe(bound,current,input,{signal}={}) {
    const {scope,access}=bound, {step,terminal,originalPolicy}=current, started=Date.now();
    const reader=createBusinessTransactionReader({authorize:access.authorize,resolveClient:access.resolveClient,now});
    const check=()=>{if(signal?.aborted || Date.now()-started>180000)fail('The read-only recovery review exceeded its three-minute budget. Refresh it before approving.');};
    check(); const observed=await reader(scope,step.entity,input.qboId,{signal}); check();
    const created=Date.parse(observed.record.MetaData?.CreateTime);
    // This explicit local tolerance is a rejection filter, never a QBO clock SLA
    // or proof of request correlation. No matching record means no replay permit.
    if (!Number.isFinite(created) || created<Date.parse(terminal.sentAt)-CLOCK_TOLERANCE_MS || created>Date.parse(terminal.endedAt)+CLOCK_TOLERANCE_MS || created>now()+CLOCK_TOLERANCE_MS) fail('The candidate lacks a creation time within this attempt’s local ±15-minute review window. Time and matching amounts do not establish request identity.');
    const parents=[];
    for (const link of step.compilation.relationships) {
      check(); const row=await read(models.Steps,{...scope,logicalKey:link.logicalKey,entity:link.entity,fingerprint:link.fingerprint,qboId:link.qboId});
      if (!row || !['saved','verified'].includes(row.state) || !row.receipt) fail('An original dependency is missing or unsettled.');
      await assertOwnerAttribution(models,scope,row);
      const value=await reader(scope,link.entity,link.qboId,{signal}); check();
      parents.push({...value,logicalKey:link.logicalKey,entity:link.entity,fingerprint:link.fingerprint,state:row.state,qboId:link.qboId,stepRevision:row.revision});
    }
    const expectation=taxExpectation(originalPolicy,step.compilation);
    const taxPolicy=expectation?{...expectation,status:'approved',scope,compilationHash:step.compilation.compilationHash,evidenceHash:hash({policyHash:hash(originalPolicy),expectation})}:null;
    const temporaryReceipt={version:1,scope,entity:step.entity,logicalKey:step.logicalKey,dispatchKey:step.dispatch.key,requestHash:step.dispatch.requestHash,qboId:input.qboId,syncToken:observed.record.SyncToken,source:SOURCE,ownerAttribution:{version:1,pendingReview:true},evidenceHash:hash({candidate:observed.recordHash,dispatch:step.dispatch.key})};
    const content=verifyBusinessContent({compiled:step.compilation,receipt:temporaryReceipt,observed,parents,taxPolicy,now:now()});
    if (content.matchesIntent!==true) fail('The candidate differs from the original request: '+content.issues.join(' '));
    if (Buffer.byteLength(canonical({observed,parents}))>1000000) fail('The recovery observations exceed their one-megabyte evidence budget.');
    return {observed,parents,content,state:{...current.state,candidate:{recordHash:observed.recordHash,syncToken:observed.record.SyncToken,createdAt:observed.record.MetaData.CreateTime},parents:parents.map(row=>({logicalKey:row.logicalKey,entity:row.entity,qboId:row.qboId,recordHash:row.recordHash,syncToken:row.record.SyncToken,stepRevision:row.stepRevision})).sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey))}};
  }
  function validate(operationId,input,approval=false) {
    exact(input,approval?['planHash','logicalKey','qboId','reviewHash','reason','confirmOwnership']:['planHash','logicalKey','qboId']);
    if (!ID.test(operationId || '') || !HASH.test(input.planHash || '') || !HASH.test(input.logicalKey || '') || !QID.test(input.qboId || '') || (approval && (!HASH.test(input.reviewHash || '') || input.confirmOwnership!==true || typeof input.reason!=='string' || input.reason.trim().length<30 || input.reason.length>2000))) fail('Choose the exact saved activity and QBO ID; confirmation needs the reviewed evidence and your identification reason.');
  }
  async function review(user,operationId,input,options={}) {
    validate(operationId,input); const bound=await bind(user,'operations.execute',true), current=await inspect(bound,operationId,input), proof=await observe(bound,current,input,options);
    const after=await inspect(bound,operationId,input); if(canonical(after.state)!==canonical(current.state)) fail('The operation changed during the read-only review.');
    return {scope:bound.scope,operationId,reviewHash:hash(proof.state),review:proof.state,record:{entity:current.step.entity,id:input.qboId,createdAt:proof.observed.record.MetaData.CreateTime,recordHash:proof.observed.recordHash,...recordSummary(proof.observed.record)},original:{...recordSummary(JSON.parse(current.step.compilation.request.body),current.originalPolicy.readbackTax?.totalTaxCents),sentAt:current.terminal.sentAt,endedAt:current.terminal.endedAt,localCompletion:current.terminal.kind,dependencies:current.step.compilation.relationships.map(link=>({entity:link.entity,id:link.qboId,kind:link.kind}))},qboWrites:0,logicalRecordLookups:1+proof.parents.length,provenance:SOURCE,limitation:'Matching content and creation time do not prove which request created this record or rule out duplicates. Confirm only with your own identification evidence. This saves owner attribution; original transport uncertainty stays in history. Full graph and report checks remain required.',queuedContinuation:current.run.executionRequest?.pending===true};
  }
  async function approve(user,operationId,input,options={}) {
    validate(operationId,input,true); const bound=await bind(user,'operations.execute',true), {scope,ownerId}=bound;
    const decisionKey=hash({scope,ownerId,operationId,...input,reason:input.reason.trim()}), auditId=decisionKey.slice(0,24);
    const repeated=async session=>{
      const row=await read(models.Authorities,{...scope,'payload.decisionKey':decisionKey},session);if(!row)return null;
      const step=await read(models.Steps,{...scope,operationId,logicalKey:input.logicalKey},session), evidence=await assertOwnerAttribution(models,scope,step,session);
      if (!evidence || evidence.authority.contentHash!==row.contentHash || evidence.payload.ownerId!==ownerId || evidence.payload.reviewHash!==input.reviewHash || evidence.payload.qboId!==input.qboId) fail('The prior attribution does not match this exact decision.');
      return {scope,operationId,attributed:true,reused:true,qboId:input.qboId,provenance:SOURCE,qboWrites:0};
    };
    const old=await repeated(); if(old)return old;
    const current=await inspect(bound,operationId,input), proof=await observe(bound,current,input,options);
    if (hash(proof.state)!==input.reviewHash) fail('The candidate, parent records or operation changed after review. Review the exact ID again.');
    return transaction(async session=>{
      await fence(bound,session,'operations.execute'); const prior=await repeated(session); if(prior)return prior;
      const latest=await inspect(bound,operationId,input,session);
      if(canonical(latest.state)!==canonical(current.state) || now()-Date.parse(proof.observed.observedAt)>300000)fail('The operation or observation changed before confirmation.');
      for(const parent of proof.parents){const saved=await read(models.Steps,{...scope,logicalKey:parent.logicalKey,entity:parent.entity,qboId:parent.qboId,revision:parent.stepRevision},session);if(!saved || !['saved','verified'].includes(saved.state))fail('An original saved dependency changed before confirmation.');await assertOwnerAttribution(models,scope,saved,session);}
      const payload={version:1,kind:'owner-attributed-business-creation',scope,ownerId,operationId,planHash:input.planHash,logicalKey:input.logicalKey,entity:latest.step.entity,dispatchKey:latest.step.dispatch.key,requestHash:latest.step.dispatch.requestHash,receiptId:latest.receipt._id,terminalHash:latest.terminal.contentHash,qboId:input.qboId,syncToken:proof.observed.record.SyncToken,recordHash:proof.observed.recordHash,record:proof.observed.record,parents:proof.parents,content:proof.content,review:proof.state,reviewHash:input.reviewHash,confirmOwnership:true,reason:input.reason.trim(),approvedAt:new Date(now()).toISOString(),decisionKey};
      const contentHash=hash(payload), receipt=attributionReceipt(payload,contentHash,auditId), pointer={version:1,authorityHash:contentHash,auditId,qboId:input.qboId,reviewHash:input.reviewHash};
      await models.Authorities.create([{_id:hash({scope,contentHash}).slice(0,24),contractVersion:1,...scope,contentHash,payload,actorId:ownerId,auditId}],{session});
      const saved=await models.Steps.findOneAndUpdate({_id:latest.step._id,...scope,operationId,state:latest.step.state,revision:latest.step.revision,'dispatch.key':payload.dispatchKey,receipt:null},{$set:{state:'saved',receipt,qboId:input.qboId,verification:null,leaseToken:randomUUID(),leaseExpiresAt:new Date(0),lastAuditId:auditId},$inc:{revision:1}},{new:true,session}).lean();
      const settled=await models.Receipts.findOneAndUpdate({_id:latest.receipt._id,...scope,state:'unknown',dispatchKey:payload.dispatchKey,ownerRecovery:null},{$set:{ownerRecovery:pointer}},{new:true,session}).lean();
      const writer=await models.Writers.findOneAndUpdate({_id:latest.writer._id,...scope,operationId,planHash:input.planHash,revision:latest.writer.revision,'unresolved.key':payload.dispatchKey,'unresolved.transportConsumed.receiptId':payload.receiptId},{$set:{unresolved:null},$inc:{revision:1}},{new:true,session}).lean();
      const run=await models.Runs.findOneAndUpdate({_id:operationId,...scope,status:latest.run.status,executionRevision:latest.run.executionRevision,writerRevision:latest.run.writerRevision,evidenceRevision:latest.run.evidenceRevision},{$set:{status:latest.run.status==='stopped'?'stopped':'blocked',verificationCandidateHash:null,leaseToken:null,leaseExpiresAt:null,lastError:null},$inc:{executionRevision:1,writerRevision:1,evidenceRevision:1}},{new:true,session}).lean();
      const calendar=await models.Calendars.findOneAndUpdate({_id:latest.calendar._id,...scope,currentOperationId:operationId,revision:latest.calendar.revision,writerRevision:latest.calendar.writerRevision,stopRequested:latest.calendar.stopRequested,pendingCommit:null},{$inc:{writerRevision:1}},{new:true,session}).lean();
      if(!saved || !settled || !writer || !run || !calendar)fail('The original barrier or operation changed during owner attribution.');
      await models.Audits.create([{_id:auditId,userId:ownerId,realmId:scope.realmId,action:ACTION,actionType:'manual',outcome:'success',beforeState:proof.state,afterState:attributionAudit(payload,contentHash)}],{session});
      return {scope,operationId,attributed:true,reused:false,qboId:input.qboId,provenance:SOURCE,qboWrites:0,queuedContinuation:run.executionRequest?.pending===true};
    });
  }
  return {reviewUnknown:review,attributeUnknown:approve};
}
module.exports={createBusinessUnknownRecovery,CLOCK_TOLERANCE_MS};
