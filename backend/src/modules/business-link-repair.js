'use strict';
const { hash, canonical } = require('./business-calendar');
const { assertRun, assertRunApproval } = require('./business-period-store');
const { businessTransportEvidence, assertBusinessTransportAudits } = require('./business-dispatch-receipt');
const { PLAN, RECOVERY_PLAN, OUTCOME, NO_EFFECT, assertNoEffectReadback, fail, equal, fresh, creationIdentity, repairRequest, assertPlan, assertRepairReadback } = require('./business-link-repair-contract');
const ACTION = 'Owned business Invoice link repair approved', VERIFIED = 'Owned business Invoice link repair verified', NO_EFFECT_ACTION = 'Owned business Invoice link repair saved without effect';
const read=(Model,filter,session)=>Model.findOne(filter).session(session).maxTimeMS(3000).lean();
const plain=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>String(a)===String(b);
const dispatchKeyFor=authorityHash=>hash({version:1,kind:'business-link-repair',authorityHash});
const approvalState=(p,authorityHash)=>({authorityHash,operationId:p.operationId,logicalKey:p.logicalKey,requestHash:repairRequest(p).requestHash});
function stateSignature(run,calendar,writer) {
 return {run:{planHash:run.planHash,authorityHash:run.authorityHash,status:run.status,nextOrdinal:run.nextOrdinal,writerRevision:run.writerRevision,evidenceRevision:run.evidenceRevision,executionRevision:run.executionRevision,executionRequestHash:hash(run.executionRequest),approvalHash:hash(run.approval)},calendar:{revision:calendar.revision,writerRevision:calendar.writerRevision,authorityHash:calendar.authorityHash,blueprintHash:calendar.blueprintHash,verifiedThrough:calendar.verifiedThrough,baselineHash:calendar.baseline?.evidenceHash},writer:{revision:writer.revision,operationId:String(writer.operationId),planHash:writer.planHash}};
}
async function acceptedSteps(Steps,scope,operationId,session) {
 const all=[];let last=null,bytes=0;
 for(;;){
  const filter={...scope,operationId,...(last?{logicalKey:{$gt:last}}:{})};
  const cursor=Steps.find(filter,null,{singleBatch:true,batchSize:100}).sort({logicalKey:1}).session(session).limit(100).maxTimeMS(3000).lean().cursor({batchSize:100});let count=0;
  try {for(;;){const row=await cursor.next();if(!row)break;if(all.length>=500||! /^[a-f0-9]{64}$/.test(row.logicalKey||'')||(last&&row.logicalKey<=last)||!['saved','verified'].includes(row.state))fail('The operation has an unresolved, ambiguous or oversized record set.');last=row.logicalKey;count++;bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>8000000)fail('Owned record evidence exceeds its budget.');all.push(plain(row));}}
  finally{await cursor.close();}
  if(count===0)break;
 }
 return all;
}
const sourceFreshClock=(a,b,plan,now,admission)=>a===b&&!admission?Date.parse(plan.reviewedAt):now;
function assertReportSources(plan,before,after,now,admission=false,afterParentLedgers=plan.parentLedgers||[]) {
 if(!Array.isArray(before)||!Array.isArray(after)||before.length!==2||after.length!==2)fail('Both original month-end and current-date all-account observations are required.');
 const {evaluateReportSources}=require('./book-evidence'),{accountCoverage}=require('./business-link-repair-balances');
 const results=[];
 for(let i=0;i<2;i++){
  const b=before[i],a=after[i];
  for(const source of [b,a]){const {sourceHash,evaluation,...raw}=source||{};if(source?.version!==3||hash(raw)!==sourceHash||!equal(source.scope,plan.scope)||!fresh(source.observedAt,source===b&&!admission?Date.parse(plan.reviewedAt):now)||evaluateReportSources(source).status!=='checks-passed')fail('Complete fresh scoped critical report sources are required.');}
  if(!equal(b.period,a.period)||b.period.fromDate!==(i===0?plan.period.fromDate:plan.currentDate.slice(0,4)+'-01-01')||b.period.throughDate!==(i===0?plan.period.throughDate:plan.currentDate)||!equal(b.accounts,a.accounts))fail('Repair report scopes or complete account definitions changed.');
  const opening=accountCoverage(b,plan.parentLedgers||[],plan.currentDate,admission?now:Date.parse(plan.reviewedAt)),closing=accountCoverage(a,afterParentLedgers,plan.currentDate,sourceFreshClock(a,b,plan,now,admission));
  if(!equal(opening.directBalances,closing.directBalances)||!equal(opening.basis,closing.basis))fail('An account balance or reported/omitted coverage changed during the link-only repair.');
  results.push({period:b.period,beforeSourceHash:b.sourceHash,afterSourceHash:a.sourceHash,accountCount:b.accounts.length,allAccountDeltaCents:0,accountBasis:opening.basis,omittedParentDirectPostings:{before:opening.omittedParents,after:closing.omittedParents},parentRollupBalancesAsserted:false});
 }
 return results;
}

