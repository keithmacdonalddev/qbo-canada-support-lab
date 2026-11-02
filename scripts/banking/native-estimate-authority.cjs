'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {hash,canonical}=require('../../backend/src/modules/business-calendar');
const {scoped,freezeWriteRequest}=require('../../backend/src/modules/qbo-write-contract');
const recovery=require('../../backend/src/modules/general-estimate-recovery');
const KIND='general-estimate-native-action';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const one=(Model,filter)=>Model.findOne(filter).maxTimeMS(3000).lean();
async function validateNativeLaunch({models,access,actionId,authorityHash,runId,task,leaseOwner,now=Date.now(),browserScope={environment:'production',realmId:require('../../backend/src/modules/qbo-browser-login').REALM}}) {
  check(/^[a-f0-9]{64}$/.test(actionId||'')&&/^[a-f0-9]{64}$/.test(authorityHash||'')&&/^bf7-[a-f0-9-]{36}$/.test(runId||''),'Exact native launch identifiers required');
  const admitted=await one(models.Authorities,{_id:actionId.slice(0,24)}),body=admitted?.payload,plan=body?.plan;
  check(admitted?.contentHash===authorityHash&&hash(body)===authorityHash&&body.kind===KIND&&body.phase==='admitted'&&body.actionId===actionId&&plan?.actionId===actionId,'Native authority is missing or changed');
  const scope=scoped(plan.scope);
  check(scope.environment===browserScope.environment&&scope.realmId===browserScope.realmId&&canonical(scoped({...admitted,connectionId:String(admitted.connectionId)}))===canonical(scope),'Native company differs');
  check(plan.runId===runId&&hash(task)===plan.promptHash&&plan.prompt===task&&plan.promptHash===hash(require('../../backend/src/modules/general-estimate-native').promptFor(plan)),'Native task or run changed');
  check(Number.isFinite(Date.parse(plan.reviewedAt))&&Date.parse(plan.reviewedAt)<=now&&now<=Date.parse(plan.deadlineAt)&&Date.parse(plan.deadlineAt)-Date.parse(plan.reviewedAt)===300000,'Native action expired');
  check(typeof leaseOwner==='string'&&/^terra-live-qbo-signin-[a-f0-9-]+-[0-9]+-[0-9]+$/.test(leaseOwner)&&plan.browserLeaseHash===hash(leaseOwner),'Native browser lease changed');
  check(plan.ownerId===plan.actorId&&String(admitted.actorId)===plan.ownerId,'Native owner differs');
  await access.authorize(scope,'operations.execute');
  const started=await one(models.Authorities,{_id:hash({actionId,phase:'started'}).slice(0,24),...scope});
  check(started?.contentHash===hash(started.payload)&&started.payload.authorityHash===authorityHash&&started.payload.runId===runId&&started.payload.promptHash===plan.promptHash&&started.payload.phase==='started','Native start is missing or changed');
  for(const phase of ['returned','verified'])check(!await one(models.Authorities,{_id:hash({actionId,phase}).slice(0,24),...scope}),'Native run already returned or completed');
  const writer=await one(models.Writers,scope),marker=writer?.unresolved;
  check(writer?.operationId===null&&writer.planHash===null&&!(writer.resourceClaims||[]).length&&!writer.populationDelegation&&marker?.kind===KIND&&marker.actionId===actionId&&marker.authorityHash===authorityHash&&marker.operationId===plan.operationId&&marker.invoiceId===plan.invoiceId&&marker.estimateId===plan.estimateId,'Native writer changed');
  const run=await one(models.GeneralWriteRuns,{_id:plan.operationId,...scope}),item=run?.items?.[plan.ref],batch=run?.batches?.find(b=>b.attempt===item?.attempt&&b.items?.some(i=>i.ref===plan.ref));
  check(run&&String(run.ownerId)===plan.ownerId&&String(run.actorId)===plan.actorId&&!run.caseAuthority&&batch?.transport?.receiptId,'Native original work differs');
  const receipt=await one(models.Receipts,{_id:batch.transport.receiptId,...scope}),source=recovery.sourceOf(run,plan.ref,receipt);
  const estimate=source&&await recovery.loadEstimateCreation({Runs:models.GeneralWriteRuns,Receipts:models.Receipts,scope,ownerId:run.ownerId,id:source.estimateId});
  check(source&&estimate&&source.item.qboId===plan.invoiceId&&source.estimateId===plan.estimateId&&source.receiptId===plan.source.invoiceReceiptId&&source.requestHash===plan.source.invoiceRequestHash&&hash(source.original)===plan.source.invoiceOriginalHash&&estimate.receiptId===plan.source.estimateReceiptId&&estimate.requestHash===plan.source.estimateRequestHash&&hash(estimate.original)===plan.source.estimateOriginalHash,'Native original receipts differ');
  const policy=await one(models.Policies,scope);
  check(policy?.state==='active'&&policy.revision===plan.policyRevision+2&&policy.periodControl?.contentHash===plan.controlHash,'Native period control changed');
  const semantic=freezeWriteRequest(scope,'POST','invoice',{Id:plan.invoiceId,SyncToken:plan.before.invoice.SyncToken,sparse:true,LinkedTxn:[{TxnId:plan.estimateId,TxnType:'Estimate'}]});
  require('../../backend/src/modules/qbo-write-period').assertWritePeriod(semantic,plan.periodProof.evidence,policy.periodControl,now,plan.ownerId);
  if(plan.agentAuthority){
    const agent=await one(models.Agents,{_id:plan.agentAuthority.agentId,...scope,ownerId:plan.ownerId});
    check(agent?.settings?.monitoring===true&&agent.settings.autonomous===true&&agent.grant?.ownerId===plan.ownerId&&require('../../backend/src/modules/business-agent-authority').ownsAgentWork(plan.agentAuthority,agent),'Native accountant grant changed');
  }else check(plan.actorProvenance==='codex-cli under exact owner-targeted request','Native coding authorization differs');
  return {invoiceId:plan.invoiceId,estimateId:plan.estimateId};
}
async function claimNativeLaunch(directory,body){await fs.writeFile(path.join(directory,'native-launch-consumed.json'),JSON.stringify(body),{flag:'wx'});}
async function main(argv) {
  check(argv.length===5,'Expected exact action, authority, run, task and lease directory');
  const [actionId,authorityHash,runId,taskFile,leaseDirectory]=argv;
  check(path.resolve(leaseDirectory)===path.join(os.tmpdir(),'qbo-terra-live.lock'),'Unexpected lease directory');
  const leaseOwner=process.env.TDL_QBO_SESSION_OWNER;
  check((await fs.readFile(path.join(leaseDirectory,'owner.txt'),'utf8')).trim()===leaseOwner,'Shared native lease changed');
  const root=path.resolve(__dirname,'../..');
  const target=await fs.realpath(taskFile),expected=await fs.realpath(path.join(root,'artifacts/banking/operator-tasks',runId,'task.txt'));
  check(target===expected,'Unexpected native task path');
  require('dotenv').config({path:path.join(root,'.env'),quiet:true});
  const mongoose=require('mongoose');
  for(const name of ['User','Connection','CompanyMembership','AuditLog'])require('../../backend/src/models/'+name);
  const models={...require('../../backend/src/modules/business-runtime').loadModels(),Agents:require('../../backend/src/models/BusinessAgent')};
  try{
    require('../../backend/src/modules/storage-target').configureDatabaseDns();
    await mongoose.connect(require('../../backend/src/config').mongoUri,{autoCreate:false,autoIndex:false,serverSelectionTimeoutMS:5000});
    const admitted=await one(models.Authorities,{_id:actionId.slice(0,24)}),plan=admitted?.payload?.plan;
    check(plan,'Missing native authority');
    const access=require('../../backend/src/modules/business-runtime-access').createBusinessRuntimeAccess({ownerId:plan.ownerId,actorId:plan.actorId});
    const result=await validateNativeLaunch({models,access,actionId,authorityHash,runId,task:await fs.readFile(target,'utf8'),leaseOwner});
    await claimNativeLaunch(path.dirname(target),{version:1,actionId,authorityHash,runId,promptHash:plan.promptHash,leaseHash:hash(leaseOwner),claimedAt:new Date().toISOString()});
    process.stdout.write(result.invoiceId+' '+result.estimateId+'\n');
  }finally{await mongoose.disconnect();}
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{process.stderr.write('Exact native repair authority validation failed\n');process.exitCode=4;});
module.exports={validateNativeLaunch,claimNativeLaunch};
