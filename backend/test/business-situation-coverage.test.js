'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const load=process.env.QBO_COVERAGE_SCRATCH ? require(process.env.QBO_COVERAGE_SCRATCH) : name=>require('../src/modules/'+name);
const coverage=load('coverage'),catalog=load('business-situation-catalog');
const NOW=new Date('2026-10-31T22:45:00Z'),TODAY='2026-10-31';
const scope={environment:'production',realmId:'9130357222392856',connectionId:'6a18e43d0b392890a1303e03'};
const source=()=>({phase:'incremental',status:'current',lastSuccessAt:NOW.toISOString(),everyMs:21600000});
const row=(entity,id,record={},extra={})=>({entity,qboId:String(id),record:{Id:String(id),TxnDate:TODAY,...record},deleted:false,...extra});
function snapshot(records=[]) {
  const entities=Object.keys(catalog.entityArea).concat(['TaxCode','CompanyInfo']);
  return {sources:Object.fromEntries(entities.map(e=>[e,source()])),records:[
    row('Preferences','prefs',{TxnDate:undefined,CurrencyPrefs:{HomeCurrency:{value:'CAD'},MultiCurrencyEnabled:false},AccountingInfoPrefs:{ClassTrackingPerTxnLine:true,TrackDepartments:true}}),
    row('CompanyInfo','company',{TxnDate:undefined,CompanyAddr:{CountrySubDivisionCode:'NS'}}),...records]};
}
const score=s=>coverage.situations(s,{now:NOW});
const get=(s,key)=>score(s).rows.find(r=>r.key===key);
test('versioned catalogue has unique keys, discovery areas and broad lifecycle depth',()=>{
  assert.ok(catalog.SITUATIONS.length>=300);
  assert.equal(new Set(catalog.SITUATIONS.map(r=>r.key)).size,catalog.SITUATIONS.length);
  for(const r of catalog.SITUATIONS) assert.ok(catalog.AREA_NAMES[r.area],r.key);
  for(const entity of ['Invoice','Bill','Payment','BillPayment','PurchaseOrder','Estimate','SalesReceipt','RefundReceipt','CreditMemo','VendorCredit','JournalEntry','Transfer','Deposit','Purchase','TimeActivity','InventoryAdjustment','Item','Customer','Vendor','Employee']) assert.ok(catalog.SITUATIONS.filter(r=>r.entity===entity).length>=4,entity);
});
test('seven-day window is inclusive and excludes future activity and observation time',()=>{
  const s=snapshot([row('Invoice',1,{TxnDate:'2026-10-25',TotalAmt:100,Balance:40}),row('Invoice',2,{TxnDate:'2026-10-24',TotalAmt:100,Balance:40},{lastObservedAt:NOW}),row('Invoice',3,{TxnDate:'2026-11-01',TotalAmt:100,Balance:40})]);
  const r=get(s,'Invoice.partially-paid');
  assert.equal(r.count,2);assert.equal(r.recentCount,1);assert.equal(r.example.id,'1');assert.equal(r.status,'present');
  assert.equal(score(s).from,'2026-10-25');
});
test('old states remain present at all, with an example, and are weekly gaps',()=>{
  const s=snapshot([row('Bill',7,{TxnDate:'2024-01-01',Balance:10,TotalAmt:20})]);
  const r=get(s,'Bill.partially-paid');assert.equal(r.status,'stale');assert.equal(r.presentAtAll,true);assert.equal(r.presentLast7Days,false);assert.equal(r.example.href,'/explorer?type=Bill&id=7');
  const w=coverage.weekly(s,{now:NOW}).rows.find(r=>r.key===rKey());function rKey(){return 'Bill.partially-paid';}
  assert.equal(w.status,'missing');assert.equal(w.count,0);assert.equal(w.example.id,'7');
});
test('missing or stale sources and scan truncation are unknown, never confirmed gaps',()=>{
  for(const setup of [s=>delete s.sources.Invoice,s=>s.sources.Invoice.status='bootstrap',s=>s.sources.Invoice.lastSuccessAt='2020-01-01T00:00:00Z',s=>s.truncated=true]){
    const s=snapshot();setup(s);const r=get(s,'Invoice.paid');assert.equal(r.status,'unknown');assert.equal(r.presentAtAll,null);assert.equal(r.evidence.complete,false);
  }
});
test('dependencies must also be complete for absence claims',()=>{
  const s=snapshot([row('Invoice',1,{Line:[{SalesItemLineDetail:{TaxCodeRef:{value:'2'}}}]})]);delete s.sources.TaxCode;
  assert.equal(get(s,'Invoice.zero-rated').status,'unknown');
  delete s.sources.Payment;assert.equal(get(s,'Invoice.credit-applied').status,'unknown');
});
test('zero-rated, exempt, out-of-scope and multi-tax use explicit codes, not a zero total',()=>{
  const s=snapshot([row('TaxCode',2,{Name:'Zero-rated'}),row('TaxCode',4,{Name:'Exempt'}),row('Invoice',1,{TxnTaxDetail:{TotalTax:0},Line:[{SalesItemLineDetail:{TaxCodeRef:{value:'2'}}},{SalesItemLineDetail:{TaxCodeRef:{value:'4'}}}]}),row('Invoice',2,{TxnTaxDetail:{TotalTax:0}})]);
  assert.equal(get(s,'Invoice.zero-rated').count,1);assert.equal(get(s,'Invoice.exempt').count,1);assert.equal(get(s,'Invoice.multi-tax').count,1);assert.equal(get(s,'Invoice.out-of-scope').count,0);
});
test('zero amounts, paid status and unsent email do not fabricate voids or drafts',()=>{
  const s=snapshot([row('Invoice',1,{TotalAmt:0,Balance:0,EmailStatus:'NotSet'}),row('Invoice',2,{TotalAmt:0,PrivateNote:'Voided original note'}),row('Invoice',3,{TotalAmt:100,EmailStatus:'EmailSent'})]);
  assert.equal(get(s,'Invoice.voided').count,1);assert.equal(get(s,'Invoice.sent').count,1);assert.equal(get(s,'Invoice.draft').status,'unknown');assert.equal(get(s,'Invoice.draft').count,0);
});
test('deletion evidence uses tombstones and is never a historical absence claim',()=>{
  const s=snapshot([row('Invoice',4,{status:'Deleted'},{deleted:true,changedAt:NOW})]);
  assert.equal(get(s,'Invoice.deleted').count,1);assert.equal(get(s,'Invoice.deleted').example.href,null);assert.equal(get(s,'Invoice.recorded').count,0);
  assert.equal(get(snapshot(),'Invoice.deleted').status,'unknown');
});
test('recurring names and monthly dates do not prove native recurrence',()=>{
  const s=snapshot([row('Invoice',1,{DocNumber:'monthly-recurring'})]);
  assert.equal(get(s,'Invoice.recurring').count,0);assert.equal(get(s,'Invoice.recurring').status,'unknown');
});
test('credit applications join the stored settlement graph and ignore voided payments',()=>{
  const s=snapshot([row('Invoice',536,{TotalAmt:4321.34,Balance:3321.34}),row('Payment',11132,{TotalAmt:0,Line:[{LinkedTxn:[{TxnType:'Invoice',TxnId:'536'}]},{LinkedTxn:[{TxnType:'CreditMemo',TxnId:'434'}]}]})]);
  assert.equal(get(s,'Invoice.credit-applied').example.id,'536');assert.equal(get(s,'Payment.zero-cash-credit').example.id,'11132');
  s.records.at(-1).record.PrivateNote='Voided';assert.equal(get(s,'Invoice.credit-applied').count,0);
});
test('PO receipt quantities use Bill line links, not closed status or mere PO existence',()=>{
  const s=snapshot([row('PurchaseOrder',1,{POStatus:'Open',Line:[{ItemBasedExpenseLineDetail:{Qty:10}}]}),row('Bill',2,{Line:[{ItemBasedExpenseLineDetail:{Qty:4},LinkedTxn:[{TxnType:'PurchaseOrder',TxnId:'1',TxnLineId:'1'}]}]})]);
  assert.equal(get(s,'PurchaseOrder.partially-received').count,1);assert.equal(get(s,'PurchaseOrder.fully-received').count,0);
});
test('owner setting and missing tool requirements remain distinct',()=>{
  const s=snapshot();assert.equal(get(s,'Bill.foreign-currency').reachability,'needs-owner-setting');
  s.records[0].record.CurrencyPrefs.MultiCurrencyEnabled=true;assert.equal(get(s,'Bill.foreign-currency').reachability,'needs-tool');
  assert.equal(get(s,'Invoice.recorded').reachability,'reachable-now');
});
test('weekly requires actual activity for every active class/location and deduplicates line uses',()=>{
  const s=snapshot([row('Class',5,{Name:'Unused',Active:true}),row('Class',6,{Name:'Used',Active:true}),row('Class',7,{Name:'Inactive',Active:false}),row('Department',2,{Active:true}),row('Invoice',1,{Line:[{SalesItemLineDetail:{ClassRef:{value:'6'}}},{SalesItemLineDetail:{ClassRef:{value:'6'}}}],DepartmentRef:{value:'2'}})]);
  const rows=coverage.weekly(s,{now:NOW}).rows.filter(r=>r.kind==='dimension');assert.equal(rows.length,3);
  assert.equal(rows.find(r=>r.key==='weekly.Class.5').status,'missing');assert.equal(rows.find(r=>r.key==='weekly.Class.6').count,1);assert.equal(rows.find(r=>r.key==='weekly.Department.2').count,1);
});
test('setup weekly evidence uses creation time and never re-observation',()=>{
  const s=snapshot([row('Customer',2,{TxnDate:undefined,Active:true,MetaData:{CreateTime:'2022-01-01T00:00:00Z'}},{lastObservedAt:NOW})]);
  const r=get(s,'Customer.active');assert.equal(r.count,1);assert.equal(r.recentCount,0);assert.equal(r.status,'present');
});
function fakeModels(s, seen=[]) {
  return {Records:{find(filter){seen.push(filter);return {select(){return this},sort(){return this},limit(n){this.n=n;return this},maxTimeMS(){return this},lean:async()=>s.records};}},
    Agents:{findOne(filter){seen.push(filter);return {select(){return this},maxTimeMS(){return this},lean:async()=>({sync:{sources:s.sources}})};}}};
}
test('mirror entry point preserves legacy areas/summary and isolates environment/connection scope',async()=>{
  const s=snapshot([row('Invoice',12,{TotalAmt:100,Balance:100})]),seen=[],models=fakeModels(s,seen);
  const r=await coverage.getMirrorCoverage(scope,{...models,now:NOW,refresh:true});
  assert.ok(r.areas.length);assert.ok(r.summary.areas);assert.ok(r.situations.rows.length);assert.ok(r.weekly.rows.length);assert.equal(r.evidence.qboRequests,0);assert.equal(r.evidence.recordsScanned,s.records.length);
  assert.deepEqual(seen,[scope,scope]);assert.equal(coverage.getCached(scope.realmId,{scope}),r);
  assert.equal(coverage.getCached(scope.realmId,{scope:{...scope,environment:'sandbox'}}),null);
  assert.equal(coverage.getCached(scope.realmId,{scope:{...scope,connectionId:'6a18e43d0b392890a1303e04'}}),null);
  await assert.rejects(coverage.getMirrorCoverage({realmId:scope.realmId}),/concrete company scope/);
});
test('Coverage route is authenticated and imports no QBO client or token-refresh path',async()=>{
  const routeFile=process.env.QBO_COVERAGE_ROUTE || require.resolve('../src/routes/coverage');
  let handler,authSeen=false,queried,result;
  const router={get(route,auth,fn){assert.equal(route,'/');authSeen=auth===authenticate;handler=fn;}},authenticate=()=>{};
  vm.runInNewContext(fs.readFileSync(routeFile,'utf8'),{module:{exports:{}},console,require(name){
    if(name==='express')return {Router:()=>router};
    if(name==='../models/Connection')return {findOne(filter){queried=filter;return {select(){return this},sort:async()=>({_id:scope.connectionId,realmId:scope.realmId})};}};
    if(name==='../middleware/auth')return {authenticate};
    if(name==='../config')return {qbo:{environment:'production'}};
    if(name==='../modules/coverage')return {getMirrorCoverage:async(s)=>{assert.equal(s.connectionId,scope.connectionId);return {situations:{}};}};
    throw Error('Unexpected route import: '+name);
  }});
  await handler({user:{id:'owner'},query:{}},{json:r=>{result=r;}});assert.equal(authSeen,true);assert.equal(queried.userId,'owner');assert.ok(result.data.situations);
});
test('real stored mirror replays offline through the same route scorer and pure exports',{skip:!process.env.QBO_COVERAGE_REPLAY},async()=>{
  const saved=JSON.parse(fs.readFileSync(process.env.QBO_COVERAGE_REPLAY,'utf8')),now=new Date(saved.capturedAt);
  const r=await coverage.getMirrorCoverage(saved.scope,{...fakeModels(saved),now,refresh:true});
  assert.deepEqual(r.situations,coverage.situations(saved,{now}));
  assert.deepEqual(r.weekly,coverage.weekly(saved,{now}));
  assert.equal(r.evidence.qboRequests,0);assert.equal(r.evidence.recordsScanned,saved.records.length);
  assert.ok(r.situations.rows.find(s=>s.key==='Invoice.credit-applied' && s.count>0));
  assert.equal(r.situations.rows.find(s=>s.key==='Preferences.multicurrency').presentAtAll,true);
});

