'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBusinessAgentService,publicSync}=require('../src/modules/business-agent-service');
const {DEFAULT_SETTINGS,reduceControl}=require('../src/modules/business-agent-policy');
const ownerId='a'.repeat(24),agentId='b'.repeat(24),authorityHash='c'.repeat(64),scope={environment:'production',realmId:'123456789',connectionId:'d'.repeat(24)};
const copy=value=>structuredClone(value);
function fixture({autonomous=true,current=true,configured=true}={}){
 const h={clock:Date.parse('2026-10-23T15:00:00Z'),events:[],engineCalls:0,syncCalls:0,setupCalls:0,stops:[],accessCalls:0};
 const stamp=()=>new Date(h.clock).toISOString();
 h.row=configured?{_id:agentId,version:1,...scope,ownerId,revision:1,createdAt:stamp(),settings:{...DEFAULT_SETTINGS,monitoring:true,autonomous,specialists:[]},grant:{id:'e'.repeat(64),authorityHash,ownerId,issuedAt:stamp()},sync:{version:1,cursor:'retained'},syncView:{status:current?'current':'catching-up',lastSuccessAt:current?stamp():null,summaryAt:stamp(),sources:[{entity:'Invoice',status:current?'current':'bootstrap',lastSuccessAt:stamp(),freshUntil:new Date(h.clock+120000).toISOString()}],company:{counts:{records:17},totals:{currency:'CAD'},recent:[]}},nextSyncAt:new Date(h.clock+30000),nextDecisionAt:new Date(h.clock),nextWakeAt:new Date(h.clock),leaseToken:null,leaseExpiresAt:null}:null;
 h.business={scope,published:true,authorityHash,verifiedThrough:'2026-10-22',openingDate:'2026-10-01',blockers:[],currentOperation:null};
 const store={models:{Records:{},Users:{findOne:()=>({select(){return this;},maxTimeMS(){return this;},lean:async()=>({anthropicApiKey:'fixture-provider-key'})})}},get:async()=>copy(h.row),setup:async()=>h.setupCalls++,business:async()=>copy(h.business),events:async()=>copy(h.events),decisions:async()=>[],ownedRuns:async()=>[],event:async(row,kind,title,detail,data)=>{h.events.push({kind,title,detail,data});return {id:'f'.repeat(24)};},due:async()=>h.row?[{_id:agentId}]:[],claim:async(id,token,leaseMs)=>{if(!h.row||!h.row.settings.monitoring||(h.row.leaseToken&&new Date(h.row.leaseExpiresAt).getTime()>h.clock))return null;h.row.leaseToken=token;h.row.leaseExpiresAt=new Date(h.clock+leaseMs);return copy(h.row);},current:async(row,token)=>{if(!h.row||h.row.revision!==row.revision||h.row.leaseToken!==token||!h.row.settings.monitoring)throw new Error('lost lease');return copy(h.row);},update:async(row,token,changes)=>{await store.current(row,token);Object.assign(h.row,copy(changes));return copy(h.row);},release:async(row,token,changes)=>{if(h.row.revision===row.revision&&h.row.leaseToken===token)Object.assign(h.row,copy(changes),{leaseToken:null,leaseExpiresAt:null});return copy(h.row);},control:async(bound,input,reduce)=>{if(h.row?.revision!==input.expectedRevision)throw Object.assign(new Error('changed'),{code:'BUSINESS_AGENT_UNAVAILABLE',status:409});const changes=await reduce(copy(h.row));Object.assign(h.row,changes,{revision:h.row.revision+1,leaseToken:null,leaseExpiresAt:null});return copy(h.row);},scopeOf:()=>scope,todayActivity:async()=>copy(h.today||{runs:[],receipts:[]}),unfinishedRuns:async()=>copy(h.owned||[])};
 store.run=async()=>copy(h.run||null);
 h.service=createBusinessAgentService({store,usage:{summary:async()=>h.usage||{month:{totalTokens:0,estimatedCostUsd:0}},begin:async(scope,details)=>{h.begun=details;return {_id:details.attemptId};},save:async(record,value)=>{(h.usageSaves||=[]).push({id:record._id,...value});}},now:()=>h.clock,resolveContext:async()=>({environment:scope.environment,connection:{connected:true,connectionId:scope.connectionId,realmId:scope.realmId,companyName:'Fixture business'}}),accessFor:()=>({authorize:async()=>{h.accessCalls++;if(h.revoked)throw Object.assign(new Error('revoked'),{code:'BUSINESS_ACCESS_DENIED'});return {};},resolveClient:async()=>({})}),checkGrant:async()=>{},execution:{stop:async(user,id)=>h.stops.push(id),request:async()=>{h.requested=(h.requested||0)+1;return {queued:true};}},governanceFor:(origin,lease)=>{(h.leases||=[]).push(lease||null);return h.governance||({});},requestMeter:{summary:async()=>h.qboRequests||{today:{total:0,attempts:{sync:0,report:0,query:0,read:0,write:0}},month:{total:0,attempts:{sync:0,report:0,query:0,read:0,write:0}}}},createSync:options=>({tick:async(args)=>{h.syncCalls++;(h.ticks||=[]).push(args?.maxRequests);(h.tickArgs||=[]).push(args);if(h.onTick)await h.onTick(options);h.loadedCursor=(await options.loadState())?.cursor;await options.saveState({version:1,cursor:'continued'});return copy(h.row.syncView);}}),engine:{run:async input=>{h.engineCalls++;h.passContext=input.context;if(h.onRun)await h.onRun(input);return {summary:'Reviewed current business and retained its next action.',calls:1,complete:true};}}});h.store=store;return h;
}
test('GET reads saved state without initialization or model/provider work',async()=>{
 const h=fixture({configured:false});const view=await h.service.status({id:ownerId});assert.equal(view.configured,false);assert.equal(h.setupCalls,0);assert.equal(h.engineCalls,0);assert.equal(h.syncCalls,0);h.service.close();
});
test('Production monitoring consent and owner identity are required before setup',async()=>{
 const h=fixture();await assert.rejects(h.service.control({id:ownerId},{command:'enable-monitoring',expectedRevision:1,requestKey:'fixture_request_0001',confirmProduction:false}),/Production/);assert.equal(h.setupCalls,0);
 await assert.rejects(h.service.control({id:ownerId,actorId:'1'.repeat(24)},{command:'pause',expectedRevision:1,requestKey:'fixture_request_0002'}),/owner/);assert.equal(h.row.settings.autonomous,true);h.service.close();
});
test('monitoring continues while autonomous decisions are paused',async()=>{
 const h=fixture({autonomous:false});h.row.nextSyncAt=new Date(h.clock);await h.service._worker(agentId,new AbortController());assert.equal(h.syncCalls,1);assert.equal(h.engineCalls,0);assert.equal(h.row.leaseToken,null);h.service.close();
});
test('partial sources prevent provider decisions and continue catch-up',async()=>{
 const h=fixture({current:false});h.row.nextSyncAt=new Date(h.clock);await h.service._worker(agentId,new AbortController());assert.equal(h.syncCalls,1);assert.equal(h.engineCalls,0);assert.equal(h.row.status,'catching-up');assert.equal(new Date(h.row.nextSyncAt).getTime(),h.clock+5000);h.service.close();
});
test('restart resumes persisted cursors after expired lease and performs an actual decision pass',async()=>{
 const h=fixture();h.row.nextSyncAt=new Date(h.clock);h.row.leaseToken='old-process';h.row.leaseExpiresAt=new Date(h.clock-1);h.row.activePass={id:'retained-pass',role:'accountant',startedAt:new Date(h.clock-60000).toISOString()};
 await h.service._worker(agentId,new AbortController());assert.equal(h.loadedCursor,'retained');assert.equal(h.engineCalls,1);assert.equal(h.row.sync.cursor,'continued');assert.equal(h.row.activePass,null);assert.equal(h.row.leaseToken,null);assert.match(h.row.summary,/Reviewed/);assert.equal(h.events.at(-1).data.passId,'retained-pass');h.service.close();
});
test('revoked access stops the worker before provider or sync work',async()=>{
 const h=fixture();h.revoked=true;await h.service._worker(agentId,new AbortController());assert.equal(h.engineCalls,0);assert.equal(h.syncCalls,0);assert.equal(h.row.leaseToken,null);h.service.close();
});
test('workspace reports stale observations honestly and honors slower source-specific freshness',()=>{
 const h=fixture();h.row.syncView.sources[0].lastSuccessAt=new Date(h.clock-240000).toISOString();h.row.syncView.sources[0].freshUntil=new Date(h.clock+60000).toISOString();h.row.syncView.lastSuccessAt=h.row.syncView.sources[0].lastSuccessAt;assert.equal(publicSync(h.row,h.clock).status,'current');
 assert.equal(publicSync(h.row,h.clock+240000).status,'stale');assert.equal(publicSync(h.row,h.clock+240000).company.provisional,true);
});

