'use strict';
// Native repair of an already-saved general Invoice. This is a distinct browser
// action, never an SDK receipt, a new Invoice create, or a legacy managed Step.
const {hash,canonical}=require('./business-calendar');
const {scoped,freezeWriteRequest}=require('./qbo-write-contract');
const {readWritePeriodEvidence,assertWritePeriod}=require('./qbo-write-period');
const {sameQboValue}=require('./qbo-semantic-compare');
const recovery=require('./general-estimate-recovery');
const timeEstimate=require('./general-time-estimate-source');
const KIND='general-estimate-native-action',EVENT='general-estimate-native-event';
const MAX_READS=24,MAX_NATIVE_MS=240000;
const BLANK_DESCRIPTION_STOP='unproved-blank-optional-description';
function fail(message){throw Object.assign(new Error(message),{status:409,code:'GENERAL_ESTIMATE_NATIVE_HELD'});}
const check=(ok,message)=>{if(!ok)fail(message);};
const clone=v=>JSON.parse(JSON.stringify(v));
const one=(Model,filter,session)=>{let q=Model.findOne(filter);if(session)q=q.session(session);return q.maxTimeMS(3000).lean();};
const links=r=>[...(r?.LinkedTxn||[]),...(r?.Line||[]).flatMap(line=>line.LinkedTxn||[])];
function unchanged(original,current,entity){
  if(!current||current.Id!==original.Id||current.SyncToken!==original.SyncToken||current.sparse===true||links(current).length)return false;
  const view=r=>{const v=clone(r);if(!v.LinkedTxn?.length)delete v.LinkedTxn;return v;};
  return sameQboValue(view(original),view(current),{entity});
}
function compatiblePair(invoice,estimate) {
  const sales=r=>(r.Line||[]).filter(l=>l.DetailType!=='SubTotalLineDetail');
  const a=sales(invoice),b=sales(estimate),financial=line=>{const v=clone(line);delete v.Id;delete v.Description;return v;};
  return invoice.CustomerRef?.value===estimate.CustomerRef?.value && /^\d{1,30}$/.test(invoice.CustomerRef?.value||'') &&
    invoice.CurrencyRef?.value==='CAD' && estimate.CurrencyRef?.value==='CAD' &&
    Number.isFinite(invoice.TotalAmt) && invoice.TotalAmt>0 && invoice.TotalAmt===estimate.TotalAmt && invoice.Balance===invoice.TotalAmt &&
    invoice.GlobalTaxCalculation===estimate.GlobalTaxCalculation && sameQboValue(invoice.TxnTaxDetail,estimate.TxnTaxDetail) &&
    a.length===1 && b.length===1 && a[0].DetailType==='SalesItemLineDetail' && b[0].DetailType==='SalesItemLineDetail' &&
    Number.isFinite(a[0].SalesItemLineDetail?.Qty) && a[0].SalesItemLineDetail.Qty>0 && Number.isFinite(a[0].SalesItemLineDetail?.UnitPrice) &&
    a[0].Amount>0 && sameQboValue(financial(a[0]),financial(b[0])) && ['Pending','Accepted'].includes(estimate.TxnStatus);
}
function completeCustomer(customer,id) {
  return customer?.Id===id && customer.sparse!==true && /^\d+$/.test(customer.SyncToken||'') &&
    require('./general-write-merge').isComplete('Customer',customer) && customer.Active===true &&
    typeof customer.DisplayName==='string' && customer.DisplayName.length>0 && Number.isFinite(customer.Balance) &&
    Number.isFinite(Date.parse(customer.MetaData?.CreateTime)) && Number.isFinite(Date.parse(customer.MetaData?.LastUpdatedTime)) &&
    (!customer.CurrencyRef || customer.CurrencyRef.value==='CAD');
}
function reportShape(report,dates){
  check(report?.Header?.ReportName==='TrialBalance'&&report.Header.ReportBasis==='Accrual'&&report.Header.StartPeriod===dates.from&&report.Header.EndPeriod===dates.through&&report.Header.Currency==='CAD'&&Array.isArray(report.Columns?.Column)&&report.Columns.Column.length>=2&&Array.isArray(report.Rows?.Row)&&report.Rows.Row.length>0,'Complete unfiltered CAD accrual TrialBalance is required.');
  return {columns:report.Columns,rows:report.Rows};
}
function actionId(scope,run,source){return hash({version:1,kind:KIND,scope,operationId:String(run._id),ref:source.ref,invoiceId:source.item.qboId,estimateId:source.estimateId,receiptId:source.receiptId});}
function replacementId(rootActionId,noEffectHash){return hash({version:1,kind:KIND,rootActionId,noEffectHash});}
function blankOptionalDescription(invoice){const lines=(invoice?.Line||[]).filter(line=>line.DetailType==='SalesItemLineDetail');return lines.length===1&&[undefined,null,''].includes(lines[0].Description);}
function promptFor(plan){
  const i=plan.before.invoice,e=plan.before.estimate,line=i.Line.filter(l=>l.DetailType!=='SubTotalLineDetail')[0];
  return [
    'Windows command rule: use the persistent general Node REPL for filesystem/command work, child_process execFile/spawn with windowsHide:true, explicit argument arrays and no shell wrapper. Do not use exec_command/write_stdin, or browser/CUA REPL for general commands. If the hidden Node route is unavailable, stop. Never expose credentials; use the coordinated session as authenticated by the private helper.',
    'Authorized native QuickBooks repair ONLY. Production My Business company '+plan.scope.realmId+' (ending2856). Use the existing coordinated qbo-ops browser; retain its lease. Actor is '+plan.actorProvenance+'.',
    'Modify existing Invoice '+i.Id+' ONLY to attach exact Estimate '+e.Id+'. Do not create an invoice, payment, credit, customer, or any other record. Do not delete/void a transaction, change settings, use APIs/network shortcuts or edit repository files.',
    'Open https://qbo.intuit.com/app/invoice?txnId='+i.Id+'. Confirm company and invoice identity before any input. If wrong company/record, sign-in challenge or stale record: stop.',
    'Preserve original DocNumber '+JSON.stringify(plan.assignedMissingDocNumber||i.DocNumber)+', customer '+JSON.stringify(i.CustomerRef)+', TxnDate '+i.TxnDate+', DueDate '+i.DueDate+', currency CAD, GlobalTaxCalculation '+i.GlobalTaxCalculation+', invoice total '+i.TotalAmt+', balance '+i.Balance+', full tax '+JSON.stringify(i.TxnTaxDetail)+', and all other fields.',
    ...(plan.assignedMissingDocNumber?['The original accepted invoice has no DocNumber. Fill ONLY that missing required field with '+plan.assignedMissingDocNumber+' before Save. This server-derived number was checked unused. Never alter an existing number; STOP on any duplicate-number warning.']:[]),
    'The blue inline informational notice "You have a draft saved. Restore draft" may be present. Leave that stored editor draft untouched: NEVER click Restore draft or delete/discard it. Ignore ONLY this optional notice and use the freshly loaded server-saved Invoice already displayed. BEFORE any input, confirm the visible customer, dates, original line and total match this plan. Actual validation errors, duplicate-number warnings, changed tax/money/company or a restored/changed form are still stop conditions.',
    ...(plan.source.kind===timeEstimate.KIND?['This saved invoice already bills exact TimeActivity '+plan.before.time.Id+'. Preserve its existing TimeActivity link and billed state. Add only Estimate '+e.Id+'; do not replace or rebill the time. Before clicking Add, verify exact Estimate transaction identity '+e.Id+' through native UI/DOM identity or an independently opened native Estimate page. Amount/date/customer alone are insufficient. If the exact candidate ID cannot be verified, stop before Add or Save and report that identity could not be proved. Do not use network or application-state shortcuts.']:[]),
    'Exact source is Estimate '+e.Id+' only. Use the native add/copy whole-estimate procedure into this EXISTING invoice. If copying creates a duplicate financial line, remove only the exact original duplicate line in the UNSAVED draft so one identical source line remains; do not delete any transaction. Exact financial line: '+JSON.stringify(line)+'.',
    (blankOptionalDescription(i)?'The original invoice optional line Description is absent, null or empty. In the UNSAVED draft, leave or restore its visible Description field blank. Do not type the literal word null. The UI need not prove the underlying null/absent/empty representation; deterministic server readback still enforces the original saved fields. ':'The Estimate may use a proposed/blank description. In the UNSAVED invoice draft, preserve/restore the invoice original line Description exactly as '+JSON.stringify(line.Description)+'. ')+ 'Do not change the saved Estimate description. '+
    'BEFORE Save: inspect and capture the UNSAVED native draft. It must have exactly ONE financial sales line, identical customer, document number, dates, quantity, unit price, amount, tax and totals. Native line ID/source-link representation may change only for the exact quoted line. No extra charges, auto credits, discounts, allocations, payments or links. If any original field cannot be preserved, STOP WITHOUT SAVING.',
    'At most ONE Save attempt. Never retry a click/keyboard submit when its outcome is uncertain. Stop immediately on any uncertainty; do not re-open and save again. A model-driven instruction is not a mechanical click counter: record exactly which Save action was attempted and whether a saved confirmation appeared.',
    'Capture before-save and saved-result screenshots privately in this run output directory. After the one Save, inspect the exact existing Invoice and Estimate in native UI. Stop with a precise result; external deterministic SDK reads will verify accounting. Do not assume UI confirmation proves ledger equality.',
    'Return a JSON object: {invoiceId:'+JSON.stringify(i.Id)+',estimateId:'+JSON.stringify(e.Id)+',draftChecked:boolean,saveAttempts:number,saveOutcome:"saved"|"not-attempted"|"uncertain",beforeSaveScreenshot:string,afterSaveScreenshot:string,notes:string}. The notes field must include the required action ledger. Screenshot fields must be paths relative to this run output directory, such as before.png and after.png, without a repository prefix. Return only the JSON object, with no surrounding text. No credentials or raw cookies. Do not perform unrelated work.'
  ].join('\n');
}
function createGeneralEstimateNative({models,transaction,access,runner,lease,guard=async()=>{},codingAuthority=null,reconcile=null,browserScope={environment:'production',realmId:require('./qbo-browser-login').REALM},now=()=>Date.now()}){
  check(models&&transaction&&access&&runner&&lease,'Concrete native repair adapters required.');
  const Runs=models.GeneralWriteRuns;
  async function load(bound,runId,ref,session){
    const scope=scoped(bound.scope),run=await one(Runs,{_id:runId,...scope},session);
    check(run&&String(run.ownerId)===String(bound.ownerId)&&String(run.actorId)===String(bound.actorId)&&String(bound.actorId)===String(bound.ownerId)&&!run.caseAuthority,'The original owner-scoped general write is required.');
    const item=run.items?.[ref],batch=run.batches?.find(b=>b.attempt===item?.attempt&&b.items?.some(s=>s.ref===ref));
    check(batch?.transport?.receiptId,'The original saved batch is required.');
    const receipt=await one(models.Receipts,{_id:batch.transport.receiptId,...scope},session);
    let source=recovery.sourceOf(item.outcome==='saved'&&item.originalSavedRecord?{...run,items:{...run.items,[ref]:{...item,outcome:'mismatch',record:item.originalSavedRecord}}}:run,ref,receipt),estimate,typed=null;
    if(source){estimate=await recovery.loadEstimateCreation({Runs,Receipts:models.Receipts,scope,ownerId:run.ownerId,id:source.estimateId,session});check(estimate,'The exact original general-created Estimate is required.');}
    else {typed=await timeEstimate.loadSource({models,scope,run,ref,session,now:now()});check(typed,'The exact saved Invoice relationship source is required.');({source,estimate}=typed);}
    if(bound.agentAuthority){check(require('./business-agent-authority').sameAgentLineage(bound.agentAuthority,run.agentAuthority),'The current accountant must own the original work.');}
    else check(codingAuthority?.environment===scope.environment&&codingAuthority.realmId===scope.realmId&&codingAuthority.pairs?.some(p=>p.invoiceId===source.item.qboId&&p.estimateId===source.estimateId),'Coding-agent native authority covers only the exact owner-approved pairs.');
    return {scope,run,source,estimate,...(typed?{time:typed.time,binding:typed.binding,bindingHash:typed.bindingHash}:{})};
  }
  async function workspace(bound,session,settling=false){
    if(!settling)await guard();await access.authorize(bound.scope,settling?'operations.verify':'operations.execute',{session});
    for(const id of [...new Set([String(bound.ownerId),String(bound.actorId)])]){
      const user=await one(models.Users,{_id:id},session),v=user?.connectionSwitchVersion??0;
      check(user&&Number.isSafeInteger(v),'Current workspace user required.');
      check(await models.Users.findOneAndUpdate({_id:id,role:user.role,connectionSwitchVersion:user.connectionSwitchVersion===undefined?{$exists:false}:v},{$inc:{connectionSwitchVersion:1}},{new:true,session}).lean(),'Workspace changed before native repair.');
    }
    const member=await one(models.Memberships,{userId:String(bound.actorId),realmId:bound.scope.realmId,status:'active'},session);
    check(member&&await models.Memberships.findOneAndUpdate({_id:member._id,userId:member.userId,realmId:bound.scope.realmId,status:'active',role:member.role},{$inc:{businessSetupVersion:1}},{new:true,session}).lean(),'Current company permission changed.');
    if(bound.agentAuthority&&!settling)await require('./business-agent-authority').fenceAgentAuthority({authority:bound.agentAuthority,scope:bound.scope,ownerId:String(bound.ownerId),actorId:String(bound.actorId),Agents:models.Agents,session});
  }
  async function retain(plan,payload,phase,session){
    const body={version:1,kind:phase==='admitted'?KIND:EVENT,actionId:plan.actionId,scope:plan.scope,ownerId:plan.ownerId,actorProvenance:plan.actorProvenance,phase,...payload};
    check(Buffer.byteLength(canonical(body))<=8000000,'Native evidence exceeds its retained budget.');
    const contentHash=hash(body),id=phase==='admitted'?plan.actionId.slice(0,24):hash({actionId:plan.actionId,phase}).slice(0,24),auditId=hash({id,contentHash}).slice(0,24);
    await models.Authorities.create([{_id:id,contractVersion:1,...plan.scope,contentHash,payload:body,actorId:plan.ownerId,auditId}],{session});
    await models.Audits.create([{_id:auditId,userId:plan.ownerId,realmId:plan.scope.realmId,action:'Native saved Invoice estimate repair '+phase,actionType:'ai_executed',aiDriven:true,tool:'browser',outcome:phase==='verified'?'success':'partial',afterState:{actionId:plan.actionId,authorityHash:contentHash,operationId:plan.operationId,invoiceId:plan.invoiceId,estimateId:plan.estimateId,actorProvenance:plan.actorProvenance}}],{session});
    return contentHash;
  }
  async function touchPolicy(plan,semantic,period,session) {
    const policy=await one(models.Policies,plan.scope,session);
    check(policy?.state==='active' && Number.isSafeInteger(policy.revision) && policy.periodControl?.contentHash===plan.controlHash && String(policy.connectionId)===plan.scope.connectionId,'Native repair protection changed.');
    assertWritePeriod(semantic,period,policy.periodControl,now(),plan.ownerId);
    check(await models.Policies.findOneAndUpdate({_id:policy._id,...plan.scope,state:'active',revision:policy.revision,'periodControl.contentHash':plan.controlHash},{$inc:{revision:1}},{new:true,session}).lean(),'Native repair protection changed concurrently.');
  }
  async function withReads(bound,scope,postAdmission,work) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),MAX_NATIVE_MS+120000);timer.unref?.();
    const client=await access.resolveClient(scope);let reads=0,submitted=postAdmission;
    const control={signal:controller.signal,beforeAttempt:async()=>{if(!submitted)await guard();check(++reads<=MAX_READS,'Native repair SDK read budget exhausted.');await access.authorize(scope,'operations.read');},onFailure:()=>{}};
    const get=async(entity,id)=>(await client.apiCall('GET',entity.toLowerCase()+'/'+id,undefined,0,0,control))?.[entity];
    const query=async text=>client.query(text,control);
    const prefs=async()=>{const rows=(await query('SELECT * FROM Preferences MAXRESULTS 1'))?.QueryResponse?.Preferences;check(Array.isArray(rows)&&rows.length===1&&rows[0].SalesFormsPrefs?.AutoApplyCredit===false,'Native repair requires observed Automatically apply credits Off; no preference change is authorized.');return rows[0];};
    const report=async(reportScope)=>{await access.authorize(scope,'reports.observe');const body=await client.apiCall('GET',reportScope.endpoint,undefined,0,0,control);reportShape(body,reportScope.dates);return body;};
    const numbers=async docNumber=>{const body=await query("SELECT * FROM Invoice WHERE DocNumber = '"+docNumber+"' MAXRESULTS 2");check(body?.QueryResponse&&typeof body.QueryResponse==='object'&&[undefined,true].includes(body.QueryResponse.Invoice===undefined?undefined:Array.isArray(body.QueryResponse.Invoice)),'Complete document-number uniqueness query is required');return body.QueryResponse.Invoice||[];};
    try{return await work({get,query,prefs,report,numbers,submitted:()=>{submitted=true;},reads:()=>reads});}finally{clearTimeout(timer);controller.abort();}
  }
  async function returned(plan,authorityHash,execution,bound) {
    await transaction(async session=>{
      await workspace(bound,session,true);
      const writer=await one(models.Writers,plan.scope,session);
      check(writer?.unresolved?.actionId===plan.actionId&&writer.unresolved.authorityHash===authorityHash,'The original native action barrier is required to retain its result.');
      await retain(plan,{authorityHash,execution,at:new Date(now()).toISOString()},'returned',session);
    });
  }
  function noEffectOf(authority,event,initial){
    check(event&&event.contentHash===hash(event.payload)&&event.payload.phase==='no-effect'&&event.payload.authorityHash===authority.contentHash&&event.payload.actionId===authority.payload.actionId&&['native-executable-unavailable','missing-invoice-document-number','unrestored-informational-draft-notice',BLANK_DESCRIPTION_STOP].includes(event.payload.reason),'The retained no-effect proof is invalid.');
    const plan=authority.payload.plan,after=event.payload.after;
    if(event.payload.reason===BLANK_DESCRIPTION_STOP)check(plan.attempt===1&&plan.source.kind===timeEstimate.KIND&&blankOptionalDescription(plan.before.invoice)&&event.payload.cleanup?.onlyHomepage===true&&event.payload.cleanup.invoiceId===plan.invoiceId&&event.payload.cleanup.runId===plan.runId&&/^[a-f0-9]{64}$/.test(event.payload.stopEvidence?.sha256||''),'Blank optional Description no-effect needs its exact typed root, original blank field, stop screenshot and journaled cleanup');
    check(plan.source.invoiceOriginalHash===hash(initial.source.original)&&plan.source.estimateOriginalHash===hash(initial.estimate.original)&&(initial.source.sourceKind===timeEstimate.KIND?timeEstimate.unchangedParent(initial.source.original,after.invoice,'Invoice')&&timeEstimate.unchangedParent(initial.estimate.original,after.estimate,'Estimate')&&timeEstimate.unchangedParent(initial.time.original,after.time,'TimeActivity'):unchanged(initial.source.original,after.invoice,'Invoice')&&unchanged(initial.estimate.original,after.estimate,'Estimate'))&&sameQboValue(plan.before.customer,after.customer,{entity:'Customer'})&&event.payload.noDraft?.onlyHomepage===true&&canonical(reportShape(plan.beforeReport,plan.reportScope.dates))===canonical(reportShape(event.payload.afterReport,plan.reportScope.dates)),'No-effect evidence no longer authenticates the original documents.');
    return event;
  }
  async function discardJournaledDraft(plan,authorityHash,bound,normalizeBlankDescription=false){
    const find=phase=>one(models.Authorities,{_id:hash({actionId:plan.actionId,phase}).slice(0,24),...plan.scope});
    const completed=await find('draft-cleanup-complete');
    if(completed){check(completed.contentHash===hash(completed.payload)&&completed.payload.authorityHash===authorityHash&&completed.payload.proof?.invoiceId===plan.invoiceId&&completed.payload.proof?.runId===plan.runId,'Retained owned cleanup differs');return completed.payload.proof;}
    const retainPhase=async(phase,payload)=>transaction(async session=>{await workspace(bound,session,true);const writer=await one(models.Writers,plan.scope,session);check(writer?.unresolved?.actionId===plan.actionId&&writer.unresolved.authorityHash===authorityHash,'Owned cleanup lost its exact writer');await retain(plan,{authorityHash,...payload},phase,session);check(await models.Writers.findOneAndUpdate({_id:writer._id,...plan.scope,revision:writer.revision,'unresolved.actionId':plan.actionId},{$inc:{revision:1}},{new:true,session}).lean(),'Owned cleanup fence changed');});
    const started=await find('draft-cleanup-started');
    if(started){
      check(started.contentHash===hash(started.payload)&&started.payload.authorityHash===authorityHash&&started.payload.invoiceId===plan.invoiceId&&started.payload.runId===plan.runId&&started.payload.witness?.realmId===plan.scope.realmId,'Interrupted cleanup witness changed');
      const observation=await runner.assertNoDraft();check(observation?.onlyHomepage===true,'Interrupted cleanup still has no responsive confirmed homepage');
      const proof={onlyHomepage:true,invoiceId:plan.invoiceId,runId:plan.runId,witness:started.payload.witness,observation,method:'confirmed-homepage-after-interrupted-owned-discard',observedAt:new Date(now()).toISOString()};
      await retainPhase('draft-cleanup-complete',{proof});return proof;
    }
    const proof=await runner.discardOwnedDraft({invoiceId:plan.invoiceId,runId:plan.runId,scope:plan.scope,customerName:plan.before.customer.DisplayName,total:plan.before.invoice.TotalAmt,description:normalizeBlankDescription&&blankOptionalDescription(plan.before.invoice)?'':plan.before.invoice.Line.find(l=>l.DetailType==='SalesItemLineDetail')?.Description,beforeDiscard:witness=>retainPhase('draft-cleanup-started',{invoiceId:plan.invoiceId,runId:plan.runId,witness,at:new Date(now()).toISOString()})});
    await retainPhase('draft-cleanup-complete',{proof});return proof;
  }
  async function verifyNoEffect(plan,authorityHash,source,estimate,execution,bound,reads,reason='native-executable-unavailable',stopScreenshot=null){
    check(runner.readExecution&&runner.assertNoDraft,'No-effect native evidence adapters are required.');
    const retained=await runner.readExecution({runId:plan.runId,promptHash:plan.promptHash,nativeRepair:{actionId:plan.actionId,authorityHash}});
    check(retained&&hash(retained)===hash(execution),'No-effect execution evidence changed.');
    let stopEvidence=null;if(reason==='unrestored-informational-draft-notice'||reason===BLANK_DESCRIPTION_STOP){check(typeof stopScreenshot==='string'&&stopScreenshot.length>0,'Retained blue-notice stop screenshot is required');stopEvidence=await runner.retainEvidence(execution,stopScreenshot,{scope:plan.scope,accountId:plan.invoiceId,runId:plan.actionId});}
    let cleanup=null;if(reason==='missing-invoice-document-number'){check(plan.attempt===2&&!plan.assignedMissingDocNumber&&recovery.missingDocumentNumber(source)&&runner.discardOwnedDraft,'Only the historical missing-number draft is eligible');cleanup=await discardJournaledDraft(plan,authorityHash,bound);}
    if(reason===BLANK_DESCRIPTION_STOP){check(plan.attempt===1&&source.sourceKind===timeEstimate.KIND&&blankOptionalDescription(plan.before.invoice)&&runner.discardOwnedDraft,'Only the exact original blank optional Description typed root draft is eligible');cleanup=await discardJournaledDraft(plan,authorityHash,bound,true);}
    const noDraft=await runner.assertNoDraft();check(noDraft?.onlyHomepage===true,'An open draft or pending submit prevents replacement.');
    const typed=source.sourceKind===timeEstimate.KIND;
    const read=async()=>({invoice:await reads.get('Invoice',plan.invoiceId),estimate:await reads.get('Estimate',plan.estimateId),customer:await reads.get('Customer',plan.before.customer.Id),...(typed?{time:await reads.get('TimeActivity',source.timeParent.step.qboId)}:{})});
    const after=await read();check((typed?timeEstimate.unchangedParent(source.original,after.invoice,'Invoice')&&timeEstimate.unchangedParent(estimate.original,after.estimate,'Estimate')&&timeEstimate.unchangedParent(source.timeParent.original,after.time,'TimeActivity'):unchanged(source.original,after.invoice,'Invoice')&&unchanged(estimate.original,after.estimate,'Estimate'))&&completeCustomer(after.customer,plan.before.customer.Id)&&sameQboValue(plan.before.customer,after.customer,{entity:'Customer'}),'Original native records changed; no-effect cannot be established.');
    await reads.prefs();const firstReport=await reads.report(plan.reportScope),stable=await read(),afterReport=await reads.report(plan.reportScope);
    check(canonical(after)===canonical(stable)&&canonical(reportShape(plan.beforeReport,plan.reportScope.dates))===canonical(reportShape(firstReport,plan.reportScope.dates))&&canonical(reportShape(firstReport,plan.reportScope.dates))===canonical(reportShape(afterReport,plan.reportScope.dates)),'Stable unchanged native records and full TrialBalance are required for no-effect.');
    await transaction(async session=>{
      await workspace(bound,session,true);await load(bound,plan.operationId,plan.ref,session);
      const writer=await one(models.Writers,plan.scope,session),policy=await one(models.Policies,plan.scope,session);
      check(writer?.unresolved?.actionId===plan.actionId&&writer.unresolved.authorityHash===authorityHash&&policy?.state==='active'&&policy.periodControl?.contentHash===plan.controlHash,'No-effect settlement fence changed.');
      await retain(plan,{authorityHash,reason,after,afterReport,noDraft,cleanup,stopEvidence,executionHash:hash(execution),sdkReads:reads.reads(),verifiedAt:new Date(now()).toISOString()},'no-effect',session);
      check(await models.Writers.findOneAndUpdate({_id:writer._id,...plan.scope,revision:writer.revision,'unresolved.actionId':plan.actionId,'unresolved.authorityHash':authorityHash},{$set:{unresolved:null},$inc:{revision:1}},{new:true,session}).lean(),'No-effect retains its exact writer until settlement.');
    });
    return {status:'not-repaired',actionId:plan.actionId,noEffectVerified:true,retryAvailable:(plan.attempt||1)===1||reason==='missing-invoice-document-number'&&plan.attempt===2||reason==='unrestored-informational-draft-notice'&&plan.attempt===3,note:'Fresh unchanged records and complete accounting prove this stopped attempt made no change. Its original launch remains consumed.'};
  }
  async function verify(plan,authorityHash,source,estimate,execution,bound,reads) {
    check(execution.exitCode===0&&execution.cleanupConfirmed===true&&execution.model==='gpt-6.1-terra'&&execution.commandAudit?.flagged===0,'Native runner result or cleanup is uncertain; keep the original action barrier.');
    let reply;try{reply=JSON.parse(execution.reply.replace(/^\s*```(?:json)?/,'').replace(/```\s*$/,''));}catch{fail('Native result is not an inspectable structured result; retain its action barrier.');}
    if(reply.invoiceId===plan.invoiceId&&reply.estimateId===plan.estimateId&&reply.draftChecked===false&&reply.saveAttempts===0&&reply.saveOutcome==='not-attempted'&&/MODULE_NOT_FOUND/.test(reply.notes||''))return verifyNoEffect(plan,authorityHash,source,estimate,execution,bound,reads);
    if(reply.invoiceId===plan.invoiceId&&reply.estimateId===plan.estimateId&&reply.draftChecked===true&&reply.saveAttempts===0&&reply.saveOutcome==='not-attempted'&&/invoice number.*(blank|required)/i.test(reply.notes||'')&&recovery.missingDocumentNumber(source)&&plan.attempt===2&&!plan.assignedMissingDocNumber)return verifyNoEffect(plan,authorityHash,source,estimate,execution,bound,reads,'missing-invoice-document-number');
    if(reply.invoiceId===plan.invoiceId&&reply.estimateId===plan.estimateId&&reply.draftChecked===false&&reply.saveAttempts===0&&reply.saveOutcome==='not-attempted'&&/existing saved draft/i.test(reply.notes||'')&&/not restored or removed/i.test(reply.notes||'')&&/No fields were entered/i.test(reply.notes||'')&&plan.attempt===3&&plan.assignedMissingDocNumber===recovery.missingDocumentNumber(source))return verifyNoEffect(plan,authorityHash,source,estimate,execution,bound,reads,'unrestored-informational-draft-notice',reply.beforeSaveScreenshot);
    if(reply.invoiceId===plan.invoiceId&&reply.estimateId===plan.estimateId&&reply.draftChecked===false&&reply.saveAttempts===0&&reply.saveOutcome==='not-attempted'&&plan.attempt===1&&source.sourceKind===timeEstimate.KIND&&blankOptionalDescription(plan.before.invoice)&&/^Stopped at: the native draft shows a blank description, but the UI does not establish whether its underlying value is exactly null\./.test(reply.notes||'')&&/The unsaved draft remains open in the persistent session; it was not removed\./.test(reply.notes||''))return verifyNoEffect(plan,authorityHash,source,estimate,execution,bound,reads,BLANK_DESCRIPTION_STOP,reply.beforeSaveScreenshot);
    check(reply.invoiceId===plan.invoiceId&&reply.estimateId===plan.estimateId&&reply.draftChecked===true&&reply.saveAttempts===1&&reply.saveOutcome==='saved','Native submission is not explicitly known saved; retain its action barrier.');
    const beforeShot=await runner.retainEvidence(execution,reply.beforeSaveScreenshot,{scope:plan.scope,accountId:plan.invoiceId,runId:plan.actionId}),afterShot=await runner.retainEvidence(execution,reply.afterSaveScreenshot,{scope:plan.scope,accountId:plan.invoiceId,runId:plan.actionId});
    const typed=source.sourceKind===timeEstimate.KIND;
    const after={invoice:await reads.get('Invoice',plan.invoiceId),estimate:await reads.get('Estimate',plan.estimateId),customer:await reads.get('Customer',plan.before.customer.Id),...(typed?{time:await reads.get('TimeActivity',source.timeParent.step.qboId)}:{})};
    const assignment=plan.assignedMissingDocNumber?await recovery.loadNativeAssignment({models,scope:plan.scope,source,estimateOriginal:estimate.original,actionId:plan.actionId,authorityHash,completed:false}):null;
    if(plan.assignedMissingDocNumber){check(assignment,'The reviewed missing-number assignment authority is required');const numbered=await reads.numbers(plan.assignedMissingDocNumber);check(numbered.length===1&&numbered[0].Id===plan.invoiceId&&numbered[0].DocNumber===plan.assignedMissingDocNumber,'The assigned invoice number is not unique to the original invoice');}
    if(typed)timeEstimate.assertAfter({source,estimate,time:source.timeParent},after,{assignedMissingDocNumber:plan.assignedMissingDocNumber});
    else check(recovery.assertRepairedPair(source,after.invoice,after.estimate,estimate.original,assignment)&&recovery.assertEstimateTransition(estimate.original,after.estimate,plan.invoiceId),'Native saved record differs from the exact approved accounting; keep its barrier.');
    check(completeCustomer(after.customer,plan.before.customer.Id)&&sameQboValue(plan.before.customer,after.customer,{entity:'Customer'}),'Native repair changed the original Customer');
    const stable={invoice:await reads.get('Invoice',plan.invoiceId),estimate:await reads.get('Estimate',plan.estimateId),...(typed?{time:await reads.get('TimeActivity',source.timeParent.step.qboId)}:{})};
    check(canonical(stable.invoice)===canonical(after.invoice)&&canonical(stable.estimate)===canonical(after.estimate)&&(!typed||canonical(stable.time)===canonical(after.time)),'Native repair readback changed during verification.');
    await reads.prefs();const afterReport=await reads.report(plan.reportScope);
    check(canonical(reportShape(plan.beforeReport,plan.reportScope.dates))===canonical(reportShape(afterReport,plan.reportScope.dates)),'Native repair changed complete TrialBalance rows or columns; retain its barrier.');
    await transaction(async session=>{
      await workspace(bound,session,true);await load(bound,plan.operationId,plan.ref,session);
      const writer=await one(models.Writers,plan.scope,session),policy=await one(models.Policies,plan.scope,session);
      check(writer?.unresolved?.actionId===plan.actionId&&writer.unresolved.authorityHash===authorityHash&&policy?.state==='active'&&policy.periodControl?.contentHash===plan.controlHash,'Native settlement fence or protection changed.');
      await retain(plan,{authorityHash,...(typed?{sourceKind:timeEstimate.KIND,bindingHash:plan.source.bindingHash}:{}),after,beforeReportHash:hash(plan.beforeReport),afterReport,execution:{model:execution.model,commandAudit:execution.commandAudit,replyPath:execution.replyPath,replyHash:hash(execution.reply),cleanupConfirmed:true,beforeShot,afterShot},sdkReads:reads.reads(),verifiedAt:new Date(now()).toISOString()},'verified',session);
      check(await models.Writers.findOneAndUpdate({_id:writer._id,...plan.scope,revision:writer.revision,'unresolved.actionId':plan.actionId,'unresolved.authorityHash':authorityHash},{$set:{unresolved:null},$inc:{revision:1}},{new:true,session}).lean(),'Native outcome retains its exact writer until settlement commits.');
    });
    const reconciled=reconcile?await reconcile(bound,plan.operationId,new Map([['Invoice:'+plan.invoiceId,after.invoice],['Estimate:'+plan.estimateId,after.estimate]])):null;
    return {status:'verified',actionId:plan.actionId,invoiceId:plan.invoiceId,estimateId:plan.estimateId,sdkReads:reads.reads(),accountingUnchanged:true,originalIdsPreserved:true,reconciled};
  }
  async function repair({bound,operationId,ref}) {
    const initial=await load(bound,operationId,ref),rootId=actionId(initial.scope,initial.run,initial.source);
    let id=rootId,prior=await one(models.Authorities,{_id:id.slice(0,24),...initial.scope}),attempt=1,predecessor=null;
    if(prior){
      check(prior.contentHash===hash(prior.payload)&&prior.payload.kind===KIND&&prior.payload.actionId===rootId,'Root native authority changed.');
      const noEffect=await one(models.Authorities,{_id:hash({actionId:rootId,phase:'no-effect'}).slice(0,24),...initial.scope});
      if(noEffect){
        noEffectOf(prior,noEffect,initial);const blankDescriptionRoot=noEffect.payload.reason===BLANK_DESCRIPTION_STOP;check(noEffect.payload.reason==='native-executable-unavailable'||blankDescriptionRoot,'Only a proved supported root no-effect may have a successor');
        predecessor={actionId:rootId,authorityHash:prior.contentHash,noEffectHash:noEffect.contentHash,plan:prior.payload.plan,reason:noEffect.payload.reason};attempt=2;id=replacementId(rootId,noEffect.contentHash);prior=await one(models.Authorities,{_id:id.slice(0,24),...initial.scope});
        if(prior&&!blankDescriptionRoot){const next=await one(models.Authorities,{_id:hash({actionId:id,phase:'no-effect'}).slice(0,24),...initial.scope});
          if(next?.payload?.reason==='missing-invoice-document-number'){
            noEffectOf(prior,next,initial);check(prior.payload.plan.attempt===2&&!prior.payload.plan.assignedMissingDocNumber&&prior.payload.plan.predecessor?.actionId===rootId&&next.payload.cleanup?.invoiceId===initial.source.item.qboId&&next.payload.cleanup.runId===prior.payload.plan.runId&&recovery.missingDocumentNumber(initial.source),'Only the exact historical helper-to-missing-number lineage has a final successor');
            predecessor={actionId:id,authorityHash:prior.contentHash,noEffectHash:next.contentHash,plan:prior.payload.plan};attempt=3;id=replacementId(rootId,next.contentHash);prior=await one(models.Authorities,{_id:id.slice(0,24),...initial.scope});
            if(prior){const notice=await one(models.Authorities,{_id:hash({actionId:id,phase:'no-effect'}).slice(0,24),...initial.scope});if(notice?.payload?.reason==='unrestored-informational-draft-notice'){
              noEffectOf(prior,notice,initial);check(prior.payload.plan.attempt===3&&prior.payload.plan.assignedMissingDocNumber===recovery.missingDocumentNumber(initial.source)&&prior.payload.plan.predecessor?.actionId===predecessor.actionId&&notice.payload.stopEvidence?.sha256,'Only the exact unrestored informational notice admits the last child');
              predecessor={actionId:id,authorityHash:prior.contentHash,noEffectHash:notice.contentHash,plan:prior.payload.plan};attempt=4;id=replacementId(rootId,notice.contentHash);prior=await one(models.Authorities,{_id:id.slice(0,24),...initial.scope});
            }}

          }
        }
      }
    }
    if(prior){
      check(prior.contentHash===hash(prior.payload)&&prior.payload.kind===KIND&&prior.payload.actionId===id,'Retained native action identity is invalid.');
      const outcome=await one(models.Authorities,{_id:hash({actionId:id,phase:'verified'}).slice(0,24),...initial.scope});
      if(outcome){check(outcome.contentHash===hash(outcome.payload)&&outcome.payload.authorityHash===prior.contentHash&&outcome.payload.phase==='verified','Retained native outcome is invalid.');const after=outcome.payload.after;return {status:'verified',actionId:id,reused:true,invoiceId:initial.source.item.qboId,estimateId:initial.source.estimateId,reconciled:reconcile?await reconcile(bound,operationId,new Map([['Invoice:'+after.invoice.Id,after.invoice],['Estimate:'+after.estimate.Id,after.estimate]])):null};}
      const ended=await one(models.Authorities,{_id:hash({actionId:id,phase:'no-effect'}).slice(0,24),...initial.scope});
      if(ended){noEffectOf(prior,ended,initial);return {status:'not-repaired',actionId:id,noEffectVerified:true,retryAvailable:false,note:'The bounded replacement also had no effect. No further native launch is available.'};}
      const plan=prior.payload.plan,started=await one(models.Authorities,{_id:hash({actionId:id,phase:'started'}).slice(0,24),...initial.scope});
      check(plan?.actionId===id&&plan.promptHash===hash(plan.prompt)&&plan.operationId===operationId&&plan.ref===ref&&plan.source.invoiceOriginalHash===hash(initial.source.original)&&plan.source.estimateOriginalHash===hash(initial.estimate.original),'Retained native plan changed.');
      if(!started)return {status:'held',actionId:id,reused:true,note:'The admitted action was not confirmed started. Never launch it again automatically.'};
      check(started.contentHash===hash(started.payload)&&started.payload.authorityHash===prior.contentHash&&started.payload.runId===plan.runId&&started.payload.promptHash===plan.promptHash,'Retained native start is invalid.');
      const release=await lease();
      try {
        let result=await one(models.Authorities,{_id:hash({actionId:id,phase:'returned'}).slice(0,24),...initial.scope});
        if(result)check(result.contentHash===hash(result.payload)&&result.payload.authorityHash===prior.contentHash&&result.payload.phase==='returned','Retained native result is invalid.');
        else if(runner.readExecution){const execution=await runner.readExecution({runId:plan.runId,promptHash:plan.promptHash,nativeRepair:{actionId:id,authorityHash:prior.contentHash}});if(execution){await returned(plan,prior.contentHash,execution,bound);result={payload:{execution}};}}
        if(!result)return {status:'held',actionId:id,reused:true,note:'Native result or process cleanup is missing. This call makes no Save attempt.'};
        try{return await withReads(bound,initial.scope,true,reads=>verify(plan,prior.contentHash,initial.source,initial.estimate,result.payload.execution,bound,reads));}
        catch(error){return {status:'held',actionId:id,reused:true,note:error.message};}
      }catch(error){return {status:'held',actionId:id,reused:true,note:error.message};}finally{await release();}
    }
    if(runner.assertAvailable)await runner.assertAvailable();
    check(initial.source.sourceKind===timeEstimate.KIND ? initial.run.items[ref].outcome==='saved'&&initial.run.items[ref].complete===true : initial.run.items[ref].outcome==='mismatch','The saved relationship is already reconciled; no native repair is needed.');
    const release=await lease();
    try{return await runner.withSession({actor:bound.agentAuthority?'accountant':'codex-cli',scope:initial.scope},()=>withReads(bound,initial.scope,false,async reads=>{
      const state=await load(bound,operationId,ref),{scope,run,source,estimate}=state;
      check(scope.environment===browserScope.environment&&scope.realmId===browserScope.realmId,'The coordinated native browser is restricted to its exact Production company.');
      let browserReadiness=null;if(attempt>=3||predecessor?.reason===BLANK_DESCRIPTION_STOP){browserReadiness=await runner.assertNoDraft();check(browserReadiness?.onlyHomepage===true,'Final native admission requires a fresh responsive homepage under its verified session');}
      const fence=recovery.createRecoveryFence({models,transaction,authorize:async(s,b,session)=>access.authorize(s,'operations.execute',{session}),now});
      const snapshot=await fence.start(scope,run,bound,{invoiceId:source.item.qboId,estimateId:source.estimateId});check(snapshot,'Native repair waits for the idle exact company writer and clear receipt graph.');
      const invoice=await reads.get('Invoice',source.item.qboId),quote=await reads.get('Estimate',source.estimateId);
      const typed=source.sourceKind===timeEstimate.KIND,time=typed?await reads.get('TimeActivity',state.time.step.qboId):null;
      if(typed){timeEstimate.assertBefore(state,{invoice,estimate:quote,time});check(timeEstimate.unchangedParent(state.estimate.original,quote,'Estimate')&&timeEstimate.unchangedParent(state.time.original,time,'TimeActivity'),'Typed parent changed before native admission');state.estimate.original=quote;state.time.original=time;}
      else check(unchanged(source.original,invoice,'Invoice')&&unchanged(estimate.original,quote,'Estimate'),'Original Invoice or Estimate changed; no native action was admitted.');
      check(compatiblePair(invoice,quote),'Only an identical unpaid CAD whole-estimate customer, financial line, tax and total is supported.');
      const customer=await reads.get('Customer',invoice.CustomerRef.value);check(completeCustomer(customer,invoice.CustomerRef.value),'The exact complete active Customer must be verified before admission.');
      const assignedMissingDocNumber=recovery.missingDocumentNumber(source);let documentNumberProof=null;
      if(assignedMissingDocNumber){check(invoice.DocNumber===undefined,'The original missing number was already assigned; preserve that record');const matches=await reads.numbers(assignedMissingDocNumber);check(matches.length===0,'The proposed missing invoice number is already used');documentNumberProof={docNumber:assignedMissingDocNumber,matches:0,observedAt:new Date(now()).toISOString()};}
      const preferences=await reads.prefs(),semantic=freezeWriteRequest(scope,'POST','invoice',{Id:invoice.Id,SyncToken:invoice.SyncToken,sparse:true,LinkedTxn:typed?timeEstimate.linksFor(state):[{TxnId:quote.Id,TxnType:'Estimate'}]});
      const periodEntities={invoice:'Invoice',estimate:'Estimate',timeactivity:'TimeActivity',customer:'Customer',payment:'Payment',deposit:'Deposit'};
      const period=await readWritePeriodEvidence(semantic,{read:async(e,i)=>{const entity=periodEntities[e.toLowerCase()];check(entity,'Unsupported native protected-period related entity');return {[entity]:await reads.get(entity,i)};},query:reads.query},now);
      const policy=await one(models.Policies,scope),periodProof=assertWritePeriod(semantic,period,policy?.periodControl,now(),String(bound.ownerId));
      const dates={from:[invoice.TxnDate,quote.TxnDate].sort()[0].slice(0,4)+'-01-01',through:require('./business-activity-preview').businessDate(new Date(now()))};
      const reportScope={endpoint:'reports/TrialBalance?'+new URLSearchParams({start_date:dates.from,end_date:dates.through,accounting_method:'Accrual'}),dates},beforeReport=await reads.report(reportScope);
      const plan={version:1,kind:KIND,actionId:id,rootActionId:rootId,attempt,predecessor:predecessor?{actionId:predecessor.actionId,authorityHash:predecessor.authorityHash,noEffectHash:predecessor.noEffectHash}:null,runId:'bf7-'+require('node:crypto').randomUUID(),scope,ownerId:String(bound.ownerId),actorId:String(bound.actorId),agentAuthority:bound.agentAuthority||null,browserLeaseHash:runner.sessionProof?.()||null,policyRevision:policy.revision,actorProvenance:bound.agentAuthority?'accountant under current standing grant':'codex-cli under exact owner-targeted request',operationId,ref,invoiceId:invoice.Id,estimateId:quote.Id,source:{...(typed?{kind:timeEstimate.KIND,binding:state.binding,bindingHash:state.bindingHash}:{}),invoiceReceiptId:source.receiptId,invoiceRequestHash:source.requestHash,invoiceOriginalHash:hash(source.original),estimateReceiptId:estimate.receiptId,estimateRequestHash:estimate.requestHash,estimateOriginalHash:hash(estimate.original)},before:{invoice,estimate:quote,customer,...(typed?{time}:{})},browserReadiness,assignedMissingDocNumber,documentNumberProof,preferences,periodProof,controlHash:policy.periodControl.contentHash,reportScope,beforeReport,reviewedAt:new Date(now()).toISOString(),deadlineAt:new Date(now()+300000).toISOString()};
      plan.prompt=promptFor(plan);plan.promptHash=hash(plan.prompt);let authorityHash;
      await fence.commit({scope,run,bound,snapshots:[snapshot],work:async session=>{
        await workspace(bound,session);const fresh=await load(bound,operationId,ref,session);check(fresh.source.receiptId===source.receiptId&&hash(fresh.source.original)===plan.source.invoiceOriginalHash&&(typed?fresh.bindingHash===plan.source.bindingHash&&timeEstimate.unchangedParent(fresh.estimate.original,plan.before.estimate,'Estimate')&&timeEstimate.unchangedParent(fresh.time.original,plan.before.time,'TimeActivity'):hash(fresh.estimate.original)===plan.source.estimateOriginalHash),'Original native repair sources changed.');
        await touchPolicy(plan,semantic,period,session);
        if(predecessor){const previous=await one(models.Authorities,{_id:hash({actionId:predecessor.actionId,phase:'no-effect'}).slice(0,24),...scope},session);check(previous?.contentHash===predecessor.noEffectHash&&previous.contentHash===hash(previous.payload),'Replacement predecessor proof changed.');}
        authorityHash=await retain(plan,{plan},'admitted',session);
        if(predecessor)await retain(predecessor.plan,{authorityHash:predecessor.authorityHash,noEffectHash:predecessor.noEffectHash,successorActionId:id,successorAuthorityHash:authorityHash},'replacement-admitted',session);
        check(await models.Writers.findOneAndUpdate({...scope,_id:snapshot.writerId,revision:snapshot.revision+1,operationId:null,planHash:null,unresolved:null},{$set:{unresolved:{kind:KIND,actionId:id,authorityHash,operationId,invoiceId:invoice.Id,estimateId:quote.Id}},$inc:{revision:1}},{new:true,session}).lean(),'Native writer admission changed.');
      }});
      await transaction(async session=>{
        await workspace(bound,session);await touchPolicy(plan,semantic,period,session);const writer=await one(models.Writers,scope,session);
        check(writer?.unresolved?.actionId===id&&writer.unresolved.authorityHash===authorityHash&&now()<=Date.parse(plan.deadlineAt),'Exact unexpired native action barrier required.');
        await retain(plan,{authorityHash,runId:plan.runId,promptHash:plan.promptHash,at:new Date(now()).toISOString()},'started',session);
        check(await models.Writers.findOneAndUpdate({_id:writer._id,...scope,revision:writer.revision,'unresolved.actionId':id},{$inc:{revision:1}},{new:true,session}).lean(),'Native start barrier changed.');
      });
      reads.submitted();
      const execution=await runner.run({runId:plan.runId,task:{prompt:plan.prompt,nativeRepair:{actionId:id,authorityHash}},mode:'flow'});
      await returned(plan,authorityHash,execution,bound);
      return verify(plan,authorityHash,source,estimate,execution,bound,reads);
    }));}finally{await release();}
  }
  return {repair};
}
function createDefaultGeneralEstimateNative({access,guard,now=()=>Date.now(),codingAuthority=null}={}){
  const models={...require('./business-runtime').loadModels(),Agents:require('../models/BusinessAgent')},transaction=require('./business-transaction').createBusinessTransaction(require('mongoose').connection);
  const runner=require('./banking-terra-runner').createTerraRunner({timeoutMs:MAX_NATIVE_MS});
  return createGeneralEstimateNative({models,transaction,access,guard,now,codingAuthority,runner,lease:()=>require('./banking-terra-runner').acquireOperatorLease(),reconcile:async(bound,operationId,hints)=>{
    const origin=await one(models.GeneralWriteRuns,{_id:operationId,...bound.scope});check(origin&&String(origin.ownerId)===String(bound.ownerId)&&String(origin.actorId)===String(bound.actorId),'Original recovery owner changed');
    const recoveryBound=!bound.agentAuthority&&codingAuthority&&origin.agentAuthority?{...bound,agentAuthority:clone(origin.agentAuthority)}:bound;
    return require('./general-write-service').createDefaultGeneralWrite({access,now,recoveryHints:hints}).reconcileSaved(recoveryBound,operationId);
  }});
}
module.exports={KIND,EVENT,MAX_READS,BLANK_DESCRIPTION_STOP,blankOptionalDescription,actionId,replacementId,promptFor,unchanged,reportShape,createGeneralEstimateNative,createDefaultGeneralEstimateNative};