function assertRepairGraph(p,after,graph,writerFence,rows,now,policyHashes){
 if(!graph||graph.version!==1||!equal(graph.scope,p.scope)||!equal(graph.roots,[p.logicalKey])||graph.complete!==true||graph.persisted!==false||graph.recordCount!==3||!Array.isArray(graph.records)||graph.records.length!==3||!Array.isArray(graph.failures)||graph.failures.length||!equal(graph.order,graph.records.map(x=>x.logicalKey))||!equal(graph.writerFence,writerFence)||Buffer.byteLength(JSON.stringify(graph))>8000000||graph.evidenceHash!==hash({graph:hash({scope:graph.scope,roots:graph.roots,records:graph.records,failures:graph.failures}),writerFence:graph.writerFence}))fail('The exact complete graph manifest changed.');
 const origins=p.originalStep.compilation.relationships,keys=new Set([p.logicalKey,...origins.map(x=>x.logicalKey)]),seen=new Set(),retained=[];
 if(keys.size!==3)fail('The original three-record graph is ambiguous.');
 for(const record of graph.records){
  const row=rows.find(x=>x.logicalKey===record.logicalKey),identity=p.identities.find(x=>x.logicalKey===record.logicalKey),observed=Object.values(after).find(x=>x.entity===record.entity&&x.record.Id===record.qboId);
  if(!keys.has(record.logicalKey)||seen.has(record.logicalKey)||!row||!identity||!observed||record.entity!==identity.entity||record.qboId!==identity.qboId||record.fingerprint!==identity.fingerprint||record.compilationHash!==identity.compilationHash||record.stepRevision!==row.revision||!Number.isSafeInteger(row.revision)||row.revision<1)fail('A graph record differs from its exact original accepted identity or revision.');
  require('./business-step-store').validateReadback(record.proof,row,now);
  if(record.proof.observedHash!==observed.recordHash||record.proof.syncToken!==observed.record.SyncToken)fail('Graph proof differs from the direct unchanged financial record.');
  for(const parent of record.proof.relationships){const origin=rows.find(x=>x.logicalKey===parent.logicalKey),parentObserved=origin&&Object.values(after).find(x=>x.entity===origin.entity&&x.record.Id===origin.qboId);if(!seen.has(parent.logicalKey)||!row.dependencies.some(x=>x.logicalKey===parent.logicalKey&&x.entity===parent.entity)||!origin||parent.entity!==origin.entity||parent.qboId!==origin.qboId||parent.syncToken!==parentObserved?.record.SyncToken)fail('The complete graph parent closure changed.');}
  seen.add(record.logicalKey);retained.push({...p.scope,logicalKey:row.logicalKey,entity:row.entity,qboId:row.qboId,fingerprint:row.fingerprint,revision:row.revision,dependencies:row.dependencies,dispatch:{compilationHash:row.dispatch.compilationHash}});
 }
 const entries=JSON.parse(graph.sourcesJson || 'null');
 if(!Array.isArray(entries)||entries.length!==3||hash(graph.sourcesJson)!==graph.sourcesHash)fail('Complete native graph source observations are required.');
 for(const entry of entries){
  const identity=p.identities.find(x=>x.logicalKey===entry.step?.logicalKey),actual=Object.values(after).find(x=>x.entity===entry.step?.entity&&x.record.Id===entry.step?.qboId);
  if(!identity||!equal(creationIdentity(entry.step),identity)||!actual||!equal(entry.observed?.record,actual.record)||entry.observed.recordHash!==actual.recordHash||hash(entry.taxPolicy)!==policyHashes?.[entry.step.logicalKey])fail('Native graph source content, original ownership or approved policy changed.');
  if(entry.observed.estimateConversion){const marker=entry.observed.estimateConversion.source?.lineage;if(marker?.authorityHash!==writerFence.quarantinedRepair?.authorityHash||marker.receiptId!==writerFence.quarantinedRepair?.receiptId||marker.compilationHash!==p.originalStep.compilation.compilationHash||marker.creationReceiptHash!==p.originalStep.receipt.evidenceHash||marker.receiptEvidenceHash!==writerFence.quarantinedRepair?.receiptEvidenceHash)fail('The native compatibility proof lacks this exact retained repair lineage.');}
 }
 const regenerated=require('./business-graph-readback').reconcileBusinessGraph({scope:p.scope,roots:[p.logicalKey],entries,now});
 if(!regenerated.complete||regenerated.evidenceHash!==hash({scope:graph.scope,roots:graph.roots,records:graph.records,failures:graph.failures})||!equal(regenerated.records,graph.records)||!equal(regenerated.order,graph.order))fail('The native content and relationship proofs do not reproduce from retained source observations.');
 return retained;
}

