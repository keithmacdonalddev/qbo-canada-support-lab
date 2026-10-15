'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createCompanyPermissionGuard } = require('../src/middleware/companyPermission');
const OWNER='a'.repeat(24), MEMBER='b'.repeat(24);
function fixture(permissions=[], options={}) {
  const seen=[];let next=0;const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  const guard=createCompanyPermissionGuard('operations.execute',{findActor:async id=>{seen.push(id);return options.actor===null?null:{role:'agent'};},context:{resolve:async user=>{if(options.unavailable)throw new Error('storage');return{connection:{connected:options.connected!==false},membership:{permissions},actor:user.actorId};}}});
  return{seen,response,guard,req:{user:{id:OWNER,actorId:MEMBER,role:'supervisor'}},next:()=>next++,count:()=>next};
}
test('write authority comes from the actual current member, not the owner or JWT role',async()=>{const f=fixture();await f.guard(f.req,f.response,f.next);assert.deepEqual(f.seen,[MEMBER]);assert.equal(f.response.statusCode,403);assert.equal(f.count(),0);assert.equal(f.response.body.code,'COMPANY_PERMISSION_REQUIRED');});
test('an explicitly permitted current member may act, but a revoked account cannot',async()=>{const f=fixture(['operations.execute']);await f.guard(f.req,f.response,f.next);assert.equal(f.count(),1);const revoked=fixture(['operations.execute'],{actor:null});await revoked.guard(revoked.req,revoked.response,revoked.next);assert.equal(revoked.response.statusCode,403);assert.equal(revoked.count(),0);});
test('missing authentication, company and permission storage fail before action',async()=>{for(const[options,expected]of[[{connected:false},409],[{unavailable:true},503]]){const f=fixture(['operations.execute'],options);await f.guard(f.req,f.response,f.next);assert.equal(f.response.statusCode,expected);assert.equal(f.count(),0);}const f=fixture();await f.guard({},f.response,f.next);assert.equal(f.response.statusCode,401);assert.equal(f.seen.length,0);});
test('actual legacy write routes reject a read-only shared-company member before handlers',async()=>{
  const permissionId=require.resolve('../src/middleware/companyPermission'),original=require.cache[permissionId];
  require.cache[permissionId]={...original,exports:{createCompanyPermissionGuard:permission=>createCompanyPermissionGuard(permission,{findActor:async()=>({role:'agent'}),context:{resolve:async()=>({connection:{connected:true},membership:{permissions:['company.read','blueprint.read']}})}})}};
  const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.headers.authorization)req.user={id:OWNER,actorId:MEMBER,scopeResolved:true,role:'supervisor'};next();});
  try{app.use('/generate',require('../src/routes/generate'));app.use('/seed',require('../src/routes/seed'));app.use('/checkpoint',require('../src/routes/checkpoint'));app.use('/issuepacks',require('../src/routes/issuepacks'));}finally{require.cache[permissionId]=original;}
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{for(const[method,url]of[['POST','/generate/start'],['POST','/seed/start'],['POST','/checkpoint'],['DELETE','/checkpoint/'+OWNER],['POST','/issuepacks/example/run']]){const result=await fetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{authorization:'fixture','content-type':'application/json'},body:method==='POST'?JSON.stringify({confirmProduction:true}):undefined});assert.equal(result.status,403,method+' '+url);assert.equal((await result.json()).code,'COMPANY_PERMISSION_REQUIRED');}assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/generate/start',{method:'POST'})).status,401);}finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});
