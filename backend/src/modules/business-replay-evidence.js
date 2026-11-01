'use strict';
// Diagnostic capture never awaits storage on a business write.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, randomUUID, randomInt } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { isDate } = require('node:util').types;
const context = new AsyncLocalStorage(), control = new AsyncLocalStorage();
const MAX_RAW=1048576, MAX_STORED=131072, SLOTS=16384, TTL_SECONDS=2592000, MAX_PENDING=16;
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const gap=code=>Object.assign(new Error(code),{code:'REPLAY_'+code});
const secret=/^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|(?:set-)?cookie|password|passwordHash|client[_-]?secret|jwt[_-]?secret|api[_-]?keys?|tokens|credentials|providerSettings|encryptedKey|keyCiphertext)$/i;
const identity=new Set(['_id','userId','realmId','status','connectionSwitchVersion','businessSetupVersion','createdAt','updatedAt']);
function errorShape(e) {
 const message=String(e?.message||''),safe=require('./business-agent-transcript').scrubText(message);
 return {mongoError:e instanceof require('mongoose').mongo.MongoError,code:['string','number'].includes(typeof e?.code)?e.code:null,status:e?.status??null,message:safe,messageRedacted:safe!==message,messageHash:e?.replayMessageHash||digest(message),qboStage:e?.qboStage??null,outcomeUnknown:e?.outcomeUnknown??null};
}

