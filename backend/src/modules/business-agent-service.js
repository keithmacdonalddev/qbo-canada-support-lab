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
const { createBusinessAgentUsage, reviewPause, reviewOutcome } = require('./business-agent-usage');
const { DEFAULT_SETTINGS, validateControl, reduceControl, fail, ID } = require('./business-agent-policy');
const { runAsActor } = require('./actor-context');
const cadence = require('./business-agent-cadence');
const management = require('./business-management-review');
const iso=value=>value?new Date(value).toISOString():null;
const at=value=>value?new Date(value).getTime():0;
// Bounded source refresh before writes: one allowance per review attempt, never replenished by later checks.
const FRESHNESS=Object.freeze({requests:40,ms:60000,tickRequests:12,writeWithinMs:120000});
// A review is a full working session (owner 2026-10-31: no artificial limits): ten minutes and 60 tool calls.
const REVIEW_LIMITS=Object.freeze({ms:600000,rounds:30,calls:60});
// Consecutive freshness yields wait 1, 2, 5, then 15 minutes before the next review; a completed review resets the count.
const YIELD_RETRY_MINUTES=Object.freeze([1,2,5,15]);
const yieldDelayMs=count=>YIELD_RETRY_MINUTES[Math.min(Math.max(count,1),YIELD_RETRY_MINUTES.length)-1]*60000;
const sourceSignature=view=>(view.sources||[]).map(source=>source.entity+':'+source.status+':'+(source.lastSuccessAt||'')).join('|')+'#'+(view.summaryAt||'');
const safeError=error=>require('./log-diagnostic').redactLogSecrets(/^(BUSINESS_|QBO_)/.test(error?.code||'')?error.message:error?.code==='AI_PROVIDER_TIMEOUT'?'The review ran out of time before it finished. Saved work is kept and the next review continues it.':error?.aiProvider?'The model service could not finish this review. Check the AI connection in Settings.':'The business worker could not finish. Saved records, decisions and cursors are retained.').slice(0,700);
function publicSync(row,clock){
  const settings={...DEFAULT_SETTINGS,...(row?.settings||{})},view=row?.syncView;
  if(!view)return {status:settings.monitoring?'initializing':'not-configured',lastSuccessAt:null,sources:[],company:{counts:{},totals:{currency:'CAD'},recent:[]}};
  const age=Math.max(settings.syncIntervalSeconds*4000,120000),sources=(view.sources||[]).map(source=>({...source,status:source.status==='current'&&(source.freshUntil?clock>at(source.freshUntil):clock-at(source.lastSuccessAt)>age)?'stale':source.status}));
  // The sync publishes how long its summary stays fresh under the adaptive cadence (summaryFreshUntil).
  const summaryStale=view.summaryFreshUntil?clock>at(view.summaryFreshUntil):clock-at(view.summaryAt||view.company?.observedAt||row.sync?.summaryAt||view.lastSuccessAt)>age;
  const stale=!settings.monitoring||!view.lastSuccessAt||sources.some(source=>source.status!=='current')||summaryStale;
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
  // lease ({ token, now }): the worker's exact lease, fenced inside governed preparation and approval.
  const governanceFor=options.governanceFor||((origin,lease=null)=>require('./business-governance-service').createBusinessGovernanceService({...(origin?{agentAuthority:origin,Agents:store.models.Agents,...(lease?{agentLease:lease}:{})}:{})}));
  const requestMeter=options.requestMeter||require('./qbo-request-meter').getQboRequestMeter();
  // The feature check: the latest QuickBooks coverage check, else today's check from the local company copy.
  const coverageFor=options.coverageFor||(scope=>{try{return require('./coverage').getCached(scope.realmId)||management.cachedCoverage(scope);}catch{return null;}});
  const jobs=new Map();let interval=null,scanPromise=null,closed=false,lastScanError=null;
  // Today's counted same-day activity under the day's frozen rhythm (saved records only).
  // fresh:true bypasses the display cache (write admission, post-review scheduling).
  async function todayFor(scope,row,{fresh=false}={}){
    const clock=now(),day=cadence.localParts(clock).date,rhythm=cadence.frozenRhythm(row?.cadence,day);
    const fallback={unavailable:true,day,label:cadence.dayLabel(day),target:rhythm.target,ceiling:rhythm.ceiling};
    if(!row||typeof store.todayActivity!=='function')return fallback;
    try{return cadence.summarizeToday({rhythm,...(await store.todayActivity(scope,String(row._id),day,{fresh})),now:clock});}catch{return fallback;}
  }
  // Unfinished operations this agent approved, found independently of the calendar slot. A read
  // failure returns none; the tools re-read them before any new period or batch is admitted.
  async function ownedFor(scope,row){if(!row?.grant||typeof store.unfinishedRuns!=='function')return [];try{return await store.unfinishedRuns(scope,String(row._id),{id:row.grant.id,authorityHash:row.grant.authorityHash});}catch{return [];}}
  // Due saved obligations (adopted invoices and bills due today or earlier); null when unknown.
  async function obligationsFor(scope){if(typeof store.dueObligations!=='function')return null;try{return await store.dueObligations(scope,cadence.localParts(now()).date);}catch{return null;}}
  // What the accountant sees of today: counts, the due slot and the next slot time (Halifax).
  const todayContext=today=>{const {slots,reservedByRun,...rest}=today||{};return {...rest,...(rest.nextSlotAt?{nextSlotTime:cadence.localTime(rest.nextSlotAt)}:{})};};
  // The daily management review (business-management-review.js): the latest saved plan; null turns the review off.
  async function managementFor(row){if(!row||typeof store.latestDailyPlan!=='function')return null;try{const plan=await store.latestDailyPlan(row);return {lastPlanDay:plan?.day||null,plan};}catch{return null;}}
  async function capabilityRequestsFor(row){if(!row||typeof store.capabilityRequests!=='function')return [];try{return await store.capabilityRequests(row);}catch{return [];}}
  const decideCadence=(row,business,today,ownerRequested,owned=[],obligations=null,requests=null,daily=null)=>cadence.decide({now:now(),settings:row.settings,business,agent:{id:String(row._id),grant:row.grant||null},today,owned,obligations,requests,state:row.cadence||{},ownerRequested,management:daily});
  // Today's enforced QuickBooks request budget from the Phase 0 meter (unreadable counts as reached).
  const requestsFor=async scope=>cadence.requestBudget(await requestMeter.summary(scope).catch(()=>null));
  // An owner request (run now, instructions, a decision response) outranks the cadence once.
  const ownerAsked=row=>at(row.reviewRequestedAt)>at(row.cadence?.lastReviewAt);
  const cadenceRecord=decision=>({...decision.state,kind:decision.kind,reason:decision.reason,decidedAt:new Date(now()).toISOString()});
  // The management review's measures, from the local company copy (no QuickBooks calls); a failure is stated, never fatal.
  async function managementContextFor(scope,row,today,events,decisions){
    const requestsList=await capabilityRequestsFor(row);
    try{const snapshot=await management.snapshotFor(scope,{Records:store.models?.Records,nowMs:now()});return management.managementContext({snapshot,today,events,decisions,requests:requestsList,nowMs:now()});}
    catch{return management.managementContext({snapshot:null,today,events,decisions,requests:requestsList,nowMs:now(),error:'The local company measures could not be read this time; use the read tools.'});}
  }
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
    let qboRequests;try{qboRequests=await requestMeter.summary(bound.scope);}catch{qboRequests={unavailable:true};}
    const events=row?await store.events(row):[],decisions=row?await store.decisions(row):[];
    await bound.access.authorize(bound.scope,'operations.read');
    const expired=row?.leaseToken&&at(row.leaseExpiresAt)<=now();
    // A review is happening right now only while it holds a live lease with an active pass.
    const reviewing=Boolean(row?.leaseToken&&!expired&&row.activePass&&row.status==='reviewing');
    // Duty facts come from saved records only; any failure just omits them.
    let facts=null;if(row&&business.published&&typeof store.workFacts==='function'){try{facts=await store.workFacts(bound.scope);}catch{facts=null;}}
    const requests=cadence.requestBudget(qboRequests);
    const daily=row?await managementFor(row):null,buildList=row?management.openRequests(await capabilityRequestsFor(row)):[];
    if(!options.coverageFor&&business.published&&store.models?.Records)management.warm(bound.scope,store.models.Records,now());
    const today=row&&business.published?await todayFor(bound.scope,row):null,calendarClose=business.published?cadence.nextClose(business,cadence.localParts(now()).date):null,owned=row&&business.published?await ownedFor(bound.scope,row):[];
    return {scope:bound.scope,owner:bound.actorId===bound.ownerId,companyName:bound.companyName,usage:usageState,qboRequests:qboRequests&&!qboRequests.unavailable?{...qboRequests,budget:requests}:qboRequests,configured:Boolean(row),revision:row?.revision||0,settings,
      agent:{id:row?String(row._id):null,status:!row?'not-configured':!settings.monitoring?'stopped':!settings.autonomous?'paused':usageState.pause?'usage-paused':expired?'recovering':row.status||'ready',summary:row?.summary||(!settings.monitoring?'Enable monitoring to establish a current view of the company.':settings.autonomous?'Company monitoring is enabled. The accountant will review the business after its sources are current.':'Company monitoring is enabled. The accountant is paused until you enable autonomous operation.'),memory:row?.memory||'',currentWork:row?.currentWork||'',lastDecisionAt:iso(row?.lastDecisionAt),nextDecisionAt:iso(row?.nextDecisionAt),specialists:settings.specialists.map(role=>({role,...(row?.specialists?.[role]||{}),status:settings.autonomous?row?.specialists?.[role]?.status||'scheduled':'paused'})),lastError:row?.lastError||lastScanError,standingAuthority:row?.grant?{issuedAt:row.grant.issuedAt,authorityHash:row.grant.authorityHash,activityPolicyHash:row.grant.activityPolicyHash||null}:null},
      management:managementView(daily,buildList,today),sync:{...sync,nextSyncAt:iso(row?.nextSyncAt)},company:sync.company||{counts:{},totals:{currency:'CAD'},recent:[]},business,events,decisions,capabilities:businessAgentCapabilities(),
      work:businessWork({usage:usageState,settings,agent:{id:row?String(row._id):null,grant:row?.grant||null,lastError:row?.lastError||null},business,sync,coverage:coverageFor(bound.scope),activityPolicyHash:require('./business-activity-batch').POLICY_HASH,facts,today,calendarClose,owned,requests,cadence:row?.cadence?{...row.cadence,nextReviewAt:iso(row.nextDecisionAt)}:null}),
      rightNow:rightNow({configured:Boolean(row),settings,usage:usageState,reviewing,recovering:Boolean(expired),activePass:row?.activePass||null,progress:row?.reviewProgress||null,nextDecisionAt:iso(row?.nextDecisionAt),lastDecisionAt:iso(row?.lastDecisionAt),events,sync,today,calendarClose,requests,cadence:row?.cadence||null})};
  }
  // Today's plan and the build list for the first page: the plan only for today, progress from today's counted activity.
  function managementView(daily,buildList,today){
    const day=cadence.localParts(now()).date,plan=daily?.plan&&daily.plan.day===day?daily.plan:null;
    return {available:Boolean(daily),day,label:cadence.dayLabel(day),reviewAt:new Date(cadence.managementAt(day)).toISOString(),
      plan:plan?{id:plan.id,at:plan.at,title:plan.title,note:plan.detail,findings:plan.findings||[],changes:plan.changes||[]}:null,lastPlanDay:daily?.lastPlanDay||null,
      progress:today&&!today.unavailable?{target:today.target,saved:today.saved,verified:today.verified,reserved:today.reserved,slotCount:today.slotCount,currentSlot:today.currentSlot}:null,
      capabilityRequests:buildList.slice(0,40)};
  }
  async function status(user){const bound=await bind(user);return workspace(bound,await store.get(bound.scope));}
  // The live activity feed (business-agent-live.js): light enough to poll every few seconds while
  // work is happening. A failed read returns the last good feed for this agent, marked stale.
  const lastFeeds=new Map();
  async function live(user){
    const bound=await bind(user),row=await store.get(bound.scope),{buildLiveFeed}=require('./business-agent-live');
    const settings={...DEFAULT_SETTINGS,...(row?.settings||{})},expired=row?.leaseToken&&at(row.leaseExpiresAt)<=now();
    const base={now:now(),configured:Boolean(row),settings,reviewing:Boolean(row?.leaseToken&&!expired&&row.activePass&&row.status==='reviewing'),progress:row?.reviewProgress||null,activePass:row?.activePass||null,cadence:row?.cadence||null};
    if(!row)return {scope:bound.scope,revision:0,...buildLiveFeed(base)};
    const key=String(row._id);let feed;
    try{
      const [events,activity]=await Promise.all([store.events(row),typeof store.liveActivity==='function'?store.liveActivity(bound.scope):{runs:[],steps:[],records:[]}]);
      feed=buildLiveFeed({...base,events,...activity});
      if(lastFeeds.size>=50)lastFeeds.clear();
      lastFeeds.set(key,feed);
    }catch{
      const prior=lastFeeds.get(key);
      feed=prior?{...buildLiveFeed(base),items:prior.items,sending:prior.sending,stale:true}:buildLiveFeed({...base,unavailable:true});
    }
    await bound.access.authorize(bound.scope,'operations.read');
    return {scope:bound.scope,revision:row.revision||0,...feed};
  }
  // Review session transcripts (business-agent-transcript.js): the recent attempts, one attempt's
  // entries after a cursor, and a live Server-Sent Events stream with cursor resume.
  const ATTEMPT=/^[A-Za-z0-9-]{8,64}$/;
  async function transcriptOwner(user){
    const bound=await bind(user),row=await store.get(bound.scope);
    if(!row)fail('Enable company monitoring first.',404);
    if(!store.transcripts)fail('Review transcripts are unavailable.',404);
    return {bound,row,agentId:String(row._id)};
  }
  async function transcripts(user){
    const {bound,row,agentId}=await transcriptOwner(user),expired=row.leaseToken&&at(row.leaseExpiresAt)<=now();
    const attempts=await store.transcripts.attempts(agentId);
    await bound.access.authorize(bound.scope,'operations.read');
    return {scope:bound.scope,revision:row.revision||0,reviewing:Boolean(row.leaseToken&&!expired&&row.activePass&&row.status==='reviewing'),attempts};
  }
  async function transcript(user,attemptId,after=0){
    if(!ATTEMPT.test(attemptId||'')||!Number.isSafeInteger(after)||after<0)fail('Choose a saved review transcript.',400);
    const {bound,row,agentId}=await transcriptOwner(user);
    const entries=await store.transcripts.entries(agentId,attemptId,after);
    await bound.access.authorize(bound.scope,'operations.read');
    return {scope:bound.scope,revision:row.revision||0,attemptId,entries};
  }
  const streams=new Map();
  // res: an Express response. Replays the latest attempt after the cursor, then sends entries as they
  // are produced. Re-checks access every minute and closes after 15 minutes; the page reconnects.
  async function transcriptStream(user,{cursor=null}={},req,res,{lifetimeMs=900000,heartbeatMs=20000,recheckMs=60000}={}){
    const {bound,agentId}=await transcriptOwner(user);
    // The stream belongs to the company it was opened for; a later company switch never redirects it.
    const opened={environment:bound.scope.environment,realmId:bound.scope.realmId,connectionId:String(bound.scope.connectionId)};
    if((streams.get(agentId)||0)>=10)fail('Too many live views are open for this company. Close one and try again.',429);
    streams.set(agentId,(streams.get(agentId)||0)+1);
    const {subscribe}=require('./business-agent-transcript'),sent=new Map(),buffered=[];
    let closed=false,replaying=true;
    const write=text=>{if(!closed&&!res.writableEnded&&!res.write(text)){/* slow reader: the socket buffers; lifetime still bounds it */}};
    const send=entry=>{if(closed||!entry||!ATTEMPT.test(entry.attemptId||''))return;if(entry.seq<=(sent.get(entry.attemptId)||0))return;sent.set(entry.attemptId,entry.seq);if(sent.size>20)sent.delete(sent.keys().next().value);write('id: '+entry.attemptId+':'+entry.seq+'\nevent: entry\ndata: '+JSON.stringify(entry)+'\n\n');};
    // Subscribe before replaying so nothing produced during the replay is missed; duplicates are skipped by seq.
    const off=subscribe(agentId,entry=>replaying?buffered.length<2000&&buffered.push(entry):send(entry));
    let heartbeat=null,recheck=null,lifetime=null;
    const close=()=>{if(closed)return;closed=true;off();clearInterval(heartbeat);clearInterval(recheck);clearTimeout(lifetime);const left=(streams.get(agentId)||1)-1;if(left>0)streams.set(agentId,left);else streams.delete(agentId);if(!res.writableEnded)res.end();};
    req?.on?.('close',close);
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.flushHeaders?.();
    try{
      const latest=await store.transcripts.latest(agentId);
      if(latest)for(const entry of await store.transcripts.entries(agentId,latest,cursor&&cursor.attemptId===latest?cursor.seq:0))send(entry);
    }catch{write('event: notice\ndata: {"replay":"unavailable"}\n\n');}
    replaying=false;for(const entry of buffered.splice(0))send(entry);
    write('event: ready\ndata: {}\n\n');
    heartbeat=setInterval(()=>write(': ping\n\n'),heartbeatMs);heartbeat.unref?.();
    // Every minute: the selected company must still be the opened one, with read access and the same agent.
    let checking=false;
    const stillOpenedScope=async()=>{
      const next=await bind(user);
      if(['environment','realmId','connectionId'].some(key=>String(next.scope[key])!==String(opened[key])))fail('The selected company changed.',403);
      await next.access.authorize(opened,'operations.read');
      const current=await store.get(opened);
      if(!current||String(current._id)!==agentId)fail('The company monitoring changed.',403);
    };
    recheck=setInterval(()=>{if(checking||closed)return;checking=true;stillOpenedScope().catch(close).finally(()=>{checking=false;});},recheckMs);recheck.unref?.();
    lifetime=setTimeout(close,lifetimeMs);lifetime.unref?.();
    return close;
  }
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
    let pulse=null,heartbeatFailure=null,heartbeatPending=Promise.resolve(),syncer=null,pass=null,usageId=null,transcript=null;
    // Each worker run is one review attempt; its id joins the usage row and the terminal event.
    const attemptId=randomUUID(),refresh={requests:0,ms:0,ticks:0};
    const syncFor=async()=>{
      if(!syncer){const client=await access.resolveClient(scope,{signal:controller.signal});syncer=makeSync({client,scope,Records:store.models.Records,loadState:async()=>row.sync,saveState:async next=>{await update({sync:next});},authorize:async()=>{await guard();},signal:controller.signal,now,intervalMs:row.settings.syncIntervalSeconds*1000});}
      return syncer;
    };
    // When current, the next sync waits for the earliest due source (the combined change read is due every
    // 5 minutes while the day's activity runs, which is all day under rhythm v3), never sooner than the monitoring interval nor later than 15 minutes.
    const nextSyncAt=view=>{const clock=now(),interval=row.settings.syncIntervalSeconds*1000;if(view.status!=='current')return new Date(clock+5000);return new Date(Math.min(clock+900000,Math.max(clock+interval,at(view.nextDueAt))));};
    const syncSlice=async(maxRequests,timeoutMs,freshWithinMs)=>{const view=await (await syncFor()).tick({maxRequests,...(timeoutMs?{timeoutMs}:{}),...(freshWithinMs?{freshWithinMs}:{})});await update({syncView:view,nextSyncAt:nextSyncAt(view)});return view;};
    // A write needs every source current and every change-tracked source read within the last two minutes;
    // that one combined change read is what admits the write.
    const writeReady=view=>view.status==='current'&&(view.sources||[]).every(source=>source.mode!=='cdc'||now()-at(source.lastSuccessAt)<=FRESHNESS.writeWithinMs);
    const yieldError=detail=>Object.assign(new Error(detail+' Saved work is retained; the accountant continues after the next synchronization.'),{code:'BUSINESS_FRESHNESS_YIELD',status:409});
    // Bring every required source current within this attempt's refresh allowance, or yield before the write.
    const freshen=async current=>{
      let view=publicSync(current,now());
      const exhausted=()=>yieldError('Company sources could not be brought current within this review’s refresh allowance, so the next write was not started.');
      while(!writeReady(view)){
        const left=FRESHNESS.requests-refresh.requests,remainingMs=FRESHNESS.ms-refresh.ms;
        if(left<1||remainingMs<1000)throw exhausted();
        // Current but older than the write window needs only the combined change read (plus one spare).
        const before=sourceSignature(view),started=now(),slice=Math.min(view.status==='current'?2:FRESHNESS.tickRequests,left);
        // Charge the slice's full request allowance so the bound holds however many requests it used.
        refresh.requests+=slice;refresh.ticks++;
        // The slice may use only the time left in the allowance.
        try{await syncSlice(slice,Math.min(120000,Math.floor(remainingMs)),FRESHNESS.writeWithinMs);}finally{refresh.ms+=Math.max(0,now()-started);}
        current=await store.current(row,token);view=publicSync(current,now());
        if(!writeReady(view)&&sourceSignature(view)===before)throw yieldError('Company sources did not advance during this review’s refresh, so the next write was not started.');
      }
      // Recheck before admitting the write: a refresh that overran its time allowance does not admit it.
      if(refresh.ms>FRESHNESS.ms)throw exhausted();
      return current;
    };
    // guard(): read access. guard('authority'): execute authority and the unchanged grant. guard(true): authority plus current sources, refreshed within the attempt's budget.
    const guard=async(mutating=false)=>{try{
      if(closed||controller.signal.aborted||heartbeatFailure)fail('The business worker was paused or cancelled.');
      let current=await store.current(row,token);await access.authorize(scope,mutating?'operations.execute':'operations.read',{signal:controller.signal});
      if(mutating&&(!current.settings.autonomous||!current.grant||current.grant.id!==row.grant?.id||current.grant.authorityHash!==row.grant?.authorityHash))fail('Autonomous accounting authority changed.');
      if(mutating===true)current=await freshen(current);
      return current;
    }catch(error){error.businessAgentFatal=true;throw error;}};
    const update=async changes=>{await guard();row=await store.update(row,token,changes);return row;};
    // One idempotent finalizer per attempt: the terminal event fixes the outcome, then the usage row and scheduling state follow it.
    // If the terminal event cannot be saved, the attempt is failed (never completed); later steps never add a second terminal event.
    let finalized=false,usageRecord=null;
    const finalize=async({outcome,role='accountant',event=null,apply=null,error=null})=>{
      if(finalized)return;finalized=true;let final=outcome;
      const evidence=()=>({passId:pass?.id||null,attemptId,usageId,outcome:final,refresh:{...refresh}});
      if(event){
        try{await store.event(row,event.kind,event.title,event.detail,{...evidence(),...(event.data||{})},null,event.key||hash({attemptId,kind:event.kind}),role);}
        catch{
          if(['completed','incomplete'].includes(final)){
            final='failed';
            try{await store.event(row,'attention','Business review needs attention','The review finished, but its result could not be recorded. Saved records, decisions and cursors are retained; the next review continues.',{...evidence(),href:'/company/manage'},null,hash({attemptId,kind:'attention'}),role);}catch{/* Storage is unavailable; the usage row still records the failure. */}
          }
        }
      }
      try{transcript?.add('outcome',{status:final,text:event?[event.title,event.detail].filter(Boolean).join(' · '):''});}catch{/* transcript is best-effort */}
      if(usageRecord){try{await usage.save(usageRecord,{outcome:final,finishedAt:new Date(now()),resetAt:error?.quota?.resetAt||null});}catch{/* The engine already saved token totals. */}}
      if(apply){try{await apply(final);}catch{/* Owner changes and expired leases win; no second terminal outcome is recorded. */}}
      return final;
    };
    // Unsent work stopped outside the calendar slot cannot be resumed; it is retired through the governed
    // retirement, which itself refuses any operation with a transport receipt or saved effect.
    const retireUnsent=async run=>{
      if(!row.grant||run.agentAuthority?.agentId!==String(row._id)||run.agentAuthority?.grantId!==row.grant.id||run.agentAuthority?.ownerId!==ownerId||!run.planHash)return false;
      await guard('authority');
      const governor=governanceFor(run.agentAuthority,{token,now}),reason='Stopped before it held the business calendar, with no QuickBooks request sent and no record saved. It cannot be resumed, so it is retired unsent under the standing grant; its work is prepared again.';
      try{
        const reviewed=await governor.reviewRetirement(user,run.operationId,{planHash:run.planHash});
        await guard('authority');
        await governor.retire(user,run.operationId,{planHash:run.planHash,reviewHash:reviewed.reviewHash,reason});
      }catch(error){
        if(error?.businessAgentFatal)throw error;
        try{await store.event(row,'attention','Unsent work could not be retired',safeError(error),{operationId:run.operationId,href:'/company/manage'},null,hash({operationId:run.operationId,phase:'retire-unsent-failed'}),'accountant');}catch{/* Visible on the next pass. */}
        return false;
      }
      try{await store.event(row,'plan-decision','Main accountant retired unsent work',reason,{operationId:run.operationId,planHash:run.planHash,grantId:row.grant.id,approvalSource:'standing-owner-grant',qboWrites:0},null,hash({operationId:run.operationId,phase:'retire-unsent'}),'accountant');}catch{/* The governed retirement audit is the durable record. */}
      return true;
    };
    // An uncertain create of its own operation is resolved automatically under the standing grant
    // (business-unknown-recovery.js resolveUnknownAutomatically): one coverage read of that entity,
    // then exactly one matching record is attributed, or none proves it was not created. Several
    // candidates stay held and are reported. No owner decision is asked.
    const resolveUncertain=async run=>{
      if(!row.grant||run.agentAuthority?.agentId!==String(row._id)||run.agentAuthority?.grantId!==row.grant.id||run.agentAuthority?.ownerId!==ownerId||!run.planHash)return false;
      await guard('authority');
      let outcome;
      try{outcome=await governanceFor(run.agentAuthority,{token,now}).resolveUnknownAutomatically(user,run.operationId,{planHash:run.planHash});}
      catch(error){if(error?.businessAgentFatal)throw error;outcome={state:'ambiguous',message:safeError(error)};}
      if(['attributed','not-created'].includes(outcome.state)){try{await store.event(row,'plan-decision',outcome.state==='attributed'?'Main accountant attributed an uncertain QuickBooks request':'Main accountant proved an uncertain QuickBooks request created nothing',outcome.message,{operationId:run.operationId,planHash:run.planHash,grantId:row.grant.id,approvalSource:'standing-owner-grant',qboWrites:0,...(outcome.qboId?{qboId:outcome.qboId}:{})},null,hash({operationId:run.operationId,phase:'auto-unknown',state:outcome.state,qboId:outcome.qboId||null}),'accountant');}catch{/* The recovery audit is the durable record. */}return true;}
      if(outcome.state==='ambiguous'){try{await store.event(row,'attention','An uncertain QuickBooks request is held',outcome.message,{operationId:run.operationId,href:'/company/manage'},null,hash({operationId:run.operationId,phase:'auto-unknown-held',message:outcome.message}),'accountant');}catch{/* Visible on the next pass. */}}
      return false;
    };
    const failedState=error=>({status:'attention',lastError:safeError(error),nextSyncAt:new Date(now()+Math.max(30000,row.settings.syncIntervalSeconds*1000)),nextDecisionAt:new Date(now()+5*60000)});
    try{
      await guard();pulse=setInterval(()=>{heartbeatPending=heartbeatPending.then(async()=>{if(!controller.signal.aborted)await store.update(row,token,{leaseExpiresAt:new Date(now()+leaseMs)});}).catch(error=>{heartbeatFailure=error;controller.abort();});},20000);pulse.unref?.();
      await runAsActor(ownerId,async()=>{
        if(at(row.nextSyncAt)<=now()){
          await update({status:row.settings.autonomous?'monitoring':'paused',currentWork:'Synchronizing company changes'});
          await syncSlice(12);
        }
        if(!row.settings.autonomous)return;
        if(publicSync(row,now()).status!=='current'){await update({status:'catching-up',summary:'Company monitoring is catching up. The accountant will act after all required sources are current.'});return;}
        const dueMain=at(row.nextDecisionAt)<=now(),dueSpecialist=row.settings.specialists.find(role=>at(row.specialists?.[role]?.nextDecisionAt)<=now());
        // The cadence decides from saved state whether this wake needs a model review at all
        // (business-agent-cadence.js); when it does not, only the next time and its reason are saved.
        let role=null,decision=null,business=null,today=null,owned=[],obligations=null,requests=null,daily=null;
        if(dueMain){
          business=await store.business(scope);today=await todayFor(scope,row);owned=await ownedFor(scope,row);obligations=await obligationsFor(scope);requests=await requestsFor(scope);daily=await managementFor(row);
          let retired=false;for(const run of owned.filter(run=>run.disposition==='unsent').slice(0,3))retired=(await retireUnsent(run))||retired;
          if(business.blockers?.some(item=>item.code==='uncertain-write'))for(const run of owned.filter(run=>run.holdsSlot).slice(0,1))retired=(await resolveUncertain(run))||retired;
          if(retired){business=await store.business(scope);owned=await ownedFor(scope,row);if(typeof store.forgetToday==='function')store.forgetToday();today=await todayFor(scope,row);}
          decision=decideCadence(row,business,today,ownerAsked(row),owned,obligations,requests,daily);
          if(decision.callModel)role='accountant';
          else await update({cadence:cadenceRecord(decision),nextDecisionAt:new Date(decision.nextReviewAt),currentWork:''});
        }
        if(!role&&dueSpecialist){
          // Specialists run in the day's activity hours (all day under rhythm v3) under the same daily review ceiling.
          const allowed=cadence.specialistAllowed({now:now(),state:row.cadence||{}});
          if(allowed.allowed)role=dueSpecialist;
          else await update({specialists:{...(row.specialists||{}),[dueSpecialist]:{...(row.specialists?.[dueSpecialist]||{}),status:'waiting',nextDecisionAt:allowed.nextAt}}});
        }
        if(!role)return;
        const usageState=await usageView(scope,row);
        if(usageState.pause){await update({status:'usage-paused',summary:usageState.pause.detail,currentWork:''});return;}
        await guard(true);
        if(!business)business=await store.business(scope);
        if(!today)today=await todayFor(scope,row);
        pass=row.activePass&&row.activePass.role===role?row.activePass:{id:randomUUID(),role,startedAt:new Date(now()).toISOString()};
        // Every model review counts toward today's ceiling when it starts; a main review also fixes its progress baseline.
        const started=role==='accountant'?{...cadence.beginReview(decision.state,{now:now(),signature:cadence.progressSignature(business,today,owned,obligations),kind:decision.kind}),kind:decision.kind,reason:decision.reason}:cadence.countReview(row.cadence||{},now());
        // Each attempt starts a fresh, bounded step list fenced to this pass and lease.
        await update({activePass:pass,status:'reviewing',cadence:started,currentWork:role==='accountant'?'Main accountant is reviewing and managing the business':role+' specialist is reviewing its work',reviewProgress:{passId:pass.id,role,startedAt:new Date(now()).toISOString(),steps:[]}});
        const progressRow=row,progress=createReviewProgress({now,write:steps=>typeof store.progress==='function'?store.progress(progressRow,token,pass.id,steps):undefined});
        // The live session transcript for this attempt: batched, best-effort and never awaited by the review.
        const transcripts=store.transcripts||null;
        transcript=require('./business-agent-transcript').createTranscriptRecorder({agentId:String(row._id),attemptId,passId:pass.id,role,scope,now,write:transcripts?rows=>transcripts.save(rows):null});
        if(transcripts)transcripts.prune(String(row._id)).catch(()=>{});
        business=await store.business(scope);const decisions=await store.decisions(row),events=await store.events(row);
        const calendarClose=cadence.nextClose(business,cadence.localParts(now()).date);
        const tools=createBusinessAgentTools({usageFor:()=>usageView(scope,row),todayFor:options=>todayFor(scope,row,options),lease:{token,now},requestsFor:()=>requestMeter.summary(scope),row,role,passId:pass.id,scope,store,access,user,guard,signal:controller.signal,now,governanceFor,execution,coverageFor,managementFor:async()=>({todaysPlan:management.planContext((await managementFor(row))?.plan||null,cadence.localParts(now()).date),...await managementContextFor(scope,row,today,events,decisions)}),persistMemory:async memory=>{if(role==='accountant')await update({memory});else await update({specialists:{...(row.specialists||{}),[role]:{...(row.specialists?.[role]||{}),memory}}});}});
        const key=options.userApiKey?await options.userApiKey(ownerId):await store.models.Users.findOne({_id:ownerId}).select('anthropicApiKey').maxTimeMS(3000).lean();
        const context={usage:usageState,ownerInstructions:row.settings.instructions,memory:role==='accountant'?row.memory:row.specialists?.[role]?.memory||'',company:row.syncView?.company||null,sync:row.syncView?{status:row.syncView.status,lastSuccessAt:row.syncView.lastSuccessAt,sources:row.syncView.sources}:null,business,decisions,specialistReports:events.filter(event=>event.kind==='specialist-report').slice(0,8),capabilities:businessAgentCapabilities(),businessDate:require('./business-activity-preview').businessDate(new Date(now())),cadence:role==='accountant'?{kind:decision.kind,reason:decision.reason}:null,todaysPlan:role==='accountant'?management.planContext((daily||await managementFor(row))?.plan||null,cadence.localParts(now()).date):null,...(role==='accountant'&&decision?.kind==='management'?{management:await managementContextFor(scope,row,today,events,decisions)}:{}),today:todayContext(today),calendarClose,unfinishedOperations:owned.filter(run=>run.disposition!=='unsent').map(({agentAuthority,...run})=>run),dueObligations:obligations,qboRequestBudget:requests,work:businessWork({usage:usageState,settings:row.settings,agent:{id:String(row._id),grant:row.grant||null,lastError:row.lastError||null},business,sync:publicSync(row,now()),coverage:coverageFor(scope),activityPolicyHash:require('./business-activity-batch').POLICY_HASH,today,calendarClose,cadence:row.cadence||null}).items};
        let result;try{result=await engine.run({role,context,tools:tools.definitions,execute:progress.wrap(tools.execute),userApiKey:typeof key==='string'?key:key?.anthropicApiKey,transcript,signal:controller.signal,timeoutMs:REVIEW_LIMITS.ms,maxRounds:REVIEW_LIMITS.rounds,maxCalls:REVIEW_LIMITS.calls,deferOutcome:true,usage:{begin:async details=>{const record=await usage.begin(scope,{...details,attemptId,passId:pass.id});usageRecord=record||null;usageId=record?._id||attemptId;return record;},save:usage.save},beforeFinish:async()=>{await guard('authority');},beforeModel:async()=>{
          // Model calls are not writes: they need authority, not current sources. Write steps refresh sources themselves.
          await guard('authority');
          const state=await usageView(scope,row);
          if(state.pause)throw Object.assign(new Error(state.pause.detail),{code:'BUSINESS_REVIEW_PAUSED',businessAgentFatal:true});
        }});}finally{await progress.flush();}
        const outcome=result.outcome||reviewOutcome({result});
        const next=new Date(now()+(result.complete?row.settings.decisionIntervalMinutes:5)*60000);
        await finalize({outcome,role,event:{kind:role==='accountant'?'review-completed':'specialist-report',title:role==='accountant'?'Main accountant completed a business review':role+' specialist report',detail:result.summary,key:pass.id,data:{toolCalls:result.calls||0,complete:result.complete===true,...(role==='accountant'?{}:{reportsTo:'accountant'})}},apply:async final=>{
          if(final!==outcome){row=await store.update(row,token,failedState(new Error('The review result could not be recorded.')));return;}
          if(role==='accountant'){
            // The next review time comes from the cadence with fresh saved state; this also records whether the review made progress.
            let after=null;try{after=decideCadence(row,await store.business(scope),await todayFor(scope,row,{fresh:true}),false,await ownedFor(scope,row),await obligationsFor(scope),await requestsFor(scope),await managementFor(row));}catch{after=null;}
            await update({summary:result.summary,lastDecisionAt:new Date(now()),nextDecisionAt:after?new Date(after.nextReviewAt):next,...(after?{cadence:cadenceRecord(after)}:{}),status:business.blockers.length?'attention':'ready',activePass:null,lastError:null,reviewYields:0});
          }
          else await update({reviewYields:0,specialists:{...(row.specialists||{}),[role]:{...(row.specialists?.[role]||{}),status:'waiting',summary:result.summary,lastDecisionAt:new Date(now()).toISOString(),nextDecisionAt:next.toISOString()}},nextDecisionAt:new Date(Math.min(at(row.nextDecisionAt)||now(),now()+60000)),activePass:null,status:'ready'});
        }});
      });
    }catch(error){
      // Every attempt ends with exactly one terminal outcome, shared with its usage row when a model session began.
      const outcome=reviewOutcome({failure:error,aborted:controller.signal.aborted}),role=pass?.role||'accountant';
      const save=async changes=>{row=await store.update(row,token,changes);};
      if(outcome==='plan-limit'||outcome==='cap-reached'){
        await finalize({outcome,role,error,event:pass?{kind:'review-paused',title:'Review paused at a usage limit',detail:outcome==='plan-limit'?'ChatGPT plan limit reached. New Codex reviews wait for the plan to reset.':safeError(error)}:null,apply:()=>save({status:'usage-paused',summary:error.code==='CODEX_SUBSCRIPTION_LIMIT'?'ChatGPT plan limit reached. New Codex reviews wait for the plan to reset.':error.message,lastError:null,...(error.quota?{codexQuota:{resetAt:error.quota.resetAt,detectedAt:new Date(now()).toISOString()}}:{})})});
      }else if(outcome==='yielded'){
        // Expected and recoverable: synchronize now and review again after a short, growing wait instead of a blind 5-minute retry.
        const yields=(Number(row.reviewYields)||0)+1,retryAt=new Date(now()+yieldDelayMs(yields));
        await finalize({outcome,role,error,event:{kind:'review-yielded',title:'Review paused to refresh company sources',detail:safeError(error),data:{yields,retryAt:retryAt.toISOString()}},apply:()=>save({status:'catching-up',summary:'The accountant stopped before a write because company sources could not be brought current in time. Saved work is retained; the next review follows synchronization.',lastError:null,reviewYields:yields,
          // A freshness yield keeps its own short retry and is not counted as a review without progress.
          ...(row.cadence?{cadence:{...row.cadence,reviewSignature:null}}:{}),nextSyncAt:new Date(now()),...(role==='accountant'?{nextDecisionAt:retryAt}:{specialists:{...(row.specialists||{}),[role]:{...(row.specialists?.[role]||{}),status:'waiting',nextDecisionAt:retryAt.toISOString()}}})})});
      }else{
        const event=outcome==='cancelled'?(pass?{kind:'review-cancelled',title:'Review stopped before it finished',detail:'The review was paused, cancelled or lost its lease. Saved records, decisions and cursors are retained.'}:null):{kind:'attention',title:'Business review needs attention',detail:safeError(error),data:{href:'/company/manage'}};
        await finalize({outcome,role,error,event,apply:()=>save(failedState(error))});
      }
    }finally{
      if(pulse)clearInterval(pulse);await heartbeatPending;
      if(transcript)await transcript.flush().catch(()=>{});
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
  return {status,live,transcripts,transcript,transcriptStream,control,start,close,drain,scan,diagnostics:()=>({workers:jobs.size,error:lastScanError}),_worker:worker};
}
let singleton;function getBusinessAgentService(){return singleton||=createBusinessAgentService();}
module.exports={createBusinessAgentService,getBusinessAgentService,publicSync};
