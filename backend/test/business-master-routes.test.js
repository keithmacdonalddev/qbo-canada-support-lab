'use strict';
process.env.QBO_ENVIRONMENT='production';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),jwt=require('jsonwebtoken');
const {fixture,scope,ownerId}=require('./helpers/master-service-fixture');
const {createCompanyScope}=require('../src/middleware/companyScope');
const {createMasterPreparationRouter}=require('../src/routes/business-master-preparation');
const {masterProgressHash}=require('../src/modules/business-master-receipt');
const config=require('../src/config');
const memberId='a'.repeat(24);
async function server(t,work){
 const h=fixture(t);h.data.Users.push({_id:memberId,role:'agent'});h.data.Memberships.push({_id:'member',userId:memberId,realmId:scope.realmId,status:'active',role:'operator',permissionOverrides:[]});
 const app=express();app.use(express.json());app.use(createCompanyScope({databaseReady:()=>true,hasOwnActiveConnection:async id=>id===ownerId,memberRealms:async id=>h.data.Memberships.filter(row=>row.userId===id&&row.status==='active').map(row=>row.realmId),activeConnectionFor:async realms=>h.data.Connections.find(row=>realms.includes(row.realmId)&&row.status==='active')}));app.use('/masters',createMasterPreparationRouter({service:()=>h.service}));
 const listener=app.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));
 const call=async(path,body,actor=ownerId)=>{const response=await fetch('http://127.0.0.1:'+listener.address().port+'/masters'+path,{method:body===undefined?'GET':'POST',headers:{...(actor?{Authorization:'Bearer '+jwt.sign({id:actor,role:'agent'},config.jwtSecret)}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};};
 try{await work({h,call});}finally{await h.service.idle();h.service.close();listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}
}
test('authenticated owner routes prepare, explicitly approve, execute and apply a complete exact role set',async t=>server(t,async({h,call})=>{
 const prepared=await call('/prepare',h.body);assert.equal(prepared.status,200,JSON.stringify(prepared.body));assert.equal(prepared.cache,'no-store');const run=prepared.body.data.run;assert.equal(run.entries.length,32);assert.equal(h.sent.length,0);
 const production={planHash:run.planHash,productionConfirmed:true};assert.equal((await call('/'+run.id+'/approve',{...production,productionConfirmed:false})).status,409);assert.equal((await call('/'+run.id+'/approve',production)).status,200);assert.equal(h.sent.length,0);
 const request={planHash:run.planHash,reviewHash:masterProgressHash(h.run()),resume:false},started=await call('/'+run.id+'/execute',request);assert.equal(started.status,202,JSON.stringify(started.body));assert.equal(started.body.data.workerClaimed,true);await h.service.idle();
 const completed=await call('/'+run.id);assert.equal(completed.status,200);assert.equal(completed.body.data.run.counts.verifiedRecords,32);assert.equal('qboWrites' in completed.body.data.run,false);assert.equal((await call('/'+run.id+'/execute',request)).status,200);assert.equal(h.sent.length,32);
 const ordinals=completed.body.data.run.records.map(row=>row.ordinal),review=await call('/'+run.id+'/apply-review',{ordinals});assert.equal(review.status,200,JSON.stringify(review.body));const input={ordinals,reviewHash:review.body.data.review.reviewHash,requestKey:'30000000-0000-0000-0000-000000000001'},applied=await call('/'+run.id+'/apply',input);assert.equal(applied.status,200,JSON.stringify(applied.body));assert.equal(applied.body.data.draft.version,2);assert.equal(applied.body.data.run.claim,'closed');assert.equal((await call('/'+run.id+'/apply',input)).body.data.reused,true);assert.equal(h.sent.length,32);
}));
test('normal routes reject absent authentication, non-owner writes and context/proof overrides',async t=>server(t,async({h,call})=>{
 assert.equal((await call('',undefined,null)).status,401);assert.equal((await call('?environment=sandbox')).status,400);assert.equal((await call('/prepare',{...h.body,realmId:'999'})).status,400);assert.equal((await call('/prepare',{...h.body,payload:{}})).status,400);assert.equal((await call('/storage/preview',{} ,memberId)).status,403);assert.equal((await call('/prepare',h.body,memberId)).status,403);assert.equal(h.data.MasterRuns.length,0);assert.equal(h.sent.length,0);
 const prepared=await call('/prepare',h.body),run=prepared.body.data.run;const readonly=h.data.Memberships.find(row=>row.userId===memberId);readonly.role='reviewer';readonly.permissionOverrides=['qbo_data.read'];const status=await call('',undefined,memberId);assert.equal(status.status,200);assert.equal(status.body.data.permissions.owner,false);assert.equal(status.body.data.run.actions.execute,false);
 for(const[path,body]of [['approve',{planHash:run.planHash,productionConfirmed:true}],['execute',{planHash:run.planHash,reviewHash:run.progressHash,resume:false}],['stop',{}],['retain',{planHash:run.planHash,reviewHash:run.progressHash,confirmRetain:true}],['apply-review',{ordinals:[0]}]])assert.equal((await call('/'+run.id+'/'+path,body,memberId)).status,403,path);
 assert.equal((await call('/'+run.id+'/apply-review',{ordinals:[0],proofs:[]})).status,400);assert.equal((await call('/'+run.id+'/approve',{planHash:run.planHash,productionConfirmed:'true'})).status,400);assert.equal((await call('/storage/apply',{planHash:'c'.repeat(64),ownerId})).status,400);assert.equal(h.setups.length,0);assert.equal(h.sent.length,0);
}));
test('QBO authorization errors map to upstream failure and never expire the app session',async t=>server(t,async({h,call})=>{
 const original=h.onGET;h.onGET=async opts=>{if(/FROM CompanyInfo/.test(new URL(opts.url).searchParams.get('query')||''))return{status:401,json:{Fault:{Error:[{Message:'Fixture QuickBooks reconnect required.'}]}}};return original(opts);};
 const result=await call('/prepare',h.body);assert.equal(result.status,502,JSON.stringify(result.body));assert.equal(result.body.qboStatus,401);assert.equal(h.data.MasterRuns.length,0);assert.equal(h.sent.length,0);
}));
test('owned background claim refusal returns saved state without an execution acknowledgement',async t=>server(t,async({h,call})=>{
 const prepared=await call('/prepare',h.body),run=prepared.body.data.run;await call('/'+run.id+'/approve',{planHash:run.planHash,productionConfirmed:true});h.busyCollection='generationruns';
 const result=await call('/'+run.id+'/execute',{planHash:run.planHash,reviewHash:masterProgressHash(h.run()),resume:false});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.workerClaimed,false);assert.equal(h.sent.length,0);assert.equal(h.run().leaseToken,null);assert.equal((await call('')).body.data.lastWorkerResult.failure.code,'claim');
}));
test('storage actions expose only the exact separate preview and apply contracts',async t=>server(t,async({h,call})=>{
 h.unprepared=true;assert.equal((await call('')).body.data.storage.ready,false);const preview=await call('/storage/preview',{});assert.equal(preview.status,200);assert.equal(preview.body.data.preview.qboWrites,0);assert.equal((await call('/storage/apply',{planHash:preview.body.data.preview.planHash})).status,200);assert.equal(h.setups.length,2);assert.equal(h.data.MasterRuns.length,0);assert.equal(h.sent.length,0);
}));
