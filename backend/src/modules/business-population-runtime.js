'use strict';
const {randomUUID}=require('node:crypto');
const {hash,canonical}=require('./business-calendar');
const {denied}=require('./qbo-write-contract');
const {withWriteWorkflow}=require('./qbo-write-workflow');
const {createQboWriteGate}=require('./qbo-write-gate');
const {readWritePeriodEvidence,assertWritePeriod}=require('./qbo-write-period');
const {assertPublishedBusiness}=require('./business-authority');
const {compileBusinessTransaction}=require('./business-transaction-compiler');
const {buildPopulationBatch,classifyPopulationResponse,readyPopulationFrontier}=require('./business-population-batch');
const {createPopulationReader,parallel}=require('./business-population-reader');
const {readPopulationDeposits}=require('./business-population-proof');
const {monthEnd}=require('./business-population-plan');
const FRESH=180000;
async function runPopulationJob(input) {
  const {scope,ownerId,actorId,access,models,transaction,assertReady,now,audit,fenceAccess,counts}=input;
  const {Jobs,Records,Writers,Receipts}=models,jobId=String(input.job._id),bound={scope,ownerId,actorId,access};
  const read=(Model,query,session)=>Model.findOne(query).session(session).maxTimeMS(5000).lean();
  const keyQuery={...scope,authorityHash:input.job.authorityHash,txnDate:{$gte:input.job.fromDate,$lte:input.job.throughDate}};
  let leaseToken=randomUUID(),client=null,started=now(),cohorts=0,lastBatchAt=0;const masterCache=new Map();
  async function loadRows(query) {const result=[];let after=null;for(;;){const page=await Records.find({...query,...(after?{_id:{$gt:after}}:{})},null,{singleBatch:true,batchSize:101}).sort({_id:1}).limit(100).maxTimeMS(5000).lean();if(!page.length)return result;result.push(...page);if(result.length>4000)throw denied('A population observation window exceeds4000 records.');after=page.at(-1)._id;}}
  const delegationMatches=(writer,job)=>writer?.populationDelegation?.jobId===jobId&&writer.populationDelegation.manifestHash===job.manifestHash&&writer.populationDelegation.authorityHash===job.authorityHash&&String(writer.operationId||'')===String(job.originalOperationId||'');
  const approvalMatches=job=>Array.isArray(job?.manifest)&&hash(job.manifest)===job.manifestHash&&job?.approval?.version===1&&job.approval.manifestHash===job.manifestHash&&job.approval.authorityHash===job.authorityHash&&job.approval.ownerId===ownerId&&job.approval.actorId===actorId&&(scope.environment!=='production'||job.approval.productionConfirmed===true);
  const claimed=await transaction(async session=>{
    await fenceAccess(bound,session);const job=await read(Jobs,{_id:jobId,...scope},session),writer=await read(Writers,scope,session);
    if(!job||!['running','stopping'].includes(job.status)||!approvalMatches(job)||!delegationMatches(writer,job))throw denied('The population job no longer owns its approved writer.');
    if(job.leaseToken&&new Date(job.leaseExpiresAt).getTime()>now())return false;
    if(writer.unresolved!==null)throw denied('An uncertain population cohort holds the company writer.');
    if(job.batch){const dispatchKey=hash({version:1,populationJobId:jobId,batchHash:job.batch.hash}),receipt=await read(Receipts,{_id:hash({scope,dispatchKey}),...scope},session);if(receipt)throw denied('A previous cohort has transport evidence and cannot be recreated.');for(const entry of job.batch.entries){const row=await read(Records,{...scope,logicalKey:entry.logicalKey},session);if(row?.state!=='pending')throw denied('The previous unsent cohort has changed.');}await audit(bound,jobId,'unsent-cohort-recovered',{batchHash:job.batch.hash,revision:job.revision},session);}
    const saved=await Jobs.findOneAndUpdate({_id:jobId,...scope,revision:job.revision},{$set:{leaseToken,leaseExpiresAt:new Date(now()+600000),batch:null},$inc:{revision:1}},{new:true,session}).lean();if(!saved)throw denied('Another population worker changed the job.');return true;
  });
  if(!claimed)return;
  async function readFence() {
    await access.authorize(scope,'operations.execute');const [job,writer]=await Promise.all([read(Jobs,{_id:jobId,...scope}),read(Writers,scope)]);
    if(!job||job.leaseToken!==leaseToken||new Date(job.leaseExpiresAt).getTime()<=now()||job.stopRequested||!delegationMatches(writer,job)||writer.unresolved!==null)throw denied('Population stopped, lost its lease, or has an unsettled request.');
    return {scope,operationId:jobId,revision:writer.revision,unresolved:null,jobRevision:job.revision};
  }
  const validateCreation=require('./business-population-receipt').createPopulationCreationValidator({models,scope,now});
  let batchForTransport=null;
  const transport={
    async receiptEvidence({workflow,request,session}){const job=await read(Jobs,{_id:jobId,...scope},session),batch=job?.batch;if(!batch||batch.hash!==workflow.batchHash||batch.request.requestHash!==request.requestHash)throw denied('The exact cohort request must be retained with its transport receipt.');return {version:1,jobId,batchHash:batch.hash,request:batch.request,entries:batch.entries.map(entry=>({bId:entry.bId,logicalKey:entry.logicalKey,entity:entry.entity,fingerprint:entry.fingerprint,intentHash:entry.intentHash,compilationHash:entry.compilation.compilationHash,requestHash:entry.compilation.request.requestHash}))};},
    async preflight({request,client:transportClient,coordination}){
      const job=await read(Jobs,{_id:jobId,...scope});const batch=job?.batch;if(!batch||batch.request.requestHash!==request.requestHash||job.leaseToken!==leaseToken)throw denied('The exact prepared population cohort is required.');
      const memo=new Map();const memoClient={read:async(entity,id)=>{const key=entity+':'+id;if(!memo.has(key))memo.set(key,transportClient.read(entity,id));return memo.get(key);},query:async(query)=>{if(!memo.has(query))memo.set(query,transportClient.query(query));return memo.get(query);}};
      const proofs=await parallel(batch.entries,entry=>readWritePeriodEvidence(entry.compilation.request,memoClient,now,coordination));
      return {version:1,kind:'population-period-evidence',coordination,scope,requestHash:request.requestHash,batchHash:batch.hash,proofs};
    },
    assertPeriod({request,evidence,controls,ownerId:actualOwner,clock}){
      if(evidence?.kind!=='population-period-evidence'||hash(evidence.scope)!==hash(scope)||evidence.requestHash!==request.requestHash||!Array.isArray(evidence.proofs)||evidence.proofs.length!==batchForTransport?.entries.length)throw denied('Population protected-period evidence is incomplete.');
      const proofs=evidence.proofs.map((proof,index)=>assertWritePeriod(batchForTransport.entries[index].compilation.request,proof,controls,clock,actualOwner));
      return {version:1,kind:'population-period-proof',batchHash:evidence.batchHash,proofs,evidenceHash:hash({requestHash:request.requestHash,proofs})};
    },
    async admit({workflow,request,receiptId,dispatchKey,writer,ownerId:actualOwner,actorId:actualActor,session}){
      const job=await read(Jobs,{_id:jobId,...scope},session),batch=job?.batch;
      if(!job||job.status!=='running'||job.stopRequested||job.leaseToken!==workflow.leaseToken||workflow.leaseToken!==leaseToken||new Date(job.leaseExpiresAt).getTime()<=now()||!approvalMatches(job)||!delegationMatches(writer,job)||writer.unresolved!==null||actualOwner!==ownerId||actualActor!==actorId||workflow.jobId!==jobId||batch?.hash!==workflow.batchHash||batch.request.requestHash!==request.requestHash||batch.request.body!==request.body||now()-Date.parse(batch.preparedAt)>FRESH)throw denied('The exact approved population cohort or writer changed.');
      const active=await assertPublishedBusiness({...models,scope,requireScheduleAcceptance:true,session,fence:true});if(active.authority.contentHash!==job.authorityHash||active.value.blueprintHash!==job.blueprintHash||active.calendar.pendingCommit||active.calendar.stopRequested)throw denied('Population business authority or Stop state changed.');
      const admittedRows=[];
      for(const entry of batch.entries){
        const row=await read(Records,{...scope,logicalKey:entry.logicalKey,state:'pending'},session),descriptor=job.manifest.find(value=>value.logicalKey===entry.logicalKey);
        if(!row||!['Estimate','Invoice','TimeActivity','Payment','Deposit','PurchaseOrder','Bill','SalesReceipt','BillPayment'].includes(row.entity)||!descriptor||row.intentHash!==entry.intentHash||row.intentHash!==hash({step:row.step,policy:row.policy})||row.fingerprint!==hash(row.step)||row.fingerprint!==entry.fingerprint||descriptor.intentHash!==entry.intentHash||descriptor.fingerprint!==entry.fingerprint||row.entity!==entry.entity||row.txnDate>job.throughDate||row.txnDate<job.fromDate)throw denied('A population item differs from its published approved intent.');
        for(const parent of row.step.dependencies){const saved=await read(Records,{...scope,logicalKey:parent.logicalKey,state:'saved'},session);if(!saved||saved.fingerprint!==parent.fingerprint||!saved.receipt||saved.receipt.qboId!==saved.qboId)throw denied('A population dependency is no longer saved.');const evidenceHash=await validateCreation(saved,{session}),observed=JSON.parse(entry.inputsJson).parents.find(value=>value.logicalKey===parent.logicalKey);if(observed?.creationEvidenceHash!==evidenceHash)throw denied('The original parent creation receipt changed before admission.');}
        const inputs=JSON.parse(entry.inputsJson);if(Object.keys(inputs).sort().join(',')!=='observationFence,parents,referenceEvidence')throw denied('Population compilation inputs contain unexpected fields.');
        const compiled=compileBusinessTransaction({...inputs,scope,step:row.step,policy:row.policy,now:now()});if(compiled.compilationHash!==entry.compilation.compilationHash||compiled.request.requestHash!==entry.compilation.request.requestHash||hash(entry.inputsJson)!==entry.inputsHash||JSON.parse(entry.inputsJson).observationFence.writerRevision!==writer.revision)throw denied('Fresh population compilation or writer evidence changed.');
        if(row.entity==='Invoice'){for(const quote of row.step.dependencies.filter(link=>link.entity==='Estimate')){const consumed=await read(Records,{...scope,entity:'Invoice',logicalKey:{$ne:row.logicalKey},state:{$in:['saved','dispatched','unknown']},'step.dependencies.logicalKey':quote.logicalKey},session);if(consumed)throw denied('This Estimate is already reserved by another Invoice.');}}
        admittedRows.push({...row,compilation:entry.compilation,inputsJson:entry.inputsJson,inputsHash:entry.inputsHash});
        const updated=await Records.findOneAndUpdate({_id:row._id,...scope,state:'pending',revision:row.revision},{$set:{state:'dispatched',compilation:entry.compilation,dispatch:{version:1,jobId,batchHash:batch.hash,bId:entry.bId,receiptId,dispatchKey,requestHash:entry.compilation.request.requestHash}},$inc:{revision:1}},{new:true,session}).lean();if(!updated)throw denied('A population item changed during admission.');
      }
      const rebuilt=buildPopulationBatch(scope,admittedRows,batch.requestId);
      if(rebuilt.hash!==batch.hash||rebuilt.request.requestHash!==request.requestHash||rebuilt.request.body!==request.body||canonical(rebuilt.entries.map(({bId,logicalKey})=>({bId,logicalKey})))!==canonical(batch.entries.map(({bId,logicalKey})=>({bId,logicalKey}))))throw denied('The exact wire batch differs from its freshly validated records.');
      const marked=await Jobs.findOneAndUpdate({_id:jobId,...scope,leaseToken,revision:job.revision,'batch.hash':batch.hash},{$set:{'batch.state':'dispatched',leaseExpiresAt:new Date(now()+600000)},$inc:{revision:1}},{new:true,session}).lean();if(!marked)throw denied('The population worker changed during admission.');
      return {version:1,kind:'business-population',key:dispatchKey,jobId,batchHash:batch.hash,requestHash:request.requestHash,actorId,transportConsumed:{receiptId,consumedAt:new Date(now()).toISOString()}};
    },
    async classify({request,response,intuitTid}){const job=await read(Jobs,{_id:jobId,...scope});if(!job?.batch||job.batch.request.requestHash!==request.requestHash)throw denied('The population cohort receipt requires recovery.',true);return classifyPopulationResponse(job.batch,response,intuitTid);},
    async settle({stored,observed,resultAuditId,observedAt,session}){
      const job=await read(Jobs,{_id:jobId,...scope},session),batch=job?.batch;if(!batch||stored.workflow?.jobId!==jobId||stored.workflow.batchHash!==batch.hash||stored.requestHash!==batch.request.requestHash)throw denied('The population response differs from its admitted cohort.',true);
      const outcomes=new Map((observed.items || []).map(item=>[item.bId,item]));
      for(const entry of batch.entries){const item=outcomes.get(entry.bId),state=item?.outcome==='saved'?'saved':item?.outcome==='rejected'?'rejected':'unknown';const row=await read(Records,{...scope,logicalKey:entry.logicalKey,state:'dispatched','dispatch.receiptId':stored._id},session);if(!row)throw denied('A population response item has changed.',true);
        const receipt=state==='saved'?require('./business-population-receipt').populationItemReceipt(scope,{...stored,observed},item,entry):null;
        const updated=await Records.findOneAndUpdate({_id:row._id,...scope,state:'dispatched',revision:row.revision},{$set:{state,...(receipt?{qboId:receipt.qboId,receipt}:{}),lastError:state==='saved'?null:state==='rejected'?'QBO rejected this item. Review its retained fault codes before retry.':'QBO outcome is uncertain. This identity must not be replayed.'},$inc:{revision:1}},{new:true,session}).lean();if(!updated)throw denied('A population result changed during settlement.',true);
      }
      const unknown=observed.outcome==='unknown',rejected=(observed.items||[]).some(item=>item.outcome==='rejected');
      const saved=await Jobs.findOneAndUpdate({_id:jobId,...scope,revision:job.revision,'batch.hash':batch.hash},{$set:{batch:unknown?{...batch,state:'unknown',receiptId:stored._id}:null,...(unknown||rejected?{status:'blocked',lastError:unknown?'An uncertain batch outcome holds the company writer. Saved siblings will not be replayed.':'One or more records were rejected. Accepted siblings are retained.'}:{}),leaseExpiresAt:new Date(now()+600000)},$inc:{revision:1}},{new:true,session}).lean();if(!saved)throw denied('Population settlement could not be saved.',true);
      await audit(bound,jobId,'cohort-result',{batchHash:batch.hash,receiptId:stored._id,resultAuditId,at:observedAt.toISOString(),saved:(observed.items||[]).filter(item=>item.outcome==='saved').length,rejected:(observed.items||[]).filter(item=>item.outcome==='rejected').length,unknown},session);
    },
  };
  const gate=createQboWriteGate({...models,transaction,assertReady,now,populationTransport:transport});
  async function windowRows(month,job){
    const through=[monthEnd(month),job.throughDate].sort()[0],current=await loadRows({...keyQuery,txnDate:{$gte:month,$lte:through}}),all=new Map(current.map(row=>[row.logicalKey,row]));
    for(let depth=0;depth<20;depth++){const missing=[...new Set([...all.values()].flatMap(row=>row.step.dependencies.map(link=>link.logicalKey)).filter(key=>!all.has(key)))];if(!missing.length)break;for(let offset=0;offset<missing.length;offset+=100){const rows=await loadRows({...scope,logicalKey:{$in:missing.slice(offset,offset+100)}});for(const row of rows)all.set(row.logicalKey,row);}if(depth===19)throw denied('Population dependencies exceed20 levels.');}
    const childRows=await loadRows({...keyQuery,state:'saved','step.dependencies.logicalKey':{$in:[...all.keys()]}});for(const row of childRows)all.set(row.logicalKey,row);
    return {current,all:[...all.values()],through};
  }
  async function rememberProofs(values){for(let offset=0;offset<values.length;offset+=25)await Records.bulkWrite(values.slice(offset,offset+25).map(value=>({updateOne:{filter:{...scope,logicalKey:value.logicalKey,state:'saved',qboId:value.qboId,fingerprint:value.fingerprint},update:{$set:{financialProof:value.financialProof,coverageGaps:value.financialProof.coverageGaps}}}})),{ordered:true});}
  try {
    client=await access.resolveClient(scope);const {QBOClient}=require('./qbo-client');if(!(client instanceof QBOClient)||client.apiCall!==QBOClient.prototype.apiCall||String(client.connection.userId)!==ownerId)throw denied('Population requires the original scoped QBO transport.');client.writeGate=gate;
    while(now()-started<600000){
      const job=await read(Jobs,{_id:jobId,...scope});if(job.leaseToken!==leaseToken)throw denied('Population lease changed.');if(job.stopRequested||job.status==='stopping')break;if(job.status!=='running')break;
      const delay=lastBatchAt?Math.max(0,2000-(Date.now()-lastBatchAt)):0;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      const earliest=await Records.findOne({...keyQuery,$or:[{state:{$in:['pending','rejected','unknown','dispatched']}},{state:'saved',financialProof:null}]}).sort({txnDate:1,logicalKey:1}).maxTimeMS(5000).lean();
      if(!earliest){const summary=await counts(job);if(summary.total!==job.manifest.length||summary.saved!==summary.required||summary.unknown||summary.rejected)throw denied('Population completion does not match its exact settled manifest.');await transaction(async session=>{await fenceAccess(bound,session);const current=await read(Jobs,{_id:jobId,...scope},session),writer=await read(Writers,scope,session);if(current.leaseToken!==leaseToken||writer.unresolved!==null||!delegationMatches(writer,current))throw denied('Population completion ownership changed.');const state=summary.coverageGaps?'populated-with-gaps':'populated';await Jobs.updateOne({_id:jobId,...scope,leaseToken,revision:current.revision},{$set:{status:state,leaseToken:null,leaseExpiresAt:null,createdThrough:job.throughDate,counts:summary,lastError:null},$inc:{revision:1}},{session});await audit(bound,jobId,'creation-completed',{manifestHash:job.manifestHash,counts:summary,verifiedCalendarAdvanced:false},session);});leaseToken=null;break;}
      if(['rejected','unknown','dispatched'].includes(earliest.state))throw denied('A failed or uncertain population item requires recovery.');
      const month=earliest.txnDate.slice(0,7)+'-01',window=await windowRows(month,job),frontier=readyPopulationFrontier(window.all).filter(row=>row.txnDate>=month&&row.txnDate<=window.through);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),FRESH);timer.unref?.();
      try {
        const reader=createPopulationReader({scope,jobId,client,records:window.all,readFence,masterCache,validateCreation,now,signal:controller.signal});
        if(!window.current.some(row=>row.state==='pending')){
          if(window.current.some(row=>row.state!=='saved'))throw denied('The population month contains an unsettled item.');await reader.prime(window.all.filter(row=>row.state==='saved'));const proofs=await parallel(window.current,row=>reader.financial(row));await readFence();await rememberProofs(proofs);await Jobs.updateOne({_id:jobId,...scope,leaseToken,status:'running',stopRequested:false},{$set:{createdThrough:window.through,leaseExpiresAt:new Date(now()+600000)},$inc:{revision:1}});continue;
        }
        if(!frontier.length)throw denied('No independent pending records are ready; source identities need recovery.');
        const parentKeys=new Set(frontier.flatMap(row=>row.step.dependencies.map(link=>link.logicalKey))),parents=window.all.filter(row=>parentKeys.has(row.logicalKey)),ancestors=window.all.filter(row=>parents.some(parent=>parent.step.dependencies.some(link=>link.logicalKey===row.logicalKey)));
        const fence=await reader.prime([...parents,...ancestors]),tag={operationId:jobId,writerRevision:fence.revision};
        const financialParents=new Map();for(const parent of parents)financialParents.set(parent.logicalKey,{...await reader.financial(parent),...tag});
        await rememberProofs([...financialParents.values()]);
        let depositProof=null;if(frontier.some(row=>row.entity==='Deposit')){const first=await readPopulationDeposits(client),second=await readPopulationDeposits(client);if(first.hash!==second.hash)throw denied('Deposits changed during population availability checks.');depositProof=second;}
        const entries=await parallel(frontier,async row=>{
          const referenceEvidence=await parallel(row.step.references,async binding=>({...await reader.master(binding.entity,binding.id,{fresh:binding.entity==='Item'&&row.entity==='SalesReceipt'}),...tag}));
          for(const source of row.policy.taxSources||[]){const observed=await reader.master(source.entity,source.id);if(hash(source.record)!==source.recordHash||observed.recordHash!==source.recordHash)throw denied('The approved dated tax sources changed.');}
          const observedParents=row.step.dependencies.map(link=>{const value=financialParents.get(link.logicalKey);if(!value)throw denied('A population parent is missing.');if(row.entity==='Deposit'){if(depositProof.payments.has(value.qboId))throw denied('The exact payment is already deposited.');return {...value,availability:{...tag,scope,observedAt:new Date(now()).toISOString(),kind:'undeposited_payment',status:'available',recordHash:value.recordHash,evidenceHash:hash({scope,paymentId:value.qboId,recordHash:value.recordHash,depositSetHash:depositProof.hash})}};}return value;});
          const inputs={referenceEvidence,parents:observedParents,observationFence:{scope,...tag,observedAt:new Date(now()).toISOString()}},compiled=compileBusinessTransaction({scope,step:row.step,policy:row.policy,...inputs,now:now()});return {...row,compilation:{...compiled.dispatchEvidence.artifact,compilationHash:compiled.compilationHash},inputsJson:JSON.stringify(inputs),inputsHash:hash(JSON.stringify(inputs))};
        });
        const currentFence=await readFence();if(canonical(currentFence)!==canonical(fence))throw denied('The writer changed during population compilation.');
        let admitted=entries;
        for(;;){batchForTransport={...buildPopulationBatch(scope,admitted,hash({jobId,revision:job.revision,keys:admitted.map(row=>row.logicalKey)}).slice(0,32)),state:'prepared',preparedAt:new Date(now()).toISOString()};if(Buffer.byteLength(JSON.stringify(batchForTransport))<=8000000)break;if(admitted.length===1)throw denied('One population item exceeds the8MB retained evidence budget.');admitted=admitted.slice(0,Math.ceil(admitted.length/2));}
        const saved=await Jobs.findOneAndUpdate({_id:jobId,...scope,leaseToken,revision:job.revision,status:'running',stopRequested:false,batch:null},{$set:{batch:batchForTransport,leaseExpiresAt:new Date(now()+600000)},$inc:{revision:1}},{new:true}).lean();if(!saved)throw denied('Population stopped or changed before reserving its cohort.');
        // Once admitted, await the original POST and its durable per-item settlement.
        lastBatchAt=Date.now();
        await withWriteWorkflow({version:1,kind:'business-population',jobId,batchHash:batchForTransport.hash,leaseToken},async()=>{},()=>client.apiCall('POST',batchForTransport.request.endpoint,JSON.parse(batchForTransport.request.body)));
        cohorts++;
        const metrics={startedAt:new Date(started).toISOString(),elapsedMs:now()-started,cohorts,transport:'QBO batch',maxBatchSize:30};await Jobs.updateOne({_id:jobId,...scope,leaseToken},{$set:{metrics}});
      } finally {clearTimeout(timer);controller.abort();}
    }
  } finally {
    if(leaseToken)await transaction(async session=>{const job=await read(Jobs,{_id:jobId,...scope},session);if(job?.leaseToken!==leaseToken)return;const writer=await read(Writers,scope,session);const status=job.stopRequested&&writer.unresolved===null&&!job.batch?'stopped':job.status;await Jobs.updateOne({_id:jobId,...scope,leaseToken,revision:job.revision},{$set:{leaseToken:null,leaseExpiresAt:null,status},$inc:{revision:1}},{session});});
  }
}
module.exports={runPopulationJob};
