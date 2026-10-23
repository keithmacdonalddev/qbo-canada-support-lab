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
