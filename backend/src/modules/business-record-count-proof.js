'use strict';
// Count-only evidence. This module performs no QBO/provider call and never grants
// accounting authority. Financial close success is a prerequisite to capture.
const { hash, canonical } = require('./business-calendar');
const { canonicalQboValue } = require('./qbo-semantic-compare');
const { accountingRecord } = require('./general-write-close');
const { NON_POSTING } = require('./general-write-postings');
const { createHash } = require('node:crypto');
const captures = new WeakMap(), VERSION = 1, MAX_MEMBERS = 10000, MAX_BYTES = 4000000;
const sameScope = (a,b) => ['environment','realmId','connectionId'].every(k => String(a?.[k]) === String(b?.[k]));
const scopeOf = v => ({ environment:v.environment, realmId:v.realmId, connectionId:String(v.connectionId) });
const projected = (entity, record) => canonicalQboValue(accountingRecord(entity, record), { entity, metadata:true });
const accountingHash = (entity, record) => hash(projected(entity, record));
const stamp = v => v == null ? NaN : new Date(v).getTime();
class CountUnavailable extends Error { constructor(reason) { super(reason); this.code='COUNT_PROOF_UNAVAILABLE'; } }
// Only errors from the optional local count reads pass through this classifier.
function isCountAvailability(error) {
  if(error instanceof CountUnavailable)return true;
  if([13,18].includes(error?.code)||[401,403].includes(error?.status))return false;
  return ['MongoNetworkError','MongoNetworkTimeoutError','MongoServerSelectionError','MongoNotConnectedError','MongoTopologyClosedError','MongoOperationTimeoutError'].includes(error?.name) || error?.name==='MongoServerError'&&[50,91,146,262,292,11600,11602].includes(error?.code);
}
async function countRead(read) { try{return await read();}catch(error){if(isCountAvailability(error))throw new CountUnavailable('local-count-read-unavailable');throw error;} }
function rememberGeneralCountInputs(gathered, inputs) { captures.set(gathered, inputs); return gathered; }
function reconciliationIdentity(item) { return hash(item?.reconciliation || null); }
function effectiveIdentity(run, ref, item) {
  return { runId:String(run._id), ref, entity:item.entity, qboId:String(item.qboId || run.plan?.operations?.find(op=>op.ref===ref)?.id || ''), operation:item.op,
    accountingHash:accountingHash(item.entity,item.record || null), requestHash:accountingHash(item.entity,item.request || null), reconciliationHash:reconciliationIdentity(item) };
}
function creationOrigin(run, ref, receipt) {
  const item=run.items?.[ref],op=run.plan?.operations?.find(v=>v.ref===ref);
  if (run.contract!=='general-write-v1' || !op || op.op!=='create' || item?.op!=='create' || !['saved','mismatch'].includes(item.outcome) || item.entity!==op.entity || !/^\d{1,30}$/.test(item.qboId || '')) return null;
  const batches=(run.batches||[]).filter(b=>b.state==='answered' && b.attempt===item.attempt && b.items?.some(v=>v.ref===ref));
  if (batches.length!==1) return null;
  const batch=batches[0],sent=batch.items.find(v=>v.ref===ref),bodyRows=batch.transport?.response;
  if (!receipt || !sameScope(receipt,run) || String(receipt.ownerId)!==String(run.ownerId) || String(receipt.actorId)!==String(run.actorId) || receipt.kind!=='general-write' || receipt.state!=='saved' || String(receipt._id)!==String(batch.transport?.receiptId) || receipt.general?.runId!==String(run._id) || receipt.general?.batchIndex!==batch.index || receipt.general?.requestId!==batch.requestId || !Array.isArray(bodyRows)) return null;
  let request; try { request=require('./general-write-transport').buildGeneralBatch(scopeOf(run),batch); } catch { return null; }
  if (batch.transport?.outcome!=='saved' || receipt.observed?.entity!=='batch' || receipt.observed?.operation!=='create' || !Number.isInteger(receipt.observed?.httpStatus) || receipt.observed.httpStatus<200 || receipt.observed.httpStatus>=300 || receipt.requestHash!==request.requestHash || sent.entity!==item.entity || sent.op!=='create' || sent.operation!=='create') return null;
  const savedIds=Object.fromEntries(Object.entries(run.items||{}).filter(([,row])=>['saved','mismatch'].includes(row.outcome)).map(([key,row])=>[key,row.qboId]));
  if(canonical(require('./general-write-service').resolve(op.payload,savedIds))!==canonical(sent.payload) || canonical(item.request)!==canonical(sent.payload)) return null;
  const responses=bodyRows.filter(v=>v.bId===sent.bId),proofs=(receipt.observed?.items||[]).filter(v=>v.bId===sent.bId && v.ref===ref);
  if (responses.length!==1 || proofs.length!==1 || proofs[0].outcome!=='saved') return null;
  const { bId, ...body }=responses[0],original=body[item.entity==='CreditCardPayment'?'CreditCardPaymentTxn':item.entity];
  if (!original || original.Id!==item.qboId || createHash('sha256').update(JSON.stringify(body)).digest('hex')!==proofs[0].responseHash || String(proofs[0].qboId)!==item.qboId) return null;
  const source={runId:String(run._id),ref,entity:item.entity,qboId:item.qboId,ownerId:String(run.ownerId),actorId:String(run.actorId),agentId:run.agentAuthority?.agentId || null,day:run.day,receiptId:String(receipt._id),bId:sent.bId,requestHash:request.requestHash,responseHash:proofs[0].responseHash};
  return {...source,originHash:hash(source)};
}
const unavailable = reason => ({version:VERSION,status:'unavailable',reason});
async function captureGeneralCountProof({scope,fromDate,throughDate,snapshotHash,ledgerHash,before,after,closed,Receipts,now=()=>Date.now()}) {
  if (closed?.ok!==true) throw new TypeError('Count capture requires completed financial success.');
  const first=captures.get(before),last=captures.get(after);
  if (!first || !last || !sameScope(first.scope,scope) || !sameScope(last.scope,scope)) return unavailable('native-count-inputs-unavailable');
  if (typeof Receipts?.find!=='function') return unavailable('creation-receipts-unavailable');
  if (Receipts.modelName && Receipts.db?.readyState!==1) return unavailable('local-count-storage-unavailable');
  const origins=[];
  for (const run of last.runs) if (run.day>=fromDate && run.day<=throughDate)
    for (const op of run.plan?.operations || []) if (op.op==='create' && ['saved','mismatch'].includes(run.items?.[op.ref]?.outcome)) origins.push({run,ref:op.ref});
  if (origins.length>MAX_MEMBERS) return unavailable('count-membership-budget');
  const receiptIds=[...new Set(origins.map(({run,ref})=>run.batches?.find(b=>b.state==='answered'&&b.attempt===run.items[ref].attempt&&b.items.some(i=>i.ref===ref))?.transport?.receiptId).filter(Boolean))],receipts=new Map();
  // Bounded optional local reads only. Recognized connection/deadline/capacity
  // failures become count-unknown; authentication/source/integrity failures propagate.
  for(let offset=0;offset<receiptIds.length;offset+=100){
    const ids=receiptIds.slice(offset,offset+100);let rows;
    try{rows=await countRead(()=>Receipts.find({...scope,_id:{$in:ids}}).limit(ids.length+1).maxTimeMS(3000).lean());}catch(error){if(error instanceof CountUnavailable)return unavailable(error.message);throw error;}
    if(!Array.isArray(rows)||rows.length>ids.length) return unavailable('count-receipt-enumeration');
    for(const row of rows){if(!ids.includes(String(row._id))||receipts.has(String(row._id))||!sameScope(row,scope))return unavailable('count-receipt-enumeration');receipts.set(String(row._id),row);}
  }
  const members=[],unresolved=[],seen=new Set(),covered=new Set(closed.records.map(row=>row.key));
  for(const {run,ref} of origins){
    const item=run.items[ref],batch=run.batches.find(b=>b.state==='answered'&&b.attempt===item.attempt&&b.items.some(i=>i.ref===ref)),origin=creationOrigin(run,ref,receipts.get(String(batch?.transport?.receiptId))),key=item.entity+':'+item.qboId;
    if(seen.has(key)){unresolved.push({key,reason:'duplicate-creation-origin'});continue;} seen.add(key);
    const current=last.current.get(key),previous=first.current.get(key),effective=last.effective.get(key);
    const effectiveVersion=effective?.identity || (effective?effectiveIdentity(effective.run,effective.ref,effective.item):null);
    if(!origin||!current||!previous||!effective||effective.outcome!=='saved'||current.Id!==item.qboId||accountingHash(item.entity,current)!==accountingHash(item.entity,previous)){
      unresolved.push({key,reason:!origin?'creation-origin-unavailable':'native-membership-unavailable'});continue;
    }
    // An undated nonfinancial record was already read in both native windows.
    // Its declared business fields must still match its retained governed version.
    const applicable=!NON_POSTING.has(item.entity),ledgerCovered=applicable&&covered.has(key);
    if(!covered.has(key)&&accountingHash(item.entity,current)!==effectiveVersion.accountingHash){unresolved.push({key,reason:'effective-native-version-unexplained'});continue;}
    members.push({key,origin,effective:effectiveVersion,projectionVersion:VERSION,accountingHash:accountingHash(item.entity,current),native:{syncToken:current.SyncToken,recordHash:hash(current),runRevision:effective.revision,observedAt:new Date(now()).toISOString()},readbackValidated:true,accountingApplicable:applicable,ledgerCovered});
  }
  members.sort((a,b)=>a.key.localeCompare(b.key));unresolved.sort((a,b)=>a.key.localeCompare(b.key));
  // Duplicated provenance cannot leave a counted first member behind.
  const duplicateKeys=new Set(unresolved.filter(r=>r.reason==='duplicate-creation-origin').map(r=>r.key));
  const accepted=members.filter(m=>!duplicateKeys.has(m.key));
  const payload={version:VERSION,status:unresolved.length?'partial':'current',scope:scopeOf(scope),fromDate,throughDate,snapshotHash,ledgerHash,projectionVersion:VERSION,members:accepted,unresolved,verifiedAt:new Date(now()).toISOString(),membersHash:hash({members:accepted,unresolved})};
  if(Buffer.byteLength(canonical(payload))>MAX_BYTES)return unavailable('count-membership-byte-budget');
  return {...payload,proofHash:hash(payload)};
}
function validGeneralCountProof(close,scope){
  const p=close?.countProof;if(close?.ok!==true||close.kind!=='period'||!p||p.version!==VERSION||!['current','partial'].includes(p.status)||!sameScope(close,scope)||!sameScope(p.scope,scope)||p.fromDate!==close.fromDate||p.throughDate!==close.throughDate||p.ledgerHash!==close.ledgerHash||p.snapshotHash!==close.snapshotHash||p.projectionVersion!==VERSION||!Array.isArray(p.members)||!Array.isArray(p.unresolved)||p.members.length>MAX_MEMBERS)return null;
  const {proofHash,...payload}=p;
  if(proofHash!==hash(payload)||p.membersHash!==hash({members:p.members,unresolved:p.unresolved})||new Set(p.members.map(m=>m.key)).size!==p.members.length)return null;
  return p;
}
function currentMirror({scope,agent,row,entity,id,now}){
  const source=agent?.sync?.sources?.[entity],clock=now();
  if(!sameScope(agent,scope)||!source||source.entity!==entity||source.phase!=='incremental'||source.status!=='current'||!source.generation||source.error||source.reconcileError||agent.sync?.summaryError||['attention','resyncing'].includes(agent.sync?.amountReconciliation?.status))return null;
  const anchor=stamp(source.startedAt),watermark=stamp(source.lastSuccessAt),coverage=stamp(source.mode==='cdc'?source.since:source.startedAt),cadence=Number(source.everyMs)||60000;
  if(!Number.isFinite(anchor)||!Number.isFinite(watermark)||!Number.isFinite(coverage)||anchor>watermark||coverage>watermark||watermark>clock||clock-watermark>Math.max(120000,cadence*2))return null;
  if(!row||!sameScope(row,scope)||row.entity!==entity||row.qboId!==id||row.generation!==source.generation||row.deleted||row.record?.Id!==id||row.record.sparse===true||row.record.status==='Deleted')return null;
  // Completion phase anchors the full generation; incrementals advance its source
  // watermark without touching unchanged records' observation timestamps.
  return row.record;
}
module.exports={VERSION,CountUnavailable,accountingHash,projected,effectiveIdentity,creationOrigin,rememberGeneralCountInputs,captureGeneralCountProof,validGeneralCountProof,currentMirror};

