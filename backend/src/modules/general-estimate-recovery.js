'use strict';
// Read-only recovery of a known saved Invoice. No SDK write, gesture, receipt
// rewriting, replacement create, or inference from an unknown transport outcome.
const { createHash } = require('node:crypto');
const { hash, canonical } = require('./business-calendar');
const { matchesQboRequest, sameQboValue } = require('./qbo-semantic-compare');
const { isComplete } = require('./general-write-merge');
const { NATIVE_REASON } = require('./estimate-conversion-policy');
const QID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const links = record => [...(record?.LinkedTxn || []), ...(record?.Line || []).flatMap(line => line.LinkedTxn || [])];
const validRecord = (record, entity, id) => Boolean(record && record.Id === id && record.sparse !== true && VERSION.test(record.SyncToken || '') && isComplete(entity, record));
function creationSourceOf(run, ref, receipt, entity, outcome) {
  try {
    const item=run.items?.[ref],op=run.plan?.operations?.find(row=>row.ref===ref);
    if(run.contract!=='general-write-v1'||item?.outcome!==outcome||item.entity!==entity||item.op!=='create'||op?.op!=='create'||op.entity!==entity||!QID.test(item.qboId||'')||Object.values(run.items).some(row=>row.outcome==='unknown'))return null;
    const batches=(run.batches||[]).filter(row=>row.attempt===item.attempt&&row.state==='answered'&&row.items?.some(sent=>sent.ref===ref));if(batches.length!==1)return null;
    const batch=batches[0],sent=batch.items.find(row=>row.ref===ref),rows=batch.transport?.response,proof=receipt?.observed;
    const scope={environment:run.environment,realmId:run.realmId,connectionId:String(run.connectionId)},request=require('./general-write-transport').buildGeneralBatch(scope,batch);
    if(batch.transport?.outcome!=='saved'||String(receipt?._id)!==String(batch.transport.receiptId)||receipt.kind!=='general-write'||receipt.state!=='saved'||['environment','realmId','connectionId','ownerId','actorId'].some(key=>String(receipt[key])!==String(run[key]))||receipt.requestHash!==request.requestHash||receipt.general?.runId!==String(run._id)||receipt.general.batchIndex!==batch.index||receipt.general.requestId!==batch.requestId||proof?.entity!=='batch'||proof.operation!=='create'||!Number.isInteger(proof.httpStatus)||proof.httpStatus<200||proof.httpStatus>=300||!Array.isArray(rows)||rows.length!==batch.items.length||new Set(rows.map(row=>row.bId)).size!==rows.length||proof.items?.length!==rows.length)return null;
    if(!rows.every(row=>{const {bId,...body}=row,originals=proof.items.filter(p=>p.bId===bId);return originals.length===1&&originals[0].outcome==='saved'&&originals[0].responseHash===createHash('sha256').update(JSON.stringify(body)).digest('hex');}))return null;
    const original=rows.find(row=>row.bId===sent.bId)?.[entity],wanted=sent.payload,savedIds=Object.fromEntries(Object.entries(run.items).filter(([,row])=>row.outcome==='saved').map(([key,row])=>[key,row.qboId]));
    if(canonical(require('./general-write-service').resolve(op.payload,savedIds))!==canonical(wanted)||sent.op!=='create'||sent.operation!=='create'||sent.entity!==entity||canonical(wanted)!==canonical(item.request)||canonical(original)!==canonical(item.record)||!validRecord(original,entity,item.qboId))return null;
    return {ownerId:String(run.ownerId),actorId:String(run.actorId),item,original,wanted,receiptId:String(receipt._id),requestHash:request.requestHash,batchIndex:batch.index,ref,operationId:String(run._id)};
  }catch{return null;}
}
function readSource(run,ref,receipt){
  const source=creationSourceOf(run,ref,receipt,'Invoice','mismatch');if(!source)return null;
  const {wanted,original}=source;
  if(!Array.isArray(wanted.LinkedTxn)||wanted.LinkedTxn.length!==1||wanted.LinkedTxn[0].TxnType!=='Estimate'||!QID.test(wanted.LinkedTxn[0].TxnId||'')||links(original).length||(wanted.Line||[]).some(line=>line.LinkedTxn))return null;
  const {LinkedTxn,...rest}=wanted;
  if(!matchesQboRequest(rest,original,{entity:'Invoice'})||matchesQboRequest(wanted,original,{entity:'Invoice'}))return null;
  return {...source,estimateId:wanted.LinkedTxn[0].TxnId};
}
function sourceOf(run, ref, receipt) { try { return readSource(run, ref, receipt); } catch { return null; } }
function packetOf(run, source) {
  return { version: 1, kind: 'saved-invoice-estimate-recovery', operationId: String(run._id), ref: source.ref, invoiceId: source.item.qboId, estimateId: source.estimateId, receiptId: source.receiptId, requestHash: source.requestHash, originalRecordHash: hash(source.original), requestedRecordHash: hash(source.wanted), action: 'native-repair-required', automaticNativeExecution: false, nativeRepairTool: 'repairEstimateConversion', reason: NATIVE_REASON, next: 'Attach this exact estimate to the existing invoice in QuickBooks. Preserve invoice identity, document number, customer, dates, lines, amounts, currency, tax and payments. Verify the Invoice link, reciprocal Closed Estimate and accounting before accepting recovery.' };
}
function hasReciprocalLink(invoice, estimate, source) {
  return validRecord(invoice, 'Invoice', source.item.qboId) && validRecord(estimate, 'Estimate', source.estimateId) && Array.isArray(invoice.LinkedTxn) && sameQboValue({ LinkedTxn: invoice.LinkedTxn }, { LinkedTxn: source.wanted.LinkedTxn }) && sameQboValue({ LinkedTxn: estimate.LinkedTxn || [] }, { LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }] }) && estimate.TxnStatus === 'Closed';
}
const nativeAssignments=new WeakSet();
function missingDocumentNumber(source){return source.original.DocNumber===undefined&&!Object.hasOwn(source.wanted,'DocNumber')?'TDL-R-'+source.item.qboId:null;}
function assignmentFor(source,proof){return proof&&nativeAssignments.has(proof)&&proof.invoiceId===source.item.qboId&&proof.receiptId===source.receiptId&&proof.requestHash===source.requestHash&&proof.docNumber===missingDocumentNumber(source)?proof.docNumber:null;}
function assertRepairedPair(source, invoice, estimate, originalEstimate = null, assignment = null) {
  if (!hasReciprocalLink(invoice, estimate, source) || !matchesQboRequest(source.wanted, invoice, { entity: 'Invoice' }) || !VERSION.test(source.original.SyncToken) || BigInt(invoice.SyncToken) <= BigInt(source.original.SyncToken)) return false;
  // A whole single-line source may replace that exact existing invoice line.
  // Its native identity/link may change; customer, money, tax, document number,
  // other lines/fields and the original creation receipts remain strict.
  const fullSource = record => (record?.Line || []).filter(line => line.DetailType !== 'SubTotalLineDetail');
  const beforeLines=fullSource(source.original),afterLines=fullSource(invoice),quoteLines=fullSource(originalEstimate);
  const replacement = originalEstimate && beforeLines.length===1 && afterLines.length===1 && quoteLines.length===1 && source.wanted.Line?.length===1 && source.wanted.Line[0].Id===undefined && beforeLines[0].DetailType==='SalesItemLineDetail' && afterLines[0].DetailType==='SalesItemLineDetail' && QID.test(beforeLines[0].Id||'') && QID.test(afterLines[0].Id||'') && QID.test(quoteLines[0].Id||'');
  const nativeLineLinks = afterLines[0]?.LinkedTxn;
  if(nativeLineLinks!==undefined && (!replacement || !Array.isArray(nativeLineLinks) || nativeLineLinks.length!==1 || nativeLineLinks[0].TxnId!==estimate.Id || nativeLineLinks[0].TxnType!=='Estimate' || Object.keys(nativeLineLinks[0]).some(key=>!['TxnId','TxnType','TxnLineId'].includes(key)) || ![undefined,'0',quoteLines[0].Id].includes(nativeLineLinks[0].TxnLineId)))return false;
  const assigned=assignmentFor(source,assignment);if(assigned&&invoice.DocNumber!==assigned)return false;
  const view = record => { const out = structuredClone(record); delete out.LinkedTxn;if(assigned&&out.DocNumber===undefined)out.DocNumber=assigned; if(replacement)for(const line of out.Line||[])if(line.DetailType==='SalesItemLineDetail'){delete line.Id;delete line.LinkedTxn;} return out; };
  if (!sameQboValue(view(source.original), view(invoice), { entity: 'Invoice', metadata: true })) return false;
  const beforeTime = Date.parse(source.original.MetaData?.LastUpdatedTime), afterTime = Date.parse(invoice.MetaData?.LastUpdatedTime);
  if (!Number.isFinite(beforeTime) || !Number.isFinite(afterTime) || afterTime < beforeTime || !Number.isFinite(Date.parse(source.original.MetaData?.CreateTime)) || source.original.MetaData.CreateTime !== invoice.MetaData?.CreateTime) return false;
  if (invoice.CustomerRef?.value !== estimate.CustomerRef?.value || invoice.CurrencyRef?.value !== estimate.CurrencyRef?.value || invoice.TotalAmt !== estimate.TotalAmt || !sameQboValue(invoice.TxnTaxDetail, estimate.TxnTaxDetail) || invoice.GlobalTaxCalculation !== estimate.GlobalTaxCalculation) return false;
  const financial = record => (record.Line || []).filter(line => line.DetailType !== 'SubTotalLineDetail').map(line => { const out = structuredClone(line); delete out.Id; delete out.Description; return out; });
  // Proposed descriptions can differ. This source-only comparison checks the
  // economics; matchesQboRequest and the full before/after view above still
  // preserve the Invoice Description, and assertEstimateTransition preserves
  // the Estimate Description independently.
  return sameQboValue(financial(source.original), financial(originalEstimate || estimate));
}
async function assessSavedEstimate({ run, ref, receipt, copy, scope, loadEstimate, loadAssignment = null, snapshot = null, now = () => Date.now() }) {
  if (['environment','realmId','connectionId'].some(key => String(run[key]) !== String(scope[key]))) return null;
  const source = sourceOf(run, ref, receipt); if (!source) return null;
  const packet = packetOf(run, source), pending = { ...source.item, next: { action: packet.action, reason: packet.reason, recovery: packet } };
  // The mirror is only a zero-call hint. Missing relationships cost no native
  // calls on repeated reviews. Successful recovery always uses stable fresh reads.
  const hintedInvoice = await copy.read(scope, 'Invoice', packet.invoiceId), hintedEstimate = await copy.read(scope, 'Estimate', packet.estimateId);
  if (!hasReciprocalLink(hintedInvoice, hintedEstimate, source) || typeof copy.fetch !== 'function' || !snapshot || typeof loadEstimate !== 'function') return pending;
  const estimateSource = await loadEstimate(source.estimateId);
  if (!estimateSource || !assertEstimateTransition(estimateSource.original, hintedEstimate, packet.invoiceId)) return pending;
  const assignment=loadAssignment?await loadAssignment(source,estimateSource.original):null;
  const startedAt = new Date(now()).toISOString(), first = { invoice: await copy.fetch(scope, 'Invoice', packet.invoiceId), estimate: await copy.fetch(scope, 'Estimate', packet.estimateId) };
  if (!assertRepairedPair(source, first.invoice, first.estimate, estimateSource.original,assignment) || !assertEstimateTransition(estimateSource.original,first.estimate,packet.invoiceId)) return pending;
  const second = { invoice: await copy.fetch(scope, 'Invoice', packet.invoiceId), estimate: await copy.fetch(scope, 'Estimate', packet.estimateId) };
  const ended = now();
  if (ended < Date.parse(startedAt) || ended - Date.parse(startedAt) > 60000 || canonical(first) !== canonical(second) || !assertRepairedPair(source, second.invoice, second.estimate, estimateSource.original,assignment)) return pending;
  const { next, errorDetail, ...saved } = source.item;
  const evidence = { version: 1, kind: 'saved-invoice-estimate-reconciled', ...scope, operationId: String(run._id), ref, receiptId: source.receiptId, requestHash: source.requestHash, originalRecordHash: hash(source.original), currentRecordHash: hash(second.invoice), estimateRecordHash: hash(second.estimate), sourceEstimate: { operationId:estimateSource.operationId,ref:estimateSource.ref,receiptId:estimateSource.receiptId,requestHash:estimateSource.requestHash,recordHash:hash(estimateSource.original) }, startedAt, observedAt: new Date(ended).toISOString(), accountingReportVerified: false, ...(assignment?{nativeAssignment:{actionId:assignment.actionId,authorityHash:assignment.authorityHash,completionHash:assignment.completionHash,docNumber:assignment.docNumber}}:{}) };
  return { ...saved, outcome: 'saved', complete: true, originalSavedRecord: source.original, record: second.invoice, version: second.invoice.SyncToken, parents: require('./general-write-merge').invalidatedParents(source.original, second.invoice), reconciliation: { ...evidence, evidenceHash: hash(evidence), estimate: second.estimate, estimateOriginal: estimateSource.original } };
}
module.exports = { sourceOf, packetOf, hasReciprocalLink, assertRepairedPair, assessSavedEstimate };