test('owner API payload includes usage, cap pause and work item; monitoring continues without reviews',async()=>{
 const h=fixture();h.usage={today:{reviews:2,totalTokens:100},week:{reviews:5,totalTokens:500},month:{reviews:10,totalTokens:1000,estimatedCostUsd:2},models:[{provider:'anthropic',model:'claude-sonnet-5-5'}]};h.row.settings.monthlyCaps={tokens:1000,apiUsd:null};
 const view=await h.service.status({id:ownerId});assert.equal(view.usage.month.totalTokens,1000);assert.equal(view.usage.pause.code,'monthly-cap');assert.equal(view.agent.status,'usage-paused');assert.equal(view.work.items.find(item=>item.key==='ai-usage-limit').owner,'owner');
 h.row.nextSyncAt=new Date(h.clock);await h.service._worker(agentId,new AbortController());assert.equal(h.syncCalls,1);assert.equal(h.engineCalls,0);assert.equal(h.row.leaseToken,null);
 const control=await h.service.control({id:ownerId},{command:'configure-usage',settings:{tokens:2000,apiUsd:null},expectedRevision:1,requestKey:'fixture_usage_caps_0001'});assert.equal(control.usage.pause,null);await h.service.drain();assert.equal(h.engineCalls,1);h.service.close();
});
test('persisted native quota survives a worker restart and waits for reset in auto mode',async()=>{
 const h=fixture();h.usage={month:{},quota:{resetAt:new Date(h.clock+3600000).toISOString(),detectedAt:new Date(h.clock).toISOString()}};
 await h.service._worker(agentId,new AbortController());assert.equal(h.engineCalls,0);assert.equal((await h.service.status({id:ownerId})).usage.pause.code,'plan-limit');
 h.clock+=3600001;h.row.syncView.summaryAt=new Date(h.clock).toISOString();h.row.syncView.lastSuccessAt=new Date(h.clock).toISOString();h.row.syncView.sources[0].freshUntil=new Date(h.clock+120000).toISOString();await h.service._worker(agentId,new AbortController());assert.equal(h.engineCalls,1);h.service.close();
});

