'use strict';
// Private, company-scoped observations. A mirror hit never advances a CDC cursor.
const { createHash } = require('node:crypto');
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const QID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const stamp = value => value == null ? NaN : new Date(value).getTime();
const sameScope = (a,b) => ['environment','realmId','connectionId'].every(key => String(a?.[key]) === String(b?.[key]));
function createBusinessObservationStore({ Records, Agents, Receipts, Writers, Audits, Steps, Authorities, session = null, now = () => Date.now() } = {}) {
  const query = (Model, filter) => { const read = Model.findOne(filter); return (session ? read.session(session) : read).maxTimeMS(3000).lean(); };
  function models() {
    // Importing this helper in an isolated test must not buffer database work.
    if (!Records && require('mongoose').connection.readyState !== 1) return null;
    return { Records: Records || require('../models/CompanySyncRecord'), Agents: Agents || require('../models/BusinessAgent'), Receipts: Receipts || require('../models/QboWriteReceipt'), Writers: Writers || require('../models/CompanyWriter'), Audits: Audits || require('../models/AuditLog'), Steps: Steps || require('../models/OperationStep'), Authorities: Authorities || require('../models/BusinessAuthority') };
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
      {entity:{$in:[entity.toLowerCase(),'batch']},'state':{$in:['possibly-sent','unknown']}},
      {'periodProof.evidence.records':{$elemMatch:{entity,id}}},
      {'periodProof.proofs.evidence.records':{$elemMatch:{entity,id}}}
    ]});
  }
  async function read(scope, entity, id, { transactions=false, guard=false, signal }={}) {
    scope=scoped(scope); signal?.throwIfAborted();
    if (!QID.test(id||'')) return null;
    const current=await source(scope,entity); if (!current) return null;
    const {db,row}=current, stored=await query(db.Records,{...scope,entity,qboId:id,deleted:false}); signal?.throwIfAborted();
    if (!stored || !sameScope(stored,scope) || stored.entity!==entity || stored.qboId!==id || stored.deleted || stored.generation!==row.generation || stored.record?.Id!==id) return null;
    // since is a conservative CDC coverage boundary (request start minus overlap),
    // not completion time. Snapshot sources need their actual read start instead.
    const coverage = row.mode==='cdc' ? stamp(row.since) : stamp(row.startedAt);
    if (!Number.isFinite(coverage) || guard && (coverage > stamp(row.lastSuccessAt) || coverage > now())) return null;
    if (guard) {
      if (row.mode !== 'cdc') return null;
      const changed = stamp(stored.record.MetaData?.LastUpdatedTime ?? stored.changedAt);
      if (!Number.isFinite(changed) || changed >= coverage) return null;
      // Batch receipts do not retain per-item targets here. Any recent batch is
      // conservatively a miss; stock quantities can change through a sale/bill
      // without the Item appearing in the protected-period link graph.
      const affectedEntities = entity === 'Item' ? ['batch','item','invoice','salesreceipt','creditmemo','refundreceipt','bill','purchase','vendorcredit','inventoryadjustment'] : [entity.toLowerCase(),'batch'];
      if (await query(db.Receipts, { ...scope, entity: { $in: affectedEntities }, $or: [{ state: { $in: ['possibly-sent','unknown'] } }, { sentAt: { $gte: new Date(coverage) } }, { observedAt: { $gte: new Date(coverage) } }] })) return null;
    }
    if (guard && await query(db.Receipts, { ...scope, $or: [{ 'periodProof.evidence.records': { $elemMatch: { entity, id } } }, { 'periodProof.proofs.evidence.records': { $elemMatch: { entity, id } } }], $and: [{ $or: [{ state: { $in: ['possibly-sent','unknown'] } }, { sentAt: { $gte: new Date(coverage) } }, { observedAt: { $gte: new Date(coverage) } }] }] })) return null;
    // Tax definitions cannot be changed by a general batch. Its unresolved transaction
    // outcome must not erase a current tax snapshot; explicit tax writes still invalidate it.
    const transactional = transactions && !['TaxCode', 'TaxRate'].includes(entity);
    if (transactional ? await affectingWrite(db,scope,entity,id,coverage) : await query(db.Receipts,{...scope,entity:entity.toLowerCase(),sentAt:{$gte:new Date(coverage)},$or:[{'observed.qboId':id},{state:{$in:['possibly-sent','unknown']}}]})) return null;
    const observedAt=new Date(now()).toISOString();
    const result=observation(scope,entity,stored.record,observedAt,{kind:'qbo-current-mirror',generation:row.generation,completedAt:new Date(row.lastSuccessAt).toISOString(),freshUntil:new Date(stamp(row.lastSuccessAt)+Math.max(120000,(Number.isSafeInteger(row.everyMs)?row.everyMs:60000)*2)).toISOString(),coverageAt:Number.isFinite(coverage)?new Date(coverage).toISOString():null});
    const after=await source(scope,entity); signal?.throwIfAborted();
    if (!after || canonical(after.row)!==canonical(row)) return null;
    return result;
  }
  // Historical master evidence only. Never a current record/cache hit: an exact
  // approved versioned hash must authenticate it in the reference verifier. Sync status,
  // age and later writes do not change that historical definition.
  async function definition(scope, entity, id, { signal }={}) {
    scope=scoped(scope); signal?.throwIfAborted();
    if (!['Item','TaxCode','Customer','Vendor'].includes(entity) || !QID.test(id||'')) return null;
    const db=models(); if (!db) return null;
    const stored=await query(db.Records,{...scope,entity,qboId:id,deleted:false}); signal?.throwIfAborted();
    const time=stamp(stored?.lastObservedAt);
    if (!stored || !sameScope(stored,scope) || stored.entity!==entity || stored.qboId!==id || stored.deleted || stored.record?.Id!==id || typeof stored.generation!=='string' || !stored.generation || !Number.isFinite(time) || time>now()) return null;
    const retainedAt=new Date(time).toISOString();
    return observation(scope,entity,stored.record,retainedAt,{kind:'qbo-retained-mirror',generation:stored.generation,retainedAt});
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
  // Complete Deposit set for the absence-of-link guard. Unlike advisory choices,
  // this requires the exact generation/count and a CDC boundary after both the
  // payment observation and every included record's last provider change.
  async function deposits(scope, after, { signal } = {}) {
    scope = scoped(scope); signal?.throwIfAborted();
    const current = await source(scope, 'Deposit'); if (!current) return null;
    const { db, row } = current, coverage = stamp(row.since), boundary = stamp(after);
    if (row.mode !== 'cdc' || !Number.isFinite(coverage) || !Number.isFinite(boundary) || coverage <= boundary || coverage > stamp(row.lastSuccessAt) || coverage > now() || !Number.isSafeInteger(row.count) || row.count < 0 || row.count > 10000) return null;
    const pending = () => query(db.Receipts, { ...scope, entity: { $in: ['deposit','batch'] }, $or: [{ state: { $in: ['possibly-sent','unknown'] } }, { sentAt: { $gte: new Date(coverage) } }, { observedAt: { $gte: new Date(coverage) } }] });
    if (await pending()) return null;
    const rows = await db.Records.find({ ...scope, entity: 'Deposit', deleted: false }).sort({ qboId: 1 }).limit(10001).maxTimeMS(5000).lean();
    if (rows.length !== row.count) return null;
    const records = [], ids = new Set(); let bytes = 0;
    for (const stored of rows) {
      const changed = stamp(stored.record?.MetaData?.LastUpdatedTime ?? stored.changedAt);
      if (!sameScope(stored, scope) || stored.entity !== 'Deposit' || stored.deleted || stored.generation !== row.generation || stored.qboId !== stored.record?.Id || ids.has(stored.qboId) || !Number.isFinite(changed) || changed >= coverage) return null;
      const observed = observation(scope, 'Deposit', stored.record, new Date(now()).toISOString(), {});
      if (!observed || (bytes += Buffer.byteLength(canonical(observed.record))) > 32000000) return null;
      records.push(observed.record); ids.add(stored.qboId);
    }
    const final = await source(scope, 'Deposit'); signal?.throwIfAborted();
    if (!final || canonical(final.row) !== canonical(row) || await pending()) return null;
    return records;
  }
  // Read observations may survive verification bookkeeping, never transport or
  // newly synchronized evidence. Unfinished sends are unsafe regardless of age.
  async function unchanged(scope, after, { signal } = {}) {
    scope = scoped(scope); signal?.throwIfAborted();
    const db = models(), at = stamp(after);
    if (!db || !Number.isFinite(at) || at > now() || now() - at > 60000) return false;
    const receipt = await query(db.Receipts, { ...scope, $or: [{ sentAt: { $gte: new Date(at) } }, { observedAt: { $gte: new Date(at) } }] });
    if (receipt) return false;
    const unresolved = await db.Receipts.find({ ...scope, state: { $in: ['possibly-sent','unknown'] } }).limit(101).maxTimeMS(3000).lean();
    if (unresolved.length > 100) return false;
    for (const row of unresolved) {
      // An old lost reply remains state=unknown after audited owner attribution.
      // Authenticate that existing terminal settlement contract, never the mere
      // presence of its pointer, before treating it as finished transport.
      if (row.state !== 'unknown' || !row.ownerRecovery || !db.Steps || !db.Authorities) return false;
      const step = await query(db.Steps, { ...scope, operationId: row.operationId, logicalKey: row.logicalKey });
      if (!step || step.receipt?.source !== 'owner-attributed-readback' || step.dispatch?.key !== row.dispatchKey) return false;
      try {
        const attribution = await require('./business-owner-attribution').assertOwnerAttribution(db, scope, step, session);
        if (attribution?.payload?.receiptId !== row._id || canonical(row.ownerRecovery) !== canonical({ version: 1, authorityHash: attribution.authority.contentHash, auditId: String(attribution.authority.auditId), qboId: attribution.payload.qboId, reviewHash: attribution.payload.reviewHash })) return false;
      }
      catch { signal?.throwIfAborted(); return false; }
    }
    const changed = await query(db.Records, { ...scope, lastObservedAt: { $gte: new Date(at) } });
    signal?.throwIfAborted(); return !receipt && !changed;
  }
  return {read,definition,saved,retain,deposits,unchanged};
}
async function readBusinessTaxRecord(client,entity,id,{ signal, live = false, store = createBusinessObservationStore() } = {}) {
 signal?.throwIfAborted();
 const {QBOClient}=require('./qbo-client');
 if(client instanceof QBOClient && client.read===QBOClient.prototype.read && client.apiCall===QBOClient.prototype.apiCall && client.connection?.status==='active') {
  const environment=client.apiBase==='https://quickbooks.api.intuit.com/v3/company/'+client.realmId?'production':client.apiBase==='https://sandbox-quickbooks.api.intuit.com/v3/company/'+client.realmId?'sandbox':null;
  if(environment && String(client.connection?.realmId) === String(client.realmId)) { const scope=scoped({environment,realmId:String(client.realmId),connectionId:String(client.connection?._id)});
   try { const observed=!live && await store.read(scope,entity,id,{signal});signal?.throwIfAborted();if(observed)return {[entity]:observed.record}; } catch { signal?.throwIfAborted(); /* A stale/unavailable mirror needs a complete scoped GET. */ }
  }
 }
 return require('./qbo-request-meter').runWithCaller('business-tax-policy',()=>client.read(entity.toLowerCase(),id));
}
async function readBusinessGuardRecord(client, entity, id, { signal, store = createBusinessObservationStore() } = {}) {
 const {QBOClient}=require('./qbo-client');
 if (!(client instanceof QBOClient) || client.read !== QBOClient.prototype.read || client.apiCall !== QBOClient.prototype.apiCall || client.connection?.status !== 'active') return null;
 const environment=client.apiBase==='https://quickbooks.api.intuit.com/v3/company/'+client.realmId?'production':client.apiBase==='https://sandbox-quickbooks.api.intuit.com/v3/company/'+client.realmId?'sandbox':null;
 if (!environment || String(client.connection?.realmId) !== String(client.realmId)) return null;
 const scope=scoped({environment,realmId:String(client.realmId),connectionId:String(client.connection?._id)});
 try { return await store.read(scope,entity,id,{transactions:true,guard:true,signal}); }
 catch { signal?.throwIfAborted(); return null; }
}
module.exports={createBusinessObservationStore,readBusinessTaxRecord,readBusinessGuardRecord};
