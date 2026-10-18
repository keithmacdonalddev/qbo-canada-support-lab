'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped, freezeWriteRequest } = require('./qbo-write-contract');
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/, QID = /^\d{1,30}$/;
const PLAN = 'business-link-repair-plan', RECOVERY_PLAN = 'business-link-repair-recovery-plan', OUTCOME = 'business-link-repair-outcome', NO_EFFECT = 'business-link-repair-no-effect', REVERSE_PLAN = 'business-estimate-link-repair-plan';
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_LINK_REPAIR_UNVERIFIED' }); }
const equal = (a,b) => canonical(a) === canonical(b);
const fresh = (stamp, now) => typeof stamp === 'string' && Number.isFinite(Date.parse(stamp)) && new Date(stamp).toISOString() === stamp && Date.parse(stamp) <= now && now - Date.parse(stamp) <= 300000;
function observation(value, scope, entity, id, now) {
  if (!value || !equal(value.scope, scope) || value.entity !== entity || value.record?.Id !== id || !QID.test(id || '') || !/^(0|[1-9]\d{0,63})$/.test(value.record.SyncToken || '') || value.recordHash !== hash(value.record) || !fresh(value.observedAt, now)) fail('Fresh unchanged exact repair observations are required.');
  return value.record;
}
function headerLinks(value) {
  if(!Array.isArray(value)||value.length>10)fail('Exact bounded header relationships are required.');
  return value.map(link=>{if(!link||Object.keys(link).some(k=>!['TxnId','TxnType','TxnLineId'].includes(k))||!QID.test(link.TxnId||'')||!['Estimate','TimeActivity','Invoice'].includes(link.TxnType)||![undefined,'0'].includes(link.TxnLineId))fail('An unexpected header relationship or line target is present.');return {TxnId:link.TxnId,TxnType:link.TxnType};}).sort((a,b)=>(a.TxnType+':'+a.TxnId).localeCompare(b.TxnType+':'+b.TxnId));
}
function creationIdentity(step) {
  return { logicalKey: step.logicalKey, entity: step.entity, qboId: step.qboId, fingerprint: step.fingerprint, compilationHash: step.compilation?.compilationHash, compilation: hash(step.compilation), dispatch: hash(step.dispatch), receipt: hash(step.receipt) };
}
function repairRequest(plan) {
  const invoice = plan.before.invoice.record;
  if(plan.kind===REVERSE_PLAN)return freezeWriteRequest(plan.scope,'POST','estimate',{Id:plan.before.estimate.record.Id,SyncToken:plan.before.estimate.record.SyncToken,sparse:true,LinkedTxn:[{TxnId:invoice.Id,TxnType:'Invoice'}]});
  return freezeWriteRequest(plan.scope, 'POST', 'invoice', { Id: invoice.Id, SyncToken: invoice.SyncToken, sparse: true, LinkedTxn: plan.links });
}
function assertPlan(p, now, requireFresh = false) {
  if (!p || p.version !== 1 || ![PLAN,RECOVERY_PLAN,REVERSE_PLAN].includes(p.kind) || !ID.test(p.ownerId || '') || !ID.test(p.operationId || '') || !HASH.test(p.planHash || '') || !HASH.test(p.logicalKey || '') || !HASH.test(p.publishedAuthorityHash || '') || !fresh(p.reviewedAt, requireFresh ? now : Date.parse(p.reviewedAt)) || typeof p.reason !== 'string' || p.reason.length < 30 || p.reason.length > 2000 || !Array.isArray(p.identities) || p.identities.length < 3 || p.identities.length > 500 || new Set(p.identities.map(x=>x.logicalKey)).size !== p.identities.length || !p.state || !p.before || !Array.isArray(p.links) || p.links.length !== 2) fail('An exact reviewed owned-link repair plan is required.');
  if(p.kind===RECOVERY_PLAN){
    if(p.recovery?.version!==1||!HASH.test(p.recovery.originalAuthorityHash||'')||typeof p.recovery.originalPlanJson!=='string'||Buffer.byteLength(p.recovery.originalPlanJson)>8000000)fail('An exact original malformed source is required for recovery.');
    const original=JSON.parse(p.recovery.originalPlanJson);if(original.kind!==PLAN||hash(original)!==p.recovery.originalAuthorityHash)fail('The recovered source differs from the original audited plan hash.');
    assertPlan(original,Date.parse(original.reviewedAt));
  }
  if(p.kind===REVERSE_PLAN&&(!p.reverse||p.reverse.version!==1||!HASH.test(p.reverse.unsuccessfulOutcomeHash||'')))fail('A separately verified unsuccessful original repair is required before exact reverse-link review.');
  const scope = scoped(p.scope); if (!equal(scope,p.scope)) fail('The repair scope changed.');
  for (const identity of p.identities) if (!HASH.test(identity.logicalKey || '') || !QID.test(identity.qboId || '') || !['fingerprint','compilationHash','compilation','dispatch','receipt'].every(k=>HASH.test(identity[k] || ''))) fail('Original accepted creation evidence is incomplete.');
  const step=p.originalStep, request=require('./business-readback').validateCompilation(step?.compilation), original=JSON.parse(request.body);
  if (step.entity!=='Invoice' || step.logicalKey!==p.logicalKey || String(step.operationId)!==p.operationId || step.planHash!==p.planHash || step.compilation.logicalKey!==p.logicalKey || step.dispatch?.requestHash!==request.requestHash || step.dispatch.compilationHash!==step.compilation.compilationHash || step.receipt?.requestHash!==request.requestHash || step.receipt.qboId!==step.qboId || !equal(creationIdentity(step),p.identities.find(x=>x.logicalKey===p.logicalKey))) fail('The target is not an original accepted Invoice in this operation.');
  const origins=step.compilation.relationships, estimate=origins.filter(x=>x.entity==='Estimate'), time=origins.filter(x=>x.entity==='TimeActivity');
  if(origins.length!==2 || estimate.length!==1 || time.length!==1 || origins.some(x=>x.kind!=='linked') || !equal(p.links,[{TxnId:estimate[0].qboId,TxnType:'Estimate'},{TxnId:time[0].qboId,TxnType:'TimeActivity'}])) fail('Only the exact original Estimate and TimeActivity links can be repaired.');
  for(const origin of origins) {
    const own=p.identities.filter(x=>x.logicalKey===origin.logicalKey&&x.entity===origin.entity&&x.qboId===origin.qboId&&x.fingerprint===origin.fingerprint);
    if(own.length!==1)fail('Both original source parents must be accepted creations in this exact same operation.');
  }
  const stamp=requireFresh?now:Date.parse(p.reviewedAt), invoice=observation(p.before.invoice,scope,'Invoice',step.qboId,stamp), source=observation(p.before.estimate,scope,'Estimate',estimate[0].qboId,stamp), work=observation(p.before.time,scope,'TimeActivity',time[0].qboId,stamp), customer=observation(p.before.customer,scope,'Customer',invoice.CustomerRef?.value,stamp);
  if(!equal(invoice.LinkedTxn,[{TxnId:time[0].qboId,TxnType:'TimeActivity'}]) || source.LinkedTxn!==undefined || !['Pending','Accepted'].includes(source.TxnStatus) || work.BillableStatus!=='HasBeenBilled' || work.LinkedTxn!==undefined || customer.Active!==true || !equal(invoice.CustomerRef,source.CustomerRef) || work.CustomerRef?.value!==invoice.CustomerRef?.value || invoice.CurrencyRef?.value!=='CAD' || original.CustomerRef?.value!==customer.Id || invoice.TxnDate!==original.TxnDate || invoice.Balance!==invoice.TotalAmt || invoice.HomeBalance!==invoice.HomeTotalAmt || invoice.Line?.some(x=>x.LinkedTxn!==undefined)) fail('The exact unconverted owned service chain changed before repair.');
  if(p.kind===REVERSE_PLAN&&!equal(p.reverse.targetIdentity,p.identities.find(x=>x.entity==='Estimate'&&x.qboId===source.Id)))fail('The distinct Estimate target must retain its exact original creation identity.');
  const requestAfter=repairRequest(p); if(requestAfter.operation!=='update' || requestAfter.targetId!==(p.kind===REVERSE_PLAN?source.Id:invoice.Id)) fail('The repair must update the same saved invoice.');
  return p;
}
function withoutChanges(record,entity) {
  const clone=structuredClone(record); delete clone.SyncToken;
  // Only provider-maintained causal metadata is allowed to change. CreateTime,
  // names, addresses, notes, dimensions, tax and every financial field remain exact.
  if (clone.MetaData) { delete clone.MetaData.LastUpdatedTime; delete clone.MetaData.LastModifiedByRef; }
  if(entity==='Invoice') delete clone.LinkedTxn;
  if(entity==='Estimate') { delete clone.LinkedTxn; delete clone.TxnStatus; }
  return clone;
}
function assertChangedMetadata(before,after,entity) {
  if(!equal(withoutChanges(before,entity),withoutChanges(after,entity))) fail('The repair changed a field outside its exact causal allowlist.');
  if(!after.MetaData || typeof after.MetaData.LastUpdatedTime!=='string' || !Number.isFinite(Date.parse(after.MetaData.LastUpdatedTime)) || Date.parse(after.MetaData.LastUpdatedTime)<Date.parse(before.MetaData.LastUpdatedTime)) fail('The repair metadata is invalid.');
  const modifier=after.MetaData.LastModifiedByRef;
  if(modifier!==undefined && (!modifier || Object.keys(modifier).some(k=>k!=='value') || typeof modifier.value!=='string' || !QID.test(modifier.value))) fail('The repair modifier metadata has an unsupported shape.');
  if(!/^(0|[1-9]\d{0,63})$/.test(after.SyncToken || '') || BigInt(after.SyncToken)<BigInt(before.SyncToken)) fail('The repaired record version moved backwards.');
}
function assertRepairReadback(plan,after,now=Date.now()) {
  assertPlan(plan,now); const before=plan.before, scope=plan.scope;
  for(const [key,entity]of Object.entries({invoice:'Invoice',estimate:'Estimate',time:'TimeActivity',customer:'Customer'})) observation(after[key],scope,entity,before[key].record.Id,now);
  const invoice=after.invoice.record,estimate=after.estimate.record;
  assertChangedMetadata(before.invoice.record,invoice,'Invoice'); assertChangedMetadata(before.estimate.record,estimate,'Estimate');
  if((plan.kind===REVERSE_PLAN?BigInt(estimate.SyncToken)!==BigInt(before.estimate.record.SyncToken)+1n:invoice.SyncToken===before.invoice.record.SyncToken) || !equal(headerLinks(invoice.LinkedTxn),headerLinks(plan.links)) || !equal(headerLinks(estimate.LinkedTxn),[{TxnId:invoice.Id,TxnType:'Invoice'}]) || estimate.TxnStatus!=='Closed') fail('The full Estimate conversion and both original header links must actually exist.');
  if(!equal(before.time.record,after.time.record) || !equal(before.customer.record,after.customer.record)) fail('The repair changed its time or customer record.');
  return {version:1,kind:'owned-link-repair-record-invariants',scope,logicalKey:plan.logicalKey,beforeHash:hash(before),afterHash:hash(after),unchangedAccounting:true,actualHeaderLinks:true,actualEstimateBacklink:true};
}
function assertNoEffectReadback(plan,after,receipt,now=Date.now()) {
  assertPlan(plan,now);const before=plan.before,scope=plan.scope,target=plan.kind===REVERSE_PLAN?'estimate':'invoice';
  for(const [key,entity]of Object.entries({invoice:'Invoice',estimate:'Estimate',time:'TimeActivity',customer:'Customer'}))observation(after[key],scope,entity,before[key].record.Id,now);
  const old=before[target].record,actual=after[target].record,strip=record=>{const value=structuredClone(record);delete value.SyncToken;if(value.MetaData)delete value.MetaData.LastUpdatedTime;return value;};
  assertChangedMetadata(old,actual,target==='invoice'?'Invoice':'Estimate');
  if(!equal(strip(old),strip(actual))||BigInt(actual.SyncToken)!==BigInt(old.SyncToken)+1n||receipt?.observed?.syncToken!==actual.SyncToken)fail('The saved unsuccessful update must preserve every original field and link outside its single accepted version and update timestamp.');
  for(const key of ['invoice','estimate','time','customer'].filter(key=>key!==target))if(!equal(before[key].record,after[key].record))fail('The unsuccessful update changed another original record.');
  return {version:1,kind:'owned-link-repair-no-effect-invariants',scope,logicalKey:plan.logicalKey,beforeHash:hash(before),afterHash:hash(after),unchangedAccounting:true,linkVerified:false,originalMissingLinkPreserved:true};
}
function assertReadFence(value) {
  if(value?.unresolved===null && value.quarantinedRepair===undefined) return value;
  const q=value?.quarantinedRepair,u=value?.unresolved;
  if(q?.kind==='known-saved-population-link-repair-batch'){if(q.version!==1||!HASH.test(q.authorityHash||'')||!HASH.test(q.bulkAuthorityHash||'')||!HASH.test(q.receiptId||'')||!HASH.test(q.receiptEvidenceHash||'')||!HASH.test(q.requestHash||'')||!HASH.test(q.dispatchKey||'')||q.operationId!==value.operationId||!Array.isArray(q.invoiceIds)||q.invoiceIds.length<1||q.invoiceIds.length>30||q.invoiceIds.some(id=>!QID.test(id))||new Set(q.invoiceIds).size!==q.invoiceIds.length||u?.kind!=='population-link-repair'||u.entity!=='batch'||u.authorityHash!==q.authorityHash||u.bulkAuthorityHash!==q.bulkAuthorityHash||u.key!==q.dispatchKey||u.requestHash!==q.requestHash||u.transportConsumed?.receiptId!==q.receiptId||u.responseReceiptId!==q.receiptId)fail('Only the exact native known-saved population repair batch may be inspected under its retained barrier.');return value;}
  if(q?.kind==='known-observed-ui-link-correction'){if(q.version!==1||!HASH.test(q.authorityHash||'')||!HASH.test(q.actionId||'')||!HASH.test(q.actionEvidenceHash||'')||!QID.test(q.qboId||'')||q.operationId!==value.operationId||u?.kind!=='business-ui-link-correction'||u.authorityHash!==q.authorityHash||u.actionId!==q.actionId||u.lastEventHash!==q.actionEvidenceHash||q.receiptId!==undefined||q.receiptEvidenceHash!==undefined)fail('Only the exact known-observed browser conversion may be inspected under its UI barrier.');return value;}

  if(!q || q.version!==1 || q.kind!=='known-saved-link-repair' || !HASH.test(q.authorityHash || '') || !HASH.test(q.receiptId || '') || !HASH.test(q.receiptEvidenceHash || '') || !HASH.test(q.requestHash || '') || !HASH.test(q.dispatchKey || '') || !QID.test(q.qboId || '') || q.operationId!==value.operationId || u?.kind!=='business-link-repair' || u.authorityHash!==q.authorityHash || u.key!==q.dispatchKey || u.requestHash!==q.requestHash || u.transportConsumed?.receiptId!==q.receiptId || u.responseReceiptId!==q.receiptId) fail('Only the exact known-saved repair may be inspected while its barrier is held.');
  return value;
}
module.exports={PLAN,RECOVERY_PLAN,REVERSE_PLAN,OUTCOME,NO_EFFECT,assertNoEffectReadback,fail,equal,fresh,observation,headerLinks,creationIdentity,repairRequest,assertPlan,assertRepairReadback,assertReadFence};
