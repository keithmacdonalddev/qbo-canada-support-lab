'use strict';
const path=require('node:path');
const {hash,createArtifactReader,createBankingWorkspaceService}=require('./banking-workspace-service');
const {createDefaultBankingOperator}=require('./banking-terra-runner');
const {TXNS}=require('./banking-operator-guards');
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const digest={type:'string',pattern:'^[a-f0-9]{64}$'};
const DEFINITIONS=[
 {name:'getBankingWorkspace',description:'Read generated banking account-months, blockers and native evidence from saved storage. No QBO calls.',input_schema:object({accountId:{type:'string',pattern:'^[0-9]+$'},period:{type:'string',pattern:'^20[0-9]{2}-[0-9]{2}$'}})},
 {name:'retryBankInstructions',description:'Retry only durable delivery of already accepted business creates to the independent bank. Never calls QuickBooks or resends a financial write. Active financial execution waits; held items need their stated dependency resolved.',input_schema:object({runId:{type:'string',pattern:'^[a-f0-9]{24}$'}})},
 {name:'getBankingPackage',description:'Inspect exact retained CSV/statement metadata and native operator evidence; generated files do not prove reconciliation.',input_schema:object({packageId:digest},['packageId'])},
 {name:'prepareBankingPackage',description:'Register an already generated immutable BF2 package from its exact retained manifest path and hash. Does not generate invented history or execute native work.',input_schema:object({manifest:object({path:{type:'string'},sha256:digest},['path','sha256'])},['manifest'])},
 {name:'getBankingCloseSupport',description:'Read retained native banking evidence for one month for the period-close workflow. Does not attest manually, change protection or certify company-wide reconciliation.',input_schema:object({period:{type:'string',pattern:'^20[0-9]{2}-(0[1-9]|1[0-2])$'}},['period'])},
];
function createBankingAccountantTools({workspace=createBankingWorkspaceService(),operator=null,readArtifact=createArtifactReader(),readLoopStatus=require('./banking-operator-loop').readBankingLoopStatus}={}) {
 async function execute(user,name,input){
  if(name==='getBankingWorkspace'){const list=await workspace.list(user,input),bank=await workspace.accounts(user);return {...list,accounts:bank.accounts,instructionDelivery:bank.instructionDelivery,operatorLoop:await readLoopStatus({packages:list.packages})};}
  if(name==='retryBankInstructions')return workspace.recoverInstructions(user,input);
  if(name==='getBankingPackage'){const pkg=await workspace.detail(user,input.packageId);return {package:pkg,operator:operator?await operator.status(user,pkg.id):null,operatorLoop:await readLoopStatus({packages:[pkg]})};}
  if(name==='getBankingCloseSupport'){
    const list=await workspace.list(user,{period:input.period});
    return {period:input.period,completeInventory:!list.truncated,packages:await Promise.all(list.packages.map(async p=>{const d=await workspace.detail(user,p.id);return {packageId:d.id,accountId:d.accountId,accountCurrency:d.accountCurrency,period:d.period,openingMinor:d.snapshot.openingMinor,closingMinor:d.snapshot.closingMinor,outstandingItems:d.snapshot.outstandingItems,reconciled:d.summary.reconciled,needsReview:d.summary.needsReview,reconciliation:d.evidence.reconciled || null};})),limitation:'Native evidence references only. Use period-close review with its current inventory, currency and book observations; never synthesize manual confirmations or advance protection here.',qboCalls:0};
  }
  if(name==='prepareBankingPackage'){
    const m=JSON.parse((await readArtifact(input.manifest)).toString('utf8'));
    if(m.kind!=='simulated-bank-statement-package' || m.version!==1 || !input.manifest.path.endsWith('/manifest.json'))throw new Error('Exact retained BF2 manifest required');
    const keys=['scope','accountId','accountCurrency','period','revision','previousPackageId','sourceSnapshotHash','policyVersion','openingMinor','closingMinor','balanceConvention','events','rows','outstandingItems','blockers'];
    const envelope=Object.fromEntries(keys.map(k=>[k,m[k]]));
    envelope.files=[...m.files,{fileId:hash({packageId:m.packageId,kind:'manifest',name:'manifest.json'}),kind:'manifest',path:input.manifest.path,sha256:input.manifest.sha256,rowCount:m.rows.length}];
    return workspace.register(user,envelope); // BF4 binds active company and write access; validates every artifact
  }
  throw new Error('Unsupported banking tool');
 }
 return {definitions:DEFINITIONS,execute,workspace,operator};
}
// Strict read-only sync adapter. It waits for the existing synchronizer; it never
// refreshes QBO itself and never claims a wall-clock read proves sync completeness.
function createBankingMirrorReader({Records,Agents,now=()=>Date.now(),wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=420000}={}){
 return async function readVerification({scope,phase,startedAt}){
  const deadline=now()+timeoutMs;
  for(;;){
   const agent=await Agents.findOne(scope).maxTimeMS(5000).lean();
   const sources=agent?.sync?.sources || {}, floor=phase==='after'?Date.parse(startedAt):now()-120000;
   const stamps=[...TXNS].map(entity=>sources[entity]);
   const ready=stamps.every(s=>s?.status==='current' && s.phase==='incremental' && Date.parse(s.lastSuccessAt)>=floor && Date.parse(s.lastSuccessAt)<=now() && Date.parse(s.since)>=floor && Date.parse(s.since)<=Date.parse(s.lastSuccessAt));
   if(ready){
    const records=await Records.find(scope).limit(100001).maxTimeMS(10000).lean();
    const current=await Agents.findOne(scope).maxTimeMS(5000).lean();
    if(records.length<=100000 && hash(current?.sync?.sources)===hash(sources))return {scope,complete:true,observedAt:new Date(now()).toISOString(),syncedThrough:new Date(Math.min(...stamps.map(s=>Date.parse(s.since)))).toISOString(),records:records.map(r=>({...r,scope,connectionId:String(r.connectionId)})),settlementEvents:[]};
   }
   if(now()>=deadline)throw Object.assign(new Error('Complete sync has not caught up; native outcome retained, never repeat Add/Match'),{code:'BANKING_OPERATOR_BLOCKED',status:409});
   await wait(1000);
  }
 };
}
function createBankingRuntime({root=path.resolve(__dirname,'../../..'),workspace=createBankingWorkspaceService(),Records=require('../models/CompanySyncRecord'),Agents=require('../models/BusinessAgent'),Users=require('../models/User'),enabled=()=>process.env.BANKING_OPERATOR_ENABLED==='true'}={}){
 const readVerification=createBankingMirrorReader({Records,Agents});
 const operator=createDefaultBankingOperator({root,workspace,readVerification,getRuleAccounts:async scope=>{const rows=await Records.find({...scope,entity:'Account',deleted:false}).limit(10001).maxTimeMS(5000).lean();if(rows.length>10000)throw new Error('Complete rule account catalog required');return rows.map(r=>r.record);},getAccount:async(scope,id)=>(await Records.findOne({...scope,entity:'Account',qboId:id,deleted:false}).maxTimeMS(5000).lean())?.record,
  resolveRows:async({scope,pkg,before})=>{
    const reservations=await require('../models/BankingEvent').find({...scope,kind:'reservation'}).limit(10001).maxTimeMS(5000).lean();
    if(reservations.length>10000)throw new Error('Complete creator reservations required');
    const accounts=before.records.filter(r=>r.entity==='Account' && !r.deleted).map(r=>r.record);
    return pkg.snapshot.events.filter(e=>e.source?.entity==='BankOrigin').map(event=>require('./bank-origin-resolution').prepareBankOriginResolution({event,accounts,reservations:reservations.map(r=>r.payload),mirrorSnapshot:before,asOf:new Date().toISOString()}));
  }});
 const L=require('./banking-operator-loop');
 const loop=L.createBankingOperatorLoop({workspace,operator,enabled,isTerraBusy:L.terraBusy,pauseStore:L.filePauseStore(path.join(root,'artifacts/banking/operator-loop-paused.json')),stateStore:L.fileStateStore(path.join(root,'artifacts/banking/operator-loop-state.json')),listUsers:async()=>{
   const agents=await Agents.find({'settings.monitoring':true,'settings.autonomous':true,environment:'production',realmId:'9130357222392856','grant.id':{$type:'string'}}).limit(3).maxTimeMS(5000).lean();
   const users=[];for(const a of agents){const u=await Users.findOne({_id:a.ownerId}).select('role').maxTimeMS(5000).lean();if(u)users.push({id:String(u._id),actorId:String(u._id),role:u.role});}return users;
 }});
 return {workspace,operator,loop,tools:createBankingAccountantTools({workspace,operator})};
}
module.exports={DEFINITIONS,createBankingAccountantTools,createBankingMirrorReader,createBankingRuntime};
