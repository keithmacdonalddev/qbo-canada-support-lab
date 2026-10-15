'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),jwt=require('jsonwebtoken');
const {fixture,scope,ownerId,actorId}=require('./helpers/business-governance-fixture');
const {createCompanyScope}=require('../src/middleware/companyScope');
const {createBusinessGovernanceRouter}=require('../src/routes/business-governance');
const {createBusinessOperationsRouter}=require('../src/routes/business-operations');
const {createBusinessExecutionService}=require('../src/modules/business-execution-service');
const config=require('../src/config'),previous=config.qbo.environment;test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
async function server(work){
 const h=fixture(),resolveContext=async()=>({environment:scope.environment,connection:{connected:true,...scope,companyName:'Fixture Harbour Business'}}),execution=createBusinessExecutionService({models:h.models,transaction:h.transaction,assertReady:h.assertReady,resolveContext,accessFor:h.accessFor,runtimeFor:input=>h.runtime(input.operationId),now:()=>h.clock});
 const app=express();app.use(express.json());app.use(createCompanyScope({databaseReady:()=>true,hasOwnActiveConnection:async id=>id===ownerId,memberRealms:async id=>h.data.Memberships.filter(row=>row.userId===id&&row.status==='active').map(row=>row.realmId),activeConnectionFor:async realms=>h.data.Connections.find(row=>realms.includes(row.realmId)&&row.status==='active')}));app.use('/governance',createBusinessGovernanceRouter({service:()=>h.service}));app.use('/operations',createBusinessOperationsRouter({service:()=>execution}));
 const listener=app.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));const call=async(path,body,actor=ownerId)=>{const response=await fetch('http://127.0.0.1:'+listener.address().port+path,{method:body===undefined?'GET':'POST',headers:{...(actor?{Authorization:'Bearer '+jwt.sign({id:actor,role:'agent'},config.jwtSecret)}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};};
 try{await work({h,execution,call});}finally{await execution.idle();execution.close();listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}
}
test('authenticated normal publication, preparation, approval and execution routes complete two adjacent periods exactly once',async()=>server(async({h,call,execution})=>{
 const baseline=await h.capture(),blueprintHash=h.data.Versions[0].contentHash,review=await call('/governance/publication/review',{blueprintHash,baselineId:baseline.id});assert.equal(review.status,200);assert.equal(review.cache,'no-store');const publication=await call('/governance/publication',{blueprintHash,baselineId:baseline.id,reviewHash:review.body.data.reviewHash,reviewNote:'Owner reviewed all current records and opening financial evidence.',ownershipDisposition:'retain-unmanaged'});assert.equal(publication.status,200);
 for(const[ordinal,throughDate]of ['2026-10-15','2026-10-31'].entries()){
  const prepared=await call('/governance/operations/prepare',{requestKey:'http-adjacent-period-'+ordinal,throughDate},actorId);assert.equal(prepared.status,200,JSON.stringify(prepared.body));const p=prepared.body.data;assert.equal((await call('/governance/operations/'+p.operationId+'/approve',{planHash:p.planHash},actorId)).status,403);assert.equal((await call('/governance/operations/'+p.operationId+'/review?offset=0')).status,200);assert.equal((await call('/governance/operations/'+p.operationId+'/approve',{planHash:p.planHash})).status,200);
  const request={planHash:p.planHash,requestKey:'http-explicit-execution-'+ordinal},queued=await call('/operations/'+p.operationId+'/execute',request);assert.equal(queued.status,202);await execution.idle();const actual=await call('/operations/'+p.operationId);assert.equal(actual.status,200);assert.equal(actual.body.data.completion.throughDate,throughDate,JSON.stringify(actual.body));const posts=h.posts;await call('/operations/'+p.operationId+'/execute',request);await execution.idle();assert.equal(h.posts,posts);
 }
 assert.equal(h.data.Calendars[0].revision,2);assert.equal(h.data.Writers[0].operationId,null);assert.equal(h.data.Evidence.length,2);
}));
test('normal governance routes deny absent authentication and context, state or unbounded-page overrides',async()=>server(async({h,call})=>{
 assert.equal((await call('/governance',undefined,null)).status,401);assert.equal((await call('/governance?realmId=999')).status,400);assert.equal((await call('/governance/operations/prepare',{requestKey:'denied-request-00001',throughDate:'2026-10-06',realmId:'999'})).status,400);assert.equal((await call('/governance/operations/'+ 'e'.repeat(24)+'/review?offset=100000')).status,400);assert.equal(h.posts,0);assert.equal(h.data.Authorities.length,0);
}));
