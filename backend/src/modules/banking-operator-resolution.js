'use strict';
const {hash}=require('./banking-workspace-service');
const OPERATOR_VERSION='bf7-visible-rules-v2-bl2';
const COOLDOWN_MS=15*60*1000, MAX_AUTO_RETRIES=3;
const settled=entry=>['completed','recovered-read-only','resolved-stop'].includes(entry.status);
const stepKey=entry=>hash({packageId:entry.packageId,step:entry.step});
const check=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{code:'BANKING_RESUME_BLOCKED',status:409});};
function noNativeEffect(entry,result){
  // Only preflight is read-only in today's operator. Rules and row review write.
  const fields=['kind','version','runId','packageId','step','scope','accountId','accountCurrency','period','status','reason','companyVerified','screenshot','actionLedger','rulesInspection'];
  const attempts=Object.entries(entry).some(([key,value])=>/attempt/i.test(key) && value!==false && value!==null && value!==0 && !(Array.isArray(value) && value.length===0));
  return !attempts && result && Object.keys(result).every(k=>fields.includes(k)) && entry.step?.type==='preflight' && result?.status==='stopped' &&
    Array.isArray(result.actionLedger) && result.actionLedger.length===0 &&
    (!entry.actionLedger || Array.isArray(entry.actionLedger) && entry.actionLedger.length===0) &&
    !entry.actionsCompletedAt && !entry.nativeAttempted &&
    !['upload','rows','reconciliation','attachment','rules'].some(k=>result[k] && (!Array.isArray(result[k]) || result[k].length>0));
}
function retryPolicy(entry,runs,now){
  const attempts=runs.filter(r=>stepKey(r)===stepKey(entry)).reduce((n,r)=>n+(r.resolutions || []).filter(v=>v.mode==='automatic').length,0);
  const changed=(entry.operatorVersion || 'legacy')!==OPERATOR_VERSION;
  const retryAt=new Date(Date.parse(entry.finishedAt || entry.startedAt)+COOLDOWN_MS).toISOString();
  const eligible=noNativeEffect(entry,entry.result) && attempts<MAX_AUTO_RETRIES && (changed || Date.parse(now)>=Date.parse(retryAt));
  return {eligible,attempts,maxAttempts:MAX_AUTO_RETRIES,retryAt,operatorVersion:OPERATOR_VERSION,producedVersion:entry.operatorVersion || 'legacy',reason:attempts>=MAX_AUTO_RETRIES?'Three automatic retries used; owner resolution required':!noNativeEffect(entry,entry.result)?'Possible native effect; observed read-only inspection required':changed?'Operator contract changed; retry after process-exit verification':Date.parse(now)>=Date.parse(retryAt)?'Read-only stop cooldown elapsed; retry after process-exit verification':'Read-only stop will retry after cooldown and process-exit verification'};
}
async function assertOwner({user,scope}){
  const member=await require('../models/CompanyMembership').findOne({userId:String(user.actorId || user.id),realmId:scope.realmId}).select('role status').maxTimeMS(3000).lean();
  if(member?.status!=='active' || member.role!=='lab-owner')throw Object.assign(new Error('Only the current company owner role may resume banking'),{code:'BANKING_RESUME_FORBIDDEN',status:403});
}
async function validateInspection(artifact,entry,pkg,readArtifact,now){
  check(artifact && readArtifact,'Attach a retained observed read-only inspection result before resuming a possible native effect');
  const scopedPath=hash(entry.scope)+'/'+entry.accountId+'/';
  check(typeof artifact.path==='string' && artifact.path.startsWith(scopedPath),'Inspection must belong to this company and account');
  let value;try{value=JSON.parse((await readArtifact(artifact)).toString('utf8'));}catch{check(false,'Inspection artifact could not be verified');}
  check(value.kind==='banking-read-only-inspection' && value.version===1 && value.runId===entry.runId && value.packageId===pkg.id && hash(value.scope)===hash(entry.scope) && value.accountId===entry.accountId && value.period===entry.period,'Inspection scope/run/package mismatch');
  check(value.readOnly===true && value.strength==='screen observed' && Array.isArray(value.actionLedger) && value.actionLedger.length===0 && typeof value.summary==='string' && value.summary.trim(),'Observed read-only inspection result required');
  check(Date.parse(value.observedAt)>=Date.parse(entry.finishedAt || entry.startedAt) && Date.parse(value.observedAt)<=Date.parse(now),'Inspection must follow the stopped run');
  check(value.outcome==='no-native-effect' && Array.isArray(value.acceptedActions) && value.acceptedActions.length===0,'Accepted or uncertain native actions require exact evidence recovery before retry; never repeat upload/Add/Match');
  // A screen reference must itself exist, have the retained hash and stay scoped.
  check(value.screenshot?.path?.startsWith(scopedPath),'Retained scoped inspection screenshot required');
  await readArtifact(value.screenshot);
  return {artifact,observedAt:value.observedAt,summary:value.summary,outcome:value.outcome,screenshot:value.screenshot};
}
module.exports={OPERATOR_VERSION,COOLDOWN_MS,MAX_AUTO_RETRIES,settled,stepKey,noNativeEffect,retryPolicy,assertOwner,validateInspection};
