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
 h.service=createBusinessAgentService({store,usage:{summary:async()=>h.usage||{month:{totalTokens:0,estimatedCostUsd:0}}},now:()=>h.clock,resolveContext:async()=>({environment:scope.environment,connection:{connected:true,connectionId:scope.connectionId,realmId:scope.realmId,companyName:'Fixture business'}}),accessFor:()=>({authorize:async()=>{h.accessCalls++;if(h.revoked)throw Object.assign(new Error('revoked'),{code:'BUSINESS_ACCESS_DENIED'});return {};},resolveClient:async()=>({})}),checkGrant:async()=>{},execution:{stop:async(user,id)=>h.stops.push(id)},governanceFor:()=>({}),createSync:options=>({tick:async()=>{h.syncCalls++;h.loadedCursor=(await options.loadState())?.cursor;await options.saveState({version:1,cursor:'continued'});return copy(h.row.syncView);}}),engine:{run:async input=>{h.engineCalls++;h.passContext=input.context;return {summary:'Reviewed current business and retained its next action.',calls:1,complete:true};}}});h.store=store;return h;
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
