'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),jwt=require('jsonwebtoken');
const config=require('../src/config');config.qbo.environment='sandbox';
const {fixture,scope,ownerId,actorId}=require('./helpers/period-close-fixture');
const {createCompanyScope}=require('../src/middleware/companyScope');
const {createPeriodCloseRouter}=require('../src/routes/period-close');
const {createAuditRouter}=require('../src/routes/audit');
const {createExploreRouter}=require('../src/routes/explore');
const C=require('../src/modules/period-close-contract');
async function server(work){
  const h=fixture(),app=express();app.use(express.json());
  for(const model of Object.values(h.models)){
    for(const name of ['find','findOne']){const original=model[name];model[name]=(...args)=>{const q=original(...args);q.skip=()=>q;q.populate=field=>{const fetch=q.fetch;q.fetch=async()=>{const result=await fetch.call(q);for(const row of Array.isArray(result)?result:[result])if(row && row[field]!=null)row[field]={_id:String(row[field]),displayName:'Fixture Owner'};return result;};return q;};return q;};}
    model.findById=id=>model.findOne({_id:id});
  }
  h.models.Audits.countDocuments=async()=>h.data.Audits.length;
  app.use(createCompanyScope({databaseReady:()=>true,hasOwnActiveConnection:async id=>id===ownerId,memberRealms:async id=>h.data.Memberships.filter(row=>row.userId===id&&row.status==='active').map(row=>row.realmId),activeConnectionFor:async realms=>h.data.Connections.find(row=>realms.includes(row.realmId)&&row.status==='active')}));
  let loseSave=false,loseCancel=false;
  const service={...h.service,apply:async(...args)=>{const result=await h.service.apply(...args);if(loseSave){loseSave=false;throw Error('Fixture lost HTTP acknowledgement');}return result;},cancel:async(...args)=>{const result=await h.service.cancel(...args);if(loseCancel){loseCancel=false;throw Error('Fixture lost cancellation HTTP acknowledgement');}return result;}};
  app.use('/period',createPeriodCloseRouter({service:()=>service}));app.use('/audit',createAuditRouter({Connection:h.models.Connections,AuditLog:h.models.Audits}));app.use('/explore',createExploreRouter({Audits:h.models.Audits,getActiveConnection:async()=>h.data.Connections[0],qboFor:async()=>{throw Error('Unexpected Explorer accounting request');}}));
  const listener=app.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));
  const call=async(path,body,actor=ownerId)=>{const response=await fetch('http://127.0.0.1:'+listener.address().port+path,{method:body===undefined?'GET':'POST',headers:{...(actor?{Authorization:'Bearer '+jwt.sign({id:actor,role:'agent'},config.jwtSecret)}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};};
  try{await work({h,call,loseSave:()=>loseSave=true,loseCancel:()=>loseCancel=true});}finally{listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}
}
test('actual scoped HTTP routes read no QBO on open and apply an exact retained manual close',async()=>server(async({h,call})=>{
  const first=await call('/period');assert.equal(first.status,200);assert.equal(first.cache,'no-store');assert.equal(h.events.length,0);assert.equal(first.body.data.qboReads,0);
  const request=await h.make(),review=await call('/period/review',{request});assert.equal(review.status,200,JSON.stringify(review.body));assert.equal(review.body.data.review.reportChecks.length,13);
  const input={request,reviewHash:review.body.data.reviewHash},saved=await call('/period/apply',input);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.data.current,true);assert.equal((await call('/period/'+saved.body.data.id)).body.data.decision.input.request.reason,request.reason);assert.equal(h.posts,0);
}));
test('actual period routes deny absent auth, shared owner borrowing and company/query/state overrides',async()=>server(async({h,call})=>{
  assert.equal((await call('/period',undefined,null)).status,401);assert.equal((await call('/period/accounts',{},actorId)).status,403);assert.equal((await call('/period/accounts',{realmId:'999'})).status,400);assert.equal((await call('/period?environment=production')).status,400);assert.equal((await call('/period/accounts?limit=1',{})).status,400);assert.equal((await call('/period/review',{request:{},ownerId})).status,400);assert.equal((await call('/period?after[at]=bad')).status,400);assert.equal(h.events.length,0);
  h.data.Memberships[1].role='reviewer';const read=await call('/period',undefined,actorId);assert.equal(read.status,200);assert.equal(read.body.data.canManage,false);
}));
test('all generic audit/timeline surfaces redact manual bank, book and reopening evidence',async()=>server(async({h,call})=>{
  const request=await h.make(),saved=await h.service.apply(h.user,await h.reviewInput(request)),reopen=h.reopen(),second=await h.service.apply(h.user,await h.reviewInput(reopen));
  for(const path of ['/audit','/audit/'+saved.id,'/audit/'+second.id,'/explore/timeline']){
    const result=await call(path);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(JSON.stringify(result.body).includes(request.bankChecks[0].statementReference),false);assert.equal(JSON.stringify(result.body).includes(reopen.correctionPlan),false);
    const rows=(result.body.logs||result.body.entries||[result.body.entry]).filter(row=>row.action===C.ACTION);assert.ok(rows.length);for(const row of rows){assert.equal(row.afterState,undefined);assert.equal(row.periodEvidence.details,'/company/period-close');}
  }
}));
test('lost HTTP save and cancellation acknowledgements retain exact terminal decisions without reopening or duplicate applies',async()=>server(async({h,call,loseSave,loseCancel})=>{
  const request=await h.make(),input=await h.reviewInput(request);loseSave();const lost=await call('/period/apply',input);assert.equal(lost.status,500);assert.equal(JSON.stringify(lost.body).includes(request.bankChecks[0].statementReference),false);
  const retried=await call('/period/apply',input);assert.equal(retried.status,200);assert.equal(retried.body.data.reused,true);assert.equal(h.data.Audits.filter(row=>row.action===C.ACTION).length,1);
  const another=h.reopen(),pending=await h.reviewInput(another);loseCancel();assert.equal((await call('/period/cancel',{input:pending,reason:'Fixture owner cancels this exact unconfirmed reopening decision.'})).status,500);
  const final=await call('/period/apply',pending);assert.equal(final.status,200);assert.equal(final.body.data.status,'cancelled');assert.equal(h.data.Policies[0].periodControl.closedThrough,'2026-09-30');
}));
test('upstream QBO authorization errors retain actual read count and never expire the app session',async()=>server(async({h,call})=>{
  const original=h.client.oauthClient.axiosInstance;h.client.oauthClient.axiosInstance=async(url,options)=>{await original(url,options);return{status:401,statusText:'Fixture denied',headers:{intuit_tid:'fixture-close-trace'},data:{Fault:{Error:[{Message:'Fixture upstream refused'}]}}};};const result=await call('/period/accounts',{});assert.equal(result.status,502);assert.equal(result.body.qboStatus,401);assert.equal(result.body.readAttempts,1);assert.equal(h.events.length,1);assert.equal(h.data.Audits.length,0);
}));