function createBusinessLinkRepair({models,transaction,assertReady,access,assertBusinessAuthority,loadTaxPolicy,now=()=>Date.now()}) {
 const {Runs,Calendars,Writers,Steps,Receipts,Authorities,Audits}=models||{};
 if([Runs,Calendars,Writers,Steps,Receipts,Authorities,Audits].some(x=>!x)||[transaction,assertReady,access?.authorize,assertBusinessAuthority,loadTaxPolicy].some(x=>typeof x!=='function'))throw new TypeError('Owned link repair requires explicit native storage and authority adapters');
 async function state(scope,operationId,session,expectedRepair=null,fence=false){
  await assertReady();const actor=await access.authorize(scope,'operations.execute',{session});if(actor.actorId!==actor.ownerId)fail('Only the current company owner can repair this same-build record.');
  const run=await read(Runs,{_id:operationId,...scope},session);assertRun(run,scope);assertRunApproval(run);
  const calendar=await read(Calendars,{...scope,currentOperationId:operationId},session),writer=await read(Writers,{...scope},session);
  if(!run||run.status!=='blocked'||run.leaseToken||run.leaseExpiresAt||run.executionRequest?.pending!==false||!calendar||calendar.stopRequested||calendar.pendingCommit!==null||!same(calendar.currentOperationId,operationId)||calendar.authorityHash!==run.authorityHash||calendar.blueprintHash!==run.blueprintHash||calendar.revision!==run.expectedRevision||calendar.verifiedThrough!==run.expectedCursor||calendar.baseline?.status!=='verified'||calendar.baseline.evidenceHash!==run.baselineHash||!writer||!same(writer.operationId,operationId)||writer.planHash!==run.planHash||(expectedRepair?writer.unresolved?.authorityHash!==expectedRepair:writer.unresolved!==null))fail('Only the exact blocked, idle, settled original operation can own a link repair.');
  await assertBusinessAuthority({scope,run,session,fence});
  if(await read(Receipts,{environment:scope.environment,realmId:scope.realmId,state:{$in:['possibly-sent','unknown']}},session))fail('Any unresolved company transport prevents repair.');
  return {run,calendar,writer,actor};
 }
 async function assertCreations(p,session){
  const steps=await acceptedSteps(Steps,p.scope,p.operationId,session),identities=steps.map(creationIdentity);
  if(!equal(identities,p.identities))fail('An accepted original identity, request, compilation or creation receipt changed.');
  for(const step of steps){
   const row=await read(Receipts,{_id:hash({scope:p.scope,dispatchKey:step.dispatch.key})},session),evidence=row&&businessTransportEvidence({...p.scope,operationId:p.operationId,logicalKey:step.logicalKey,entity:step.entity,dispatch:step.dispatch},row);
   if(!evidence||String(row.ownerId)!==p.ownerId||evidence.result.receipt.qboId!==step.qboId||evidence.result.receipt.requestHash!==step.receipt.requestHash)fail('Every original accepted record needs its native creation receipt.');
   const audits=[];for(const expected of evidence.audits)audits.push(await read(Audits,{_id:expected.id},session));assertBusinessTransportAudits(row,evidence,audits);
  }
  return steps;
 }
 async function loadPlan(scope,authorityHash,session){
  const authority=await read(Authorities,{...scope,contentHash:authorityHash},session),p=authority?.payload;
  if(!authority||authority.contractVersion!==1||String(authority._id)!==hash({scope,kind:p?.kind,logicalKey:p?.logicalKey}).slice(0,24)||hash(p)!==authorityHash||!same(authority.actorId,p?.ownerId))fail('The exact immutable repair authority is unavailable.');assertPlan(p,now());
  await require('./business-link-repair-recovery').assertRecoverySource({models,scope,plan:p,session,clock:now()});
  const audit=await read(Audits,{_id:authority.auditId,userId:p.ownerId,realmId:scope.realmId,action:ACTION,actionType:'manual',outcome:'success'},session);
  if(!audit||!equal(audit.afterState,approvalState(p,authorityHash)))fail('The exact repair approval audit is unavailable.');
  return {authority,p};
 }
 async function approve(p){
  assertPlan(p,now(),true);assertReportSources(p,p.reports,p.reports,now(),true);if(Buffer.byteLength(canonical(p))>8000000)fail('Repair authority exceeds its bounded evidence budget.');
  const authorityHash=hash(p),auditId=hash({authorityHash,event:'approved'}).slice(0,24);
  return transaction(async session=>{
   const current=await state(p.scope,p.operationId,session,null,true);if(current.actor.ownerId!==p.ownerId||!equal(stateSignature(current.run,current.calendar,current.writer),p.state)||current.run.authorityHash!==p.publishedAuthorityHash||!equal(p.period,{fromDate:current.run.fromDate,throughDate:current.run.throughDate})||p.currentDate!==require('./business-activity-preview').businessDate(new Date(now())))fail('The reviewed company operation changed.');await assertCreations(p,session);
   // One plan per original creation, even after a rejection. No retry authority is inferred.
   if(p.kind===PLAN){if(await read(Authorities,{...p.scope,'payload.kind':{$in:[PLAN,RECOVERY_PLAN]},'payload.logicalKey':p.logicalKey},session))fail('This original Invoice already has a retained repair plan. Inspect it without another update.');}
   else {
    await require('./business-link-repair-recovery').assertRecoverySource({models,scope:p.scope,plan:p,session,clock:now()});
    if(await read(Authorities,{...p.scope,'payload.kind':RECOVERY_PLAN,'payload.logicalKey':p.logicalKey},session)||await read(Receipts,{...p.scope,kind:'business-link-repair',logicalKey:p.logicalKey},session))fail('This original target already has recovery authority or transport evidence.');
   }
   await Authorities.create([{_id:hash({scope:p.scope,kind:p.kind,logicalKey:p.logicalKey}).slice(0,24),contractVersion:1,...p.scope,contentHash:authorityHash,payload:p,actorId:p.ownerId,auditId}],{session});
   await Audits.create([{_id:auditId,userId:p.ownerId,realmId:p.scope.realmId,action:ACTION,actionType:'manual',outcome:'success',afterState:approvalState(p,authorityHash)}],{session});
   return {authorityHash,auditId,request:repairRequest(p)};
  });
 }
 async function admit({scope,ownerId,actorId,workflow,request,receiptId,dispatchKey,writer,periodProof,session}){
  if(!session?.inTransaction?.()||actorId!==ownerId||workflow?.kind!=='business-link-repair')fail('Dedicated owner-only repair admission is required.');
  const {p}=await loadPlan(scope,workflow.authorityHash,session),s=await state(scope,p.operationId,session,null,true);
  if(ownerId!==p.ownerId||!equal(plain(s.writer),plain(writer))||!equal(stateSignature(s.run,s.calendar,s.writer),p.state)||!equal(repairRequest(p),request)||dispatchKey!==dispatchKeyFor(workflow.authorityHash)||receiptId!==hash({scope,dispatchKey}))fail('The exact single-use reviewed repair request changed.');
  assertPlan(p,now(),true);assertReportSources(p,p.reports,p.reports,now(),true);await assertCreations(p,session);
  const dated=periodProof?.evidence?.records;
  if(!Array.isArray(dated)||dated.length!==3||!['invoice','estimate','time'].every(key=>dated.filter(row=>row.entity===p.before[key].entity&&row.id===p.before[key].record.Id&&row.syncToken===p.before[key].record.SyncToken&&row.recordHash===p.before[key].recordHash).length===1))fail('Protected-period preflight no longer matches all three exact reviewed records.');
  if(await read(Receipts,{...scope,kind:'business-link-repair','workflow.authorityHash':workflow.authorityHash},session))fail('This exact repair has already been admitted. It cannot be replayed.');
  const run=await Runs.findOneAndUpdate({_id:s.run._id,...scope,status:'blocked',writerRevision:s.run.writerRevision,evidenceRevision:s.run.evidenceRevision,executionRevision:s.run.executionRevision,leaseToken:null,'executionRequest.pending':false},{$inc:{writerRevision:1,evidenceRevision:1},$set:{verificationCandidateHash:null}},{new:true,session}).lean();
  const calendar=await Calendars.findOneAndUpdate({_id:s.calendar._id,...scope,writerRevision:s.calendar.writerRevision,currentOperationId:p.operationId,stopRequested:false,pendingCommit:null},{$inc:{writerRevision:1}},{new:true,session}).lean();
  if(!run||!calendar)fail('The blocked operation changed while admitting repair.');
  return {kind:'business-link-repair',authorityHash:workflow.authorityHash,operationId:p.operationId,logicalKey:p.logicalKey,key:dispatchKey,requestHash:request.requestHash,actorId,entity:'invoice',transportConsumed:{receiptId,consumedAt:new Date(now()).toISOString()}};
 }
 async function settle({stored,observed,session}){
  const {p}=await loadPlan({environment:stored.environment,realmId:stored.realmId,connectionId:String(stored.connectionId)},stored.workflow?.authorityHash,session);
  if(stored.kind!=='business-link-repair'||stored.operation!=='update'||stored.requestHash!==repairRequest(p).requestHash||!['saved','unknown','rejected'].includes(observed.outcome)||(observed.outcome==='saved'&&observed.qboId!==p.originalStep.qboId))fail('The repair result does not match its single admitted target.');
 }
 async function saved(scope,authorityHash,session){
  const {p}=await loadPlan(scope,authorityHash,session),s=await state(scope,p.operationId,session,authorityHash),key=dispatchKeyFor(authorityHash),receiptId=hash({scope,dispatchKey:key}),row=await read(Receipts,{_id:receiptId,...scope},session);
  await assertSavedRepairReceipt({Receipts,Authorities,Audits},scope,p,authorityHash,row,session);
  const expected=structuredClone(p.state);expected.run.writerRevision++;expected.run.evidenceRevision++;expected.calendar.writerRevision++;expected.writer.revision+=2;
  if(!equal(stateSignature(s.run,s.calendar,s.writer),expected)||s.writer.unresolved?.key!==key||s.writer.unresolved?.responseReceiptId!==receiptId||s.writer.unresolved?.transportConsumed?.receiptId!==receiptId||s.writer.unresolved?.requestHash!==row.requestHash)fail('The exact held saved repair state changed.');
  return {p,...s,row};
 }
 async function graphSnapshot({scope,intent,session,authorityHash}){
  const s=await saved(scope,authorityHash,session);if(intent.operationId!==s.p.operationId||intent.planHash!==s.p.planHash)fail('The quarantined graph operation changed.');
  return {scope,operationId:s.p.operationId,revision:s.writer.revision,unresolved:plain(s.writer.unresolved),quarantinedRepair:{version:1,kind:'known-saved-link-repair',authorityHash,receiptId:s.row._id,requestHash:s.row.requestHash,dispatchKey:s.row.dispatchKey,qboId:s.row.observed.qboId,receiptEvidenceHash:hash({requestHash:s.row.requestHash,observed:s.row.observed,startAuditId:String(s.row.startAuditId),resultAuditId:String(s.row.resultAuditId)}),operationId:s.p.operationId}};
 }
 async function finalizeNoEffect({scope,authorityHash,after,reports,parentLedgers=[]}){
  return transaction(async session=>{
   const s=await saved(scope,authorityHash,session),p=s.p,invariants=assertNoEffectReadback(p,after,s.row,now()),financial=assertReportSources(p,p.reports,reports,now(),false,parentLedgers);await assertCreations(p,session);
   if(await read(Authorities,{...scope,'payload.planAuthorityHash':authorityHash,'payload.kind':{$in:[OUTCOME,NO_EFFECT]}},session))fail('The saved repair already has a retained settlement.');
   const payload={version:1,kind:NO_EFFECT,scope,ownerId:p.ownerId,operationId:p.operationId,logicalKey:p.logicalKey,qboId:p.originalStep.qboId,compilationHash:p.originalStep.compilation.compilationHash,creationReceiptHash:p.originalStep.receipt.evidenceHash,planAuthorityHash:authorityHash,receiptId:s.row._id,verifiedAt:new Date(now()).toISOString(),linkVerified:false,originalOperationBlocked:true,invariants,after,reports,parentLedgers,financial},contentHash=hash(payload),auditId=hash({contentHash,event:'no-effect'}).slice(0,24);
   if(Buffer.byteLength(canonical(payload))>8000000)fail('Unsuccessful repair settlement exceeds its retained budget.');
   await Authorities.create([{_id:hash({scope,kind:NO_EFFECT,planAuthorityHash:authorityHash}).slice(0,24),contractVersion:1,...scope,contentHash,payload,actorId:p.ownerId,auditId}],{session});
   await Audits.create([{_id:auditId,userId:p.ownerId,realmId:scope.realmId,action:NO_EFFECT_ACTION,actionType:'manual',outcome:'partial',afterState:noEffectAuditState(payload,contentHash)}],{session});
   const released=await Writers.findOneAndUpdate({_id:s.writer._id,...scope,revision:s.writer.revision,operationId:p.operationId,planHash:p.planHash,'unresolved.key':s.row.dispatchKey,'unresolved.responseReceiptId':s.row._id},{$set:{unresolved:null},$inc:{revision:1}},{new:true,session}).lean();
   if(!released)fail('The exact saved repair pointer changed before unsuccessful settlement.');
   return {status:'saved-without-effect',authorityHash:contentHash,planAuthorityHash:authorityHash,receiptId:s.row._id,operationId:p.operationId,logicalKey:p.logicalKey,linkVerified:false,originalOperationBlocked:true,financial};
  });
 }
 async function finalize({scope,authorityHash,after,reports,graph,parentLedgers=[]}){
  // Immutable policy reads occur before the retryable settlement transaction.
  const prepared=await transaction(async session=>{const value=await saved(scope,authorityHash,session);return {p:value.p,rows:await assertCreations(value.p,session)};});
  const policyHashes={};
  for(const key of [prepared.p.logicalKey,...prepared.p.originalStep.compilation.relationships.map(x=>x.logicalKey)]){const row=prepared.rows.find(x=>x.logicalKey===key),policy=await loadTaxPolicy(scope,row.compilation);policyHashes[key]=hash(policy);}
  return transaction(async session=>{
   const s=await saved(scope,authorityHash,session),p=s.p,invariants=assertRepairReadback(p,after,now()),financial=assertReportSources(p,p.reports,reports,now(),false,parentLedgers);const originalRows=await assertCreations(p,session);
   const snapshot=await graphSnapshot({scope,intent:{operationId:p.operationId,planHash:p.planHash},authorityHash,session}),expectedFence={scope,operationId:p.operationId,revision:snapshot.revision,unresolved:snapshot.unresolved,quarantinedRepair:snapshot.quarantinedRepair};
   const graphSteps=assertRepairGraph(p,after,graph,expectedFence,originalRows,now(),policyHashes);
   // Retain the complete graph as bounded JSON text so nested ledger/report
   // sources do not exceed the published blueprint canonical depth contract.
   const graphSourceJson=JSON.stringify(graph),graphSourceHash=hash(graphSourceJson),graphSummary={version:graph.version,scope:graph.scope,roots:graph.roots,complete:graph.complete,recordCount:graph.recordCount,observedAt:graph.observedAt,writerFence:graph.writerFence,evidenceHash:graph.evidenceHash,records:graph.records.map(({proof,...row})=>({...row,proof:{kind:proof.kind,matchesIntent:proof.matchesIntent,observedHash:proof.observedHash,compilationHash:proof.compilationHash,evidenceHash:proof.evidenceHash,syncToken:proof.syncToken,observedAt:proof.observedAt}}))};
   const payload={version:1,kind:OUTCOME,scope,ownerId:p.ownerId,operationId:p.operationId,logicalKey:p.logicalKey,qboId:p.originalStep.qboId,compilationHash:p.originalStep.compilation.compilationHash,creationReceiptHash:p.originalStep.receipt.evidenceHash,planAuthorityHash:authorityHash,receiptId:s.row._id,verifiedAt:new Date(now()).toISOString(),invariants,after,reports,parentLedgers,financial,graphSteps,policyHashes,graph:graphSummary,graphSourceJson,graphSourceHash},contentHash=hash(payload),auditId=hash({contentHash,event:'verified'}).slice(0,24);
   if(Buffer.byteLength(canonical(payload))>8000000)fail('Repair verification exceeds its retained evidence budget.');
   await Authorities.create([{_id:hash({scope,kind:OUTCOME,planAuthorityHash:authorityHash}).slice(0,24),contractVersion:1,...scope,contentHash,payload,actorId:p.ownerId,auditId}],{session});
   await Audits.create([{_id:auditId,userId:p.ownerId,realmId:scope.realmId,action:VERIFIED,actionType:'manual',outcome:'success',afterState:{authorityHash:contentHash,planAuthorityHash:authorityHash,receiptId:s.row._id,operationId:p.operationId,logicalKey:p.logicalKey,allAccountDeltaCents:0,graphEvidenceHash:graph.evidenceHash}}],{session});
   const released=await Writers.findOneAndUpdate({_id:s.writer._id,...scope,revision:s.writer.revision,operationId:p.operationId,planHash:p.planHash,'unresolved.key':s.row.dispatchKey,'unresolved.responseReceiptId':s.row._id},{$set:{unresolved:null},$inc:{revision:1}},{new:true,session}).lean();
   if(!released)fail('The repair barrier changed before verification could be retained.');
   return {status:'verified',authorityHash:contentHash,planAuthorityHash:authorityHash,receiptId:s.row._id,operationId:p.operationId,logicalKey:p.logicalKey,financial,graphEvidenceHash:graph.evidenceHash,originalOperationPreserved:true};
  });
 }
 return {approve,admit,settle,graphSnapshot,finalize,finalizeNoEffect,loadPlan,saved,state};
}
async function assertSavedRepairReceipt(models,scope,p,authorityHash,row,session){
 const {Audits}=models,dispatchKey=dispatchKeyFor(authorityHash),receiptId=hash({scope,dispatchKey}),request=repairRequest(p),observed=row?.observed;
 if(!row||row.contractVersion!==1||row._id!==receiptId||row.kind!=='business-link-repair'||row.operation!=='update'||row.entity!=='invoice'||!equal({environment:row.environment,realmId:row.realmId,connectionId:String(row.connectionId)},scope)||!same(row.ownerId,p.ownerId)||!same(row.actorId,p.ownerId)||row.workflow?.version!==1||row.workflow.kind!=='business-link-repair'||row.workflow.authorityHash!==authorityHash||row.dispatchKey!==dispatchKey||row.requestHash!==request.requestHash||row.state!=='saved'||observed?.outcome!=='saved'||observed.operation!=='update'||observed.entity!=='invoice'||observed.qboId!==p.originalStep.qboId||! /^[a-f0-9]{64}$/.test(observed.responseHash||'')||observed.httpStatus<200||observed.httpStatus>299)fail('An exact known-saved dedicated repair receipt is required.');
 const start=hash({receiptId,event:'started'}).slice(0,24),result=hash({receiptId,event:'response',observed}).slice(0,24),params={environment:scope.environment,connectionId:scope.connectionId,dispatchKey,requestHash:row.requestHash,entity:'invoice',operation:'update'};
 if(!same(row.startAuditId,start)||!same(row.resultAuditId,result))fail('The repair transport audit identity changed.');
 for(const expected of [{id:start,action:'QuickBooks write dispatch recorded',outcome:'partial',afterState:{state:'possibly-sent',receiptId}},{id:result,action:'QuickBooks write response recorded',outcome:'success',afterState:{state:'saved',receiptId,...observed}}]){const a=await read(Audits,{_id:expected.id},session);if(!a||!same(a.userId,p.ownerId)||!same(a.actorUserId||a.userId,p.ownerId)||a.realmId!==scope.realmId||a.action!==expected.action||a.actionType!=='manual'||a.outcome!==expected.outcome||!equal(a.inputParams,params)||!equal(a.afterState,expected.afterState))fail('The exact repair dispatch and result audits are required.');}
 return row;
}

