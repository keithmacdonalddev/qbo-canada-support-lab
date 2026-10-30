'use strict';
const { randomUUID } = require('node:crypto');
const { hash } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { createBusinessAgentStore, scopeOf } = require('./business-agent-store');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessAgentEngine } = require('./business-agent-engine');
const { createBusinessAgentTools, businessAgentCapabilities } = require('./business-agent-tools');
const { businessWork, rightNow } = require('./business-agent-work');
const { createReviewProgress } = require('./business-agent-progress');
const { createBusinessAgentUsage, reviewPause } = require('./business-agent-usage');
const { DEFAULT_SETTINGS, validateControl, reduceControl, fail, ID } = require('./business-agent-policy');
const { runAsActor } = require('./actor-context');
const iso=value=>value?new Date(value).toISOString():null;
const at=value=>value?new Date(value).getTime():0;
const safeError=error=>require('./log-diagnostic').redactLogSecrets(/^(BUSINESS_|QBO_)/.test(error?.code||'')?error.message:error?.aiProvider?'The model service could not finish this review. Check the AI connection in Settings.':'The business worker could not finish. Saved records, decisions and cursors are retained.').slice(0,700);
function publicSync(row,clock){
  const settings={...DEFAULT_SETTINGS,...(row?.settings||{})},view=row?.syncView;
  if(!view)return {status:settings.monitoring?'initializing':'not-configured',lastSuccessAt:null,sources:[],company:{counts:{},totals:{currency:'CAD'},recent:[]}};
  const age=Math.max(settings.syncIntervalSeconds*4000,120000),sources=(view.sources||[]).map(source=>({...source,status:source.status==='current'&&(source.freshUntil?clock>at(source.freshUntil):clock-at(source.lastSuccessAt)>age)?'stale':source.status}));
  const stale=!settings.monitoring||!view.lastSuccessAt||sources.some(source=>source.status!=='current')||clock-at(view.summaryAt||view.company?.observedAt||row.sync?.summaryAt||view.lastSuccessAt)>age;
  return {...view,sources,status:view.status==='current'&&stale?'stale':view.status,company:{...(view.company||{}),provisional:stale||view.status!=='current'}};
}
function createBusinessAgentService(options={}) {
  const now=options.now||(()=>Date.now()),store=options.store||createBusinessAgentStore({...options,now});
  const usage=options.usage||createBusinessAgentUsage({now});
  const usageView=async(scope,row)=>{let view;try{view=await usage.summary(scope);}catch{view={unavailable:true};}const quota=[view.quota,row?.codexQuota].filter(value=>value&&at(value.detectedAt)>at(row?.codexQuotaClearedAt)).sort((a,b)=>at(b.detectedAt)-at(a.detectedAt))[0]||null;return {...view,caps:row?.settings?.monthlyCaps||{apiUsd:null,tokens:null},planLimit:quota,pause:reviewPause(view,row?.settings,quota,now(),require('../config').ai.provider)};};
  const resolve=options.resolveContext||require('./rebuild-context').createContextService().resolve;
  const accessFor=options.accessFor||createBusinessRuntimeAccess;
  const engine=options.engine||createBusinessAgentEngine({now});
  const makeSync=options.createSync||require('./business-agent-sync').createBusinessAgentSync;
  const execution=options.execution||require('./business-execution-service').getBusinessExecutionService();
  const governanceFor=options.governanceFor||((origin)=>require('./business-governance-service').createBusinessGovernanceService({...(origin?{agentAuthority:origin,Agents:store.models.Agents}:{})}));
  const coverageFor=options.coverageFor||(scope=>{try{return require('./coverage').getCached(scope.realmId);}catch{return null;}});
  const jobs=new Map();let interval=null,scanPromise=null,closed=false,lastScanError=null;
  const leaseMs=240000,scanMs=5000;
  async function bind(user,action='operations.read') {
    const ownerId=String(user?.id||''),actorId=String(user?.actorId||user?.id||'');
    if(!ID.test(ownerId)||!ID.test(actorId))fail('Sign in to the selected company.',403);
    const context=await resolve(user);if(!context.connection?.connected)fail('Connect a company before using business monitoring.');
    const scope=scoped({environment:context.environment,realmId:context.connection.realmId,connectionId:context.connection.connectionId});
    const access=accessFor({actorId,ownerId});await access.authorize(scope,action);
    return {scope,ownerId,actorId,access,action,companyName:context.connection.companyName||'Company'};
  }
  async function workspace(bound,row) {
    let business;try{business=await store.business(bound.scope);}catch{business={scope:bound.scope,published:null,unavailable:true,verifiedThrough:null,recordsThrough:null,recordCount:null,currentOperation:null,blockers:[{code:'business-state-unavailable',title:'Business state needs another read',detail:'Saved business evidence could not be read. Current controls and monitoring state remain available.',href:'/company/manage'}]};}
    const settings={...DEFAULT_SETTINGS,...(row?.settings||{}),specialists:[...(row?.settings?.specialists||[])]};
    const sync=publicSync(row,now()),usageState=await usageView(bound.scope,row);
    const events=row?await store.events(row):[],decisions=row?await store.decisions(row):[];
    await bound.access.authorize(bound.scope,'operations.read');
    const expired=row?.leaseToken&&at(row.leaseExpiresAt)<=now();
    // A review is happening right now only while it holds a live lease with an active pass.
    const reviewing=Boolean(row?.leaseToken&&!expired&&row.activePass&&row.status==='reviewing');
    // Duty facts come from saved records only; any failure just omits them.
    let facts=null;if(row&&business.published&&typeof store.workFacts==='function'){try{facts=await store.workFacts(bound.scope);}catch{facts=null;}}
    return {scope:bound.scope,owner:bound.actorId===bound.ownerId,companyName:bound.companyName,usage:usageState,configured:Boolean(row),revision:row?.revision||0,settings,
      agent:{id:row?String(row._id):null,status:!row?'not-configured':!settings.monitoring?'stopped':!settings.autonomous?'paused':usageState.pause?'usage-paused':expired?'recovering':row.status||'ready',summary:row?.summary||(!settings.monitoring?'Enable monitoring to establish a current view of the company.':settings.autonomous?'Company monitoring is enabled. The accountant will review the business after its sources are current.':'Company monitoring is enabled. The accountant is paused until you enable autonomous operation.'),memory:row?.memory||'',currentWork:row?.currentWork||'',lastDecisionAt:iso(row?.lastDecisionAt),nextDecisionAt:iso(row?.nextDecisionAt),specialists:settings.specialists.map(role=>({role,...(row?.specialists?.[role]||{}),status:settings.autonomous?row?.specialists?.[role]?.status||'scheduled':'paused'})),lastError:row?.lastError||lastScanError,standingAuthority:row?.grant?{issuedAt:row.grant.issuedAt,authorityHash:row.grant.authorityHash,activityPolicyHash:row.grant.activityPolicyHash||null}:null},
      sync:{...sync,nextSyncAt:iso(row?.nextSyncAt)},company:sync.company||{counts:{},totals:{currency:'CAD'},recent:[]},business,events,decisions,capabilities:businessAgentCapabilities(),
      work:businessWork({usage:usageState,settings,agent:{id:row?String(row._id):null,grant:row?.grant||null,lastError:row?.lastError||null},business,sync,coverage:coverageFor(bound.scope),activityPolicyHash:require('./business-activity-batch').POLICY_HASH,facts}),
      rightNow:rightNow({configured:Boolean(row),settings,usage:usageState,reviewing,recovering:Boolean(expired),activePass:row?.activePass||null,progress:row?.reviewProgress||null,nextDecisionAt:iso(row?.nextDecisionAt),lastDecisionAt:iso(row?.lastDecisionAt),events,sync})};
  }
  async function status(user){const bound=await bind(user);return workspace(bound,await store.get(bound.scope));}
  async function checkGrant(bound,business,session){
    if(options.checkGrant)return options.checkGrant(bound,business,session);
    const current=await store.models.Calendars.findOne(bound.scope).session(session).maxTimeMS(3000).lean();
    if(!current?.authorityHash||current.authorityHash!==business.authorityHash)fail('The published business changed during the standing-authority decision.');
    const authority=await store.models.Authorities.findOne({...bound.scope,contentHash:current.authorityHash}).session(session).maxTimeMS(3000).lean();
    require('./business-authority').assertAuthorityDocument(authority,bound.scope);
    if(String(authority.payload.ownerId)!==bound.ownerId)fail('Only the current published-business owner can grant autonomy.');
  }
  async function stopOwnedWork(bound,row){
    const state=await store.business(bound.scope),operation=state.currentOperation;
    const retained=store.ownedRuns?await store.ownedRuns(bound.scope,String(row._id)):[];
    if(operation?.agentAuthority?.agentId===String(row._id)&&!retained.some(run=>String(run._id)===operation.operationId))retained.push({_id:operation.operationId,status:operation.status});
    for(const run of retained)if(!['verified','retired','stopped','previewed'].includes(run.status))await execution.stop({id:bound.ownerId,actorId:bound.actorId},String(run._id));
  }
  async function control(user,input){
    validateControl(input);const stopping=['pause','stop-monitoring'].includes(input.command),bound=await bind(user,stopping?'operations.stop':'operations.execute');
    if(bound.ownerId!==bound.actorId)fail('Only the connected company owner can change business-agent controls.',403);
    if(['enable-monitoring','enable-autonomy'].includes(input.command)&&bound.scope.environment==='production'&&input.confirmProduction!==true)fail('Explicit consent for this Production company is required.',400);
    if(input.command==='enable-monitoring')await store.setup();
    const business=stopping?{scope:bound.scope,authorityHash:null}:await store.business(bound.scope);
    const saved=await store.control(bound,input,async(row,session)=>{
      if(input.command==='enable-autonomy'||input.command==='resume')await checkGrant(bound,business,session);
      return reduceControl(row,input,business,now(),bound.ownerId);
    });
    const currentJob=jobs.get(String(saved._id));if(currentJob)currentJob.controller.abort();
    if(stopping){try{await stopOwnedWork(bound,saved);}catch(error){await store.event(saved,'attention','Agent paused; retained work needs review',safeError(error),{href:'/company/manage'},null,input.requestKey,'owner');}}
    if(saved.settings.monitoring)kick(String(saved._id));
    return workspace(bound,saved);
  }
  async function worker(id,controller){
    const token=randomUUID();let row=await store.claim(id,token,leaseMs);if(!row)return;
    const scope=scopeOf(row),ownerId=String(row.ownerId),access=accessFor({actorId:ownerId,ownerId}),user={id:ownerId,actorId:ownerId,role:'supervisor'};
    let pulse=null,heartbeatFailure=null,heartbeatPending=Promise.resolve();
    const guard=async(mutating=false)=>{try{
      if(closed||controller.signal.aborted||heartbeatFailure)fail('The business worker was paused or cancelled.');
      const current=await store.current(row,token);await access.authorize(scope,mutating?'operations.execute':'operations.read',{signal:controller.signal});
      if(mutating&&publicSync(current,now()).status!=='current')fail('Company sources need to finish synchronizing before autonomous work.');
      if(mutating&&(!current.settings.autonomous||!current.grant||current.grant.id!==row.grant?.id||current.grant.authorityHash!==row.grant?.authorityHash))fail('Autonomous accounting authority changed.');
      return current;
    }catch(error){error.businessAgentFatal=true;throw error;}};
    const update=async changes=>{await guard();row=await store.update(row,token,changes);return row;};
    try{
      await guard();pulse=setInterval(()=>{heartbeatPending=heartbeatPending.then(async()=>{if(!controller.signal.aborted)await store.update(row,token,{leaseExpiresAt:new Date(now()+leaseMs)});}).catch(error=>{heartbeatFailure=error;controller.abort();});},20000);pulse.unref?.();
      await runAsActor(ownerId,async()=>{
        if(at(row.nextSyncAt)<=now()){
          await update({status:row.settings.autonomous?'monitoring':'paused',currentWork:'Synchronizing company changes'});
          const client=await access.resolveClient(scope,{signal:controller.signal});
          const sync=makeSync({client,scope,Records:store.models.Records,loadState:async()=>row.sync,saveState:async next=>{await update({sync:next});},authorize:async()=>{await guard();},signal:controller.signal,now,intervalMs:row.settings.syncIntervalSeconds*1000});
          const view=await sync.tick({maxRequests:12});await update({syncView:view,nextSyncAt:new Date(now()+(view.status==='current'?row.settings.syncIntervalSeconds*1000:5000))});
        }
        if(!row.settings.autonomous)return;
        if(publicSync(row,now()).status!=='current'){await update({status:'catching-up',summary:'Company monitoring is catching up. The accountant will act after all required sources are current.'});return;}
        const dueMain=at(row.nextDecisionAt)<=now(),dueSpecialist=row.settings.specialists.find(role=>at(row.specialists?.[role]?.nextDecisionAt)<=now());
        const role=dueMain?'accountant':dueSpecialist;if(!role)return;
        const usageState=await usageView(scope,row);
        if(usageState.pause){await update({status:'usage-paused',summary:usageState.pause.detail,currentWork:''});return;}
        await guard(true);
        const pass=row.activePass&&row.activePass.role===role?row.activePass:{id:randomUUID(),role,startedAt:new Date(now()).toISOString()};
        // Each attempt starts a fresh, bounded step list fenced to this pass and lease.
        await update({activePass:pass,status:'reviewing',currentWork:role==='accountant'?'Main accountant is reviewing and managing the business':role+' specialist is reviewing its work',reviewProgress:{passId:pass.id,role,startedAt:new Date(now()).toISOString(),steps:[]}});
        const progressRow=row,progress=createReviewProgress({now,write:steps=>typeof store.progress==='function'?store.progress(progressRow,token,pass.id,steps):undefined});
        const business=await store.business(scope),decisions=await store.decisions(row),events=await store.events(row);
        const tools=createBusinessAgentTools({usageFor:()=>usageView(scope,row),row,role,passId:pass.id,scope,store,access,user,guard,signal:controller.signal,now,governanceFor,execution,coverageFor,persistMemory:async memory=>{if(role==='accountant')await update({memory});else await update({specialists:{...(row.specialists||{}),[role]:{...(row.specialists?.[role]||{}),memory}}});}});
        const key=options.userApiKey?await options.userApiKey(ownerId):await store.models.Users.findOne({_id:ownerId}).select('anthropicApiKey').maxTimeMS(3000).lean();
        const context={usage:usageState,ownerInstructions:row.settings.instructions,memory:role==='accountant'?row.memory:row.specialists?.[role]?.memory||'',company:row.syncView?.company||null,sync:row.syncView?{status:row.syncView.status,lastSuccessAt:row.syncView.lastSuccessAt,sources:row.syncView.sources}:null,business,decisions,specialistReports:events.filter(event=>event.kind==='specialist-report').slice(0,8),capabilities:businessAgentCapabilities(),businessDate:require('./business-activity-preview').businessDate(new Date(now())),work:businessWork({usage:usageState,settings:row.settings,agent:{id:String(row._id),grant:row.grant||null,lastError:row.lastError||null},business,sync:publicSync(row,now()),coverage:coverageFor(scope),activityPolicyHash:require('./business-activity-batch').POLICY_HASH}).items};
        let result;try{result=await engine.run({role,context,tools:tools.definitions,execute:progress.wrap(tools.execute),userApiKey:typeof key==='string'?key:key?.anthropicApiKey,signal:controller.signal,timeoutMs:120000,maxRounds:8,maxCalls:24,usage:{begin:details=>usage.begin(scope,details),save:usage.save},beforeModel:async()=>{
          await guard(true);
          const state=await usageView(scope,row);
          if(state.pause)throw Object.assign(new Error(state.pause.detail),{code:'BUSINESS_REVIEW_PAUSED',businessAgentFatal:true});
        }});}finally{await progress.flush();}
        await guard(true);
        await store.event(row,role==='accountant'?'review-completed':'specialist-report',role==='accountant'?'Main accountant completed a business review':role+' specialist report',result.summary,{passId:pass.id,toolCalls:result.calls||0,complete:result.complete===true,...(role==='accountant'?{}:{reportsTo:'accountant'})},null,pass.id,role);
        const next=new Date(now()+(result.complete?row.settings.decisionIntervalMinutes:5)*60000);
        if(role==='accountant')await update({summary:result.summary,lastDecisionAt:new Date(now()),nextDecisionAt:next,status:business.blockers.length?'attention':'ready',activePass:null,lastError:null});
        else await update({specialists:{...(row.specialists||{}),[role]:{...(row.specialists?.[role]||{}),status:'waiting',summary:result.summary,lastDecisionAt:new Date(now()).toISOString(),nextDecisionAt:next.toISOString()}},nextDecisionAt:new Date(Math.min(at(row.nextDecisionAt)||now(),now()+60000)),activePass:null,status:'ready'});
      });
    }catch(error){
      if(error.code==='CODEX_SUBSCRIPTION_LIMIT'||error.code==='BUSINESS_REVIEW_PAUSED'){
        try{row=await store.update(row,token,{status:'usage-paused',summary:error.code==='CODEX_SUBSCRIPTION_LIMIT'?'ChatGPT plan limit reached. New Codex reviews wait for the plan to reset.':error.message,lastError:null,...(error.quota?{codexQuota:{resetAt:error.quota.resetAt,detectedAt:new Date(now()).toISOString()}}:{})});}catch{/* Owner revision wins; usage record retains the outcome. */}
      }else{
      if(!controller.signal.aborted){try{await store.event(row,'attention','Business review needs attention',safeError(error),{href:'/company/manage'},null,hash({passId:row.activePass?.id||token,error:safeError(error)}));}catch{/* Retain the lease/control barrier if event storage is unavailable. */}}
      try{row=await store.update(row,token,{status:'attention',lastError:safeError(error),nextSyncAt:new Date(now()+Math.max(30000,row.settings.syncIntervalSeconds*1000)),nextDecisionAt:new Date(now()+5*60000)});}catch{/* Owner changes and expired leases win. */}
      }
    }finally{
      if(pulse)clearInterval(pulse);await heartbeatPending;
      const dates=[row.nextSyncAt,...(row.settings.autonomous&&row.status!=='usage-paused'?[row.nextDecisionAt,...row.settings.specialists.map(role=>row.specialists?.[role]?.nextDecisionAt)]:[])].filter(Boolean).map(at);
      const nextWakeAt=new Date(Math.max(now()+1000,dates.length?Math.min(...dates):now()+30000));
      await store.release(row,token,{nextWakeAt}).catch(()=>{});
    }
  }
  function kick(id){
    if(closed||jobs.has(id)||jobs.size>=2)return;
    const controller=new AbortController(),promise=Promise.resolve().then(()=>worker(id,controller)).catch(()=>{lastScanError='Business monitoring needs storage recovery. Saved controls and cursors are retained.';}).finally(()=>jobs.delete(id));jobs.set(id,{controller,promise});
  }
  async function scan(){if(closed||scanPromise)return scanPromise;scanPromise=(async()=>{const rows=await store.due();for(const row of rows)kick(String(row._id));lastScanError=null;})().catch(()=>{lastScanError='Business monitoring storage is unavailable.';}).finally(()=>{scanPromise=null;});return scanPromise;}
  function start(){if(closed||interval)return;interval=setInterval(()=>void scan(),scanMs);interval.unref?.();void scan();}
  function close(){closed=true;if(interval)clearInterval(interval);interval=null;for(const job of jobs.values())job.controller.abort();}
  async function drain(){await Promise.allSettled([...jobs.values()].map(job=>job.promise));}
  return {status,control,start,close,drain,scan,diagnostics:()=>({workers:jobs.size,error:lastScanError}),_worker:worker};
}
let singleton;function getBusinessAgentService(){return singleton||=createBusinessAgentService();}
module.exports={createBusinessAgentService,getBusinessAgentService,publicSync};
