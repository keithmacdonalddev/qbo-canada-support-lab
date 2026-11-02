'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {incident,scope,ownerId,clock}=require('./helpers/general-estimate-fixture');
const {hash}=require('../src/modules/business-calendar');
const {controls}=require('./helpers/period-controls');
const {createGeneralEstimateNative}=require('../src/modules/general-estimate-native');
const clone=v=>structuredClone(v);
function fixture(mode='success',descriptions){
  const h=incident('11331','11217',descriptions),db={authorities:[],audits:[]},counters={runs:0,sessions:0,releases:0,reads:0};let acted=false,denied=false,retained=null;
  const query=value=>({select(){return this;},session(){return this;},maxTimeMS(){return this;},lean:async()=>clone(value)});
  h.models.Authorities={findOne:filter=>query(db.authorities.find(r=>r._id===filter._id&&(filter.environment===undefined||r.environment===filter.environment)&&(filter.realmId===undefined||r.realmId===filter.realmId)&&(filter.connectionId===undefined||String(r.connectionId)===String(filter.connectionId)))||null),create:async rows=>{for(const r of rows){if(db.authorities.some(old=>old._id===r._id))throw Error('duplicate action');db.authorities.push(clone(r));}}};
  h.models.Audits={create:async rows=>db.audits.push(...clone(rows))};
  const policy={_id:'policy',...scope,state:'active',revision:0,periodControl:controls(scope,ownerId,clock)};
  h.models.Policies={findOne:()=>query(policy),findOneAndUpdate:(filter,update)=>{if(filter.revision!==policy.revision||filter['periodControl.contentHash']!==policy.periodControl.contentHash)return query(null);policy.revision+=update.$inc.revision;return query(policy);}};
  h.models.Writers={findOne:()=>query(h.writer),findOneAndUpdate:(filter,update)=>{if(filter.revision!==h.writer.revision||filter['unresolved.actionId']&&filter['unresolved.actionId']!==h.writer.unresolved?.actionId)return query(null);Object.assign(h.writer,clone(update.$set||{}));h.writer.revision+=update.$inc?.revision||0;return query(h.writer);}};
  const customer={Id:'1',SyncToken:'0',DisplayName:'Fictional customer',Balance:285,Active:true,MetaData:{CreateTime:'2026-01-01T00:00:00Z',LastUpdatedTime:'2026-01-01T00:00:00Z'}};
  const report=()=>({Header:{ReportName:'TrialBalance',ReportBasis:'Accrual',Currency:'CAD',StartPeriod:'2026-01-01',EndPeriod:'2026-11-02'},Columns:{Column:[{ColType:'debt_amt'},{ColType:'credit_amt'}]},Rows:{Row:[{ColData:[{id:'120',value:acted&&mode==='report-change'?'286.00':'285.00'},{value:'0.00'}]}]}});
  const client={query:async()=>{counters.reads++;return {QueryResponse:{Preferences:[{AccountingInfoPrefs:{},SalesFormsPrefs:{AutoApplyCredit:mode==='auto-credit',UsingProgressInvoicing:true}}]}};},apiCall:async(method,endpoint)=>{assert.equal(method,'GET','native repair module never sends an SDK mutation');counters.reads++;if(endpoint.startsWith('reports/'))return report();const [entity]=endpoint.split('/');if(entity==='customer')return {Customer:clone(customer)};const type=entity==='invoice'?'Invoice':'Estimate',record=h.current(type);if(mode==='source-drift'&&!acted&&type==='Invoice')record.Balance--;if(acted&&mode==='extra-line'&&type==='Invoice')record.Line.push(clone(record.Line[0]));return {[type]:record};}};
  const access={authorize:async()=>{if(denied)throw Error('current permission revoked');return {ownerId,actorId:ownerId,scope};},resolveClient:async()=>client};
  const runner={sessionProof:()=>hash('terra-live-qbo-signin-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-123-123'),withSession:async(ctx,work)=>{assert.deepEqual(ctx.scope,scope);counters.sessions++;return work();},run:async({runId,task})=>{counters.runs++;assert.ok(task.prompt.includes('existing Invoice 11331'));assert.ok(runId.startsWith('bf7-'));if(mode.startsWith('missing-helper')&&(counters.runs===1||mode==='missing-helper-always'))return retained={exitCode:0,cleanupConfirmed:true,model:'gpt-6.1-terra',commandAudit:{shell:0,flagged:0},replyPath:'private/reply.txt',reply:JSON.stringify({invoiceId:'11331',estimateId:'11217',draftChecked:false,saveAttempts:0,saveOutcome:'not-attempted',notes:'MODULE_NOT_FOUND before browser entry'})};h.nativeRepair();acted=true;if(mode==='revoke-after-save')denied=true;return retained={exitCode:0,cleanupConfirmed:mode!=='cleanup-unknown',model:'gpt-6.1-terra',commandAudit:{shell:4,flagged:mode==='flagged-command'?1:0},replyPath:'artifacts/private/reply.txt',reply:mode==='missing-result'?'':JSON.stringify({invoiceId:'11331',estimateId:'11217',draftChecked:true,saveAttempts:1,saveOutcome:mode==='save-unknown'?'uncertain':'saved',beforeSaveScreenshot:'before.png',afterSaveScreenshot:'after.png'})};},readExecution:async()=>retained,assertNoDraft:async()=>({onlyHomepage:mode!=='missing-helper-draft',tabCount:1,observedAt:new Date(clock).toISOString()}),retainEvidence:async(execution,path)=>({path,sha256:hash(path)})};
  const transaction=async work=>{const before={writer:clone(h.writer),policy:clone(policy),authorities:clone(db.authorities),audits:clone(db.audits)};try{return await work({inTransaction:()=>true});}catch(error){Object.assign(h.writer,before.writer);Object.assign(policy,before.policy);db.authorities=before.authorities;db.audits=before.audits;throw error;}};
  const codingAuthority={...scope,pairs:[{invoiceId:'11331',estimateId:'11217'}]};
  const config={models:h.models,transaction,access,runner,lease:async()=>async()=>{counters.releases++;},codingAuthority,browserScope:scope,now:()=>clock};
  const api=()=>createGeneralEstimateNative(config),bound={scope,ownerId,actorId:ownerId};
  return {h,db,counters,config,bound,customer,policy,client,deny:value=>{denied=value;},repair:()=>api().repair({bound,operationId:h.run._id,ref:'invoice'})};
}
test('native saved-record action holds its own writer, proves accounting, and never fabricates an SDK receipt',async()=>{
  const f=fixture(),old=clone(f.h.receipt),result=await f.repair();assert.equal(result.status,'verified');assert.equal(result.invoiceId,'11331');assert.equal(result.accountingUnchanged,true);assert.equal(f.counters.runs,1);assert.equal(f.h.writer.unresolved,null);assert.deepEqual(f.h.receipt,old);assert.deepEqual(f.db.authorities.map(r=>r.payload.phase),['admitted','started','returned','verified']);assert.equal(f.db.audits.at(-1).tool,'browser');assert.equal(f.counters.releases,1);
  assert.equal((await f.repair()).status,'verified');assert.equal(f.counters.runs,1,'retry/restart never launches a second native task');
});
for(const mode of ['cleanup-unknown','flagged-command','missing-result','save-unknown','report-change','extra-line','revoke-after-save'])test('uncertain native outcome retains exact barrier: '+mode,async()=>{
  const f=fixture(mode);await assert.rejects(f.repair());assert.ok(f.h.writer.unresolved?.actionId);assert.equal(f.counters.runs,1);assert.equal((await f.repair()).status,'held');assert.equal(f.counters.runs,1);assert.equal(f.h.run.items.invoice.outcome,'mismatch');assert.equal(f.db.authorities.some(r=>r.payload.phase==='verified'),false);
});
for(const mode of ['auto-credit','source-drift'])test('unsafe fresh preflight saves nothing: '+mode,async()=>{const f=fixture(mode);await assert.rejects(f.repair());assert.equal(f.counters.runs,0);assert.equal(f.db.authorities.length,0);assert.equal(f.h.writer.unresolved,null);});
test('wrong authority or busy writer cannot admit a native task',async()=>{
  const wrong=fixture();wrong.config.codingAuthority.pairs=[];await assert.rejects(wrong.repair(),/owner-approved/);assert.equal(wrong.counters.runs,0);
  const busy=fixture();busy.h.writer.unresolved={kind:'other-write'};await assert.rejects(busy.repair(),/idle exact company writer/);assert.equal(busy.counters.runs,0);assert.equal(busy.h.writer.unresolved.kind,'other-write');
});
test('verified native repair and exact original receipts flow into existing read-only reconciliation and day close',async()=>{
  const f=fixture();f.config.reconcile=()=>f.h.execute();const result=await f.repair();assert.equal(result.reconciled.status,'complete');assert.equal(f.h.run.items.invoice.qboId,'11331');assert.equal(f.h.run.items.invoice.originalSavedRecord.Line[0].Id,'1');assert.equal(f.h.run.items.invoice.record.Line[0].Id,'2');
  const gathered=await require('../src/modules/general-write-day-close').generalRecordsFor({Runs:f.h.models.GeneralWriteRuns,scope,day:'2026-11-01',copy:{read:async(s,entity)=>f.h.current(entity)},models:f.h.models,now:()=>clock});assert.ok(gathered.records[0].evidence.accountant.estimateConversion);
});

