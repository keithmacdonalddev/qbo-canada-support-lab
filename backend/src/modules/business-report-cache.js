'use strict';
const {hash,canonical}=require('./business-calendar');
const {scoped}=require('./qbo-write-contract');
const {ENTITIES,SNAPSHOT_ONLY}=require('./business-agent-sync');
const {evaluateReportSources}=require('./book-evidence');
const {reportComplete}=require('./business-financial-summary');
const {canonicalReport}=require('./report-json');
const {unpackReport,packReport}=require('./business-report-source');
const ledgerDigest=report=>{const copy=JSON.parse(canonicalReport(report));if(copy.Header)delete copy.Header.Time;return hash(copy);};
const {MAX_SOURCE_BYTES}=require('./business-report-source');
const TRACKED=ENTITIES.filter(entity=>!SNAPSHOT_ONLY.includes(entity));
const clockOf=value=>value==null?NaN:new Date(value).getTime();
const cacheDay=clock=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Halifax',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(clock));
function originalSource(source){const {reuse,sourceHash,evaluation,...base}=source;return reuse?{...base,startedAt:reuse.startedAt,observedAt:reuse.observedAt}:base;}
function assertReportReuse(source){
 if(source?.reuse===undefined)return;
 const r=source.reuse,d=r?.detection,original=originalSource(source),start=clockOf(source.startedAt),end=clockOf(source.observedAt),oldEnd=clockOf(r?.observedAt);
 if(r?.version!==1||hash(original)!==r.sourceHash||!d||d.version!==1||canonical(d.scope)!==canonical(source.scope)||! /^[a-f0-9]{64}$/.test(d.signature||''))throw Error('Invalid report reuse provenance.');
 // Provenance carries the original report window and an unchanged CDC signature;
 // the new timestamps describe that re-observation, never a new report transport.
 const {contentHash,...token}=d;
 if(!r.ledgerProbe || ledgerDigest(unpackReport('GeneralLedger',source.reports.GeneralLedger,source.version))!==ledgerDigest(unpackReport('GeneralLedger',r.ledgerProbe,3)) || hash(token)!==contentHash||!Number.isFinite(start)||end<start||clockOf(d.observedThrough)<oldEnd||clockOf(d.checkedAt)!==end||start<clockOf(d.observedThrough)||cacheDay(oldEnd)!==cacheDay(end)||clockOf(r.startedAt)>oldEnd||clockOf(r.observedAt)>start)throw Error('Report reuse lacks a same-day unchanged change observation.');
}
function createBusinessReportCache({Records,Agents,Receipts,Writers,now=()=>Date.now()}={}){
 function models(){if(!Records&&require('mongoose').connection.readyState!==1)return null;return{Records:Records||require('../models/CompanySyncRecord'),Agents:Agents||require('../models/BusinessAgent'),Receipts:Receipts||require('../models/QboWriteReceipt'),Writers:Writers||require('../models/CompanyWriter')};}
 async function snapshot(scope){
  scope=scoped(scope);const db=models();if(!db)return null;
  const agent=await db.Agents.findOne(scope).maxTimeMS(3000).lean(),clock=now(),sources=agent?.sync?.sources;
  if(!agent||['environment','realmId','connectionId'].some(key=>String(agent[key])!==scope[key])||!sources||agent.sync.summaryError||['attention','resyncing'].includes(agent.sync.amountReconciliation?.status))return null;
  let through=Infinity;const generations={};
  for(const entity of TRACKED){const s=sources[entity],completed=clockOf(s?.lastSuccessAt),since=clockOf(s?.since),cadence=Number.isSafeInteger(s?.everyMs)&&s.everyMs>=1000?s.everyMs:60000;
   if(s?.entity!==entity||s.mode!=='cdc'||s.phase!=='incremental'||s.status!=='current'||s.error||s.reconcileError||!s.generation||!Number.isFinite(completed)||completed>clock||clock-completed>Math.max(120000,cadence*2)||!Number.isFinite(since)||since>completed)return null;
   through=Math.min(through,since);generations[entity]=s.generation;
  }
  const writer=await db.Writers.findOne({environment:scope.environment,realmId:scope.realmId}).maxTimeMS(3000).lean();
  if(!writer||String(writer.connectionId)!==scope.connectionId||writer.unresolved)return null;
  for(const entity of SNAPSHOT_ONLY){const s=sources[entity],completed=clockOf(s?.lastSuccessAt),cadence=Number.isSafeInteger(s?.everyMs)&&s.everyMs>=1000?s.everyMs:60000;if(s?.entity!==entity||s.mode!=='snapshot'||s.status!=='current'||s.phase!=='incremental'||!s.generation||s.error||!Number.isFinite(completed)||completed>clock||clock-completed>Math.max(120000,cadence*2))return null;generations[entity]=s.generation;}
  const rows=await db.Records.find({...scope,entity:{$in:ENTITIES}}).select('entity qboId deleted generation record changedAt').sort({entity:1,qboId:1}).limit(50001).maxTimeMS(10000).lean();
  if(rows.length>50000||rows.some(row=>!row.deleted&&row.generation!==generations[row.entity]))return null;
  for(const entity of ENTITIES)if(!Number.isSafeInteger(sources[entity]?.count)||sources[entity].count!==rows.filter(row=>row.entity===entity&&!row.deleted).length)return null;
  const receipts=await db.Receipts.find({...scope,sentAt:{$gte:new Date(clock-2*86400000)}}).select('_id state observedAt observed.responseHash').sort({_id:1}).limit(10001).maxTimeMS(5000).lean();
  if(receipts.length>10000||receipts.some(row=>['possibly-sent','unknown'].includes(row.state)))return null;
  const signature=hash({generations,records:rows.map(row=>({entity:row.entity,id:row.qboId,deleted:row.deleted,recordHash:hash(row.record),changedAt:row.changedAt?new Date(row.changedAt).toISOString():null})),receipts:receipts.map(row=>({id:String(row._id),state:row.state,observedAt:row.observedAt?new Date(row.observedAt).toISOString():null,responseHash:row.observed?.responseHash||null}))});
  const token={version:1,scope,signature,observedThrough:new Date(through).toISOString(),checkedAt:new Date(clock).toISOString()};return{...token,contentHash:hash(token)};
 }
 async function load(scope,period,before,{readLedger}={}){
  if(!before||typeof readLedger!=='function')return null;const db=models();if(!db)return null;
  const row=await db.Records.findOne({...scope,entity:'CompanyInfo',deleted:false}).select('reportCache').maxTimeMS(3000).lean(),entry=row?.reportCache;
  if(!entry||entry.version!==1||canonical(entry.scope)!==canonical(scope)||canonical(entry.source?.period)!==canonical(period)||entry.token?.signature!==before.signature||hash(entry.source)!==entry.sourceHash||cacheDay(clockOf(entry.source.observedAt))!==cacheDay(now())||clockOf(before.observedThrough)<clockOf(entry.source.observedAt))return null;
  // CDC does not cover every report-affecting QBO type (for example tax
  // payments/inventory adjustments). One complete unchanged ledger probe closes
  // that gap; a changed probe is reused by the caller in its one refreshed set.
  const ledger=await readLedger();
  if(ledgerDigest(ledger)!==ledgerDigest(unpackReport('GeneralLedger',entry.source.reports.GeneralLedger,entry.source.version)))return null;
  const after=await snapshot(scope);if(!after||after.signature!==before.signature)return null;
  const original=originalSource(entry.source),observedAt=new Date(now()).toISOString();
  const detection={...after,checkedAt:observedAt};delete detection.contentHash;detection.contentHash=hash(detection);
  const source={...original,startedAt:observedAt,observedAt,reuse:{version:1,startedAt:original.startedAt,observedAt:original.observedAt,sourceHash:hash(original),ledgerProbe:packReport('GeneralLedger',ledger,3),detection}};
  assertReportReuse(source);const evaluation=evaluateReportSources(source,{allowExplicitZero:true});if(evaluation.status!=='checks-passed'||!reportComplete(evaluation,source)||Buffer.byteLength(canonical(source))>MAX_SOURCE_BYTES)return null;
  return{...source,sourceHash:hash(source),evaluation};
 }
 async function retain(scope,source,before){
  if(!before)return;const db=models();if(!db)return;
  const after=await snapshot(scope);if(!after||after.signature!==before.signature)return;
  const evaluation=evaluateReportSources(source,{allowExplicitZero:true});if(evaluation.status!=='checks-passed'||!reportComplete(evaluation,source))return;
  const entry={version:1,scope,source,sourceHash:hash(source),token:after};
  // Metadata beside CompanyInfo, never inside its QBO record. One bounded set per
  // company; no new collection, startup preparation, or unbounded report history.
  await db.Records.updateOne({...scope,entity:'CompanyInfo',deleted:false},{$set:{reportCache:entry}},{maxTimeMS:3000});
 }
 return{snapshot,load,retain};
}
module.exports={createBusinessReportCache,assertReportReuse};