function assertEstimateTransition(original, current, invoiceId) {
  if (!validRecord(original,'Estimate',current?.Id) || !validRecord(current,'Estimate',original.Id) || !['Pending','Accepted'].includes(original.TxnStatus) || links(original).length || current.TxnStatus!=='Closed' || BigInt(current.SyncToken)<BigInt(original.SyncToken) || !sameQboValue({LinkedTxn:current.LinkedTxn||[]},{LinkedTxn:[{TxnId:invoiceId,TxnType:'Invoice'}]})) return false;
  const view=r=>{const v=structuredClone(r);delete v.LinkedTxn;delete v.TxnStatus;return v;};
  const before=Date.parse(original.MetaData?.LastUpdatedTime),after=Date.parse(current.MetaData?.LastUpdatedTime);
  return Number.isFinite(before)&&Number.isFinite(after)&&after>=before&&Number.isFinite(Date.parse(original.MetaData?.CreateTime))&&original.MetaData?.CreateTime===current.MetaData?.CreateTime&&sameQboValue(view(original),view(current),{entity:'Estimate',metadata:true});
}
async function loadEstimateCreation({Runs,Receipts,scope,ownerId,id,session}) {
  if(!Runs?.find||!Receipts)return null;
  let query=Runs.find({...scope,contract:'general-write-v1',ownerId,owned:{$elemMatch:{key:'Estimate:'+id,op:'create'}}});if(session)query=query.session(session);
  const origins=await query.limit(2).maxTimeMS(3000).lean();if(origins.length!==1||origins[0].caseAuthority)return null;
  const run=origins[0],refs=Object.entries(run.items||{}).filter(([,item])=>item.entity==='Estimate'&&item.qboId===id&&item.op==='create'&&item.outcome==='saved');if(refs.length!==1)return null;
  const [ref,item]=refs[0],batch=run.batches?.find(row=>row.attempt===item.attempt&&row.items?.some(sent=>sent.ref===ref));if(!batch?.transport?.receiptId)return null;
  let receiptQuery=Receipts.findOne({_id:batch.transport.receiptId,...scope,kind:'general-write',state:'saved'});if(session)receiptQuery=receiptQuery.session(session);
  const receipt=await receiptQuery.maxTimeMS(3000).lean(),source=creationSourceOf(run,ref,receipt,'Estimate','saved');
  return source&&matchesQboRequest(source.wanted,source.original,{entity:'Estimate'})?source:null;
}
function idleWriter(writer,scope) {
  return Boolean(writer&&['environment','realmId','connectionId'].every(key=>String(writer[key])===String(scope[key]))&&Number.isSafeInteger(writer.revision)&&writer.operationId===null&&writer.planHash===null&&writer.unresolved===null&&!writer.populationDelegation&&!(writer.resourceClaims||[]).length);
}
function createRecoveryFence({models,transaction,authorize,now=()=>Date.now()}) {
  const one=(Model,filter,session)=>{let q=Model.findOne(filter);if(session)q=q.session(session);return q.maxTimeMS(3000).lean();};
  const conflicts=async(scope,ids,session)=>{
    const graph=[{entity:'Invoice',id:ids.invoiceId},{entity:'Estimate',id:ids.estimateId}];
    const filter={...scope,state:{$in:['possibly-sent','unknown']},$or:[...graph.map(r=>({entity:r.entity.toLowerCase(),'observed.qboId':r.id})),{'periodProof.evidence.records':{$elemMatch:{$or:graph}}},{'periodProof.proofs.evidence.records':{$elemMatch:{$or:graph}}}]};
    let q=models.Receipts.find(filter);if(session)q=q.session(session);return (await q.limit(1).maxTimeMS(3000).lean()).length>0;
  };
  return {
    async start(scope,run,bound,ids){
      if(!models.Writers||!models.Users||!models.Memberships||!models.Receipts?.find||typeof transaction!=='function'||typeof authorize!=='function')return null;
      await authorize(scope,bound);
      const writer=await one(models.Writers,scope);if(!idleWriter(writer,scope)||await conflicts(scope,ids))return null;
      return {writerId:String(writer._id),revision:writer.revision,startedAt:now(),ids};
    },
    async commit({scope,run,bound,snapshots,work}){
      return transaction(async session=>{
        await authorize(scope,bound,session);
        for(const id of [...new Set([String(run.ownerId),String(run.actorId)])]) {
          const user=await one(models.Users,{_id:id},session),version=user?.connectionSwitchVersion??0;
          if(!user||!Number.isSafeInteger(version)||version<0)throw Error('Estimate recovery workspace user changed.');
          const touched=await models.Users.findOneAndUpdate({_id:id,role:user.role,connectionSwitchVersion:user.connectionSwitchVersion===undefined?{$exists:false}:version},{$inc:{connectionSwitchVersion:1}},{new:true,session}).lean();
          if(!touched)throw Error('Estimate recovery workspace changed.');
        }
        const member=await one(models.Memberships,{userId:String(run.actorId),realmId:scope.realmId,status:'active'},session);
        if(!member||!await models.Memberships.findOneAndUpdate({_id:member._id,userId:member.userId,realmId:scope.realmId,status:'active',role:member.role},{$inc:{businessSetupVersion:1}},{new:true,session}).lean())throw Error('Estimate recovery company permission changed.');
        if(run.agentAuthority)await require('./business-agent-authority').fenceAgentAuthority({authority:bound.agentAuthority,scope,ownerId:String(run.ownerId),actorId:String(run.actorId),Agents:models.Agents,session});
        const first=snapshots[0],writer=await one(models.Writers,scope,session);
        if(!snapshots.length||!idleWriter(writer,scope)||snapshots.some(s=>s.writerId!==String(writer._id)||s.revision!==writer.revision||now()<s.startedAt||now()-s.startedAt>60000))throw Error('Estimate recovery writer changed; retain the original mismatch.');
        for(const snapshot of snapshots)if(await conflicts(scope,snapshot.ids,session))throw Error('Estimate recovery has an unresolved linked write.');
        const touched=await models.Writers.findOneAndUpdate({_id:writer._id,...scope,revision:first.revision,operationId:null,planHash:null,unresolved:null},{$inc:{revision:1}},{new:true,session}).lean();
        if(!touched)throw Error('Estimate recovery writer changed before settlement.');
        return work(session);
      });
    }
  };
}

