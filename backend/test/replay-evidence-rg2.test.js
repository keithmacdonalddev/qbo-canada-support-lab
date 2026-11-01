'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const capture=require('../src/modules/business-replay-evidence');
const load=name=>require('../src/modules/'+name);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const filename=path.join(__dirname,'general-write-gate.test.js'),fixtureModule=new Module(filename,module);
 fixtureModule.filename=filename;fixtureModule.paths=Module._nodeModulePaths(__dirname);
 const source=fs.readFileSync(filename,'utf8').split("\ntest('a general batch")[0];
 fixtureModule._compile(source+'\nmodule.exports={harness,answered};',filename);return fixtureModule.exports;
}
async function record(fn){
 const rows=[];const value=await capture.withCaptureSink(e=>rows.push(e),()=>fn());await tick();await tick();return {rows,value};
}
test('real gate admits and settles; exact adapter transcript replays without writes',async()=>{
 const {harness,answered}=fixture(),h=harness();
 h.data.Connections[0].accessToken='never-retain-access';
 h.data.Connections[0].refreshToken='never-retain-refresh';
 const {rows}=await record(async()=>{const gate=h.gateFor(),ticket=await h.begin(gate);await gate.complete(ticket,h.request(),answered,'tid');});
 const decisions=rows.filter(e=>e.boundary.startsWith('qbo-write-gate:'));
 assert.equal(decisions.length,2);
 for(const e of rows){
  const raw=JSON.stringify(capture.unpack(e));assert.ok(!raw.includes('never-retain-'));
  assert.ok(e.operationIds.includes('d'.repeat(24)));
  assert.equal((await capture.replayCaptured(e,load)).same,true);
 }
});
test('captured refusal stays a refusal; changed and unused dependencies fail replay',async()=>{
 const {harness}=fixture(),h=harness();h.data.Policies[0].state='paused';
 const {rows}=await record(async()=>{await assert.rejects(h.gateFor().begin({request:h.request(),ownerId:'b'.repeat(24),actorId:'b'.repeat(24),workflow:{version:1,kind:'general-write',runId:'d'.repeat(24),batchIndex:0,sends:1}}));});
 assert.equal(rows.length,1);assert.equal((await capture.replayCaptured(rows[0],load)).refused,true);
 const changed=name=>name==='qbo-write-gate'?{createQboWriteGate:()=>({begin:async()=>({accepted:true})})}:load(name);
 await assert.rejects(capture.replayCaptured(rows[0],changed),{code:'REPLAY_CAPTURE_NEWLY_ACCEPTED'});
});
test('failed and hung capture sinks cannot reject or delay a decision',async()=>{
 const {harness}=fixture(),h=harness();
 await capture.withCaptureSink(()=>new Promise(()=>{}),async()=>{const gate=h.gateFor();assert.equal((await h.begin(gate)).kind,'general-write');});
 await capture.withCaptureSink(()=>{throw new Error('private');},async()=>{const second=harness();assert.equal((await second.begin(second.gateFor())).kind,'general-write');});
 await tick();
});
test('secret fields in JSON, size limits, corruption, TTL and slot cap are explicit',async()=>{
 const encoded=capture.encode({body:JSON.stringify({apiKey:'never-retain',value:12}),refreshToken:'secret'});
 assert.ok(!JSON.stringify(encoded).includes('never-retain'));assert.ok(!JSON.stringify(encoded).includes('"secret"'));
 assert.throws(()=>capture.encode('x'.repeat(capture.MAX_RAW+1)),{code:'REPLAY_CAPTURE_SIZE_LIMIT'});
 assert.equal(capture.TTL_SECONDS,30*86400);assert.equal(capture.SLOTS*capture.MAX_STORED,2147483648);
 const {setupDefinition,exactIndex}=require('../src/modules/business-storage-setup');
 const profile=setupDefinition('replay-evidence');assert.equal(profile.version,7);assert.equal(profile.collections[0].name,'businessreplayevidences');
 const ttl=profile.collections[0].indexes[0];assert.equal(exactIndex(ttl,ttl),true);assert.equal(exactIndex({...ttl,expireAfterSeconds:10},ttl),false);
 assert.equal(exactIndex({...ttl,expireAfterSeconds:10},{key:ttl.key}),false);
 const {harness}=fixture(),h=harness(),{rows}=await record(()=>h.begin(h.gateFor()));
 await assert.rejects(capture.replayCaptured({...rows.find(e=>e.boundary==='qbo-write-gate:begin'),bodyHash:'0'.repeat(64)},load),{code:'REPLAY_CAPTURE_HASH_MISMATCH'});
});

