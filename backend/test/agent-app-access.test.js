'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),vm=require('node:vm');
const mod=require('../src/modules/agent-app-access'),config=require('../src/config');
const {issueToken,verifyToken}=require('../src/modules/auth-token');
const {createCurrentAccountGuard}=require('../src/middleware/currentAccount');
const {createAuthRouter}=require('../src/routes/auth');
const User=require('../src/models/User');
const helper=require('../../scripts/security/app-agent-login.cjs');
const id='b'.repeat(24),realm='9130357222392856',environment=config.qbo.environment;
function fixture(){
 const h={user:{_id:id,email:'private@fixture.invalid',password:'private-owner-hash',role:'agent',authVersion:0,connectionSwitchVersion:0,automationAccessPolicyVersion:7},
  connection:{_id:'c'.repeat(24),userId:id,realmId:realm,status:'active'},audits:[],failAudit:false};
 const query=value=>({select(){return this;},sort(){return this;},maxTimeMS(){return this;},session(){return this;},lean:async()=>structuredClone(value),then:(yes,no)=>Promise.resolve(value?new User(value):null).then(yes,no)});
 h.Users={findById:()=>query(h.user),updateOne:async(filter,update)=>{
   if(!h.user||String(filter._id)!==String(h.user._id)||(filter.agentCredentialId&&filter.agentCredentialId!==h.user.agentCredentialId))return{matchedCount:0};
   Object.assign(h.user,update.$set||{});for(const k of Object.keys(update.$unset||{}))delete h.user[k];return{matchedCount:1};}};
 h.Connections={findOne:filter=>query(h.connection?.status===filter.status?h.connection:null),updateOne:async()=>({matchedCount:h.connection?.status==='active'?1:0})};
 h.Audits={create:async v=>{if(h.failAudit)throw Error('Private audit error');h.audits.push(...(Array.isArray(v)?v:[v]));}};
 h.service=mod.createAgentAccess({Users:h.Users,Connections:h.Connections,Audits:h.Audits,environment,
  transaction:async fn=>{const before=structuredClone({user:h.user,audits:h.audits});try{return await fn({});}catch(e){h.user=before.user;h.audits=before.audits;throw e;}}});
 h.credential=mod.newCredential();
 h.enroll=()=>h.service.enroll({accountId:id,realmId:realm,credential:h.credential});
 h.input=()=>({accountId:id,...h.credential,actor:'codex-fixture'});
 return h;
}
async function httpFixture(h,work){
 const app=express();app.use(express.json());app.use('/api',createCurrentAccountGuard({loadAccount:async()=>h.user,loadConnection:async()=>h.connection}));
 app.use('/api/auth',createAuthRouter({Users:h.Users,agentAccess:()=>h.service}));
 app.get('/api/check',(req,res)=>res.json({id:req.user.id,role:req.user.role}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=async(p,{token,body,origin}={})=>{
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/api'+p,{method:body?'POST':'GET',headers:{
   ...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return{status:r.status,data:await r.json(),cache:r.headers.get('cache-control')};
 };
 try{await work(call);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
test('enrollment preserves owner password, account authority, automation and memberships; audits contain no secret/hash',async()=>{
 const h=fixture(),before=structuredClone(h.user);await h.enroll();
 for(const [k,v]of Object.entries(before))assert.deepEqual(h.user[k],v);
 assert.equal(h.user.agentCredentialId,h.credential.credentialId);assert.notEqual(h.user.agentCredentialHash,h.credential.secret);
 assert.equal(mod.matches(h.user,h.credential),true);assert.equal(h.audits.length,1);
 const audit=JSON.stringify(h.audits);assert.equal(audit.includes(h.credential.secret),false);assert.equal(audit.includes(h.user.agentCredentialHash),false);
 await assert.rejects(h.enroll(),/already exists/);
});
test('audit failure rolls enrollment back without replacing owner authority',async()=>{
 const h=fixture(),before=structuredClone(h.user);h.failAudit=true;await assert.rejects(h.enroll(),/audit/);
 assert.deepEqual(h.user,before);assert.equal(h.audits.length,0);
});
test('enrollment requires eligible existing owner and exact active company',async()=>{
 const h=fixture();h.connection.realmId='123456789';await assert.rejects(h.enroll(),/company/);
 h.connection.realmId=realm;h.user.email='tester@testdatalab.local';await assert.rejects(h.enroll(),/private app access/);
 assert.equal(h.user.agentCredentialId,undefined);
});
test('credential exchange uses normal tokens and hides every agent field in user JSON',async()=>{
 const h=fixture();await h.enroll();const result=await h.service.login(h.input());const claims=verifyToken(result.token);
 assert.equal(claims.id,id);assert.deepEqual(claims.agent,mod.binding(h.user));assert.equal(claims.av,0);
 for(const k of Object.keys(result.user))assert.equal(k.startsWith('agentCredential'),false);
 assert.equal(JSON.stringify(result.user).includes(h.credential.secret),false);
});
test('wrong/malformed secret and account recovery cannot renew an agent session',async()=>{
 const h=fixture();await h.enroll();
 for(const changes of [{secret:'A'.repeat(43)},{secret:{}},{credentialId:'invalid'},{accountId:'invalid'},{actor:'bad actor'}])await assert.rejects(h.service.login({...h.input(),...changes}));
 h.user.authVersion=1;await assert.rejects(h.service.login(h.input()));assert.equal(h.user.password,'private-owner-hash');
});
test('agent route is reachable without a prior JWT but requires valid private credential; errors and responses are no-store',async()=>{
 const h=fixture();await h.enroll();await httpFixture(h,async call=>{
  const bad=await call('/auth/agent-login',{body:{}});assert.equal(bad.status,401);assert.equal(bad.cache,'no-store');
  const good=await call('/auth/agent-login',{body:h.input()});assert.equal(good.status,200);assert.equal(good.cache,'no-store');
  assert.equal((await call('/check',{token:good.data.token})).status,200);
  h.failAudit=true;const failed=await call('/auth/agent-login',{body:h.input()});assert.equal(failed.status,503);assert.equal(JSON.stringify(failed).includes('Private audit'),false);
 });
});
test('credential rotation/revocation stops issued agent sessions while ordinary owner sessions remain valid',async()=>{
 const h=fixture();await h.enroll();const agent=(await h.service.login(h.input())).token,owner=issueToken(h.user);
 await httpFixture(h,async call=>{
  assert.equal((await call('/check',{token:agent})).status,200);
  h.user.agentCredentialId=mod.newCredential().credentialId;assert.equal((await call('/check',{token:agent})).status,401);
  assert.equal((await call('/check',{token:owner})).status,200);
  h.user.agentCredentialId=h.credential.credentialId;await h.service.revoke({accountId:id,credentialId:h.credential.credentialId});
  assert.equal((await call('/check',{token:agent})).status,401);assert.equal((await call('/check',{token:owner})).status,200);
  await assert.rejects(h.service.login(h.input()));
 });
});
test('agent sessions fail closed on company switch or connection loss',async()=>{
 const h=fixture();await h.enroll();const agent=(await h.service.login(h.input())).token;
 await httpFixture(h,async call=>{
  h.connection.realmId='123456789';assert.equal((await call('/check',{token:agent})).status,401);await assert.rejects(h.service.login(h.input()));
  h.connection.realmId=realm;h.connection._id='d'.repeat(24);assert.equal((await call('/check',{token:agent})).status,401);await assert.rejects(h.service.login(h.input()));
 });
});
test('optional malformed agent binding is rejected by session validation',()=>{
 const h=fixture();assert.throws(()=>issueToken(h.user,{agent:{credentialId:'wrong'}}),/binding/);
});
test('helper accepts owned sessions and app paths; refuses credential argv, QBO sessions and external routes',()=>{
 for(const argv of [['login','--secret','x'],['login','--session','qbo-ops'],['login','--session','default'],['login','--path','//evil.invalid'],['login','--path','/company/bank?token=x']])assert.throws(()=>helper.argumentsFor(argv));
 assert.equal(helper.argumentsFor(['login','--session','bank1-proof','--path','/company/bank']).session,'bank1-proof');
});
async function runPage({origin='http://localhost:5173',company=realm,rejectRedirect=false}={}){
 let saved=null,calls=0;const context={location:{origin,pathname:'/login'},AbortSignal,
  localStorage:{getItem:()=>null,setItem:(k,v)=>{saved={k,v};}},fetch:async(url,options)=>{
   calls++;assert.equal(options.redirect,'error');if(rejectRedirect)throw Error('redirect');
   const data=url.endsWith('agent-login')?{token:'fixture-server-session',user:{_id:id}}:url.endsWith('/me')?{user:{_id:id}}:{environment,realmId:company};
   return{ok:true,json:async()=>data};
  }};
 context.window=context;context.top=context;vm.createContext(context);
 const payload={origin:'http://localhost:5173',accountId:id,realmId:realm,environment,credentialId:mod.newCredential().credentialId,secret:'A'.repeat(43),actor:'fixture'};
 const work=vm.runInContext('('+helper.browserPageLogin.toString()+')('+JSON.stringify(payload)+')',context);
 return{work,get saved(){return saved;},get calls(){return calls;}};
}
test('private page exchange refuses origin changes, redirect and company mismatch before storing a session',async()=>{
 for(const options of [{origin:'https://evil.invalid'},{company:'123456789'},{rejectRedirect:true}]){
  const h=await runPage(options);await assert.rejects(h.work);assert.equal(h.saved,null);if(options.origin)assert.equal(h.calls,0);
 }
 const h=await runPage();assert.deepEqual(JSON.parse(JSON.stringify(await h.work)),{authenticated:true,accountMatches:true,companyMatches:true,sessionReused:false});
 assert.deepEqual(h.saved,{k:'token',v:'fixture-server-session'});
});

test('QBO token expiry does not revoke app login or prevent agent settings access',async()=>{
 const h=fixture();await h.enroll();h.connection.status='expired';
 const agent=(await h.service.login(h.input())).token;await httpFixture(h,async call=>assert.equal((await call('/check',{token:agent})).status,200));
});

test('ordinary bookkeeping write-fence advances do not revoke agent credentials or sessions',async()=>{
 const h=fixture();await h.enroll();const agent=(await h.service.login(h.input())).token;h.user.connectionSwitchVersion+=20;
 assert.equal((await h.service.login(h.input())).user._id.toString(),id);await httpFixture(h,async call=>assert.equal((await call('/check',{token:agent})).status,200));
});
