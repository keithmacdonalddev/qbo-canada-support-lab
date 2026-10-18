'use strict';
const {hash,canonical}=require('./business-calendar');
// Only the previously approved postpaid tax transition may differ across a quote
// and its later invoice. This verifies both original policies; it never retaxes.
function matchesDatedEstimateLink(compiled,invoice,source,step,policy){
 try{
  const binding=compiled.relationships.find(x=>x.entity==='Estimate'),quote=source.record,payload=JSON.parse(compiled.request.body),withoutHash=value=>{const {evidenceHash,...body}=value;return body;};
  if(!binding||source.entity!=='Estimate'||source.fingerprint!==binding.fingerprint||quote.Id!==binding.qboId||hash(step)!==compiled.intentHash||policy.stepHash!==compiled.intentHash||hash(withoutHash(policy))!==policy.evidenceHash||policy.status!=='approved'||source.originalPolicy?.status!=='approved'||canonical(source.originalPolicy.scope)!==canonical(compiled.request.scope)||canonical(policy.scope)!==canonical(compiled.request.scope)||step.txnDate!==invoice.TxnDate||payload.TxnDate!==invoice.TxnDate||invoice.GlobalTaxCalculation!=='TaxExcluded')return false;
  const il=invoice.Line.filter(x=>x.DetailType==='SalesItemLineDetail'),ql=quote.Line.filter(x=>x.DetailType==='SalesItemLineDetail');if(il.length!==1||ql.length!==1)return false;
  if(!require('./business-dated-tax').permitsDatedConversion(step,policy,source,ql[0].SalesItemLineDetail.TaxCodeRef.value,il[0].SalesItemLineDetail.TaxCodeRef.value))return false;
  const expected=require('./business-verification-runtime').taxExpectation(policy,compiled),tax=invoice.TxnTaxDetail,actual=tax?.TaxLine;
  const cents=v=>{const c=Math.round(v*100);return typeof v==='number'&&Number.isSafeInteger(c)&&c>=0&&Math.abs(v*100-c)<0.00001?c:null;};
  if(!expected||!Array.isArray(actual)||actual.length!==expected.lines.length||cents(tax.TotalTax)!==expected.totalTaxCents)return false;
  for(let n=0;n<actual.length;n++){const a=actual[n],d=a.TaxLineDetail,e=expected.lines[n];if(a.DetailType!=='TaxLineDetail'||d?.PercentBased!==true||d.TaxRateRef?.value!==e.rateId||d.TaxPercent!==e.percent||cents(a.Amount)!==e.amountCents||cents(d.NetAmountTaxable)!==e.taxableCents)return false;}
  const net=record=>record.Line.filter(x=>x.DetailType!=='SubTotalLineDetail').reduce((sum,l)=>sum+cents(l.Amount),0);
  return cents(invoice.TotalAmt)===net(invoice)+expected.totalTaxCents&&cents(quote.TotalAmt)===net(quote)+cents(quote.TxnTaxDetail.TotalTax);
 }catch{return false;}
}
module.exports={matchesDatedEstimateLink};
