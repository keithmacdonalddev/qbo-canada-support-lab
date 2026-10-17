'use strict';
const {hash,canonical}=require('./business-calendar');
const {PLAN,RECOVERY_PLAN,assertPlan,repairRequest,fail,equal}=require('./business-link-repair-contract');
const read=(Model,filter,session)=>Model.findOne(filter).session(session).maxTimeMS(3000).lean();
// Recognize only the empty objects lost in the observed legacy serialization.
// Never normalize monetary, identity, relationship or arbitrary hash changes.
function minimizedSource(original,stored,path=''){
 if(original&&Object.getPrototypeOf(original)===Object.prototype&&Object.keys(original).length===0&&stored===undefined){
  if(!/^(before\.(invoice|estimate)\.record\.Line\.\d+\.SubTotalLineDetail|parentLedgers\.\d+\.report\.Rows)$/.test(path))fail('The authority differs outside the evidenced empty-object loss.');return [path];
 }
 if(equal(original,stored))return [];
 if(!original||!stored||typeof original!=='object'||typeof stored!=='object'||Array.isArray(original)!==Array.isArray(stored))fail('The malformed authority has an unrelated content change.');
 if(Object.keys(stored).some(k=>!Object.hasOwn(original,k)))fail('The malformed authority contains unapproved source fields.');
 return Object.keys(original).flatMap(k=>minimizedSource(original[k],stored[k],path?path+'.'+k:k));
}
async function assertRecoverySource({models,scope,plan,session,clock=Date.now()}){
 if(plan.kind!==RECOVERY_PLAN)return null;
 const {Authorities,Audits,Receipts}=models,original=JSON.parse(plan.recovery.originalPlanJson);assertPlan(original,clock);
 const originalHash=hash(original),old=await read(Authorities,{...scope,contentHash:originalHash},session);
 if(!old||old.contractVersion!==1||String(old._id)!==hash({scope,kind:PLAN,logicalKey:plan.logicalKey}).slice(0,24)||String(old.actorId)!==plan.ownerId||old.contentHash!==plan.recovery.originalAuthorityHash||hash(old.payload)===old.contentHash||!minimizedSource(original,old.payload).length)fail('Only the exact originally audited empty-object serialization loss can be superseded.');
 if(original.ownerId!==plan.ownerId||!equal(original.scope,scope)||original.operationId!==plan.operationId||original.planHash!==plan.planHash||original.logicalKey!==plan.logicalKey||original.publishedAuthorityHash!==plan.publishedAuthorityHash||!equal(original.identities,plan.identities)||!equal(original.state,plan.state)||!equal(repairRequest(original),repairRequest(plan))||!['invoice','estimate','time','customer'].every(k=>original.before[k].recordHash===plan.before[k].recordHash&&equal(original.before[k].record,plan.before[k].record)))fail('The recovery expands the original target, unchanged request, operation or saved records.');
 const audit=await read(Audits,{_id:old.auditId,userId:plan.ownerId,realmId:scope.realmId,action:'Owned business Invoice link repair approved',actionType:'manual',outcome:'success'},session);
 if(!audit||!equal(audit.afterState,{authorityHash:originalHash,operationId:original.operationId,logicalKey:original.logicalKey,requestHash:repairRequest(original).requestHash}))fail('The original exact approval audit is unavailable.');
 const dispatchKey=hash({version:1,kind:'business-link-repair',authorityHash:originalHash}),receiptId=hash({scope,dispatchKey});
 if(await read(Receipts,{_id:receiptId,...scope},session)||await read(Receipts,{...scope,'workflow.kind':'business-link-repair','workflow.authorityHash':originalHash},session))fail('Any original transport admission forbids this source-only recovery.');
 require('./business-link-repair').assertReportSources(original,original.reports,plan.reports,Date.parse(plan.reviewedAt),false,plan.parentLedgers);
 return {originalAuthorityHash:originalHash,originalAuditId:String(old.auditId),lostEmptyPaths:minimizedSource(original,old.payload),originalTransportReceiptAbsent:true};
}
module.exports={assertRecoverySource,minimizedSource};