test('bootstrap phase cannot certify completeness even with a retained current status',()=>{
  const s=snapshot();s.sources.Invoice.phase='bootstrap';s.sources.Invoice.status='current';
  assert.equal(get(s,'Invoice.paid').status,'unknown');
});
test('future settlements, conversions and receipts cannot prove current relationships',()=>{
  const s=snapshot([
    row('Invoice',1,{TotalAmt:10,Balance:10}),row('Estimate',2,{TxnStatus:'Pending'}),row('PurchaseOrder',3,{Line:[{ItemBasedExpenseLineDetail:{Qty:10}}]}),
    row('Payment',4,{TxnDate:'2026-11-01',TotalAmt:0,Line:[{LinkedTxn:[{TxnType:'Invoice',TxnId:'1'},{TxnType:'CreditMemo',TxnId:'5'}]}]}),
    row('Invoice',6,{TxnDate:'2026-11-01',LinkedTxn:[{TxnType:'Estimate',TxnId:'2'}]}),
    row('Bill',7,{TxnDate:'2026-11-01',Line:[{ItemBasedExpenseLineDetail:{Qty:5},LinkedTxn:[{TxnType:'PurchaseOrder',TxnId:'3'}]}]})
  ]);
  assert.equal(get(s,'Invoice.credit-applied').count,0);assert.equal(get(s,'Estimate.converted').count,0);assert.equal(get(s,'PurchaseOrder.partially-received').count,0);
});
test('missing activity sources keep dimension absence unknown',()=>{
  const s=snapshot([row('Class',5,{Active:true})]);delete s.sources.Invoice;
  assert.equal(coverage.weekly(s,{now:NOW}).rows.find(r=>r.key==='weekly.Class.5').status,'unknown');
});
test('fixed inventory sale/receipt/order workflows are available with stated guard limits',()=>{
  for(const e of ['Invoice','Bill','PurchaseOrder']) assert.equal(get(snapshot(),e+'.inventory-line').reachability,'reachable-now');
});
test('scoped mirror cache expires before stale classifications can be reused',async()=>{
  const r=await coverage.getMirrorCoverage(scope,{...fakeModels(snapshot()),now:NOW,refresh:true});
  const entry=[...coverage._internal.cache.values()].find(e=>e.result===r);entry.at=Date.now()-61000;
  assert.equal(coverage.getCached(scope.realmId,{scope}),null);
});