function validStepAudit(audit,scope,ownerId,step){
  const p=audit?.inputParams,d=p?.details;
  if(!audit||audit.outcome!=='success'||audit.action!=='Business operation evidence recorded'||String(audit.userId)!==String(ownerId)||!sameScope(p,scope)||!sameScope(d,scope)||d.phase!=='verify'||d.logicalKey!==step.logicalKey||d.qboId!==step.qboId||d.operationId!==String(step.operationId)||!Number.isSafeInteger(d.revision)||d.revision<1)return false;
  const eventKey='business-step:'+hash({scope:scopeOf(scope),operationId:String(step.operationId),planHash:step.planHash,logicalKey:step.logicalKey,revision:d.revision,phase:'verify'});
  return p.eventKey===eventKey&&String(audit.actorUserId||audit.userId)===d.actorId;
}
function auditBinding(audit,scope,ownerId,step,observedHash){
  const p=audit?.inputParams,d=p?.details;
  if(!audit||audit.outcome!=='success'||audit.action!=='Business operation evidence recorded'||String(audit.userId)!==String(ownerId)||!sameScope(p,scope)||!sameScope(d,scope)||d.phase!=='verify'||d.logicalKey!==step.logicalKey||d.qboId!==step.qboId||d.operationId!==String(step.operationId)||!Number.isSafeInteger(d.revision)||d.revision<1)return null;
  const eventKey='business-step:'+hash({scope:scopeOf(scope),operationId:String(step.operationId),planHash:step.planHash,logicalKey:step.logicalKey,revision:d.revision,phase:'verify'});
  if(p.eventKey!==eventKey||String(audit.actorUserId||audit.userId)!==d.actorId)return null;
  if(d.countProjectionVersion!==VERSION||d.countObservedHash!==observedHash||!/^[a-f0-9]{64}$/.test(d.countAccountingHash||''))return null;
  const payload={version:VERSION,projectionVersion:VERSION,observedHash:d.countObservedHash,accountingHash:d.countAccountingHash};
  return d.countReadbackHash===hash(payload)?payload:null;
}
function committedFixedEvidence(run,evidence,scope,ownerId,auditById){
  try{
    if(run?.status!=='verified'||!evidence||evidence.contractVersion!==1||!sameScope(evidence,scope)||evidence.operationId!==String(run._id)||evidence.planHash!==run.planHash||evidence.evidenceRevision!==run.evidenceRevision||evidence.evidenceHash!==run.verificationCandidateHash||hash(evidence.proof)!==evidence.evidenceHash)return false;
    const validation=require('./business-period-store').validatePeriodProof(run,evidence.proof,stamp(evidence.proof.observedAt)),v=run.verification;
    if(!v||!v.completionAuditId||v.operationId!==String(run._id)||v.planHash!==run.planHash||v.blueprintHash!==run.blueprintHash||v.evidenceHash!==validation.evidenceHash||v.evidenceRevision!==validation.evidenceRevision||v.recordSetHash!==validation.recordSetHash||v.observedAt!==validation.observedAt||v.throughDate!==undefined&&v.throughDate!==run.throughDate||!/^[a-f0-9]{24}$/.test(v.actorId||''))return false;
    const {sourceHash,...source}=evidence.sources||{},names=require('./business-report-source').namesFor(source.version);
    if(hash(source)!==sourceHash||!sameScope(source.scope,scope)||canonical(source.period)!==canonical({fromDate:run.fromDate,throughDate:run.throughDate})||!Array.isArray(source.accounts)||!source.reports||canonical(Object.keys(source.reports).sort())!==canonical([...names].sort())||source.observedAt!==evidence.proof.observedAt||!Number.isFinite(stamp(source.startedAt))||stamp(source.startedAt)>stamp(source.observedAt)||evidence.proof.records.some(r=>stamp(r.observedAt)>stamp(source.startedAt))||evidence.proof.assertions.some(check=>check.sourceHash!==(check.evidenceType==='record-readback'?hash(evidence.proof.records):sourceHash)))return false;
    const exactAudit=(id,eventKey,actorId,details)=>{const audit=auditById.get(String(id));return String(id)===hash({scope:scopeOf(scope),actorId,ownerId,eventKey}).slice(0,24)&&audit?.action==='Business operation evidence recorded'&&audit.actionType==='manual'&&audit.outcome==='success'&&String(audit.userId)===String(ownerId)&&audit.realmId===scope.realmId&&String(audit.actorUserId||audit.userId)===actorId&&canonical(audit.inputParams)===canonical({eventKey,...scopeOf(scope),details});};
    const observedKey='business-period-evidence:'+String(run._id)+':'+evidence.evidenceRevision,actorId=String(evidence.actorId),observedDetails={...scopeOf(scope),actorId,operationId:String(run._id),evidenceHash:evidence.evidenceHash,sourceHash,evidenceRevision:evidence.evidenceRevision,recordCount:evidence.proof.records.length};
    const committedKey='business-period:'+String(run._id)+':committed',committedDetails={...scopeOf(scope),actorId:v.actorId,action:'Business period verified',operationId:String(run._id),evidenceHash:evidence.evidenceHash,throughDate:run.throughDate};
    return exactAudit(evidence.auditId,observedKey,actorId,observedDetails)&&exactAudit(v.completionAuditId,committedKey,v.actorId,committedDetails);
  }catch{return false;}
}
const uniqueSaved = activity => Array.isArray(activity?.receipts)?new Set(activity.receipts.filter(r=>r.logicalKey).map(r=>String(r.operationId)+':'+r.logicalKey)).size:Number.isSafeInteger(activity?.saved)&&activity.saved>=0?activity.saved:0;
function unknownCounts(activity,reason,now){return{version:VERSION,cohort:'accountant-created',saved:uniqueSaved(activity),readbackValidated:0,accountingVerified:0,nonfinancial:0,readbackUnresolved:uniqueSaved(activity),accountingUnresolved:uniqueSaved(activity),status:'unknown',knownMinimum:true,reason,asOf:new Date(now()).toISOString()};}
async function readLocalProofCounts({models,scope,agentId,ownerId,day,activity,now=()=>Date.now()}){
  const required=['Agents','GeneralWriteRuns','Runs','Receipts','Steps','Evidence','GeneralDayCloses','Records','Audits'];
  if(required.some(k=>!models?.[k]||(models[k].modelName&&models[k].db?.readyState!==1)))return unknownCounts(activity,'local-count-storage-unavailable',now);
  const rows=async(Model,filter,limit=MAX_MEMBERS,select=null)=>{
    let q;await countRead(async()=>{q=Model.find(filter);if(select&&q.select)q=q.select(select);});
    const found=await countRead(()=>q.limit(limit+1).maxTimeMS(3000).lean());
    if(!Array.isArray(found)||found.length>limit)throw new CountUnavailable('count-enumeration-incomplete');
    return found;
  };
  try{
    const agent=await countRead(()=>models.Agents.findOne(scope).select('_id ownerId environment realmId connectionId sync').maxTimeMS(3000).lean());
    if(!agent||!sameScope(agent,scope)||String(agent._id)!==String(agentId)||String(agent.ownerId)!==String(ownerId))throw Object.assign(Error('Count workspace scope changed.'),{code:'COUNT_SCOPE_CHANGED',status:409});
    const generalIds=(activity?.runs||[]).filter(r=>r.hourlyActivity===true).map(r=>String(r.id)),fixedIds=(activity?.runs||[]).filter(r=>r.hourlyActivity!==true).map(r=>String(r.id));
    const general=generalIds.length?await rows(models.GeneralWriteRuns,{...scope,_id:{$in:generalIds}},generalIds.length):[];
    const fixedRuns=fixedIds.length?await rows(models.Runs,{...scope,_id:{$in:fixedIds}},fixedIds.length):[];
    const generalById=new Map(general.map(r=>[String(r._id),r])),fixedById=new Map(fixedRuns.map(r=>[String(r._id),r]));
    const batchReceiptIds=[...new Set(general.flatMap(r=>(r.batches||[]).map(b=>b.transport?.receiptId).filter(Boolean)))];
    const generalReceipts=batchReceiptIds.length?await rows(models.Receipts,{...scope,_id:{$in:batchReceiptIds}},batchReceiptIds.length):[];
    const receiptById=new Map(generalReceipts.map(r=>[String(r._id),r]));
    const fixedReceipts=fixedIds.length?await rows(models.Receipts,{...scope,operationId:{$in:fixedIds},kind:'business',operation:'create',state:'saved'}):[];
    const steps=fixedIds.length?await rows(models.Steps,{...scope,operationId:{$in:fixedIds}}):[],stepByKey=new Map(steps.map(s=>[String(s.operationId)+':'+s.logicalKey,s]));
    const nativeFixed=new Map(fixedReceipts.map(r=>[String(r.operationId)+':'+r.logicalKey,r]));
    const creates=[],duplicate=new Set(),seen=new Set();
    for(const saved of activity?.receipts||[]){
      const id=String(saved.operationId),ref=saved.logicalKey,run=generalById.get(id);
      if(run){
        if(!sameScope(run,scope)||String(run.ownerId)!==String(ownerId)||run.agentAuthority?.agentId!==agentId||run.day!==day)continue;
        const item=run.items?.[ref],batch=(run.batches||[]).find(b=>b.attempt===item?.attempt&&b.state==='answered'&&b.items.some(i=>i.ref===ref)),origin=creationOrigin(run,ref,receiptById.get(String(batch?.transport?.receiptId)));
        if(!origin)continue;
        const key=origin.entity+':'+origin.qboId;if(seen.has(key)){duplicate.add(key);continue;}seen.add(key);creates.push({kind:'general',key,origin,run,item,ref});
      }else{
        const fixed=fixedById.get(id),step=stepByKey.get(id+':'+ref),receipt=nativeFixed.get(id+':'+ref);
        if(!fixed||fixed.agentAuthority?.agentId!==agentId||fixed.activityBatch?.day!==day||String(fixed.agentAuthority?.ownerId)!==String(ownerId)||!step||step.kind==='general-calendar-fulfillment'||!receipt||!sameScope(receipt,scope)||String(receipt.ownerId)!==String(ownerId)||receipt.dispatchKey!==step.dispatch?.key||receipt.requestHash!==step.dispatch?.requestHash||receipt.observed?.qboId!==step.qboId||step.receipt?.qboId!==step.qboId)continue;
        const key=step.entity+':'+step.qboId;if(seen.has(key)){duplicate.add(key);continue;}seen.add(key);creates.push({kind:'fixed',key,step,run:fixed,receipt});
      }
    }
    const keys=creates.map(r=>r.key),keySet=new Set(keys),lookup=keys.map(k=>{const at=k.indexOf(':');return{entity:k.slice(0,at),qboId:k.slice(at+1)};});
    const mirrors=lookup.length?await rows(models.Records,{...scope,$or:lookup},lookup.length):[],mirrorByKey=new Map(mirrors.map(r=>[r.entity+':'+r.qboId,r]));
    const pendingReceipts=keys.length?await rows(models.Receipts,{...scope,state:{$in:['possibly-sent','unknown']}},1000):[],uncertain=new Set();
    for(const receipt of pendingReceipts){
      if(receipt.observed?.qboId){const entity=lookup.find(r=>r.entity.toLowerCase()===receipt.entity)?.entity;if(entity)uncertain.add(entity+':'+receipt.observed.qboId);}
      for(const item of receipt.general?.items||[])if(item.id)uncertain.add(item.entity+':'+item.id);
      const evidence=[receipt.periodProof?.evidence,...(receipt.periodProof?.proofs||[]).map(p=>p.evidence)];
      for(const e of evidence)for(const record of e?.records||[])if(record.entity&&record.id)uncertain.add(record.entity+':'+record.id);
    }
    const effectiveRows=keys.length?await rows(models.GeneralWriteRuns,{...scope,$or:[{'owned.key':{$in:keys}},{'dirty.0':{$exists:true}}]}):[];
    const effective=new Map();
    for(const run of effectiveRows)for(const [ref,item]of Object.entries(run.items||{})){
      const key=item.entity+':'+item.qboId;if(!keySet.has(key)||!['saved','mismatch','deleted'].includes(item.outcome))continue;
      const raw=(item.op==='delete'?item.request?.SyncToken:item.record?.SyncToken)??-1;
      if(!/^-?\d+$/.test(String(raw)))throw new CountUnavailable('effective-version-unavailable');
      const version=BigInt(raw),old=effective.get(key);
      if(!old||version>old.version||version===old.version&&item.outcome==='deleted')effective.set(key,{version,identity:effectiveIdentity(run,ref,item),deleted:item.outcome==='deleted',outcome:item.outcome});
    }
    const closes=await rows(models.GeneralDayCloses,{...scope,kind:'period',fromDate:{$lte:day},throughDate:{$gte:day}},1000);
    const latest=new Map();for(const row of closes){const k=row.fromDate+':'+row.throughDate;if(!latest.has(k)||stamp(row.verifiedAt)>stamp(latest.get(k).verifiedAt))latest.set(k,row);}
    const generalMembers=new Map();for(const row of latest.values()){const proof=validGeneralCountProof(row,scope);if(!proof)continue;for(const member of proof.members)if(member.origin.day===day){if(generalMembers.has(member.key)){generalMembers.set(member.key,null);continue;}generalMembers.set(member.key,{member,close:row});}}
    const evidence=fixedIds.length?await rows(models.Evidence,{...scope,operationId:{$in:fixedIds}}):[];
    const evidenceByRun=new Map();for(const e of evidence){const r=fixedById.get(String(e.operationId));if(r?.status==='verified'&&e.evidenceRevision===r.evidenceRevision&&e.evidenceHash===r.verificationCandidateHash&&e.evidenceHash===r.verification?.evidenceHash&&hash(e.proof)===e.evidenceHash&&e.proof?.complete===true&&e.planHash===r.planHash)evidenceByRun.set(String(e.operationId),e);}
    const auditIds=[...new Set([...steps.map(s=>s.lastAuditId),...fixedRuns.map(r=>r.verification?.completionAuditId),...evidence.flatMap(e=>[e.auditId,...(e.proof?.records||[]).map(r=>r.auditId)])].filter(Boolean).map(String))];
    const audits=auditIds.length?await rows(models.Audits,{_id:{$in:auditIds},realmId:scope.realmId,userId:ownerId},auditIds.length):[],auditById=new Map(audits.map(a=>[String(a._id),a]));
    let readbackValidated=0,accountingVerified=0,nonfinancial=0;
    const dirtyFor=proof=>effectiveRows.some(r=>(r.dirty||[]).some(d=>typeof d.date==='string'&&d.date<=proof.throughDate));
    const failedFor=proof=>[...latest.values()].some(r=>!r.ok&&r.fromDate<=proof.throughDate&&r.throughDate>=proof.fromDate);
    for(const create of creates){
      if(duplicate.has(create.key)||uncertain.has(create.key))continue;
      const at=create.key.indexOf(':'),entity=create.key.slice(0,at),id=create.key.slice(at+1),record=currentMirror({scope,agent,row:mirrorByKey.get(create.key),entity,id,now}),applicable=!NON_POSTING.has(entity);
      if(!applicable)nonfinancial++;
      if(!record)continue;
      const currentHash=accountingHash(entity,record);
      if(create.kind==='general'){
        const accepted=generalMembers.get(create.key),latestItem=effective.get(create.key);
        if(!accepted||accepted.member.origin.originHash!==create.origin.originHash||!latestItem||latestItem.deleted||latestItem.outcome!=='saved'||canonical(latestItem.identity)!==canonical(accepted.member.effective)||currentHash!==accepted.member.accountingHash)continue;
        readbackValidated++;
        if(applicable&&accepted.member.ledgerCovered&&!dirtyFor(accepted.close)&&!failedFor(accepted.close))accountingVerified++;
      }else{
        const s=create.step,v=s.verification;
        if(s.state!=='verified'||v?.kind!=='business-readback'||v.compilationHash!==s.dispatch?.compilationHash||!s.lastAuditId)continue;
        const audit=auditById.get(String(s.lastAuditId));if(!validStepAudit(audit,scope,ownerId,s))continue;
        const metadata=auditBinding(audit,scope,ownerId,s,v.observedHash),storedCount=v.countReadback;
        if(storedCount||audit.inputParams.details.countReadbackHash){
          const {proofHash,...payload}=storedCount||{};
          if(!storedCount||storedCount.version!==VERSION||storedCount.projectionVersion!==VERSION||storedCount.observedHash!==v.observedHash||proofHash!==hash(payload)||proofHash!==audit.inputParams.details.countReadbackHash)continue;
        }
        const unchangedRaw=hash(record)===v.observedHash;
        if(metadata?metadata.accountingHash!==currentHash:!unchangedRaw)continue;
        readbackValidated++;
        const e=evidenceByRun.get(String(create.run._id));if(!committedFixedEvidence(create.run,e,scope,ownerId,auditById))continue;
        const member=e?.proof?.records?.find(r=>r.logicalKey===s.logicalKey&&r.entity===s.entity&&r.qboId===s.qboId&&r.fingerprint===s.fingerprint&&!r.fulfillment);
        const periodAudit=auditById.get(String(e?.auditId)),periodDetails=periodAudit?.inputParams?.details;
        if(!applicable||!member||!e.auditId||periodAudit?.outcome!=='success'||String(periodAudit.userId)!==String(ownerId)||!sameScope(periodAudit.inputParams,scope)||periodDetails?.operationId!==String(e.operationId)||periodDetails?.evidenceHash!==e.evidenceHash)continue;
        const originalAudit=auditById.get(String(member.auditId));if(!validStepAudit(originalAudit,scope,ownerId,s))continue;
        const originalProjection=auditBinding(originalAudit,scope,ownerId,s,member.observedHash);
        const currentMember=originalProjection?originalProjection.accountingHash===currentHash:hash(record)===member.observedHash;
        if(currentMember&&!dirtyFor(e.proof)&&!failedFor(e.proof))accountingVerified++;
      }
    }
    const saved=uniqueSaved(activity),readbackUnresolved=Math.max(0,saved-readbackValidated),accountingUnresolved=Math.max(0,saved-nonfinancial-accountingVerified);
    return{version:VERSION,cohort:'accountant-created',saved,readbackValidated,accountingVerified,nonfinancial,readbackUnresolved,accountingUnresolved,status:readbackUnresolved||accountingUnresolved?'partial':'current',knownMinimum:true,asOf:new Date(now()).toISOString(),note:'Save-response checks are not independent readback; nonfinancial lists are not ledger-verified.'};
  }catch(error){if(error instanceof CountUnavailable)return unknownCounts(activity,error.message,now);throw error;}
}
module.exports.validStepAudit=validStepAudit;module.exports.auditBinding=auditBinding;module.exports.readLocalProofCounts=readLocalProofCounts;module.exports.unknownCounts=unknownCounts;

module.exports.isCountAvailability=isCountAvailability;
module.exports.committedFixedEvidence=committedFixedEvidence;