function noEffectAuditState(o,contentHash){return {authorityHash:contentHash,planAuthorityHash:o.planAuthorityHash,receiptId:o.receiptId,operationId:o.operationId,logicalKey:o.logicalKey,allAccountDeltaCents:0,linkVerified:false,originalOperationBlocked:true};}
async function assertNoEffectOutcome({models,scope,p,authority,row,outcome,session}){
 const o=outcome.payload;
 if(outcome.contractVersion!==1||String(outcome._id)!==hash({scope,kind:NO_EFFECT,planAuthorityHash:authority.contentHash}).slice(0,24)||hash(o)!==outcome.contentHash||!equal(o.scope,scope)||o.version!==1||o.kind!==NO_EFFECT||o.ownerId!==p.ownerId||o.operationId!==p.operationId||o.planAuthorityHash!==authority.contentHash||o.receiptId!==row._id||o.compilationHash!==p.originalStep.compilation.compilationHash||o.creationReceiptHash!==p.originalStep.receipt.evidenceHash||o.logicalKey!==p.logicalKey||o.qboId!==p.originalStep.qboId||o.linkVerified!==false||o.originalOperationBlocked!==true||!same(outcome.actorId,p.ownerId))fail('The explicit unsuccessful settlement changed.');
 const audit=await read(models.Audits,{_id:outcome.auditId,userId:p.ownerId,realmId:scope.realmId,action:NO_EFFECT_ACTION,actionType:'manual',outcome:'partial'},session);
 if(!audit||!equal(audit.afterState,noEffectAuditState(o,outcome.contentHash))||!equal(o.invariants,assertNoEffectReadback(p,o.after,row,Date.parse(o.verifiedAt)))||!equal(o.financial,assertReportSources(p,p.reports,o.reports,Date.parse(o.verifiedAt),false,o.parentLedgers)))fail('The unsuccessful settlement proof or audit is unavailable.');
}
// A read-only lookup. A known saved repair may provide provisional representation
// evidence only under its exact held barrier; later reads require the append-only
// verified outcome. Neither path authorizes another write.
async function loadOwnedLinkLineage({models,scope,step,session}){
 const {Authorities,Receipts,Audits,Writers}=models;
 const recoveryId=hash({scope,kind:RECOVERY_PLAN,logicalKey:step.logicalKey}).slice(0,24);
 if(await read(Authorities,{...scope,'payload.kind':RECOVERY_PLAN,'payload.logicalKey':step.logicalKey,_id:{$ne:recoveryId}},session))fail('Several recovery authorities claim this original target.');
 const recoveryAuthority=await read(Authorities,{_id:recoveryId,...scope,'payload.kind':RECOVERY_PLAN,'payload.logicalKey':step.logicalKey},session);
 const authority=recoveryAuthority||await read(Authorities,{_id:hash({scope,kind:PLAN,logicalKey:step.logicalKey}).slice(0,24),...scope,'payload.kind':PLAN,'payload.logicalKey':step.logicalKey},session);
 if(!authority)return null;
 const p=authority.payload;assertPlan(p,Date.now());
 await require('./business-link-repair-recovery').assertRecoverySource({models,scope,plan:p,session});
 if(hash(p)!==authority.contentHash||!same(authority.actorId,p.ownerId)||p.originalStep.compilation.compilationHash!==step.compilation.compilationHash||p.originalStep.receipt.evidenceHash!==step.receipt.evidenceHash||p.originalStep.qboId!==step.qboId)fail('The exact legacy line-repair authority changed.');
 const approval=await read(Audits,{_id:authority.auditId,userId:p.ownerId,realmId:scope.realmId,action:ACTION,actionType:'manual',outcome:'success'},session);
 if(!approval||!equal(approval.afterState,approvalState(p,authority.contentHash)))fail('The repair approval audit is required for compatibility.');
 const row=await read(Receipts,{_id:hash({scope,dispatchKey:dispatchKeyFor(authority.contentHash)}),...scope},session);
 await assertSavedRepairReceipt(models,scope,p,authority.contentHash,row,session);
 const noEffect=await read(Authorities,{...scope,'payload.kind':NO_EFFECT,'payload.planAuthorityHash':authority.contentHash},session);
 const outcome=await read(Authorities,{...scope,'payload.kind':OUTCOME,'payload.planAuthorityHash':authority.contentHash},session);
 if(noEffect){if(outcome)fail('Conflicting repair settlements are not admissible.');await assertNoEffectOutcome({models,scope,p,authority,row,outcome:noEffect,session});return null;}
 let outcomeHash=null;
 if(outcome){
  const o=outcome.payload;
  if(hash(o)!==outcome.contentHash||o.receiptId!==row._id||o.compilationHash!==step.compilation.compilationHash||o.creationReceiptHash!==step.receipt.evidenceHash||o.logicalKey!==step.logicalKey||o.qboId!==step.qboId||hash(o.graphSourceJson)!==o.graphSourceHash||JSON.parse(o.graphSourceJson).evidenceHash!==o.graph?.evidenceHash||!same(outcome.actorId,p.ownerId))fail('The verified repair lineage changed.');
  const audit=await read(Audits,{_id:outcome.auditId,userId:p.ownerId,realmId:scope.realmId,action:VERIFIED,actionType:'manual',outcome:'success'},session);
  if(!audit||!equal(audit.afterState,{authorityHash:outcome.contentHash,planAuthorityHash:authority.contentHash,receiptId:row._id,operationId:p.operationId,logicalKey:p.logicalKey,allAccountDeltaCents:0,graphEvidenceHash:o.graph?.evidenceHash}))fail('The final repair verification audit is unavailable.');
  assertRepairGraph(p,o.after,JSON.parse(o.graphSourceJson),o.graph.writerFence,o.graphSteps,Date.parse(o.verifiedAt),o.policyHashes);assertRepairReadback(p,o.after,Date.parse(o.verifiedAt));assertReportSources(p,p.reports,o.reports,Date.parse(o.verifiedAt),false,o.parentLedgers);outcomeHash=outcome.contentHash;
 } else {
  const writer=await read(Writers,{...scope},session),u=writer?.unresolved;
  if(!same(writer?.operationId,p.operationId)||writer?.planHash!==p.planHash||u?.kind!=='business-link-repair'||u.authorityHash!==authority.contentHash||u.key!==row.dispatchKey||u.requestHash!==row.requestHash||u.responseReceiptId!==row._id||u.transportConsumed?.receiptId!==row._id)fail('Provisional compatibility requires the exact held known-saved repair barrier.');
 }
 return {version:1,kind:'verified-owned-link-repair',authorityHash:authority.contentHash,outcomeHash,receiptId:row._id,receiptEvidenceHash:hash({requestHash:row.requestHash,observed:row.observed,startAuditId:String(row.startAuditId),resultAuditId:String(row.resultAuditId)}),compilationHash:step.compilation.compilationHash,creationReceiptHash:step.receipt.evidenceHash,qboId:step.qboId,stage:outcomeHash?'verified-outcome':'provisional-known-saved-read-only'};
}

module.exports={loadOwnedLinkLineage,createBusinessLinkRepair,assertSavedRepairReceipt,stateSignature,assertRepairGraph,acceptedSteps,dispatchKeyFor,assertReportSources,ACTION,VERIFIED};
