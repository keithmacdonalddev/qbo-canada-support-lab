'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { runWithCaller } = require('./qbo-request-meter');
function fail(message) { throw Object.assign(new Error(message),{status:409,code:'BUSINESS_VERIFICATION_UNAVAILABLE'}); }
// One full-entity query per type/page for parents that genuinely changed after a
// child write. Never project fields or infer missing rows from a partial page.
function createBusinessTransactionBatchReader({ access, observations, now=()=>Date.now() }) {
 return async function read(scope, steps, {signal}={}) {
  scope=scoped(scope); signal?.throwIfAborted(); const result=new Map(), missing=new Map();
  for(const step of steps) {
   const key=step.entity+':'+step.qboId;
   if(!/^[A-Za-z]+$/.test(step.entity)||!/^\d{1,30}$/.test(step.qboId)) fail('An exact saved transaction is required.');
   let value;
   try { value=await observations.read(scope,step.entity,step.qboId,{transactions:true,signal}) || await observations.saved(scope,step.entity,step.qboId,{signal}); }
   catch { signal?.throwIfAborted(); }
   if(value) { if(value.source.kind==='qbo-write-response') try { await observations.retain(scope,step.entity,value.record,value.observedAt); } catch { signal?.throwIfAborted(); /* Receipt survives a mirror failure. */ } result.set(key,value); } else { const ids=missing.get(step.entity)||[];ids.push(step.qboId);missing.set(step.entity,ids); }
  }
  if(!missing.size) return result;
  const actor=await access.authorize(scope,'operations.read',{signal}),client=await access.resolveClient(scope,{signal});
  const {QBOClient}=require('./qbo-client');
  const guard=async()=>{signal?.throwIfAborted();const current=await access.authorize(scope,'operations.read',{signal});
   const base='https://'+(scope.environment==='production'?'quickbooks.api.intuit.com':'sandbox-quickbooks.api.intuit.com')+'/v3/company/'+scope.realmId;
   if(current?.actorId!==actor?.actorId||current?.ownerId!==actor?.ownerId||!/^[a-f0-9]{24}$/.test(actor?.ownerId||'')||!(client instanceof QBOClient)||client.query!==QBOClient.prototype.query||client.apiCall!==QBOClient.prototype.apiCall||client.apiBase!==base||client.realmId!==scope.realmId||String(client.connection?._id)!==scope.connectionId||String(client.connection?.userId)!==actor.ownerId||String(client.connection?.realmId)!==scope.realmId||client.connection?.status!=='active')fail('The batch reader changed company or authority.');};
  const control={signal:signal||new AbortController().signal,beforeAttempt:guard,onFailure:()=>{}};
  for(const [entity,all] of missing)for(let offset=0;offset<all.length;offset+=100){
   const ids=all.slice(offset,offset+100);await guard();
   const query='SELECT * FROM '+entity+' WHERE Id IN ('+ids.map(id=>"'"+id+"'").join(',')+') MAXRESULTS 1000';
   const body=await runWithCaller('business-transaction',()=>client.query(query,control));await guard();
   const page=body?.QueryResponse,rows=page?.[entity];
   if(!body||Object.keys(body).some(key=>!['QueryResponse','time'].includes(key))||!page||Object.keys(page).some(key=>![entity,'startPosition','maxResults','totalCount'].includes(key))||!Array.isArray(rows)||rows.length!==ids.length||page.startPosition!==undefined&&page.startPosition!==1||page.maxResults!==undefined&&page.maxResults!==rows.length||page.totalCount!==undefined&&page.totalCount!==rows.length)fail('The complete parent query omitted or truncated saved records.');
   const seen=new Set();
   for(const record of rows){
    if(!record||!ids.includes(record.Id)||seen.has(record.Id)||typeof record.SyncToken!=='string'||!/^(0|[1-9]\d{0,63})$/.test(record.SyncToken)||record.sparse!==undefined&&record.sparse!==false||record.status==='Deleted'||Buffer.byteLength(canonical(record))>256000)fail('The parent query returned incomplete or repeated records.');
    seen.add(record.Id);const copied=JSON.parse(canonical(record)),recordHash=hash(copied);
    result.set(entity+':'+record.Id,{scope,entity,record:copied,recordHash,observedAt:new Date(now()).toISOString(),source:{version:1,kind:'qbo-full-entity-query',scope,entity,id:record.Id,recordHash}});
   }
  }
  return result;
 };
}
module.exports={createBusinessTransactionBatchReader};
