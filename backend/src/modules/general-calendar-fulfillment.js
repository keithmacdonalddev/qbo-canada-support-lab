'use strict';
// A calendar fulfillment is a distinct origin. It never manufactures a managed
// OperationStep, an SDK compilation, a dispatch or a creation receipt.
const {hash,canonical}=require('./business-calendar');
const {scoped}=require('./qbo-write-contract');
const C=require('./bank-settlement-contract');
const native=require('./general-time-estimate-source');
const KIND='general-calendar-fulfillment',CLAIM='general-calendar-fulfillment-claim',READBACK='general-calendar-readback';
const HASH=/^[a-f0-9]{64}$/,ID=/^[a-f0-9]{24}$/,QID=/^\d{1,30}$/;
const clone=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>canonical(a)===canonical(b);
const sameScope=(a,b)=>['environment','realmId','connectionId'].every(k=>String(a?.[k])===String(b?.[k]));
const check=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{status:409,code:'GENERAL_CALENDAR_FULFILLMENT_UNVERIFIED'});};
const one=(Model,filter,session)=>{let q=Model.findOne(filter);if(session)q=q.session(session);return q.maxTimeMS(5000).lean();};
const many=(Model,filter,session,limit=3)=>{let q=Model.find(filter);if(session)q=q.session(session);return q.limit(limit).maxTimeMS(5000).lean();};
const claimId=(scope,type,value)=>hash({kind:CLAIM,scope,type,value}).slice(0,24);
const expectedClaims=(scope,logicalKey,qboId)=>[['logicalKey',logicalKey],['Invoice',qboId]].map(([type,value])=>({_id:claimId(scope,type,value),type,value}));
function nativePointer(proof){return Object.fromEntries(['kind','version','authorityId','authorityHash','outcomeId','outcomeHash','bindingHash','invoiceId','estimateId','timeId'].map(key=>[key,proof[key]]));}
function normalizedStep(step){const references=step.references.map(({key,entity,id,syncToken,status,definition})=>({key,entity,id,syncToken,status,definition})).sort((a,b)=>(a.entity+':'+a.key).localeCompare(b.entity+':'+b.key));return {logicalKey:step.logicalKey,entity:step.entity,txnDate:step.txnDate,calendarFingerprint:step.calendarFingerprint,detailsHash:step.detailsHash,details:clone(step.details),references,dependencies:clone(step.dependencies).sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey))};}
function assertPlannedBinding(step,policy,proof,active) {
 const b=proof?.binding,invoice=native.derivedRecord(proof),estimate=native.derivedRelatedRecord(proof,'Estimate'),time=native.derivedRelatedRecord(proof,'TimeActivity');
 check(invoice&&estimate&&time&&b&&proof.kind===native.KIND&&hash(b)===proof.bindingHash,'An authenticated completed native Invoice/Estimate/Time witness is required.');
 check(step.entity==='Invoice'&&step.logicalKey===b.calendar.logicalKey&&step.calendarFingerprint===b.calendar.calendarFingerprint&&step.txnDate===b.calendar.txnDate&&invoice.Id===proof.invoiceId&&estimate.Id===proof.estimateId&&time.Id===proof.timeId,'The native witness belongs to another planned activity.');
 check(active&&sameScope(b.scope,active.scope||b.scope)&&active.authority?.contentHash===b.calendar.authorityHash&&active.value?.businessKey===b.calendar.businessKey&&String(active.value.blueprintId)===String(b.calendar.blueprintId)&&active.value.blueprintHash===b.calendar.blueprintHash&&String(active.value.ownerId)===b.ownerId,'The exact owner publication changed.');
 check(same(step.dependencies.map(({logicalKey,entity,fingerprint})=>({logicalKey,entity,fingerprint})).sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey)),[b.estimate,b.time].map((p,i)=>({logicalKey:p.logicalKey,entity:i?'TimeActivity':'Estimate',fingerprint:p.fingerprint})).sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey))),'The full original managed dependency fingerprints changed.');
 require('./business-operation-plan-store').validateOperationEntry({kind:'create',step,policy},b.scope,step.txnDate,step.txnDate);
 const details=step.details,reference=(entity,key)=>{const rows=step.references.filter(r=>r.entity===entity&&r.key===key);check(rows.length===1,'The resolved planned reference is ambiguous.');return rows[0].id;};
 check(invoice.TxnDate===step.txnDate&&invoice.CurrencyRef?.value==='CAD'&&invoice.CustomerRef?.value===reference('Customer',details.customerKey)&&invoice.GlobalTaxCalculation==='TaxExcluded'&&(!details.dueDate||invoice.DueDate===details.dueDate),'The fulfilled Invoice date, customer, currency or terms differ from the full plan.');
 const sales=(invoice.Line||[]).filter(line=>line.DetailType==='SalesItemLineDetail');
 check(sales.length===details.lines.length&&sales.every((line,i)=>{const intended=details.lines[i],d=line.SalesItemLineDetail;return d?.ItemRef?.value===reference('Item',intended.itemKey)&&d.Qty===intended.quantity&&C.minor(d.UnitPrice)===intended.unitPriceCents&&C.minor(line.Amount)===intended.amountCents&&d.TaxCodeRef?.value===reference('TaxCode',details.taxMapping||'salesTax');}),'The fulfilled Invoice lines differ from the full planned quantities, prices, items or tax codes.');
 const base=C.sum(details.lines.map(line=>line.amountCents)),tax=policy.readbackTax;
 check(tax&&Number.isSafeInteger(tax.totalTaxCents)&&C.minor(invoice.TxnTaxDetail?.TotalTax)===tax.totalTaxCents&&C.minor(invoice.TotalAmt)===C.sum([base,tax.totalTaxCents]),'The fulfilled Invoice gross amount differs from the approved tax policy.');
 const actualTax=(invoice.TxnTaxDetail?.TaxLine||[]).map(line=>({rateId:line.TaxLineDetail?.TaxRateRef?.value,percent:line.TaxLineDetail?.TaxPercent,taxableCents:C.minor(line.TaxLineDetail?.NetAmountTaxable),amountCents:C.minor(line.Amount)}));
 const orderTax=lines=>lines.map(line=>canonical({rateId:line.rateId,percent:line.percent,taxableCents:line.taxableCents,amountCents:line.amountCents})).sort();
 check(Array.isArray(tax.lines)&&same(orderTax(actualTax),orderTax(tax.lines))&&C.minor(invoice.Balance)===C.minor(invoice.TotalAmt),'The fulfilled Invoice native tax allocation or original unpaid balance differs from the exact planned obligation.');
 check(estimate.TxnStatus==='Closed'&&time.BillableStatus==='HasBeenBilled','The native conversion has not closed the exact Estimate and retained billed Time.');
 return {invoice,estimate,time};
}
function auditParams(payload,contentHash){return {kind:KIND,phase:'bound',scope:payload.scope,originHash:contentHash,logicalKey:payload.logicalKey,invoiceId:payload.qboId,authorityHash:payload.authorityHash,nativeOutcomeHash:payload.native.outcomeHash};}
async function authenticateAuthority(models,row,scope,session) {
 check(row&&sameScope(row,scope)&&row.contractVersion===1&&row.contentHash===hash(row.payload)&&row.payload.kind===KIND&&sameScope(row.payload.scope,scope),'The retained calendar fulfillment authority changed.');
 const p=row.payload,a=await one(models.Audits,{_id:row.auditId},session);
 check(a&&String(a.userId)===p.ownerId&&String(a.actorUserId||a.userId)===String(row.actorId)&&a.realmId===scope.realmId&&a.action==='Business calendar fulfillment recorded'&&a.actionType==='manual'&&a.outcome==='success'&&same(a.inputParams,auditParams(p,row.contentHash)),'The calendar fulfillment admission audit changed.');
 for(const c of expectedClaims(scope,p.logicalKey,p.qboId)){const r=await one(models.Authorities,{_id:c._id,...scope},session),expected={version:1,kind:CLAIM,scope,type:c.type,value:c.value,originId:String(row._id),originHash:row.contentHash};check(r&&r.contractVersion===1&&r.contentHash===hash(r.payload)&&same(r.payload,expected)&&String(r.actorId)===String(row.actorId)&&r.auditId===row.auditId,'The forward or reverse calendar fulfillment claim changed.');}
 return row;
}
async function loadNative(models,scope,general,session) {
 const run=await one(models.GeneralWriteRuns,{_id:general.operationId,...scope},session);check(run,'The original General creation is unavailable.');
 const proof=await native.loadProof({models,scope,run,ref:general.ref,session});check(proof&&native.derivedRecord(proof),'The native relationship witness is not completed.');
 return {run,proof};
}
async function loadOrigin({models,scope,logicalKey,qboId,session=null}) {
 scope=scoped(scope);check(models?.Authorities&&models.Audits,'Calendar fulfillment stores are required.');
 const claim=await one(models.Authorities,{_id:claimId(scope,logicalKey?'logicalKey':'Invoice',logicalKey||qboId),...scope},session);
 if(!claim){const prior=await one(models.Authorities,{environment:scope.environment,realmId:scope.realmId,'payload.kind':CLAIM,'payload.type':logicalKey?'logicalKey':'Invoice','payload.value':logicalKey||qboId},session);check(!prior,'A fulfilled origin belongs to an earlier connection and requires reviewed recovery.');return null;}
 check(models.GeneralWriteRuns,'Original General fulfillment source storage is unavailable.');
 check(claim.payload?.kind===CLAIM&&claim.contentHash===hash(claim.payload),'The calendar fulfillment claim is invalid.');
 const row=await authenticateAuthority(models,await one(models.Authorities,{_id:claim.payload.originId,...scope},session),scope,session),p=row.payload;
 check((!logicalKey||p.logicalKey===logicalKey)&&(!qboId||p.qboId===qboId),'The calendar fulfillment claim names another activity.');
 const {proof}=await loadNative(models,scope,p.general,session);check(same(nativePointer(proof),p.native)&&hash(p.step)===p.fingerprint&&hash(p.policy)===p.policyHash&&p.policy.stepHash===p.fingerprint,'The original native or planned fulfillment provenance changed.');
 const recordSnapshots=Object.fromEntries(['Invoice','Estimate','TimeActivity'].map(entity=>[entity,native.derivedRelatedRecord(proof,entity)]));
 check(Object.entries(recordSnapshots).every(([entity,record])=>record&&hash(record)===p.originRecordHashes?.[entity]),'The historical native origin snapshots changed.');
 return {...clone(p),retained:clone(p),authorityId:String(row._id),originHash:row.contentHash,recordSnapshots,nativeProof:proof};
}
async function assertNoFulfillment({models,scope,logicalKey,qboId,session=null}) {
 check(models?.Authorities,'Fulfillment conflict protection is unavailable.');
 for(const [type,value] of [['logicalKey',logicalKey],['Invoice',qboId]].filter(([,v])=>v)){const row=await one(models.Authorities,{environment:scope.environment,realmId:scope.realmId,'payload.kind':CLAIM,'payload.type':type,'payload.value':value},session);check(!row,'This obligation or Invoice already has a distinct calendar fulfillment; creation/dispatch is prohibited.');}
}
async function discover({models,scope,logicalKey,session=null}) {
 const rows=await many(models.Authorities,{...scope,'payload.kind':'general-estimate-native-action','payload.phase':'admitted','payload.plan.source.binding.calendar.logicalKey':logicalKey},session,21);
 check(rows.length<=20,'Native fulfillment source history exceeds its bounded lookup.');
 const sources=new Map();for(const row of rows){const b=row.payload?.plan?.source?.binding;if(b?.kind===native.KIND)sources.set(b.general.operationId+':'+b.general.ref,b.general);}
 check(sources.size<=1,'Several General creations claim this calendar activity.');if(!sources.size)return null;
 const {proof}=await loadNative(models,scope,[...sources.values()][0],session);return proof;
}
function createGeneralCalendarFulfillment({models,transaction,access,assertReady=async()=>{},now=()=>Date.now()}) {
 check(models?.Policies&&models.Writers&&models.Steps&&models.Intents&&typeof transaction==='function'&&typeof access?.authorize==='function','Concrete fulfillment storage and authorization are required.');
 async function resolvePrepared({scope,prepared,active}) {
  scope=scoped(scope);await assertReady();const actor=await access.authorize(scope,'operations.preview');check(actor?.ownerId===String(active.value.ownerId),'The calendar fulfillment reader changed.');
  const result=clone(prepared);
  for(const step of result.steps.filter(step=>step.entity==='Invoice')){const origin=await loadOrigin({models,scope,logicalKey:step.logicalKey});let proof=origin?.nativeProof||await discover({models,scope,logicalKey:step.logicalKey});if(!proof)continue;const b=proof.binding;check(step.calendarFingerprint===b.calendar.calendarFingerprint&&step.txnDate===b.calendar.txnDate&&active.authority.contentHash===b.calendar.authorityHash,'The native witness does not resolve this published calendar step.');step.kind='fulfilled';step.fulfillment={version:1,kind:KIND,general:clone(b.general),native:nativePointer(proof),...(origin?{authorityId:origin.authorityId,authorityHash:origin.originHash}:{})};}
  return result;
 }
 async function freeze({scope,step,policy,active}) {
  scope=scoped(scope);step=normalizedStep(step);await assertReady();
  return transaction(async session=>{
   check(session?.inTransaction?.(),'Calendar fulfillment admission requires a transaction.');const actor=await access.authorize(scope,'operations.preview',{session});check(ID.test(actor?.ownerId||'')&&ID.test(actor?.actorId||''),'The calendar fulfillment actor is unavailable.');
   const policyRow=await one(models.Policies,{environment:scope.environment,realmId:scope.realmId},session);check(policyRow&&sameScope(policyRow,scope)&&policyRow.state==='active'&&Number.isSafeInteger(policyRow.revision),'The company revision fence is unavailable.');
   const fenced=await models.Policies.findOneAndUpdate({_id:policyRow._id,...scope,state:'active',revision:policyRow.revision},{$inc:{revision:1}},{new:true,session}).lean();check(fenced,'The company changed before fulfillment admission.');
   const current=await require('./business-authority').readPublishedBusiness({...models,scope,session});check(HASH.test(current.value.baselineHash||'')&&current.authority.contentHash===active.authority.contentHash&&String(current.value.ownerId)===actor.ownerId,'The published owner authority changed before fulfillment admission.');
   const writer=await one(models.Writers,{environment:scope.environment,realmId:scope.realmId},session);check(writer&&sameScope(writer,scope)&&!writer.unresolved&&!writer.operationId&&(!writer.resourceClaims||writer.resourceClaims.length===0),'Fulfillment admission waits for the settled idle company writer.');
   const proof=await discover({models,scope,logicalKey:step.logicalKey,session});check(proof,'The completed native fulfillment witness is unavailable.');assertPlannedBinding(step,policy,proof,current);
   const old=await loadOrigin({models,scope,logicalKey:step.logicalKey,session});
   if(old){check(old.qboId===proof.invoiceId&&same(old.step,step)&&same(old.policy,policy),'The calendar fulfillment is already bound to different immutable intent.');return {...old,admissionFence:{beforeRevision:policyRow.revision,afterRevision:fenced.revision}};}
   await assertNoFulfillment({models,scope,logicalKey:step.logicalKey,qboId:proof.invoiceId,session});
   const conflict=await one(models.Steps,{environment:scope.environment,realmId:scope.realmId,$or:[{logicalKey:step.logicalKey},{entity:'Invoice',qboId:proof.invoiceId}]},session);check(!conflict,'A managed claim, dispatch or saved record already owns this calendar fulfillment.');
   const intents=await many(models.Intents,{environment:scope.environment,realmId:scope.realmId,logicalKey:step.logicalKey},session);check(intents.length===0,'An existing immutable calendar intent already owns this obligation.');
   const b=proof.binding,payload={version:1,kind:KIND,scope,ownerId:actor.ownerId,actorId:actor.actorId,businessKey:current.value.businessKey,authorityHash:current.authority.contentHash,blueprintId:String(current.value.blueprintId),blueprintHash:current.value.blueprintHash,baselineHash:current.value.baselineHash,logicalKey:step.logicalKey,entity:'Invoice',qboId:proof.invoiceId,fingerprint:hash(step),step,policy:clone(policy),policyHash:hash(policy),dependencies:clone(step.dependencies),originRecordHashes:Object.fromEntries(['Invoice','Estimate','TimeActivity'].map(entity=>[entity,hash(native.derivedRelatedRecord(proof,entity))])),general:clone(b.general),native:nativePointer(proof),admittedAt:new Date(now()).toISOString()};
   const contentHash=hash(payload),originId=contentHash.slice(0,24),auditId=hash({scope,kind:KIND,contentHash}).slice(0,24);
   await models.Audits.create([{_id:auditId,userId:actor.ownerId,...(actor.actorId!==actor.ownerId?{actorUserId:actor.actorId}:{}),realmId:scope.realmId,action:'Business calendar fulfillment recorded',actionType:'manual',outcome:'success',inputParams:auditParams(payload,contentHash)}],{session});
   await models.Authorities.create([{_id:originId,contractVersion:1,...scope,contentHash,payload,actorId:actor.actorId,auditId}],{session});
   for(const c of expectedClaims(scope,step.logicalKey,proof.invoiceId)){const claim={version:1,kind:CLAIM,scope,type:c.type,value:c.value,originId,originHash:contentHash};await models.Authorities.create([{_id:c._id,contractVersion:1,...scope,contentHash:hash(claim),payload:claim,actorId:actor.actorId,auditId}],{session});}
   return {...await loadOrigin({models,scope,logicalKey:step.logicalKey,session}),admissionFence:{beforeRevision:policyRow.revision,afterRevision:fenced.revision}};
  });
 }
 return {resolvePrepared,freeze};
}
function originPointer(origin){return {version:1,kind:KIND,authorityId:origin.authorityId,authorityHash:origin.originHash,logicalKey:origin.logicalKey,qboId:origin.qboId,fingerprint:origin.fingerprint};}
function serializeOrigin(origin){return {kind:KIND,version:1,...clone(origin.retained),retained:clone(origin.retained),authorityId:origin.authorityId,originHash:origin.originHash,recordSnapshots:clone(origin.recordSnapshots)};}
function validateOriginEnvelope(origin){
 const p=origin?.retained;check(p?.kind===KIND&&origin.kind===KIND&&origin.originHash===hash(p)&&origin.fingerprint===hash(p.step)&&origin.fingerprint===p.fingerprint&&origin.policyHash===hash(p.policy)&&p.policy.stepHash===p.fingerprint&&['scope','logicalKey','qboId','step','policy','dependencies','native'].every(k=>same(origin[k],p[k])),'The typed fulfilled origin envelope changed.');
 check(Object.entries(origin.recordSnapshots||{}).length===3&&Object.entries(origin.recordSnapshots).every(([entity,record])=>hash(record)===p.originRecordHashes[entity]),'The immutable native origin snapshot changed.');return p;
}
function fresh(stamp,now){const ms=Date.parse(stamp);return Number.isFinite(ms)&&new Date(ms).toISOString()===stamp&&ms<=now&&now-ms<=300000;}
function checkObserved(value,scope,entity,id,now){check(value&&sameScope(value.scope,scope)&&value.entity===entity&&value.record?.Id===id&&value.recordHash===hash(value.record)&&fresh(value.observedAt,now)&&/^(0|[1-9]\d{0,63})$/.test(value.record.SyncToken||''),'An exact fresh fulfilled-origin record observation is required.');return value.record;}
function receivablesEvidence({origin,observed,accountBinding,accountObserved,report,reportObservedAt,beforeFence,afterFence,now=Date.now()}){
 validateOriginEnvelope(origin);const record=checkObserved(observed,origin.scope,'Invoice',origin.qboId,now),bindings=origin.step.references.filter(r=>r.entity==='Account'&&r.key==='accountsReceivable');
 check(bindings.length===1&&same(bindings[0],accountBinding)&&record.TxnDate===origin.step.txnDate,'The fulfilled Invoice needs its exact approved receivables binding.');
 const account=require('./business-receivables-route').validateExactAccountPosting({scope:origin.scope,entity:'Invoice',record,accountBinding,accountObserved,report,reportObservedAt,beforeFence,afterFence,now});
 const body={version:1,kind:'general-calendar-receivables',scope:origin.scope,logicalKey:origin.logicalKey,fingerprint:origin.fingerprint,originHash:origin.originHash,qboId:origin.qboId,syncToken:record.SyncToken,recordHash:observed.recordHash,accountId:account.Id,accountDefinitionHash:accountBinding.definition.hash,operationId:beforeFence.operationId,writerRevision:beforeFence.revision,observedAt:[observed.observedAt,accountObserved.observedAt,reportObservedAt].sort()[0],source:{originPointer:originPointer(origin),observed:Object.fromEntries(['scope','entity','record','recordHash','observedAt','source'].filter(k=>observed[k]!==undefined).map(k=>[k,clone(observed[k])])),accountBinding,accountObserved,reportJson:JSON.stringify(report),reportHash:hash(report),reportObservedAt,beforeFence,afterFence}};
 return {...body,evidenceHash:hash(body)};
}
function verifyReceivables({origin,observed,operationId,writerRevision,now=Date.now()}){
 const proof=observed?.accountRouting;check(proof?.kind==='general-calendar-receivables'&&proof.originHash===origin.originHash,'Distinct fulfilled-origin receivables proof is required.');
 const source=proof.source;check(same(source.originPointer,originPointer(origin)),'The receivables origin pointer changed.');check(typeof source.reportJson==='string'&&Buffer.byteLength(source.reportJson)<=2000000,'The retained exact GL source is unavailable.');let report;try{report=JSON.parse(source.reportJson);}catch{check(false,'The retained exact GL source is invalid.');}check(hash(report)===source.reportHash,'The retained exact GL source hash changed.');const replayed=receivablesEvidence({...source,origin,report,observed:{...observed,observedAt:source.observed.observedAt,accountRouting:undefined},now});
 check(same(replayed,proof)&&(!operationId||proof.operationId===operationId)&&(writerRevision===undefined||proof.writerRevision===writerRevision),'The fulfilled-origin receivables evidence changed.');return proof.accountId;
}
function proofObservation(value){const fields=['scope','entity','record','recordHash','observedAt','logicalKey','fingerprint','state','qboId','syncToken','compilationHash','creationReceipt'];const result=Object.fromEntries(fields.filter(k=>value[k]!==undefined).map(k=>[k,clone(value[k])]));if(value.accountRouting)result.accountRouting=clone(value.accountRouting);if(value.verification){const p=value.verification;result.verification=Object.fromEntries(['version','kind','scope','entity','logicalKey','qboId','fingerprint','matchesIntent','observedHash','syncToken','observedAt','evidenceHash','compilationHash','relationships'].filter(k=>p[k]!==undefined).map(k=>[k,clone(p[k])]));}return result;}
function verifyContent({origin,observed,parents=[],descendants=[],now=Date.now()}){
 validateOriginEnvelope(origin);const scope=origin.scope,record=checkObserved(observed,scope,'Invoice',origin.qboId,now),base=origin.recordSnapshots.Invoice;
 const nativeBinding=origin.native.bindingHash,expectedParents=[['Estimate',origin.native.estimateId],['TimeActivity',origin.native.timeId]],relationships=[];
 check(parents.length===2,'The complete original Estimate/Time closure is required.');
 for(const [entity,id]of expectedParents){const found=parents.filter(p=>p.entity===entity&&p.record?.Id===id);check(found.length===1,'An original native parent is missing or duplicated.');const parent=found[0],actual=checkObserved(parent,scope,entity,id,now),dependency=origin.dependencies.find(d=>d.logicalKey===parent.logicalKey&&d.entity===entity);check(dependency&&dependency.fingerprint===parent.fingerprint&&same(actual,origin.recordSnapshots[entity]),'A native parent changed outside the authenticated fulfillment.');relationships.push({logicalKey:parent.logicalKey,entity,fingerprint:parent.fingerprint,qboId:id,syncToken:actual.SyncToken});}
 check(descendants.length<=1000,'Too many fulfilled-origin descendants.');const ids=new Set(),paymentLinks=[],applied=[];
 for(const child of descendants){const r=checkObserved(child,scope,'Payment',child.record?.Id,now),receipt=child.creationReceipt,proof=child.verification;check(HASH.test(child.logicalKey||'')&&!ids.has(r.Id)&&receipt?.version===1&&sameScope(receipt.scope,scope)&&receipt.logicalKey===child.logicalKey&&receipt.qboId===r.Id&&HASH.test(receipt.dispatchKey||'')&&HASH.test(receipt.requestHash||'')&&HASH.test(receipt.evidenceHash||'')&&['create-response','request-correlated-readback','owner-attributed-readback'].includes(receipt.source)&&proof?.kind==='business-content'&&proof.matchesIntent===true&&proof.observedHash===child.recordHash&&proof.syncToken===r.SyncToken&&proof.compilationHash===child.compilationHash&&fresh(proof.observedAt,now),'Only independently authenticated managed Payment descendants may change the fulfilled Invoice.');
  const links=proof.relationships?.filter(p=>p.logicalKey===origin.logicalKey);check(links?.length===1&&links[0].entity==='Invoice'&&links[0].fingerprint===origin.fingerprint&&links[0].qboId===origin.qboId&&links[0].syncToken===record.SyncToken&&r.CustomerRef?.value===base.CustomerRef?.value&&r.CurrencyRef?.value==='CAD'&&r.TxnDate>=base.TxnDate&&C.minor(r.UnappliedAmt)===0,'The managed Payment does not prove this exact Invoice/customer/current version.');
  const lines=r.Line||[];check(lines.length>0&&lines.every(line=>line.LinkedTxn?.length===1&&line.LinkedTxn[0].TxnType==='Invoice'&&line.LinkedTxn[0].TxnId===origin.qboId&&C.minor(line.Amount)>0)&&C.sum(lines.map(line=>C.minor(line.Amount)))===C.minor(r.TotalAmt),'The managed Payment allocation differs from this Invoice.');ids.add(r.Id);applied.push(C.minor(r.TotalAmt));paymentLinks.push({TxnId:r.Id,TxnType:'Payment'});
 }
 const paid=C.sum(applied),remaining=C.minor(base.Balance)-paid;check(remaining>=0&&C.minor(record.Balance)===remaining,'The fulfilled Invoice balance is not explained by authenticated managed Payments.');
 const ar=origin.step.references.filter(r=>r.entity==='Account'&&r.key==='accountsReceivable');check(ar.length===1,'The full planned receivables reference is required.');check(record.ARAccountRef!==undefined?record.ARAccountRef?.value===ar[0].id:verifyReceivables({origin,observed,now})===ar[0].id,'The fulfilled Invoice posted to a different receivables account.');
 const expected=clone(base),actual=clone(record);if(expected.ARAccountRef===undefined)delete actual.ARAccountRef;
 if(descendants.length){delete expected.SyncToken;delete actual.SyncToken;if(expected.MetaData)delete expected.MetaData.LastUpdatedTime;if(actual.MetaData)delete actual.MetaData.LastUpdatedTime;delete expected.Balance;delete actual.Balance;delete expected.LinkedTxn;delete actual.LinkedTxn;}
 check(same(expected,actual),'The fulfilled Invoice changed beyond its authenticated native relationship and managed Payments.');
 const order=links=>[...(links||[])].map(link=>canonical(link)).sort();check(same(order(record.LinkedTxn),order([...(base.LinkedTxn||[]),...paymentLinks])),'The fulfilled Invoice reciprocal relationship set is incomplete or unrelated.');
 const observedAt=[observed.observedAt,...parents.map(p=>p.observedAt),...descendants.flatMap(c=>[c.observedAt,c.verification.observedAt]),...(observed.accountRouting?[observed.accountRouting.observedAt]:[])].sort()[0];
 const body={version:1,kind:'general-calendar-content',scope,logicalKey:origin.logicalKey,entity:'Invoice',qboId:origin.qboId,fingerprint:origin.fingerprint,originHash:origin.originHash,nativeBindingHash:nativeBinding,matchesIntent:true,issues:[],observedHash:observed.recordHash,syncToken:record.SyncToken,observedAt,relationships:relationships.sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey)),...(observed.accountRouting?{accountRouting:observed.accountRouting}:{}),source:{originPointer:originPointer(origin),observed:proofObservation(observed),parents:parents.map(proofObservation),descendants:descendants.map(proofObservation)}};
 return {...body,evidenceHash:hash(body)};
}
function verifyReadback(input){const proof=verifyContent(input),now=input.now??Date.now();for(const parent of input.parents||[]){const p=parent.verification;check(parent.state==='verified'&&p?.kind==='business-readback'&&p.matchesIntent===true&&p.observedHash===parent.recordHash&&p.syncToken===parent.record.SyncToken&&fresh(p.observedAt,now),'The managed Estimate/Time parent closure is not freshly verified.');}const body={...proof,kind:READBACK,parentProofs:(input.parents||[]).map(p=>({logicalKey:p.logicalKey,evidenceHash:p.verification.evidenceHash})).sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey))};delete body.evidenceHash;return {...body,evidenceHash:hash(body)};}
function validateReadback(proof,origin,now=Date.now()){
 validateOriginEnvelope(origin);check(proof?.kind===READBACK&&proof.originHash===origin.originHash&&proof.logicalKey===origin.logicalKey&&proof.fingerprint===origin.fingerprint&&proof.qboId===origin.qboId,'The distinct fulfilled-origin readback identity changed.');if(!fresh(proof.observedAt,now))throw Object.assign(new Error('The distinct fulfilled-origin readback expired.'),{status:409,code:'BUSINESS_READBACK_EXPIRED'});check(same(proof.source?.originPointer,originPointer(origin)),'The current readback origin pointer changed.');const regenerated=verifyReadback({...proof.source,origin,now});const {graphEvidenceHash,...content}=proof;check(same(regenerated,content),'The fulfilled-origin current readback content changed.');return proof;
}
function validatePointer(entry,{allowUnbound=false}={}){const p=entry?.fulfillment;check(entry?.kind==='fulfilled'&&entry.step?.entity==='Invoice'&&p?.kind===KIND&&p.version===1,'An explicit typed fulfilled disposition is required.');if(allowUnbound&&!p.authorityId){check(p.native?.kind===native.KIND&&HASH.test(p.native.outcomeHash||'')&&HASH.test(p.native.bindingHash||''),'The readonly native resolution is incomplete.');return;}check(ID.test(p.authorityId||'')&&HASH.test(p.authorityHash||'')&&QID.test(p.qboId||'')&&p.logicalKey===entry.step.logicalKey&&p.fingerprint===hash(entry.step),'The immutable fulfilled origin pointer changed.');}
async function assertEntry({models,scope,entry,session=null}){if(entry.kind!=='fulfilled'){await assertNoFulfillment({models,scope,logicalKey:entry.step.logicalKey,session});return null;}validatePointer(entry);const origin=await loadOrigin({models,scope,logicalKey:entry.step.logicalKey,session});check(origin&&same(originPointer(origin),entry.fulfillment)&&same(origin.step,entry.step)&&same(origin.policy,entry.policy),'The declared fulfilled intent differs from its exact admitted origin.');return origin;}
const VERIFICATION='general-calendar-fulfillment-verification';
function createProofStore({models,now=()=>Date.now()}) {
 async function state({scope,logicalKey,session=null}) {
  const origin=await loadOrigin({models,scope,logicalKey,session});if(!origin)return null;
  let q=models.Authorities.find({...scope,'payload.kind':VERIFICATION,'payload.originHash':origin.originHash}).sort({'payload.revision':-1}).limit(1).maxTimeMS(5000);if(session)q=q.session(session);const rows=await q.lean(),latest=rows.sort((a,b)=>b.payload.revision-a.payload.revision)[0];
  let revision=1,status='saved',verification=null,lastAuditId=null,eventHash=origin.originHash;
  if(latest){const p=latest.payload;check(latest.contentHash===hash(p)&&p.kind===VERIFICATION&&p.originHash===origin.originHash&&sameScope(p.scope,scope)&&Number.isSafeInteger(p.revision)&&p.revision>=2&&['saved','verified','needs-check'].includes(p.state),'The typed fulfillment verification state changed.');const audit=await one(models.Audits,{_id:latest.auditId},session);check(audit&&String(audit.userId)===origin.ownerId&&String(audit.actorUserId||audit.userId)===String(latest.actorId)&&audit.action==='Business calendar fulfillment verification recorded'&&audit.outcome==='success'&&same(audit.inputParams,{scope,originHash:origin.originHash,eventHash:latest.contentHash,operationId:p.operationId,planHash:p.planHash,revision:p.revision,phase:p.phase}),'The typed fulfillment verification audit changed.');const previous=await one(models.Authorities,{...scope,contentHash:p.previousStateHash},session);check(previous&&previous.contentHash===hash(previous.payload)&&(p.revision===2?previous.contentHash===origin.originHash:previous.payload.kind===VERIFICATION&&previous.payload.originHash===origin.originHash&&previous.payload.revision===p.revision-1),'The typed fulfillment verification revision chain changed.');if(p.state==='verified')validateReadback(p.verification,origin,Date.parse(p.recordedAt));revision=p.revision;status=p.state;verification=p.verification;lastAuditId=latest.auditId;eventHash=latest.contentHash;}
  const row={kind:KIND,scope,logicalKey:origin.logicalKey,entity:'Invoice',fingerprint:origin.fingerprint,qboId:origin.qboId,dependencies:clone(origin.dependencies),originHash:origin.originHash,origin:serializeOrigin(origin),revision,state:status,verification,lastAuditId,eventHash};
  return row;
 }
 async function transition(ctx,before,change,phase,session) {
  check(session?.inTransaction?.()&&ctx.kind==='fulfilled'&&['verification-start','verify','needs-check'].includes(phase),'Only typed read-only fulfillment verification transitions are allowed.');
  const current=await state({scope:ctx.scope,logicalKey:ctx.intent.logicalKey,session});check(current&&current.originHash===before.originHash&&current.revision===before.revision&&current.eventHash===before.eventHash,'The fulfilled-origin verification revision changed.');
  const status=change.state,verification=change.verification||null;if(status==='verified')validateReadback(verification,current.origin,now());
  const payload={version:1,kind:VERIFICATION,scope:ctx.scope,originHash:current.originHash,logicalKey:current.logicalKey,qboId:current.qboId,operationId:ctx.intent.operationId,planHash:ctx.intent.planHash,revision:current.revision+1,previousStateHash:current.eventHash,state:status,phase,verification,recordedAt:new Date(now()).toISOString()};const contentHash=hash(payload),auditId=hash({scope:ctx.scope,kind:VERIFICATION,contentHash}).slice(0,24);
  await models.Audits.create([{_id:auditId,userId:current.origin.ownerId,...(ctx.actorId!==current.origin.ownerId?{actorUserId:ctx.actorId}:{}),realmId:ctx.scope.realmId,action:'Business calendar fulfillment verification recorded',actionType:'manual',outcome:'success',inputParams:{scope:ctx.scope,originHash:current.originHash,eventHash:contentHash,operationId:ctx.intent.operationId,planHash:ctx.intent.planHash,revision:payload.revision,phase}}],{session});
  await models.Authorities.create([{_id:contentHash.slice(0,24),contractVersion:1,...ctx.scope,contentHash,payload,actorId:ctx.actorId,auditId}],{session});return state({scope:ctx.scope,logicalKey:ctx.intent.logicalKey,session});
 }
 async function related({scope,logicalKeys,session=null}){const rows=await many(models.Authorities,{...scope,'payload.kind':KIND,'payload.dependencies.logicalKey':{$in:logicalKeys}},session,1001);check(rows.length<=1000,'Fulfilled dependency graph exceeds its bounded capacity.');const result=[];for(const row of rows){const node=await state({scope,logicalKey:row.payload.logicalKey,session});check(node,'A fulfilled dependent origin disappeared.');result.push(node);}return result;}
 return {state,transition,related,origin:input=>loadOrigin({models,...input}),assertEntry:input=>assertEntry({models,...input})};
}
module.exports={KIND,CLAIM,READBACK,normalizedStep,assertPlannedBinding,createGeneralCalendarFulfillment,loadOrigin,assertNoFulfillment,claimId,originPointer,serializeOrigin,validateOriginEnvelope,receivablesEvidence,verifyReceivables,verifyContent,verifyReadback,validateReadback,validatePointer,assertEntry,createProofStore,VERIFICATION};
