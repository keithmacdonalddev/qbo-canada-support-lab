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
 const store={models:{Records:{},Users:{findOne:()=>({select(){return this;},maxTimeMS(){return this;},lean:async()=>({anthropicApiKey:'fixture-provider-key'})})}},get:async()=>copy(h.row),setup:async()=>h.setupCalls++,business:async()=>copy(h.business),events:async()=>copy(h.events),decisions:async()=>[],ownedRuns:async()=>[],event:async(row,kind,title,detail,data)=>{h.events.push({kind,title,detail,data});return {id:'f'.repeat(24)};},due:async()=>h.row?[{_id:agentId}]:[],claim:async(id,token,leaseMs)=>{if(!h.row||!h.row.settings.monitoring||(h.row.leaseToken&&new Date(h.row.leaseExpiresAt).getTime()>h.clock))return null;h.row.leaseToken=token;h.row.leaseExpiresAt=new Date(h.clock+leaseMs);return copy(h.row);},current:async(row,token)=>{if(!h.row||h.row.revision!==row.revision||h.row.leaseToken!==token||!h.row.settings.monitoring)throw new Error('lost lease');return copy(h.row);},update:async(row,token,changes)=>{await store.current(row,token);Object.assign(h.row,copy(changes));return copy(h.row);},release:async(row,token,changes)=>{if(h.row.revision===row.revision&&h.row.leaseToken===token)Object.assign(h.row,copy(changes),{leaseToken:null,leaseExpiresAt:null});return copy(h.row);},control:async(bound,input,reduce)=>{if(h.row?.revision!==input.expectedRevision)throw Object.assign(new Error('changed'),{code:'BUSINESS_AGENT_UNAVAILABLE',status:409});const changes=await reduce(copy(h.row));Object.assign(h.row,changes,{revision:h.row.revision+1,leaseToken:null,leaseExpiresAt:null});return copy(h.row);},scopeOf:()=>scope};
 store.run=async()=>copy(h.run||null);
 h.service=createBusinessAgentService({store,usage:{summary:async()=>h.usage||{month:{totalTokens:0,estimatedCostUsd:0}},begin:async(scope,details)=>{h.begun=details;return {_id:details.attemptId};},save:async(record,value)=>{(h.usageSaves||=[]).push({id:record._id,...value});}},now:()=>h.clock,resolveContext:async()=>({environment:scope.environment,connection:{connected:true,connectionId:scope.connectionId,realmId:scope.realmId,companyName:'Fixture business'}}),accessFor:()=>({authorize:async()=>{h.accessCalls++;if(h.revoked)throw Object.assign(new Error('revoked'),{code:'BUSINESS_ACCESS_DENIED'});return {};},resolveClient:async()=>({})}),checkGrant:async()=>{},execution:{stop:async(user,id)=>h.stops.push(id),request:async()=>{h.requested=(h.requested||0)+1;return {queued:true};}},governanceFor:()=>h.governance||({}),requestMeter:{summary:async()=>h.qboRequests||{today:{total:0}}},createSync:options=>({tick:async(args)=>{h.syncCalls++;(h.ticks||=[]).push(args?.maxRequests);(h.tickArgs||=[]).push(args);if(h.onTick)await h.onTick(options);h.loadedCursor=(await options.loadState())?.cursor;await options.saveState({version:1,cursor:'continued'});return copy(h.row.syncView);}}),engine:{run:async input=>{h.engineCalls++;h.passContext=input.context;if(h.onRun)await h.onRun(input);return {summary:'Reviewed current business and retained its next action.',calls:1,complete:true};}}});h.store=store;return h;
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
 const h=fixture();h.qboRequests={timezone:'UTC',today:{total:7,attempts:{sync:5,report:1,query:0,read:0,write:1}},month:{total:70}};
 const view=await h.service.status({id:ownerId});assert.equal(view.qboRequests.today.total,7);assert.equal(view.qboRequests.month.total,70);
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