test('real QBOClient accepts the owned signal contract and performs only GETs',async()=>{
  const f=fixture(),{QBOClient}=require('../src/modules/qbo-client'),actual=Object.create(QBOClient.prototype),sent=[];
  Object.assign(actual,{realmId:scope.realmId,connection:{_id:scope.connectionId,userId:ownerId,realmId:scope.realmId,status:'active'},_requestLog:[],_windowMs:60000,_retryAfterUntil:0,ensureFreshToken:async()=>{},_meterRequest:()=>null,oauthClient:{makeApiCall:async opts=>{sent.push(opts);assert.equal(opts.method,'GET');assert.equal(opts.maxRetries,1);const u=new URL(opts.url),endpoint=u.pathname.split('/').slice(4).join('/');return {status:200,json:endpoint==='query'?await f.client.query():await f.client.apiCall('GET',endpoint)};}}});
  Object.defineProperty(actual,'apiBase',{value:'https://sandbox-quickbooks.api.intuit.com/v3/company/123'});
  f.config.access.resolveClient=async()=>actual;
  const result=await f.repair();assert.equal(result.status,'verified');assert.equal(result.sdkReads,sent.length);assert.ok(sent.length<=24);
});
test('lost verification permission resumes from retained result without a second Save',async()=>{
  const f=fixture('revoke-after-save');await assert.rejects(f.repair());assert.equal(f.counters.runs,1);f.deny(false);
  const result=await f.repair();assert.equal(result.status,'verified');assert.equal(f.counters.runs,1);assert.equal(f.h.writer.unresolved,null);
});
test('a pause after Save still allows observing and settling the admitted result',async()=>{
  const f=fixture();let paused=false;f.config.guard=async()=>{if(paused)throw Error('paused');};const run=f.config.runner.run;f.config.runner.run=async args=>{const result=await run(args);paused=true;return result;};
  assert.equal((await f.repair()).status,'verified');assert.equal(f.counters.runs,1);
});
test('a concurrent policy change aborts admission before native work',async()=>{
  const f=fixture();f.h.models.Policies.findOneAndUpdate=()=>({lean:async()=>null});await assert.rejects(f.repair(),/protection changed concurrently/);assert.equal(f.counters.runs,0);assert.equal(f.db.authorities.length,0);assert.equal(f.h.writer.unresolved,null);
});
for(const field of ['CustomerRef','CurrencyRef','Line','TxnTaxDetail','GlobalTaxCalculation','TotalAmt'])test('incompatible authenticated original source saves nothing: '+field,async()=>{
  const f=fixture(),e=f.h.estimate;
  if(field==='CustomerRef')e.CustomerRef.value='2';if(field==='CurrencyRef'){e.CurrencyRef.value='USD';e.ExchangeRate=1.3;}
  if(field==='Line')e.Line[0].SalesItemLineDetail.Qty=3;if(field==='TxnTaxDetail')e.TxnTaxDetail.TotalTax++;
  if(field==='GlobalTaxCalculation')e.GlobalTaxCalculation='TaxInclusive';if(field==='TotalAmt')e.TotalAmt++;
  const q=f.h.quoteRun,b=q.batches[0],p=b.items[0].payload;
  for(const key of ['CustomerRef','CurrencyRef','GlobalTaxCalculation'])p[key]=clone(e[key]);
  p.Line=e.Line.map(line=>{const r=clone(line);delete r.Id;return r;});q.plan.operations[0].payload=clone(p);q.items.quote.request=clone(p);q.items.quote.record=clone(e);b.transport.response=[{bId:'1',Estimate:clone(e)}];
  const transport=require('../src/modules/general-write-transport');f.h.quoteReceipt.requestHash=transport.buildGeneralBatch(scope,b).requestHash;f.h.quoteReceipt.observed=transport.classifyGeneralResponse(scope,b,{status:200,json:{BatchItemResponse:b.transport.response}});
  await assert.rejects(f.repair());assert.equal(f.counters.runs,0);assert.equal(f.db.authorities.length,0);
});
for(const variant of ['Id','MetaData','sparse'])test('wrong or incomplete Customer is rejected before admission: '+variant,async()=>{
  const f=fixture();if(variant==='Id')f.customer.Id='2';if(variant==='MetaData')delete f.customer.MetaData;if(variant==='sparse')f.customer.sparse=true;
  await assert.rejects(f.repair(),/complete active Customer/);assert.equal(f.counters.runs,0);assert.equal(f.db.authorities.length,0);
});