test('full graph cursor, writer fence and independent read-back bodies replay exactly',async()=>{
 const filename=path.join(__dirname,'business-graph-readback.test.js'),fm=new Module(filename,module);
 fm.filename=filename;fm.paths=Module._nodeModulePaths(__dirname);
 fm._compile(fs.readFileSync(filename,'utf8').split("\nfor (const kind of ['sales', 'purchase']) test")[0]+'\nmodule.exports={harness};',filename);
 const h=fm.exports.harness(),{rows,value}=await record(()=>h.reader());
 assert.equal(value.complete,true);
 const evidence=rows.find(e=>e.boundary==='business-graph-readback:$call');assert.ok(evidence);
 const payload=capture.unpack(evidence);
 assert.ok(payload.calls.some(e=>e.port.includes('.cursor.next')&&e.value?.compilation));
 assert.ok(payload.calls.some(e=>e.port==='config.readFence'));
 assert.equal((await capture.replayCaptured(evidence,load)).same,true);
});
test('close captures its exact ledger and gathered versions, then recomputes offline',async()=>{
 const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)},day='2026-11-01';
 const input={scope,day,ctx:{accountKey:id=>String(id)},gathered:{records:[],dirty:[],ownSettlements:[],runVersions:[{id:'d'.repeat(24)}]},ledgerReport:{Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',StartPeriod:day,EndPeriod:day},Columns:{Column:['tx_date','txn_type','debt_amt','credit_amt'].map(ColType=>({ColType}))},Rows:{Row:[]}}};
 const {rows,value}=await record(()=>load('general-write-day-close').closeGeneralDay(input));
 assert.equal(value.ok,true);assert.equal(rows.length,1);assert.ok(rows[0].operationIds.includes('d'.repeat(24)));
 assert.equal((await capture.replayCaptured(rows[0],load)).same,true);
});

test('parallel read-backs retain out-of-order completion without a false regression',async()=>{
 const filename=path.join(__dirname,'business-graph-readback.test.js'),fm=new Module(filename,module);
 fm.filename=filename;fm.paths=Module._nodeModulePaths(__dirname);
 fm._compile(fs.readFileSync(filename,'utf8').split("\nfor (const kind of ['sales', 'purchase']) test")[0]+'\nmodule.exports={harness};',filename);
 const h=fm.exports.harness();
 h.onRead=async(entity)=>new Promise(resolve=>setTimeout(resolve,entity==='Estimate'?15:entity==='TimeActivity'?1:4));
 const {rows}=await record(()=>h.reader());
 const e=rows.find(e=>e.boundary==='business-graph-readback:$call');assert.ok(e);
 assert.equal((await capture.replayCaptured(e,load)).same,true);
});
test('transaction callback retry replays every original attempt without database access',async()=>{
 const {harness}=fixture(),h=harness();let first=true;
 const read=h.models.Users.findOne;
 h.models.Users.findOne=(...a)=>{if(!first)return read(...a);first=false;return {select(){return this;},session(){return this;},maxTimeMS(){return this;},async lean(){throw Object.assign(new Error('transient test'),{code:'TRANSIENT_TEST'});}};}; 
 h.transaction=async work=>{try{return await work({inTransaction:()=>true});}catch{return work({inTransaction:()=>true});}};
 const {rows}=await record(()=>h.begin(h.gateFor()));
 const e=rows.find(e=>e.boundary==='qbo-write-gate:begin');assert.ok(e);
 assert.equal(capture.unpack(e).calls.find(c=>c.transaction).sessions.length,2);
 assert.equal((await capture.replayCaptured(e,load)).same,true);
});
test('actual boundary descriptors redact nested and header credential fields',async()=>{
 const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)};
 const input={scope,apiKey:'sentinel-api',access_token:'sentinel-access',headers:{authorization:'sentinel-auth','set-cookie':'sentinel-cookie'},credentials:{nested:'sentinel-nested'}};
 const {rows,value}=await record(()=>capture.captureFunction('test','echo',v=>v.scope,[input]));
 assert.deepEqual(value,scope);assert.equal(rows.length,1);
 assert.ok(!JSON.stringify(capture.unpack(rows[0])).includes('sentinel-'));
});
test('partial captured coverage lists missing boundaries and still rejects a changed decision',async()=>{
 const {harness}=fixture(),h=harness(),{rows}=await record(()=>h.begin(h.gateFor()));
 const {replayEvidence}=require('./replay/captured.cjs');
 const sources={};for(const name of fs.readdirSync(path.join(__dirname,'../src/modules')).filter(n=>n.endsWith('.js')))sources['backend/src/modules/'+name]=fs.readFileSync(path.join(__dirname,'../src/modules',name),'utf8');
 for(const [file,source]of Object.entries(global.__rg2Sources||{}))if(file.replaceAll('\\','/').includes('/backend/src/modules/'))sources['backend/src/modules/'+path.basename(file)]=source;
 const report=await replayEvidence({root:path.resolve(__dirname,'../..'),data:{__replaySources:sources},run:h.run(),evidence:rows.filter(e=>e.boundary==='qbo-write-gate:begin'),features:{}});
 assert.equal(report.outcome,'same outcome',JSON.stringify(report));assert.equal(report.coverage,'captured-decisions-only');
 assert.ok(report.missingEvidence.some(e=>e.stage==='general-write-day-close:closeGeneralDay'));
 const changed=await replayEvidence({root:path.resolve(__dirname,'../..'),data:{__replaySources:sources},run:h.run(),evidence:rows.filter(e=>e.boundary==='qbo-write-gate:begin'),features:{},transform:(file,source)=>file.endsWith('qbo-write-gate.js')?source.replace("initial.policy.state !== 'active'", "initial.policy.state === 'active'"):source});
 assert.ok(['newly refused','errored'].includes(changed.outcome));
});