module.exports.creationSourceOf=creationSourceOf;module.exports.loadEstimateCreation=loadEstimateCreation;module.exports.assertEstimateTransition=assertEstimateTransition;module.exports.createRecoveryFence=createRecoveryFence;

function nativeAssignmentRef(proof){return proof?{actionId:proof.actionId,authorityHash:proof.authorityHash,completionHash:proof.completionHash,docNumber:proof.docNumber}:null;}
function storedReconciliation(run,ref,receipt,scope,assignment=null) {
  const item=run.items?.[ref],r=item?.reconciliation;if(item?.outcome!=='saved'||!item.originalSavedRecord||r?.kind!=='saved-invoice-estimate-reconciled')return null;
  if(r.nativeAssignment&&canonical(r.nativeAssignment)!==canonical(nativeAssignmentRef(assignment)))return null;
  const {evidenceHash,estimate,estimateOriginal,...evidence}=r;
  if(hash(evidence)!==evidenceHash||['environment','realmId','connectionId'].some(k=>String(r[k])!==String(scope[k]))||r.operationId!==String(run._id)||r.ref!==ref||r.currentRecordHash!==hash(item.record)||r.estimateRecordHash!==hash(estimate)||r.originalRecordHash!==hash(item.originalSavedRecord)||!estimateOriginal||hash(estimateOriginal)!==r.sourceEstimate?.recordHash)return null;
  const source=sourceOf({...run,items:{...run.items,[ref]:{...item,outcome:'mismatch',record:item.originalSavedRecord}}},ref,receipt);
  return source&&r.receiptId===source.receiptId&&r.requestHash===source.requestHash&&assertRepairedPair(source,item.record,estimate,estimateOriginal,assignment)?{source,evidence:r}:null;
}
module.exports.storedReconciliation=storedReconciliation;