test('native wrapper authenticates task, original receipt, lease, writer and stored ObjectId',async()=>{
  const f=fixture(),validate=require('../../scripts/banking/native-estimate-authority.cjs').validateNativeLaunch,launch=f.config.runner.run;
  f.config.runner.run=async args=>{
    const admitted=f.db.authorities.find(r=>r.payload.phase==='admitted'),plan=admitted.payload.plan;
    const opts={models:f.h.models,access:f.config.access,actionId:plan.actionId,authorityHash:admitted.contentHash,runId:plan.runId,task:args.task.prompt,leaseOwner:'terra-live-qbo-signin-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-123-123',now:clock,browserScope:scope};
    const find=f.h.models.Authorities.findOne;f.h.models.Authorities.findOne=filter=>filter._id===admitted._id?{maxTimeMS(){return this;},lean:async()=>({...admitted,connectionId:new (require('mongoose').Types.ObjectId)(scope.connectionId)})}:find(filter);
    assert.deepEqual(await validate(opts),{invoiceId:'11331',estimateId:'11217'});
    for(const changes of [{task:opts.task+' '},{runId:'bf7-00000000-0000-0000-0000-000000000000'},{leaseOwner:'terra-live-qbo-signin-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-123-123'},{authorityHash:'f'.repeat(64)},{now:clock+300001}])await assert.rejects(validate({...opts,...changes}));
    const old=f.h.writer.unresolved.estimateId;f.h.writer.unresolved.estimateId='999';await assert.rejects(validate(opts),/writer changed/);f.h.writer.unresolved.estimateId=old;
    f.policy.revision++;await assert.rejects(validate(opts),/period control changed/);f.policy.revision--;
    f.h.models.Authorities.findOne=find;return launch(args);
  };
  assert.equal((await f.repair()).status,'verified');
});

