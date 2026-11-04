'use strict';
// Typed native source: an accepted time-only General Invoice and its original
// managed quote/time chain. Never supplies an SDK creation receipt or an API write.
const {hash,canonical}=require('./business-calendar');
const {sameQboValue,matchesQboRequest}=require('./qbo-semantic-compare');
const recovery=require('./general-estimate-recovery');
const KIND='calendar-time-invoice-estimate-link';
const NATIVE='general-estimate-native-action',EVENT='general-estimate-native-event';
const QID=/^\d{1,30}$/,proofs=new WeakMap();
const clone=v=>JSON.parse(JSON.stringify(v));
const check=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{status:409,code:'GENERAL_TIME_ESTIMATE_HELD'});};
const same=(a,b)=>canonical(a)===canonical(b);
const scopeMatches=(a,b)=>['environment','realmId','connectionId'].every(k=>String(a?.[k])===String(b?.[k]));
const one=(Model,filter,session)=>{check(Model?.findOne,'Required native source storage is unavailable');let q=Model.findOne(filter);if(session)q=q.session(session);return q.maxTimeMS(3000).lean();};
const header=r=>(r?.LinkedTxn||[]).map(l=>({TxnId:l.TxnId,TxnType:l.TxnType})).sort((a,b)=>(a.TxnType+a.TxnId).localeCompare(b.TxnType+b.TxnId));
const sales=r=>(r?.Line||[]).filter(l=>l.DetailType==='SalesItemLineDetail');
const allLinks=r=>[...(r?.LinkedTxn||[]),...(r?.Line||[]).flatMap(l=>l.LinkedTxn||[])];
const nativeId=(scope,run,source)=>hash({version:1,kind:NATIVE,scope,operationId:String(run._id),ref:source.ref,invoiceId:source.item.qboId,estimateId:source.estimateId,receiptId:source.receiptId});
function invoiceCandidate(item){return item?.entity==='Invoice' && item.op==='create' && item.outcome==='saved' && item.complete===true && item.request?.LinkedTxn?.length===1 && item.request.LinkedTxn[0].TxnType==='TimeActivity' && QID.test(item.request.LinkedTxn[0].TxnId||'');}
async function managedParent({models,scope,ownerId,step,session,completedOrigin=false}) {
 check(step&&scopeMatches(step,scope)&&step.contractVersion===1&&(completedOrigin?['saved','verified','needs-check'].includes(step.state):step.state==='verified')&&QID.test(step.qboId||'')&&step.compilation&&step.receipt&&step.dispatch,'A verified original managed parent is required');
 const intent=await one(models.Intents,{...scope,planHash:step.planHash,logicalKey:step.logicalKey},session),run=await one(models.Runs,{_id:step.operationId,...scope},session),plan=run&&await one(models.Plans,{_id:run.planId,...scope,planHash:step.planHash},session);
 check(intent&&run&&plan&&intent.kind==='create'&&String(plan.createdBy)===ownerId&&String(run.createdBy)===ownerId&&run.status==='verified'&&hash(plan.manifest)===plan.planHash&&plan.planHash===run.planHash&&hash(intent.step)===step.fingerprint&&intent.fingerprint===step.fingerprint&&String(intent.planId)===String(plan._id),'Managed parent original approved intent changed');
 require('./business-period-store').assertRunApproval(run);
 require('./business-operation-plan-store').validateOperationEntry({kind:'create',step:intent.step,policy:intent.policy},scope,plan.manifest.fromDate,plan.manifest.throughDate);
 const entry=plan.manifest.records.filter(r=>r.logicalKey===step.logicalKey);check(entry.length===1&&entry[0].fingerprint===step.fingerprint&&entry[0].kind==='create','Managed parent original manifest differs');
 const request=require('./business-readback').validateCompilation(step.compilation);
 check(step.compilation.logicalKey===step.logicalKey&&step.compilation.intentHash===step.fingerprint&&step.compilation.entity===step.entity&&step.dispatch.requestHash===request.requestHash&&step.dispatch.compilationHash===step.compilation.compilationHash&&(completedOrigin||(step.verification?.compilationHash===step.compilation.compilationHash&&step.verification.syncToken===step.receipt.syncToken)),'Managed parent original compilation changed');
 const receiptId=hash({scope,dispatchKey:step.dispatch.key}),receipt=await one(models.Receipts,{_id:receiptId,...scope},session),transport=receipt&&require('./business-dispatch-receipt').businessTransportEvidence({...scope,operationId:String(step.operationId),logicalKey:step.logicalKey,entity:step.entity,dispatch:step.dispatch},receipt);
 check(transport&&String(receipt.ownerId)===ownerId&&transport.result.receipt.qboId===step.qboId&&transport.result.receipt.syncToken===step.receipt.syncToken&&transport.result.receipt.evidenceHash===step.receipt.evidenceHash,'Original managed parent transport receipt changed');
 const audits=[];for(const expected of transport.audits)audits.push(await one(models.Audits,{_id:expected.id,realmId:scope.realmId},session));require('./business-dispatch-receipt').assertBusinessTransportAudits(receipt,transport,audits);
 return {step,intent,plan,run,request:JSON.parse(request.body),receiptId,requestHash:request.requestHash,receiptEvidenceHash:step.receipt.evidenceHash,identity:{logicalKey:step.logicalKey,qboId:step.qboId,operationId:String(step.operationId),planHash:step.planHash,fingerprint:step.fingerprint,compilationHash:step.compilation.compilationHash,receiptId,requestHash:request.requestHash,receiptEvidenceHash:step.receipt.evidenceHash}};
}
function bindingRecord(binding,key){const value=binding[key];return typeof value==='string'?value:value?.id;}
async function nativeLineage({models,scope,root,session}) {
 const rootPlan=root?.payload?.plan;check(root&&root.contentHash===hash(root.payload)&&root.payload.kind===NATIVE&&root.payload.phase==='admitted'&&rootPlan?.source?.kind===KIND&&rootPlan.attempt===1&&rootPlan.actionId===root.payload.actionId,'Typed native root authority changed');
 const nodes=[];let current=root,rootStopReason=null;
 for(let attempt=1;attempt<=4;attempt++){
  const p=current.payload,plan=p.plan;check(current.contentHash===hash(p)&&p.kind===NATIVE&&p.phase==='admitted'&&String(current._id)===plan.actionId.slice(0,24)&&scopeMatches(current,scope)&&scopeMatches(plan.scope,scope)&&plan.attempt===attempt&&plan.rootActionId===rootPlan.actionId&&plan.source.kind===KIND&&same(plan.source,rootPlan.source)&&plan.ownerId===rootPlan.ownerId&&plan.actorId===rootPlan.actorId&&plan.invoiceId===rootPlan.invoiceId&&plan.estimateId===rootPlan.estimateId,'Typed native replacement source changed');await nativeAudit(models,current,'admitted',session);
  const id=plan.actionId,outcome=await one(models.Authorities,{_id:hash({actionId:id,phase:'verified'}).slice(0,24),...scope},session),stop=await one(models.Authorities,{_id:hash({actionId:id,phase:'no-effect'}).slice(0,24),...scope},session);check(!(outcome&&stop),'Native action has conflicting saved/no-effect outcomes');nodes.push({admitted:current,outcome});
  if(outcome||!stop)break;
  const s=stop.payload;check(stop.contentHash===hash(s)&&s.phase==='no-effect'&&s.actionId===id&&s.authorityHash===current.contentHash&&s.noDraft?.onlyHomepage===true&&unchangedParent(plan.before.invoice,s.after?.invoice,'Invoice')&&unchangedParent(plan.before.estimate,s.after?.estimate,'Estimate')&&unchangedParent(plan.before.time,s.after?.time,'TimeActivity')&&same(require('./general-estimate-native').reportShape(plan.beforeReport,plan.reportScope.dates),require('./general-estimate-native').reportShape(s.afterReport,plan.reportScope.dates)),'Typed predecessor no-effect proof changed');await nativeAudit(models,stop,'no-effect',session);
  const native=require('./general-estimate-native');if(attempt===1)rootStopReason=s.reason;
  if(s.reason===native.BLANK_DESCRIPTION_STOP){const cleanup=await one(models.Authorities,{_id:hash({actionId:id,phase:'draft-cleanup-complete'}).slice(0,24),...scope},session);check(attempt===1&&native.blankOptionalDescription(plan.before.invoice)&&/^[a-f0-9]{64}$/.test(s.stopEvidence?.sha256||'')&&cleanup&&cleanup.contentHash===hash(cleanup.payload)&&cleanup.payload.authorityHash===current.contentHash&&cleanup.payload.proof?.onlyHomepage===true&&cleanup.payload.proof.invoiceId===plan.invoiceId&&cleanup.payload.proof.runId===plan.runId&&same(cleanup.payload.proof,s.cleanup),'Blank optional Description root lacks exact journaled cleanup');await nativeAudit(models,cleanup,'draft-cleanup-complete',session);}

  const used=await one(models.Authorities,{_id:hash({actionId:id,phase:'replacement-admitted'}).slice(0,24),...scope},session);if(!used)break;
  const nextId=require('./general-estimate-native').replacementId(rootPlan.actionId,stop.contentHash),u=used.payload;check(attempt<4&&u.phase==='replacement-admitted'&&used.contentHash===hash(u)&&u.actionId===id&&u.authorityHash===current.contentHash&&u.noEffectHash===stop.contentHash&&u.successorActionId===nextId&&(rootStopReason===native.BLANK_DESCRIPTION_STOP?attempt===1&&s.reason===native.BLANK_DESCRIPTION_STOP:['native-executable-unavailable','missing-invoice-document-number','unrestored-informational-draft-notice'][attempt-1]===s.reason),'Typed native replacement consumption changed');await nativeAudit(models,used,'replacement-admitted',session);
  const next=await one(models.Authorities,{_id:nextId.slice(0,24),...scope},session),np=next?.payload?.plan;check(next&&next.contentHash===u.successorAuthorityHash&&np?.predecessor?.actionId===id&&np.predecessor.authorityHash===current.contentHash&&np.predecessor.noEffectHash===stop.contentHash&&np.actionId===nextId,'Exact consumed native successor is unavailable');current=next;
 }
 return nodes;
}
async function loadSourceState({models,scope,run,ref,session=null,now=Date.now(),retained=null},completedOrigin=false) {
 const item=run.items?.[ref];if(!invoiceCandidate(item)||run.caseAuthority)return null;
 const batches=run.batches.filter(b=>b.attempt===item.attempt&&b.items?.some(i=>i.ref===ref));check(batches.length===1,'Original time-only Invoice batch is ambiguous');
 const receipt=await one(models.Receipts,{_id:batches[0].transport?.receiptId,...scope},session),source=recovery.creationSourceOf(run,ref,receipt,'Invoice','saved');
 check(source&&item.complete===true&&allLinks(source.original).length===1&&same(header(source.original),header(source.wanted)),'Exact accepted time-only Invoice creation receipt is required');
 const timeId=source.wanted.LinkedTxn[0].TxnId,timeStep=await one(models.Steps,{...scope,entity:'TimeActivity',qboId:timeId},session),time=await managedParent({models,scope,ownerId:String(run.ownerId),step:timeStep,session,completedOrigin});
 check(time.intent.step.dependencies.length===1&&time.intent.step.dependencies[0].entity==='Estimate','Time must belong to one original managed estimate');
 const estimateStep=await one(models.Steps,{...scope,logicalKey:time.intent.step.dependencies[0].logicalKey,entity:'Estimate'},session),estimate=await managedParent({models,scope,ownerId:String(run.ownerId),step:estimateStep,session,completedOrigin});
 check(time.intent.step.dependencies[0].fingerprint===estimate.step.fingerprint&&time.plan.manifest.businessKey===estimate.plan.manifest.businessKey,'Original time and estimate chain changed');
 source.estimateId=estimate.step.qboId;source.sourceKind=KIND;
 const rootId=nativeId(scope,run,source);retained ||= await one(models.Authorities,{_id:rootId.slice(0,24),...scope},session);
 let before=null,binding,lineage=null;
 if(retained){const p=retained.payload,plan=p?.plan,root=p?.actionId===rootId?retained:await one(models.Authorities,{_id:rootId.slice(0,24),...scope},session);lineage=await nativeLineage({models,scope,root,session});check(lineage.some(n=>String(n.admitted._id)===String(retained._id)&&n.admitted.contentHash===retained.contentHash)&&plan?.source?.kind===KIND&&plan.source.bindingHash===hash(plan.source.binding)&&plan.source.binding.general.receiptId===source.receiptId&&plan.source.binding.general.originalHash===hash(source.original),'Retained typed native source authority changed');binding=plan.source.binding;before=plan.before;}
 else {
  const active=await require('./business-authority').readPublishedBusiness({...models,scope,session}),view={...scope,draft:active.view},day=source.original.TxnDate;
  check(String(active.value.ownerId)===String(run.ownerId)&&active.calendar.currentOperationId===null&&!active.calendar.pendingCommit,'Native calendar fulfillment waits for the idle owner-scoped calendar');
  const activity=require('./business-activity-preview').previewBusinessActivity(view,{connectionId:scope.connectionId,baseHash:active.view.contentHash,fromDate:day,throughDate:day},require('./business-activity-preview').businessDate(new Date(now)));
  const events=activity.events.filter(e=>e.entity==='Invoice'&&e.dependsOn.includes(time.step.logicalKey)&&e.dependsOn.includes(estimate.step.logicalKey));check(events.length===1,'Exact published scheduled invoice is required');
  const event=events[0],details=activity.detailProposal.byLogicalKey[event.logicalKey].details;
  check(active.value.businessKey===time.plan.manifest.businessKey&&details.customerKey&&bindingRecord(active.view.masterBindings,details.customerKey)===source.original.CustomerRef?.value,'Published scheduled customer differs from the original Invoice');
  const lines=sales(source.original);check(lines.length===1&&details.lines.length===1&&bindingRecord(active.view.masterBindings,details.lines[0].itemKey)===lines[0].SalesItemLineDetail.ItemRef.value&&details.lines[0].quantity===lines[0].SalesItemLineDetail.Qty&&details.lines[0].unitPriceCents===Math.round(lines[0].SalesItemLineDetail.UnitPrice*100)&&details.lines[0].amountCents===Math.round(lines[0].Amount*100)&&(!details.dueDate||details.dueDate===source.original.DueDate),'Published scheduled Invoice economics/date differ from the accepted original');
  check(!await one(models.Steps,{...scope,logicalKey:event.logicalKey},session)&&!await one(models.Intents,{...scope,logicalKey:event.logicalKey},session),'A planned Invoice already has a retained intent or dispatch; do not create an alternate binding');
  binding={version:1,kind:KIND,scope,ownerId:String(run.ownerId),actorId:String(run.actorId),general:{operationId:String(run._id),ref,receiptId:source.receiptId,requestHash:source.requestHash,originalHash:hash(source.original)},calendar:{logicalKey:event.logicalKey,calendarFingerprint:event.fingerprint,txnDate:day,businessKey:active.value.businessKey,authorityHash:active.authority.contentHash,blueprintId:active.value.blueprintId,blueprintHash:active.value.blueprintHash},estimate:estimate.identity,time:time.identity};
 }
 check(same(binding.estimate,estimate.identity)&&same(binding.time,time.identity)&&binding.general.operationId===String(run._id)&&binding.general.ref===ref&&binding.general.requestHash===source.requestHash&&binding.ownerId===String(run.ownerId)&&binding.actorId===String(run.actorId)&&scopeMatches(binding.scope,scope),'Native parent/source binding changed');
 const mirror=async(entity,id)=>{const row=await one(models.Records,{...scope,entity,qboId:id,deleted:false},session);check(row?.record?.Id===id,'Original managed parent mirror is unavailable');return row.record;};
 estimate.original=before?.estimate||await mirror('Estimate',estimate.step.qboId);time.original=before?.time||await mirror('TimeActivity',time.step.qboId);
 source.timeParent=time;
 const completed=lineage?.some(node=>node.outcome);
 if(!completed)check(!await one(models.Steps,{...scope,logicalKey:binding.calendar.logicalKey},session)&&!await one(models.Intents,{...scope,logicalKey:binding.calendar.logicalKey},session),'Planned Invoice ownership changed before native fulfillment');
 const state={scope,run,source,estimate,time,binding,bindingHash:hash(binding)};
 assertBefore(state,{invoice:source.original,estimate:estimate.original,time:time.original});return state;
}
// Public source loading is always strict for a new native admission.
function loadSource(options){return loadSourceState(options);}
function linksFor(state){return [...header(state.source.original),{TxnId:state.source.estimateId,TxnType:'Estimate'}];}
function assertBefore(state,before) {
 const {source,estimate,time}=state,i=before.invoice,e=before.estimate,t=before.time;
 check(i?.Id===source.item.qboId&&sameQboValue(source.original,i,{entity:'Invoice'})&&same(header(i),[{TxnId:time.step.qboId,TxnType:'TimeActivity'}])&&allLinks(i).length===1,'The original Invoice/time relationship changed');
 check(e?.Id===estimate.step.qboId&&e.SyncToken===estimate.step.receipt.syncToken&&['Pending','Accepted'].includes(e.TxnStatus)&&allLinks(e).length===0&&matchesQboRequest(estimate.request,e,{entity:'Estimate'}),'Exact original unconverted managed Estimate is required');
 check(t?.Id===time.step.qboId&&t.SyncToken===time.step.receipt.syncToken&&t.BillableStatus==='HasBeenBilled'&&matchesQboRequest({...time.request,BillableStatus:'HasBeenBilled'},t,{entity:'TimeActivity'})&&allLinks(t).length===0,'The original billed TimeActivity changed');
 const il=sales(i),el=sales(e),economy=l=>({Amount:l.Amount,ItemRef:l.SalesItemLineDetail?.ItemRef?.value,Qty:l.SalesItemLineDetail?.Qty,UnitPrice:l.SalesItemLineDetail?.UnitPrice,TaxCodeRef:l.SalesItemLineDetail?.TaxCodeRef?.value});
 check(il.length===1&&el.length===1&&same(economy(il[0]),economy(el[0]))&&i.CustomerRef?.value===e.CustomerRef?.value&&t.CustomerRef?.value===i.CustomerRef?.value&&t.ItemRef?.value===il[0].SalesItemLineDetail.ItemRef.value&&t.Hours+(t.Minutes||0)/60===il[0].SalesItemLineDetail.Qty&&i.CurrencyRef?.value==='CAD'&&e.CurrencyRef?.value==='CAD'&&i.TotalAmt>0&&i.Balance===i.TotalAmt&&i.TotalAmt===e.TotalAmt&&i.GlobalTaxCalculation===e.GlobalTaxCalculation&&sameQboValue(i.TxnTaxDetail,e.TxnTaxDetail),'Exact unpaid whole-quote Invoice economics and billed time are required');
}
function unchangedParent(original,current,entity){return Boolean(current&&current.Id===original.Id&&current.SyncToken===original.SyncToken&&current.sparse!==true&&sameQboValue(original,current,{entity}));}
function assertAfter(state,after,{before=state,assignedMissingDocNumber=null}={}) {
 const original=state.source.original,i=after.invoice,e=after.estimate,t=after.time,quote=state.estimate.original;
 check(i?.Id===original.Id&&e?.Id===quote.Id&&same(header(i),linksFor(state).sort((a,b)=>(a.TxnType+a.TxnId).localeCompare(b.TxnType+b.TxnId)))&&same(header(e),[{TxnId:original.Id,TxnType:'Invoice'}])&&e.TxnStatus==='Closed','Native conversion must retain the original Time link and add only the exact Estimate/backlink');
 check(unchangedParent(state.time.original,t,'TimeActivity'),'Native conversion changed the original billed TimeActivity');
 const beforeLine=sales(original),afterLine=sales(i),quoteLine=sales(quote);check(beforeLine.length===1&&afterLine.length===1&&quoteLine.length===1,'Native conversion must retain exactly one original financial line');
 const allowedLine=afterLine[0].LinkedTxn;
 check(allowedLine===undefined||same(allowedLine,[{TxnId:quote.Id,TxnType:'Estimate'}])||same(allowedLine,[{TxnId:quote.Id,TxnType:'Estimate',TxnLineId:quoteLine[0].Id}]),'Native Invoice line gained an unrelated link');
 const invoiceView=r=>{const v=clone(r);delete v.LinkedTxn;if(assignedMissingDocNumber&&v.DocNumber===undefined)v.DocNumber=assignedMissingDocNumber;for(const l of v.Line||[])if(l.DetailType==='SalesItemLineDetail'){delete l.Id;delete l.LinkedTxn;}return v;};
 check(sameQboValue(invoiceView(original),invoiceView(i),{entity:'Invoice',metadata:true})&&Number.isFinite(Date.parse(i.MetaData?.LastUpdatedTime))&&i.MetaData?.CreateTime===original.MetaData?.CreateTime&&BigInt(i.SyncToken)>BigInt(original.SyncToken),'Native conversion changed an original Invoice field or did not advance its version');
 check(recovery.assertEstimateTransition(quote,e,original.Id),'Native conversion changed the original Estimate beyond its sole Invoice link/closure');
 return true;
}
async function nativeAudit(models,row,phase,session) {
 const p=row.payload,plan=phase==='admitted'?p.plan:null,id=String(row._id),expected=hash({id,contentHash:row.contentHash}).slice(0,24),audit=await one(models.Audits,{_id:expected,realmId:row.realmId},session);
 check(String(row.auditId)===expected&&audit&&String(audit.userId)===p.ownerId&&audit.action==='Native saved Invoice estimate repair '+phase&&audit.actionType==='ai_executed'&&audit.aiDriven===true&&audit.tool==='browser'&&audit.outcome===(phase==='verified'?'success':'partial')&&audit.afterState?.authorityHash===row.contentHash&&audit.afterState.actionId===p.actionId,'Typed native source audit is unavailable or changed');return plan;
}
async function loadProof({models,scope,run,ref,session=null}) {
 if(!invoiceCandidate(run.items?.[ref])||!models.Authorities?.findOne)return null;
 const admitted=await one(models.Authorities,{...scope,'payload.kind':NATIVE,'payload.phase':'admitted','payload.plan.source.kind':KIND,'payload.plan.operationId':String(run._id),'payload.plan.ref':ref,'payload.plan.attempt':1},session);if(!admitted)return null;
 const p=admitted.payload,plan=p.plan;check(admitted.contentHash===hash(p)&&p.actionId===plan.actionId&&plan.source.bindingHash===hash(plan.source.binding)&&scopeMatches(admitted,scope)&&scopeMatches(plan.scope,scope),'Typed native authority changed');await nativeAudit(models,admitted,'admitted',session);
 const lineage=await nativeLineage({models,scope,root:admitted,session}),winner=lineage.find(node=>node.outcome);if(!winner)return null;
 const completion=winner.admitted,completionPlan=completion.payload.plan,outcome=winner.outcome;
 check(outcome.contentHash===hash(outcome.payload)&&outcome.payload.kind===EVENT&&outcome.payload.phase==='verified'&&outcome.payload.actionId===completionPlan.actionId&&outcome.payload.authorityHash===completion.contentHash&&outcome.payload.sourceKind===KIND&&outcome.payload.bindingHash===plan.source.bindingHash&&outcome.payload.beforeReportHash===hash(completionPlan.beforeReport),'Typed native completion changed');await nativeAudit(models,outcome,'verified',session);
 check(same(require('./general-estimate-native').reportShape(completionPlan.beforeReport,completionPlan.reportScope.dates),require('./general-estimate-native').reportShape(outcome.payload.afterReport,completionPlan.reportScope.dates)),'Typed native completion changed TrialBalance');
 // Only authenticated completed origins may ignore mutable graph-verification state.
 // Immutable creation receipts, parent compilation/dispatch, binding and native snapshots still authenticate below.
 const state=await loadSourceState({models,scope,run,ref,session,retained:admitted},true);
 check(state&&state.bindingHash===plan.source.bindingHash&&plan.invoiceId===state.source.item.qboId&&plan.estimateId===state.source.estimateId,'Typed native source no longer matches its original work');
 if(completionPlan.assignedMissingDocNumber)check(await recovery.loadNativeAssignment({models,scope,source:state.source,estimateOriginal:state.estimate.original,actionId:completionPlan.actionId,authorityHash:completion.contentHash,session}),'Typed native document-number authority changed');
 assertAfter(state,outcome.payload.after,{assignedMissingDocNumber:completionPlan.assignedMissingDocNumber});
 const proof=Object.freeze({kind:KIND,version:1,authorityId:String(completion._id),authorityHash:completion.contentHash,rootAuthorityId:String(admitted._id),rootAuthorityHash:admitted.contentHash,outcomeId:String(outcome._id),outcomeHash:outcome.contentHash,binding:clone(state.binding),bindingHash:state.bindingHash,invoiceId:plan.invoiceId,estimateId:plan.estimateId,timeId:state.time.step.qboId});proofs.set(proof,{after:clone(outcome.payload.after),original:state.source.original});return proof;
}
function derivedRecord(proof){return proofs.has(proof)?clone(proofs.get(proof).after.invoice):null;}
function derivedRelatedRecord(proof,entity){const key={Invoice:'invoice',Estimate:'estimate',TimeActivity:'time'}[entity];return key&&proofs.has(proof)?clone(proofs.get(proof).after[key]):null;}
function requestView(current,proof){
 const known=proofs.get(proof);if(!known||current?.Id!==proof.invoiceId)return null;
 const quoted=(current.LinkedTxn||[]).filter(l=>l.TxnType==='Estimate');if(quoted.length!==1||quoted[0].TxnId!==proof.estimateId||!(current.LinkedTxn||[]).some(l=>l.TxnType==='TimeActivity'&&l.TxnId===proof.timeId))return null;
 const view=clone(current);view.LinkedTxn=view.LinkedTxn.filter(l=>l.TxnType!=='Estimate');return view;
}
module.exports={KIND,invoiceCandidate,loadSource,assertBefore,assertAfter,linksFor,unchangedParent,loadProof,derivedRecord,derivedRelatedRecord,requestView};