test('a review records plain-English steps for the live pass and the workspace shows them right now',async()=>{
 const h=fixture();h.row.reviewProgress={passId:'older-pass',startedAt:new Date(h.clock-3600000).toISOString(),steps:[{at:new Date(h.clock-3600000).toISOString(),label:'Old step',status:'done'}]};
 const writes=[];h.store.progress=async(row,token,passId,steps)=>{writes.push(passId);if(h.row.leaseToken!==token||h.row.reviewProgress?.passId!==passId)return {matchedCount:0};h.row.reviewProgress.steps=copy(steps);return {matchedCount:1};};
 let during;
 h.onRun=async input=>{
  assert.deepEqual(h.row.reviewProgress.steps,[],'each attempt starts with an empty step list');
  await input.execute('rememberBusinessContext',{memory:'Customer Jane Doe still owes $399.'});
  await assert.rejects(input.execute('notARealTool',{}),/cannot use/);
  await new Promise(resolve=>setImmediate(resolve));
  during=await h.service.status({id:ownerId});
 };
 await h.service._worker(agentId,new AbortController());
 assert.equal(during.rightNow.state,'reviewing');
 assert.ok(during.rightNow.startedAt);
 assert.ok(during.rightNow.steps.length>=1);
 assert.equal(during.work.items.some(item=>item.key==='reviewing'),false);
 const final=h.row.reviewProgress;
 assert.notEqual(final.passId,'older-pass');
 assert.deepEqual(final.steps.map(step=>[step.label,step.status]),[['Saving notes for its next review','done'],['Using not a real tool','failed']]);
 assert.ok(!JSON.stringify(final).includes('Jane Doe'),'tool inputs are never stored');
 assert.ok(writes.every(passId=>passId===final.passId),'writes are fenced to the active pass');
 const after=await h.service.status({id:ownerId});
 assert.equal(after.rightNow.state,'idle');
 assert.deepEqual(after.rightNow.steps,[]);
 assert.equal(after.rightNow.lastSummary,'Reviewed current business and retained its next action.');
 assert.ok(after.rightNow.nextReviewAt);
 h.service.close();
});
test('progress storage failures never break or block a review',async()=>{
 const h=fixture();h.store.progress=async()=>{throw new Error('storage unavailable');};
 h.onRun=async input=>{await input.execute('rememberBusinessContext',{memory:'Handoff.'});};
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.engineCalls,1);assert.match(h.row.summary,/Reviewed/);assert.equal(h.row.activePass,null);assert.equal(h.row.lastError,null);assert.equal(h.row.leaseToken,null);
 h.row.leaseToken=null;assert.equal((await h.service.status({id:ownerId})).rightNow.state,'idle');
 h.row.settings.autonomous=false;assert.equal((await h.service.status({id:ownerId})).rightNow.state,'paused');
 h.service.close();
});

