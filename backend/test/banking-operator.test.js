'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const os=require('node:os');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const root=path.resolve(process.cwd(),'..');
const modules=process.env.BF7_MODULE_ROOT || path.join(root,'backend/src/modules');
const {createBankingOperator,buildBankingTask,parseTerraReply,createFileJournal}=require(path.join(modules,'banking-operator'));
const {createTerraRunner,acquireOperatorLease}=require(path.join(modules,'banking-terra-runner'));
const {createBankingWorkspaceService,hash}=require(path.join(root,'backend/src/modules/banking-workspace-service'));
const {buildBankStatementEvidence}=require(path.join(root,'backend/src/modules/bank-statement-evidence'));
const {generateBankStatementPackages}=require(path.join(root,'backend/src/modules/bank-statement-package'));
const history=require(path.join(root,'backend/test/fixtures/bank-settlement-history.json'));
const retained=require(path.join(root,'backend/test/fixtures/bank-opening-history-evidence.json'));
const replies=require(path.join(__dirname,'fixtures/banking-terra-replies.json'));
const clone=v=>structuredClone(v);
const built=buildBankStatementEvidence(history,retained);
const generated=generateBankStatementPackages(built.dataset,{balanceEvidence:built.evidence});
const real=generated.packages.find(p=>p.envelope.events.some(e=>e.source.entity==='Payment' && e.source.id==='26'));
const user={id:'2'.repeat(24),actorId:'3'.repeat(24),role:'supervisor'};
const digest=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
async function harness(input=real) {
  const source=clone(input), scope=source.envelope.scope, accountId=source.envelope.accountId;
  let clock=Date.parse('2026-11-01T06:00:00Z'), lost=false, denied=false, calls=0, leaseHeld=false;
  const now=()=>new Date(clock).toISOString(), packages=new Map(), journals=[], artifacts=new Map(), records=[];
  for(const a of source.artifacts) artifacts.set(a.path,Buffer.from(a.bytes));
  const account={Id:accountId,Name:'Replay account '+accountId,AccountType:source.envelope.balanceConvention==='card-amount-owed'?'Credit Card':'Bank',CurrencyRef:{value:source.envelope.accountCurrency}};
  const store={assertReady:async()=>{},transaction:async f=>f('session'),fenceAccount:async()=>{},putEvent:async()=>{},insert:async r=>packages.set(r._id,clone(r)),get:async(_s,id)=>clone(packages.get(id)),list:async(_s,filter={})=>[...packages.values()].filter(r=>Object.entries(filter).every(([k,v])=>r[k]===v)).map(clone),replace:async(_s,id,version,state)=>{const r=packages.get(id);if(r.stateVersion!==version)return false;r.state=clone(state);r.stateVersion++;return true;}};
  const workspace=createBankingWorkspaceService({store,now,resolveContext:async()=>({environment:scope.environment,connection:{connected:true,realmId:scope.realmId,connectionId:scope.connectionId}}),authorize:async()=>{},getAccount:async()=>account,readArtifact:async a=>{const b=artifacts.get(a.path);assert.ok(b);assert.equal(digest(b),a.sha256);return b;},findSyncedRecord:async(_s,r)=>records.find(b=>b.entity===r.entity && b.qboId===r.id)});
  let pkg=await workspace.register(user,source.envelope);
  const journal={list:async()=>clone(journals),start:async j=>journals.push(clone(j)),finish:async j=>{journals[journals.findIndex(r=>r.runId===j.runId)]=clone(j);}};
  const runner={retainInput:async file=>'C:/retained/'+file.path,retainEvidence:async(_run,name,{runId})=>{assert.ok(name);const p=hash(scope)+'/'+accountId+'/operator/'+runId+'/'+name,b=Buffer.from('FAKE SCREENSHOT '+name);artifacts.set(p,b);return {path:p,sha256:digest(b)};},run:async({task})=>{
    calls++;clock+=1000;
    if(lost)throw new Error('Lost Terra process connection');
    const d=task.data,type=d.step.type;
    const value={...clone(replies[type]),kind:'banking-operator-result',version:1,runId:d.runId,packageId:d.packageId,step:type,scope,accountId,accountCurrency:d.account.currency,period:d.period,companyVerified:{realmId:scope.realmId,name:'My Business'},screenshot:type+'.jpg'};
    if(type==='preflight')value.rulesInspection={scope,accountId,complete:true,observedAt:now(),screenshot:'rules.jpg',rules:[]};
    if(type==='upload') {const file=source.envelope.files.find(f=>f.fileId===d.step.fileId);value.upload={fileId:file.fileId,fileHash:file.sha256,observedCount:file.rowCount,nativeRows:source.envelope.rows.filter(r=>r.fileId===file.fileId).map(r=>({rowId:r.rowId,nativeRowId:'native-'+r.rowNumber})),confirmation:'Recorded fake native import confirmation'};value.actionLedger=[{action:'upload',fileId:file.fileId}];}
    if(type==='review') {value.rows=d.rows.map(r=>({rowId:r.rowId,decision:r.action,qboRefs:r.qboRefs,reason:'Recorded exact fake row resolution',screenshot:'row-'+r.rowId+'.jpg'}));value.actionLedger=d.rows.map(r=>({action:r.action,rowId:r.rowId}));}
    if(type==='reconcile')value.reconciliation={completed:true,openingMinor:d.openingMinor,closingMinor:d.closingMinor,differenceMinor:0,outstandingItems:d.outstandingItems,statementEndingDate:d.statementEndingDate,completion:'zero.jpg',report:'native-report.jpg'};
    if(type==='attach'){const f=d.files.find(f=>f.kind==='statement');value.attachment.fileId=f.fileId;value.attachment.fileHash=f.sha256;Object.assign(value.actionLedger[0],{fileId:f.fileId,fileHash:f.sha256});}
    if(type==='rules'){value.rules=d.rules.map((r,i)=>({...clone(r),ruleId:r.ruleId || 'fake-rule-'+i}));value.actionLedger=value.rules.map(r=>({action:r.action,name:r.name,ruleId:r.ruleId}));}
    if(h.mutateReply)h.mutateReply(value,task);
    if(type==='preflight' && !value.rulesInspection.coverage)value.rulesInspection.coverage={filter:'all',includesActive:true,includesDisabled:true,totalRules:value.rulesInspection.rules.length,pages:[{page:1,pageCount:1,ruleCount:value.rulesInspection.rules.length,screenshot:'rules.jpg'}]};
    return {exitCode:0,cleanupConfirmed:!h.badCleanup,model:'gpt-6.1-terra',reply:JSON.stringify(value),commandAudit:{shell:0,flagged:0},replyPath:'fake-reply.json'};
  }};
  const readVerification=async ({phase,rows=[]})=>({scope,complete:true,observedAt:now(),syncedThrough:now(),records:clone(records),settlementEvents:[],marks:h.withMarks ? rows.map(r=>{const row=source.envelope.rows.find(b=>b.rowId===r.rowId),e=source.envelope.events.find(e=>e.eventId===row.eventId);return {scope,artifact:{path:hash(scope)+'/'+accountId+'/fake-report.json',sha256:'a'.repeat(64)},rowId:r.rowId,accountId,accountCurrency:source.envelope.accountCurrency,amountMinor:e.amountMinor,date:e.actualPostingDate || e.expectedPostingDate,qboRefs:r.qboRefs,mark:'C',observedAt:phase==='after'?now():'2020-01-01T00:00:00Z'};}) : []});
  const h={advance:ms=>clock+=ms,source,scope,account,workspace,store,packages,journal,journals,runner,records,artifacts,now,readVerification,get calls(){return calls;},get leaseHeld(){return leaseHeld;},lose:()=>lost=true,deny:()=>denied=true};
  const deps={workspace,getAccount:async()=>account,journal,runner,now,readVerification,readReportArtifact:async()=>Buffer.from('recorded fake scoped report'),authorize:async()=>{if(denied)throw new Error('Write denied');},lease:async()=>{assert.equal(leaseHeld,false);leaseHeld=true;return async()=>{leaseHeld=false;};}};
  h.deps=deps;h.operator=createBankingOperator(deps);h.pkg=pkg;
  h.exec=async (type,options={})=>{const step=typeof type==='string'?{type}:type;const result=await h.operator.execute(user,{packageId:pkg.id,step,...options});h.pkg=result.package;return result;};
  h.upload=async()=>{await h.exec('preflight');for(const f of source.envelope.files.filter(f=>f.kind==='csv'))await h.exec({type:'upload',fileId:f.fileId});};
  return h;
}
test('real stored Payment26 package replays through BF2 -> BF4 -> BF7 production execute with fake Terra',async t=>{
  const h=await harness();const e=h.source.envelope.events.find(e=>e.source.entity==='Payment' && e.source.id==='26');assert.equal(e.amountMinor,342349);assert.equal(real.envelope.period,'2023-08');
  await h.upload();h.withMarks=true;let reviewed;for(let i=0;i<12;i++)reviewed=await h.exec('review');assert.equal(reviewed.package.summary.matched,12);assert.equal(reviewed.verification.status,'observed');
  await h.exec('reconcile');assert.equal(h.pkg.summary.reconciled,false);const done=await h.exec('attach');assert.equal(done.package.summary.reconciled,true);assert.equal(done.verification.status,'Terra-reported only');assert.equal(h.calls,17);assert.ok(h.journals.every(j=>j.status==='completed'));assert.equal(h.leaseHeld,false);
  t.diagnostic('Real package '+real.packageId+' account 60 / 2023-08: 12 rows, Payment26 CAD3423.49; all native outcomes FAKE, no QBO/DB calls.');
});
test('task scopes CSV only, Company ID, persistent operator browser and deliberate rule Auto-post',async()=>{
  const h=await harness(), f=h.source.envelope.files.find(f=>f.kind==='csv');
  const task=buildBankingTask({pkg:h.pkg,manifest:h.source.manifest,account:h.account,step:{type:'upload',fileId:f.fileId},runId:'test',files:[f]});
  for(const text of ['9130357222392856','My Business','session qbo-ops','C:/Users/NewAdmin/.qbo-automation-profile','Upload ONLY the named CSV','Never upload a PDF','security-verification error','Banking > Rules'])assert.ok(task.prompt.includes(text));
  assert.throws(()=>buildBankingTask({pkg:h.pkg,manifest:h.source.manifest,account:{...h.account,Id:'85'},step:{type:'preflight'},runId:'test'}),/account/);
  assert.throws(()=>buildBankingTask({pkg:h.pkg,manifest:h.source.manifest,account:h.account,step:{type:'reconcile',extra:true},runId:'test'}),/Unsupported/);
  await h.upload();const rule={action:'create',name:'BF7 exact rule',accountId:h.account.Id,period:h.pkg.period,autoPost:false,conditions:[{field:'description',operator:'equals',value:'Simulated fee'}],categoryId:'7',taxTreatment:'out-of-scope'};
  const rules=buildBankingTask({pkg:h.pkg,manifest:h.source.manifest,account:h.account,step:{type:'rules'},runId:'r',rules:[rule]});assert.match(rules.prompt,/Auto-post defaults ON/);assert.equal(rules.data.rules[0].autoPost,false);
});
test('not-ready manifest and changed event evidence are refused before Terra',async()=>{
  const h=await harness();const m=clone(h.source.manifest);m.readyForNativeWork=false;assert.throws(()=>buildBankingTask({pkg:h.pkg,manifest:m,account:h.account,step:{type:'preflight'}}),/ready/);
  const p=clone(h.pkg);p.snapshot.events[0].amountMinor++;assert.throws(()=>buildBankingTask({pkg:p,manifest:h.source.manifest,account:h.account,step:{type:'preflight'}}),/event/);assert.equal(h.calls,0);
});
test('write permission and earlier unfinished account periods stop before launch',async()=>{
  const h=await harness();h.deny();await assert.rejects(h.exec('preflight'),/Write denied/);assert.equal(h.calls,0);
  // After a completed reconciliation, an unfinished month between it and this one still blocks.
  const x=await harness(), list=x.workspace.list;x.workspace.list=async(...a)=>{const v=await list(...a);v.packages.push({...v.packages[0],id:'done',period:'2023-06',summary:{reconciled:true}},{...v.packages[0],id:'older',period:'2023-07',summary:{reconciled:false}});return v;};await assert.rejects(x.exec('preflight'),/Earlier/);assert.equal(x.calls,0);
  // Before an account's first reconciliation, older months are covered by it and never block.
  const y=await harness(), list2=y.workspace.list;y.workspace.list=async(...a)=>{const v=await list2(...a);v.packages.push({...v.packages[0],id:'older',period:'2023-07',summary:{reconciled:false}});return v;};await y.exec('preflight');assert.equal(y.calls,1);
});
test('superseded earlier revision does not block its reconciled replacement',async()=>{
  const h=await harness(), list=h.workspace.list;h.workspace.list=async(...a)=>{const v=await list(...a);v.packages.push({...v.packages[0],id:'old',period:'2023-07',revision:1,summary:{reconciled:false}},{...v.packages[0],id:'new',period:'2023-07',revision:2,summary:{reconciled:true}});return v;};await h.exec('preflight');assert.equal(h.calls,1);
});
test('stopped at blocks account permanently; upload remains uncertain rather than retrying',async()=>{
  const h=await harness();await h.exec('preflight');h.mutateReply=(v,task)=>{if(task.data.step.type==='upload'){v.status='stopped';v.reason='confirmation policy';}};await assert.rejects(h.exec({type:'upload',fileId:h.source.envelope.files.find(f=>f.kind==='csv').fileId}),/stopped at/);assert.equal(h.journals.at(-1).status,'blocked');const status=await h.operator.status(user,h.pkg.id);assert.equal(status.blocked,true);assert.match(status.reasons[0].reason,/confirmation policy/);assert.equal((await h.workspace.detail(user,h.pkg.id)).evidence.imports[0].status,'started');const count=h.calls;await assert.rejects(h.exec('preflight'),/stopped, uncertain/);assert.equal(h.calls,count);
});
test('lost process keeps operator lease and durable blocked intent',async()=>{
  const h=await harness();h.lose();await assert.rejects(h.exec('preflight'),/Lost Terra/);assert.equal(h.leaseHeld,true);assert.equal(h.journals[0].status,'blocked');
});
test('missing screenshot, unexpected action and false company each block completion',async()=>{
  for(const mutate of [v=>v.screenshot=null,v=>v.actionLedger.push({action:'add',rowId:'unexpected'}),v=>v.companyVerified.realmId='99']){const h=await harness();h.mutateReply=mutate;await assert.rejects(h.exec('preflight'));assert.equal(h.journals.at(-1).status,'blocked');}
});
test('missing fresh report marks stays Terra-reported only, not observed',async()=>{
  const h=await harness();await h.upload();const result=await h.exec('review');assert.equal(result.verification.status,'Terra-reported only');assert.equal(result.package.summary.matched,1);
});
test('BF3 Add cannot be substituted for a Match or use another account',async()=>{
  const h=await harness();await h.upload();const p=clone(h.pkg),m=clone(h.source.manifest),event=p.snapshot.events[0];
  event.source={...event.source,entity:'BankOrigin'};event.resolution={...event.resolution,action:'Add',designatedCreator:'native-add'};event.expectedResolution='add';event.creator='native-add';m.events=clone(p.snapshot.events);
  const r={eventId:event.eventId,status:'native-task',scope:h.scope,sourceHash:event.source.sourceHash,nativeTask:{scope:h.scope,eventIds:[event.eventId],action:'Exclude',accountId:'wrong',accountCurrency:'CAD',amountMinor:event.amountMinor,postingDate:event.actualPostingDate || event.expectedPostingDate,creator:'native-add',createsBookkeeping:true}};
  assert.throws(()=>buildBankingTask({pkg:p,manifest:m,account:h.account,step:{type:'review'},resolutions:[r]}),/differs/);
});
test('file journal preserves blocked state across restart and global lease refuses overlap',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bf7-journal-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=createFileJournal(path.join(dir,'journal')),value={runId:'run-one',scope:real.envelope.scope,accountId:'60',status:'started'};await store.start(value);await store.finish({...value,status:'blocked'});assert.equal((await createFileJournal(path.join(dir,'journal')).list(value.scope,'60'))[0].status,'blocked');const release=await acquireOperatorLease(path.join(dir,'lease'));await assert.rejects(acquireOperatorLease(path.join(dir,'lease')),/Another/);await release();
});
test('runner uses hidden explicit flow wrapper args, model section and retained evidence boundaries',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bf7-runner-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const runId='bf7-11111111-1111-1111-1111-111111111111',out='artifacts/terra-live/'+runId+'-20261101-000000';await fs.mkdir(path.join(dir,out),{recursive:true});await fs.writeFile(path.join(dir,out,'reply.txt'),'recorded fake');let captured;
  const spawnProcess=(exe,args,opts)=>{captured={exe,args,opts};const c=new EventEmitter();c.pid=123;c.stdout=new PassThrough();c.stderr=new PassThrough();setImmediate(()=>{c.stdout.write('files in '+out+'/\n--- command audit: shell=0; flagged=0 ---\n--- Terra reply ---\n--- effective settings (thread fixture) ---\n"model":"gpt-6.1-terra"\n--- cleanup ---\nthis run\'s processes: none left\n');c.emit('close',0);});return c;};
  const runner=createTerraRunner({root:dir,spawnProcess});const execution=await runner.run({task:{prompt:'fake'},runId});assert.equal(execution.cleanupConfirmed,true);assert.equal(execution.model,'gpt-6.1-terra');assert.deepEqual(execution.commandAudit,{shell:0,flagged:0});assert.ok(captured.args.includes('--flow'));assert.equal(captured.opts.windowsHide,true);assert.equal(captured.opts.shell,false);
  const png=Buffer.from([137,80,78,71,13,10,26,10,1]);await fs.writeFile(path.join(dir,out,'screen.png'),png);const a=await runner.retainEvidence(execution,'screen.png',{scope:real.envelope.scope,accountId:'60',runId});assert.equal(a.sha256,digest(png));await assert.rejects(runner.retainEvidence(execution,'../screen.png',{}),/inside/);
});

