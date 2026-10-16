'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),jwt=require('jsonwebtoken');
const {fixture,scope,ownerId,actorId}=require('./helpers/report-evidence-fixture');
const {createCompanyScope}=require('../src/middleware/companyScope');
const {createReportEvidenceRouter}=require('../src/routes/report-evidence');
const {createAuditRouter}=require('../src/routes/audit');
const {createExploreRouter}=require('../src/routes/explore');
const config=require('../src/config');
async function server(work){
 const h=fixture(),app=express();app.use(express.json());app.use(createCompanyScope({databaseReady:()=>true,hasOwnActiveConnection:async id=>id===ownerId,memberRealms:async id=>h.data.Memberships.filter(row=>row.userId===id&&row.status==='active').map(row=>row.realmId),activeConnectionFor:async realms=>h.data.Connections.find(row=>realms.includes(row.realmId)&&row.status==='active')}));
 app.use('/evidence',createReportEvidenceRouter({service:()=>h.service}));app.use('/audit',createAuditRouter({Connection:h.models.Connections,AuditLog:h.models.Audits}));app.use('/explore',createExploreRouter({Audits:h.models.Audits,getActiveConnection:async()=>h.data.Connections[0],qboFor:async()=>{throw Error('Unexpected QBO request');}}));
 const listener=app.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));const call=async(path,body,actor=ownerId)=>{const response=await fetch('http://127.0.0.1:'+listener.address().port+path,{method:body===undefined?'GET':'POST',headers:{...(actor?{Authorization:'Bearer '+jwt.sign({id:actor,role:'agent'},config.jwtSecret)}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};};
 try{await work({h,call});}finally{listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}
}
test('authenticated local report routes retain exact source and independent levels with no accounting calls',async()=>server(async({h,call})=>{
 const request=h.request(),initial=await call('/evidence?reportKey='+request.reportKey);assert.equal(initial.status,200);assert.equal(initial.cache,'no-store');assert.equal(initial.body.data.items.length,0);const saved=await call('/evidence',request);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.data.request.source.reference,request.source.reference);assert.equal(saved.body.data.request.checks.reconciliation.status,'not-checked');assert.equal((await call('/evidence/'+saved.body.data.id)).body.data.sourceType,'owner-manual');assert.equal(h.qboCalls,0);
}));
test('report routes reject absent auth, non-owner writes and query/company/state overrides',async()=>server(async({h,call})=>{
 const request=h.request();assert.equal((await call('/evidence?reportKey='+request.reportKey,undefined,null)).status,401);assert.equal((await call('/evidence',request,actorId)).status,403);assert.equal((await call('/evidence',{...request,realmId:'999'})).status,400);assert.equal((await call('/evidence?reportKey='+request.reportKey+'&limit=100000')).status,400);assert.equal((await call('/evidence?environment=production',request)).status,400);assert.equal((await call('/evidence/withdraw',{request,reason:'Owner withdraws this request from the current report screen.'},actorId)).status,403);assert.equal(h.data.Audits.length,0);assert.equal((await call('/evidence?reportKey='+request.reportKey,undefined,actorId)).body.data.canRecord,false);
}));
test('existing audit list/detail and Explorer timeline expose only new event metadata, with source details protected',async()=>server(async({h,call})=>{
 const request=h.request(),saved=await call('/evidence',request);await call('/evidence/withdraw',{request,reason:'Owner withdraws this manual check without changing any accounting record.'});
 const responses=[await call('/audit'),await call('/audit/'+saved.body.data.id),await call('/explore/timeline')];for(const response of responses){assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(JSON.stringify(response.body).includes(request.source.reference),false);const rows=response.body.logs||response.body.entries||[response.body.entry];assert.ok(rows.length);for(const row of rows){assert.equal(row.reportEvidence.details,'/reports');assert.equal(row.afterState,undefined);assert.equal(row.inputParams,undefined);}}
 const full=await call('/evidence/'+saved.body.data.id);assert.equal(full.body.data.request.source.reference,request.source.reference);assert.equal(full.body.data.withdrawn,true);
}));
test('HTTP lost acknowledgements keep durable manual status and exact retries',async()=>server(async({h,call})=>{
 const request=h.request();h.loseReply=true;const lost=await call('/evidence',request);assert.equal(lost.status,500);assert.equal(JSON.stringify(lost.body).includes(request.source.reference),false);const retried=await call('/evidence',request);assert.equal(retried.status,200);assert.equal(retried.body.data.reused,true);assert.equal(h.data.Audits.length,1);h.loseReply=true;assert.equal((await call('/evidence/withdraw',{request,reason:'Owner withdraws this exact manual check after inspecting its source.'})).status,500);const final=await call('/evidence',request);assert.equal(final.body.data.withdrawn,true);assert.equal(h.data.Audits.length,2);assert.equal(h.qboCalls,0);
}));
