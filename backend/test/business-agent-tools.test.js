'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBusinessAgentTools,validateArguments}=require('../src/modules/business-agent-tools');
const ownerId='a'.repeat(24),agentId='b'.repeat(24),grantId='c'.repeat(64),authorityHash='d'.repeat(64),operationId='e'.repeat(24),planHash='f'.repeat(64);
const scope={environment:'production',realmId:'123456789',connectionId:'1'.repeat(24)};
function fixture(role='accountant'){
 const h={events:[],approved:0,queued:0,prepared:0,resumed:0,paused:false,business:{scope,openingDate:'2026-10-01',verifiedThrough:'2026-10-22',blockers:[]}};
 h.row={_id:agentId,ownerId,grant:{id:grantId,authorityHash},settings:{instructions:''}};
 h.run={_id:operationId,createdBy:ownerId,planHash,agentAuthority:{version:1,agentId,grantId,authorityHash,ownerId}};
 h.tools=createBusinessAgentTools({row:h.row,role,passId:'fixture-pass',scope,user:{id:ownerId},signal:new AbortController().signal,now:()=>Date.parse('2026-10-23T12:00:00Z'),store:{models:{},business:async()=>h.business,decisions:async()=>[],run:async()=>h.run,event:async(...args)=>{h.events.push(args);return {id:'2'.repeat(24)};}},access:{},readTools:{toolDefinitions:[],toolHandlers:{}},guard:async()=>{if(h.paused)throw Object.assign(new Error('Owner paused the agent'),{code:'BUSINESS_AGENT_UNAVAILABLE'});},persistMemory:async memory=>{h.memory=memory;},governanceFor:origin=>({prepare:async()=>{assert.equal(origin.agentId,agentId);h.prepared++;return {operationId,planHash};},approve:async()=>{h.approved++;},reviewResume:async()=>({reviewHash:'1'.repeat(64)}),resume:async(user,id,input)=>{assert.equal(input.reviewHash,'1'.repeat(64));h.resumed++;}}),execution:{request:async()=>{h.queued++;return {accepted:true};}}});return h;
}
test('strict nested contracts reject authority injection and malformed values',()=>{
 assert.throws(()=>validateArguments({filters:{type:'Invoice',realmId:'foreign'}},{type:'object',properties:{filters:{type:'object',properties:{type:{type:'string'}}}}}),/unsupported field/);
 assert.throws(()=>validateArguments({limit:NaN},{type:'object',properties:{limit:{type:'number'}}}),/numeric/);
});
test('retained population and calendar blockers prevent historical regeneration',async()=>{
 const h=fixture();h.business.blockers=[{detail:'Verify original populated history; do not rebuild.'}];await assert.rejects(h.tools.execute('prepareBusinessPeriod',{throughDate:'2026-10-23'}),/do not rebuild/);assert.equal(h.prepared,0);
});
test('exact grant-owned plan approval retains agent decision before queuing work',async()=>{
 const h=fixture();await h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'The due published work is ready.'});assert.equal(h.approved,1);assert.equal(h.queued,1);assert.equal(h.events[0][1],'plan-decision');assert.equal(h.events[0][4].approvalSource,'standing-owner-grant');
 h.run.agentAuthority.grantId='0'.repeat(64);await assert.rejects(h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Try another grant'}),/belonging/);assert.equal(h.queued,1);
});
test('pause and specialist role prevent accounting dispatch',async()=>{
 const h=fixture();h.paused=true;await assert.rejects(h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'due'}),/paused/);assert.equal(h.queued,0);
 const specialist=fixture('receivables');assert.equal(specialist.tools.definitions.some(tool=>tool.name==='executeBusinessPeriod'),false);await assert.rejects(specialist.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'due'}),/cannot use/);
});
test('specialist findings report to the main accountant and operating memory is persisted',async()=>{
 const h=fixture('inventory');await h.tools.execute('recordBusinessDecision',{issueKey:'stock-low',title:'Review stock replenishment',detail:'The observed stock needs a purchasing decision.',requiresOwner:false,area:'inventory'});assert.equal(h.events[0][1],'specialist-report');assert.equal(h.events[0][4].reportsTo,'accountant');
 await h.tools.execute('rememberBusinessContext',{memory:'Awaiting purchasing evidence.'});assert.equal(h.memory,'Awaiting purchasing evidence.');
});