test('every upload automatically obtains its own fresh Rules pre-flight',async()=>{
 const h=await harness();await h.exec('preflight');h.advance(301000);await h.exec({type:'upload',fileId:h.source.envelope.files.find(f=>f.kind==='csv').fileId});assert.equal(h.pkg.summary.uploaded,true);assert.equal(h.journals.filter(j=>j.step.type==='preflight').length,2);
});
function nativeAddPackage(){
 const {buildBankOriginEvents}=require(path.join(root,'backend/src/modules/bank-origin-events'));
 const day='2026-10-20',event=buildBankOriginEvents({scope:history.scope,accounts:history.accounts,scenarios:[{scenarioId:'bf7-fee',kind:'bank-fee',accountId:'123',currency:'CAD',bookDate:day,postingDate:day,amountMinor:2500,creator:'native-add',counterpartAccountId:'19',taxTreatment:'out-of-scope',advice:{basis:'simulated',reference:'bf7-recorded-fake-advice'},window:{start:day,end:day,unreconciled:true,evidenceRef:'recorded-fake-unreconciled-window'}}]}).events[0];
 const dataset={...clone(built.dataset),accounts:built.dataset.accounts.filter(a=>a.id==='123'),events:[event],unresolvedEvents:[],coverage:{issues:[]},provisionalRanges:[{accountId:'123',evidenceType:'bank-or-card-statement',provisionalStartMonth:'2026-10',provisionalEndMonth:'2026-10',periods:1}],asOf:'2026-10-31'};
 return generateBankStatementPackages(dataset,{openingBalances:[{accountId:'123',period:'2026-10',amountMinor:0,evidenceRef:'explicit-fake-opening',basis:'isolated native Add test fixture'}]}).packages[0];
}
test('native Add uses real BF3 resolver and BF4 synced proof; missing sync blocks without repeating Add',async()=>{
 const {prepareBankOriginResolution}=require(path.join(root,'backend/src/modules/bank-origin-resolution'));
 for(const synced of [true,false]){
  const h=await harness(nativeAddPackage()),event=h.source.envelope.events[0];
  h.deps.resolveRows=async({before})=>[prepareBankOriginResolution({event,accounts:history.accounts,reservations:[{scope:h.scope,eventId:event.eventId,accountId:'123',period:event.statementPeriod,creator:'native-add'}],mirrorSnapshot:before,asOf:h.now()})];
  h.operator=createBankingOperator(h.deps);await h.upload();h.mutateReply=(v,task)=>{if(task.data.step.type!=='review')return;v.rows[0].qboRefs=[{entity:'Purchase',id:'999999'}];if(synced)h.records.push({...h.scope,entity:'Purchase',qboId:'999999',deleted:false,lastObservedAt:h.now(),record:{Id:'999999',AccountRef:{value:'123'},CurrencyRef:{value:'CAD'},TotalAmt:25,TxnDate:event.actualPostingDate,MetaData:{CreateTime:h.now()}}});};
  if(synced){const result=await h.exec('review');assert.equal(result.package.summary.added,1);assert.equal(result.verification.status,'observed');}
  else {await assert.rejects(h.exec('review'),/not yet observed/);const calls=h.calls;await assert.rejects(h.exec('review'),/stopped, uncertain/);assert.equal(h.calls,calls);assert.equal(h.pkg.summary.added,0);}
 }
});
test('cross-company or future nested report marks cannot become observed',async()=>{
 for(const patch of [m=>m.scope={...m.scope,realmId:'99'},m=>m.observedAt='2099-01-01T00:00:00Z']){
  const h=await harness();await h.upload();h.withMarks=true;const read=h.deps.readVerification;h.deps.readVerification=async args=>{const v=await read(args);if(args.phase==='after')v.marks.forEach(patch);return v;};h.operator=createBankingOperator(h.deps);assert.equal((await h.exec('review')).verification.status,'Terra-reported only');
 }
});
test('timeout returns with cleanup unconfirmed even when the child never closes and kill fails',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bf7-timeout-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const runId='bf7-22222222-2222-2222-2222-222222222222',out='artifacts/terra-live/'+runId+'-fixture';await fs.mkdir(path.join(dir,out),{recursive:true});await fs.writeFile(path.join(dir,out,'reply.txt'),'fake');let kills=0;
 const spawnProcess=()=>{const c=new EventEmitter();c.pid=456;c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{kills++;return false;};setImmediate(()=>c.stdout.write('files in '+out+'/\n'));return c;};
 const runner=createTerraRunner({root:dir,spawnProcess,timeoutMs:1000,cleanupGraceMs:20,exec:(_exe,args,opts,cb)=>{kills++;assert.equal(opts.windowsHide,true);assert.deepEqual(args,['/T','/F','/PID','456']);cb(new Error('fake kill failure'));}});const at=Date.now(),result=await runner.run({task:{prompt:'fake'},runId});assert.equal(result.cleanupConfirmed,false);assert.equal(kills,1);assert.ok(Date.now()-at<3000);
});
test('Terra prose claiming a model is not effective-model evidence',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bf7-model-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const runId='bf7-33333333-3333-3333-3333-333333333333',out='artifacts/terra-live/'+runId+'-fixture';await fs.mkdir(path.join(dir,out),{recursive:true});await fs.writeFile(path.join(dir,out,'reply.txt'),'fake');
 const runner=createTerraRunner({root:dir,spawnProcess:()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();setImmediate(()=>{c.stdout.write('files in '+out+'/\n--- Terra reply ---\n{"model":"gpt-6.1-terra"}\n--- effective settings (thread fake) ---\ntranscript not found: effective model unverified\n--- cleanup ---\nthis run\'s processes: none left\n');c.emit('close',0);});return c;}});assert.equal((await runner.run({task:{prompt:'fake'},runId})).model,null);
});