test('swept tombstones and undated matches cannot certify weekly absence',()=>{
  const s=snapshot([row('Invoice',4,{TxnDate:'2024-01-01'},{deleted:true,changedAt:NOW}),row('Payment',5,{TxnDate:undefined})]);
  assert.equal(get(s,'Invoice.deleted').presentAtAll,true);
  const w=coverage.weekly(s,{now:NOW});
  assert.equal(w.rows.find(r=>r.key==='Invoice.deleted').status,'unknown');
  assert.equal(w.rows.find(r=>r.key==='Payment.recorded').status,'unknown');
});
test('native dated deletion event may establish this week, independent of old changedAt',()=>{
  const s=snapshot([row('Invoice',4,{TxnDate:undefined,status:'Deleted',MetaData:{LastUpdatedTime:NOW.toISOString()}},{deleted:true,changedAt:'2022-01-01T00:00:00Z'})]);
  const w=coverage.weekly(s,{now:NOW}).rows.find(r=>r.key==='Invoice.deleted');
  assert.equal(w.status,'present');assert.equal(w.recentCount,1);
});
test('unsupported discount and alternate purchase/quote taxes request tools',()=>{
  for(const key of ['Invoice.discounted','Bill.multi-tax','Purchase.zero-rated','Estimate.exempt','CreditMemo.out-of-scope']) assert.equal(get(snapshot(),key).reachability,'needs-tool',key);
  assert.equal(get(snapshot(),'Invoice.zero-rated').reachability,'reachable-now');
});