async function loadNativeAssignment({models,scope,source,estimateOriginal,actionId=null,authorityHash=null,completed=true,session=null}){
  if(!source||!missingDocumentNumber(source)||!models.Authorities?.findOne)return null;
  const native=require('./general-estimate-native'),rootId=native.actionId(scope,{_id:source.operationId},source);
  const find=async id=>{let q=models.Authorities.findOne({_id:id,...scope});if(session)q=q.session(session);return q.maxTimeMS(3000).lean();};
  let id=actionId||rootId;
  for(let attempt=1;attempt<=4;attempt++){
    const authority=await find(id.slice(0,24)),body=authority?.payload,plan=body?.plan;
    if(!authority||authority.contentHash!==hash(body)||body.kind!==native.KIND||body.phase!=='admitted'||body.actionId!==id||plan?.actionId!==id||authorityHash&&authority.contentHash!==authorityHash||['environment','realmId','connectionId'].some(k=>String(authority[k])!==String(scope[k])||String(plan.scope?.[k])!==String(scope[k]))||String(authority.actorId)!==source.ownerId||body.ownerId!==source.ownerId||plan.ownerId!==source.ownerId||plan.actorId!==source.actorId||plan.source?.invoiceReceiptId!==source.receiptId||plan.source.invoiceRequestHash!==source.requestHash||plan.source.invoiceOriginalHash!==hash(source.original)||plan.invoiceId!==source.item.qboId||plan.estimateId!==source.estimateId||estimateOriginal&&plan.source.estimateOriginalHash!==hash(estimateOriginal))return null;
    const event=completed?await find(hash({actionId:id,phase:'verified'}).slice(0,24)):null;
    if(!completed||event){
      const candidate=missingDocumentNumber(source),numberProof=plan.documentNumberProof;
      if(plan.assignedMissingDocNumber!==candidate||plan.before.invoice.DocNumber!==undefined||numberProof?.docNumber!==candidate||numberProof.matches!==0||!Number.isFinite(Date.parse(numberProof.observedAt))||Date.parse(numberProof.observedAt)>Date.parse(plan.reviewedAt))return null;
      if(completed&&(event.contentHash!==hash(event.payload)||event.payload.phase!=='verified'||event.payload.authorityHash!==authority.contentHash||event.payload.actionId!==id||event.payload.after?.invoice?.DocNumber!==candidate||event.payload.beforeReportHash!==hash(plan.beforeReport)||canonical(native.reportShape(plan.beforeReport,plan.reportScope.dates))!==canonical(native.reportShape(event.payload.afterReport,plan.reportScope.dates))))return null;
      const proof={invoiceId:source.item.qboId,receiptId:source.receiptId,requestHash:source.requestHash,docNumber:candidate,actionId:id,authorityHash:authority.contentHash,completionHash:completed?event.contentHash:null};Object.freeze(proof);nativeAssignments.add(proof);return proof;
    }
    if(actionId)return null;
    const stopped=await find(hash({actionId:id,phase:'no-effect'}).slice(0,24));
    if(!stopped||stopped.contentHash!==hash(stopped.payload)||stopped.payload.authorityHash!==authority.contentHash||stopped.payload.phase!=='no-effect')return null;
    id=native.replacementId(rootId,stopped.contentHash);
  }
  return null;
}
module.exports.missingDocumentNumber=missingDocumentNumber;module.exports.loadNativeAssignment=loadNativeAssignment;

module.exports.nativeAssignmentRef=nativeAssignmentRef;