test('child completion receipt binds task, action and artifact bytes and cannot be overwritten',async t=>{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{writeReceipt,readReceipt}=require('../../scripts/banking/native-estimate-execution.cjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tdl-native-proof-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runId='bf7-00000000-0000-0000-0000-000000000000',actionId='a'.repeat(64),authorityHash='b'.repeat(64),output=path.join(root,'artifacts/terra-live',runId+'-proof'),taskDir=path.join(root,'artifacts/banking/operator-tasks',runId),taskFile=path.join(taskDir,'task.txt');
  await fs.mkdir(output,{recursive:true});await fs.mkdir(taskDir,{recursive:true});
  for(const [name,body] of Object.entries({'prompt.txt':'assembled fixed limits','reply.txt':'{}','commands.txt':'safe calls','settings.txt':'"model":"gpt-6.1-terra"','command-audit.json':'{"shell":0,"flagged":0}'}))await fs.writeFile(path.join(output,name),body);
  const claim=require('../../scripts/banking/native-estimate-authority.cjs').claimNativeLaunch,claimed=await Promise.allSettled([claim(taskDir,{actionId,runId}),claim(taskDir,{actionId,runId})]);assert.equal(claimed.filter(r=>r.status==='fulfilled').length,1,'only one concurrent wrapper launch can claim this run');
  await fs.writeFile(taskFile,'exact native task');const opts={root,runId,taskFile,output,exitCode:0,cleanupConfirmed:true,actionId,authorityHash,startedMs:Date.now()};await writeReceipt(opts);
  const request={runId,promptHash:hash('exact native task'),nativeRepair:{actionId,authorityHash}};
  assert.equal((await readReceipt(root,request)).model,'gpt-6.1-terra');
  await assert.rejects(writeReceipt(opts));await assert.rejects(readReceipt(root,{...request,nativeRepair:{actionId:'c'.repeat(64),authorityHash}}));
  await fs.writeFile(path.join(output,'reply.txt'),'changed');await assert.rejects(readReceipt(root,request),/artifacts changed/);
});

for(const estimate of [undefined,'Proposed fictional planning'])test('different proposed description preserves both original documents: '+String(estimate),async()=>{
  const f=fixture('success',{invoice:'Fictional planning, two hours',estimate});const result=await f.repair();assert.equal(result.status,'verified');assert.equal(f.h.current('Invoice').Line[0].Description,'Fictional planning, two hours');assert.equal(f.h.current('Estimate').Line[0].Description,estimate);
  const source=f.h.source(),bad=f.h.current('Invoice');bad.Line[0].Description='Overwritten by quote';assert.equal(require('../src/modules/general-estimate-recovery').assertRepairedPair(source,bad,f.h.current('Estimate'),f.h.estimate),false);
});

test('proved missing-helper no-effect admits only one immutable successor',async()=>{
  const f=fixture('missing-helper'),receipt=clone(f.h.receipt),first=await f.repair();assert.equal(first.noEffectVerified,true);assert.equal(first.retryAvailable,true);assert.equal(f.h.writer.unresolved,null);assert.equal(f.counters.runs,1);
  const result=await f.repair();assert.equal(result.status,'verified');assert.notEqual(result.actionId,first.actionId);assert.equal(f.counters.runs,2);assert.equal(f.db.authorities.filter(r=>r.payload.phase==='replacement-admitted').length,1);assert.deepEqual(f.h.receipt,receipt);assert.equal((await f.repair()).status,'verified');assert.equal(f.counters.runs,2);
});
test('two no-effect launches permanently exhaust the immutable lineage cap',async()=>{
  const f=fixture('missing-helper-always');assert.equal((await f.repair()).retryAvailable,true);assert.equal((await f.repair()).retryAvailable,false);assert.equal((await f.repair()).retryAvailable,false);assert.equal(f.counters.runs,2);assert.equal(f.h.writer.unresolved,null);
});
test('an open draft cannot prove no effect or permit replacement',async()=>{
  const f=fixture('missing-helper-draft');await assert.rejects(f.repair(),/open draft/);assert.ok(f.h.writer.unresolved);assert.equal((await f.repair()).status,'held');assert.equal(f.counters.runs,1);
});
for(const field of ['invoice','customer','report'])test('zero-Save claim cannot replace changed native evidence: '+field,async()=>{
  const f=fixture('missing-helper'),run=f.config.runner.run;let stopped=false;f.config.runner.run=async args=>{const result=await run(args);stopped=true;if(field==='invoice')f.h.original.Balance--;if(field==='customer')f.customer.Balance--;return result;};
  if(field==='report'){const get=f.client.apiCall;f.client.apiCall=async(...args)=>{const result=await get(...args);if(stopped&&args[1].startsWith('reports/'))result.Rows.Row[0].ColData[0].value='999.00';return result;};}
  await assert.rejects(f.repair());assert.ok(f.h.writer.unresolved);assert.equal((await f.repair()).status,'held');assert.equal(f.counters.runs,1);
});
test('wrapper independently verifies the exact no-effect successor and consumed predecessor',async()=>{
  const f=fixture('missing-helper'),validate=require('../../scripts/banking/native-estimate-authority.cjs').validateNativeLaunch,run=f.config.runner.run;
  f.config.runner.run=async args=>{const admitted=f.db.authorities.find(r=>r.payload.phase==='admitted'&&r.payload.plan.runId===args.runId),p=admitted.payload.plan,opts={models:f.h.models,access:f.config.access,actionId:p.actionId,authorityHash:admitted.contentHash,runId:p.runId,task:p.prompt,leaseOwner:'terra-live-qbo-signin-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-123-123',now:clock,browserScope:scope};assert.deepEqual(await validate(opts),{invoiceId:'11331',estimateId:'11217'});if(p.attempt===2){const events=f.db.authorities;f.db.authorities=events.filter(r=>r.payload.phase!=='replacement-admitted');await assert.rejects(validate(opts),/atomically consumed/);f.db.authorities=events;}return run(args);};
  assert.equal((await f.repair()).noEffectVerified,true);assert.equal((await f.repair()).status,'verified');assert.equal(f.counters.runs,2);
});
test('concurrent replacement callers cannot fork or launch a third child',async()=>{
  const f=fixture('missing-helper');await f.repair();const tx=f.config.transaction;let queue=Promise.resolve();f.config.transaction=work=>{let release;const before=queue;queue=new Promise(resolve=>{release=resolve;});return before.then(()=>tx(work)).finally(()=>release());};await Promise.allSettled([f.repair(),f.repair()]);assert.equal(f.counters.runs,2);assert.equal(f.db.authorities.filter(r=>r.payload.phase==='replacement-admitted').length,1);
});
test('hidden-shell task resolves browser through Windows home when APPDATA is empty',async()=>{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),script=await fs.readFile(path.resolve(__dirname,'../../.claude/skills/qbo-team-delivery/scripts/terra-live.sh'),'utf8'),line=script.split('\n').find(l=>l.startsWith('ab_js=$(node -p ')),program=line.slice('ab_js=$(node -p "'.length,line.indexOf('")'));
  const output=await new Promise((resolve,reject)=>cp.execFile(process.execPath,['-p',program],{env:{...process.env,APPDATA:''},windowsHide:true,timeout:5000},(error,out)=>error?reject(error):resolve(out.trim())));assert.equal(output,path.join(os.homedir(),'AppData','Roaming','npm','node_modules','agent-browser','bin','agent-browser.js'));
});

test('no-draft inspection reuses an active native lease and owns resumed leases',async t=>{
  const sessions=require('../src/modules/qbo-browser-session'),transport=require('../src/modules/qbo-browser-transport'),{createTerraRunner}=require('../src/modules/banking-terra-runner');let acquisitions=0,releases=0;
  const lease={environment:{TDL_QBO_SESSION_OWNER:'test'},trackChild:()=>{},retain:()=>{},release:async()=>{releases++;}};
  t.mock.method(sessions,'acquireSessionLease',async()=>{acquisitions++;return lease;});t.mock.method(transport,'privateRun',async()=>JSON.stringify({success:true,data:{tabs:[{url:'https://qbo.intuit.com/app/homepage'}]}}));
  const runner=createTerraRunner({coordinator:{withSession:async(ctx,work)=>work(lease)}});await runner.withSession({},async()=>assert.equal((await runner.assertNoDraft()).onlyHomepage,true));assert.equal(acquisitions,0);assert.equal(releases,0);assert.equal((await runner.assertNoDraft()).onlyHomepage,true);assert.equal(acquisitions,1);assert.equal(releases,1);
});
