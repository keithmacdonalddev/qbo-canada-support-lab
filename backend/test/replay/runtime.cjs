'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { model } = require('./memory.cjs');
const { digest } = require('./loader.cjs');
const json = value => JSON.parse(JSON.stringify(value));
const scopeOf = r => ({ environment:r.environment,realmId:r.realmId,connectionId:String(r.connectionId) });
const sameScope = (a,b) => ['environment','realmId','connectionId'].every(k=>String(a?.[k])===String(b?.[k]));
const missing = code => Object.assign(new Error(code),{code:'REPLAY_'+code});
const TABLES = { Runs:'operationruns',Steps:'operationsteps',Plans:'operationplans',Intents:'operationintents',Evidence:'operationevidences',
 GeneralWriteRuns:'generalwriteruns',Receipts:'qbowritereceipts',Records:'companysyncrecords',Mirror:'companysyncrecords',
 Authorities:'businessauthorities',Versions:'blueprintversions',Calendars:'businesscalendars',Policies:'companywritepolicies',
 Agents:'businessagents',Candidates:'businesscandidates',Baselines:'businessbaselines',GeneralDayCloses:'generaldaycloses',Audits:'auditlogs',Writers:'companywriters' };
const MODEL_TABLES = { OperationRun:'operationruns',OperationStep:'operationsteps',OperationPlan:'operationplans',OperationIntent:'operationintents',
 OperationEvidence:'operationevidences',GeneralWriteRun:'generalwriteruns',QboWriteReceipt:'qbowritereceipts',CompanySyncRecord:'companysyncrecords',
 BusinessAuthority:'businessauthorities',BlueprintVersion:'blueprintversions',BusinessCalendar:'businesscalendars',CompanyWritePolicy:'companywritepolicies',
 BusinessCandidate:'businesscandidates',BusinessAgent:'businessagents',BusinessBaseline:'businessbaselines',GeneralDayClose:'generaldaycloses',AuditLog:'auditlogs',CompanyWriter:'companywriters' };