// Phase 0 (continuous-business plan v2): bounded freshness before writes, truthful outcomes, request measurement.
const OPERATION='9'.repeat(24),PLAN='a'.repeat(64);
function writeFixture(){
 const h=fixture();h.run={_id:OPERATION,planHash:PLAN,status:'previewed',createdBy:ownerId,agentAuthority:{version:1,agentId,grantId:h.row.grant.id,authorityHash,ownerId}};
 h.governance={approve:async()=>{h.approved=(h.approved||0)+1;}};
 h.age=()=>{h.clock+=150000;};// every source and the summary are now older than their 120 s window
 h.freshView=()=>{const at=new Date(h.clock).toISOString();h.row.syncView={...h.row.syncView,status:'current',lastSuccessAt:at,summaryAt:at,sources:[{entity:'Invoice',status:'current',lastSuccessAt:at,freshUntil:new Date(h.clock+120000).toISOString()}]};};
 h.write=input=>input.execute('executeBusinessPeriod',{operationId:OPERATION,planHash:PLAN,reason:'Close the elapsed business period under the standing grant.'});
 return h;
}
test('an aged source is refreshed within the review before a write, and the write proceeds',async()=>{
 const h=writeFixture();let written;
 h.onTick=async()=>h.freshView();
 h.onRun=async input=>{h.age();assert.equal(publicSync(h.row,h.clock).status,'stale');written=await h.write(input);};
 await h.service._worker(agentId,new AbortController());
 assert.equal(written.success,true);assert.equal(h.approved,1);assert.equal(h.requested,1);
 assert.deepEqual(h.ticks,[12],'one bounded slice brought the sources current; later write steps reuse it');
 const done=h.events.at(-1);assert.equal(done.kind,'review-completed');assert.equal(done.data.outcome,'completed');assert.deepEqual(done.data.refresh,{requests:12,ms:0,ticks:1});
 assert.equal(h.row.reviewYields,0);assert.equal(h.row.status,'ready');h.service.close();
});
test('an exhausted refresh allowance yields deterministically before any write and schedules a short retry',async()=>{
 const h=writeFixture();let n=0;
 // Each slice makes progress but never brings the source inside its window.
 h.onTick=async()=>{const at=new Date(h.clock-200000+(++n)*1000).toISOString();h.row.syncView={...h.row.syncView,lastSuccessAt:at,summaryAt:at,sources:[{entity:'Invoice',status:'current',lastSuccessAt:at,freshUntil:new Date(Date.parse(at)+120000).toISOString()}]};};
 h.onRun=async input=>{h.age();await h.write(input);};
 await h.service._worker(agentId,new AbortController());
 assert.deepEqual(h.ticks,[12,12,12,4],'the 40-request allowance is shared across slices and never replenished');
 assert.equal(h.approved,undefined);assert.equal(h.requested,undefined);assert.equal(h.events.some(event=>event.kind==='plan-decision'),false,'nothing was approved or queued');
 const yielded=h.events.at(-1);assert.equal(yielded.kind,'review-yielded');assert.equal(yielded.data.outcome,'yielded');assert.equal(yielded.data.yields,1);assert.equal(yielded.data.refresh.requests,40);
 assert.equal(h.events.some(event=>event.kind==='review-completed'||event.kind==='attention'),false,'no false completion and no attention alarm');
 assert.equal(h.row.status,'catching-up');assert.equal(h.row.reviewYields,1);assert.equal(new Date(h.row.nextSyncAt).getTime(),h.clock);assert.equal(new Date(h.row.nextDecisionAt).getTime(),h.clock+60000);assert.equal(h.row.lastError,null);
 h.service.close();
});
test('a refresh that makes no progress yields after one slice, with a growing wait on repeated yields',async()=>{
 const h=writeFixture();h.row.reviewYields=2;
 h.onRun=async input=>{h.age();await h.write(input);};
 await h.service._worker(agentId,new AbortController());
 assert.deepEqual(h.ticks,[12]);assert.equal(h.approved,undefined);
 assert.equal(h.events.at(-1).kind,'review-yielded');assert.equal(h.row.reviewYields,3);assert.equal(new Date(h.row.nextDecisionAt).getTime(),h.clock+5*60000);
 h.service.close();
});
test('model rounds and review finalization need authority, not current sources',async()=>{
 const h=writeFixture();
 h.onRun=async input=>{h.age();await input.beforeModel();await input.beforeFinish({complete:true});};
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.ticks,undefined,'no refresh without a write');assert.equal(h.events.at(-1).kind,'review-completed');assert.equal(h.events.at(-1).data.outcome,'completed');
 h.service.close();
});
test('each attempt records one terminal outcome joined to its usage row',async()=>{
 const h=writeFixture();
 h.onRun=async input=>{await input.usage.begin({provider:'codex',model:'gpt-6.1-sol',role:'accountant'});};
 await h.service._worker(agentId,new AbortController());
 const done=h.events.at(-1);assert.match(h.begun.attemptId,/^[0-9a-f-]{36}$/);assert.equal(done.data.attemptId,h.begun.attemptId);assert.equal(done.data.usageId,h.begun.attemptId);assert.equal(h.begun.passId,done.data.passId);
 const failed=writeFixture();failed.row.nextSyncAt=new Date(failed.clock+30000);
 failed.onRun=async input=>{await input.usage.begin({provider:'codex',model:'gpt-6.1-sol',role:'accountant'});throw Object.assign(new Error('provider broke'),{reviewOutcome:'failed'});};
 await failed.service._worker(agentId,new AbortController());
 const attention=failed.events.at(-1);assert.equal(attention.kind,'attention');assert.equal(attention.data.outcome,'failed');assert.equal(attention.data.usageId,failed.begun.attemptId);
 const paused=writeFixture();
 paused.onRun=async input=>{await input.usage.begin({provider:'codex',model:'gpt-6.1-sol',role:'accountant'});throw Object.assign(new Error('limit'),{code:'CODEX_SUBSCRIPTION_LIMIT',reviewOutcome:'plan-limit'});};
 await paused.service._worker(agentId,new AbortController());
 assert.equal(paused.events.at(-1).kind,'review-paused');assert.equal(paused.events.at(-1).data.outcome,'plan-limit');assert.equal(paused.row.status,'usage-paused');
 const cancelled=writeFixture(),controller=new AbortController();
 cancelled.onRun=async()=>{controller.abort();throw new Error('aborted');};
 await cancelled.service._worker(agentId,controller);
 assert.equal(cancelled.events.at(-1).kind,'review-cancelled');assert.equal(cancelled.events.at(-1).data.outcome,'cancelled');
 [h,failed,paused,cancelled].forEach(value=>value.service.close());
});
test('the workspace exposes measured QuickBooks requests read-only',async()=>{
 const h=fixture();h.qboRequests={timezone:'UTC',today:{total:7,attempts:{sync:5,report:1,query:0,read:0,write:1}},month:{total:70,attempts:{sync:50,report:10,query:0,read:0,write:10}}};
 const view=await h.service.status({id:ownerId});assert.equal(view.qboRequests.today.total,7);assert.equal(view.qboRequests.month.total,70);
 const budget=view.qboRequests.budget;assert.deepEqual([budget.used,budget.meteredToday,budget.meteredMonth,budget.sync,budget.allowance,budget.reached],[1,6,60,5,500000,false],'writes are not metered; sync is metered but outside the activity budget');
 h.service.close();
});
test('a refresh that overruns its 60 s time allowance does not admit the write, and slices get only the time left',async()=>{
 const h=writeFixture();
 h.onTick=async()=>{h.clock+=61000;h.freshView();};// current again, but only after 61 s of refresh
 h.onRun=async input=>{h.age();await h.write(input);};
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.tickArgs[0].timeoutMs,60000,'the slice is bounded by the remaining allowance');
 assert.equal(h.approved,undefined);assert.equal(h.requested,undefined);assert.equal(h.events.some(event=>event.kind==='plan-decision'),false);
 const yielded=h.events.at(-1);assert.equal(yielded.kind,'review-yielded');assert.equal(yielded.data.refresh.ms,61000);assert.equal(h.row.status,'catching-up');
 h.service.close();
});
const terminal=(h)=>h.events.filter(event=>event.data?.attemptId===h.begun.attemptId&&['review-completed','specialist-report','review-yielded','attention','review-paused','review-cancelled'].includes(event.kind));
test('if the completion event cannot be saved the attempt is failed once, in its event and its usage row',async()=>{
 const h=writeFixture(),original=h.store.event;
 h.store.event=async(...args)=>{if(args[1]==='review-completed')throw new Error('event storage unavailable');return original(...args);};
 h.onRun=async input=>{await input.usage.begin({provider:'codex',model:'gpt-6.1-sol',role:'accountant'});return undefined;};
 await h.service._worker(agentId,new AbortController());
 const events=terminal(h);assert.equal(events.length,1);assert.equal(events[0].kind,'attention');assert.equal(events[0].data.outcome,'failed');
 assert.equal(h.usageSaves.at(-1).outcome,'failed');assert.equal(h.usageSaves.at(-1).id,h.begun.attemptId);assert.equal(h.row.status,'attention');
 h.service.close();
});
test('if the completion state cannot be saved there is still exactly one terminal outcome',async()=>{
 const h=writeFixture(),original=h.store.update;
 h.store.update=async(row,token,changes)=>{if(changes.lastDecisionAt)throw new Error('state storage unavailable');return original(row,token,changes);};
 h.onRun=async input=>{await input.usage.begin({provider:'codex',model:'gpt-6.1-sol',role:'accountant'});};
 await h.service._worker(agentId,new AbortController());
 const events=terminal(h);assert.equal(events.length,1);assert.equal(events[0].kind,'review-completed');assert.equal(events[0].data.outcome,'completed');
 assert.equal(h.usageSaves.filter(save=>save.outcome).length,1);assert.equal(h.usageSaves.at(-1).outcome,'completed');
 h.service.close();
});