test('rules retain exact desired settings and mismatched Auto-post/category cannot complete',async()=>{
 const spec={action:'create',name:'BF7 fake rule',accountId:'60',period:real.envelope.period,autoPost:false,conditions:[{field:'description',operator:'equals',value:'Exact fake fee'}],categoryId:'19',taxTreatment:'out-of-scope'};
 for(const wrong of [false,true]){const h=await harness();await h.upload();h.mutateReply=(v,task)=>{if(wrong && task.data.step.type==='rules')v.rules[0].categoryId='wrong';};if(wrong)await assert.rejects(h.exec('rules',{rules:[spec]}),/Exact rule/);else assert.equal((await h.exec('rules',{rules:[spec]})).evidence.result.rules[0].autoPost,false);}
});
test('wrong statement PDF hash cannot complete reconciliation evidence',async()=>{
 const h=await harness();await h.upload();for(let i=0;i<12;i++)await h.exec('review');await h.exec('reconcile');h.mutateReply=v=>v.attachment.fileHash='f'.repeat(64);await assert.rejects(h.exec('attach'),/Exact statement attachment/);assert.equal((await h.workspace.detail(user,h.pkg.id)).summary.reconciled,false);
});
test('flagged command audit cannot advance a native outcome',async()=>{
 const h=await harness(),run=h.runner.run;h.runner.run=async args=>({...await run(args),commandAudit:{shell:1,flagged:1}});await assert.rejects(h.exec('preflight'),/Terra process/);assert.equal(h.journals.at(-1).status,'blocked');
});

