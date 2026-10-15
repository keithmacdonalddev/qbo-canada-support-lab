'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),jwt=require('jsonwebtoken'),express=require('express');
const {createApp}=require('../src/app');
const {createCompanyScope}=require('../src/middleware/companyScope');
const {authenticate,requireRole}=require('../src/middleware/auth');
const {issueToken,ISSUER,AUDIENCE,MAX_LIFETIME,validateStartupSecurity}=require('../src/modules/auth-token');
const {accountEligible,RESERVED_EMAIL,publicTesterAttempt}=require('../src/modules/account-policy');
const config=require('../src/config');
const owner='b'.repeat(24),actor='c'.repeat(24);
async function fixture(work){
 const users=new Map([[owner,{_id:owner,email:'owner@fixture.invalid',role:'agent',authVersion:0}],[actor,{_id:actor,email:'member@fixture.invalid',role:'agent',authVersion:0}]]),h={users,lookups:0,unavailable:false};
 const scope=createCompanyScope({databaseReady:()=>true,hasOwnActiveConnection:async id=>id===owner,memberRealms:async()=>['123'],activeConnectionFor:async()=>({userId:owner,realmId:'123'})});
 const app=createApp({databaseReady:()=>true,rebuildRouter:express.Router(),companyScope:scope,currentAccount:{loadAccount:async id=>{h.lookups++;if(h.unavailable)throw Error('Fixture private storage detail');return users.get(id)||null;}}});
 app.get('/api/company/account-fixture',authenticate,(req,res)=>res.json({id:req.user.id,actorId:req.user.actorId,role:req.user.role}));
 app.get('/api/account-fixture',authenticate,(req,res)=>res.json({id:req.user.id,role:req.user.role}));
 app.get('/api/supervisor-fixture',authenticate,requireRole('supervisor'),(_req,res)=>res.json({ok:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 h.call=async(path,{token=issueToken(users.get(actor)),method='GET',origin,body}={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:response.status,data,allowOrigin:response.headers.get('access-control-allow-origin')};};
 try{await work(h);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
const token=(payload,options={})=>jwt.sign({id:actor,av:0,...payload},config.jwtSecret,{algorithm:'HS256',issuer:ISSUER,audience:AUDIENCE,expiresIn:3600,...options});
test('default app uses current role and keeps the personal actor distinct from company owner',async()=>fixture(async h=>{
 const forgedRole=token({role:'supervisor'});assert.deepEqual((await h.call('/account-fixture',{token:forgedRole})).data,{id:actor,role:'agent'});assert.equal((await h.call('/supervisor-fixture',{token:forgedRole})).status,403);assert.deepEqual((await h.call('/company/account-fixture',{token:forgedRole})).data,{id:owner,actorId:actor,role:'agent'});
 h.users.get(actor).role='supervisor';assert.equal((await h.call('/supervisor-fixture',{token:forgedRole})).status,200);h.users.delete(owner);assert.equal((await h.call('/company/account-fixture',{token:forgedRole})).status,403);
}));
test('revoked/deleted/current-account storage failures do not fall back to JWT claims',async()=>fixture(async h=>{
 const saved=token({role:'supervisor'});h.users.get(actor).authVersion=1;assert.equal((await h.call('/account-fixture',{token:saved})).status,401);h.users.get(actor).authVersion=0;h.unavailable=true;const unavailable=await h.call('/account-fixture',{token:saved});assert.equal(unavailable.status,503);assert.equal(JSON.stringify(unavailable).includes('private storage'),false);h.unavailable=false;h.users.delete(actor);assert.equal((await h.call('/account-fixture',{token:saved})).status,401);
}));
test('historical reserved access and sessions stay blocked; recovered private sign-in remains separate from automation',async()=>fixture(async h=>{
 const legacy=h.users.get(actor);legacy.email=RESERVED_EMAIL;legacy.role='supervisor';const old=token({role:'supervisor'});assert.equal((await h.call('/account-fixture',{token:old})).status,401);assert.equal(publicTesterAttempt(' TESTER@testdatalab.local ','test-data-lab'),true);
 legacy.authVersion=1;legacy.accessPolicyVersion=1;assert.equal(accountEligible(legacy),true);assert.equal(accountEligible(legacy,{automation:true}),false);assert.equal((await h.call('/account-fixture',{token:old})).status,401);assert.equal((await h.call('/account-fixture',{token:issueToken(legacy)})).status,200);
}));
test('exact capability exceptions and approved preflight work without database sessions; other origins and MCP descendants do not',async()=>fixture(async h=>{
 const before=h.lookups;assert.equal((await h.call('/health',{token:null,origin:'http://localhost:5173'})).status,200);assert.equal((await h.call('/health',{token:null,origin:'https://unapproved.invalid'})).status,403);assert.equal((await h.call('/account-fixture',{token:null,method:'OPTIONS',origin:'http://localhost:5173'})).status,204);assert.equal(h.lookups,before);
 const extension='chrome-extension://'+'a'.repeat(32);assert.equal((await h.call('/screen-reader/capability',{token:null,method:'POST',origin:extension,body:{stage:'redeem',nonce:'missing'}})).status,404);assert.equal((await h.call('/health',{token:null,origin:extension})).status,403);assert.equal((await h.call('/ai-tools/mcp',{token:null})).status,405);assert.equal((await h.call('/ai-tools/mcp/child',{token:null})).status,401);assert.equal((await h.call('/qbo/callback?state=missing',{token:null})).status,403);
}));
test('bounded session claims reject wrong algorithm, issuer, audience, missing time and excess lifetime',async()=>fixture(async h=>{
 const now=Math.floor(Date.now()/1000),variants=[token({}, {algorithm:'HS384'}),token({}, {issuer:'other'}),token({}, {audience:'other'}),token({}, {expiresIn:MAX_LIFETIME+1}),jwt.sign({id:actor,av:0,exp:now+60},config.jwtSecret,{algorithm:'HS256',issuer:ISSUER,audience:AUDIENCE,noTimestamp:true}),token({id:'invalid'}),token({av:0.5})];
 for(const value of variants)assert.equal((await h.call('/account-fixture',{token:value})).status,401);assert.equal(h.lookups,0);
}));
test('startup refuses missing/private-key policy and invalid duration before database startup',()=>{
 const security=config.security.privateJwtConfigured,expiry=config.jwtExpiresIn;try{config.security.privateJwtConfigured=false;assert.throws(validateStartupSecurity,/private JWT_SECRET/);config.security.privateJwtConfigured=true;config.jwtExpiresIn='8d';assert.throws(validateStartupSecurity,/at most seven days/);}finally{config.security.privateJwtConfigured=security;config.jwtExpiresIn=expiry;}
});
