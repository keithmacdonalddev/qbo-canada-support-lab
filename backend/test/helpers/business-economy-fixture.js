'use strict';
const assert=require('node:assert/strict');
const {createBusinessObservationStore}=require('../../src/modules/business-observation-store');
const {QBOClient}=require('../../src/modules/qbo-client');
const {ENTITIES,SNAPSHOT_ONLY}=require('../../src/modules/business-agent-sync');
const scope={realmId:'123',environment:'sandbox',connectionId:'a'.repeat(24)},ownerId='b'.repeat(24),actorId=ownerId;
const clock=Date.parse('2026-10-06T12:00:00.000Z'),iso=value=>new Date(value).toISOString(),copy=structuredClone;
const get=(obj,key)=>key.split('.').reduce((value,part)=>value?.[part],obj);
function matches(row,filter){return Object.entries(filter).every(([key,value])=>{
 if(key==='$and')return value.every(branch=>matches(row,branch));
 if(key==='$or')return value.some(branch=>matches(row,branch));
 const actual=get(row,key);
 if(value instanceof Date)return new Date(actual).getTime()===value.getTime();
 if(value&&typeof value==='object')return Object.entries(value).every(([op,wanted])=>op==='$gte'?new Date(actual).getTime()>=new Date(wanted).getTime():op==='$in'?wanted.includes(actual):op==='$ne'?actual!==wanted:op==='$elemMatch'?Array.isArray(actual)&&actual.some(item=>matches(item,wanted)):false);
 return String(actual)===String(value);
 });}
function model(rows){return{findOne(filter){return cursor(()=>rows.find(row=>matches(row,filter))||null);},find(filter){return cursor(()=>rows.filter(row=>matches(row,filter)));},async updateOne(filter,update,options){let row=rows.find(row=>matches(row,filter));if(!row&&options?.upsert){row={...filter,...copy(update.$setOnInsert)};rows.push(row);}if(row)Object.assign(row,copy(update.$set));return{matchedCount:row?1:0};}};}
function cursor(read){let order,limit=Infinity;return{select(){return this;},sort(value){order=value;return this;},limit(value){limit=value;return this;},maxTimeMS(){return this;},async lean(){let value=copy(read());if(Array.isArray(value)){if(order)value.sort((a,b)=>{for(const [key,direction]of Object.entries(order)){const cmp=String(get(a,key)).localeCompare(String(get(b,key)));if(cmp)return cmp*direction;}return 0;});return value.slice(0,limit);}return value;}};}
function harness(){
 const h={now:clock,records:[],receipts:[],audits:[],writers:[{...scope,unresolved:null}],agents:[{...scope,sync:{sources:{}}}]};
 for(const entity of ENTITIES)h.agents[0].sync.sources[entity]={entity,mode:SNAPSHOT_ONLY.includes(entity)?'snapshot':'cdc',phase:'incremental',status:'current',generation:'fixture-generation',startedAt:iso(clock-120000),since:iso(clock-60000),lastSuccessAt:iso(clock-10000),everyMs:300000,count:0};
 h.models={Records:model(h.records),Agents:model(h.agents),Receipts:model(h.receipts),Audits:model(h.audits),Writers:model(h.writers),now:()=>h.now};
 h.store=createBusinessObservationStore(h.models);
 h.add=(entity,record,extra={})=>{const row={...scope,entity,qboId:record.Id,record:copy(record),deleted:false,generation:'fixture-generation',lastObservedAt:new Date(clock-10000),lastReadStartedAt:new Date(clock-120000),...extra};h.records.push(row);h.agents[0].sync.sources[entity].count++;return row;};
 h.client=Object.create(QBOClient.prototype);h.calls=[];
 Object.assign(h.client,{realmId:scope.realmId,connection:{_id:scope.connectionId,userId:ownerId,realmId:scope.realmId,status:'active'},ensureFreshToken:async()=>{},_requestLog:[],_retryAfterUntil:0,_windowMs:60000,requestMeter:{record(){}},oauthClient:{makeApiCall:async options=>{h.calls.push(options);return{status:200,json:await h.response(options)};}}});
 h.access={authorize:async()=>{if(h.revoked)throw Error('permission revoked');return{actorId,ownerId};},resolveClient:async()=>h.client};
 return h;
}

module.exports={harness,scope,ownerId,actorId,clock,iso,model};