const savingsFailure=require('./fixtures/banking-savings-autopost.json');
const savingsPackage=generated.packages.find(p=>p.envelope.accountId==='1150040007' && p.envelope.period==='2026-10');
test('real Savings Transfer591 / duplicate Deposit11232 replay: Auto-post blocks before upload',async t=>{
 const h=await harness(savingsPackage);h.mutateReply=(v,task)=>{if(task.data.step.type==='preflight')v.rulesInspection.rules=clone(savingsFailure.rules);};
 await assert.rejects(h.exec({type:'upload',fileId:h.source.envelope.files.find(f=>f.kind==='csv').fileId}),/Auto-post.*add sales/);
 assert.equal(h.calls,1);assert.equal((await h.workspace.detail(user,h.pkg.id)).evidence.imports.length,0);assert.equal((await h.operator.status(user,h.pkg.id)).blocked,true);
 t.diagnostic('Real Savings1150040007 October2026 Transfer591/Deposit11232 CAD1000 each; rule settings owner-reported, IDs test-local.');
});
test('real duplicate Deposit11232 blocks after upload and Match; no subsequent row can run',async()=>{
 for(const phase of ['upload','review']){
  const h=await harness(savingsPackage),original=savingsFailure.records.find(r=>r.entity==='Transfer'),duplicate=savingsFailure.records.find(r=>r.entity==='Deposit');h.records.push(clone(original));
  h.mutateReply=(v,task)=>{if(task.data.step.type===phase)h.records.push(clone(duplicate));};
  if(phase==='review')await h.upload();
  const action=phase==='upload'?{type:'upload',fileId:h.source.envelope.files.find(f=>f.kind==='csv').fileId}:'review';
  await assert.rejects(h.exec(action),/Unexpected new accounting record.*Deposit 11232/);
  assert.equal((await h.operator.status(user,h.pkg.id)).blocked,true);const count=h.calls;await assert.rejects(h.exec('preflight'),/stopped, uncertain/);assert.equal(h.calls,count);
 }
});
test('unknown Rules scope/completeness and missing post-action completeness fail closed',async()=>{
 for(const patch of [v=>v.complete=false,v=>v.rules=[{ruleId:'unknown',name:'Unknown',active:true,autoPost:true}]]){
  const h=await harness(savingsPackage);h.mutateReply=(v,t)=>{if(t.data.step.type==='preflight')patch(v.rulesInspection);};await assert.rejects(h.exec({type:'upload',fileId:h.source.envelope.files.find(f=>f.kind==='csv').fileId}));assert.equal(h.calls,1);
 }
 const h=await harness(savingsPackage),reader=h.deps.readVerification;h.deps.readVerification=async args=>{const v=await reader(args);if(args.phase==='after')v.complete=false;return v;};h.operator=createBankingOperator(h.deps);await assert.rejects(h.exec({type:'upload',fileId:h.source.envelope.files.find(f=>f.kind==='csv').fileId}),/complete scoped/);
});

