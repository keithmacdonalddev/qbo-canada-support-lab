'use strict';
const {hash,canonical}=require('./business-calendar');
const {fail,equal,observation,headerLinks}=require('./business-link-repair-contract');
const HASH=/^[a-f0-9]{64}$/;
function createEstimateConversionProof({compiled,receipt,observed,estimateObserved,timeObserved,lineage,now=Date.now()}) {
  const request=require('./business-readback').validateCompilation(compiled),scope=request.scope,payload=JSON.parse(request.body),sources=compiled.relationships.filter(x=>x.entity==='Estimate'),times=compiled.relationships.filter(x=>x.entity==='TimeActivity');
  if(compiled.entity!=='Invoice'||sources.length!==1||times.length!==1||compiled.relationships.length!==2||!lineage||lineage.version!==1||!((lineage.kind==='verified-owned-link-repair'&&HASH.test(lineage.receiptId||'')&&HASH.test(lineage.receiptEvidenceHash||''))||(lineage.kind==='verified-owned-ui-link-correction'&&HASH.test(lineage.actionId||'')&&HASH.test(lineage.actionEvidenceHash||'')&&lineage.receiptId===undefined&&lineage.receiptEvidenceHash===undefined))||!HASH.test(lineage.authorityHash||'')||lineage.compilationHash!==compiled.compilationHash||lineage.creationReceiptHash!==receipt.evidenceHash||lineage.qboId!==receipt.qboId) fail('Legacy line compatibility needs exact separately audited repair lineage.');
  const invoice=observation(observed,scope,'Invoice',receipt.qboId,now),estimate=observation(estimateObserved,scope,'Estimate',sources[0].qboId,now),time=observation(timeObserved,scope,'TimeActivity',times[0].qboId,now);
  const financial=record=>(record.Line||[]).filter(x=>x.DetailType!=='SubTotalLineDetail'),lines=financial(invoice),sourceLines=financial(estimate),wanted=payload.Line;
  const top=(invoice.LinkedTxn||[]).filter(x=>x.TxnType==='Estimate'||x.TxnType==='TimeActivity');
  if(!equal(top.map(x=>({TxnId:x.TxnId,TxnType:x.TxnType})).sort((a,b)=>a.TxnType.localeCompare(b.TxnType)),[{TxnId:estimate.Id,TxnType:'Estimate'},{TxnId:time.Id,TxnType:'TimeActivity'}]) || top.some(x=>Object.keys(x).some(k=>!['TxnId','TxnType','TxnLineId'].includes(k))||![undefined,'0'].includes(x.TxnLineId)) || !equal(headerLinks(estimate.LinkedTxn),[{TxnId:invoice.Id,TxnType:'Invoice'}]) || estimate.TxnStatus!=='Closed' || time.BillableStatus!=='HasBeenBilled') fail('Real full-conversion header links and the sole Estimate backlink are required.');
  if(lines.length!==1||sourceLines.length!==1||wanted?.length!==1||lines[0].DetailType!=='SalesItemLineDetail'||sourceLines[0].DetailType!=='SalesItemLineDetail'||lines[0].LinkedTxn!==undefined||sourceLines[0].LinkedTxn!==undefined||!equal(wanted[0].LinkedTxn,[{TxnId:estimate.Id,TxnType:'Estimate',TxnLineId:sourceLines[0].Id}]) || sources[0].links.filter(x=>x.path==='Line.0.LinkedTxn'&&x.txnLineId===sourceLines[0].Id).length!==1) fail('Only the original sole full Estimate line may use this explicit compatibility representation.');
  const economy=line=>({Amount:line.Amount,DetailType:line.DetailType,ItemRef:line.SalesItemLineDetail?.ItemRef?.value,Qty:line.SalesItemLineDetail?.Qty,UnitPrice:line.SalesItemLineDetail?.UnitPrice,TaxCodeRef:line.SalesItemLineDetail?.TaxCodeRef?.value});
  if(!equal(economy(wanted[0]),economy(lines[0]))||!equal(economy(lines[0]),economy(sourceLines[0])) || !equal(invoice.CustomerRef,estimate.CustomerRef)||time.CustomerRef?.value!==invoice.CustomerRef?.value||time.ItemRef?.value!==lines[0].SalesItemLineDetail.ItemRef.value||time.Hours+time.Minutes/60!==lines[0].SalesItemLineDetail.Qty || !equal(invoice.CurrencyRef,estimate.CurrencyRef)||invoice.CurrencyRef?.value!=='CAD'||invoice.GlobalTaxCalculation!==estimate.GlobalTaxCalculation||invoice.ExchangeRate!==estimate.ExchangeRate||invoice.TotalAmt!==estimate.TotalAmt||!equal(invoice.TxnTaxDetail,estimate.TxnTaxDetail)) fail('Full conversion economics, tax, currency or customer differ.');
  const source={compiled,receipt,estimateObserved,timeObserved,lineage};
  const proof={version:1,kind:'full-estimate-header-conversion-compatibility',scope,logicalKey:compiled.logicalKey,qboId:invoice.Id,syncToken:invoice.SyncToken,recordHash:observed.recordHash,compilationHash:compiled.compilationHash,sourceLineId:sourceLines[0].Id,invoiceLineId:lines[0].Id,sourceRecordHash:estimateObserved.recordHash,timeRecordHash:timeObserved.recordHash,physicalInvoiceLineLinkReturned:false,representation:'whole-estimate-header-and-backlink',observedAt:[observed.observedAt,estimateObserved.observedAt,timeObserved.observedAt].sort()[0],source};
  return {...proof,evidenceHash:hash(proof)};
}
function verifyEstimateConversion({compiled,receipt,observed,parents,now}) {
  const proof=observed.estimateConversion;
  if(!proof||!HASH.test(proof.evidenceHash||''))return null;
  const recreated=createEstimateConversionProof({...proof.source,compiled,receipt,observed,now});
  if(canonical(recreated)!==canonical(proof)||!parents.some(x=>x.entity==='Estimate'&&x.recordHash===proof.sourceRecordHash)||!parents.some(x=>x.entity==='TimeActivity'&&x.recordHash===proof.timeRecordHash))fail('The separate full-conversion evidence changed during graph verification.');
  return proof;
}
// Original-create representation. This never supplies compatibility for an old
// line-link request and never accepts a missing provider relationship.
function verifyWholeEstimateCreation({compiled,receipt,observed,parents,now}) {
  const sources=compiled.relationships.filter(x=>x.entity==='Estimate'),times=compiled.relationships.filter(x=>x.entity==='TimeActivity');
  if(compiled.entity!=='Invoice'||sources.length!==1||times.length!==1||compiled.relationships.length!==2||sources[0].representation!=='whole-estimate-header'||!/^\d{1,30}$/.test(sources[0].sourceLineId||'')||!equal(sources[0].links,[{path:'LinkedTxn'}])) fail('An exact original whole-Estimate creation contract is required.');
  const payload=JSON.parse(compiled.request.body),source=parents.find(x=>x.logicalKey===sources[0].logicalKey),worked=parents.find(x=>x.logicalKey===times[0].logicalKey);
  const invoice=observation(observed,compiled.request.scope,'Invoice',receipt.qboId,now),estimate=observation(source,compiled.request.scope,'Estimate',sources[0].qboId,now),time=observation(worked,compiled.request.scope,'TimeActivity',times[0].qboId,now);
  const financial=record=>(record.Line||[]).filter(x=>x.DetailType!=='SubTotalLineDetail'),lines=financial(invoice),quoted=financial(estimate);
  const requested=[{TxnId:estimate.Id,TxnType:'Estimate'},{TxnId:time.Id,TxnType:'TimeActivity'}],actual=(invoice.LinkedTxn||[]).filter(x=>['Estimate','TimeActivity'].includes(x.TxnType));
  if(!equal(headerLinks(payload.LinkedTxn),requested)||!equal(headerLinks(actual),requested)||!equal(headerLinks(estimate.LinkedTxn),[{TxnId:invoice.Id,TxnType:'Invoice'}])||estimate.TxnStatus!=='Closed'||time.BillableStatus!=='HasBeenBilled') return false;
  if(payload.Line?.length!==1||lines.length!==1||quoted.length!==1||quoted[0].Id!==sources[0].sourceLineId||payload.Line[0].LinkedTxn!==undefined||lines[0].LinkedTxn!==undefined||quoted[0].LinkedTxn!==undefined) return false;
  const economy=line=>({Amount:line.Amount,DetailType:line.DetailType,ItemRef:line.SalesItemLineDetail?.ItemRef?.value,Qty:line.SalesItemLineDetail?.Qty,UnitPrice:line.SalesItemLineDetail?.UnitPrice,TaxCodeRef:line.SalesItemLineDetail?.TaxCodeRef?.value});
  const tax=record=>({TotalTax:record.TxnTaxDetail?.TotalTax,lines:(record.TxnTaxDetail?.TaxLine||[]).map(x=>({Amount:x.Amount,DetailType:x.DetailType,rate:x.TaxLineDetail?.TaxRateRef?.value,percent:x.TaxLineDetail?.TaxPercent,based:x.TaxLineDetail?.PercentBased,net:x.TaxLineDetail?.NetAmountTaxable}))});
  if(!equal(economy(payload.Line[0]),economy(lines[0]))||!equal(economy(lines[0]),economy(quoted[0]))||invoice.CustomerRef?.value!==estimate.CustomerRef?.value||time.CustomerRef?.value!==invoice.CustomerRef?.value||time.ItemRef?.value!==lines[0].SalesItemLineDetail?.ItemRef?.value||time.Hours+time.Minutes/60!==lines[0].SalesItemLineDetail?.Qty||invoice.CurrencyRef?.value!=='CAD'||estimate.CurrencyRef?.value!=='CAD'||invoice.GlobalTaxCalculation!==estimate.GlobalTaxCalculation||invoice.ExchangeRate!==estimate.ExchangeRate||invoice.TotalAmt!==estimate.TotalAmt||!equal(tax(invoice),tax(estimate))) return false;
  return true;
}
module.exports={createEstimateConversionProof,verifyEstimateConversion,verifyWholeEstimateCreation};
