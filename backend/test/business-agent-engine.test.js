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
