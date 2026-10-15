'use strict';
const { hash, canonical } = require('./business-calendar');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
const ACTION = 'Uncertain business creation attributed by owner';
const SOURCE = 'owner-attributed-readback';
const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_OWNER_ATTRIBUTION_UNVERIFIED' }); }
const same = (a,b) => String(a) === String(b);
const iso = value => { const stamp = new Date(value).getTime(); return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null; };
async function terminalUnknown(models, scope, step, row, session) {
  const d = step.dispatch, receiptId = d && hash({ scope, dispatchKey: d.key });
  if (!d || !HASH.test(d.key || '') || !HASH.test(d.requestHash || '') || !row || row._id !== receiptId || row.contractVersion !== 1 || !same(row.connectionId, scope.connectionId) || row.environment !== scope.environment || row.realmId !== scope.realmId || row.kind !== 'business' || row.operation !== 'create' || row.entity !== step.entity.toLowerCase() || !same(row.operationId, step.operationId) || row.logicalKey !== step.logicalKey || row.dispatchKey !== d?.key || row.requestHash !== d?.requestHash || !same(row.actorId,d?.actorId) || !ID.test(String(row.ownerId)) || row.state !== 'unknown' || row.observed?.outcome !== 'unknown' || row.observed.entity !== row.entity || row.observed.operation !== 'create') fail('The exact original terminal unknown transport receipt is required. An unfinished request cannot be attributed or retried.');
  const sentAt = iso(row.sentAt), endedAt = iso(row.observedAt), observed = row.observed;
  if (!sentAt || !endedAt || endedAt < sentAt) fail('The local transport has no retained completion observation.');
  const startId = hash({ receiptId, event: 'started' }).slice(0,24), resultId = hash({ receiptId, event: 'response', observed }).slice(0,24);
  if (!same(row.startAuditId,startId) || !same(row.resultAuditId,resultId)) fail('The original transport audit identity changed.');
  const params = { environment:scope.environment, connectionId:scope.connectionId, dispatchKey:d.key, requestHash:d.requestHash, entity:row.entity, operation:'create' };
  for (const expected of [
    { id:startId, action:'QuickBooks write dispatch recorded', afterState:{state:'possibly-sent',receiptId} },
    { id:resultId, action:observed.transportFailure === true ? 'QuickBooks write transport failure recorded' : 'QuickBooks write response recorded', afterState:{state:'unknown',receiptId,...observed} },
  ]) {
    const audit = await read(models.Audits,{_id:expected.id,realmId:scope.realmId},session);
    if (!audit || !same(audit.userId,row.ownerId) || !same(audit.actorUserId || audit.userId,row.actorId) || audit.action !== expected.action || audit.actionType !== 'manual' || audit.outcome !== 'partial' || canonical(audit.inputParams) !== canonical(params) || canonical(audit.afterState) !== canonical(expected.afterState)) fail('The original unknown-attempt audit is unavailable.');
  }
  const payload = {version:1,scope,receiptId,dispatchKey:d.key,requestHash:d.requestHash,kind:observed.transportFailure === true ? 'sdk-failure' : 'http-response',endedAt,observedHash:hash(observed)}, contentHash=hash(payload);
  // Old audited resolved responses predate the separate terminal fact. A thrown
  // SDK call must always have the new durable terminal observation.
  if (row.terminal || observed.transportFailure === true) {
    const auditId=hash({terminalHash:contentHash}).slice(0,24), expected={...payload,contentHash};
    if (canonical(row.terminal) !== canonical({...expected,auditId})) fail('The transport completion proof changed.');
    const audit=await read(models.Audits,{_id:auditId,realmId:scope.realmId,userId:row.ownerId,action:'QuickBooks write attempt ended without a confirmed outcome',outcome:'partial'},session);
    if (!audit || canonical(audit.afterState)!==canonical(expected)) fail('The transport completion audit is unavailable.');
  }
  return {...payload,contentHash,sentAt};
}
function attributionReceipt(payload, authorityHash, auditId) {
  return {version:1,dispatchKey:payload.dispatchKey,requestHash:payload.requestHash,qboId:payload.qboId,syncToken:payload.syncToken,source:SOURCE,ownerAttribution:{version:1,authorityHash,auditId},evidenceHash:hash({kind:SOURCE,authorityHash,auditId})};
}
function attributionAudit(payload, authorityHash) {
  return {...payload.scope,operationId:payload.operationId,planHash:payload.planHash,logicalKey:payload.logicalKey,receiptId:payload.receiptId,dispatchKey:payload.dispatchKey,qboId:payload.qboId,reviewHash:payload.reviewHash,authorityHash,provenance:SOURCE,qboWrites:0};
}
async function assertOwnerAttribution(models,scope,step,session) {
  if (step.receipt?.source !== SOURCE) return null;
  const pointer=step.receipt.ownerAttribution;
  if (!pointer || pointer.version!==1 || !HASH.test(pointer.authorityHash || '') || !ID.test(String(pointer.auditId || '')) || !models.Authorities || !models.Receipts || !models.Audits) fail('Owner-attributed creation evidence is unavailable.');
  const authority=await read(models.Authorities,{...scope,contentHash:pointer.authorityHash},session),p=authority?.payload;
  if (!p || p.version!==1 || p.kind!=='owner-attributed-business-creation' || authority.contractVersion!==1 || hash(p)!==authority.contentHash || !same(authority.actorId,p.ownerId) || !same(authority.auditId,pointer.auditId) || canonical(p.scope)!==canonical(scope) || p.operationId!==String(step.operationId) || p.planHash!==step.planHash || p.logicalKey!==step.logicalKey || p.entity!==step.entity || p.dispatchKey!==step.dispatch?.key || p.requestHash!==step.dispatch?.requestHash || p.qboId!==step.qboId || p.reviewHash!==hash(p.review) || p.recordHash!==hash(p.record) || p.record?.Id!==p.qboId || p.record?.SyncToken!==p.syncToken || p.review.ownerId!==p.ownerId || p.review.operationId!==p.operationId || p.review.planHash!==p.planHash || p.review.logicalKey!==p.logicalKey || p.review.qboId!==p.qboId || p.review.terminalHash!==p.terminalHash || p.review.candidate?.recordHash!==p.recordHash || p.content?.matchesIntent!==true || p.content.kind!=='business-content' || p.content.compilationHash!==step.dispatch?.compilationHash || p.content.logicalKey!==step.logicalKey || p.content.entity!==step.entity || p.content.qboId!==p.qboId || p.content.observedHash!==p.recordHash || p.confirmOwnership!==true || typeof p.reason!=='string' || p.reason.length<30 || canonical(step.receipt)!==canonical(attributionReceipt(p,authority.contentHash,String(authority.auditId)))) fail('The retained owner attribution differs from the original activity.');
  const decisionKey=hash({scope,ownerId:p.ownerId,operationId:p.operationId,planHash:p.planHash,logicalKey:p.logicalKey,qboId:p.qboId,reviewHash:p.reviewHash,reason:p.reason,confirmOwnership:true});
  if(p.decisionKey!==decisionKey || String(authority.auditId)!==decisionKey.slice(0,24)) fail('The exact owner confirmation identity changed.');
  const row=await read(models.Receipts,{_id:p.receiptId,...scope},session),terminal=await terminalUnknown(models,scope,step,row,session);
  if (terminal.contentHash!==p.terminalHash || canonical(row.ownerRecovery)!==canonical({version:1,authorityHash:authority.contentHash,auditId:String(authority.auditId),qboId:p.qboId,reviewHash:p.reviewHash})) fail('The original unknown receipt no longer names this owner decision.');
  const audit=await read(models.Audits,{_id:authority.auditId,userId:p.ownerId,realmId:scope.realmId,action:ACTION,actionType:'manual',outcome:'success'},session);
  if (!audit || canonical(audit.beforeState)!==canonical(p.review) || canonical(audit.afterState)!==canonical(attributionAudit(p,authority.contentHash))) fail('The exact owner-attribution audit is unavailable.');
  return {authority,payload:p};
}
module.exports={SOURCE,ACTION,terminalUnknown,attributionReceipt,attributionAudit,assertOwnerAttribution};