function createRuntime({ root, data, run, at, transform, features = {} }) {
 const scope=scopeOf(run), operationId=String(run._id), clock=()=>at;
 const models=Object.fromEntries(Object.entries(TABLES).map(([key,table])=>[key,model(data[table]||[])]));
 const cache=new Map(), native=Module.createRequire(root+'/backend/package.json');
 let activeRecords=new Map(), activeReports=new Map();
 class QBOClient {
   constructor() {
     this.connection={_id:scope.connectionId,realmId:scope.realmId,userId:String(run.createdBy||run.ownerId),status:'active'};
     this.realmId=scope.realmId;
     this.apiBase='https://'+(scope.environment==='production'?'quickbooks.api.intuit.com':'sandbox-quickbooks.api.intuit.com')+'/v3/company/'+scope.realmId;
   }
   async read(entity,id){return this.apiCall('GET',entity.toLowerCase()+'/'+id);}
   async query(text) {
     const match=/^SELECT \* FROM ([A-Za-z]+)(?: WHERE Active IN \(true, false\))?(?: ORDERBY Id ASC)?(?: STARTPOSITION (\d+))?(?: MAXRESULTS (\d+))?$/.exec(text);
     if(!match)throw missing('UNRECORDED_QUERY');
     const [,entity,start='1',size='1000']=match;
     if(!activeRecords.has(entity))throw missing('AS_OF_ENUMERATION_MISSING');
     const rows=[...activeRecords.get(entity).values()].slice(Number(start)-1,Number(start)-1+Number(size));
     return {QueryResponse:{[entity]:json(rows),startPosition:Number(start),maxResults:rows.length}};
   }
   async apiCall(method,endpoint) {
     if(method!=='GET')throw missing('TRANSPORT_SEND_FORBIDDEN');
     if(endpoint.startsWith('reports/')) {
       const name=endpoint.slice(8).split('?')[0], report=activeReports.get(name);
       if(!report)throw missing('STORED_REPORT_MISSING');
       return json(report);
     }
     const match=/^([a-z]+)\/(\d+)$/.exec(endpoint);
     if(!match)throw missing('UNRECORDED_ENDPOINT');
     const entity=[...activeRecords.keys()].find(e=>e.toLowerCase()===match[1]);
     const record=activeRecords.get(entity)?.get(match[2]);
     if(!record)throw missing('AS_OF_RECORD_MISSING');
     return {[entity]:json(record)};
   }
 }
 const fakeClient={QBOClient};
 const load = filename => {
   filename=path.resolve(filename);
   if(cache.has(filename))return cache.get(filename).exports;
   const local=new Module(filename); cache.set(filename,local); local.filename=filename; local.paths=Module._nodeModulePaths(path.dirname(filename));
   local.require = spec => {
     if(spec==='replay:clock')return class ReplayDate extends Date {constructor(...args){super(...(args.length?args:[clock()]));}static now(){return clock();}};
     if(spec==='mongoose')throw missing('DATABASE_ACCESS_FORBIDDEN');
     const resolved=Module._resolveFilename(spec,local);
     if(typeof resolved==='string' && /[\\/]backend[\\/]src[\\/]/.test(resolved)) {
       if(/[\\/]modules[\\/]qbo-client\.js$/.test(resolved))return fakeClient;
       if(/[\\/]config([\\/]|\.js$)/.test(resolved))return {features,qbo:{environment:scope.environment}};
       if(/[\\/]models[\\/]/.test(resolved)) {
         const table=MODEL_TABLES[path.basename(resolved,'.js')];
         if(!table || !Object.hasOwn(data,table))return new Proxy({}, {get:()=>()=>{throw missing('MODEL_SNAPSHOT_MISSING');}});
         return model(data[table]);
       }
       if(!/[\\/]modules[\\/]/.test(resolved))throw missing('APPLICATION_ENTRY_FORBIDDEN');
       return load(resolved);
     }
     return native(resolved);
   };
   const relative=path.relative(root,filename).replace(/\\/g,'/');
   let source=data.__replaySources?data.__replaySources[relative]:fs.readFileSync(filename,'utf8');
   if(typeof source!=='string')throw missing('SOURCE_SNAPSHOT_MISSING');
   if(transform)source=transform(filename,source);
   local._compile("'use strict'; const Date = require('replay:clock');\n"+source,filename);
   return local.exports;
 };
 const current = name=>load(root+'/backend/src/modules/'+name+'.js');
 const hash = current('business-calendar').hash;
 function seedRecords(time) {
   activeRecords=new Map();
   // lastObservedAt is the only retained observation time. LastUpdatedTime alone
   // is insufficient: balances and backlinks can change without a SyncToken.
   for(const row of data.companysyncrecords||[]) {
     if(!sameScope(row,scope)||row.deleted||!row.record||!Number.isFinite(+new Date(row.lastObservedAt))||+new Date(row.lastObservedAt)>time||time-(+new Date(row.lastObservedAt))>300000)continue;
     put(row.entity,row.record);
   }
 }
 function put(entity,record) {
   if(!record?.Id)return;
   if(!activeRecords.has(entity))activeRecords.set(entity,new Map());
   activeRecords.get(entity).set(String(record.Id),json(record));
 }
 function observed(entity,record) {
   return {scope,entity,record:json(record),recordHash:hash(json(record)),observedAt:new Date(at).toISOString(),
     source:{version:1,kind:'qbo-full-entity-get',scope,entity,id:String(record.Id),endpoint:entity.toLowerCase()+'/'+record.Id,recordHash:hash(json(record))}};
 }
 const client=new QBOClient(), authorize=async s=>{if(!sameScope(s,scope))throw missing('SCOPE_CHANGED');return {actorId:String(run.createdBy||run.actorId),ownerId:String(run.createdBy||run.ownerId)};};
 const access={authorize,resolveClient:async()=>client};
 const observations={
   read:async(s,entity,id)=>{const body=await client.read(entity,id);return observed(entity,body[entity]);},
   definition:async(s,entity,id)=>{const record=activeRecords.get(entity)?.get(String(id));return record?observed(entity,record):null;},
   // Full enumeration is never invented from an incomplete set of retained receipts.
   deposits:async()=>{throw missing('AS_OF_ENUMERATION_MISSING');}
 };
 seedRecords(at);
 return {current,models,scope,operationId,hash,clock,client,access,observations,observed,put,seedRecords,
   getRecord:(entity,id)=>activeRecords.get(entity)?.get(String(id)),
   setReports:reports=>{activeReports=new Map(Object.entries(reports));},
   setAt:time=>{at=time;seedRecords(time);},
   hasTable:table=>Object.hasOwn(data,table)};
}
function safeError(error, stage) {
 const stack=String(error?.stack||'').split('\n');
 const frame=stack.map(line=>/[\\/]backend[\\/](src[\\/][^():]+|test[\\/]replay[\\/][^():]+):(\d+):\d+/.exec(line)).find(Boolean);
 const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/.test(error.code)?error.code:'REPLAY_EXCEPTION';
 return {code,stage,messageHash:digest(String(error?.message||error)),...(frame?{check:{file:'backend/'+frame[1].replace(/\\/g,'/'),line:Number(frame[2])}}:{})};
}
function classify(baseline, errors) {
 if(errors.some(e=>e.code.startsWith('REPLAY_')||!e.refused))return 'errored';
 if(errors.length)return baseline==='accepted'?'newly refused':'same outcome';
 return baseline==='refused'?'newly accepted':'same outcome';
}
module.exports={createRuntime,scopeOf,sameScope,missing,json,safeError,classify};