// Phase 1 (continuous-business plan v2): the cadence decides whether a wake needs a model review.
const moveTo=(h,iso)=>{h.clock=Date.parse(iso);const now=new Date(h.clock).toISOString();h.row.syncView={...h.row.syncView,status:'current',lastSuccessAt:now,summaryAt:now,sources:[{entity:'Invoice',status:'current',lastSuccessAt:now,freshUntil:new Date(h.clock+120000).toISOString()}]};h.row.nextDecisionAt=new Date(h.clock);};
test('overnight with nothing actionable makes no model call and saves the next time and its reason',async()=>{
 const h=fixture();moveTo(h,'2026-10-24T02:00:00Z');// 11:00 PM Friday in Halifax; the calendar is closed through yesterday
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.engineCalls,0);assert.equal(h.row.cadence.kind,'quiet');assert.equal(h.row.cadence.reason,'after business hours');
 assert.equal(new Date(h.row.nextDecisionAt).getTime(),h.clock+3600000,'the owner interval is the overnight re-check, with no model');
 const view=await h.service.status({id:ownerId});assert.equal(view.rightNow.cadence.reason,'after business hours');
 h.service.close();
});
test('an owner request outranks the cadence once and counts toward the daily ceiling',async()=>{
 const h=fixture();moveTo(h,'2026-10-24T02:00:00Z');h.row.reviewRequestedAt=new Date(h.clock);
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.engineCalls,1);assert.equal(h.passContext.cadence.kind,'owner');assert.equal(h.row.cadence.reviews,1);
 assert.equal(new Date(h.row.nextDecisionAt).getTime(),h.clock+3600000,'after the requested review the quiet cadence resumes');
 h.row.nextDecisionAt=new Date(h.clock);await h.service._worker(agentId,new AbortController());assert.equal(h.engineCalls,1,'the request is served once');
 h.service.close();
});
test('at the daily review ceiling reviews pause until Halifax midnight',async()=>{
 const h=fixture();h.row.cadence={day:'2026-10-23',reviews:80};
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.engineCalls,0);assert.equal(h.row.cadence.kind,'ceiling');assert.equal(new Date(h.row.nextDecisionAt).toISOString(),'2026-10-24T03:00:00.000Z');
 h.service.close();
});
test('a due slot gives the accountant today’s counts and slot, and an unproductive review backs off',async()=>{
 const h=fixture();h.store.todayActivity=async()=>({runs:[],receipts:[]});
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.engineCalls,1);assert.equal(h.passContext.cadence.kind,'slice');
 assert.deepEqual(h.passContext.today.dueSlot,{n:4,records:30,decisionKey:'slot-20261023-r2-s4'});assert.equal(h.passContext.today.target,150);
 assert.equal(h.row.cadence.reviews,1);assert.equal(h.row.cadence.misses,1,'nothing changed during the review');
 assert.equal(new Date(h.row.nextDecisionAt).getTime(),h.clock+15*60000,'a retry is never sooner than the 15-minute slice spacing');
 const view=await h.service.status({id:ownerId});
 assert.equal(view.rightNow.today.line,'Today (Fri Oct 23): 150 planned · 0 in QuickBooks');
 assert.match(view.work.items.find(item=>item.key==='todays-activity').detail,/Activity slot 4 of 10 is due now: about 30 records/);
 h.service.close();
});