test('Rules pre-flight never waits for mirror sync and expired Rules screen cannot upload',async()=>{
 const h=await harness(),reader=h.deps.readVerification;let reads=0;h.deps.readVerification=async args=>{reads++;h.advance(301000);return reader(args);};h.operator=createBankingOperator(h.deps);await h.exec('preflight');assert.equal(reads,0);
 await assert.rejects(h.exec({type:'upload',fileId:h.source.envelope.files.find(f=>f.kind==='csv').fileId}),/expired while waiting/);assert.equal(h.calls,2);assert.equal((await h.workspace.detail(user,h.pkg.id)).evidence.imports.length,0);
});

test('inactive and other-account Auto-post rules are harmless; deliberate scenario cannot bypass active Auto-post',async()=>{
 const h=await harness(savingsPackage),file=h.source.envelope.files.find(f=>f.kind==='csv');h.mutateReply=(v,t)=>{if(t.data.step.type==='preflight')v.rulesInspection.rules=clone(savingsFailure.rules).map((r,i)=>i===0?{...r,active:false}:{...r,allAccounts:false,accountIds:['123']});};await h.exec({type:'upload',fileId:file.fileId});assert.equal(h.pkg.summary.uploaded,true);
 const x=await harness(savingsPackage),rules=clone(savingsFailure.rules);x.mutateReply=(v,t)=>{if(t.data.step.type==='preflight')v.rulesInspection.rules=rules;};x.deps.ruleScenarioFor=async()=>({deliberate:true,packageId:x.pkg.id,accountId:x.account.Id,fileId:file.fileId,rulesHash:hash(rules),ruleKeys:rules.map(r=>hash({name:r.name,active:r.active,autoPost:r.autoPost,allAccounts:r.allAccounts,accountIds:r.accountIds,accountNames:r.accountNames || [],conditions:r.conditions}))});x.operator=createBankingOperator(x.deps);await assert.rejects(x.exec({type:'upload',fileId:file.fileId}),/active Auto-post/);assert.equal(x.pkg.summary.uploaded,false);
});

