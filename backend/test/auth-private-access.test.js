'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {createApp}=require('../src/app');
const {createAuthRouter}=require('../src/routes/auth');
const {issueToken,verifyToken}=require('../src/modules/auth-token');
const id='b'.repeat(24),config=require('../src/config');
async function fixture(work){
 const h={account:{_id:id,email:'private@fixture.invalid',role:'agent',authVersion:0},lookups:0,comparisons:0,created:[]};
 const doc=()=>({...h.account,comparePassword:async value=>{h.comparisons++;return value==='a private fixture passphrase';},toJSON:()=>({_id:id,email:h.account.email,role:h.account.role})});
 const Users={findOne:()=>{h.lookups++;const query=Promise.resolve(doc());query.select=()=>query;return query;},create:async value=>{h.created.push(value);h.account={...h.account,...value};return doc();},findById:async()=>doc()};
 const automation={review:async value=>({id:value,required:true,reviewHash:'a'.repeat(64),groups:[]}),enable:async(value,body)=>({id:value,enabled:body.acknowledgeRetainedWork===true})};
 const app=createApp({authRouter:createAuthRouter({Users,automation:()=>automation}),rebuildRouter:express.Router(),databaseReady:()=>true,currentAccount:{loadAccount:async()=>h.account}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 h.call=async(path,body,token)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/auth/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};};
 try{await work(h);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('public tester credentials never grant access, reset passwords or create/promote accounts',async()=>fixture(async h=>{
 const enabled=config.devAccess.enabled;try{config.devAccess.enabled=true;h.account.email='tester@testdatalab.local';h.account.role='supervisor';const info=await h.call('dev-access');assert.deepEqual(info.data,{enabled:false});assert.equal((await h.call('login',{email:h.account.email,password:'test-data-lab'})).status,401);assert.equal(h.lookups,0);assert.equal((await h.call('login',{email:h.account.email,password:'a private fixture passphrase'})).status,401);assert.equal(h.comparisons,0);assert.equal((await h.call('register',{email:h.account.email,password:'a private fixture passphrase',role:'supervisor'})).status,409);assert.equal(h.created.length,0);h.account.authVersion=1;h.account.accessPolicyVersion=1;const login=await h.call('login',{email:h.account.email,password:'a private fixture passphrase'});assert.equal(login.status,200);assert.equal(verifyToken(login.data.token).av,1);assert.equal((await h.call('login',{email:h.account.email,password:'test-data-lab'})).status,401);}finally{config.devAccess.enabled=enabled;}
}));
test('registration enforces private password length and server-owned roles',async()=>fixture(async h=>{
 for(const password of ['short','é'.repeat(37),{}])assert.equal((await h.call('register',{email:'private@fixture.invalid',password})).status,400);assert.equal(h.created.length,0);
 // This fixture has no matching registered account for the creation path.
 const router=createAuthRouter({Users:{findOne:async()=>null,create:async value=>{h.created.push(value);return{_id:id,...value,toJSON:()=>({_id:id,role:value.role})};}}});const app=express();app.use(express.json());app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));try{const response=await fetch('http://127.0.0.1:'+server.address().port+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:' NEW@fixture.invalid ',password:'a private fixture passphrase',role:'supervisor'})});assert.equal(response.status,201);assert.equal(h.created[0].role,'agent');assert.equal(h.created[0].email,'new@fixture.invalid');}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));
test('account automation routes preserve the signed-in personal account',async()=>fixture(async h=>{
 const token=issueToken(h.account);assert.equal((await h.call('automation-review',null,token)).data.id,id);assert.deepEqual((await h.call('automation-enable',{reviewHash:'a'.repeat(64),acknowledgeRetainedWork:true},token)).data,{id,enabled:true});assert.equal((await h.call('automation-review')).status,401);
}));
test('invalid startup security is rejected before MongoDB connect',async()=>{
 const mongoose=require('mongoose'),oldConnect=mongoose.connect,valid=config.security.privateJwtConfigured;let connections=0;mongoose.connect=async()=>{connections++;throw Error('must not connect');};try{config.security.privateJwtConfigured=false;await assert.rejects(require('../src/server').start(),/private JWT_SECRET/);assert.equal(connections,0);}finally{mongoose.connect=oldConnect;config.security.privateJwtConfigured=valid;}
});