// Sol's Phase 1 review (2026-10-30) findings 1 and 4.
test('approved own work outside the calendar slot gets a recovery review overnight, before any calendar close',async()=>{
 const h=fixture();moveTo(h,'2026-10-24T02:00:00Z');
 h.owned=[{operationId:'7'.repeat(24),status:'approved',day:'2026-10-23',agentAuthority:{version:1,agentId,grantId:h.row.grant.id,authorityHash,ownerId},executionPending:false,completedRecords:0}];
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.engineCalls,1);assert.equal(h.passContext.cadence.kind,'recovery');assert.equal(h.passContext.unfinishedOperations[0].operationId,'7'.repeat(24));
 assert.equal(h.passContext.unfinishedOperations[0].agentAuthority,undefined,'authority internals stay out of the model context');
 const view=await h.service.status({id:ownerId});assert.equal(view.work.items.find(item=>item.key==='finish-approved').state,'waiting');
 h.service.close();
});
test('settings changes are not review requests, and an owner request at the ceiling is reported instead of run',async()=>{
 const h=fixture();moveTo(h,'2026-10-24T02:00:00Z');
 await h.service.control({id:ownerId},{command:'configure',settings:{syncIntervalSeconds:30,decisionIntervalMinutes:60},expectedRevision:1,requestKey:'fixture_configure_0001'});await h.service.drain();
 assert.equal(h.engineCalls,0);assert.equal(h.row.reviewRequestedAt,undefined);
 const capped=fixture();capped.row.cadence={day:'2026-10-23',reviews:80};
 await capped.service.control({id:ownerId},{command:'run-now',expectedRevision:1,requestKey:'fixture_run_now_0001'});await capped.service.drain();
 assert.equal(capped.engineCalls,0,'review 81 is never admitted');assert.equal(capped.row.cadence.kind,'ceiling');assert.match(capped.row.cadence.reason,/^you asked for a review, but today’s limit of 80 reviews is reached/);
 assert.equal(new Date(capped.row.nextDecisionAt).toISOString(),'2026-10-24T03:00:00.000Z','the request runs after Halifax midnight');
 [h,capped].forEach(value=>value.service.close());
});

