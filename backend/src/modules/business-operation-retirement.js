'use strict';
const { hash, canonical } = require('./business-calendar');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
const exact = input => input && Object.getPrototypeOf(input) === Object.prototype;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_RETIREMENT_BLOCKED' }); }
function createBusinessOperationRetirement({ models, transaction, now, bind, fence }) {
  const read=(Model,filter,session)=>Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function inspect(bound,operationId,planHash,session) {
    if(!ID.test(operationId||'')||!HASH.test(planHash||''))fail('Choose the exact saved operation and plan.');
    const {scope}=bound,run=await read(models.Runs,{_id:operationId,...scope,planHash},session);
    const calendar=await read(models.Calendars,{...scope},session),writer=await read(models.Writers,{environment:scope.environment,realmId:scope.realmId},session);
    if(!run||!calendar||!writer||String(writer.connectionId)!==scope.connectionId||run.status==='retired'||['verified','committing'].includes(run.status)||calendar.pendingCommit||calendar.verifiedThrough!==run.expectedCursor||calendar.revision!==run.expectedRevision||(calendar.currentOperationId!==null&&String(calendar.currentOperationId)!==operationId)||(writer.operationId!==null&&String(writer.operationId)!==operationId)||writer.unresolved!==null)fail('Only the exact unsettled operation with no uncertain request can be retired.');
    const plan=run&&await read(models.Plans,{_id:run.planId,...scope,operationId,planHash},session);
    if(!plan||hash(plan.manifest)!==planHash||(writer.operationId===null?writer.planHash!==null:writer.planHash!==planHash))fail('The retained plan or writer ownership changed.');
    if(run.leaseToken&&(!Number.isFinite(new Date(run.leaseExpiresAt).getTime())||new Date(run.leaseExpiresAt).getTime()>now()))fail('An active worker must finish or stop before retirement can be reviewed.');
    if(await read(models.Receipts,{environment:scope.environment,realmId:scope.realmId,operationId},session))fail('A transport receipt exists. Retain and reconcile those effects; this operation cannot be retired as unsent.');
    const rows=await models.Steps.find({environment:scope.environment,realmId:scope.realmId,operationId}).limit(1001).session(session).maxTimeMS(3000).lean();
    if(rows.length>1000||rows.some(row=>String(row.connectionId)!==scope.connectionId||row.state!=='claimed'||row.dispatch||row.receipt||row.qboId))fail('Saved or possibly sent activity cannot be retired as unsent.');
    const claims=rows.map(row=>({id:String(row._id),logicalKey:row.logicalKey,fingerprint:row.fingerprint,planHash:row.planHash,revision:row.revision,attempts:row.attempts,leaseHash:hash(row.leaseToken||null)})).sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey));
    const review={version:1,scope,operationId,planHash,runRevision:run.executionRevision,writerRevision:writer.revision,calendarWriterRevision:calendar.writerRevision,authorityHash:calendar.authorityHash,claims,noTransportReceipts:true,noAccountingRecords:true};
    return{run,calendar,writer,rows,review,reviewHash:hash(review)};
  }
  async function review(user,operationId,input) {
    if(!exact(input)||Object.keys(input).join(',')!=='planHash')fail('Choose the exact saved plan for review.');
    const bound=await bind(user,'operations.execute',true),result=await inspect(bound,operationId,input.planHash);
    return{scope:bound.scope,review:result.review,reviewHash:result.reviewHash,claimCount:result.rows.length,qboWrites:0};
  }
  async function retire(user,operationId,input) {
    if(!exact(input)||!ID.test(operationId||'')||!HASH.test(input.planHash||'')||!HASH.test(input.reviewHash||'')||Object.keys(input).sort().join(',')!=='planHash,reason,reviewHash'||typeof input.reason!=='string'||input.reason.trim().length<20||input.reason.length>2000)fail('Record the exact unsent review and a retirement reason.');
    const bound=await bind(user,'operations.execute',true),{scope,ownerId,actorId}=bound;
    return transaction(async session=>{
      await fence(bound,session,'operations.execute');
      const prior=await read(models.Runs,{_id:operationId,...scope,planHash:input.planHash,status:'retired'},session);
      if(prior){if(prior.retirement?.reviewHash!==input.reviewHash||prior.retirement.reason!==input.reason.trim())fail('This operation was retired by a different review.');return{retired:true,reused:true,operationId};}
      const current=await inspect(bound,operationId,input.planHash,session);
      if(current.reviewHash!==input.reviewHash)fail('The operation changed after its unsent review. Review it again.');
      const {run,calendar,writer,rows,review}=current,auditId=hash({retirement:input.reviewHash}).slice(0,24),retirement={version:1,reviewHash:input.reviewHash,reason:input.reason.trim(),actorId,retiredAt:new Date(now()).toISOString(),auditId};
      if(Buffer.byteLength(canonical(review))>8000000)fail('The unsent review exceeds its retained evidence budget.');
      // Claims have no external effect and are copied into the durable audit.
      // Deleting only these fenced claims frees their unique business keys for
      // a newly reviewed operation. Immutable plans/intents remain untouched.
      for(const row of rows){const removed=await models.Steps.deleteOne({_id:row._id,...scope,operationId,state:'claimed',revision:row.revision,leaseToken:row.leaseToken,dispatch:null,receipt:null},{session});if(removed.deletedCount!==1)fail('An unsent claim changed during retirement.');}
      const saved=await models.Runs.findOneAndUpdate({_id:operationId,...scope,planHash:input.planHash,status:run.status,executionRevision:run.executionRevision,writerRevision:run.writerRevision},{ $set:{status:'retired',retirement,leaseToken:null,leaseExpiresAt:null,executionRequest:run.executionRequest?{...run.executionRequest,pending:false,result:{complete:false,state:'retired'}}:null,lastError:'Retired with no QuickBooks effects; prepare a fresh reviewed operation.'},$inc:{executionRevision:1,writerRevision:1,evidenceRevision:1}},{new:true,session}).lean();
      const released=await models.Writers.findOneAndUpdate({_id:writer._id,...scope,revision:writer.revision,operationId:writer.operationId,unresolved:null},{ $set:{operationId:null,planHash:null},$inc:{revision:1}},{new:true,session}).lean();
      const cleared=await models.Calendars.findOneAndUpdate({_id:calendar._id,...scope,currentOperationId:calendar.currentOperationId,revision:calendar.revision,writerRevision:calendar.writerRevision,pendingCommit:null},{ $set:{currentOperationId:null,stopRequested:false},$inc:{writerRevision:1}},{new:true,session}).lean();
      if(!saved||!released||!cleared)fail('Operation ownership changed before retirement.');
      await models.Audits.create([{_id:auditId,userId:ownerId,actorUserId:actorId!==ownerId?actorId:undefined,realmId:scope.realmId,action:'Unsent business operation retired',actionType:'manual',outcome:'success',beforeState:review,afterState:{...scope,operationId,planHash:input.planHash,retirement,qboWrites:0,verifiedThrough:calendar.verifiedThrough}}],{session});
      return{retired:true,reused:false,operationId};
    });
  }
  return{review,retire};
}
module.exports={createBusinessOperationRetirement};