test('oversized contextFor capture cannot block successful admission work',async()=>{
 const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)},large='x'.repeat(capture.MAX_RAW+1);
 const api=capture.captureFactory('fixture','make',config=>({guard:async input=>config.contextFor({scope,...input})}),{contextFor:async()=>({ok:true,large})},['guard']);
 const {value}=await record(()=>api.guard({scope,large}));
 assert.equal(value.ok,true);assert.equal(value.large,large);
});
test('fixed close captures and replays retained reports through the isolated runtime',async()=>{
 const filename=path.join(__dirname,'business-period-evidence.test.js'),fm=new Module(filename,module);
 fm.filename=filename;fm.paths=Module._nodeModulePaths(__dirname);
 fm._compile(fs.readFileSync(filename,'utf8').split("\ntest('runner completes")[0]+'\nmodule.exports={harness};',filename);
 const h=fm.exports.harness(0),{rows,value}=await record(()=>h.execute());assert.equal(value.complete,true);
 const closes=rows.filter(e=>e.boundary.startsWith('business-period-'));assert.ok(closes.some(e=>e.boundary==='business-period-evidence:prepareEvidence'));
 const sources={};for(const name of fs.readdirSync(path.join(__dirname,'../src/modules')).filter(n=>n.endsWith('.js')))sources['backend/src/modules/'+name]=fs.readFileSync(path.join(__dirname,'../src/modules',name),'utf8');
 for(const[file,source]of Object.entries(global.__rg2Sources||{}))if(file.replaceAll('\\','/').includes('/backend/src/modules/'))sources['backend/src/modules/'+path.basename(file)]=source;
 const {createRuntime}=require('./replay/runtime.cjs');
 for(const evidence of closes){
  const rt=createRuntime({root:path.resolve(__dirname,'../..'),data:{__replaySources:sources},run:h.run(),at:h.clock});
  assert.equal((await rt.current('business-replay-evidence').replayCaptured(evidence,rt.current)).same,true,evidence.boundary);
 }
});

test('ordinary general admission refusal replays through isolated MongoError type checks',async()=>{
 for(const mongo of [false,true]) {
 const {harness}=fixture(),h=harness();h.service.guardBatch=async()=>{throw mongo?Object.assign(new (require('mongoose').mongo.MongoError)('write conflict fixture'),{code:112}):Object.assign(new Error('General batch admission refused: fixture'),{status:409,code:'GENERAL_WRITE_REFUSED'});};
 const {rows}=await record(async()=>{await assert.rejects(h.begin(h.gateFor()));});
 const sources={};for(const name of fs.readdirSync(path.join(__dirname,'../src/modules')).filter(n=>n.endsWith('.js')))sources['backend/src/modules/'+name]=fs.readFileSync(path.join(__dirname,'../src/modules',name),'utf8');
 for(const[file,source]of Object.entries(global.__rg2Sources||{}))if(file.replaceAll('\\','/').includes('/backend/src/modules/'))sources['backend/src/modules/'+path.basename(file)]=source;
 const {createRuntime}=require('./replay/runtime.cjs'),transport=rows.find(e=>e.boundary==='general-write-transport:admit');
 assert.ok(transport);
 const rt=createRuntime({root:path.resolve(__dirname,'../..'),data:{__replaySources:sources},run:h.run(),at:h.clock});
 assert.equal((await rt.current('business-replay-evidence').replayCaptured(transport,rt.current)).refused,true);
 }
});