// GPT-6.1 Sol round-2 review (2026-10-30) findings 1, 2 and 4.
const strandedRun=(h,disposition)=>({operationId:'7'.repeat(24),status:'stopped',planHash:'b'.repeat(64),day:'2026-10-23',agentAuthority:{version:1,agentId,grantId:h.row.grant.id,authorityHash,ownerId},executionPending:false,completedRecords:0,holdsSlot:false,disposition});
test('unsent work stopped outside the calendar is retired through the governed retirement, then normal work resumes',async()=>{
 const h=fixture();moveTo(h,'2026-10-24T02:00:00Z');h.owned=[strandedRun(h,'unsent')];const calls=[];
 h.governance={reviewRetirement:async(user,id,input)=>{calls.push(['review',id,input.planHash]);return {reviewHash:'c'.repeat(64)};},retire:async(user,id,input)=>{calls.push(['retire',id,input.reviewHash]);assert.match(input.reason,/no QuickBooks request sent and no record saved/);h.owned=[];return {retired:true};}};
 await h.service._worker(agentId,new AbortController());
 assert.deepEqual(calls,[['review','7'.repeat(24),'b'.repeat(64)],['retire','7'.repeat(24),'c'.repeat(64)]]);
 assert.equal(h.events.find(event=>event.title==='Main accountant retired unsent work').data.qboWrites,0);
 assert.equal(h.engineCalls,0,'nothing else is actionable overnight');assert.equal(h.row.cadence.kind,'quiet');
});
test('a failed retirement is reported and does not loop a model review',async()=>{
 const h=fixture();moveTo(h,'2026-10-24T02:00:00Z');h.owned=[strandedRun(h,'unsent')];
 h.governance={reviewRetirement:async()=>{throw Object.assign(new Error('A transport receipt exists. Retain and reconcile those effects; this operation cannot be retired as unsent.'),{code:'BUSINESS_RETIREMENT_BLOCKED'});}};
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.events.find(event=>event.title==='Unsent work could not be retired').kind,'attention');assert.equal(h.engineCalls,0);
 h.service.close();
});
test('stranded work with saved records holds new work visibly and makes no model call',async()=>{
 const h=fixture();h.owned=[strandedRun(h,'stranded')];
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.engineCalls,0);assert.equal(h.row.cadence.kind,'held');assert.match(h.row.cadence.reason,/stopped work with saved records/);
 const view=await h.service.status({id:ownerId});assert.equal(view.work.items.find(item=>item.key==='finish-approved').state,'blocked');
 h.service.close();
});
test('the worker hands its exact live lease to governed approval',async()=>{
 const h=writeFixture();let liveToken;
 h.onRun=async input=>{liveToken=h.row.leaseToken;await h.write(input);};
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.approved,1);const lease=h.leases.find(Boolean);
 assert.equal(lease.token,liveToken,'approval is fenced to this worker lease, not just the outer guard');assert.equal(typeof lease.now,'function');
 h.service.close();
});
test('due saved obligations trigger a review in business hours even when today is full',async()=>{
 const h=fixture();h.store.dueObligations=async()=>({invoices:2,bills:1,count:3});
 h.today={runs:[{id:'f',status:'verified',decisionKey:'duty-0001',createdAt:h.clock,createCount:150}],receipts:Array.from({length:150},(_,i)=>({operationId:'f',entity:'payment',logicalKey:'k'+i}))};
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.engineCalls,1);assert.equal(h.passContext.cadence.kind,'obligations');assert.deepEqual(h.passContext.dueObligations,{invoices:2,bills:1,count:3});
 h.service.close();
});

// GPT-6.1 Sol final review (2026-10-30): the enforced daily QuickBooks request budget.
test('at the daily request budget a due slot makes no model call and the reason is visible',async()=>{
 const h=fixture();h.qboRequests={today:{total:12000,attempts:{sync:2000,report:4000,query:3000,read:3000,write:0}},month:{total:90000,attempts:{sync:20000,report:30000,query:20000,read:20000,write:0}}};
 await h.service._worker(agentId,new AbortController());
 assert.equal(h.engineCalls,0);assert.match(h.row.cadence.reason,/request budget of 10,000 is used/);
 const view=await h.service.status({id:ownerId});
 assert.equal(view.rightNow.requests.reached,true);assert.match(view.work.items.find(item=>item.key==='todays-activity').detail,/request budget of 10,000 is used \(10,000 reads, queries and reports; sync and writes are not counted\)/);
 h.service.close();
});
