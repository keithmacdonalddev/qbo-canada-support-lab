'use strict';
const { model } = require('./memory.cjs');
const { createRuntime,scopeOf,sameScope,missing,json,safeError,classify } = require('./runtime.cjs');

async function checkChoices({ root, data, capturedAt, transform, features }) {
 const representative=(data.operationruns||[])[0]||(data.generalwriteruns||[])[0];
 if(!representative)throw missing('EMPTY_SELECTION');
 const rt=createRuntime({root,data,run:representative,at:+new Date(capturedAt),transform,features});
 const choices=rt.current('business-activity-choice-client').createActivityChoiceClient({
   scope:rt.scope, Records:rt.models.Records,Agents:rt.models.Agents,now:rt.clock });
 // Same readers used by governance.activityOptions, concurrently sharing one
 // single-use Agents query. Also validate the plain-JSON transport contract.
 const [masters,setup]=await Promise.all([
   rt.current('business-master-data').readBusinessMasters(choices,rt.scope,rt.clock),
   rt.current('blueprint-draft').readDraftSetup(choices,rt.scope,rt.clock)
 ]);
 if(!Object.values(masters.completeness).every(Boolean)||!setup.complete||choices.source.unavailable.length)
   throw Object.assign(missing('ACTIVITY_CHOICES_UNAVAILABLE'),{message:JSON.stringify({completeness:masters.completeness,complete:setup.complete,unavailable:choices.source.unavailable})});
 for(const entity of ['Customer','Vendor','Employee','Item','Account','TaxCode','Preferences']) {
   const query='SELECT * FROM '+entity+(entity==='Preferences'?' STARTPOSITION 1 MAXRESULTS 1':'');
   rt.current('business-calendar').canonical(await choices.query(query));
 }
 return {status:'passed',sourceHash:rt.hash({masters,setup})};
}
function planReader(rt) {
 return rt.current('business-operation-plan-store').createBusinessOperationPlanStore({
   ...rt.models,readOnly:true,authorize:rt.access.authorize,transaction:work=>work(null),
   assertReady:async()=>{},now:rt.clock
 });
}
function verification(rt,run,plans) {
 return rt.current('business-verification-runtime').createBusinessVerificationRuntime({
   ...rt.models,scope:rt.scope,operationId:String(run._id),planHash:run.planHash,
   transaction:work=>work(null),assertReady:async()=>{},access:rt.access,plans,
   observations:rt.observations,now:rt.clock,retainSources:true,
   writerFence:{graphSnapshot:async()=>{throw missing('WRITER_FENCE_SNAPSHOT_MISSING');}}
 });
}
function assertCompiledResponse(rt,compiled,stored) {
 if(!rt.current('general-write-recovery').matchesRequest(JSON.parse(compiled.request.body),json(stored),compiled.entity))
   throw Object.assign(Error('Current compiled financial request no longer matches the stored QBO response'),{code:'BUSINESS_COMPILED_RESPONSE_UNVERIFIED',status:409});
}
function assertResponseOutcomes(run,items) {
 if(items.some(item=>run.items?.[item.ref]?.outcome==='saved'&&item.outcome!=='saved'))throw Object.assign(Error('Stored successful item now refused'),{code:'GENERAL_RESPONSE_REFUSED',status:409});
}
function assertPreparedReferences(prepared) {
 if(prepared.steps.some(step=>step.references.some(ref=>ref.status!=='resolved')))throw Object.assign(Error('A current master choice is unresolved'),{code:'BUSINESS_PREPARATION_CHANGED',status:409});
}
function classifyStages(stages,errors) {
 const incomplete=errors.some(e=>!e.refused||e.code.startsWith('REPLAY_')||e.baseline==='unresolved')||stages.some(s=>s.status==='passed'&&s.baseline==='unresolved');
 return incomplete?'errored':errors.some(e=>e.baseline==='accepted')?'newly refused':stages.some(s=>s.baseline==='refused'&&s.status==='passed')?'newly accepted':'same outcome';
}
function stageBaseline(run,kind,name,data) {
 if(['preparation','plans-and-approvals'].includes(name))return (kind==='fixed'?run.planId:run.plan?.operations?.length)?'accepted':'unresolved';
 if(kind==='fixed') {
   const key=name.split(':')[1],step=(data.operationsteps||[]).find(s=>String(s.operationId)===String(run._id)&&s.logicalKey===key);
   if(name.startsWith('compilation:'))return step?.compilation?'accepted':'unresolved';
   if(name.startsWith('period-admission:'))return (data.qbowritereceipts||[]).some(r=>String(r.operationId)===String(run._id)&&r.logicalKey===key&&r.periodProof)?'accepted':'unresolved';
   if(name==='verification')return run.status==='verified'?'accepted':run.errorDetail?.code==='BUSINESS_GRAPH_UNVERIFIED'?'refused':'unresolved';
 }
 if(kind==='general'&&name==='admission-and-response-verification')return run.batches?.some(b=>b.transport?.receiptId)?'accepted':'unresolved';
 if(kind==='general'&&name==='after-save-readback-and-ledger')return (data.generaldaycloses||[]).some(c=>sameScope(c,run)&&c.ok&&c.fromDate<=run.day&&c.throughDate>=run.day&&+new Date(c.verifiedAt)>=+new Date(run.createdAt)&&c.records?.some(r=>Object.values(run.items||{}).some(i=>r.key===i.entity+':'+i.qboId)))?'accepted':'unresolved';
 return 'unresolved';
}
function baselineFor(run,kind) {
 if(kind==='fixed' && run.status==='verified'||kind==='general'&&run.status==='complete')return 'accepted';
 if(kind==='general'&&run.plan?.operations?.length)return 'accepted';
 if(kind==='fixed'&&run.planId)return 'accepted';
 return 'unresolved';
}
async function replayOperation({ root, data, run, kind, features, transform }) {
 const errors=[],stages=[],baseline=baselineFor(run,kind);
 const rt=createRuntime({root,data,run,at:+new Date(run.createdAt),features,transform});
 const stage=async(name,fn)=>{
   const original=stageBaseline(run,kind,name,data);
   if(typeof process.send==='function')process.send({type:'progress',id:String(run._id),stage:name});
   try {const result=await fn();stages.push({stage:name,baseline:original,status:'passed',...(result?{resultHash:rt.hash(json(result))}:{})});return result;}
   catch(error) {
     const detail=safeError(error,name), refused=!detail.code.startsWith('REPLAY_')&&(error.status===400||error.status===403||error.status===409||error.businessPlanError===true);
     errors.push({...detail,baseline:original,refused});stages.push({stage:name,baseline:original,status:'failed',errorDetail:detail});return null;
   }
 };
 if(kind==='fixed') {
   const rows=(data.operationintents||[]).filter(i=>sameScope(i,rt.scope)&&String(i.planId)===String(run.planId)).sort((a,b)=>a.ordinal-b.ordinal);
   const plans=planReader(rt),intents=new Map();
   await stage('plans-and-approvals',async()=>{
     if(!rows.length && run.recordCount)throw missing('INTENTS_MISSING');
     for(const row of rows)intents.set(row.logicalKey,await plans.loadIntent(rt.scope,String(run._id),row.logicalKey));
     if(run.approval)await rt.current('business-approval-report-evidence').readApprovalReports({models:rt.models,run,ownerId:String(run.createdBy),session:null});
     return [...intents.values()];
   });
   await stage('preparation',async()=>{

     const blueprint=(data.blueprintversions||[]).find(v=>String(v._id)===String(run.blueprintId)&&sameScope(v,rt.scope));
     if(!blueprint)throw missing('BLUEPRINT_MISSING');
     const historicAgents=(data.businessagents||[]).filter(a=>sameScope(a,rt.scope)&&+new Date(a.updatedAt)<=rt.clock());
     if(!historicAgents.length)throw missing('PREPARATION_SYNC_SNAPSHOT_MISSING');
     const historicalCopy=rt.current('business-activity-choice-client').createActivityChoiceClient({
       scope:rt.scope,Records:model((data.companysyncrecords||[]).filter(r=>+new Date(r.lastObservedAt)<=rt.clock())),
       Agents:model(historicAgents),now:rt.clock
     });
     const [masters,setup]=await Promise.all([
       rt.current('business-master-data').readBusinessMasters(historicalCopy,rt.scope,rt.clock),
       rt.current('blueprint-draft').readDraftSetup(historicalCopy,rt.scope,rt.clock)
     ]);
     if(!Object.values(masters.completeness).every(Boolean)||!setup.complete)throw missing('PREPARATION_LIST_SNAPSHOT_MISSING');
     const draft=rt.current('blueprint-draft').draftView(blueprint,rt.scope.connectionId);
     const activity=run.activityBatch?rt.current('business-activity-batch').buildBatchActivity(json(run.activityBatch),rt.scope,run.businessKey):null;
     const prepared=rt.current('business-operation-preview').prepareBusinessOperation(
       {...rt.scope,draft,proposal:rt.current('blueprint-draft').proposalView()},
       {connectionId:rt.scope.connectionId,baseHash:run.blueprintHash,fromDate:run.fromDate,throughDate:run.throughDate},
       setup,masters,new Date(rt.clock()),activity
     );
     assertPreparedReferences(prepared);
     return rt.current('business-preparation-references').bindPreparedOperationReferences(prepared,{...rt.access,now:rt.clock});

   });
   const ver=verification(rt,run,plans);
   for(const row of rows) {
     const saved=(data.operationsteps||[]).find(s=>sameScope(s,rt.scope)&&String(s.operationId)===String(run._id)&&s.logicalKey===row.logicalKey);
     const receipt=(data.qbowritereceipts||[]).find(r=>sameScope(r,rt.scope)&&r.dispatchKey===saved?.dispatch?.key);
     await stage('compilation:'+row.logicalKey,async()=>{
       if(!saved?.dispatch?.markedAt)throw missing('PRESEND_SNAPSHOT_MISSING');
       rt.setAt(+new Date(saved.dispatch.markedAt));
       const intent=intents.get(row.logicalKey)||await plans.loadIntent(rt.scope,String(run._id),row.logicalKey);
       // Approved tax sources are witnesses, never a substitute for current observations.
       // No mock approval or "verified:true" return: dependency proof is recomputed
       // by the same graph runtime used for live compilation.
       const steps={
         verifyGraph:async(s,o,roots)=>{
           const result=await ver.loadGraphReadback({scope:s,roots});
           if(!result.complete)throw missing('DEPENDENCY_READBACK_INCOMPLETE');
           return {...result,persisted:true};
         },
         evidence:async(s,o,key)=>{
           const dep=(data.operationsteps||[]).find(x=>sameScope(x,s)&&x.logicalKey===key);
           if(!dep)throw missing('DEPENDENCY_STEP_MISSING');
           // A dependency's old proof cannot be freshly relabelled by replay.
           if(+new Date(dep.verification?.observedAt)>rt.clock()||rt.clock()-Date.parse(dep.verification?.observedAt)>300000)throw missing('DEPENDENCY_PROOF_SNAPSHOT_MISSING');
           return {...dep,fresh:true};
         }
       };
       const load=rt.current('business-compilation-runtime').createBusinessCompilationRuntime({
         scope:rt.scope,operationId:String(run._id),planHash:run.planHash,access:rt.access,plans,steps,verification:ver,
         assertReady:async()=>{},observations:rt.observations,now:rt.clock
       });
       const evidence=await load({scope:rt.scope,operationId:String(run._id),logicalKey:row.logicalKey,intent});
       const compiled=await rt.current('business-transaction-compiler').compileBusinessTransactionWithDefinitions(
         {scope:rt.scope,step:intent.step,policy:intent.policy,...evidence,now:rt.clock()},
         {resolveDefinitionObservation:rt.observations.definition,clock:rt.clock});
       const stored=receipt?.savedResponse?.[row.step.entity];
       if(!stored)throw missing('STORED_COMPILE_RESPONSE_MISSING');
       assertCompiledResponse(rt,compiled,stored);
       return compiled;
     });
     await stage('period-admission:'+row.logicalKey,async()=>{
       if(!receipt?.periodProof?.evidence||!saved?.compilation?.request)throw missing('PERIOD_PROOF_MISSING');
       return rt.current('qbo-write-period').assertWritePeriod(saved.compilation.request,receipt.periodProof.evidence,
         receipt.periodProof.controls,Date.parse(receipt.periodProof.evidence.observedAt),String(receipt.ownerId));
     });
   }
   await stage('verification',async()=>{
     const evidence=(data.operationevidences||[]).filter(e=>String(e.operationId)===String(run._id)).sort((a,b)=>b.evidenceRevision-a.evidenceRevision)[0];
     if(!evidence)throw missing('READBACK_SNAPSHOT_MISSING');
     rt.setAt(Date.parse(evidence.proof.observedAt));
     // Create responses may only stand in for a read-back if the retained proof
     // authenticates that exact full body. Never use them after a later payment.
     const own=(data.operationsteps||[]).filter(s=>sameScope(s,rt.scope)&&String(s.operationId)===String(run._id));
     for(const step of own) {
       const receipt=(data.qbowritereceipts||[]).find(r=>sameScope(r,rt.scope)&&r.dispatchKey===step.dispatch?.key);
       const body=receipt?.savedResponse?.[step.entity];
       if(body && rt.hash(json(body))===step.verification?.observedHash)rt.put(step.entity,body);
       const record=rt.getRecord(step.entity,step.qboId);
       if(!record||rt.hash(record)!==step.verification?.observedHash)throw missing('EXACT_READBACK_BODY_MISSING');
     }
     rt.setReports(rt.current('business-report-source').unpackReports(evidence.sources));
     const roots=own.map(s=>s.logicalKey);
     if(roots.length>100)throw missing('GRAPH_ROOT_BUDGET');
     if(!roots.length)throw missing('GRAPH_ROOTS_MISSING');
     const result=await ver.loadGraphReadback({scope:rt.scope,roots});
     if(!result.complete)throw Object.assign(Error(JSON.stringify(result.failures)),{status:409,code:'BUSINESS_GRAPH_UNVERIFIED'});
     return result;
   });
 } else {
   // Full service preparation is used, with only its isolated plan store writable.
   const serviceModule=rt.current('general-write-service');
   const beforeRows=(data.companysyncrecords||[]).filter(r=>sameScope(r,rt.scope)&&+new Date(r.lastObservedAt)<=rt.clock());
   rt.models.Records=model(beforeRows);
   for(const key of ['Calendars','Policies','Agents']) {
     const table={Calendars:'businesscalendars',Policies:'companywritepolicies',Agents:'businessagents'}[key];
     const rows=(data[table]||[]).filter(r=>sameScope(r,rt.scope)&&+new Date(r.updatedAt)<=rt.clock());
     rt.models[key]=model(rows);
   }
   const contextFor=serviceModule.createGeneralWriteContext({models:rt.models,now:rt.clock});
   const operations=(run.plan?.operations||[]).map(({ref,op,entity,id,payload,reason})=>({ref,op,entity,...(id?{id}:{}),payload,...(reason?{reason}:{})}));
   const memRuns=model([], {writable:true});
   const api=serviceModule.createGeneralWriteService({models:{...rt.models,GeneralWriteRuns:memRuns},
     copy:{read:async(s,entity,id)=>{const r=rt.getRecord(entity,id);if(!r)throw missing('AS_OF_RECORD_MISSING');return r;}},
     contextFor,now:rt.clock,dispatchEnabled:()=>false});
   await stage('preparation',async()=>{
     if(!rt.models.Calendars || !(await rt.models.Calendars.findOne(rt.scope)))throw missing('CALENDAR_SNAPSHOT_MISSING');
     if(!operations.length)throw missing('GENERAL_OPERATIONS_MISSING');
     const result=await api.prepare({scope:rt.scope,ownerId:String(run.ownerId),actorId:String(run.actorId),
       ...(run.caseAuthority?{caseAuthority:run.caseAuthority}:{})},
       {decisionKey:run.decisionKey,purpose:run.purpose,operations});
     if(result.status==='refused')throw Object.assign(Error(JSON.stringify(result.problems)),{code:'GENERAL_WRITE_REFUSED',status:409});
     return result;
   });
   await stage('admission-and-response-verification',async()=>{
     if(!run.batches?.length)throw missing('GENERAL_BATCH_MISSING');
     const transport=rt.current('general-write-transport'), outcomes=[];
     for(const batch of run.batches) {
       const receipt=(data.qbowritereceipts||[]).find(r=>sameScope(r,rt.scope)&&r.general?.runId===String(run._id)&&r.general?.batchIndex===batch.index);
       const response=receipt?.savedResponse||(batch.transport?.response?{BatchItemResponse:batch.transport.response}:null);
       if(!response)throw missing('GENERAL_RESPONSE_MISSING');
       transport.buildGeneralBatch(rt.scope,batch);
       if(!receipt?.periodProof?.proofs)throw missing('PERIOD_PROOF_MISSING');
       // Re-run the live batch guard, never execute or send the saved run.
       await api.guardBatch({scope:rt.scope,run,batch,session:null,periodProof:receipt.periodProof});
       for(let n=0;n<batch.items.length;n++){
         const proof=receipt.periodProof.proofs[n];
         if(!proof)throw missing('PERIOD_PROOF_MISSING');
         rt.current('qbo-write-period').assertWritePeriod(transport.itemRequest(rt.scope,batch.items[n]),proof.evidence,proof.controls,Date.parse(proof.evidence.observedAt),String(run.ownerId));
       }
       const result=transport.classifyGeneralResponse(rt.scope,batch,{status:receipt.observed?.httpStatus||200,json:response});
       outcomes.push(result);
       if(result.items.some(i=>!['saved','rejected'].includes(i.outcome)))throw missing('GENERAL_OUTCOME_UNPROVEN');
       assertResponseOutcomes(run,result.items);
     }
     return outcomes;
   });
   // Service execution has no retained after-save read-back/GL body in GeneralWriteRun.
   // Do not relabel a transport response as independent verification.
   await stage('after-save-readback-and-ledger',async()=>{
     const items=Object.values(run.items||{}).filter(i=>['saved','deleted'].includes(i.outcome));
     if(!items.length)throw missing('GENERAL_SAVED_ITEMS_MISSING');
     const verifications=[];
     for(const item of items) {
       if(item.outcome==='deleted')continue;
       const itemBatch=run.batches.find(batch=>batch.items?.some(i=>i.ref===item.ref))||run.batches.find(batch=>batch.items?.some(i=>run.items?.[i.ref]===item));
       const answeredAt=itemBatch?.answeredAt||itemBatch?.transport?.observedAt;
       if(!answeredAt)throw missing('GENERAL_COMPLETION_TIME_MISSING');
       const observed=(data.companysyncrecords||[]).find(r=>sameScope(r,rt.scope)&&r.entity===item.entity&&r.qboId===item.qboId&&
         +new Date(r.lastObservedAt)>=+new Date(answeredAt)&&+new Date(r.lastObservedAt)<=+new Date(run.updatedAt)+300000);
       if(!observed?.record)throw missing('GENERAL_READBACK_SNAPSHOT_MISSING');
       const request={entity:item.entity,op:item.op,payload:item.request,before:item.before};
       if(!rt.current('general-write-recovery').matchesSavedRequest(request,json(observed.record)))
         throw Object.assign(Error('Stored readback no longer verifies'),{code:'GENERAL_READBACK_UNVERIFIED',status:409});
       verifications.push({entity:item.entity,id:item.qboId,recordHash:rt.hash(json(observed.record))});
     }
     if(items.every(i=>!rt.current('general-write-postings').isPosting(i.entity)))return verifications;
     // Real period report bodies are retained by OperationEvidence, not by the
     // general-close hash. A digest alone can never stand in for GL rows.
     const evidence=(data.operationevidences||[]).find(e=>sameScope(e,rt.scope)&&e.proof?.fromDate<=run.day&&e.proof?.throughDate>=run.day&&
       Date.parse(e.proof.observedAt)>=+new Date(run.updatedAt)&&e.sources?.reports?.GeneralLedger);
     if(!evidence)throw missing('GENERAL_LEDGER_BODY_MISSING');
     rt.setAt(Date.parse(evidence.proof.observedAt));
     const accounts=evidence.sources.accounts||[];
     for(const record of accounts)rt.put('Account',record);
     const all=rt.current('business-report-source').unpackReports(evidence.sources);
     const publication=await rt.current('business-authority').readPublishedBusiness({...rt.models,scope:rt.scope,session:null});
     const mappings=publication.view.mappings;
     const tax=accounts.filter(a=>['GlobalTaxPayable','GlobalTaxSuspense','SalesTaxPayable'].includes(a.AccountSubType));
     const ctx={get:(entity,id)=>{const record=rt.getRecord(entity,id);if(!record)throw missing('POSTING_REFERENCE_SNAPSHOT_MISSING');return record;},
       accountKey:id=>String(id),homeCurrency:'CAD',receivables:mappings.accountsReceivable,payables:mappings.accountsPayable,undepositedFunds:mappings.undepositedFunds,
       taxAccount:()=>{if(tax.length!==1)throw missing('TAX_POSTING_ACCOUNT_AMBIGUOUS');return tax[0].Id;}};
     const closed=await rt.current('general-write-day-close').closeGeneralDay({
       Runs:model([run]),scope:rt.scope,day:run.day,copy:{read:async(s,entity,id)=>ctx.get(entity,id)},ledgerReport:all.GeneralLedger,ctx,
       verifiedThrough:run.day,openingDate:publication.value.openingDate
     });
     if(!closed.ok)throw Object.assign(Error(JSON.stringify(closed.failures)),{code:'GENERAL_LEDGER_UNVERIFIED',status:409});
     return {verifications,closed};

   });
 }
 if(baseline==='unresolved')errors.push({...safeError(missing('BASELINE_UNRESOLVED'),'baseline'),refused:false});
 const outcome=classifyStages(stages,errors);
 return {id:String(run._id),kind,inputHash:rt.hash(json(run)),baseline,outcome,stages,errorDetail:errors};
}
async function replayDataset({root,bundle,features={},transform}) {
 const started=Date.now(), {data}=bundle, operations=[],preflight=[];
 // Current advisory data has a separate clock and result; it is never passed off
 // as an historical snapshot for any operation.
 const reps=[...new Map([...(data.operationruns||[]),...(data.generalwriteruns||[])].map(r=>[JSON.stringify(scopeOf(r)),r])).values()];
 for(const rep of reps) {
   const scoped={...data,operationruns:(data.operationruns||[]).filter(r=>sameScope(r,rep)),generalwriteruns:(data.generalwriteruns||[]).filter(r=>sameScope(r,rep))};
   try {preflight.push({scopeHash:require('./loader.cjs').digest(scopeOf(rep)),...(await checkChoices({root,data:scoped,capturedAt:bundle.capturedAt,features,transform}))});}
   catch(error){preflight.push({scopeHash:require('./loader.cjs').digest(scopeOf(rep)),status:'errored',errorDetail:safeError(error,'activity-choices')});}
 }
 for(const [kind,runs] of [['fixed',data.operationruns||[]],['general',data.generalwriteruns||[]]])for(const run of runs.filter(r=>!bundle.selected||bundle.selected.includes(String(r._id)))){
   if(Date.now()-started>480000)throw missing('EXECUTION_BUDGET');
   try{operations.push(await replayOperation({root,data,run,kind,features,transform}));}
   catch(error){operations.push({id:String(run._id),kind,outcome:'errored',errorDetail:[safeError(error,'harness')]});}
 }
 const counts=Object.fromEntries(['same outcome','newly refused','newly accepted','errored'].map(k=>[k,operations.filter(o=>o.outcome===k).length]));
 const failed=!operations.length||bundle.missing?.length||preflight.some(p=>p.status!=='passed')||counts['newly refused']||counts.errored;
 return {version:1,passed:!failed,captureHash:bundle.captureHash,elapsedMs:Date.now()-started,counts,missing:bundle.missing||[],preflight,operations};
}
module.exports={replayDataset,replayOperation,checkChoices,baselineFor,assertCompiledResponse,assertResponseOutcomes,assertPreparedReferences,stageBaseline,classifyStages};
