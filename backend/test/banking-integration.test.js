'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(process.cwd(),'..'),from=p=>require(path.join(process.env.BF7_MODULE_ROOT || path.join(root,'backend/src/modules'),p));
const {createBankingOperatorLoop}=from('banking-operator-loop');
const {createBankingAccountantTools,createBankingMirrorReader}=from('banking-accountant-tools');
const {hash,createBankingWorkspaceService}=from('banking-workspace-service');
const history=require(path.join(root,'backend/test/fixtures/bank-settlement-history.json'));
const retained=require(path.join(root,'backend/test/fixtures/bank-opening-history-evidence.json'));
const {dataset,evidence}=from('bank-statement-evidence').buildBankStatementEvidence(history,retained);
const generated=from('bank-statement-package').generateBankStatementPackages(dataset,{balanceEvidence:evidence});
const user={id:'2'.repeat(24),role:'supervisor'},scope=history.scope;
const fakeQuery=v=>({maxTimeMS(){return this;},limit(){return this;},lean:async()=>structuredClone(v)});
function loopHarness(rows){let saved=null,executed=[],busy=false,enabled=true;const details=new Map(rows.map(p=>[p.id,p]));const workspace={list:async()=>({packages:rows,truncated:false}),detail:async(_u,id)=>details.get(id)};const operator={status:async()=>({blocked:false,steps:[]}),execute:async(_u,v)=>{executed.push(v);return {runId:'fake'};}};const pauseStore={read:async()=>saved,write:async v=>{saved=v;}};const opts={workspace,operator,listUsers:async()=>[user],enabled:()=>enabled,isTerraBusy:async()=>busy,pauseStore};return {opts,operator,executed,setBusy:v=>busy=v,setEnabled:v=>enabled=v,get saved(){return saved;}};}
const pkg=(id,accountId,period,revision=1)=>({id,accountId,period,revision,summary:{reconciled:false},snapshot:{blockers:[],files:[{kind:'csv',fileId:'csv-'+id}],rows:[]},evidence:{imports:[],rows:{}}});
test('loop processes oldest month first, serially and only one step per tick',async()=>{
 const h=loopHarness([pkg('new','60','2026-10'),pkg('old','85','2023-08')]),loop=createBankingOperatorLoop(h.opts);let release;h.operator.execute=async(_u,v)=>{h.executed.push(v);await new Promise(r=>release=r);return {runId:'fake'};};const a=loop.tick(),b=loop.tick();while(!release)await new Promise(r=>setImmediate(r));assert.equal(h.executed.length,1);assert.equal(h.executed[0].packageId,'old');release();await Promise.all([a,b]);assert.equal(loop.status().status,'progress');
});
test('loop honours Terra lock and disabled state, retains durable pause across construction',async()=>{
 const h=loopHarness([pkg('one','60','2023-08')]);let loop=createBankingOperatorLoop(h.opts);h.setBusy(true);assert.equal((await loop.tick()).status,'waiting');assert.equal(h.executed.length,0);h.setBusy(false);h.setEnabled(false);assert.equal((await loop.tick()).status,'disabled');h.setEnabled(true);h.operator.execute=async()=>{throw new Error('Exact duplicate Deposit11232');};assert.equal((await loop.tick()).status,'blocked');assert.match(h.saved.reason,/11232/);loop=createBankingOperatorLoop(h.opts);assert.equal((await loop.tick()).status,'blocked');
});
test('blocked oldest period pauses instead of skipping to a newer or different account',async()=>{
 const old=pkg('old','60','2020-07');old.snapshot.blockers=['Existing reconciled marks require inspection'];const h=loopHarness([pkg('new','85','2026-10'),old]);assert.equal((await createBankingOperatorLoop(h.opts).tick()).status,'blocked');assert.equal(h.executed.length,0);
});
test('register real retained BF2 manifest through accountant tool -> BF4; close support retains limits',async t=>{
 const real=generated.packages.find(p=>p.envelope.accountId==='1150040007' && p.envelope.period==='2026-10'),artifacts=new Map(real.artifacts.map(a=>[a.path,Buffer.from(a.bytes)])),packages=new Map();
 const store={assertReady:async()=>{},transaction:async f=>f(null),fenceAccount:async()=>{},putEvent:async()=>{},insert:async r=>packages.set(r._id,r),get:async(_s,id)=>packages.get(id),list:async()=>[...packages.values()],replace:async()=>{throw new Error('No evidence mutation authorized by read tools');}};
 const workspace=createBankingWorkspaceService({store,resolveContext:async()=>({environment:scope.environment,connection:{connected:true,realmId:scope.realmId,connectionId:scope.connectionId}}),authorize:async()=>{},getAccount:async()=>({Id:'1150040007',Name:'Savings',AccountType:'Bank',CurrencyRef:{value:'CAD'}}),readArtifact:async a=>artifacts.get(a.path)});
 const tools=createBankingAccountantTools({workspace,readArtifact:async a=>artifacts.get(a.path)}),mf=real.envelope.files.find(f=>f.kind==='manifest');
 const registered=await tools.execute(user,'prepareBankingPackage',{manifest:{path:mf.path,sha256:mf.sha256}});assert.equal(registered.id,real.packageId);
 const detail=await tools.execute(user,'getBankingPackage',{packageId:real.packageId,section:'rows'});assert.equal(detail.items[0].source.id,'591');
 const close=await tools.execute(user,'getBankingCloseSupport',{period:'2026-10'});assert.equal(close.packages[0].reconciled,false);assert.equal(close.qboCalls,0);assert.match(close.limitation,/never synthesize manual/);
 t.diagnostic('Real Savings package '+real.packageId+' registered through production BF6 -> BF4; no native evidence manufactured.');
});
test('all four storage model collections and exact indexes have governed additive profiles',()=>{
 const setup=from('business-storage-setup');for(const [profile,model]of [['banking','BankingEvent'],['banking','BankingPackage'],['replay-evidence','BusinessReplayEvidence'],['close-checklist','BusinessCloseChecklistEvidence']]){
 const Model=require(path.join(root,'backend/src/models',model)),definition=setup.setupDefinition(profile),collection=definition.collections.find(c=>c.name===Model.collection.name);assert.ok(collection,model);for(const [key,options]of Model.schema.indexes()){const wanted=collection.indexes.find(i=>JSON.stringify(i.key)===JSON.stringify(key));assert.ok(wanted);assert.equal(!!wanted.unique,!!options.unique);assert.equal(wanted.expireAfterSeconds,options.expireAfterSeconds);if(options.name)assert.equal(wanted.name,options.name);}}
 assert.equal(setup.setupDefinition('continual-business').version,4);assert.equal(setup.setupDefinition('general-writes').version,6);
});
test('post-action mirror reader waits for real sync completion and never calls a provider',async()=>{
 let clock=Date.parse('2026-11-01T06:00:00Z'),waited=0;const startedAt=new Date(clock).toISOString(),sources=Object.fromEntries([...from('banking-operator-guards').TXNS].map(entity=>[entity,{status:'current',phase:'incremental',lastSuccessAt:new Date(clock+1000).toISOString(),since:new Date(clock-60000).toISOString()}]));
 const Agents={findOne:()=>fakeQuery({sync:{sources}})},Records={find:()=>fakeQuery([])};
 const reader=createBankingMirrorReader({Agents,Records,now:()=>clock,wait:async()=>{waited++;clock+=1000;for(const s of Object.values(sources)){s.lastSuccessAt=new Date(clock).toISOString();s.since=new Date(clock).toISOString();}}});
 const result=await reader({scope,phase:'after',startedAt});assert.equal(waited,1);assert.equal(result.complete,true);assert.ok(Date.parse(result.syncedThrough)>Date.parse(startedAt));
});
test('discovery exposes banking tools as deferred and source mounting does not activate a loop',()=>{
 const {createToolbox}=from('business-agent-toolbox'),tools=createBankingAccountantTools({workspace:{}}),box=createToolbox({definitions:tools.definitions,execute:async()=>({})});assert.equal(box.describe().core.includes('prepareBankingPackage'),false);assert.ok(box.searchTools({query:'banking statement reconciliation'}).data.tools.some(t=>t.name==='getBankingWorkspace'));
 const h=loopHarness([]);let timers=0;createBankingOperatorLoop({...h.opts,setTimer:()=>{timers++;return {};}});assert.equal(timers,0);
});

