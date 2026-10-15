'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { QBOClient } = require('../src/modules/qbo-client');
const { freezeWriteRequest, withBusinessWritePermit, consumeBusinessWritePermit } = require('../src/modules/qbo-write-contract');
const { hash } = require('../src/modules/business-calendar');
const config = require('../src/config');
function fixture() {
  const h = {calls:[],admissions:0,preparations:[],failures:[],sleeps:[],controller:new AbortController()};
  h.client = Object.create(QBOClient.prototype);
  Object.assign(h.client,{realmId:'123',connection:{_id:'a'.repeat(24),userId:'b'.repeat(24),realmId:'123',status:'active'},_requestLog:[],_windowMs:60000,_retryAfterUntil:0,ensureFreshToken:async options=>{h.preparations.push(options);if(h.prepare)await h.prepare();},_sleep:async ms=>{h.sleeps.push(ms);},oauthClient:{makeApiCall:async options=>{h.calls.push(options);return h.reply?h.reply(options):{status:200,json:{QueryResponse:{}}};}}});
  h.control={signal:h.controller.signal,beforeAttempt:async()=>{h.admissions++;if(h.before)await h.before();},onFailure:error=>{h.failures.push(error);}};
  h.read=()=>h.client.apiCall('GET','reports/TrialBalance',undefined,0,0,h.control);
  return h;
}
async function quiet(work) { const error=console.error,warn=console.warn;console.error=()=>{};console.warn=()=>{};try{return await work();}finally{console.error=error;console.warn=warn;} }
test('controlled GET and SELECT each enter the original SDK once with maxRetries one',async()=>{
 const h=fixture();await h.read();await h.client.query('SELECT * FROM Account MAXRESULTS 1',h.control);
 assert.equal(h.calls.length,2);assert.equal(h.admissions,2);assert.equal(h.preparations.length,2);assert.ok(h.calls.every(options=>options.method==='GET'&&options.maxRetries===1));assert.deepEqual(h.failures,[]);
});
test('controlled authorization and rate-limit failures stop without force-refresh or backoff',async()=>quiet(async()=>{
 for(const status of [401,429]){const h=fixture();h.reply=()=>({status,headers:{intuit_tid:'fixture-read-trace','retry-after':'60'},json:{Fault:{Error:[{Message:'Fixture bounded refusal'}]}}});
  await assert.rejects(h.read(),error=>error.status===status&&error.intuit_tid==='fixture-read-trace'&&error.qboStage==='api');
  assert.equal(h.calls.length,1);assert.equal(h.preparations.length,1);assert.equal(h.admissions,1);assert.equal(h.failures.length,1);assert.deepEqual(h.sleeps,[]);
 }
}));
test('existing uncontrolled401 and429 retry behavior remains unchanged',async()=>quiet(async()=>{
 const auth=fixture();auth.reply=()=>({status:auth.calls.length===1?401:200,json:{QueryResponse:{}}});await auth.client.apiCall('GET','query');assert.equal(auth.calls.length,2);assert.equal(auth.preparations.filter(value=>value?.force).length,1);assert.ok(auth.calls.every(options=>options.maxRetries===undefined));
 // Completing the simulated wait must also expire the rate window.
 const rate=fixture();rate.client._sleep=async ms=>{rate.sleeps.push(ms);rate.client._retryAfterUntil=0;};rate.reply=()=>({status:429,headers:{'retry-after':'999999'},json:{}});await assert.rejects(rate.client.apiCall('GET','query'),{status:429});assert.equal(rate.calls.length,6);assert.deepEqual(rate.sleeps,Array(5).fill(60000));
}));
test('malformed controls and all controlled mutation methods fail before token or transport work',async()=>{
 for(const control of [null,{}, {signal:{aborted:false},beforeAttempt:()=>{},onFailure:()=>{}},{signal:new AbortController().signal,beforeAttempt:'invalid',onFailure:()=>{}},{signal:new AbortController().signal,beforeAttempt:()=>{},onFailure:()=>{},retry:true}]){const h=fixture();await assert.rejects(h.client.apiCall('GET','query',undefined,0,0,control),TypeError);assert.equal(h.preparations.length,0);assert.equal(h.calls.length,0);}
 for(const method of ['POST','PUT','PATCH','DELETE']){const h=fixture();await assert.rejects(h.client.apiCall(method,'invoice',{Id:'1'},0,0,h.control),TypeError);assert.equal(h.preparations.length,0);assert.equal(h.calls.length,0);}
});
test('rejecting read controls on a write does not consume its inherited dispatch permission',async()=>{
 const h=fixture(),scope={environment:config.qbo.environment,realmId:'123',connectionId:'a'.repeat(24)},request=freezeWriteRequest(scope,'POST','invoice',{CustomerRef:{value:'1'}}),permit={scope,operationId:'c'.repeat(24),logicalKey:hash('logical'),dispatchKey:hash('dispatch'),requestHash:request.requestHash,dispatchRevision:1,stepLeaseToken:'fixture-lease'};
 await withBusinessWritePermit(permit,async()=>{await assert.rejects(h.client.apiCall('POST','invoice',{CustomerRef:{value:'1'}},0,0,h.control),TypeError);assert.equal(consumeBusinessWritePermit().requestHash,request.requestHash);});assert.equal(h.calls.length,0);
});
test('control values are snapshotted before token preparation',async()=>{
 const h=fixture();h.prepare=async()=>{h.control.beforeAttempt=()=>{throw Error('Changed callback was not snapshotted');};};await h.read();assert.equal(h.admissions,1);assert.equal(h.calls.length,1);
});
test('revocation at the admission callback preserves local status and never enters SDK',async()=>{
 const h=fixture(),denied=Object.assign(Error('Fixture permission revoked'),{status:403,code:'BUSINESS_ACCESS_DENIED'});h.before=async()=>{throw denied;};await assert.rejects(h.read(),error=>error===denied&&error.qboStage===undefined);assert.equal(h.calls.length,0);assert.equal(h.failures[0],denied);
});
test('abort before or at a completed admission never enters SDK',async()=>{
 const before=fixture();before.controller.abort();await assert.rejects(before.read(),{code:'QBO_READ_CANCELLED'});assert.equal(before.preparations.length,0);
 const during=fixture();during.before=async()=>during.controller.abort();await assert.rejects(during.read(),{code:'QBO_READ_CANCELLED'});assert.equal(during.calls.length,0);
});
test('cancelling a previously active rate window does not leave a delayed accounting request', {timeout:5000},async()=>{
 const h=fixture();h.client._retryAfterUntil=Date.now()+60000;const result=h.read();setImmediate(()=>h.controller.abort());await assert.rejects(result,{code:'QBO_READ_CANCELLED'});assert.equal(h.calls.length,0);assert.equal(h.admissions,0);assert.deepEqual(h.sleeps,[]);
});
test('already-started token persistence settles even when its accounting read was cancelled',async()=>{
 const h=fixture();let started,release,persisted=false;const began=new Promise(resolve=>{started=resolve;}),held=new Promise(resolve=>{release=resolve;});h.prepare=async()=>{started();await held;persisted=true;};
 const result=h.read();await began;h.controller.abort();release();await assert.rejects(result,{code:'QBO_READ_CANCELLED'});assert.equal(persisted,true);assert.equal(h.calls.length,0);
});
test('late successful SDK responses are discarded after cancellation',async()=>{
 const h=fixture();let entered,release;const began=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});h.reply=async()=>{entered();await held;return{status:200,json:{QueryResponse:{}}};};const result=h.read();await began;h.controller.abort();release();await assert.rejects(result,{code:'QBO_READ_CANCELLED'});assert.equal(h.calls.length,1);assert.equal(h.failures.length,1);
});
test('failure callback cannot replace the original upstream failure',async()=>quiet(async()=>{
 const h=fixture();h.reply=()=>({status:401,json:{}});h.control.onFailure=()=>{throw Error('Fixture observer failed');};await assert.rejects(h.read(),{status:401});assert.equal(h.calls.length,1);
}));
test('controlled original SDK reaches axios only once on failure',async()=>quiet(async()=>{
 const h=fixture(),OAuthClient=require('intuit-oauth'),sdk=new OAuthClient({clientId:'fixture-client',clientSecret:'fixture-secret',environment:'sandbox',redirectUri:'http://fixture.invalid'});sdk.log=()=>{};sdk.setToken({access_token:'fixture-token'});let calls=0;sdk.axiosInstance=async()=>{calls++;throw Object.assign(Error('Fixture service unavailable'),{response:{status:503,headers:{intuit_tid:'fixture-503'},data:{Fault:{Error:[{Message:'Fixture upstream failure'}]}}}});};h.client.oauthClient=sdk;await assert.rejects(h.read(),error=>error.status===503);assert.equal(calls,1);assert.equal(h.failures.length,1);
}));
