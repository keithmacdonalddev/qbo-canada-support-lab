'use strict';
const { hash, canonical } = require('./business-calendar');
const { assertRun, assertRunApproval } = require('./business-period-store');
const { validateOperationEntry } = require('./business-operation-plan-store');
const { deriveBusinessPolicies, verifyBusinessTaxSources } = require('./business-tax-policy');
const { randomUUID } = require('node:crypto');
const { referenceDefinition } = require('./business-reference');
const { assertOwnerAttribution, SOURCE: OWNER_SOURCE } = require('./business-owner-attribution');
const ID=/^[a-f0-9]{24}$/, HASH=/^[a-f0-9]{64}$/;
const read=(Model,filter,session)=>Model.findOne(filter).session(session).maxTimeMS(3000).lean();
function fail(message){throw Object.assign(new Error(message),{status:409,code:'BUSINESS_POLICY_REVIEW_REQUIRED'});}
const fixed=policy=>Object.fromEntries(Object.entries(policy).filter(([key])=>!['readbackTax','taxSources','taxReferenceDefinitions','derivedAt','evidenceHash'].includes(key)));
function assertOverlay(original,overlay,step){
 if(!overlay||canonical(fixed(original))!==canonical(fixed(overlay)))fail('A tax review cannot change dates, prices, record choices or business authority.');
 if(overlay.taxReferenceDefinitions){
  if(!Array.isArray(overlay.taxReferenceDefinitions)||overlay.taxReferenceDefinitions.length>2)fail('Tax reference choices exceed their approved budget.');
  for(const choice of overlay.taxReferenceDefinitions){const binding=step?.references.find(row=>row.entity==='TaxCode'&&row.key===choice.key&&row.id===choice.id),source=overlay.taxSources?.find(row=>row.entity==='TaxCode'&&row.id===choice.id);if(!binding||binding.definition.hash!==choice.originalDefinitionHash||!source||canonical(referenceDefinition(overlay.scope,'TaxCode',source.record))!==canonical(choice.definition))fail('Only the same selected tax code can receive a reviewed definition.');}
 }
 const {evidenceHash,...body}=overlay;if(!HASH.test(evidenceHash||'')||hash(body)!==evidenceHash)fail('The approved tax expectation changed.');
}
async function approvedAmendment(models,scope,run,session){
 if(!run.policyAmendmentHash)return null;
 const row=await read(models.Authorities,{...scope,contentHash:run.policyAmendmentHash},session),p=row?.payload;
 if(!p||p.kind!=='operation-policy-amendment'||hash(p)!==row.contentHash||p.operationId!==String(run._id)||p.planHash!==run.planHash||p.authorityHash!==run.authorityHash||canonical(p.scope)!==canonical(scope)||p.ownerId!==String(run.approval?.actorId)||String(row.actorId)!==p.ownerId||!Array.isArray(p.overrides)||p.overrides.length>500)fail('The retained owner-approved tax review is unavailable.');
 const audit=await read(models.Audits,{_id:row.auditId,realmId:scope.realmId,userId:p.ownerId,action:'Remaining business tax expectations approved',outcome:'success','afterState.amendmentHash':row.contentHash,'afterState.operationId':String(run._id),'afterState.planHash':run.planHash},session);
 if(!audit)fail('The tax review audit is unavailable.');return row;
}
async function effectiveBusinessPolicy(models,scope,run,intent,session,cache){
 if(!run.policyAmendmentHash)return structuredClone(intent.policy);
 const key=String(run._id)+':'+run.policyAmendmentHash;let approved=cache?.get(key);
 if(!approved){approved=await approvedAmendment(models,scope,run,session);cache?.set(key,approved);}
 const choices=approved.payload.overrides.filter(entry=>entry.logicalKey===intent.logicalKey);
 if(choices.length>1)fail('The tax review contains duplicate activity identities.');
 if(!choices.length)return structuredClone(intent.policy);
 const choice=choices[0];if(choice.originalPolicyHash!==hash(intent.policy)||intent.kind!=='create')fail('The tax review differs from the original immutable policy.');assertOverlay(intent.policy,choice.policy,intent.step);return structuredClone(choice.policy);
}
function createBusinessPolicyAmendment({models,transaction,now,bind,fence}){
 async function inspect(bound,operationId,planHash,session){
  if(!ID.test(operationId||'')||!HASH.test(planHash||''))fail('Choose the exact approved saved operation.');
  const {scope}=bound,run=await read(models.Runs,{_id:operationId,...scope,planHash},session);assertRun(run,scope);assertRunApproval(run);
  const calendar=await read(models.Calendars,{...scope},session),writer=await read(models.Writers,{environment:scope.environment,realmId:scope.realmId},session);
  if(!['approved','reserved','running','blocked'].includes(run.status)||!calendar||!writer||String(writer.connectionId)!==scope.connectionId||calendar.pendingCommit||calendar.authorityHash!==run.authorityHash||calendar.verifiedThrough!==run.expectedCursor||calendar.revision!==run.expectedRevision||(calendar.currentOperationId!==null&&String(calendar.currentOperationId)!==operationId)||(writer.operationId===null?writer.planHash!==null:String(writer.operationId)!==operationId||writer.planHash!==planHash)||writer.unresolved!==null)fail('Settle uncertain requests and use the operation still owning this calendar.');
  if(run.leaseToken&&(!Number.isFinite(new Date(run.leaseExpiresAt).getTime())||new Date(run.leaseExpiresAt).getTime()>now()))fail('Wait for the active worker to finish or stop before reviewing tax changes.');
  const plan=await read(models.Plans,{_id:run.planId,...scope,operationId,planHash},session);if(!plan||hash(plan.manifest)!==planHash)fail('The original immutable plan is unavailable.');
  const intents=await models.Intents.find({...scope,planId:plan._id,planHash}).sort({ordinal:1}).limit(1001).session(session).maxTimeMS(3000).lean();
  if(intents.length!==plan.manifest.records.length||intents.length>1000)fail('Original activity policies are incomplete.');
  for(const[row,index]of intents.map((row,index)=>[row,index]))if(row.ordinal!==index||canonical(validateOperationEntry(row,scope,run.fromDate,run.throughDate))!==canonical(plan.manifest.records[index]))fail('An original immutable activity changed.');
  const create=intents.filter(row=>row.kind==='create'),keys=create.map(row=>row.logicalKey),rows=keys.length?await models.Steps.find({environment:scope.environment,realmId:scope.realmId,logicalKey:{$in:keys}}).limit(501).session(session).maxTimeMS(3000).lean():[];
  if(rows.length>500||rows.some(row=>String(row.connectionId)!==scope.connectionId||String(row.operationId)!==operationId||row.planHash!==planHash||!['claimed','saved','verified'].includes(row.state)||(row.state==='claimed'&&(row.dispatch||row.receipt||row.qboId))))fail('A possibly sent request must be reconciled before any tax review.');
  const saved=new Set(rows.filter(row=>['saved','verified'].includes(row.state)&&row.receipt&&row.qboId).map(row=>row.logicalKey));
  if(rows.some(row=>row.state!=='claimed'&&!saved.has(row.logicalKey)))fail('A saved effect has incomplete receipt evidence.');
  const remaining=create.filter(row=>!saved.has(row.logicalKey));if(!remaining.length)fail('No unsent tax expectations remain to review.');
  const receipts=await models.Receipts.find({environment:scope.environment,realmId:scope.realmId,operationId}).limit(1001).session(session).maxTimeMS(3000).lean();
  if(receipts.length>1000)fail('Transport history exceeds the review budget.');
  for(const receipt of receipts){
   const step=rows.find(row=>row.logicalKey===receipt.logicalKey);
   if(step&&saved.has(step.logicalKey)&&receipt.state==='saved'&&receipt.dispatchKey===step.dispatch?.key&&receipt.observed?.qboId===step.qboId)continue;
   if(step&&saved.has(step.logicalKey)&&step.receipt?.source===OWNER_SOURCE&&receipt._id===hash({scope,dispatchKey:step.dispatch?.key})){await assertOwnerAttribution(models,scope,step,session);continue;}
   const history=step?.retryHistory?.find(entry=>entry.receiptId===String(receipt._id)&&entry.dispatchKey===receipt.dispatchKey&&entry.responseHash===receipt.observed?.responseHash&&entry.retryGeneration<=step.retryGeneration);
   const audit=history&&await read(models.Audits,{_id:history.recoveryAuditId,userId:bound.ownerId,realmId:scope.realmId,action:'Business operation recovery approved','afterState.operationId':operationId,'afterState.mode':'retry-rejected','afterState.newRetryGeneration':history.retryGeneration,'afterState.retainedRejectedAttempt.rejection.receiptId':receipt._id},session);
   if(!history||!audit||receipt.state!=='rejected'||receipt.observed?.outcome!=='rejected'||receipt.observed.httpStatus!==400||receipt.observed.qboId)fail('A transport outcome is not represented by a saved activity or exact owner-closed rejection.');
  }
  const previous=await approvedAmendment(models,scope,run,session),claims=rows.filter(row=>row.state==='claimed');
  const state={version:1,scope,operationId,planHash,authorityHash:run.authorityHash,previousHash:run.policyAmendmentHash||null,executionRevision:run.executionRevision,runWriterRevision:run.writerRevision,writerRevision:writer.revision,calendarWriterRevision:calendar.writerRevision,remaining:remaining.map(row=>row.logicalKey).sort(),saved:[...saved].sort(),claims:claims.map(row=>({id:String(row._id),logicalKey:row.logicalKey,revision:row.revision,leaseHash:hash(row.leaseToken||null)})).sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey))};
  return{run,calendar,writer,intents,remaining,claims,previous,state,stateHash:hash(state)};
 }
 async function review(user,operationId,input){
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).join(',')!=='planHash')fail('Review the exact saved plan.');
  const bound=await bind(user,'operations.execute',true),current=await inspect(bound,operationId,input.planHash),{scope,access,ownerId,actorId}=bound,client=await access.resolveClient(scope);
  const policies=await deriveBusinessPolicies({candidate:{scope,fromDate:current.run.fromDate,throughDate:current.run.throughDate,entries:current.remaining.map(row=>({kind:'create',step:row.step}))}},client,current.run.authorityHash,now());
  const inherited=new Map((current.previous?.payload.overrides||[]).map(row=>[row.logicalKey,row])),cache=new Map(),changes=[];
  for(const value of policies){const original=current.remaining.find(row=>row.logicalKey===value.logicalKey),previous=await effectiveBusinessPolicy(models,scope,current.run,original,undefined,cache);value.policy.taxReferenceDefinitions=original.step.references.filter(row=>row.entity==='TaxCode').map(binding=>{const source=value.policy.taxSources?.find(row=>row.entity==='TaxCode'&&row.id===binding.id);if(!source)fail('The fresh tax-code definition is unavailable.');return{key:binding.key,id:binding.id,originalDefinitionHash:binding.definition.hash,definition:referenceDefinition(scope,'TaxCode',source.record)};});
   delete value.policy.evidenceHash;value.policy.evidenceHash=hash(value.policy);assertOverlay(original.policy,value.policy,original.step);inherited.set(value.logicalKey,{logicalKey:value.logicalKey,originalPolicyHash:hash(original.policy),policy:value.policy});changes.push({logicalKey:value.logicalKey,entity:original.step.entity,txnDate:original.step.txnDate,previousTaxCents:previous.readbackTax?.totalTaxCents??null,proposedTaxCents:value.policy.readbackTax?.totalTaxCents??null,taxCodeDefinitionChanged:value.policy.taxReferenceDefinitions.some(choice=>choice.originalDefinitionHash!==choice.definition.hash),taxCodes:(value.policy.taxSources||[]).filter(source=>source.entity==='TaxCode').map(source=>({id:source.id,name:source.record.Name||source.id})),rates:value.policy.readbackTax?.lines||[]});}
  const payload={version:1,kind:'operation-policy-review',scope,operationId,planHash:input.planHash,state:current.state,stateHash:current.stateHash,overrides:[...inherited.values()].sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey)),changes,preparedAt:new Date(now()).toISOString()},candidateHash=hash(payload),auditId=hash({taxReview:candidateHash}).slice(0,24);
  await transaction(async session=>{await fence(bound,session,'operations.execute');const latest=await inspect(bound,operationId,input.planHash,session);if(latest.stateHash!==current.stateHash)fail('Operation activity changed during tax review.');if(!await read(models.Candidates,{...scope,candidateHash},session)){await models.Candidates.create([{_id:hash({scope,candidateHash}).slice(0,24),contractVersion:1,...scope,candidateHash,payload,actorId,auditId}],{session});await models.Audits.create([{_id:auditId,userId:ownerId,realmId:scope.realmId,action:'Remaining business tax review prepared',actionType:'manual',outcome:'success',afterState:{...scope,candidateHash,operationId,planHash:input.planHash,qboWrites:0}}],{session});}});
  return{scope,operationId,planHash:input.planHash,reviewHash:candidateHash,savedRecords:current.state.saved.length,remainingRecords:current.remaining.length,changes,qboWrites:0};
 }
 async function approve(user,operationId,input){
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).sort().join(',')!=='planHash,reason,reviewHash'||!HASH.test(input.reviewHash||'')||!HASH.test(input.planHash||'')||typeof input.reason!=='string'||input.reason.trim().length<20||input.reason.length>2000)fail('Approve the exact retained tax review with your reason.');
  const bound=await bind(user,'operations.execute',true),{scope,ownerId,actorId,access}=bound;
  const prior=await read(models.Authorities,{...scope,'payload.kind':'operation-policy-amendment','payload.reviewHash':input.reviewHash});if(prior){if(prior.payload.reason!==input.reason.trim()||prior.payload.operationId!==operationId||prior.payload.planHash!==input.planHash)fail('This tax review already has a different approval.');return{scope,operationId,approved:true,reused:true,amendmentHash:prior.contentHash};}
  const candidate=await read(models.Candidates,{...scope,candidateHash:input.reviewHash}),p=candidate?.payload;
  if(!p||hash(p)!==input.reviewHash||p.kind!=='operation-policy-review'||p.operationId!==operationId||p.planHash!==input.planHash||String(candidate.actorId)!==actorId)fail('The exact retained tax review is unavailable.');
  const audit=await read(models.Audits,{_id:candidate.auditId,userId:ownerId,realmId:scope.realmId,action:'Remaining business tax review prepared',outcome:'success','afterState.candidateHash':input.reviewHash});if(!audit)fail('The tax review preparation audit is unavailable.');
  const fresh=await inspect(bound,operationId,input.planHash),remaining=new Set(fresh.remaining.map(row=>row.logicalKey)),client=await access.resolveClient(scope),cache=new Map(),reader={read:async(entity,id)=>{const key=entity+':'+id;if(!cache.has(key))cache.set(key,await client.read(entity,id));return cache.get(key);}};
  for(const entry of p.overrides)if(remaining.has(entry.logicalKey))await verifyBusinessTaxSources(entry.policy,reader);
  return transaction(async session=>{
   await fence(bound,session,'operations.execute');const current=await inspect(bound,operationId,input.planHash,session);if(current.stateHash!==p.stateHash||canonical(current.state)!==canonical(p.state))fail('The operation changed after the tax review. Review it again.');
   const payload={version:1,kind:'operation-policy-amendment',scope,operationId,planHash:input.planHash,authorityHash:current.run.authorityHash,previousHash:current.run.policyAmendmentHash||null,reviewHash:input.reviewHash,ownerId,overrides:p.overrides,reason:input.reason.trim(),approvedAt:new Date(now()).toISOString()},contentHash=hash(payload),auditId=hash({taxAmendment:contentHash}).slice(0,24);
   if(Buffer.byteLength(canonical(payload))>8000000)fail('Approved tax evidence exceeds its storage budget.');
   await models.Authorities.create([{_id:hash({scope,contentHash}).slice(0,24),contractVersion:1,...scope,contentHash,payload,actorId,auditId}],{session});
   for(const row of current.claims){const changed=await models.Steps.findOneAndUpdate({_id:row._id,...scope,operationId,state:'claimed',revision:row.revision,leaseToken:row.leaseToken,dispatch:null,receipt:null},{$set:{leaseToken:randomUUID(),leaseExpiresAt:new Date(0)},$inc:{revision:1}},{new:true,session}).lean();if(!changed)fail('An unsent claim changed during tax approval.');}
   const run=await models.Runs.findOneAndUpdate({_id:operationId,...scope,planHash:input.planHash,status:current.run.status,executionRevision:current.run.executionRevision,writerRevision:current.run.writerRevision},{$set:{policyAmendmentHash:contentHash,leaseToken:null,leaseExpiresAt:null,verificationCandidateHash:null,lastError:null},$inc:{policyRevision:1,executionRevision:1,writerRevision:1,evidenceRevision:1}},{new:true,session}).lean();
   const writer=await models.Writers.findOneAndUpdate({_id:current.writer._id,...scope,revision:current.writer.revision,operationId:current.writer.operationId,unresolved:null},{$inc:{revision:1}},{new:true,session}).lean();
   const calendar=await models.Calendars.findOneAndUpdate({_id:current.calendar._id,...scope,revision:current.calendar.revision,writerRevision:current.calendar.writerRevision,currentOperationId:current.calendar.currentOperationId,pendingCommit:null},{$inc:{writerRevision:1}},{new:true,session}).lean();if(!run||!writer||!calendar)fail('Company ownership changed before tax approval.');
   await models.Audits.create([{_id:auditId,userId:ownerId,realmId:scope.realmId,action:'Remaining business tax expectations approved',actionType:'manual',outcome:'success',beforeState:current.state,afterState:{...scope,operationId,planHash:input.planHash,amendmentHash:contentHash,reviewHash:input.reviewHash,savedRecordsUnchanged:current.state.saved.length,changedUnsentPolicies:p.changes.length,qboWrites:0}}],{session});
   return{scope,operationId,approved:true,reused:false,amendmentHash:contentHash};
  });
 }
 return{review,approve};
}
module.exports={createBusinessPolicyAmendment,effectiveBusinessPolicy};
