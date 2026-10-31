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
// Automatic resolution under the standing grant (no owner decision): a possibly-sent
// request is abandoned once its sending process has been gone this long (far beyond the
// SDK request timeout), and a coverage read counts only when it starts this long after
// the send, so a created record is visible to it.
const ABANDON_MS = 10 * 60 * 1000, COVERAGE_MARGIN_MS = 5 * 60 * 1000, COVERAGE_LIMIT = 1000;
const AUTOMATIC_SOURCE = 'automatic-standing-grant-evidence';
const LISTS = { Customer: 'DisplayName', Vendor: 'DisplayName', Employee: 'DisplayName', Item: 'Name' };
// Does a saved record carry exactly what the original compiled create asked for? Every
// sent reference, the date, hours, line amounts and the activity marker (PrivateNote or
// Description, which carries the step's logical key) must agree.
function matchesCreation(entity, body, record) {
  if (!record || typeof record !== 'object') return false;
  if (body.TxnDate !== undefined && record.TxnDate !== body.TxnDate) return false;
  for (const key of ['CustomerRef', 'VendorRef', 'EmployeeRef', 'ItemRef', 'DepositToAccountRef', 'AccountRef', 'FromAccountRef', 'ToAccountRef', 'EntityRef']) if (body[key]?.value !== undefined && String(record[key]?.value) !== String(body[key].value)) return false;
  for (const key of ['PrivateNote', 'Description', 'DisplayName', 'Name', 'NameOf', 'Hours', 'Minutes', 'BillableStatus', 'DocNumber']) if (body[key] !== undefined && String(record[key]) !== String(body[key])) return false;
  const cents = value => Math.round(Number(value) * 100);
  if (body.TotalAmt !== undefined && cents(record.TotalAmt) !== cents(body.TotalAmt)) return false;
  if (body.Amount !== undefined && cents(record.Amount) !== cents(body.Amount)) return false;
  if (Array.isArray(body.Line)) {
    const amounts = lines => lines.filter(line => line?.DetailType !== 'SubTotalLineDetail').map(line => cents(line.Amount || 0)).sort((a, b) => a - b);
    if (canonical(amounts(body.Line)) !== canonical(amounts(record.Line || []))) return false;
  }
  return true;
}
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
    validate(operationId,input,true);
    // Standing-grant automatic attribution carries its retained coverage evidence.
    const automatic=options.automatic && Object.getPrototypeOf(options.automatic)===Object.prototype ? JSON.parse(JSON.stringify(options.automatic)) : null; const bound=await bind(user,'operations.execute',true), {scope,ownerId}=bound;
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
      const payload={version:1,kind:'owner-attributed-business-creation',scope,ownerId,operationId,planHash:input.planHash,logicalKey:input.logicalKey,entity:latest.step.entity,dispatchKey:latest.step.dispatch.key,requestHash:latest.step.dispatch.requestHash,receiptId:latest.receipt._id,terminalHash:latest.terminal.contentHash,qboId:input.qboId,syncToken:proof.observed.record.SyncToken,recordHash:proof.observed.recordHash,record:proof.observed.record,parents:proof.parents,content:proof.content,review:proof.state,reviewHash:input.reviewHash,confirmOwnership:true,reason:input.reason.trim(),approvedAt:new Date(now()).toISOString(),decisionKey,...(automatic?{automatic:{...automatic,source:AUTOMATIC_SOURCE}}:{})};
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
  // ---- Automatic resolution under the standing grant (no owner decision) ----
  // The operation's unresolved create, its receipt and the barrier, read together.
  async function unresolvedCreate(scope, operationId, planHash, session) {
    const writer=await read(models.Writers,{environment:scope.environment,realmId:scope.realmId},session), barrier=writer?.unresolved;
    if (!writer || String(writer.operationId)!==operationId || writer.planHash!==planHash || !barrier || !HASH.test(barrier.key || '') || !HASH.test(barrier.logicalKey || '')) return null;
    const run=await read(models.Runs,{_id:operationId,...scope,planHash},session);
    const step=await read(models.Steps,{...scope,operationId,planHash,logicalKey:barrier.logicalKey},session);
    const receipt=await read(models.Receipts,{_id:hash({scope,dispatchKey:barrier.key}),...scope},session);
    return {writer,barrier,run,step,receipt};
  }
  // A possibly-sent request whose process is gone gets the same terminal unknown facts the
  // write gate records for a failed transport, so the attribution contract applies to it.
  async function endAbandoned(bound, operationId, planHash) {
    const {scope}=bound;
    return transaction(async session=>{
      await fence(bound,session,'operations.execute');
      const current=await unresolvedCreate(scope,operationId,planHash,session), stored=current?.receipt, run=current?.run;
      if (!stored || stored.state!=='possibly-sent' || current.barrier.transportConsumed?.receiptId!==stored._id || now()-new Date(stored.sentAt).getTime()<ABANDON_MS) fail('The request is not an abandoned possibly-sent create.');
      if (!run || (run.leaseToken && new Date(run.leaseExpiresAt).getTime()>now()) || !['reserved','running','blocked','stopped'].includes(run.status)) fail('A worker may still be sending this request; wait for its lease to end.');
      const observed={httpStatus:null,intuitTid:null,responseHash:null,entity:stored.entity,operation:stored.operation,outcome:'unknown',transportFailure:true};
      const observedAt=new Date(now()), resultAuditId=hash({receiptId:stored._id,event:'response',observed}).slice(0,24);
      const terminal={version:1,scope,receiptId:stored._id,dispatchKey:stored.dispatchKey,requestHash:stored.requestHash,kind:'sdk-failure',endedAt:observedAt.toISOString(),observedHash:hash(observed)};
      const terminalHash=hash(terminal), terminalAuditId=hash({terminalHash}).slice(0,24);
      const saved=await models.Receipts.findOneAndUpdate({_id:stored._id,...scope,state:'possibly-sent',requestHash:stored.requestHash},{$set:{state:'unknown',observed,observedAt,resultAuditId,terminal:{...terminal,contentHash:terminalHash,auditId:terminalAuditId}}},{new:true,session}).lean();
      const writer=await models.Writers.findOneAndUpdate({_id:current.writer._id,...scope,revision:current.writer.revision,'unresolved.key':stored.dispatchKey},{$set:{unresolved:{...current.writer.unresolved,responseReceiptId:stored._id}},$inc:{revision:1}},{new:true,session}).lean();
      if (!saved || !writer) fail('The abandoned request changed while its terminal facts were recorded.');
      const params={environment:scope.environment,connectionId:scope.connectionId,dispatchKey:stored.dispatchKey,requestHash:stored.requestHash,entity:stored.entity,operation:stored.operation};
      await models.Audits.create([{_id:resultAuditId,userId:stored.ownerId,actorUserId:String(stored.actorId)!==String(stored.ownerId)?stored.actorId:undefined,realmId:scope.realmId,action:'QuickBooks write transport failure recorded',actionType:'manual',outcome:'partial',inputParams:params,afterState:{state:'unknown',receiptId:stored._id,...observed}}],{session});
      await models.Audits.create([{_id:terminalAuditId,userId:stored.ownerId,actorUserId:String(stored.actorId)===String(stored.ownerId)?undefined:stored.actorId,realmId:scope.realmId,action:'QuickBooks write attempt ended without a confirmed outcome',actionType:'manual',outcome:'partial',afterState:{...terminal,contentHash:terminalHash}}],{session});
      return true;
    });
  }
  // One targeted coverage read of the created entity: transactions by date, list records by
  // their unique name. readStartedAt is taken before the request.
  async function coverage(bound, step, {signal}={}) {
    const body=JSON.parse(step.compilation.request.body), entity=step.entity, field=LISTS[entity];
    const quote=value=>"'"+String(value).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'";
    if (field ? typeof body[field]!=='string' : !/^\d{4}-\d{2}-\d{2}$/.test(body.TxnDate || '')) fail('This creation has no date or unique name to search by.');
    const text='SELECT * FROM '+entity+' WHERE '+(field ? field+' = '+quote(body[field]) : 'TxnDate = '+quote(body.TxnDate))+' MAXRESULTS '+COVERAGE_LIMIT;
    await bound.access.authorize(bound.scope,'operations.execute',{signal});
    const client=await bound.access.resolveClient(bound.scope,{signal}), readStartedAt=now(), response=await client.query(text);
    const rows=response?.QueryResponse?.[entity];
    return {text,readStartedAt,rows:Array.isArray(rows)?rows:[],complete:Array.isArray(rows)?rows.length<COVERAGE_LIMIT:response?.QueryResponse!==undefined,body};
  }
  async function claimedElsewhere(scope, entity, qboId, receiptId) {
    const company={environment:scope.environment,realmId:scope.realmId};
    if (await models.Steps.findOne({...company,entity,qboId}).select('_id').maxTimeMS(3000).lean()) return true;
    const receipts=await models.Receipts.find({...company,entity:entity.toLowerCase(),$or:[{'observed.qboId':qboId},{'reconciliation.qboId':qboId},{'ownerRecovery.qboId':qboId}]}).limit(3).maxTimeMS(3000).lean();
    return receipts.some(row=>String(row._id)!==receiptId);
  }
  // No candidate after proven coverage: the request created nothing. The receipt is settled
  // as having no effect, the barrier is released and the step is claimable again; the
  // step's activity marker lets any later look-up find a duplicate.
  async function concludeNotCreated(bound, operationId, planHash, evidence) {
    const {scope,ownerId}=bound;
    return transaction(async session=>{
      await fence(bound,session,'operations.execute');
      const current=await unresolvedCreate(scope,operationId,planHash,session), {step,receipt,writer,run}=current || {};
      if (!receipt || receipt.state!=='unknown' || receipt.ownerRecovery || receipt.reconciliation || !step || !['dispatched','unknown'].includes(step.state) || step.receipt || step.qboId) fail('The unknown create changed before it could be settled as not created.');
      await terminalUnknown(models,scope,step,receipt,session);
      if (!run || (run.leaseToken && new Date(run.leaseExpiresAt).getTime()>now())) fail('A worker holds this operation.');
      const calendar=await read(models.Calendars,{...scope,currentOperationId:operationId,pendingCommit:null},session);
      if (!calendar) fail('The operation no longer holds the calendar.');
      const auditId=hash({receiptId:receipt._id,event:'not-created',evidence:evidence.coverageHash}).slice(0,24);
      const reconciliation={version:1,outcome:'not-created',source:AUTOMATIC_SOURCE,at:new Date(now()).toISOString(),coverage:evidence,auditId};
      const settled=await models.Receipts.findOneAndUpdate({_id:receipt._id,...scope,state:'unknown',ownerRecovery:null,reconciliation:null},{$set:{state:'rejected',reconciliation}},{new:true,session}).lean();
      const reset=await models.Steps.findOneAndUpdate({_id:step._id,...scope,operationId,state:step.state,revision:step.revision,'dispatch.key':receipt.dispatchKey,receipt:null},{$set:{state:'claimed',dispatch:null,compilation:null,rejection:null,verification:null,leaseToken:randomUUID(),leaseExpiresAt:new Date(0),lastAuditId:auditId,retryHistory:[...(step.retryHistory||[]),{receiptId:String(receipt._id),dispatchKey:receipt.dispatchKey,responseHash:null,recoveryAuditId:auditId,retryGeneration:(step.retryGeneration||0)+1,outcome:'not-created'}]},$inc:{revision:1,retryGeneration:1}},{new:true,session}).lean();
      const released=await models.Writers.findOneAndUpdate({_id:writer._id,...scope,revision:writer.revision,operationId,planHash,'unresolved.key':receipt.dispatchKey},{$set:{unresolved:null},$inc:{revision:1}},{new:true,session}).lean();
      const changedRun=await models.Runs.findOneAndUpdate({_id:operationId,...scope,status:run.status,writerRevision:run.writerRevision,evidenceRevision:run.evidenceRevision},{$set:{verificationCandidateHash:null,lastError:null},$inc:{writerRevision:1,evidenceRevision:1}},{new:true,session}).lean();
      const changedCalendar=await models.Calendars.findOneAndUpdate({_id:calendar._id,...scope,currentOperationId:operationId,writerRevision:calendar.writerRevision},{$inc:{writerRevision:1}},{new:true,session}).lean();
      if (!settled || !reset || !released || !changedRun || !changedCalendar) fail('The unknown create changed while it was settled as not created.');
      await models.Audits.create([{_id:auditId,userId:ownerId,realmId:scope.realmId,action:'Uncertain business creation proved not created',actionType:'manual',outcome:'success',beforeState:{...scope,operationId,logicalKey:step.logicalKey,receiptId:receipt._id,dispatch:step.dispatch},afterState:{state:'claimed',reconciliation,qboWrites:0}}],{session});
      return true;
    });
  }
  // The whole automatic path. Returns { state, message } where state is 'none' (no
  // unresolved create), 'waiting' (too early, or a worker is active), 'attributed',
  // 'not-created' (the step may be sent again) or 'ambiguous' (held, reported plainly).
  async function resolveAutomatically(user,operationId,input,{signal}={}) {
    exact(input,['planHash']); if(!ID.test(operationId || '') || !HASH.test(input.planHash || ''))fail('Choose the exact saved operation and plan.');
    const bound=await bind(user,'operations.execute',true), {scope}=bound;
    let current=await unresolvedCreate(scope,operationId,input.planHash);
    if (!current?.receipt) return {state:'none',message:'No uncertain create holds this operation.'};
    const {receipt,step,run}=current, sentAt=new Date(receipt.sentAt).getTime();
    if (receipt.kind!=='business' || receipt.operation!=='create' || !step?.compilation || receipt.ownerRecovery || receipt.reconciliation) return {state:'ambiguous',message:'This uncertain request is not an unattributed business create; it needs its own recovery.'};
    if (run?.leaseToken && new Date(run.leaseExpiresAt).getTime()>now()) return {state:'waiting',message:'A worker still holds this operation.'};
    if (receipt.state==='possibly-sent') {
      if (now()-sentAt<ABANDON_MS) return {state:'waiting',message:'The request was sent '+Math.round((now()-sentAt)/1000)+' seconds ago; its outcome is checked automatically after 10 minutes.'};
      await endAbandoned(bound,operationId,input.planHash);
    } else if (receipt.state!=='unknown') return {state:'none',message:'The request already has a settled outcome.'};
    if (now()<sentAt+COVERAGE_MARGIN_MS) return {state:'waiting',message:'Waiting for QuickBooks to show any record created by this request.'};
    const seen=await coverage(bound,step,{signal});
    if (!seen.complete) return {state:'ambiguous',message:'The coverage search returned '+COVERAGE_LIMIT+' or more '+step.entity+' records; it cannot prove the outcome. The operation stays held.'};
    if (seen.readStartedAt<sentAt+COVERAGE_MARGIN_MS) return {state:'waiting',message:'The coverage read started too soon after the send.'};
    const window=row=>{const created=Date.parse(row?.MetaData?.CreateTime);return Number.isFinite(created) && created>=sentAt-CLOCK_TOLERANCE_MS && created<=seen.readStartedAt+CLOCK_TOLERANCE_MS;};
    const matching=seen.rows.filter(row=>window(row) && matchesCreation(step.entity,seen.body,row));
    const free=[];for(const row of matching)if(QID.test(String(row.Id || '')) && !await claimedElsewhere(scope,step.entity,String(row.Id),receipt._id))free.push(row);
    const evidence={query:seen.text,readStartedAt:new Date(seen.readStartedAt).toISOString(),sentAt:new Date(sentAt).toISOString(),returned:seen.rows.length,matching:matching.map(row=>String(row.Id)),unclaimed:free.map(row=>String(row.Id))};
    evidence.coverageHash=hash(evidence);
    if (free.length===1) {
      const qboId=String(free[0].Id), target={planHash:input.planHash,logicalKey:step.logicalKey,qboId};
      const reviewed=await review(user,operationId,target,{signal});
      const reason='Automatic standing-grant evidence: one coverage read ('+evidence.query+') started '+evidence.readStartedAt+', after the send at '+evidence.sentAt+', found exactly one unclaimed '+step.entity+' ('+qboId+') matching the original request.';
      await approve(user,operationId,{...target,reviewHash:reviewed.reviewHash,reason,confirmOwnership:true},{signal,automatic:evidence});
      return {state:'attributed',qboId,message:step.entity+' '+qboId+' was attributed to the request automatically; the operation can continue.',evidence};
    }
    if (free.length===0 && matching.length===0) {
      await concludeNotCreated(bound,operationId,input.planHash,evidence);
      return {state:'not-created',message:'No '+step.entity+' created by this request exists; the record will be sent again.',evidence};
    }
    return {state:'ambiguous',message:(matching.length>1?matching.length+' matching '+step.entity+' records ('+evidence.matching.join(', ')+')':'The only matching record belongs to another request')+'; the operation stays held for review.',evidence};
  }
  return {reviewUnknown:review,attributeUnknown:approve,resolveUnknownAutomatically:resolveAutomatically};
}
module.exports={createBusinessUnknownRecovery,CLOCK_TOLERANCE_MS,matchesCreation,AUTOMATIC_SOURCE};
