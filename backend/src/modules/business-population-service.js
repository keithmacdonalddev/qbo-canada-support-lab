'use strict';
const { randomUUID } = require('node:crypto');
const { hash, canonical, date } = require('./business-calendar');
const { scoped, denied } = require('./qbo-write-contract');
const { createBusinessTransaction } = require('./business-transaction');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessStorageReadiness } = require('./business-runtime-storage');
const { assertPublishedBusiness } = require('./business-authority');
const { assertOwnerAttribution } = require('./business-owner-attribution');
const { createBusinessOperationPlanStore } = require('./business-operation-plan-store');
const { preparePopulationPlan } = require('./business-population-plan');
const { validateCompilation } = require('./business-readback');
const populationIssues = require('./business-population-issues');
const { createPopulationVerification, publicVerification } = require('./business-population-verification');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
const done = status => ['populated','populated-with-gaps'].includes(status);
const recordId = (scope,key) => hash({scope,logicalKey:key});
function exact(body,keys) { if(!body || Object.getPrototypeOf(body)!==Object.prototype || Object.keys(body).sort().join(',')!==[...keys].sort().join(','))throw Object.assign(denied('Use the exact population action without company/state overrides.'),{status:400}); }
function createBusinessPopulationService(options = {}) {
  const connection=options.connection || require('mongoose').connection;
  const base=options.models || require('./business-runtime').loadModels();
  const models={...base,Jobs:base.Jobs || require('../models/BusinessPopulationJob'),Records:base.Records || require('../models/BusinessPopulationRecord')};
  const {Jobs,Records}=models,transaction=options.transaction || createBusinessTransaction(connection),now=options.now || (()=>Date.now());
  const assertReady=options.assertReady || createBusinessStorageReadiness({connection,models:base});
  const resolve=options.resolveContext || require('./rebuild-context').createContextService().resolve;
  const accessFor=options.accessFor || (input=>createBusinessRuntimeAccess({...input,...models}));
  const read=(Model,query,session)=>Model.findOne(query).session(session).maxTimeMS(5000).lean();
  async function pageRows(Model,query,session,projection=null){const result=[];let after=null,bytes=0;for(;;){let cursor=Model.find({...query,...(after?{_id:{$gt:after}}:{})},null,{singleBatch:true,batchSize:101}).sort({_id:1}).limit(100).session(session).maxTimeMS(5000);if(projection)cursor=cursor.select(projection);const page=await cursor.lean();if(!page.length)return result;bytes+=Buffer.byteLength(JSON.stringify(page));result.push(...page);if(result.length>40000||bytes>128000000)throw denied('Population preparation exceeds its bounded record budget.');after=page.at(-1)._id;}}
  const creationIdentity=row=>({logicalKey:row.logicalKey,entity:row.entity,qboId:row.qboId,fingerprint:row.fingerprint,compilationHash:row.compilation.compilationHash,receiptHash:hash(row.receipt),dispatchHash:hash(row.dispatch)});
  const jobs=new Map();let interval=null,closed=false,scanPromise=null;
  const verification = createPopulationVerification({models,bind,bindJob,read,transaction,fenceAccess,audit,now,publicJob,pageRows,counts,createReadQueue:options.createReadQueue});
  async function bind(user,action='operations.read') {
    const value=await resolve(user),scope=scoped({environment:value.environment,realmId:value.connection?.realmId,connectionId:value.connection?.connectionId}),ownerId=String(user.id),actorId=String(user.actorId || user.id),access=accessFor({ownerId,actorId});
    await assertReady();await access.authorize(scope,action);
    return {scope,ownerId,actorId,access};
  }
  async function bindJob(id) {
    if(!ID.test(id || ''))throw denied('Use an exact saved population job.');
    const job=await read(Jobs,{_id:id});if(!job)throw Object.assign(denied('Population job not found.'),{status:404});
    const scope=scoped({environment:job.environment,realmId:job.realmId,connectionId:String(job.connectionId)}),ownerId=String(job.ownerId),actorId=String(job.actorId),access=accessFor({ownerId,actorId});
    await assertReady();await access.authorize(scope,'operations.execute');return {job,scope,ownerId,actorId,access};
  }
  async function fenceAccess(bound,session,action='operations.execute') {
    const actor=await bound.access.authorize(bound.scope,action,{session});
    if(actor.actorId!==bound.actorId || actor.ownerId!==bound.ownerId)throw denied('Population workspace authority changed.');
    for(const id of new Set([bound.ownerId,bound.actorId])) if((await models.Users.updateOne({_id:id,role:{$in:['agent','supervisor']}},{$inc:{connectionSwitchVersion:1}},{session})).matchedCount!==1)throw denied('Population user changed.');
    if((await models.Connections.updateOne({_id:bound.scope.connectionId,userId:bound.ownerId,realmId:bound.scope.realmId,status:'active'},{$inc:{businessSetupVersion:1}},{session})).matchedCount!==1)throw denied('Population company selection changed.');
    if((await models.Memberships.updateOne({userId:bound.actorId,realmId:bound.scope.realmId,status:'active'},{$inc:{businessSetupVersion:1}},{session})).matchedCount!==1)throw denied('Population membership changed.');
  }
  async function audit(bound,jobId,phase,data,session) {
    const id=hash({jobId,phase,data}).slice(0,24);
    if(phase==='relationship-evidence-observed'){const existing=await read(models.Audits,{_id:id,realmId:bound.scope.realmId},session);if(existing){if(String(existing.userId)!==bound.ownerId||String(existing.actorUserId||existing.userId)!==bound.actorId||existing.action!=='Business population '+phase||existing.actionType!=='manual'||existing.outcome!=='success'||canonical(existing.afterState)!==canonical({...bound.scope,jobId,...data}))throw denied('The original relationship observation audit changed.');return id;}}
    await models.Audits.create([{_id:id,userId:bound.ownerId,actorUserId:bound.actorId!==bound.ownerId?bound.actorId:undefined,realmId:bound.scope.realmId,action:'Business population '+phase,actionType:'manual',outcome:'success',afterState:{...bound.scope,jobId,...data}}],{session});return id;
  }
  async function counts(job) {
    const rows=await Records.aggregate([{$match:{environment:job.environment,realmId:job.realmId,authorityHash:job.authorityHash,txnDate:{$gte:job.fromDate,$lte:job.throughDate}}},{$group:{_id:null,total:{$sum:1},saved:{$sum:{$cond:[{$eq:['$state','saved']},1,0]}},pending:{$sum:{$cond:[{$eq:['$state','pending']},1,0]}},rejected:{$sum:{$cond:[{$eq:['$state','rejected']},1,0]}},unknown:{$sum:{$cond:[{$in:['$state',['unknown','dispatched']]},1,0]}},contentChecked:{$sum:{$cond:[{$ne:[{$ifNull:['$financialProof',null]},null]},1,0]}},coverageGaps:{$sum:{$cond:[{$gt:[{$size:{$ifNull:['$coverageGaps',[]]}},0]},1,0]}},estimateGaps:{$sum:{$cond:[{$in:['estimate-invoice-conversion-unverified',{$ifNull:['$coverageGaps',[]]}]},1,0]}},timeGaps:{$sum:{$cond:[{$in:['time-invoice-billing-unverified',{$ifNull:['$coverageGaps',[]]}]},1,0]}},verificationErrors:{$sum:{$cond:[{$or:[{$eq:['$relationshipCheck.outcome','error']},{$and:[{$eq:['$state','saved']},{$eq:[{$ifNull:['$financialProof',null]},null]}]}]},1,0]}}}}]).option({maxTimeMS:5000});
    const summary={required:job.manifest.length,total:0,saved:0,pending:0,rejected:0,unknown:0,contentChecked:0,coverageGaps:0,estimateGaps:0,timeGaps:0,verificationErrors:0,...(rows[0] || {})};delete summary._id;return summary;
  }
  async function publicJob(job) {
    if(!job)return null;
    const writer=job.batch?.state==='prepared'?await read(models.Writers,{environment:job.environment,realmId:job.realmId,connectionId:job.connectionId}):null;const unsentRecoverable=writer?await recoverableUnsent(job,writer):false;
    const summary=await counts(job);
    return {issueGroups:populationIssues.DEFINITIONS.map((definition,index)=>({...definition,count:[summary.estimateGaps,summary.timeGaps,summary.verificationErrors][index] || 0})),relationshipVerification:publicVerification(job.verification),relationshipPolicyVersion:job.relationshipPolicyVersion || 0,jobId:String(job._id),scope:{environment:job.environment,realmId:job.realmId,connectionId:String(job.connectionId)},manifestHash:job.manifestHash,status:job.status,fromDate:job.fromDate,throughDate:job.throughDate,createdThrough:job.createdThrough,imported:job.importedCount,counts:summary,stopRequested:job.stopRequested,lastError:job.lastError,metrics:job.metrics,approved:Boolean(job.approval),batch:job.batch?{size:job.batch.entries.length,state:job.batch.state || 'prepared',unsentRecoverable}:null,verification:'Creation/content progress only; full relationship, report and reconciliation verification is separate.'};
  }
  async function status(user) {
    const bound=await bind(user),job=await Jobs.findOne(bound.scope).sort({createdAt:-1}).maxTimeMS(5000).lean();
    return {scope:bound.scope,owner:bound.actorId===bound.ownerId,job:await publicJob(job)};
  }
  async function nativeOrigins(bound,writer) {
    if(!writer.operationId)return {intents:[],rows:[],identities:[],operation:null};
    const operation=await read(models.Runs,{_id:writer.operationId,...bound.scope});
    if(!operation || !['blocked','stopped','awaiting-evidence'].includes(operation.status) || operation.leaseToken || operation.executionRequest?.pending || operation.planHash!==writer.planHash)throw denied('The original business operation must be settled and idle before population delegation.');
    const plans=createBusinessOperationPlanStore({...models,transaction,assertReady,authorize:bound.access.authorize,readOnly:true,now});
    const intents=[];for(let offset=0;offset<operation.recordCount;offset+=50){const page=await plans.page(bound.scope,String(operation._id),offset,50);intents.push(...page.entries.map(({step,policy})=>({step,policy}))); }
    const rows=await pageRows(models.Steps,{...bound.scope,operationId:operation._id},null,'operationId planHash logicalKey entity fingerprint state compilation dispatch receipt qboId');
    if(rows.some(row=>['dispatched','unknown','rejected'].includes(row.state)))throw denied('Settle every original native dispatch before population delegation.');
    const accepted=rows.filter(row=>['saved','verified'].includes(row.state)),identities=[];
    for(const row of accepted){validateCompilation(row.compilation);await assertOwnerAttribution(models,bound.scope,row);
      if(row.receipt?.source!=='owner-attributed-readback'){
        const receiptId=hash({scope:bound.scope,dispatchKey:row.dispatch?.key}),transport=await read(models.Receipts,{_id:receiptId,...bound.scope,kind:'business',state:'saved',operationId:row.operationId,logicalKey:row.logicalKey});
        if(!transport || transport.requestHash!==row.receipt?.requestHash || transport.dispatchKey!==row.receipt?.dispatchKey || transport.observed?.qboId!==row.qboId || !transport.startAuditId || !transport.resultAuditId)throw denied('An original record lacks its exact accepted native transport receipt.');
        const evidence=require('./business-dispatch-receipt').businessTransportEvidence({...row,...bound.scope,operationId:String(row.operationId)},transport);if(!evidence)throw denied('The original transport evidence is not saved.');const audits=[];for(const expected of evidence.audits)audits.push(await read(models.Audits,{_id:expected.id,realmId:bound.scope.realmId}));require('./business-dispatch-receipt').assertBusinessTransportAudits(transport,evidence,audits);
      }
      if(row.receipt?.qboId!==row.qboId || row.compilation.intentHash!==row.fingerprint || row.compilation.request.requestHash!==row.receipt.requestHash)throw denied('An original saved identity lacks exact receipt evidence.');identities.push(creationIdentity(row));}
    identities.sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey));return {intents,rows:accepted,identities,operation};
  }
  async function prepare(user,body) {
    exact(body,['throughDate','requestKey']);date(body.throughDate);if(!/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestKey||''))throw denied('Use a retained population request identifier.');
    const bound=await bind(user,'operations.preview');if(bound.ownerId!==bound.actorId)throw denied('Only the company owner can prepare population.');
    if(await read(Jobs,{...bound.scope,'verification.status':{$in:['queued','running']}}))throw denied('Finish the company relationship recheck before preparing more records.');
    const active=await assertPublishedBusiness({...models,scope:bound.scope,requireScheduleAcceptance:true,verifyBaseline:true});
    const jobId=hash({scope:bound.scope,authorityHash:active.authority.contentHash,throughDate:body.throughDate,purpose:'business-population-v1'}).slice(0,24),existing=await read(Jobs,{_id:jobId,...bound.scope});if(existing)return {scope:bound.scope,job:await publicJob(existing),reused:true};
    const writer=await read(models.Writers,bound.scope),calendar=active.calendar;
    if(!writer || writer.unresolved!==null || calendar.pendingCommit || calendar.stopRequested)throw denied('Settle company writes and its Stop request before preparing population.');
    if(writer.populationDelegation){const previous=await read(Jobs,{_id:writer.populationDelegation.jobId,...bound.scope});if(!previous||!done(previous.status)||previous.batch||previous.leaseToken)throw denied('Finish the current population job before preparing another date range.');}
    const origins=await nativeOrigins(bound,writer),client=await bound.access.resolveClient(bound.scope);
    await require('./business-country').readCanadianCompany(client,bound.scope,now);
    const [setup,masters]=await Promise.all([require('./blueprint-draft').readDraftSetup(client,bound.scope,now),require('./business-master-data').readBusinessMasters(client,bound.scope,now)]);
    const prior=await pageRows(Records,{...bound.scope,authorityHash:active.authority.contentHash},null,'step policy logicalKey');
    const plan=await (options.preparePlan || preparePopulationPlan)({active,scope:bound.scope,throughDate:body.throughDate,setup,masters,access:bound.access,originalIntents:origins.intents,existingRecords:prior,now:now()});
    const saved=new Map(origins.rows.map(row=>[row.logicalKey,row]));
    // Explicit owner-requested schema preparation; no startup initialization.
    for(const Model of [Jobs,Records]){await Model.createCollection();await Model.createIndexes();}
    for(let offset=0;offset<plan.records.length;offset+=250){const rows=plan.records.slice(offset,offset+250);await Records.bulkWrite(rows.map(row=>{const original=saved.get(row.logicalKey),origin=original?{kind:'native-operation',operationId:String(original.operationId),planHash:original.planHash,identity:origins.identities.find(value=>value.logicalKey===row.logicalKey)}:null;return {updateOne:{filter:{_id:recordId(bound.scope,row.logicalKey)},update:{$setOnInsert:{_id:recordId(bound.scope,row.logicalKey),version:1,...bound.scope,authorityHash:active.authority.contentHash,...row,origin,state:original?'saved':'pending',...(original?{qboId:original.qboId,compilation:original.compilation,receipt:{version:1,scope:bound.scope,entity:original.entity,logicalKey:original.logicalKey,...original.receipt}}:{}),revision:0}},upsert:true}};}),{ordered:true});}
    const retained=await pageRows(Records,{...bound.scope,authorityHash:active.authority.contentHash,txnDate:{$gte:plan.fromDate,$lte:plan.throughDate}},null,'logicalKey fingerprint intentHash entity txnDate');
    const manifest=retained.map(row=>({logicalKey:row.logicalKey,fingerprint:row.fingerprint,intentHash:row.intentHash,entity:row.entity,txnDate:row.txnDate})).sort((a,b)=>a.txnDate.localeCompare(b.txnDate)||a.logicalKey.localeCompare(b.logicalKey));
    if(hash(manifest)!==plan.manifestHash)throw denied('The population ledger differs from the immutable published manifest.');
    await transaction(async session=>{
      await fenceAccess(bound,session,'operations.preview');
      if(await read(Jobs,{...bound.scope,'verification.status':{$in:['queued','running']}},session))throw denied('Finish the company relationship recheck before preparing more records.');
      const latest=await read(models.Writers,bound.scope,session);if(latest.revision!==writer.revision || latest.unresolved!==null)throw denied('Company activity changed during population preparation.');
      const current=await assertPublishedBusiness({...models,scope:bound.scope,requireScheduleAcceptance:true,session,fence:true});if(current.authority.contentHash!==active.authority.contentHash)throw denied('The published business changed during population preparation.');
      const job={_id:jobId,version:1,...bound.scope,ownerId:bound.ownerId,actorId:bound.actorId,authorityHash:active.authority.contentHash,blueprintHash:active.value.blueprintHash,originalOperationId:writer.operationId || null,fromDate:plan.fromDate,throughDate:plan.throughDate,manifest:plan.manifest,manifestHash:plan.manifestHash,importedHash:hash(origins.identities),importedCount:origins.identities.length,relationshipPolicyVersion:1,status:'prepared',revision:0};
      await Jobs.create([job],{session});await audit(bound,jobId,'prepared',{manifestHash:plan.manifestHash,records:plan.records.length,imported:origins.identities.length,qboWrites:0},session);
    });
    return {scope:bound.scope,job:await publicJob(await read(Jobs,{_id:jobId,...bound.scope})),reused:false};
  }
  async function recoverableUnsent(job,writer,session){
    if(job.batch?.state!=='prepared'||writer.unresolved!==null||writer.populationDelegation?.jobId!==String(job._id))return false;
    const dispatchKey=hash({version:1,populationJobId:String(job._id),batchHash:job.batch.hash});
    if(await read(models.Receipts,{...scoped({environment:job.environment,realmId:job.realmId,connectionId:String(job.connectionId)}),$or:[{_id:hash({scope:scoped({environment:job.environment,realmId:job.realmId,connectionId:String(job.connectionId)}),dispatchKey})},{'workflow.jobId':String(job._id),'workflow.batchHash':job.batch.hash}]},session))return false;
    for(const entry of job.batch.entries){const row=await read(Records,{environment:job.environment,realmId:job.realmId,connectionId:job.connectionId,logicalKey:entry.logicalKey},session);if(row?.state!=='pending'||row.receipt||row.qboId||row.intentHash!==entry.intentHash||row.fingerprint!==entry.fingerprint)return false;}
    return true;
  }
  async function start(user,id,body) {
    exact(body,['manifestHash','confirmProduction',...(Object.hasOwn(body||{},'retryRejected')?['retryRejected']:[])]);if((body.retryRejected!==undefined&&typeof body.retryRejected!=='boolean')||!ID.test(id||'')||!HASH.test(body.manifestHash||'')||typeof body.confirmProduction!=='boolean')throw denied('Use the exact prepared population manifest.');
    const bound=await bind(user,'operations.execute');if(bound.actorId!==bound.ownerId)throw denied('Only the company owner can start population.');
    await transaction(async session=>{
      await fenceAccess(bound,session);const job=await read(Jobs,{_id:id,...bound.scope},session),writer=await read(models.Writers,bound.scope,session),policy=await read(models.Policies,bound.scope,session);
      if(!job||!Array.isArray(job.manifest)||hash(job.manifest)!==job.manifestHash||job.manifestHash!==body.manifestHash||String(job.ownerId)!==bound.ownerId||job.actorId.toString()!==bound.actorId||!policy||policy.state!=='active'||!writer||writer.unresolved!==null||(bound.scope.environment==='production'&&!body.confirmProduction))throw denied('Population approval or company coordination changed.');
      if(await read(Jobs,{...bound.scope,_id:{$ne:id},'verification.status':{$in:['queued','running']}},session))throw denied('Finish the other company relationship recheck before adding records.');
      if(['queued','running'].includes(job.verification?.status))throw denied('Stop the relationship recheck before adding records.');
      if(done(job.status))return;
      if((job.batch&&!await recoverableUnsent(job,writer,session)) || (job.leaseToken&&new Date(job.leaseExpiresAt).getTime()>now()))throw denied('Population is active or has an unsettled cohort.');
      const unsettled=await pageRows(Records,{...bound.scope,authorityHash:job.authorityHash,txnDate:{$gte:job.fromDate,$lte:job.throughDate},state:{$in:['rejected','unknown','dispatched']}},session);
      if(unsettled.some(row=>row.state!=='rejected')||(unsettled.length&&!body.retryRejected))throw denied('A rejected or uncertain population item needs its explicit recovery before restart.');
      if(unsettled.length){
        const validateRejected=require('./business-population-receipt').createPopulationCreationValidator({models,scope:bound.scope,now,allowRejected:true}),retried=[];
        for(const row of unsettled){const descriptor=job.manifest.find(entry=>entry.logicalKey===row.logicalKey);if(!descriptor||descriptor.intentHash!==row.intentHash||descriptor.fingerprint!==row.fingerprint||row.dispatch?.jobId!==id)throw denied('A rejected identity differs from this approved manifest.');const rejection=await validateRejected(row,{session}),history=[...(row.retryHistory||[]),{version:1,dispatch:row.dispatch,compilation:row.compilation,rejection,at:new Date(now()).toISOString(),actorId:bound.actorId}];
          const updated=await Records.findOneAndUpdate({_id:row._id,...bound.scope,state:'rejected',revision:row.revision,qboId:{$exists:false},receipt:null},{$set:{state:'pending',dispatch:null,compilation:null,lastError:null,retryHistory:history},$inc:{revision:1}},{new:true,session}).lean();if(!updated)throw denied('The rejected identity changed before its audited retry.');retried.push({logicalKey:row.logicalKey,...rejection});}
        await audit(bound,id,'definite-rejections-retried',{manifestHash:job.manifestHash,revision:job.revision,items:retried},session);
      }
      const active=await assertPublishedBusiness({...models,scope:bound.scope,requireScheduleAcceptance:true,session,fence:true});
      if(active.authority.contentHash!==job.authorityHash||active.value.blueprintHash!==job.blueprintHash||active.calendar.stopRequested||active.calendar.pendingCommit||String(writer.operationId||'')!==String(job.originalOperationId||''))throw denied('Population business authority or calendar changed.');
      const delegated=writer.populationDelegation;
      if(delegated&&delegated.jobId!==id){const previous=await read(Jobs,{_id:delegated.jobId,...bound.scope},session);if(!previous||!done(previous.status)||previous.batch||previous.leaseToken)throw denied('Another population job owns this writer.');}
      if(!delegated||delegated.jobId!==id){
        const originalRows=writer.operationId?await pageRows(models.Steps,{...bound.scope,operationId:writer.operationId},session,'operationId planHash logicalKey entity fingerprint state compilation dispatch receipt qboId'):[];
        if(writer.operationId){const run=await read(models.Runs,{_id:writer.operationId,...bound.scope},session);if(!run||run.leaseToken||run.executionRequest?.pending||!['blocked','stopped','awaiting-evidence'].includes(run.status)||run.planHash!==writer.planHash)throw denied('The original operation is no longer idle.');const fenced=await models.Runs.findOneAndUpdate({_id:run._id,...bound.scope,executionRevision:run.executionRevision,status:run.status,leaseToken:null,executionRequest:run.executionRequest||null},{$inc:{executionRevision:1}},{new:true,session}).lean();if(!fenced)throw denied('The original operation changed during writer handoff.');}
        if(originalRows.some(row=>['dispatched','unknown','rejected'].includes(row.state)))throw denied('Original dispatch recovery is required.');
        const identities=originalRows.filter(row=>['saved','verified'].includes(row.state)).map(creationIdentity).sort((a,b)=>a.logicalKey.localeCompare(b.logicalKey));if(hash(identities)!==job.importedHash)throw denied('The original saved identities changed before delegation.');
        const delegation={version:1,kind:'business-population',jobId:id,manifestHash:job.manifestHash,authorityHash:job.authorityHash,originalOperationId:job.originalOperationId?String(job.originalOperationId):null,importedHash:job.importedHash,delegatedAt:new Date(now()).toISOString()};
        const updated=await models.Writers.findOneAndUpdate({_id:writer._id,...bound.scope,revision:writer.revision,unresolved:null},{$set:{populationDelegation:delegation},$inc:{revision:1}},{new:true,session}).lean();if(!updated)throw denied('Company writer changed during delegation.');
      }
      const approval=job.approval || {version:1,actorId:bound.actorId,ownerId:bound.ownerId,manifestHash:job.manifestHash,authorityHash:job.authorityHash,approvedAt:new Date(now()).toISOString(),productionConfirmed:body.confirmProduction};
      const updated=await Jobs.findOneAndUpdate({_id:id,...bound.scope,revision:job.revision},{$set:{status:'running',approval,stopRequested:false,lastError:null},$inc:{revision:1}},{new:true,session}).lean();if(!updated)throw denied('The population job changed before starting.');await audit(bound,id,'started',{manifestHash:job.manifestHash,revision:updated.revision},session);
    });
    kick(id);return {scope:bound.scope,job:await publicJob(await read(Jobs,{_id:id,...bound.scope})),accepted:true};
  }
  async function stop(user,id) {
    const bound=await bind(user,'operations.stop');if(!ID.test(id||'')||bound.actorId!==bound.ownerId)throw denied('Only the company owner can stop its population job.');
    await transaction(async session=>{await fenceAccess(bound,session,'operations.stop');const job=await read(Jobs,{_id:id,...bound.scope},session);if(!job)throw denied('Population job not found.');if(done(job.status)||job.status==='stopped')return;const updated=await Jobs.findOneAndUpdate({_id:id,...bound.scope,revision:job.revision},{$set:{stopRequested:true,status:job.leaseToken||job.batch?'stopping':'stopped'},$inc:{revision:1}},{new:true,session}).lean();if(!updated)throw denied('Population changed during Stop.');await audit(bound,id,'stop-requested',{revision:updated.revision},session);});return {scope:bound.scope,job:await publicJob(await read(Jobs,{_id:id,...bound.scope}))};
  }
  function kick(id) {
    if(closed||jobs.has(id))return;
    const work=Promise.resolve().then(async()=>{const bound=await bindJob(id);return require('./business-population-runtime').runPopulationJob({...bound,models,transaction,assertReady,now,audit,fenceAccess,counts,readQueue:options.createReadQueue?.()});}).catch(async error=>{try{
      if(error.status===429&&error.outcomeUnknown!==true){const job=await read(Jobs,{_id:id}),writer=job?await read(models.Writers,{environment:job.environment,realmId:job.realmId,connectionId:job.connectionId}):null;if(job&&['running','stopping'].includes(job.status)&&!job.batch&&!job.leaseToken&&writer?.unresolved===null){await Jobs.updateOne({_id:id,revision:job.revision,batch:null,leaseToken:null},{$set:{status:job.stopRequested?'stopped':'running',retryAfter:new Date(now()+65000),lastError:'Waiting for the QuickBooks rate limit. Saved records are retained.'},$inc:{revision:1}});return;}}
      await Jobs.updateOne({_id:id,status:{$in:['running','stopping']}},{$set:{status:'blocked',diagnostics:{type:error.name,stage:error.qboStage||null,message:require('./log-diagnostic').redactLogSecrets(error.message).slice(0,1000),stack:require('./log-diagnostic').redactLogSecrets(error.stack).split('\n').slice(0,5).join('\n')},lastError:error.qboStage==='write_receipt'?'A cohort has an uncertain QBO outcome. Its saved identities are retained; do not replay it.':(error.qboStage==='write_admission'||error.code&&/^BUSINESS_/.test(error.code))?error.message:'Population stopped at a safety check. Saved records and dispatch evidence are retained.'}});}catch{/* Preserve durable dispatch barriers if storage is unavailable. */}}).finally(()=>jobs.delete(id));jobs.set(id,work);
  }
  async function scan(){if(closed||scanPromise)return scanPromise;scanPromise=(async()=>{await assertReady();const rows=await Jobs.find({status:{$in:['running','stopping']}}).select('_id').sort({_id:1}).limit(20).maxTimeMS(5000).lean();for(const row of rows)kick(String(row._id));await verification.scan();})().catch(()=>{}).finally(()=>{scanPromise=null;});return scanPromise;}
  function startWorker(){if(interval||closed)return;interval=setInterval(()=>void scan(),10000);interval.unref?.();void scan();}
  function close(){closed=true;verification.close();if(interval)clearInterval(interval);interval=null;}
  return {status,prepare,start,stop,startWorker,close,scan,issues:verification.list,recheck:verification.start,stopRecheck:verification.stop,documentLimitation:verification.limitation,drain:async()=>Promise.allSettled([...jobs.values(),verification.drain()])};
}
let singleton;function getBusinessPopulationService(){return singleton ||= createBusinessPopulationService();}
module.exports={createBusinessPopulationService,getBusinessPopulationService,recordId};