function encode(v,b={bytes:0,nodes:0},key='') {
 if(++b.nodes>25000)throw gap('CAPTURE_SIZE_LIMIT');
 if(secret.test(key))return {$redacted:true};
 if(v===undefined)return {$undefined:true};
 if(v===null||typeof v==='boolean'||typeof v==='number')return v;
 if(typeof v==='string'){
  b.bytes+=Buffer.byteLength(v);if(b.bytes>MAX_RAW)throw gap('CAPTURE_SIZE_LIMIT');
  if(/^\s*[\[{]/.test(v)){try{const body=JSON.parse(v),clean=encode(body,b);if(JSON.stringify(clean)!==JSON.stringify(body))return {$json:clean};}catch(e){if(e.code)throw e;}}
  return v;
 }
 if(isDate(v))return {$date:v.toISOString()};
 if(v?._bsontype==='ObjectId')return v.toHexString();
 if(typeof v?.inTransaction==='function')return {$session:true};
 if(v instanceof AbortSignal)return {$signal:v.aborted};
 if(v instanceof Map)return {$map:[...v].map(([k,x])=>[encode(k,b),encode(x,b)])};
 if(v instanceof Set)return {$set:[...v].map(x=>encode(x,b))};
 if(typeof v!=='object')throw gap('CAPTURE_UNSUPPORTED_VALUE');
 if(Array.isArray(v))return v.map(x=>encode(x,b));
 if(typeof v.toObject==='function')v=v.toObject();
 return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='session'?{$session:true}:encode(x,b,k)]));
}
function decode(v,port){
 if(!v||typeof v!=='object')return v;
 if(v.$port)return port(v.$port,v.$model===true);
 if(v.$undefined||v.$redacted)return undefined;
 if(v.$date)return new Date(v.$date);
 if(v.$oid)return v.$oid;
 if(v.$signal!==undefined){const c=new AbortController();if(v.$signal)c.abort();return c.signal;}
 if(v.$session)return null;
 if(v.$json)return JSON.stringify(decode(v.$json,port));
 if(v.$map)return new Map(v.$map.map(([k,x])=>[decode(k,port),decode(x,port)]));
 if(v.$set)return new Set(v.$set.map(x=>decode(x,port)));
 if(Array.isArray(v))return v.map(x=>decode(x,port));
 return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x,port)]));
}
function snapshot(v,s){try{return encode(v,s.budget);}catch(e){s.incomplete=true;return {$unavailable:true};}}
function cleanResult(v,name){
 if(!/\bConnections\./.test(name))return v;
 const clean=row=>row&&Object.fromEntries(Object.entries(row.toObject?.()||row).filter(([k])=>identity.has(k)));
 return Array.isArray(v)?v.map(clean):clean(v);
}
function portCall(fn,receiver,args,name){
 const s=context.getStore();if(!s)return Reflect.apply(fn,receiver,args);
 let encodedArgs;try{encodedArgs=name.endsWith('.contextFor')?describe(args,name+'.args').descriptor:snapshot(args,s);}catch{s.incomplete=true;encodedArgs={$unavailable:true};}
 const e={port:name,args:encodedArgs,chain:[]};s.calls.push(e);
 const done=v=>{e.completion=s.completions++;if(name.endsWith('.contextFor')){try{const d=describe(v,'calls.'+(s.calls.indexOf(e))+'.value');e.value=d.descriptor;return d.bound;}catch{s.incomplete=true;return v;}}e.value=snapshot(cleanResult(v,name),s);return v;};
 const fail=error=>{e.completion=s.completions++;e.error=errorShape(error);if(e.error.messageRedacted)s.incomplete=true;throw error;};
 let result;try{result=context.run(null,()=>Reflect.apply(fn,receiver,args));}catch(error){return fail(error);}
 if(result&&(typeof result.exec==='function'&&typeof result.then==='function'||typeof result.lean==='function')){
  const query=result;
  const proxy=new Proxy(query,{get(target,key){
   if(key==='then')return (yes,no)=>query.then(done,fail).then(yes,no);
   if(key==='catch')return no=>query.then(done,fail).catch(no);
   if(key==='cursor')return (...a)=>{e.chain.push(['cursor',snapshot(a,s)]);e.cursor=name+'.cursor';const cursor=query.cursor(...a);return new Proxy(cursor,{get:(t,k)=>typeof t[k]==='function'?(...x)=>portCall(t[k],t,x,e.cursor+'.'+String(k)):t[k]});};
   if(key==='exec')return (...a)=>{e.chain.push(['exec',snapshot(a,s)]);return query.exec(...a).then(done,fail);};
   if(typeof target[key]==='function')return (...a)=>{e.chain.push([String(key),(key==='session'?[{$session:true}]:snapshot(a,s))]);const v=target[key](...a);return v===query?proxy:v&&typeof v.then==='function'?v.then(done,fail):done(v);};
   return target[key];
  }});return proxy;
 }
 if(result&&typeof result.then==='function'){e.async=true;return result.then(done,fail);}
 return done(result);
}
function describe(value,name,key='',receiver,budget={bytes:0,nodes:0}){
 if(++budget.nodes>25000)throw gap('CAPTURE_SIZE_LIMIT');
 if(secret.test(key))return {bound:value,descriptor:{$redacted:true}};
 if(typeof value==='function'||value&&typeof value.findOne==='function'){
  if(key==='transaction')return {descriptor:{$transaction:name},bound:(work,...args)=>{
   const state=context.getStore();if(!state)return value(work,...args);
   const event={port:name,transaction:true,sessions:[]};state.calls.push(event);
   return value(session=>{event.sessions.push(Boolean(session));return work(session);},...args).catch(error=>{event.error=errorShape(error);throw error;});
  }};
  const model=typeof value.findOne==='function';
  return {descriptor:{$port:name,...(model?{$model:true}:{})},bound:model?new Proxy(value,{get:(target,k)=>typeof target[k]==='function'?(...a)=>portCall(target[k],target,a,name+'.'+String(k)):target[k]}):(...args)=>portCall(value,receiver,args,name)};
 }
 if(value&&typeof value==='object'&&!(isDate(value))&&!(value instanceof Map)&&!(value instanceof Set)&&!(value instanceof AbortSignal)&&!value._bsontype){
  const bound=Array.isArray(value)?[]:{},descriptor=Array.isArray(value)?[]:{};
  for(const[k,v]of Object.entries(value)){const d=describe(v,name+'.'+k,k,value,budget);bound[k]=d.bound;descriptor[k]=d.descriptor;}return {bound,descriptor};
 }
 return {bound:value,descriptor:encode(value,budget,key)};
}
let pending=0,slot=randomInt(SLOTS),lastLog=0,readiness={db:null,at:0,ready:false};
function log(code){if(Date.now()-lastLog>60000){lastLog=Date.now();try{console.warn('[replay-evidence] '+code);}catch{}}}
async function persist(envelope){
 const Model=require('../models/BusinessReplayEvidence'),connection=Model.db;if(connection.readyState!==1||!connection.db)return;
 const db=connection.db;
 if(readiness.db!==db||Date.now()-readiness.at>30000){
  const found=await db.listCollections({name:Model.collection.name},{nameOnly:true,maxTimeMS:1000}).toArray();
  const indexes=found.length?await Model.collection.indexes({maxTimeMS:1000}):[];
  readiness={db,at:Date.now(),ready:indexes.some(i=>i.key?.capturedAt===1&&i.expireAfterSeconds===TTL_SECONDS)};
 }
 if(!readiness.ready){log('storage-unprepared');return;}
 const id=String(slot++%SLOTS);
 await Model.collection.replaceOne({_id:id},{...envelope,connectionId:Model.schema.path('connectionId').cast(envelope.connectionId),_id:id},{upsert:true,maxTimeMS:1000});
}
function enqueue(s){
 if(pending>=MAX_PENDING){log('capture-queue-full');return;}
 const sink=control.getStore()?.sink;pending++;
 setImmediate(async()=>{try{
  if(s.incomplete){log('capture-size-or-type-limit');return;}
  const raw=JSON.stringify(s.payload);if(Buffer.byteLength(raw)>MAX_RAW){log('capture-size-limit');return;}
  const body=gzipSync(raw);if(body.length>MAX_STORED){log('capture-queue-or-size-limit');return;}
  const ids=new Set();
  const scan=v=>{if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(['operationId','runId'].includes(k)&&typeof x==='string'&&/^[a-f0-9]{24}$/.test(x))ids.add(x);if(k==='runVersions'&&Array.isArray(x))for(const r of x)if(/^[a-f0-9]{24}$/.test(r.id))ids.add(r.id);scan(x);}};
  scan(s.payload);
  const scope=s.scope;
  if(!scope||!['production','sandbox'].includes(scope.environment)||!scope.realmId||!/^[a-f0-9]{24}$/.test(String(scope.connectionId))){log('capture-scope-missing');return;}
  const envelope={version:1,evidenceId:randomUUID(),...scope,operationIds:[...ids],boundary:s.payload.module+':'+s.payload.method,capturedAt:new Date(),body,bodyHash:digest(s.payload),rawBytes:Buffer.byteLength(raw)};
  await (sink?sink(envelope):persist(envelope));
 }catch{log('capture-failed');}finally{pending--;}
 });
}

