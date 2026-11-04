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
  const receipt=await one(models.Receipts,{_id:batch.transport.receiptId,...scope}),typed=plan.source.kind===require('../../backend/src/modules/general-time-estimate-source').KIND;
  const state=typed?await require('../../backend/src/modules/general-time-estimate-source').loadSource({models,scope,run,ref:plan.ref,now}):null;
  const source=typed?state?.source:recovery.sourceOf(run,plan.ref,receipt);
  const estimate=typed?state?.estimate:source&&await recovery.loadEstimateCreation({Runs:models.GeneralWriteRuns,Receipts:models.Receipts,scope,ownerId:run.ownerId,id:source.estimateId});
  if(typed)check(state?.bindingHash===plan.source.bindingHash&&hash(state.binding)===plan.source.bindingHash&&hash(state.time.original)===hash(plan.before.time),'Typed original calendar/time source changed');
  check(source&&estimate&&source.item.qboId===plan.invoiceId&&source.estimateId===plan.estimateId&&source.receiptId===plan.source.invoiceReceiptId&&source.requestHash===plan.source.invoiceRequestHash&&hash(source.original)===plan.source.invoiceOriginalHash&&estimate.receiptId===plan.source.estimateReceiptId&&estimate.requestHash===plan.source.estimateRequestHash&&hash(estimate.original)===plan.source.estimateOriginalHash,'Native original receipts differ');
  const native=require('../../backend/src/modules/general-estimate-native'),rootId=native.actionId(scope,run,source);
  const missing=recovery.missingDocumentNumber(source);
  if(missing)check(plan.assignedMissingDocNumber===missing&&plan.before.invoice.DocNumber===undefined&&plan.documentNumberProof?.docNumber===missing&&plan.documentNumberProof.matches===0&&Number.isFinite(Date.parse(plan.documentNumberProof.observedAt))&&Date.parse(plan.documentNumberProof.observedAt)<=Date.parse(plan.reviewedAt),'Missing invoice number has no reviewed uniqueness authority');
  else check(!plan.assignedMissingDocNumber,'An existing invoice number cannot be reassigned');
  if((plan.attempt||1)===1)check(actionId===rootId&&(plan.rootActionId||actionId)===rootId&&!plan.predecessor,'Invalid root native launch');
  else{
    check([2,3,4].includes(plan.attempt)&&plan.rootActionId===rootId,'Native lineage launch limit exceeded');
    const root=await one(models.Authorities,{_id:rootId.slice(0,24),...scope}),rootPlan=root?.payload?.plan;
    const rootStop=await one(models.Authorities,{_id:hash({actionId:rootId,phase:'no-effect'}).slice(0,24),...scope});
    check(root&&root.contentHash===hash(root.payload)&&(rootPlan?.attempt||1)===1&&!rootPlan.predecessor&&canonical(rootPlan.source)===canonical(plan.source)&&rootPlan.ownerId===plan.ownerId&&rootPlan.invoiceId===plan.invoiceId&&rootPlan.estimateId===plan.estimateId,'Replacement root differs');
    check(rootStop&&rootStop.contentHash===hash(rootStop.payload)&&rootStop.payload.phase==='no-effect'&&(rootStop.payload.reason==='native-executable-unavailable'||rootStop.payload.reason===native.BLANK_DESCRIPTION_STOP&&typed&&plan.attempt===2&&native.blankOptionalDescription(rootPlan.before.invoice))&&rootStop.payload.authorityHash===root.contentHash,'Replacement root no-effect is missing');
    if(rootStop.payload.reason===native.BLANK_DESCRIPTION_STOP){const cleanup=await one(models.Authorities,{_id:hash({actionId:rootId,phase:'draft-cleanup-complete'}).slice(0,24),...scope});check(/^[a-f0-9]{64}$/.test(rootStop.payload.stopEvidence?.sha256||'')&&cleanup&&cleanup.contentHash===hash(cleanup.payload)&&cleanup.payload.authorityHash===root.contentHash&&cleanup.payload.proof?.onlyHomepage===true&&cleanup.payload.proof.invoiceId===plan.invoiceId&&cleanup.payload.proof.runId===rootPlan.runId&&canonical(cleanup.payload.proof)===canonical(rootStop.payload.cleanup)&&plan.browserReadiness?.onlyHomepage===true&&Number.isFinite(Date.parse(plan.browserReadiness.observedAt))&&Date.parse(plan.browserReadiness.observedAt)>=Date.parse(rootStop.payload.verifiedAt)&&Date.parse(plan.browserReadiness.observedAt)<=Date.parse(plan.reviewedAt),'Blank optional Description successor requires exact journaled cleanup and fresh responsive homepage');}
    let previous=root,stopped=rootStop,previousId=rootId;
    if(plan.attempt>=3){
      previousId=native.replacementId(rootId,rootStop.contentHash);previous=await one(models.Authorities,{_id:previousId.slice(0,24),...scope});stopped=await one(models.Authorities,{_id:hash({actionId:previousId,phase:'no-effect'}).slice(0,24),...scope});
      const second=previous?.payload?.plan,rootUse=await one(models.Authorities,{_id:hash({actionId:rootId,phase:'replacement-admitted'}).slice(0,24),...scope});
      check(plan.browserReadiness?.onlyHomepage===true&&Number.isFinite(Date.parse(plan.browserReadiness.observedAt))&&Date.parse(plan.browserReadiness.observedAt)>=Date.parse(stopped?.payload?.verifiedAt)&&Date.parse(plan.browserReadiness.observedAt)<=Date.parse(plan.reviewedAt),'Final native admission requires a fresh responsive homepage after no-effect settlement');
      check(missing&&previous&&previous.contentHash===hash(previous.payload)&&second?.attempt===2&&second.rootActionId===rootId&&second.predecessor?.actionId===rootId&&second.predecessor.authorityHash===root.contentHash&&second.predecessor.noEffectHash===rootStop.contentHash&&!second.assignedMissingDocNumber&&canonical(second.source)===canonical(plan.source),'Only the historical missing-number second action admits a final successor');
      check(rootUse&&rootUse.contentHash===hash(rootUse.payload)&&rootUse.payload.authorityHash===root.contentHash&&rootUse.payload.noEffectHash===rootStop.contentHash&&rootUse.payload.successorActionId===previousId&&rootUse.payload.successorAuthorityHash===previous.contentHash,'Historical second launch was not consumed from its root');
      const cleanup=await one(models.Authorities,{_id:hash({actionId:previousId,phase:'draft-cleanup-complete'}).slice(0,24),...scope});
      check(stopped?.payload?.reason==='missing-invoice-document-number'&&cleanup&&cleanup.contentHash===hash(cleanup.payload)&&cleanup.payload.authorityHash===previous.contentHash&&cleanup.payload.proof?.invoiceId===plan.invoiceId&&cleanup.payload.proof.runId===second.runId&&canonical(cleanup.payload.proof)===canonical(stopped.payload.cleanup),'Final launch requires exact journaled owned-draft cleanup');
      check(!await one(models.Authorities,{_id:hash({actionId:previousId,phase:'verified'}).slice(0,24),...scope}),'A saved second action never admits replacement');
    }
    if(plan.attempt===4){
      const secondId=previousId,secondAuthority=previous,secondStop=stopped;previousId=native.replacementId(rootId,secondStop.contentHash);previous=await one(models.Authorities,{_id:previousId.slice(0,24),...scope});stopped=await one(models.Authorities,{_id:hash({actionId:previousId,phase:'no-effect'}).slice(0,24),...scope});
      const third=previous?.payload?.plan,use=await one(models.Authorities,{_id:hash({actionId:secondId,phase:'replacement-admitted'}).slice(0,24),...scope});
      check(previous&&previous.contentHash===hash(previous.payload)&&third?.attempt===3&&third.rootActionId===rootId&&third.predecessor?.actionId===secondId&&third.predecessor.authorityHash===secondAuthority.contentHash&&third.predecessor.noEffectHash===secondStop.contentHash&&third.assignedMissingDocNumber===missing&&canonical(third.source)===canonical(plan.source),'Only the exact historical third action admits the informational-notice successor');
      check(use&&use.contentHash===hash(use.payload)&&use.payload.authorityHash===secondAuthority.contentHash&&use.payload.noEffectHash===secondStop.contentHash&&use.payload.successorActionId===previousId&&use.payload.successorAuthorityHash===previous.contentHash,'Historical third action was not consumed from its predecessor');
      check(stopped?.payload?.reason==='unrestored-informational-draft-notice'&&/^[a-f0-9]{64}$/.test(stopped.payload.stopEvidence?.sha256||'')&&Date.parse(plan.browserReadiness.observedAt)>=Date.parse(stopped.payload.verifiedAt),'Final informational-notice action requires a newer responsive homepage');
      check(!await one(models.Authorities,{_id:hash({actionId:previousId,phase:'verified'}).slice(0,24),...scope}),'A saved third action never admits replacement');
    }
    check(plan.predecessor?.actionId===previousId&&plan.predecessor.authorityHash===previous.contentHash&&stopped&&stopped.contentHash===hash(stopped.payload)&&stopped.contentHash===plan.predecessor.noEffectHash&&stopped.payload.phase==='no-effect'&&stopped.payload.authorityHash===previous.contentHash&&stopped.payload.noDraft?.onlyHomepage===true&&(typed?require('../../backend/src/modules/general-time-estimate-source').unchangedParent(source.original,stopped.payload.after?.invoice,'Invoice')&&require('../../backend/src/modules/general-time-estimate-source').unchangedParent(estimate.original,stopped.payload.after?.estimate,'Estimate')&&require('../../backend/src/modules/general-time-estimate-source').unchangedParent(state.time.original,stopped.payload.after?.time,'TimeActivity'):native.unchanged(source.original,stopped.payload.after?.invoice,'Invoice')&&native.unchanged(estimate.original,stopped.payload.after?.estimate,'Estimate'))&&actionId===native.replacementId(rootId,stopped.contentHash),'Replacement requires exact unchanged no-effect evidence');
    const consumed=await one(models.Authorities,{_id:hash({actionId:previousId,phase:'replacement-admitted'}).slice(0,24),...scope});
    check(consumed&&consumed.contentHash===hash(consumed.payload)&&consumed.payload.phase==='replacement-admitted'&&consumed.payload.authorityHash===previous.contentHash&&consumed.payload.noEffectHash===stopped.contentHash&&consumed.payload.successorActionId===actionId&&consumed.payload.successorAuthorityHash===authorityHash,'Replacement proof was not atomically consumed for this child');
    check(!await one(models.Authorities,{_id:hash({actionId:rootId,phase:'verified'}).slice(0,24),...scope}),'A saved root never admits replacement');
  }
  const policy=await one(models.Policies,scope);
  check(policy?.state==='active'&&policy.revision===plan.policyRevision+2&&policy.periodControl?.contentHash===plan.controlHash,'Native period control changed');
  const semantic=freezeWriteRequest(scope,'POST','invoice',{Id:plan.invoiceId,SyncToken:plan.before.invoice.SyncToken,sparse:true,LinkedTxn:typed?require('../../backend/src/modules/general-time-estimate-source').linksFor(state):[{TxnId:plan.estimateId,TxnType:'Estimate'}]});
  require('../../backend/src/modules/qbo-write-period').assertWritePeriod(semantic,plan.periodProof.evidence,policy.periodControl,now,plan.ownerId);
  if(plan.agentAuthority){
    const agent=await one(models.Agents,{_id:plan.agentAuthority.agentId,...scope,ownerId:plan.ownerId});
    check(agent?.settings?.monitoring===true&&agent.settings.autonomous===true&&agent.grant?.ownerId===plan.ownerId&&require('../../backend/src/modules/business-agent-authority').ownsAgentWork(plan.agentAuthority,agent),'Native accountant grant changed');
  }else check(plan.actorProvenance==='codex-cli under exact owner-targeted request','Native coding authorization differs');
  return {invoiceId:plan.invoiceId,estimateId:plan.estimateId,...(plan.assignedMissingDocNumber?{assignedMissingDocNumber:plan.assignedMissingDocNumber}:{})};
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
    process.stdout.write(result.invoiceId+' '+result.estimateId+' '+(result.assignedMissingDocNumber||'none')+'\n');
  }finally{await mongoose.disconnect();}
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{process.stderr.write('Exact native repair authority validation failed\n');process.exitCode=4;});
module.exports={validateNativeLaunch,claimNativeLaunch};