const blStop=require('./fixtures/banking-bl-real-stop.json');
const blPackage=require('./fixtures/banking-bl-real-package.json');
function blInput(){
 const manifest=clone(blPackage.manifest),keys=['scope','accountId','accountCurrency','period','revision','previousPackageId','sourceSnapshotHash','policyVersion','openingMinor','closingMinor','balanceConvention','events','rows','outstandingItems','blockers'];
 const envelope=Object.fromEntries(keys.map(k=>[k,manifest[k]])),mf=blPackage.files.at(-1);
 envelope.files=[...manifest.files,{fileId:hash({packageId:manifest.packageId,kind:'manifest',name:'manifest.json'}),kind:'manifest',path:mf.path,sha256:digest(Buffer.from(mf.base64,'base64')),rowCount:manifest.rows.length}];
 return {manifest,envelope,artifacts:blPackage.files.map(f=>({path:f.path,bytes:Buffer.from(f.base64,'base64')}))};
}
test('BL exact stored Chequing stop replays through production execute and loop into durable pause',async t=>{
 const h=await harness(blInput());assert.equal(h.pkg.id,blStop.result.packageId);assert.equal(h.pkg.period,'2020-04');
 h.runner.run=async({task})=>({exitCode:null,cleanupConfirmed:false,reply:blStop.message.replaceAll(blStop.result.runId,task.data.runId),replyPath:blStop.source});
 const L=require(path.join(modules,'banking-operator-loop'));let pause=null,state=null;
 const asPreflight={...h.operator,execute:(u,a)=>h.operator.execute(u,{...a,step:{type:'preflight'}})};
 const loop=L.createBankingOperatorLoop({workspace:h.workspace,operator:asPreflight,listUsers:async()=>[user],enabled:()=>true,isTerraBusy:async()=>false,pauseStore:{read:async()=>pause,write:async v=>pause=clone(v)},stateStore:{read:async()=>state,write:async v=>state=clone(v)},now:h.now});
 const result=await loop.tick();assert.equal(result.status,'blocked');assert.equal(pause.reason,'stopped at: '+blStop.result.reason);assert.equal(h.journals[0].result.screenshot,'preflight.png');assert.equal(h.journals[0].status,'blocked');assert.ok(state.lastTickAt);assert.ok(state.lastRunAt);assert.equal(state.lastOutcome.status,'blocked');assert.equal(h.leaseHeld,true);
 const restarted=L.createBankingOperatorLoop({workspace:h.workspace,operator:h.operator,listUsers:async()=>[user],enabled:()=>true,isTerraBusy:async()=>{throw new Error('must pause before checking locks');},pauseStore:{read:async()=>pause},stateStore:{read:async()=>state,write:async v=>state=clone(v)},now:h.now});assert.equal((await restarted.tick()).status,'blocked');assert.equal(state.lastRunAt,h.now());
 t.diagnostic('Actual ce9526d1 / account60 / April2020 and real bf7-4cf19462 structured stop; fake native runner only.');
});
test('BL restart recovers exact retained stop without reply.txt, never launches Terra',async t=>{
 const h=await harness(blInput()),dir=await fs.mkdtemp(path.join(os.tmpdir(),'bl-stored-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const folder=path.join(dir,'artifacts/terra-live',blStop.journal.runId+'-20261101-014409');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'events.jsonl'),JSON.stringify({type:'item.completed',item:{type:'agent_message',text:blStop.message}})+'\n');
 h.journals.push(clone(blStop.journal));h.deps.readRetainedResult=entry=>require(path.join(modules,'banking-operator-recovery')).readRetainedTerraResult(dir,entry);h.operator=createBankingOperator(h.deps);
 await h.operator.recover(user,h.pkg.id);assert.equal(h.calls,0);assert.equal(h.journals[0].status,'blocked');assert.equal(h.journals[0].reason,'stopped at: '+blStop.result.reason);assert.match(h.journals[0].recovery.source,/events.jsonl$/);assert.equal(h.leaseHeld,false);await assert.rejects(h.exec('preflight'),/stopped, uncertain/);
});
test('BL killed read-only preflight can be replaced; unknown upload requires bank-transactions inspection',async()=>{
 for(const type of ['preflight','upload','review','reconcile','attach']){
  const h=await harness(blInput());h.journals.push({...clone(blStop.journal),step:{type}});await h.operator.recover(user,h.pkg.id);
  if(type==='preflight'){assert.equal(h.journals[0].status,'recovered-read-only');await h.exec('preflight');assert.equal(h.calls,1);}else{assert.equal(h.journals[0].status,'blocked');assert.match(h.journals[0].reason,/Read-only inspection.*bank transactions/);await assert.rejects(h.exec('preflight'),/stopped, uncertain/);assert.equal(h.calls,0);}
 }
});
test('BL native visible rule identities need no IDs, hash full list, and fail closed on every page/status',async()=>{
 const {assertRulesSafe}=require(path.join(modules,'banking-operator-guards')),scope=blStop.result.scope;
 const context={scope,accountId:'60',accountName:'Chequing',packageId:blStop.result.packageId,now:'2026-11-01T07:00:01Z',startedAt:'2026-11-01T07:00:00Z'};
 const rules=[{name:'Utilities',active:true,autoPost:false,allAccounts:true,accountIds:[],conditions:['Description contains hydro']},{name:'Sort Ad expenses',active:false,autoPost:true,allAccounts:true,accountIds:[],conditions:['Description contains Google']},{name:'taxes',active:false,autoPost:true,allAccounts:true,accountIds:[],conditions:['Amount greater than -1.00']},{name:'add sales',active:false,autoPost:true,allAccounts:true,accountIds:[],conditions:['Amount greater than 1.00']}];
 const value={scope,accountId:'60',complete:true,observedAt:context.now,rules,coverage:{filter:'all',includesActive:true,includesDisabled:true,totalRules:4,pages:[{page:1,pageCount:2,ruleCount:2,screenshot:'rules-1.png'},{page:2,pageCount:2,ruleCount:2,screenshot:'rules-2.png'}]}};
 const good=assertRulesSafe(value,context);assert.equal(good.rulesHash,hash(rules));assert.equal(good.ruleKeys.length,4);
 const changed=clone(value);changed.rules[3].conditions=['Amount greater than 2.00'];assert.notEqual(assertRulesSafe(changed,context).rulesHash,good.rulesHash);
 for(const bad of [v=>v.coverage.pages.pop(),v=>v.coverage.includesDisabled=false,v=>v.rules[3].active=true,v=>v.rules[0].autoPost=true,v=>{v.rules[0]={...v.rules[0],autoPost:true,allAccounts:false,accountNames:['Chequing']};}]){const v=clone(value);bad(v);assert.throws(()=>assertRulesSafe(v,context));}
 const other=clone(value);other.rules[0]={...other.rules[0],autoPost:true,allAccounts:false,accountNames:['Savings']};assert.throws(()=>assertRulesSafe(other,context),/Unknown or ambiguous/);assertRulesSafe(other,{...context,accounts:[{Id:'1150040007',Name:'Savings'}]});
 const qualified=clone(value);qualified.rules[0]={...qualified.rules[0],autoPost:true,allAccounts:false,accountNames:['  PARENT:Chequing  ']};assert.throws(()=>assertRulesSafe(qualified,{...context,accountFullName:'Parent:Chequing'}),/active Auto-post/);
});

test('BL retained stop is visible and durably pauses even while lock recovery is unavailable',async()=>{
 const h=await harness(blInput());h.journals.push(clone(blStop.journal));h.deps.readRetainedResult=async()=>({reply:blStop.message,source:blStop.source});h.operator=createBankingOperator(h.deps);
 const status=await h.operator.status(user,h.pkg.id);assert.equal(status.reasons[0].nativeStatus,'stopped');
 let pause=null;const L=require(path.join(modules,'banking-operator-loop')),loop=L.createBankingOperatorLoop({workspace:h.workspace,operator:h.operator,listUsers:async()=>[user],enabled:()=>true,isTerraBusy:async()=>{throw new Error('process enumeration denied; should not mask retained stop');},pauseStore:{read:async()=>pause,write:async v=>pause=clone(v)}});
 assert.equal((await loop.tick()).status,'blocked');assert.equal(pause.reason,'stopped at: '+blStop.result.reason);assert.equal(h.calls,0);assert.equal(h.journals[0].status,'started');
});

// BL2 replay: the original stored failure passes through production recovery and execution.
function bl2Recovery(h){
 h.deps.verifyRunStopped=async()=>({processesVerifiedAbsent:true});
 h.deps.authorizeOwner=async()=>{};
 h.deps.readRetainedResult=async()=>({reply:blStop.message,source:blStop.source});
 h.operator=createBankingOperator(h.deps);
 let pause={packageId:h.pkg.id,accountId:h.pkg.accountId,reason:'stopped at: '+blStop.result.reason,at:h.now()};
 return {read:async()=>pause,write:async v=>{pause=clone(v);},clear:async expected=>{assert.deepEqual(pause,expected);pause=null;}};
}
test('BL2 exact real retained stop auto-resolves audited after contract change, then production upload gets a fresh preflight',async()=>{
 const h=await harness(blInput());h.journals.push(clone(blStop.journal));const store=bl2Recovery(h),L=require(path.join(modules,'banking-operator-loop'));
 const loop=L.createBankingOperatorLoop({workspace:h.workspace,operator:h.operator,listUsers:async()=>[user],enabled:()=>true,isTerraBusy:async()=>false,pauseStore:store,now:h.now});
 assert.equal((await loop.tick()).status,'resolved');assert.equal(await store.read(),null);assert.equal(h.calls,0);assert.equal(h.journals[0].status,'resolved-stop');assert.equal(h.journals[0].resolutions[0].mode,'automatic');assert.equal(h.journals[0].result.reason,blStop.result.reason);
 // The month is reconciled from QuickBooks' register; its CSV is not uploaded again.
 assert.equal((await loop.tick()).status,'progress');assert.equal(h.calls,1);assert.equal(h.journals[1].step.type,'reconcile');
});
test('BL2 cooldown and durable three-retry cap survive a restart and version changes',async()=>{
 const h=await harness(blInput()),R=require(path.join(modules,'banking-operator-resolution'));
 const store=bl2Recovery(h);h.journals.push({...clone(blStop.journal),operatorVersion:R.OPERATOR_VERSION,finishedAt:h.now(),status:'blocked',result:clone(blStop.result)});
 const resolve=async()=>h.operator.resolvePause(user,{packageId:h.pkg.id,pause:await store.read(),automatic:true,clearPause:v=>store.clear(v)});
 assert.equal((await resolve()).resolved,false);h.advance(R.COOLDOWN_MS);assert.equal((await resolve()).resolved,true);
 for(let n=1;n<=3;n++){
  const id='bf7-retry-'+n,entry={...clone(blStop.journal),runId:id,operatorVersion:'older-build',status:'blocked',finishedAt:h.now(),result:{...clone(blStop.result),runId:id}};h.journals.push(entry);await store.write({packageId:h.pkg.id,accountId:h.pkg.accountId,reason:entry.result.reason,at:h.now()});h.operator=createBankingOperator(h.deps);
  const out=await resolve();assert.equal(out.resolved,n<3);assert.equal(out.automaticRetry.attempts,n<3?n+1:3);
 }
 assert.equal(h.journals.flatMap(r=>r.resolutions || []).filter(r=>r.mode==='automatic').length,3);assert.ok(await store.read());
});
test('BL2 live or unverifiable processes, missing ledger and every writable step stay paused',async()=>{
 // A reconcile/attach with an empty ledger now retries (tested separately); writing steps still pause.
 for(const mode of ['live','unknown','ledger','upload','review','rules','attempt','nativeAttempted','uploadAttempted','addAttempted','matchAttempted','reconcileAttempted','attemptedActions']){
  const h=await harness(blInput()),store=bl2Recovery(h),entry={...clone(blStop.journal),status:'blocked',result:clone(blStop.result)};h.journals.push(entry);
  if(mode==='live')h.deps.verifyRunStopped=async()=>{throw new Error('process still live');};
  if(mode==='unknown')h.deps.verifyRunStopped=async()=>undefined;
  if(mode==='ledger')entry.result.actionLedger.push({action:'add'});
  if(mode==='attempt')entry.result.upload={attempted:true};
  if(/Attempted$/.test(mode))entry.result[mode]=true;
  if(mode==='attemptedActions')entry.result.attemptedActions=['upload'];
  if(['upload','review','reconcile','rules','attach'].includes(mode)){entry.step.type=mode;entry.result.step=mode;}
  h.operator=createBankingOperator(h.deps);
  try{const r=await h.operator.resolvePause(user,{packageId:h.pkg.id,pause:await store.read(),automatic:true,clearPause:v=>store.clear(v)});assert.equal(r.resolved,false);}catch(e){assert.match(e.message,/live|Fresh proof/);}
  assert.ok(await store.read());assert.equal(h.journals[0].status,'blocked');assert.equal(h.calls,0);
 }
});
test('BL2 owner resolution is audited, invalid/unauthorized resolutions preserve pause and native actions',async()=>{
 const h=await harness(blInput()),store=bl2Recovery(h);h.journals.push({...clone(blStop.journal),status:'blocked',result:clone(blStop.result)});
 const resume=async resolution=>h.operator.resolvePause(user,{packageId:h.pkg.id,pause:await store.read(),resolution,clearPause:v=>store.clear(v)});
 await assert.rejects(resume({reason:''}),/resolution reason/);h.deps.authorizeOwner=async()=>{throw new Error('owner required');};h.operator=createBankingOperator(h.deps);await assert.rejects(resume({reason:'Fixed visible-rule contract'}),/owner required/);assert.ok(await store.read());
 h.deps.authorizeOwner=async()=>{};h.operator=createBankingOperator(h.deps);assert.equal((await resume({reason:'Fixed visible-rule contract'})).resolved,true);assert.equal(h.journals[0].resolutions[0].mode,'owner');assert.equal(h.journals[0].resolutions[0].reason,'Fixed visible-rule contract');assert.equal(h.calls,0);
});


test('private sign-in failure precedes every banking journal and import admission',async()=>{
 const h=await harness();h.runner.withSession=async(_context,_work)=>{throw Object.assign(new Error('Intuit needs verification'),{code:'QBO_VERIFICATION_REQUIRED'});};
 await assert.rejects(h.exec({type:'upload',fileId:h.source.envelope.files.find(f=>f.kind==='csv').fileId}),/Intuit needs verification/);
 assert.equal(h.calls,0);assert.equal(h.journals.length,0);assert.equal((await h.workspace.detail(user,h.pkg.id)).evidence.imports.length,0);assert.equal(h.leaseHeld,false);
});
test('banking authorization precedes private credential/session access',async()=>{
 const h=await harness();let signins=0;h.runner.withSession=async(_context,work)=>{signins++;return work();};h.deny();
 await assert.rejects(h.exec('preflight'),/Write denied/);assert.equal(signins,0);assert.equal(h.journals.length,0);assert.equal(h.leaseHeld,false);
});
test('one shared browser lease covers fresh Rules preflight and exact upload together',async()=>{
 const h=await harness();let sessions=0,held=false;const run=h.runner.run;
 h.runner.withSession=async(context,work)=>{sessions++;assert.equal(context.actor,'app');assert.deepEqual(context.scope,h.scope);held=true;try{return await work();}finally{held=false;}};
 h.runner.run=async args=>{assert.equal(held,true);return run(args);};
 await h.exec({type:'upload',fileId:h.source.envelope.files.find(f=>f.kind==='csv').fileId});
 assert.equal(sessions,1);assert.equal(h.calls,2);assert.equal(held,false);assert.equal(h.leaseHeld,false);
});


test('login-only block survives restart and corrected sign-in resumes without a native pause',async()=>{
 const h=await harness(),L=require(path.join(modules,'banking-operator-loop'));let broken=true,signins=0,pause=null,state=null,proof=null;
 h.runner.withSession=async(_context,work)=>{signins++;if(broken)throw Object.assign(Error('private raw message is not retained'),{code:'QBO_VERIFICATION_REQUIRED'});return work();};
 const deps={workspace:h.workspace,operator:h.operator,listUsers:async()=>[user],enabled:()=>true,isTerraBusy:async()=>false,pauseStore:{read:async()=>pause,write:async v=>pause=v},stateStore:{read:async()=>state,write:async v=>state=clone(v)},readSignInStatus:async()=>proof,now:h.now};
 assert.equal((await L.createBankingOperatorLoop(deps).tick()).requiresSignIn,true);assert.equal(pause,null);assert.equal(h.journals.length,0);assert.equal(h.calls,0);assert.equal(signins,1);assert.ok(!JSON.stringify(state).includes('private raw'));
 const restarted=L.createBankingOperatorLoop(deps);await restarted.tick();assert.equal(signins,1);
 broken=false;h.advance(1000);proof={status:'ready',identityVerified:true,companyVerified:true,at:h.now()};
 assert.equal((await restarted.tick()).status,'progress');assert.equal(h.calls,1);assert.equal(pause,null);assert.equal(signins,2);
});
test('login-only retry cap and ordinary browser contention never create a native pause',async()=>{
 const h=await harness(),L=require(path.join(modules,'banking-operator-loop'));let pause=null,state=null,signins=0;
 h.runner.withSession=async()=>{signins++;throw Object.assign(Error('login'),{code:'QBO_SIGNIN_REQUIRED'});};
 const deps={workspace:h.workspace,operator:h.operator,listUsers:async()=>[user],enabled:()=>true,isTerraBusy:async()=>false,pauseStore:{read:async()=>pause,write:async v=>pause=v},stateStore:{read:async()=>state,write:async v=>state=clone(v)},readSignInStatus:async()=>null,now:h.now};
 for(let i=0;i<4;i++){await L.createBankingOperatorLoop(deps).tick();h.advance(16*60000);}assert.equal(signins,3);assert.equal(pause,null);assert.equal(h.calls,0);
 const x=await harness();x.runner.withSession=async()=>{throw Object.assign(Error('busy'),{code:'QBO_SESSION_BUSY'});};
 const result=await L.createBankingOperatorLoop({...deps,workspace:x.workspace,operator:x.operator,stateStore:null}).tick();assert.equal(result.status,'waiting');assert.equal(pause,null);assert.equal(x.journals.length,0);
});

test('pending heartbeat and restart retain authentication retry history',async()=>{
 const h=await harness(),L=require(path.join(modules,'banking-operator-loop'));let state=null,pause=null,signins=0,release;
 h.runner.withSession=async()=>{signins++;throw Object.assign(Error('login'),{code:'QBO_SIGNIN_REQUIRED'});};
 const deps={workspace:h.workspace,operator:h.operator,listUsers:async()=>[user],enabled:()=>true,isTerraBusy:async()=>false,pauseStore:{read:async()=>pause,write:async v=>pause=v},stateStore:{read:async()=>state,write:async v=>state=clone(v)},readSignInStatus:async()=>null,now:h.now};
 await L.createBankingOperatorLoop(deps).tick();h.advance(16*60000);const retry=clone(state.signInRetry);
 let entered;const admitted=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);
 h.runner.withSession=async()=>{signins++;entered();await blocked;throw Object.assign(Error('login'),{code:'QBO_SIGNIN_REQUIRED'});};
 const loop=L.createBankingOperatorLoop(deps),pending=loop.tick();await admitted;const heartbeat=loop.tick();
 await new Promise(r=>setImmediate(r));assert.deepEqual(state.signInRetry,retry);assert.equal(state.status,'running');
 // A restarted process must load the retry count saved while the first tick was pending.
 const snapshot=clone(state);release();await pending;await heartbeat;assert.equal(state.signInRetry.attempts,2);
 state=snapshot;h.runner.withSession=async()=>{throw Object.assign(Error('login'),{code:'QBO_SIGNIN_REQUIRED'});};
 await L.createBankingOperatorLoop(deps).tick();assert.equal(state.signInRetry.attempts,2);assert.equal(pause,null);
});
test('a stop pauses only its own account; the newest workable month of another account still runs',async()=>{
 const L=require(path.join(modules,'banking-operator-loop'));
 const pkg=(id,accountId,period,reconciled=false)=>({id,accountId,period,revision:1,summary:{reconciled,needsReview:false},evidence:{imports:[],rows:{},supersededBy:null},snapshot:{files:[],rows:[],blockers:[]}});
 const packages=[pkg('a60','60','2020-04'),pkg('b123old','123','2023-09'),pkg('b123','123','2026-10'),pkg('s9','1150040007','2026-09',true),pkg('s10','1150040007','2026-10')];
 assert.deepEqual(L.workablePackages(packages).map(p=>p.id).sort(),['a60','b123','s10']);
 packages.at(-1).period='2026-10';
 const executed=[];
 const loop=L.createBankingOperatorLoop({workspace:{list:async()=>({packages}),detail:async(_u,id)=>packages.find(p=>p.id===id)},operator:{status:async()=>({steps:[]}),execute:async(_u,a)=>{executed.push(a);return {runId:'r'};}},listUsers:async()=>[user],enabled:()=>true,isTerraBusy:async()=>false,pauseStore:{list:async()=>[{packageId:'a60',accountId:'60',reason:'opening differs',at:'2026-11-07T00:00:00Z'}],write:async()=>{}}});
 const result=await loop.tick();
 assert.equal(result.status,'progress');assert.deepEqual(executed.map(e=>[e.packageId,e.step.type]),[['b123','reconcile']]);
});
test('after a reconciled month the next month in date order is worked, never a later one',async()=>{
 const L=require(path.join(modules,'banking-operator-loop'));
 const pkg=(id,accountId,period,reconciled=false)=>({id,accountId,period,revision:1,summary:{reconciled}});
 assert.deepEqual(L.workablePackages([pkg('a','7','2026-08',true),pkg('b','7','2026-09'),pkg('c','7','2026-10'),pkg('d','8','2026-05'),pkg('e','8','2026-10')]).map(p=>p.id).sort(),['b','e']);
});
test('a reconcile that stopped before any action retries automatically; one that reported a reconciliation does not',async()=>{
 const R=require(path.join(modules,'banking-operator-resolution'));
 const base={runId:'bf7-x',packageId:'p',step:{type:'reconcile'},actionLedger:[],status:'blocked'};
 const result={kind:'banking-operator-result',version:1,runId:'bf7-x',packageId:'p',step:'reconcile',scope:{},accountId:'121',accountCurrency:'CAD',period:'2026-10',status:'stopped',reason:'company not verified',actionLedger:[]};
 assert.equal(R.noNativeEffect(base,result),true);
 assert.equal(R.noNativeEffect(base,{...result,reconciliation:{completed:false}}),false);
 assert.equal(R.noNativeEffect(base,{...result,actionLedger:[{action:'reconcile'}]}),false);
 assert.equal(R.noNativeEffect({...base,step:{type:'upload'}},{...result,step:'upload'}),false);
});
