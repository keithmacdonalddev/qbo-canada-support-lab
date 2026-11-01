'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os');
const root=path.resolve(__dirname,'../..'),modules=process.env.BF7_MODULE_ROOT || path.join(root,'backend/src/modules');
const {createBankingOperator}=require(path.join(modules,'banking-operator'));
const R=require(path.join(modules,'banking-operator-resolution'));
const L=require(path.join(modules,'banking-operator-loop'));
const {hash}=require(path.join(root,'backend/src/modules/banking-workspace-service'));
const stop=require('./fixtures/banking-bl-real-stop.json');
const user={id:'2'.repeat(24),role:'supervisor'};
function harness(){
 const journal={...structuredClone(stop.journal),status:'blocked',result:structuredClone(stop.result),finishedAt:'2026-11-01T06:00:00Z'};
 const pkg={id:journal.packageId,accountId:journal.accountId,accountCurrency:'CAD',snapshot:{scope:journal.scope},evidence:{imports:[]}};
 let pause={packageId:pkg.id,accountId:pkg.accountId,reason:stop.result.reason,at:journal.finishedAt};
 const deps={workspace:{detail:async(_u,id)=>{assert.equal(id,pkg.id);return pkg;}},getAccount:async()=>{},journal:{list:async()=>[structuredClone(journal)],finish:async v=>Object.assign(journal,structuredClone(v))},runner:{},lease:async()=>async()=>{},readVerification:async()=>{},authorize:async()=>{},authorizeOwner:async({user:u})=>{if(u.role!=='supervisor')throw Object.assign(new Error('Owner required'),{code:'BANKING_RESUME_FORBIDDEN',status:403});},verifyRunStopped:async()=>({processesVerifiedAbsent:true}),now:()=>Date.parse('2026-11-01T08:00:00Z')};
 const pauseStore={read:async()=>pause,clear:async expected=>{assert.deepEqual(pause,expected);pause=null;}};
 return {journal,pkg,deps,pauseStore,get pause(){return pause;},operator:()=>createBankingOperator(deps)};
}
test('owner resume HTTP authenticates, refuses nonowners, overrides and missing reasons, audits exact real stop before clear',async()=>{
 const h=harness(),express=require('express'),jwt=require('jsonwebtoken'),config=require('../src/config');
 const route=process.env.BF7_ROUTE_FILE || path.join(root,'backend/src/routes/banking-workspace');
 const app=express();app.use(express.json());app.use('/api/company/banking-workspace',require(route).createBankingWorkspaceRouter({service:h.deps.workspace,operator:h.operator(),pauseStore:h.pauseStore}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port+'/api/company/banking-workspace/operator/resume',body={packageId:h.pkg.id,resolution:{reason:'New contract no longer requires internal rule IDs'}};
 const send=async(role,payload=body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(role?{Authorization:'Bearer '+jwt.sign({id:user.id,role},config.jwtSecret)}:{})},body:JSON.stringify(payload)});
 try{
  assert.equal((await send(null)).status,401);assert.equal((await send('agent')).status,403);assert.ok(h.pause);
  assert.equal((await send('supervisor',{...body,realmId:'other'})).status,400);
  assert.equal((await send('supervisor',{...body,resolution:{reason:''}})).status,409);
  const response=await send('supervisor');assert.equal(response.status,200);assert.equal((await response.json()).data.resolved,true);assert.equal(h.pause,null);assert.equal(h.journal.resolutions[0].actorId,user.id);assert.equal(h.journal.result.reason,stop.result.reason);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('possible native effects require fresh exact observed no-effect inspection plus retained screenshot; never clear interrupted import',async()=>{
 for(const mode of ['none','attested','wrong-run','stale','changed','accepted','interrupted','valid']){
  const h=harness();h.journal.step={type:'review',rowId:'row-1'};h.journal.result.step='review';h.journal.result.actionLedger=[{action:'match',rowId:'row-1'}];
  const prefix=hash(h.journal.scope)+'/60/',screen={path:prefix+'inspection.png',sha256:'b'.repeat(64)},artifact={path:prefix+'inspection.json',sha256:'a'.repeat(64)};
  const value={kind:'banking-read-only-inspection',version:1,scope:h.journal.scope,runId:h.journal.runId,packageId:h.pkg.id,accountId:'60',period:h.journal.period,readOnly:true,strength:'screen observed',actionLedger:[],acceptedActions:[],outcome:'no-native-effect',summary:'Observed unchanged review row and account state',observedAt:'2026-11-01T07:00:00Z',screenshot:screen};
  if(mode==='attested')value.strength='operator attested';if(mode==='wrong-run')value.runId='another';if(mode==='stale')value.observedAt='2020-01-01T00:00:00Z';if(mode==='accepted'){value.outcome='accepted';value.acceptedActions=[{id:'retained'}];}if(mode==='interrupted')h.pkg.evidence.imports=[{status:'started'}];
  let reads=0;h.deps.readReportArtifact=async ref=>{reads++;if(mode==='changed')throw new Error('hash changed');return ref.path===artifact.path?Buffer.from(JSON.stringify(value)):Buffer.from('SCREEN');};
  const execute=()=>h.operator().resolvePause(user,{packageId:h.pkg.id,pause:h.pause,resolution:{reason:'Inspected native state',...(mode==='none'?{}:{inspection:artifact})},clearPause:v=>h.pauseStore.clear(v)});
  if(mode==='valid'){assert.equal((await execute()).resolved,true);assert.equal(h.journal.resolutions[0].inspection.outcome,'no-native-effect');assert.equal(reads,2);}else{await assert.rejects(execute());assert.ok(h.pause);assert.equal(h.journal.status,'blocked');assert.deepEqual(h.journal.result.actionLedger,[{action:'match',rowId:'row-1'}]);}
 }
});
test('pause clear compares exact bytes logically and keeps a replacement stop',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bl2-cas-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=L.filePauseStore(path.join(dir,'pause.json'));
 const a={packageId:'one',reason:'original'},b={...a,reason:'new'};await store.write(a);await assert.rejects(store.clear(b),/pause changed/);assert.deepEqual(await store.read(),a);await store.clear(a);assert.equal(await store.read(),null);
});
test('only active lab-owner membership grants owner resume even if token is supervisor',async()=>{
 const Module=require('node:module'),old=Module._load;
 let membership={role:'operator',status:'active'};
 Module._load=function(id,parent,isMain){if(id==='../models/CompanyMembership' && parent.filename.endsWith('banking-operator-resolution.js'))return {findOne:()=>({select(){return this;},maxTimeMS(){return this;},lean:async()=>membership})};return old.call(this,id,parent,isMain);};
 try{await assert.rejects(R.assertOwner({user,scope:stop.journal.scope}),/owner role/);membership={role:'lab-owner',status:'suspended'};await assert.rejects(R.assertOwner({user,scope:stop.journal.scope}));membership={role:'lab-owner',status:'active'};await R.assertOwner({user,scope:stop.journal.scope});}finally{Module._load=old;}
});

test('multiple unresolved stops cannot take automatic retries beyond three in one resolution batch',async()=>{
 const h=harness();h.journal.resolutions=[{mode:'automatic'},{mode:'automatic'}];const second={...structuredClone(h.journal),runId:'bf7-another',resolutions:[],result:{...structuredClone(h.journal.result),runId:'bf7-another'}};
 h.deps.journal.list=async()=>[structuredClone(h.journal),structuredClone(second)];
 const out=await h.operator().resolvePause(user,{packageId:h.pkg.id,pause:h.pause,automatic:true,clearPause:v=>h.pauseStore.clear(v)});
 assert.equal(out.resolved,false);assert.equal(out.automaticRetry.attempts,3);assert.ok(h.pause);assert.equal(h.journal.status,'blocked');
});

test('loop diagnostics expose real-stop retry eligibility and process verification refusal without another company leak',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bl2-status-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const p={id:stop.journal.packageId,accountId:'60',accountCurrency:'CAD',snapshot:{scope:stop.journal.scope}};
 const pause={packageId:p.id,accountId:'60',reason:stop.result.reason,at:stop.journal.startedAt};
 await L.filePauseStore(path.join(dir,'artifacts/banking/operator-loop-paused.json')).write(pause);
 await L.fileStateStore(path.join(dir,'artifacts/banking/operator-loop-state.json')).write({packageId:p.id,lastOutcome:{status:'blocked',packageId:p.id,recoveryReason:'Cannot verify live banking processes; locks retained'}});
 const O=require(path.join(modules,'banking-operator'));await O.createFileJournal(path.join(dir,'artifacts/banking/operator-journal')).start({...stop.journal,status:'blocked',result:stop.result});
 const status=await L.readBankingLoopStatus({root:dir,packages:[p],enabled:true});assert.equal(status.automaticRetry.eligible,true);assert.equal(status.requiresInspection,false);assert.match(status.recoveryReason,/Cannot verify/);assert.equal(status.resumeAvailable,true);
 const hidden=await L.readBankingLoopStatus({root:dir,packages:[],enabled:true});assert.equal(hidden.automaticRetry,null);assert.equal(hidden.recoveryReason,null);assert.equal(hidden.resumeAvailable,false);
});