test('resume uses the exact existing recovery review before queueing original work',async()=>{
 const h=fixture();h.run.status='stopped';h.run.executionRevision=7;await h.tools.execute('resumeBusinessOperation',{operationId,planHash,reason:'Resume the exact original work after the owner enabled business operation.'});assert.equal(h.resumed,1);assert.equal(h.queued,1);assert.equal(h.events[0][1],'plan-decision');
 h.run.agentAuthority.grantId='0'.repeat(64);await assert.rejects(h.tools.execute('resumeBusinessOperation',{operationId,planHash,reason:'Do not permit another grant to resume retained work.'}),/standing grant/);assert.equal(h.resumed,1);
});

test('financial report tools enforce reports permission before any SDK request',async()=>{
 let sdk=0;const row={_id:agentId,ownerId,grant:{id:grantId,authorityHash},settings:{instructions:''}};
 const tools=createBusinessAgentTools({row,scope,passId:'report-pass',store:{},guard:async()=>{},access:{authorize:async(scope,action)=>{assert.equal(action,'reports.observe');throw Object.assign(new Error('reports denied'),{code:'BUSINESS_ACCESS_DENIED'});}},readTools:{toolDefinitions:[{name:'runReport',input_schema:{type:'object',properties:{report:{type:'string'}},required:['report']}}],toolHandlers:{runReport:async(input,context)=>context.qbo.apiCall('GET','reports/BalanceSheet')}},clientFor:async()=>({apiCall:async()=>{sdk++;return {};}}),signal:new AbortController().signal});
 await assert.rejects(tools.execute('runReport',{report:'BalanceSheet'}),/reports denied/);assert.equal(sdk,0);
});

test('getBusinessState exposes usage read-only without any control tool',async()=>{
 const usage={month:{totalTokens:42},caps:{tokens:100},planLimit:{resetAt:null}};
 const tools=createBusinessAgentTools({row:{settings:{}},scope,store:{business:async()=>({}),decisions:async()=>[]},guard:async()=>{},readTools:{toolDefinitions:[]},usageFor:async()=>usage});
 const result=await tools.execute('getBusinessState',{});assert.deepEqual(result.data.usage,usage);assert.equal(tools.definitions.some(tool=>/configure-usage|retry-plan-limit/.test(tool.name)),false);
});
test('inspecting an identifier with no saved operation says nothing is waiting to be recovered',async()=>{
 const h=fixture();let reviewed=0;const lookups=[];
 h.tools=createBusinessAgentTools({row:h.row,passId:'fixture-pass',scope,user:{id:ownerId},signal:new AbortController().signal,store:{models:{Runs:{exists:query=>{lookups.push(query);return {maxTimeMS:async()=>query._id===operationId?{_id:operationId}:null};}}}},access:{},readTools:{toolDefinitions:[],toolHandlers:{}},guard:async()=>{},governanceFor:()=>({reviewOperation:async()=>{reviewed++;return {entries:[]};}})});
 const missing=await h.tools.execute('inspectBusinessOperation',{operationId:'9'.repeat(24)});
 assert.equal(missing.success,false);assert.equal(missing.notFound,true);assert.match(missing.error,/Nothing is waiting to be recovered/);assert.equal(reviewed,0);
 assert.deepEqual(lookups[0],{_id:'9'.repeat(24),...scope});
 const found=await h.tools.execute('inspectBusinessOperation',{operationId});assert.equal(found.success,true);assert.equal(reviewed,1);
});

