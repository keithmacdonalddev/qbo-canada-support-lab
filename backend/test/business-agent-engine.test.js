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
test('Codex bridge closes on provider failure and receives only core and discovery tools',async()=>{
  let closed=0;const tools=[{name:'getBusinessState'},{name:'runReport'}];const engine=createBusinessAgentEngine({provider:{resolveProvider:async()=> 'codex'},createBridge:options=>{assert.deepEqual(options.tools.map(tool=>tool.name),['searchTools','useTool','listSkills','loadSkill','readSkillReference','getBusinessState']);return {bridge:{token:'fixture-private'},close:async()=>closed++};},codex:{run:async()=>{throw new Error('fixture failure');}}});
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
 assert.equal(saves.at(-1).outcome,'plan-limit');assert.equal(saves.at(-1).resetAt,quota.resetAt);assert.equal(saves.at(-1).totalTokens,6);assert.equal(saves.at(-1).estimatedCostUsd,null);assert.equal(saves.at(-1).cacheSplit,false);
});
test('Codex reviews store fresh and cached input separately with unchanged token totals and no API spend',async()=>{
 const saves=[];const engine=createBusinessAgentEngine({provider:{resolveProvider:async()=> 'codex'},createBridge:()=>({bridge:{},close:async()=>{}}),codex:{getStatus:async()=>({method:'chatgpt'}),run:async()=>({text:'done',usage:{inputTokens:100,cachedInputTokens:80,outputTokens:10}})}});
 const result=await engine.run({context:{},tools:[],execute:async()=>({}),usage:{begin:async()=>({_id:'fixture'}),save:async(row,value)=>saves.push(value)}});
 const last=saves.at(-1);assert.equal(result.complete,true);assert.equal(last.inputTokens,20);assert.equal(last.cacheReadTokens,80);assert.equal(last.totalTokens,110);assert.equal(last.cacheSplit,true);assert.equal(last.estimatedCostUsd,null);assert.equal(last.outcome,'completed');
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
test('one terminal outcome per attempt: finalization failure, freshness yield and completion agree with the usage row',async()=>{
 const provider={resolveProvider:async()=> 'anthropic',chat:async()=>({model:'claude-sonnet-5-5',usage:{input_tokens:1,output_tokens:1},stop_reason:'end_turn',content:[{type:'text',text:'done'}]})};
 const usageFor=saves=>({begin:async()=>({_id:'fixture'}),save:async(row,value)=>saves.push(value)});
 let saves=[];const result=await createBusinessAgentEngine({provider}).run({context:{},tools:[],execute:async()=>({}),usage:usageFor(saves),beforeFinish:async()=>{}});
 assert.equal(result.outcome,'completed');assert.equal(saves.at(-1).outcome,'completed');
 saves=[];let failure;await createBusinessAgentEngine({provider}).run({context:{},tools:[],execute:async()=>({}),usage:usageFor(saves),beforeFinish:async()=>{throw new Error('authority changed');}}).catch(error=>{failure=error;});
 assert.match(failure.message,/authority/);assert.equal(failure.reviewOutcome,'failed');assert.equal(saves.at(-1).outcome,'failed','a model session that could not be finalized is not recorded as completed');
 let rounds=0;const toolProvider={resolveProvider:async()=> 'anthropic',chat:async()=>({usage:{input_tokens:1,output_tokens:1},stop_reason:++rounds===1?'tool_use':'end_turn',content:[{type:'tool_use',id:'w',name:'executeBusinessPeriod',input:{}}]})};
 saves=[];failure=null;await createBusinessAgentEngine({provider:toolProvider}).run({context:{},tools:[],execute:async()=>{throw Object.assign(new Error('sources stale'),{code:'BUSINESS_FRESHNESS_YIELD',businessAgentFatal:true});},usage:usageFor(saves)}).catch(error=>{failure=error;});
 assert.equal(failure.reviewOutcome,'yielded');assert.equal(saves.at(-1).outcome,'yielded');assert.equal(rounds,1,'the review stops at the yield');
});
test('Codex: a fatal tool error through the real MCP bridge is retained, refuses later calls and ends the attempt as yielded',async()=>{
 const {handleMcpRequest}=require('../src/modules/ai-tool-bridge');const saves=[],replies=[];let executed=0;
 const call=(token,id)=>handleMcpRequest(token,{jsonrpc:'2.0',id,method:'tools/call',params:{name:'executeBusinessPeriod',arguments:{}}});
 const codex={run:async({bridge})=>{replies.push((await call(bridge.token,1)).json,(await call(bridge.token,2)).json);return {text:'Business review completed.',usage:{inputTokens:5,outputTokens:1}};}};
 const engine=createBusinessAgentEngine({provider:{resolveProvider:async()=> 'codex'},codex});
 let failure;await engine.run({context:{},tools:[{name:'executeBusinessPeriod',description:'write',input_schema:{type:'object',properties:{}}}],execute:async()=>{executed++;throw Object.assign(new Error('Company sources could not be brought current.'),{code:'BUSINESS_FRESHNESS_YIELD',businessAgentFatal:true});},usage:{begin:async()=>({_id:'fixture'}),save:async(row,value)=>saves.push(value)}}).catch(error=>{failure=error;});
 assert.equal(failure?.code,'BUSINESS_FRESHNESS_YIELD');assert.equal(failure.reviewOutcome,'yielded');assert.equal(saves.at(-1).outcome,'yielded');assert.equal(saves.at(-1).totalTokens,6,'usage from the finished Codex run is kept');
 assert.equal(executed,1,'the second call is refused without running');assert.equal(replies[0].result.isError,true);assert.match(replies[1].result.content[0].text,/stopped/);
});
test('deferOutcome leaves the terminal outcome to the caller’s attempt finalizer',async()=>{
 const saves=[];const provider={resolveProvider:async()=> 'anthropic',chat:async()=>({model:'claude-sonnet-5-5',usage:{input_tokens:1,output_tokens:1},stop_reason:'end_turn',content:[{type:'text',text:'done'}]})};
 const result=await createBusinessAgentEngine({provider}).run({context:{},tools:[],execute:async()=>({}),deferOutcome:true,usage:{begin:async()=>({_id:'fixture'}),save:async(row,value)=>saves.push(value)}});
 assert.equal(result.outcome,'completed');assert.equal(Object.hasOwn(saves.at(-1),'outcome'),false);assert.ok(saves.at(-1).finishedAt);
});
test('progressive disclosure: core schemas only, skills index in the instructions, search loads a deferred tool natively and useTool dispatches',async()=>{
 const schema={type:'object',properties:{reportName:{type:'string'}},required:['reportName'],additionalProperties:false};
 const tools=[{name:'getBusinessState',description:'state',input_schema:{type:'object',properties:{},required:[],additionalProperties:false}},{name:'runReport',description:'Runs a QuickBooks report such as aged receivables.',input_schema:schema}];
 const sent=[],calls=[];let system='';
 const replies=[
  {stop_reason:'tool_use',content:[{type:'tool_use',id:'a',name:'searchTools',input:{query:'aged receivables report'}},{type:'tool_use',id:'b',name:'loadSkill',input:{name:'receivables-and-collections'}}]},
  {stop_reason:'tool_use',content:[{type:'tool_use',id:'c',name:'useTool',input:{name:'runReport',input:{reportName:'AgedReceivables'}}},{type:'tool_use',id:'d',name:'useTool',input:{name:'runReport',input:{wrong:true}}}]},
  {stop_reason:'tool_use',content:[{type:'tool_use',id:'e',name:'runReport',input:{reportName:'ProfitAndLoss'}}]},
  {stop_reason:'end_turn',content:[{type:'text',text:'done'}]}];
 const results=[];
 const provider={resolveProvider:async()=> 'anthropic',chat:async(messages,list,options)=>{sent.push(list.map(tool=>tool.name));system=options.system;const last=messages.at(-1);if(Array.isArray(last.content))results.push(...last.content.map(item=>JSON.parse(item.content)));return replies[sent.length-1];}};
 const result=await createBusinessAgentEngine({provider}).run({context:{},tools,maxCalls:3,execute:async(name,input)=>{calls.push({name,input});return {success:true};}});
 assert.equal(result.complete,true);
 assert.ok(!sent[0].includes('runReport'),'deferred tools are not sent first');assert.ok(sent[0].includes('searchTools')&&sent[0].includes('getBusinessState'));
 assert.ok(sent[1].includes('runReport'),'a searched tool is offered natively from the next round');
 assert.match(system,/receivables-and-collections: /);assert.match(system,/Deferred tools: quickbooks-read: runReport/);
 assert.equal(results[0].data.tools[0].name,'runReport');assert.match(results[1].data.instructions,/Dunning/);
 assert.equal(results[3].success,false,'useTool rejects input outside the schema');
 assert.deepEqual(calls,[{name:'runReport',input:{reportName:'AgedReceivables'}},{name:'runReport',input:{reportName:'ProfitAndLoss'}}],'discovery calls do not use the three-call allowance');
});

test('the accountant keeps independent work moving and acts on current saved eligibility',()=>{
 const prompt=systemPrompt('accountant');assert.match(prompt,/manageQboRecord to prepare independent/);assert.match(prompt,/three operations/);assert.match(prompt,/current saved eligibility/);assert.doesNotMatch(prompt,/New periods and batches are refused until it is done/);
});
