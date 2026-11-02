'use strict';
// A saved Invoice can bill its own TimeActivity without changing the time token.
// This derives close evidence; original runs, requests and receipts stay untouched.
const {hash}=require('./business-calendar');
const {sameQboValue,matchesQboRequest}=require('./qbo-semantic-compare');
const {creationSourceOf}=require('./general-estimate-recovery');
const {sameProvenRecord,explainedByOwnSettlements}=require('./general-write-close');
const witnesses=new WeakSet(),QID=/^[0-9]{1,30}$/;
const allLinks=r=>[...(r?.LinkedTxn||[]),...(r?.Line||[]).flatMap(l=>l.LinkedTxn||[])];
const cents=n=>{const c=Math.round(n*100);return typeof n==='number'&&Number.isSafeInteger(c)&&Math.abs(n*100-c)<0.000001?c:null;};
function timeTransition(original,current){
  if(original?.BillableStatus!=='Billable'||current?.BillableStatus!=='HasBeenBilled')return false;
  const before=Date.parse(original.MetaData?.LastUpdatedTime),after=Date.parse(current.MetaData?.LastUpdatedTime);
  if(!Number.isFinite(before)||!Number.isFinite(after)||after<before||!Number.isFinite(Date.parse(original.MetaData?.CreateTime)))return false;
  const view=r=>{const v=structuredClone(r);delete v.BillableStatus;delete v.MetaData.LastUpdatedTime;return v;};
  return sameQboValue(view(original),view(current),{entity:'TimeActivity'});
}
function billingMatches(time,invoice,{request=false}={}){
  const links=allLinks(invoice).filter(l=>l.TxnType==='TimeActivity'),header=(invoice.LinkedTxn||[]).filter(l=>l.TxnType==='TimeActivity');
  if(links.length!==1||header.length!==1||header[0].TxnId!==time.Id||![undefined,'0'].includes(header[0].TxnLineId)||Object.keys(header[0]).some(k=>!['TxnId','TxnType','TxnLineId'].includes(k)))return false;
  if(invoice.status==='Voided'||invoice.PrivateNote?.startsWith?.('Voided')||invoice.CurrencyRef?.value!=='CAD'&&!(request&&invoice.CurrencyRef===undefined)||invoice.CustomerRef?.value!==time.CustomerRef?.value||!QID.test(time.CustomerRef?.value||''))return false;
  const lines=(invoice.Line||[]).filter(l=>l.DetailType!=='SubTotalLineDetail');if(lines.length!==1||lines[0].DetailType!=='SalesItemLineDetail')return false;
  const line=lines[0],detail=line.SalesItemLineDetail,h=time.Hours,m=time.Minutes,rate=cents(time.HourlyRate);
  if(!Number.isSafeInteger(h)||h<0||!Number.isSafeInteger(m)||m<0||m>59||(time.Seconds??0)!==0||rate===null||rate<=0||!QID.test(time.ItemRef?.value||''))return false;
  const minutes=h*60+m,charge=minutes*rate;
  return Number.isSafeInteger(minutes)&&minutes>0&&Number.isSafeInteger(charge)&&charge%60===0&&detail?.ItemRef?.value===time.ItemRef.value&&detail.Qty===minutes/60&&cents(detail.UnitPrice)===rate&&cents(line.Amount)===charge/60;
}
function sameLineage(a,b){
  if(String(a.ownerId)!==String(b.ownerId)||String(a.actorId)!==String(b.actorId)||a.caseAuthority||b.caseAuthority)return false;
  if(!a.agentAuthority&&!b.agentAuthority)return true;
  try{return Boolean(a.agentAuthority&&b.agentAuthority&&require('./business-agent-authority').sameAgentLineage(a.agentAuthority,b.agentAuthority));}catch{return false;}
}
async function source(models,scope,run,ref,entity){
  if(!models.Receipts||run.caseAuthority||['environment','realmId','connectionId'].some(k=>String(run[k])!==String(scope[k])))return null;
  const item=run.items?.[ref],batches=(run.batches||[]).filter(b=>b.attempt===item?.attempt&&b.items.some(i=>i.ref===ref));if(batches.length!==1||!batches[0].transport?.receiptId)return null;
  const receipt=await models.Receipts.findOne({_id:batches[0].transport.receiptId,...scope,kind:'general-write',state:'saved'}).maxTimeMS(3000).lean();
  return creationSourceOf(run,ref,receipt,entity,'saved');
}
async function deriveTimeBilling({models,scope,runs,row,copy,ownSettlements}){
  if(!timeTransition(row.evidence?.accountant?.record,row.current))return null;
  const origins=[];
  for(const run of runs)for(const [ref,item]of Object.entries(run.items||{}))if(item.entity==='TimeActivity'&&item.op==='create'&&item.outcome==='saved'&&item.qboId===row.id)origins.push({run,ref});
  if(origins.length!==1)return null;
  const origin=origins[0],time=await source(models,scope,origin.run,origin.ref,'TimeActivity');
  if(!time||hash(time.original)!==hash(row.evidence.accountant.record)||!matchesQboRequest(time.wanted,time.original,{entity:'TimeActivity'}))return null;
  const consumers=[];
  for(const run of runs)for(const [ref,item]of Object.entries(run.items||{}))if(item.entity==='Invoice'&&item.op==='create'&&item.outcome==='saved'&&allLinks(item.record).some(l=>l.TxnType==='TimeActivity'&&l.TxnId===row.id))consumers.push({run,ref,item});
  if(consumers.length!==1)return null;
  const child=consumers[0];if(!sameLineage(origin.run,child.run))return null;
  const invoice=await source(models,scope,child.run,child.ref,'Invoice');if(!invoice)return null;
  const currentInvoice=await copy.read(scope,'Invoice',child.item.qboId);
  if(!currentInvoice||!billingMatches(time.original,invoice.wanted,{request:true})||!billingMatches(time.original,invoice.original)||!billingMatches(time.original,currentInvoice))return null;
  if(!matchesQboRequest(invoice.wanted,invoice.original,{entity:'Invoice'})||!sameProvenRecord('Invoice',invoice.original,currentInvoice,hash(invoice.original))&&!explainedByOwnSettlements(invoice.original,currentInvoice,ownSettlements,'Invoice'))return null;
  const created=Date.parse(invoice.original.MetaData?.CreateTime),billed=Date.parse(row.current.MetaData?.LastUpdatedTime);
  if(!Number.isFinite(created)||billed<created)return null;
  const proof=Object.freeze({version:1,kind:'own-invoice-time-billing',timeId:row.id,timeRecordHash:hash(row.current),originalRecordHash:hash(time.original),sourceOperationId:String(origin.run._id),sourceRef:origin.ref,sourceReceiptId:time.receiptId,sourceRequestHash:time.requestHash,invoiceId:child.item.qboId,invoiceOperationId:String(child.run._id),invoiceRef:child.ref,invoiceReceiptId:invoice.receiptId,invoiceRequestHash:invoice.requestHash,invoiceRecordHash:hash(currentInvoice)});
  witnesses.add(proof);return {proof,original:time.original};
}
function requestView(current,proof){return proof&&witnesses.has(proof)&&proof.timeId===current?.Id&&proof.timeRecordHash===hash(current)?{...current,BillableStatus:'Billable'}:null;}
module.exports={deriveTimeBilling,requestView,timeTransition,billingMatches};