// Continuous-business Phase 1: server-owned slot identities, the daily ceiling and month-aware calendar closes.
const cadence=require('../src/modules/business-agent-cadence');
const NOON=Date.parse('2026-10-30T15:00:00Z');// 12:00 Halifax, Friday: slot 4 of 10 (11:30) is due
const sale={decisionKey:'model-chosen-key-01',purpose:'A completed same-day service visit with its accepted customer payment.',activities:[{type:'settled-service-sale',customerKey:'field-client-001',itemKey:'field-service-hour',quantity:3,unitPriceCents:12500,purpose:'Completed on-site maintenance visit and collected the accepted invoice.'}]};
const additions={decisionKey:'list-additions-0001',purpose:'Add the new customer that signed a service agreement today.',activities:[{type:'add-customer',name:'Harbour Fixture Co',purpose:'A new customer signed a service agreement today.'}]};
function slotFixture({now=NOON,verifiedThrough='2026-10-29'}={}){
 const h={prepared:[],periods:[],approved:0,queued:0,forgets:0,owned:[],todayCalls:[],leases:[],today:cadence.summarizeToday({rhythm:cadence.dayRhythm(cadence.localParts(now).date),now})};
 h.run={_id:operationId,createdBy:ownerId,planHash,status:'previewed',recordCount:5,activityBatch:{day:'2026-10-30',activities:[{type:'settled-service-sale'}]},agentAuthority:{version:1,agentId,grantId,authorityHash,ownerId}};
 h.tools=createBusinessAgentTools({row:{_id:agentId,ownerId,grant:{id:grantId,authorityHash},settings:{instructions:''}},passId:'slot-pass',scope,user:{id:ownerId},signal:new AbortController().signal,now:()=>now,
  store:{models:{},business:async()=>({scope,openingDate:'2026-01-01',verifiedThrough,blockers:[]}),run:async()=>h.run,event:async()=>({id:'2'.repeat(24)}),forgetToday:()=>{h.forgets++;},unfinishedRuns:async(scope,agent,grant)=>{h.unfinishedQuery=grant;return h.owned;}},access:{},readTools:{toolDefinitions:[],toolHandlers:{}},guard:async()=>{},
  governanceFor:(origin,lease)=>{h.leases.push(lease);return {prepareActivityBatch:async(user,input)=>{h.prepared.push(input);return {operationId,planHash};},prepare:async(user,input)=>{h.periods.push(input.throughDate);return {operationId,planHash};},approve:async()=>{h.approved++;}};},lease:{token:'worker-lease-token',now:()=>now},
  execution:{request:async()=>{h.queued++;return {accepted:true};}},todayFor:async options=>{h.todayCalls.push(options||{});return h.today;}});
 return h;
}
test('a same-day slice takes the due slot identity; duty and list batches keep their own',async()=>{
 const h=slotFixture();
 await h.tools.execute('prepareBusinessActivity',sale);
 assert.equal(h.prepared[0].decisionKey,'slot-20261030-r2-s4','the model chooses contents, the server names the slot');
 await h.tools.execute('prepareBusinessActivity',additions);
 assert.equal(h.prepared[1].decisionKey,'list-additions-0001');
 // The slot's batch was prepared: another slice in the same slot is refused and points at that plan.
 h.today=cadence.summarizeToday({rhythm:cadence.dayRhythm('2026-10-30'),runs:[{id:operationId,status:'previewed',decisionKey:'slot-20261030-r2-s4',createdAt:NOON-60000,createCount:3}],now:NOON});
 await assert.rejects(h.tools.execute('prepareBusinessActivity',sale),/already has a prepared batch \(operation e{24}\)/);
 h.today={...h.today,open:[]};
 await assert.rejects(h.tools.execute('prepareBusinessActivity',sale),/No same-day activity slot is due now; the next one opens at 12:30 PM \(Halifax\)/);
 await h.tools.execute('prepareBusinessActivity',additions);assert.equal(h.prepared.length,3,'standing duties stay available between slots');
});
test('the daily ceiling, a closed day and an unreadable count stop new discretionary slices',async()=>{
 const h=slotFixture();
 h.today={...h.today,ceilingReached:true,saved:300};await assert.rejects(h.tools.execute('prepareBusinessActivity',sale),/ceiling of 300 records is reached/);
 h.today={unavailable:true,day:'2026-10-30',label:'Fri Oct 30',target:20,ceiling:40};await assert.rejects(h.tools.execute('prepareBusinessActivity',sale),/could not be read/);
 const sunday=slotFixture({now:Date.parse('2026-11-01T16:00:00Z')});await assert.rejects(sunday.tools.execute('prepareBusinessActivity',sale),/closed today \(Sun Nov 1\)/);
 assert.equal(h.prepared.length+sunday.prepared.length,0);
});
test('obligations and other standing duties are never limited by the target or ceiling, including on Sunday',async()=>{
 const sunday=slotFixture({now:Date.parse('2026-11-01T16:00:00Z')});
 await sunday.tools.execute('prepareBusinessActivity',additions);assert.equal(sunday.prepared.length,1);
 const h=slotFixture();h.today={...h.today,ceilingReached:true,saved:300,reserved:0,reservedByRun:{}};
 await h.tools.execute('prepareBusinessActivity',additions);assert.equal(h.prepared[0].decisionKey,'list-additions-0001');
 h.run.activityBatch.activities=[{type:'collect-adopted-invoice'}];h.run.recordCount=3;
 await h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Collect the adopted invoice the customer paid today.'});assert.equal(h.queued,1,'an obligation is approved past the discretionary ceiling');
});
test('an unfinished approved operation is recovered before any new period or batch',async()=>{
 const h=slotFixture({now:Date.parse('2026-10-31T04:10:00Z'),verifiedThrough:'2026-10-29'});
 h.owned=[{operationId:'7'.repeat(24),status:'approved',day:'2026-10-30',agentAuthority:{version:1,agentId,grantId,authorityHash,ownerId}}];
 await assert.rejects(h.tools.execute('prepareBusinessPeriod',{throughDate:'2026-10-30'}),/Finish your unfinished operation 7{24} \(approved, 2026-10-30\) first/);
 await assert.rejects(h.tools.execute('prepareBusinessActivity',additions),/Finish your unfinished operation/);
 await assert.rejects(h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Approve another batch.'}),/Finish your unfinished operation/);
 assert.deepEqual([h.periods.length,h.prepared.length,h.approved],[0,0,0]);
 h.owned=[{...h.owned[0],agentAuthority:{...h.owned[0].agentAuthority,grantId:'0'.repeat(64)}}];
 await h.tools.execute('prepareBusinessPeriod',{throughDate:'2026-10-30'});assert.deepEqual(h.periods,['2026-10-30'],'work under another grant does not block this lineage');
});
test('slice admission reads fresh counts and drops cached counts after preparing and queueing',async()=>{
 const h=slotFixture();
 await h.tools.execute('prepareBusinessActivity',sale);assert.deepEqual(h.todayCalls.at(-1),{fresh:true});assert.equal(h.forgets,1);
 await h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Execute today’s slot batch.'});assert.deepEqual(h.todayCalls.at(-1),{fresh:true});assert.equal(h.forgets,2);
});
test('executing a new same-day batch must fit today’s ceiling; recovery is never limited',async()=>{
 const h=slotFixture();
 h.today={...h.today,saved:290,reserved:0,reservedByRun:{}};h.run.recordCount=12;
 await assert.rejects(h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Execute today’s slot batch.'}),/302 records, over its ceiling of 300/);
 assert.equal(h.approved,0);assert.equal(h.queued,0);
 h.run.recordCount=5;await h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Execute today’s slot batch.'});assert.equal(h.approved,1);assert.equal(h.queued,1);
});
test('calendar closes never cross a month-end',async()=>{
 const h=slotFixture({now:Date.parse('2026-11-03T15:00:00Z'),verifiedThrough:'2026-10-25'});
 await assert.rejects(h.tools.execute('prepareBusinessPeriod',{throughDate:'2026-11-02'}),/one calendar month at a time: prepare through 2026-10-31 first/);
 await h.tools.execute('prepareBusinessPeriod',{throughDate:'2026-10-31'});assert.deepEqual(h.periods,['2026-10-31']);
});

// GPT-6.1 Sol round-2 review (2026-10-30) findings 1-3.
test('only continuable or stranded work blocks new work; unsent work outside the slot does not',async()=>{
 const h=slotFixture({now:Date.parse('2026-10-31T04:10:00Z'),verifiedThrough:'2026-10-29'});
 const run={operationId:'7'.repeat(24),status:'stopped',day:'2026-10-30',agentAuthority:{version:1,agentId,grantId,authorityHash,ownerId},holdsSlot:false};
 h.owned=[{...run,disposition:'unsent'}];
 await h.tools.execute('prepareBusinessPeriod',{throughDate:'2026-10-30'});assert.deepEqual(h.periods,['2026-10-30'],'dead unsent work is retired by the worker, not left to deadlock the calendar');
 h.owned=[{...run,disposition:'stranded'}];
 await assert.rejects(h.tools.execute('prepareBusinessPeriod',{throughDate:'2026-10-30'}),/stopped outside the calendar after saving records/);
 h.owned=[{...run,status:'approved',disposition:'continue'}];
 await assert.rejects(h.tools.execute('prepareBusinessActivity',additions),/Finish your unfinished operation/);
 assert.equal(h.periods.length,1);
});
test('the unfinished-work query is filtered to the current grant, and governed calls carry the worker lease',async()=>{
 const h=slotFixture();
 await h.tools.execute('prepareBusinessActivity',sale);
 assert.deepEqual(h.unfinishedQuery,{id:grantId,authorityHash},'older grants cannot crowd current work out of a limited query');
 await h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Execute today\u2019s slot batch.'});
 assert.deepEqual(h.leases.filter(Boolean).map(lease=>lease.token),['worker-lease-token','worker-lease-token'],'preparation and approval are fenced to the exact worker lease');
});

// GPT-6.1 Sol final review (2026-10-30): per-slice allowance at approval and the daily request budget.
test('approval refuses a slice whose saved plan exceeds the slot allowance; obligations are not limited',async()=>{
 const h=slotFixture();h.today={...h.today,saved:0,reserved:0,reservedByRun:{},plannedByRun:{[operationId]:60},sliceCap:30};h.run.recordCount=5;
 await assert.rejects(h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Execute the slot batch under the standing grant.'}),/plans 60 new records, more than this slot\u2019s allowance of 30\. It was not approved\. Prepare a smaller batch/);
 assert.deepEqual([h.approved,h.queued],[0,0],'the saved plan count wins over the run row');
 h.today.plannedByRun={[operationId]:15};await h.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Execute the slot batch under the standing grant.'});assert.equal(h.approved,1);
 const duty=slotFixture();duty.today={...duty.today,plannedByRun:{[operationId]:60},sliceCap:30};duty.run.activityBatch.activities=[{type:'pay-adopted-bill'}];
 await duty.tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Pay the adopted bill that fell due today.'});assert.equal(duty.approved,1);
});
test('at the daily QuickBooks request budget new slices are refused; duties and recovery continue',async()=>{
 const h=slotFixture();let total=12000;
 const tools=createBusinessAgentTools({row:{_id:agentId,ownerId,grant:{id:grantId,authorityHash},settings:{instructions:''}},passId:'budget-pass',scope,user:{id:ownerId},signal:new AbortController().signal,now:()=>NOON,
  store:{models:{},business:async()=>({scope,openingDate:'2026-01-01',verifiedThrough:'2026-10-29',blockers:[]}),run:async()=>h.run,event:async()=>({id:'2'.repeat(24)}),unfinishedRuns:async()=>[]},access:{},readTools:{toolDefinitions:[],toolHandlers:{}},guard:async()=>{},
  governanceFor:()=>({prepareActivityBatch:async(user,input)=>{h.prepared.push(input);return {operationId,planHash};},approve:async()=>{h.approved++;}}),execution:{request:async()=>{h.queued++;return {accepted:true};}},todayFor:async()=>h.today,requestsFor:async()=>({today:{total}})});
 await assert.rejects(tools.execute('prepareBusinessActivity',sale),/request budget of 12,000 is used \(12,000 requests\)/);
 await assert.rejects(tools.execute('executeBusinessPeriod',{operationId,planHash,reason:'Execute the slot batch under the standing grant.'}),/request budget of 12,000 is used/);
 await tools.execute('prepareBusinessActivity',additions);assert.equal(h.prepared.length,1,'list additions and obligations are not discretionary slices');
 total=500;await tools.execute('prepareBusinessActivity',sale);assert.equal(h.prepared.length,2);
});