test('unwritable pause diagnostics stop this loop without a rejected timer promise',async()=>{
 const h=loopHarness([pkg('one','60','2023-08')]);let attempts=0;h.operator.execute=async()=>{attempts++;throw new Error('duplicate');};h.opts.pauseStore.write=async()=>{throw new Error('disk full');};const loop=createBankingOperatorLoop(h.opts);const first=await loop.tick();assert.equal(first.status,'blocked');assert.match(first.persistenceError,/could not be saved/);await loop.tick();assert.equal(attempts,1);
});
test('durable loop pause is exposed only with authorized package identities',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),L=from('banking-operator-loop');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bf6-pause-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await L.filePauseStore(path.join(dir,'artifacts/banking/operator-loop-paused.json')).write({packageId:'authorized',accountId:'60',reason:'Exact blocked Deposit11232',at:'2026-11-01T06:00:00Z'});
 const visible=await L.readBankingLoopStatus({root:dir,packages:[{id:'authorized'}],enabled:true});assert.match(visible.reason,/11232/);assert.match(visible.recovery,/Never replay/);const hidden=await L.readBankingLoopStatus({root:dir,packages:[],enabled:true});assert.equal(hidden.packageId,null);assert.ok(!hidden.reason.includes('11232'));
});

test('authenticated workspace HTTP response exposes durable loop pause; rejects scope overrides',async()=>{
 const express=require(path.join(root,'node_modules/express')),jwt=require(path.join(root,'node_modules/jsonwebtoken')),config=require(path.join(root,'backend/src/config'));
 const {createBankingWorkspaceRouter}=require(path.join(root,'backend/src/routes/banking-workspace'));let reads=0;
 const app=express();app.use('/banking',createBankingWorkspaceRouter({service:{list:async()=>({packages:[{id:'allowed'}],truncated:false})},readLoopStatus:async({packages})=>{reads++;assert.equal(packages[0].id,'allowed');return {paused:true,reason:'Exact test block'};}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const token=jwt.sign({id:user.id,role:user.role},config.jwtSecret),url='http://127.0.0.1:'+server.address().port+'/banking',headers={Authorization:'Bearer '+token};assert.equal((await fetch(url)).status,401);assert.equal(reads,0);const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal((await response.json()).data.operatorLoop.paused,true);assert.equal((await fetch(url+'?realmId=other',{headers})).status,400);assert.equal(reads,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
