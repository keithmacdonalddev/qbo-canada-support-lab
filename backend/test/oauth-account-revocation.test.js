'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {createApp}=require('../src/app');
const {createQboRouter}=require('../src/routes/qbo');
const {issueToken}=require('../src/modules/auth-token');
const id='b'.repeat(24);
async function fixture(work){
 const h={account:{_id:id,email:'private@fixture.invalid',role:'agent',authVersion:0},exchanges:0,connections:[],audits:[],userWrites:0,ended:0};
 const Accounts={findById:()=>{const query={select(){return query;},session(){return query;},maxTimeMS(){return query;},lean:async()=>h.account?{...h.account}:null};return query;},updateOne:async(filter)=>{if(!h.account||h.account.role!==filter.role||h.account.authVersion!==filter.authVersion)return{matchedCount:0};h.userWrites++;return{matchedCount:1};}};
 const qboRouter=createQboRouter({Accounts,loadAccount:async()=>{if(h.unavailable)throw Error('private storage detail');return h.account?{...h.account}:null;},Connections:{findOneAndUpdate:async(_filter,update)=>{h.connections.push(update);return{_id:'connection-1',...update};},updateMany:async()=>{}},Audits:{create:async rows=>h.audits.push(...rows)},database:{startSession:async()=>({withTransaction:async callback=>callback(),endSession:async()=>{h.ended++;}})},auditEntry:async()=>({id:'fixture-audit'}),oauthFactory:()=>({authorizeUri:({state})=>'https://identity.fixture.invalid/?state='+state,createToken:async()=>{h.exchanges++;if(h.revokeAfterExchange)h.account.authVersion++;return{json:{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600}};}})});
 const app=createApp({qboRouter,rebuildRouter:express.Router(),databaseReady:()=>true,companyScope:(_req,_res,next)=>next(),currentAccount:{loadAccount:async()=>h.account?{...h.account}:null}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/api/qbo';
 h.connect=async()=>{const result=await fetch(base+'/connect',{headers:{Authorization:'Bearer '+issueToken(h.account),Origin:'http://localhost:5173'}});assert.equal(result.status,200);return new URL((await result.json()).authUri).searchParams.get('state');};
 h.callback=async nonce=>{const response=await fetch(base+'/callback?state='+nonce+'&realmId=123&code=fixture');return{status:response.status,text:await response.text()};};
 const originalError=console.error;console.error=()=>{};
 try{await work(h);}finally{console.error=originalError;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('nonce is single-use and credential revocation blocks exchange before provider or connection changes',async()=>fixture(async h=>{
 const nonce=await h.connect();h.account.authVersion++;const result=await h.callback(nonce);assert.equal(result.status,403);assert.match(result.text,/authorization changed/);assert.equal(h.exchanges,0);assert.equal(h.connections.length,0);assert.equal((await h.callback(nonce)).status,403);
}));
test('deleted, unrecovered reserved and unavailable account authority stop pending OAuth before exchange',async()=>{
 for(const kind of ['deleted','reserved','unavailable'])await fixture(async h=>{const nonce=await h.connect();if(kind==='deleted')h.account=null;if(kind==='reserved')h.account.email='tester@testdatalab.local';if(kind==='unavailable')h.unavailable=true;const result=await h.callback(nonce);assert.equal(result.status,kind==='unavailable'?503:403);assert.equal(h.exchanges,0);assert.equal(h.connections.length,0);assert.equal(h.audits.length,0);assert.equal(result.text.includes('private storage detail'),false);});
});
test('a credential change during token exchange fences the connection transaction',async()=>fixture(async h=>{
 const nonce=await h.connect();h.revokeAfterExchange=true;const result=await h.callback(nonce);assert.match(result.text,/qbo_error/);assert.equal(h.exchanges,1);assert.equal(h.connections.length,0);assert.equal(h.audits.length,0);assert.equal(h.userWrites,0);assert.equal(h.ended,1);
}));
test('current nonce can connect while replay cannot exchange again',async()=>fixture(async h=>{
 const nonce=await h.connect(),result=await h.callback(nonce);assert.match(result.text,/qbo_connected/);assert.equal(h.exchanges,1);assert.equal(h.connections.length,1);assert.equal(h.userWrites,1);assert.equal(h.audits.length,1);assert.equal(h.ended,1);assert.equal((await h.callback(nonce)).status,403);assert.equal(h.exchanges,1);
}));
