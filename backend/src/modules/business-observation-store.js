'use strict';
// Private, company-scoped observations. A mirror hit never advances a CDC cursor.
const { createHash } = require('node:crypto');
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const QID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const stamp = value => value == null ? NaN : new Date(value).getTime();
const sameScope = (a,b) => ['environment','realmId','connectionId'].every(key => String(a?.[key]) === String(b?.[key]));
function createBusinessObservationStore({ Records, Agents, Receipts, Writers, Audits, session = null, now = () => Date.now() } = {}) {
  const query = (Model, filter) => { const read = Model.findOne(filter); return (session ? read.session(session) : read).maxTimeMS(3000).lean(); };
  function models() {
    // Importing this helper in an isolated test must not buffer database work.
    if (!Records && require('mongoose').connection.readyState !== 1) return null;
    return { Records: Records || require('../models/CompanySyncRecord'), Agents: Agents || require('../models/BusinessAgent'), Receipts: Receipts || require('../models/QboWriteReceipt'), Writers: Writers || require('../models/CompanyWriter'), Audits: Audits || require('../models/AuditLog') };
  }
  async function source(scope, entity) {
    const db = models(); if (!db) return null;
    const agent = await query(db.Agents, scope), row = agent?.sync?.sources?.[entity], clock = now();
    if (!agent || !sameScope(agent,scope) || !row || row.entity !== entity || row.status !== 'current' || row.phase !== 'incremental' || !row.generation || row.error || row.reconcileError || agent.sync?.summaryError || ['attention','resyncing'].includes(agent.sync?.amountReconciliation?.status)) return null;
    const completed = stamp(row.lastSuccessAt), cadence = Number.isSafeInteger(row.everyMs) && row.everyMs >= 1000 ? row.everyMs : 60000;
    if (!Number.isFinite(completed) || completed > clock || clock-completed > Math.max(120000,cadence*2)) return null;
    return { db, row };
  }
  function observation(scope, entity, record, observedAt, provenance) {
    let text; try { text=canonical(record); } catch { return null; }
    if (Buffer.byteLength(text)>256000 || !record || typeof record.Id!=='string' || !QID.test(record.Id) || typeof record.SyncToken!=='string' || !VERSION.test(record.SyncToken) || record.sparse !== undefined && record.sparse !== false || record.status === 'Deleted') return null;
    const copied=JSON.parse(text), recordHash=hash(copied);
    return { scope, entity, record:copied, recordHash, observedAt, source:{version:1,scope,entity,id:record.Id,recordHash,...provenance} };
  }
  async function affectingWrite(db, scope, entity, id, after) {
    // Period proof includes transitive linked parents. A child's save invalidates
    // their old balances/backlinks even when their own SyncToken did not change.
    return query(db.Receipts,{...scope,sentAt:{$gte:new Date(after)},$or:[
      {entity:entity.toLowerCase(),'observed.qboId':id},
      {entity:entity.toLowerCase(),'state':{$in:['possibly-sent','unknown']}},
      {'periodProof.evidence.records':{$elemMatch:{entity,id}}},
      {'periodProof.proofs.evidence.records':{$elemMatch:{entity,id}}}
    ]});
  }
  async function read(scope, entity, id, { transactions=false, signal }={}) {
    scope=scoped(scope); signal?.throwIfAborted();
    if (!QID.test(id||'')) return null;
    const current=await source(scope,entity); if (!current) return null;
    const {db,row}=current, stored=await query(db.Records,{...scope,entity,qboId:id,deleted:false}); signal?.throwIfAborted();
    if (!stored || !sameScope(stored,scope) || stored.entity!==entity || stored.qboId!==id || stored.deleted || stored.generation!==row.generation || stored.record?.Id!==id) return null;
    // since is a conservative CDC coverage boundary (request start minus overlap),
    // not completion time. Snapshot sources need their actual read start instead.
    const coverage = row.mode==='cdc' ? stamp(row.since) : stamp(row.startedAt);
    if (!Number.isFinite(coverage)) return null;
    if (transactions ? await affectingWrite(db,scope,entity,id,coverage) : await query(db.Receipts,{...scope,entity:entity.toLowerCase(),sentAt:{$gte:new Date(coverage)},$or:[{'observed.qboId':id},{state:{$in:['possibly-sent','unknown']}}]})) return null;
    const observedAt=new Date(now()).toISOString();
    const result=observation(scope,entity,stored.record,observedAt,{kind:'qbo-current-mirror',generation:row.generation,completedAt:new Date(row.lastSuccessAt).toISOString(),freshUntil:new Date(stamp(row.lastSuccessAt)+Math.max(120000,(Number.isSafeInteger(row.everyMs)?row.everyMs:60000)*2)).toISOString(),coverageAt:Number.isFinite(coverage)?new Date(coverage).toISOString():null});
    const after=await source(scope,entity); signal?.throwIfAborted();
    if (!after || canonical(after.row)!==canonical(row)) return null;
    return result;
  }
  async function saved(scope, entity, id, { signal }={}) {
    scope=scoped(scope); const db=models(); if (!db) return null; signal?.throwIfAborted();
    const receipt=await db.Receipts.findOne({...scope,entity:entity.toLowerCase(),operation:{$in:['create','update']},state:'saved','observed.qboId':id}).select('+savedResponse').sort({observedAt:-1}).maxTimeMS(3000).lean();
    if (!receipt || !sameScope(receipt,scope) || !['business','legacy','master-preparation','business-link-repair'].includes(receipt.kind) || receipt.observed?.outcome!=='saved' || receipt.observed?.qboId!==id || receipt.observed?.entity!==entity.toLowerCase() || receipt.observed?.operation!==receipt.operation || receipt.observed?.httpStatus<200 || receipt.observed?.httpStatus>299) return null;
    const time=stamp(receipt.observedAt), clock=now(), payload=receipt.savedResponse;
    if (!Number.isFinite(time) || time>clock || clock-time>300000 || !payload || createHash('sha256').update(JSON.stringify(payload)).digest('hex')!==receipt.observed.responseHash || Object.keys(payload).some(key=>![entity,'time'].includes(key)) || payload[entity]?.Id!==id || payload[entity]?.SyncToken!==receipt.observed.syncToken) return null;
    const receiptId=hash({scope,dispatchKey:receipt.dispatchKey});
    if (!/^[a-f0-9]{64}$/.test(receipt.dispatchKey||'') || !/^[a-f0-9]{64}$/.test(receipt.requestHash||'') || !/^[a-f0-9]{24}$/.test(String(receipt.ownerId||'')) || !/^[a-f0-9]{24}$/.test(String(receipt.actorId||'')) || receipt._id!==receiptId || String(receipt.resultAuditId)!==hash({receiptId,event:'response',observed:receipt.observed}).slice(0,24) || String(receipt.startAuditId)!==hash({receiptId,event:'started'}).slice(0,24)) return null;
    const mirrored=await query(db.Records,{...scope,entity,qboId:id});
    if (mirrored && (mirrored.deleted || mirrored.record?.status==='Deleted' || stamp(mirrored.lastObservedAt)>=time && hash(mirrored.record)!==hash(payload[entity]))) return null;
    const params={environment:scope.environment,connectionId:scope.connectionId,dispatchKey:receipt.dispatchKey,requestHash:receipt.requestHash,entity:receipt.entity,operation:receipt.operation};
    for(const [auditId,action,outcome,afterState] of [[receipt.startAuditId,'QuickBooks write dispatch recorded','partial',{state:'possibly-sent',receiptId}],[receipt.resultAuditId,'QuickBooks write response recorded','success',{state:'saved',receiptId,...receipt.observed}]]) {
      const audit=await query(db.Audits,{_id:auditId,realmId:scope.realmId});
      if(!audit || String(audit.userId)!==String(receipt.ownerId) || String(audit.actorUserId||audit.userId)!==String(receipt.actorId) || audit.action!==action || audit.actionType!=='manual' || audit.outcome!==outcome || canonical(audit.inputParams)!==canonical(params) || canonical(audit.afterState)!==canonical(afterState))return null;
    }
    const conflict=await query(db.Receipts,{...scope,_id:{$ne:receiptId},sentAt:{$gte:new Date(receipt.sentAt)},$or:[{entity:entity.toLowerCase(),'observed.qboId':id},{entity:entity.toLowerCase(),state:{$in:['possibly-sent','unknown']}},{'periodProof.evidence.records':{$elemMatch:{entity,id}}},{'periodProof.proofs.evidence.records':{$elemMatch:{entity,id}}}]});
    if (conflict) return null; signal?.throwIfAborted();
    return observation(scope,entity,payload[entity],new Date(time).toISOString(),{kind:'qbo-write-response',receiptId,requestHash:receipt.requestHash,responseHash:receipt.observed.responseHash});
  }
  async function retain(scope, entity, record, observedAt) {
    scope=scoped(scope); const current=await source(scope,entity); if (!current) return false;
    const {db,row}=current, at=stamp(observedAt); if (!Number.isFinite(at) || at>now() || !observation(scope,entity,record,new Date(at).toISOString(),{})) return false;
    const existing=await query(db.Records,{...scope,entity,qboId:record.Id});
    if (existing && (!VERSION.test(existing.record?.SyncToken||'') || BigInt(existing.record.SyncToken)>BigInt(record.SyncToken) || stamp(existing.lastReadStartedAt)>at)) return false;
    const filter={...scope,entity,qboId:record.Id,...(existing?{lastReadStartedAt:existing.lastReadStartedAt,'record.SyncToken':existing.record.SyncToken}:{_id:createHash('sha256').update(JSON.stringify({...scope,entity,qboId:record.Id})).digest('hex')})};
    await db.Records.updateOne(filter,{$set:{record:JSON.parse(canonical(record)),generation:row.generation,deleted:false,lastReadStartedAt:new Date(at),lastObservedAt:new Date(at),changedAt:Number.isFinite(stamp(record.MetaData?.LastUpdatedTime))?new Date(record.MetaData.LastUpdatedTime):null,summary:require('./business-agent-sync').recordSummary(entity,record,'CAD')},$setOnInsert:{version:1,...scope,entity,qboId:record.Id}}, {upsert:!existing,maxTimeMS:3000});
    return true;
  }
  return {read,saved,retain};
}
async function readBusinessTaxRecord(client,entity,id) {
 const {QBOClient}=require('./qbo-client');
 if(client instanceof QBOClient && client.read===QBOClient.prototype.read && client.apiCall===QBOClient.prototype.apiCall && client.connection?.status==='active') {
  const environment=client.apiBase==='https://quickbooks.api.intuit.com/v3/company/'+client.realmId?'production':client.apiBase==='https://sandbox-quickbooks.api.intuit.com/v3/company/'+client.realmId?'sandbox':null;
  if(environment) { const scope=scoped({environment,realmId:String(client.realmId),connectionId:String(client.connection?._id)});
   try { const observed=await createBusinessObservationStore().read(scope,entity,id);if(observed)return {[entity]:observed.record}; } catch { /* A stale/unavailable mirror needs a complete scoped GET. */ }
  }
 }
 return require('./qbo-request-meter').runWithCaller('business-tax-policy',()=>client.read(entity.toLowerCase(),id));
}
module.exports={createBusinessObservationStore,readBusinessTaxRecord};
