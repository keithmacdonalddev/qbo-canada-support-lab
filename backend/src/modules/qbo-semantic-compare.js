'use strict';
// Compare provider JSON by business meaning. Unknown fields/arrays stay strict;
// only documented presentation/defaults and known unordered collections normalize.
const { canonical } = require('./business-calendar');
const FALSE_DEFAULTS = Object.freeze({
 // QBO adds this presentation flag to Estimate read/CDC responses while omitting
 // it from create receipts. Only absent/false is equivalent; true stays distinct.
 Estimate: ['FreeFormAddress'],
 Item: ['DeferredRevenue','SalesTaxIncluded','PurchaseTaxIncluded','TrackQtyOnHand','SubItem','Taxable','PrintGroupedItems'],
 Customer: ['Job','BillWithParent','IsProject','Taxable'], Vendor: ['Vendor1099','T4AEligible','T5018Eligible'], TaxCode: ['Hidden','Taxable','TaxGroup'],
});
const META = new Set(['SyncToken','MetaData','domain','sparse','CreateTime','LastUpdatedTime']);
const unordered = path => ['Line','LinkedTxn','Line.*.LinkedTxn','SalesTaxRateList.TaxRateDetail','PurchaseTaxRateList.TaxRateDetail','EffectiveTaxRate','TxnTaxDetail.TaxLine'].includes(path);
const txnType = type => ({BillPaymentCheck:'BillPayment',BillPaymentCreditCard:'BillPayment',ReceivePayment:'Payment'})[type] || type;
function normalizedBoundary(value) {
 if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return value;
 const day=value.slice(0,10); try { require('./business-calendar').date(day); return day; } catch { return value; }
}
function canonicalQboValue(value, { entity, metadata = false } = {}, path = '') {
 if (Array.isArray(value)) { const rows=value.map(v=>canonicalQboValue(v,{entity,metadata},path+'.*')); return unordered(path)?rows.sort((a,b)=>canonical(a).localeCompare(canonical(b))):rows; }
 if (!value || typeof value !== 'object') return value;
 const ref = /Ref$/.test(path.split('.').at(-1)) && typeof value.value === 'string';
 const link = ['LinkedTxn.*','Line.*.LinkedTxn.*'].includes(path);
 const history = path === 'EffectiveTaxRate.*';
 const taxDetail = ['SalesTaxRateList.TaxRateDetail.*','PurchaseTaxRateList.TaxRateDetail.*'].includes(path);
 return Object.fromEntries(Object.entries(value).filter(([key,v])=>!(metadata && !path && META.has(key)) && !(ref && key==='name') && !(!path && (FALSE_DEFAULTS[entity]||[]).includes(key) && (v===false||v===null)) && !(link && key==='TxnLineId' && v==='0') && !(taxDetail && ['TaxOrder','TaxOnTaxOrder'].includes(key) && v===0)).map(([key,v])=>[key,link && key==='TxnType'?txnType(v):history && ['EffectiveDate','EndDate'].includes(key)?normalizedBoundary(v):canonicalQboValue(v,{entity,metadata},path?path+'.'+key:key)]));
}
function sameQboValue(a,b,options={}) { return canonical(canonicalQboValue(a,options))===canonical(canonicalQboValue(b,options)); }
// One-to-one assignment preserves duplicates, including overlapping sparse line
// requests. Greedy matching can reject a valid assignment; reusable .some loses rows.
function matchRows(expected,actual,matches) {
 if (!Array.isArray(actual)||expected.length!==actual.length) return false;
 const assigned=new Map();
 const visit=(i,seen)=>{for(let j=0;j<actual.length;j++)if(!seen.has(j)&&matches(expected[i],actual[j])){seen.add(j);if(!assigned.has(j)||visit(assigned.get(j),seen)){assigned.set(j,i);return true;}}return false;};
 return expected.every((_,i)=>visit(i,new Set()));
}
function exactCents(value) {
 if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Missing money');
 const n=Math.round(value*100);
 if (!Number.isSafeInteger(n) || Math.abs(value*100-n)>Number.EPSILON*Math.max(1,Math.abs(value*100))*4) throw new TypeError('Sub-cent money');
 return n;
}
function matchesQboRequest(expected,actual,{entity,path='',transport=true}={}) {
 if (Array.isArray(expected)) return Array.isArray(actual) && (unordered(path)?matchRows(expected,actual,(a,b)=>matchesQboRequest(a,b,{entity,path:path+'.*',transport})):expected.length===actual.length&&expected.every((v,i)=>matchesQboRequest(v,actual[i],{entity,path:path+'.*',transport})));
 if (expected && typeof expected==='object') {
  if (!actual||typeof actual!=='object'||Array.isArray(actual))return false;
  const ref=/Ref$/.test(path.split('.').at(-1))&&typeof expected.value==='string';
  return Object.entries(expected).every(([key,v])=>{
   if (transport && !path && ['sparse','SyncToken'].includes(key) || ref && key==='name')return true;
   if ((!path&&(FALSE_DEFAULTS[entity]||[]).includes(key)||['ProcessPayment','ProcessBillPayment'].includes(key))&&(v===false||v===null)&&[undefined,null,false].includes(actual[key]))return true;
   // Purchase orders do not post. QBO can omit their optional due date; a
   // returned differing date still matters. Never waive invoice/bill due dates.
   if (!path && entity==='PurchaseOrder' && key==='DueDate' && actual[key]==null && /^\d{4}-\d{2}-\d{2}$/.test(v) && typeof expected.VendorRef?.value==='string' && typeof expected.TxnDate==='string' && Array.isArray(expected.Line) && expected.Line.length) return true;
   if(key==='LinkedTxn' && ['', 'Line.*'].includes(path))return sameQboValue({LinkedTxn:v},{LinkedTxn:actual[key]||[]});
   if (key==='Line' && !path && Array.isArray(actual.Line)) {
    const subtotals=actual.Line.filter(line=>line.DetailType==='SubTotalLineDetail');
    if (subtotals.length && (subtotals.length!==1 || actual.Line.at(-1)!==subtotals[0] || !Array.isArray(v) || !v.length || v.some(line=>line.DetailType!=='SalesItemLineDetail') || !v.every(line=>Number.isFinite(line.Amount)) || Math.abs(subtotals[0].Amount-v.reduce((n,line)=>n+line.Amount,0))>=1e-8 || !Number.isFinite(subtotals[0].Amount))) return false;
   }
   const saved=key==='Line'&&!path&&Array.isArray(actual.Line)?actual.Line.filter(line=>line.DetailType!=='SubTotalLineDetail'):actual[key];
   return matchesQboRequest(v,saved,{entity,path:path?path+'.'+key:key,transport});
  });
 }
 if(typeof expected==='number' && transport && path.split('.').at(-1)==='UnitPrice') return typeof actual==='number' && Number.isFinite(actual) && expected===actual;
 if(typeof expected==='number' && ['Amount','TotalAmt','UnitPrice'].includes(path.split('.').at(-1))) { try { return exactCents(expected)===exactCents(actual); } catch { return false; } }
 if(typeof expected==='number')return typeof actual==='number'&&Number.isFinite(actual)&&Math.abs(expected-actual)<1e-8;
 return expected===actual;
}
module.exports={canonicalQboValue,sameQboValue,matchesQboRequest,matchRows};