function boundary(meta,fn,args,initial,getState){
 if(control.getStore()?.disabled)return fn(...args);
 if(pending>=MAX_PENDING){log('capture-queue-full');return fn(...args);}
 const s={calls:[],completions:0,budget:{bytes:0,nodes:0}};
 let described;
 try{
  described=describe(args,'args');
  s.payload={...meta,config:initial,args:described.descriptor,calls:s.calls,...(getState?{factoryState:snapshot(getState(),s)}:{})};
  const find=v=>{if(!v||typeof v!=='object')return null;if(v.environment&&v.realmId&&v.connectionId)return {environment:v.environment,realmId:v.realmId,connectionId:String(v.connectionId)};for(const x of Object.values(v)){const scope=find(x);if(scope)return scope;}return null;};
  s.scope=find(args)||find(initial)||context.getStore()?.scope;
 }catch{log('capture-failed');return fn(...args);}
 const done=v=>{s.payload.result=snapshot(v,s);enqueue(s);return v;};
 const fail=e=>{s.payload.error=errorShape(e);if(s.payload.error.messageRedacted)s.incomplete=true;enqueue(s);throw e;};
 return context.run(s,()=>{try{const result=fn(...described.bound);return result&&typeof result.then==='function'?result.then(done,fail):done(result);}catch(e){return fail(e);}});
}
function captureFactory(module,name,implementation,config,methods){
 if(control.getStore()?.disabled)return implementation(config);
 let d;try{d=describe(config,'config');}catch{log('capture-failed');return implementation(config);}
 const api=implementation(d.bound);
 if(typeof api==='function')return (...a)=>boundary({module,factory:name,method:'$call'},api,a,d.descriptor);
 for(const method of methods)if(typeof api[method]==='function'){const fn=api[method];api[method]=(...a)=>boundary({module,factory:name,method},fn,a,d.descriptor,api[Symbol.for('business-replay-state')]);}
 return api;
}
function captureFunction(module,name,fn,args){return boundary({module,method:name},fn,args,null);}
function unpack(e){
 if(e.version!==1||!Buffer.isBuffer(e.body)||e.body.length>MAX_STORED)throw gap('CAPTURE_INVALID');
 const p=JSON.parse(gunzipSync(e.body,{maxOutputLength:MAX_RAW}).toString('utf8'));if(digest(p)!==e.bodyHash)throw gap('CAPTURE_HASH_MISMATCH');return p;
}
async function replayCaptured(envelope,load){
 const p=unpack(envelope);let cursor=0,completion=0;const waiting=new Map();
 const pump=()=>{while(waiting.has(completion)){const finish=waiting.get(completion);waiting.delete(completion++);finish();}};
 const deliver=(e,fn,async)=>{if(!async){if(e.completion!==completion)throw gap('CAPTURE_COMPLETION_CHANGED');completion++;const value=fn();pump();return value;}return new Promise((resolve,reject)=>{waiting.set(e.completion,()=>{try{resolve(fn());}catch(error){reject(error);}});queueMicrotask(pump);});};
 const invoke=(name,args)=>{
  const e=p.calls[cursor++];if(!e||e.port!==name||digest(name.endsWith('.contextFor')?describe(args,name+'.args').descriptor:encode(args))!==digest(e.args))throw gap('CAPTURE_CALL_CHANGED');
  const value=()=>{if(e.error){const err=Object.assign(new (e.error.mongoError?require('mongoose').mongo.MongoError:Error)(e.error.message),e.error);err.replayMessageHash=e.error.messageHash;throw err;}return decode(e.value,port);};
  if(e.chain.length){let n=0;const q=new Proxy({},{get(_,key){
   if(key==='then')return (yes,no)=>Promise.resolve().then(()=>{if(n!==e.chain.length)throw gap('CAPTURE_QUERY_CHANGED');return deliver(e,value,true);}).then(yes,no);
   return (...a)=>{const expected=e.chain[n++];if(!expected||expected[0]!==key||digest(key==='session'?[{$session:true}]:encode(a))!==digest(expected[1]))throw gap('CAPTURE_QUERY_CHANGED');if(key==='cursor'){if(n!==e.chain.length||!e.cursor)throw gap('CAPTURE_QUERY_CHANGED');return new Proxy({},{get:(_,k)=>(...x)=>invoke(e.cursor+'.'+String(k),x)});}return key==='exec'?deliver(e,value,true):q;};
  }});return q;}
  return deliver(e,value,e.async);
 };
 const port=(name,model)=>model?new Proxy({},{get:(_,k)=>(...a)=>invoke(name+'.'+String(k),a)}):(...a)=>invoke(name,a);
 const hydrate=v=>{
  if(v?.$transaction)return async work=>{const e=p.calls[cursor++];if(!e||e.port!==v.$transaction||!e.transaction)throw gap('CAPTURE_TRANSACTION_CHANGED');let value;for(const [index,active] of e.sessions.entries()){try{value=await work(active?{inTransaction:()=>true}:null);}catch(error){if(index===e.sessions.length-1)throw error;}}if(e.error){const error=Object.assign(new Error(),e.error);error.replayMessageHash=e.error.messageHash;throw error;}return value;};
  if(v&&typeof v==='object'&&!Array.isArray(v)&&!Object.keys(v).some(k=>k.startsWith('$')))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,hydrate(x)]));
  if(Array.isArray(v))return v.map(hydrate);return decode(v,port);
 };
 return control.run({disabled:true},async()=>{
  let result,error;
  try{const mod=load(p.module),args=hydrate(p.args);if(p.factory){const api=mod[p.factory]({...hydrate(p.config),...(p.factoryState?{replayState:hydrate(p.factoryState)}:{})});result=await(p.method==='$call'?api(...args):api[p.method](...args));}else result=await mod[p.method](...args);}catch(e){error=e;}
  if(typeof error?.code==='string'&&error.code.startsWith('REPLAY_'))throw error;
  if(!p.error&&error&&[400,403,409].includes(error.status))throw gap('CAPTURE_NEWLY_REFUSED');
  if(p.error&&!error)throw gap('CAPTURE_NEWLY_ACCEPTED');
  if(cursor!==p.calls.length)throw gap('CAPTURE_CALLS_UNUSED');
  if(p.error){if(!error)throw gap('CAPTURE_NEWLY_ACCEPTED');if(digest(errorShape(error))!==digest(p.error))throw gap('CAPTURE_OUTCOME_CHANGED');}
  else if(error){if([400,403,409].includes(error.status))throw gap('CAPTURE_NEWLY_REFUSED');throw gap('CAPTURE_OUTCOME_CHANGED');}
  else if(digest(encode(result))!==digest(p.result))throw gap('CAPTURE_OUTCOME_CHANGED');
  return {same:true,refused:!!p.error||p.result?.ok===false||p.result?.status==='refused'||p.result?.outcome==='rejected',bodyHash:envelope.bodyHash,calls:cursor};
 });
}
module.exports={captureFactory,captureFunction,replayCaptured,unpack,encode,decode,digest,withCaptureSink:(sink,fn)=>control.run({sink},fn),MAX_RAW,MAX_STORED,SLOTS,TTL_SECONDS};
