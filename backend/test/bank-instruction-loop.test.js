'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBankInstructionLoop,createDefaultBankInstructionLoop}=require('../src/modules/bank-instruction-loop');
const scope={environment:'production',realmId:'9130357222392856',connectionId:'a'.repeat(24)},ownerId='b'.repeat(24),row={_id:'c'.repeat(24),...scope,ownerId,settings:{monitoring:true,autonomous:true},grant:{id:'d'.repeat(64),authorityHash:'e'.repeat(64),ownerId}};
const chain=v=>({limit(){return this;},maxTimeMS(){return this;},lean:async()=>v});
test('constructor/import never start queries; timer owns one tick and close drains current account only',async()=>{
 let lists=0,executions=0,release,clears=0;const blocked=new Promise(r=>release=r),loop=createBankInstructionLoop({listAgents:async()=>{lists++;return[row];},listAccounts:async()=>['1','2'],execute:async()=>{executions++;await blocked;return{results:[],posted:0};},setTimer:()=>({unref(){}}),clearTimer:()=>clears++});
 assert.equal(lists,0);assert.equal(loop.status(scope,ownerId).status,'unobserved');loop.start();await new Promise(r=>setImmediate(r));assert.equal(executions,1);const pending=loop.tick();assert.equal(lists,1);loop.close();let drained=false;const drain=loop.drain().then(()=>drained=true);await new Promise(r=>setImmediate(r));assert.equal(drained,false);release();await Promise.all([drain,pending]);assert.equal(executions,1);assert.equal(clears,1);assert.equal(loop.status(scope,ownerId).status,'stopped');
});
test('account errors back off locally while independent accounts continue, heartbeat stays owner scoped',async()=>{
 let now=1000000;const calls=[];const loop=createBankInstructionLoop({now:()=>now,listAgents:async()=>[row],listAccounts:async()=>['1','2'],execute:async(_b,id)=>{calls.push(id);if(id==='1')throw Object.assign(Error('private detail'),{code:'BANKING_SETTLEMENT_PROOF'});return{results:[{changed:true,status:'pending'}],posted:0};}});
 await loop.tick();let s=loop.status(scope,ownerId);assert.equal(s.status,'attention');assert.equal(s.scheduled,1);assert.equal(JSON.stringify(s).includes('private detail'),false);assert.equal(loop.status({...scope,connectionId:'f'.repeat(24)},ownerId).status,'unobserved');assert.equal(loop.status(scope,'f'.repeat(24)).status,'unobserved');await loop.tick();assert.deepEqual(calls,['1','2','2']);now+=60001;await loop.tick();assert.deepEqual(calls,['1','2','2','1','2']);
});
test('paused, absent grant and foreign company agents never trigger bank processing',async()=>{
 const variants=[{...row,settings:{monitoring:true,autonomous:false}},{...row,grant:null},{...row,realmId:'999'}];for(const variant of variants){let calls=0;const loop=createBankInstructionLoop({listAgents:async()=>[variant],listAccounts:async()=>{calls++;return['1'];},execute:async()=>{calls++;}});await loop.tick();assert.equal(calls,0);}
});
test('production adapter renews runtime permission and fences agent inside each settlement transaction',async()=>{
 const calls=[],session={inTransaction:()=>true};let current=row,authorize;
 const Agents={find:()=>chain([row]),findOne:()=>chain(current)};
 const loop=createDefaultBankInstructionLoop({selectDue:async()=>[{}],Agents,Events:{distinct:()=>({maxTimeMS:async()=>['1']})},createAccess:()=>({authorize:async(s,a,o)=>calls.push({scope:s,action:a,session:o.session})}),fence:async args=>{calls.push({fenced:args.authority,session:args.session});assert.equal(current.settings.autonomous,true);},makeSettlement:options=>{authorize=options.authorize;return{settle:async(b,input)=>{await authorize({...b,action:'periods.manage'});await authorize({...b,action:'periods.manage',session});return{results:[],posted:0};}};}});
 assert.deepEqual(calls,[]);await loop.tick();assert.equal(calls.length,4);assert.equal(calls[0].action,'periods.manage');assert.equal(calls[2].session,session);assert.equal(calls[3].session,session);assert.equal(calls[3].fenced.agentId,row._id);
 current={...row,settings:{...row.settings,autonomous:false}};Agents.findOne=filter=>chain(current.settings.autonomous===filter['settings.autonomous']?current:null);await assert.rejects(authorize({scope,ownerId,actorId:ownerId,agentAuthority:{version:1,agentId:row._id,ownerId,grantId:row.grant.id,authorityHash:row.grant.authorityHash}}),{code:'BUSINESS_AGENT_AUTHORITY_REQUIRED'});
});

test('empty due selection does not open a settlement transaction or touch agent dispatch progress',async()=>{let settled=0,authorized=0;const loop=createDefaultBankInstructionLoop({Agents:{find:()=>chain([row]),findOne:()=>chain(row)},Events:{distinct:()=>({maxTimeMS:async()=>['1']})},selectDue:async()=>[],createAccess:()=>({authorize:async()=>authorized++}),makeSettlement:()=>({settle:async()=>{settled++;}})});await loop.tick();assert.equal(authorized,1);assert.equal(settled,0);assert.equal(loop.status(scope,ownerId).lastWorkAt,null);});
