'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {createSessionStreams}=require('../src/modules/ai-session-streams');
const {createSessionStreamRouter}=require('../src/routes/session-streams');
const {createApp}=require('../src/app');
const {issueToken}=require('../src/modules/auth-token');
const {createCompanyScope}=require('../src/middleware/companyScope');
const owner='b'.repeat(24),actor='c'.repeat(24),sessionId='d'.repeat(24),connectionId='a'.repeat(24);
async function fixture(work){
 const h={clock:Date.now(),owner,realmId:'123',connectionId,membership:true,accounts:new Map([[owner,{_id:owner,email:'owner@fixture.invalid',role:'agent',authVersion:0}],[actor,{_id:actor,email:'actor@fixture.invalid',role:'agent',authVersion:0}]]),reads:0};
 const query=value=>({select(){return this;},sort(){return this;},maxTimeMS(){return this;},lean:async()=>value()});
 const loadAccount=async id=>{h.reads++;return h.accounts.get(id);};
 const streams=createSessionStreams({loadAccount,workspaceFor:async()=>h.owner,Sessions:{findOne:filter=>query(()=>filter._id===sessionId&&filter.userId===owner?{_id:sessionId,userId:owner,realmId:'123'}:null)},Connections:{findOne:()=>query(()=>({_id:h.connectionId,realmId:h.realmId}))},Memberships:{findOne:()=>query(()=>h.membership?{role:'reviewer'}:null)},environment:()=> 'sandbox',now:()=>h.clock});h.streams=streams;
 const router=createSessionStreamRouter({streams}),scope=createCompanyScope({databaseReady:()=>true,hasOwnActiveConnection:async id=>id===owner,memberRealms:async()=>h.membership?['123']:[],activeConnectionFor:async()=>({userId:h.owner,realmId:h.realmId})});
 const app=createApp({aiRoutes:{router,emitSSE:()=>{}},companyScope:scope,rebuildRouter:express.Router(),databaseReady:()=>true,currentAccount:{loadAccount}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port+'/api/ai';
 h.token=()=>issueToken(h.accounts.get(actor));
 h.ticket=async()=>{const response=await fetch(base+'/stream-ticket',{method:'POST',headers:{Authorization:'Bearer '+h.token(),'Content-Type':'application/json'},body:JSON.stringify({sessionId})});assert.equal(response.status,200);return(await response.json()).data.ticket;};
 h.open=(ticket,{token=h.token(),signal}={})=>fetch(base+'/stream/'+sessionId+'?ticket='+ticket,{headers:token?{Authorization:'Bearer '+token}:{},signal});
 try{await work(h);}finally{streams.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('actual app opens a single-use ticket stream with Authorization and no public stream bypass',async()=>fixture(async h=>{
 const ticket=await h.ticket();assert.equal((await h.open(ticket,{token:null})).status,401);
 const controller=new AbortController(),response=await h.open(ticket,{signal:controller.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: connected/);
 const next=reader.read();await h.streams.emit(sessionId,'done',{ok:true});assert.match(new TextDecoder().decode((await next).value),/event: done/);assert.equal((await h.open(ticket)).status,401);controller.abort();await reader.cancel().catch(()=>{});
}));
test('ticket actor versions and shared company scope are rechecked before opening',async()=>{
 for(const kind of ['version','owner','connection','membership'])await fixture(async h=>{const ticket=await h.ticket();if(kind==='version')h.accounts.get(actor).authVersion++;if(kind==='owner')h.owner='e'.repeat(24);if(kind==='connection')h.connectionId='f'.repeat(24);if(kind==='membership')h.membership=false;const response=await h.open(ticket);assert.equal(response.status,403);});
});
test('an open stream ends without delivering another event after account, membership or company revocation',async()=>{
 for(const kind of ['version','owner-recovery','membership','connection'])await fixture(async h=>{const ticket=await h.ticket(),response=await h.open(ticket),reader=response.body.getReader();await reader.read();if(kind==='version')h.accounts.get(actor).authVersion++;if(kind==='owner-recovery')h.accounts.get(owner).email='tester@testdatalab.local';if(kind==='membership')h.membership=false;if(kind==='connection')h.realmId='456';const next=reader.read();await h.streams.emit(sessionId,'token','must not be delivered');const value=await next;assert.equal(value.done,true);await reader.cancel().catch(()=>{});});
});
