'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBusinessAgentEngine,systemPrompt}=require('../src/modules/business-agent-engine');
test('Anthropic tool loop executes real supplied contracts and returns the observed summary',async()=>{
  let rounds=0;const calls=[];const provider={resolveProvider:async()=> 'anthropic',chat:async()=>++rounds===1?{stop_reason:'tool_use',content:[{type:'tool_use',id:'one',name:'getBusinessState',input:{}}]}:{stop_reason:'end_turn',content:[{type:'text',text:'Inspected the current business and retained its next action.'}]}};
  const result=await createBusinessAgentEngine({provider}).run({context:{ownerInstructions:'Keep a believable business'},tools:[{name:'getBusinessState'}],execute:async(name,input)=>{calls.push({name,input});return {success:true};}});
  assert.equal(rounds,2);assert.equal(calls.length,1);assert.equal(result.complete,true);assert.match(result.summary,/Inspected/);
});
test('a truncated tool response cannot dispatch partial model arguments',async()=>{
  let writes=0;const provider={resolveProvider:async()=> 'anthropic',chat:async()=>({stop_reason:'max_tokens',content:[{type:'tool_use',id:'cut',name:'executeBusinessPeriod',input:{}}]})};
  const result=await createBusinessAgentEngine({provider}).run({context:{},tools:[],execute:async()=>writes++});assert.equal(writes,0);assert.equal(result.complete,false);
});
test('Codex bridge closes on provider failure and has no additional tool surface',async()=>{
  let closed=0;const tools=[{name:'getBusinessState'}];const engine=createBusinessAgentEngine({provider:{resolveProvider:async()=> 'codex'},createBridge:options=>{assert.equal(options.tools,tools);return {bridge:{token:'fixture-private'},close:async()=>closed++};},codex:{run:async()=>{throw new Error('fixture failure');}}});
  await assert.rejects(engine.run({context:{},tools,execute:async()=>({})}),/fixture failure/);assert.equal(closed,1);
});
test('cancelled passes do not call a model and specialist operating briefs preserve main accountability',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;const engine=createBusinessAgentEngine({provider:{resolveProvider:async()=>{calls++;return 'anthropic';}}});
  await assert.rejects(engine.run({context:{},tools:[],execute:async()=>({}),signal:controller.signal}),/cancelled/);assert.equal(calls,0);assert.match(systemPrompt('inventory'),/main accountant/);assert.match(systemPrompt('accountant'),/untrusted business data/);
});

test('server authority is checked before provider resolution and every model round',async()=>{
 let resolved=0,chats=0,guards=0;const provider={resolveProvider:async()=>{resolved++;return 'anthropic';},chat:async()=>{chats++;return {stop_reason:'tool_use',content:[{type:'tool_use',id:'one',name:'getBusinessState',input:{}}]};}};
 const engine=createBusinessAgentEngine({provider});await assert.rejects(engine.run({context:{},tools:[],execute:async()=>({success:true}),beforeModel:async()=>{if(++guards===3)throw new Error('paused at next model round');}}),/paused/);assert.equal(resolved,1);assert.equal(chats,1);
 let called=0;await assert.rejects(engine.run({context:{},tools:[],execute:async()=>({}),beforeModel:async()=>{called++;throw new Error('authority revoked');}}),/revoked/);assert.equal(called,1);assert.equal(resolved,1);
});
test('fatal lease/authority failures propagate instead of becoming ordinary tool results',async()=>{
 let chats=0;const provider={resolveProvider:async()=> 'anthropic',chat:async()=>{chats++;return {stop_reason:'tool_use',content:[{type:'tool_use',id:'one',name:'getBusinessState',input:{}}]};}};
 const engine=createBusinessAgentEngine({provider});await assert.rejects(engine.run({context:{},tools:[],execute:async()=>{throw Object.assign(new Error('lost lease'),{businessAgentFatal:true});}}),/lost lease/);assert.equal(chats,1);
});

test('legal full decision history is summarized without stopping future reviews',async()=>{
  let size=0;const provider={resolveProvider:async()=> 'anthropic',chat:async(messages,tools,options)=>{size=Buffer.byteLength(messages[0].content);assert.equal(options.maxAttempts,1);return {stop_reason:'end_turn',content:[{type:'text',text:'Review complete.'}]};}};
  const decisions=Array.from({length:20},(_,i)=>({id:String(i),title:'Decision',detail:'e'.repeat(5000),response:{detail:'r'.repeat(3000)},status:'accept'}));
  const result=await createBusinessAgentEngine({provider}).run({context:{decisions,specialistReports:Array.from({length:8},()=>({detail:'s'.repeat(6000)}))},tools:[],execute:async()=>({})});
  assert.equal(result.complete,true);assert.ok(size<60000);
});

