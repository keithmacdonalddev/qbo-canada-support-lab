'use strict';
const { hash, canonical } = require('./business-calendar');
const { denied } = require('./qbo-write-contract');
const { referenceDefinition } = require('./business-reference');
const { accountPostingEvidence, endpointFor } = require('./business-receivables-route');
const { taxExpectation } = require('./business-verification-runtime');
const { verifyPopulationFinancialContent } = require('./business-readback');
const ENTITIES = new Set(['Estimate','Invoice','TimeActivity','Payment','Deposit','PurchaseOrder','Bill','SalesReceipt','BillPayment']);
async function parallel(values, work, limit = 3) {
  let next=0,failure=null;const results=new Array(values.length);
  await Promise.allSettled(Array.from({length:Math.min(limit,values.length)},async()=>{while(!failure&&next<values.length){const index=next++;try{results[index]=await work(values[index],index);}catch(error){failure ||= error;}}}));
  if(failure)throw failure;return results;
}
function createPopulationReader({ scope, jobId, client, records, readFence, masterCache = new Map(), validateCreation, now = () => Date.now(), signal, readQueue = require('./business-population-reads').createPopulationReadQueue() }) {
  const raw = new Map(), routes = new Map(), reports = new Map(), byKey = new Map(records.map(row=>[row.logicalKey,row])), children = new Map();
  const check = () => { if (signal?.aborted) throw denied('Population reads were stopped before dispatch.'); };
  const control = { signal: signal || new AbortController().signal, beforeAttempt: async()=>check(), onFailure:()=>{} };
  for (const row of records) if(row.state==='saved') for(const link of row.step.dependencies){const values=children.get(link.logicalKey)||[];values.push(row);children.set(link.logicalKey,values);}
  const get = endpoint => {check();return readQueue.run(()=>client.apiCall('GET',endpoint,undefined,0,0,control),signal);};
  async function queryMany(rows, force = false) {
    const groups = new Map();
    for (const row of rows) {
      const key=row.entity+':'+row.qboId;if(!ENTITIES.has(row.entity)||!/^\d{1,30}$/.test(row.qboId||''))throw denied('Population reads require exact saved identities.');
      if(!force && raw.has(key))continue;
      const group=groups.get(row.entity)||new Map();group.set(row.qboId,row);groups.set(row.entity,group);
    }
    const jobs=[];for(const [entity,values] of groups) {const entries=[...values.values()];for(let offset=0;offset<entries.length;offset+=100)jobs.push({entity,rows:entries.slice(offset,offset+100)});}
    await parallel(jobs,async job=>{
      check();const ids=job.rows.map(row=>row.qboId).sort(),query='SELECT * FROM '+job.entity+" WHERE Id IN ("+ids.map(id=>"'"+id+"'").join(',')+') MAXRESULTS 1000';
      const body=await readQueue.run(()=>client.query(query,control),signal),page=body?.QueryResponse,values=page?.[job.entity];
      if(!page||Object.keys(page).some(key=>![job.entity,'startPosition','maxResults','totalCount'].includes(key))||!Array.isArray(values)||values.length!==ids.length||(page.totalCount!==undefined&&page.totalCount!==ids.length)||(page.maxResults!==undefined&&page.maxResults!==values.length))throw denied('The grouped full-record read is incomplete.');
      const seen=new Set(),observedAt=new Date(now()).toISOString();
      for(const record of values){if(!ids.includes(record?.Id)||seen.has(record.Id)||typeof record.SyncToken!=='string'||!/^(0|[1-9]\d{0,63})$/.test(record.SyncToken)||record.sparse===true||record.status==='Deleted'||Buffer.byteLength(canonical(record))>256000)throw denied('A grouped population record is changed, duplicate or incomplete.');seen.add(record.Id);const recordHash=hash(record);raw.set(job.entity+':'+record.Id,{scope,entity:job.entity,record,recordHash,observedAt,source:{version:1,kind:'qbo-full-entity-query',scope,entity:job.entity,id:record.Id,query,recordHash,responseHash:hash(body)}});}
    });
  }
  const cohortMasters=new Map(), masterFlights=new Map();
  async function loadMaster(entity,id,{fresh=false}={}) {
    const key=entity+':'+id,cached=masterCache.get(key);
    if(!fresh&&cached&&now()-Date.parse(cached.observedAt)<60000)return cached;
    const body=await get(entity.toLowerCase()+'/'+id),record=body?.[entity];
    if(!record||record.Id!==id)throw denied('An approved population master could not be read.');
    const recordHash=hash(record),observed={scope,entity,record,recordHash,observedAt:new Date(now()).toISOString(),source:{version:1,kind:'qbo-full-entity-get',scope,entity,id,endpoint:entity.toLowerCase()+'/'+id,recordHash}};
    if(entity!=='TaxRate')referenceDefinition(scope,entity,record);
    // Inventory and all mutable transaction/balance observations are never reused across cohorts.
    if(!(entity==='Item'&&record.Type==='Inventory'))masterCache.set(key,observed);
    return observed;
  }
  async function master(entity,id,options={}) {
    const key=entity+':'+id;if(cohortMasters.has(key))return cohortMasters.get(key);
    if(!masterFlights.has(key))masterFlights.set(key,loadMaster(entity,id,options).then(value=>{cohortMasters.set(key,value);return value;}));
    try{return await masterFlights.get(key);}catch(error){masterFlights.delete(key);throw error;}
  }
  let primedFence=null;
  async function prime(rows) {
    if(primedFence&&rows.every(row=>raw.has(row.entity+':'+row.qboId)&&(!['Invoice','Payment','BillPayment'].includes(row.entity)||raw.get(row.entity+':'+row.qboId).record[row.entity==='BillPayment'?'APAccountRef':'ARAccountRef']!==undefined||routes.has(row.entity+':'+row.qboId))))return primedFence;
    const before=await readFence();await queryMany(rows);
    const omitted=rows.filter(row=>['Invoice','Payment','BillPayment'].includes(row.entity)&&raw.get(row.entity+':'+row.qboId).record[row.entity==='BillPayment'?'APAccountRef':'ARAccountRef']===undefined&&!routes.has(row.entity+':'+row.qboId));
    await parallel(omitted,async row=>{
      const observed=raw.get(row.entity+':'+row.qboId),binding=row.step.references.find(ref=>ref.key===(row.entity==='BillPayment'?'accountsPayable':'accountsReceivable'));
      if(!binding)throw denied('The original posting-account choice is unavailable.');
      const endpoint=endpointFor(observed.record,binding.id);
      if(!reports.has(endpoint))reports.set(endpoint,(async()=>({report:await get(endpoint),observedAt:new Date(now()).toISOString()}))());
      await reports.get(endpoint);
    });
    const originals=new Map(omitted.map(row=>[row.entity+':'+row.qboId,raw.get(row.entity+':'+row.qboId)]));
    if(omitted.length)await queryMany(omitted,true);
    const after=await readFence();if(canonical(before)!==canonical(after))throw denied('Company activity changed during grouped financial reads.');
    await parallel(omitted,async row=>{
      const key=row.entity+':'+row.qboId,first=originals.get(key),observed=raw.get(key);
      if(first.recordHash!==observed.recordHash)throw denied('A transaction changed during posting-account verification.');
      const accountBinding=row.step.references.find(ref=>ref.key===(row.entity==='BillPayment'?'accountsPayable':'accountsReceivable')),accountObserved=await master('Account',accountBinding.id),source=await reports.get(endpointFor(observed.record,accountBinding.id));
      const accountRouting=accountPostingEvidence({compiled:row.compilation,receipt:row.receipt,observed:first,accountBinding,accountObserved,report:source.report,reportObservedAt:source.observedAt,beforeFence:before,afterFence:after,now:now()});
      routes.set(key,accountRouting);
    });
    primedFence=before;return before;
  }
  async function observed(row){await queryMany([row]);const value=raw.get(row.entity+':'+row.qboId);return {...value,...(routes.has(row.entity+':'+row.qboId)?{accountRouting:routes.get(row.entity+':'+row.qboId)}:{})};}
  async function financial(row) {
    if(row.state!=='saved'||!row.receipt||row.receipt.qboId!==row.qboId||row.compilation?.intentHash!==row.fingerprint)throw denied('A financial parent needs its original saved creation receipt.');
    if(typeof validateCreation!=='function')throw denied('The native population creation-evidence validator is required.');
    const creationEvidenceHash=await validateCreation(row);
    const value=await observed(row),parents=await parallel(row.step.dependencies,async link=>{const parent=byKey.get(link.logicalKey);if(parent?.state!=='saved'||parent.fingerprint!==link.fingerprint)throw denied('An original financial dependency differs.');return {...await observed(parent),logicalKey:parent.logicalKey,fingerprint:parent.fingerprint};});
    const childRows=children.get(row.logicalKey)||[];await prime(childRows);
    const childSources=await parallel(childRows,async child=>{await validateCreation(child);return ({logicalKey:child.logicalKey,entity:child.entity,qboId:child.qboId,receiptHash:child.receipt.evidenceHash,receipt:child.receipt,compilation:child.compilation,observed:await observed(child),relationships:child.compilation.relationships,settlementLines:(await observed(child)).record.Line || []});});
    const expected=taxExpectation(row.policy,row.compilation),taxPolicy=expected?{...expected,status:'approved',scope,compilationHash:row.compilation.compilationHash,evidenceHash:hash({policyHash:hash(row.policy),compilationHash:row.compilation.compilationHash,expected})}:null;
    const financialProof=verifyPopulationFinancialContent({compiled:row.compilation,receipt:row.receipt,observed:value,parents,children:childSources,taxPolicy,now:now()});
    return {...value,scope,logicalKey:row.logicalKey,entity:row.entity,fingerprint:row.fingerprint,qboId:row.qboId,syncToken:value.record.SyncToken,state:'financially-verified',financialProof,creationEvidenceHash,originalStep:row.step,originalPolicy:row.policy};
  }
  return { prime, observed, financial, master, get, queryMany, control };
}
module.exports = { createPopulationReader, parallel };