test('records every API round and final outcome without response content or keys',async()=>{
 const saves=[],starts=[];let chats=0;
 const provider={resolveProvider:async()=> 'anthropic',chat:async()=>({model:'claude-sonnet-5-5',usage:{input_tokens:10,output_tokens:3,cache_read_input_tokens:4},stop_reason:++chats===1?'tool_use':'end_turn',content:chats===1?[{type:'tool_use',id:'one',name:'getBusinessState',input:{}}]:[{type:'text',text:'private summary'}]})};
 const result=await createBusinessAgentEngine({provider}).run({role:'inventory',context:{ownerInstructions:'private prompt'},userApiKey:'private-key',tools:[],execute:async()=>({}),usage:{begin:async value=>{starts.push(value);return {_id:'fixture'};},save:async(row,value)=>saves.push(value)}});
 assert.equal(result.complete,true);assert.equal(starts[0].role,'inventory');assert.equal(saves.at(-1).inputTokens,20);assert.equal(saves.at(-1).cacheReadTokens,8);assert.equal(saves.at(-1).outcome,'completed');assert.equal(saves.at(-1).totalTokens,34);assert.ok(!JSON.stringify({starts,saves}).includes('private'));
});
test('Codex quota failures record reset and partial usage even when review fails',async()=>{
 const saves=[];const quota={resetAt:'2026-11-01T00:00:00Z'};
 const engine=createBusinessAgentEngine({provider:{resolveProvider:async()=> 'codex'},createBridge:()=>({bridge:{},close:async()=>{}}),codex:{run:async()=>{throw Object.assign(new Error('limit'),{code:'CODEX_SUBSCRIPTION_LIMIT',quota,usage:{inputTokens:4,outputTokens:2}});}}});
 await assert.rejects(engine.run({context:{},tools:[],execute:async()=>({}),usage:{begin:async()=>({_id:'fixture'}),save:async(row,value)=>saves.push(value)}}),/limit/);
 assert.equal(saves.at(-1).outcome,'plan-limit');assert.equal(saves.at(-1).resetAt,quota.resetAt);assert.equal(saves.at(-1).totalTokens,6);assert.equal(saves.at(-1).estimatedCostUsd,null);
});
test('usage write failure stops before model tools can execute',async()=>{
 let executed=0;const provider={resolveProvider:async()=> 'anthropic',chat:async()=>({usage:{input_tokens:2,output_tokens:1},content:[{type:'tool_use',id:'one',name:'write',input:{}}]})};
 await assert.rejects(createBusinessAgentEngine({provider}).run({context:{},tools:[],execute:async()=>executed++,usage:{begin:async()=>({_id:'fixture'}),save:async()=>{throw new Error('storage unavailable');}}}),/storage unavailable/);assert.equal(executed,0);
});

test('a real capped tool loop starts and pauses only the next model call after spend reaches its limit',async()=>{
 const {reviewPause}=require('../src/modules/business-agent-usage');let chats=0,record;const cap={monthlyCaps:{apiUsd:0.01}};
 const provider={resolveProvider:async()=> 'anthropic',chat:async()=>{chats++;return {model:'claude-sonnet-5-5',usage:{input_tokens:10000,output_tokens:10},stop_reason:'tool_use',content:[{type:'tool_use',id:'one',name:'read',input:{}}]};}};
 const usage={begin:async value=>(record={...value,outcome:'running',estimatedCostUsd:null}),save:async(row,value)=>Object.assign(record,value)};
 const beforeModel=async()=>{const state={month:{estimatedCostUsd:record?.estimatedCostUsd||0,unpricedReviews:record?.outcome!=='running'&&record?.estimatedCostUsd===null?1:0}};if(reviewPause(state,cap))throw Object.assign(new Error('cap reached'),{code:'BUSINESS_REVIEW_PAUSED'});};
 await assert.rejects(createBusinessAgentEngine({provider}).run({context:{},tools:[],execute:async()=>({}),usage,beforeModel}),/cap reached/);assert.equal(chats,1);assert.equal(record.outcome,'cap-reached');assert.ok(record.estimatedCostUsd>=0.01);
});

test('unpriced API response retains an unknown state before the next capped call',async()=>{
 let record,chats=0;const provider={resolveProvider:async()=> 'anthropic',chat:async()=>{chats++;return {model:'unpriced-model',usage:{input_tokens:10,output_tokens:1},stop_reason:'tool_use',content:[{type:'tool_use',id:'one',name:'read',input:{}}]};}};
 await assert.rejects(createBusinessAgentEngine({provider}).run({context:{},tools:[],execute:async()=>({}),usage:{begin:async value=>(record={...value,outcome:'running'}),save:async(row,value)=>Object.assign(record,value)},beforeModel:async()=>{if(record?.outcome==='usage-unknown')throw new Error('unknown API price');}}),/unknown API price/);assert.equal(chats,1);assert.equal(record.estimatedCostUsd,null);
});

test('a review stopped before dispatch retains known zero usage instead of blocking future capped reviews',async()=>{
 let guards=0,record,chats=0;const provider={resolveProvider:async()=> 'anthropic',chat:async()=>chats++};
 await assert.rejects(createBusinessAgentEngine({provider}).run({context:{},tools:[],execute:async()=>({}),beforeModel:async()=>{if(++guards===2)throw new Error('owner paused before dispatch');},usage:{begin:async value=>(record={...value}),save:async(row,value)=>Object.assign(record,value)}}),/owner paused/);
 assert.equal(chats,0);assert.equal(record.usageMissing,false);assert.equal(record.totalTokens,0);assert.equal(record.estimatedCostUsd,0);
});
