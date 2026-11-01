'use strict';
// Native inventory reports are independent of the General Ledger being tested.
const { hash, canonical, date } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { canonicalReport } = require('./report-json');
const RETURNS = new Set(['CreditMemo','RefundReceipt','VendorCredit']);
const LABELS = { 'Credit Memo':'CreditMemo', 'Credit Note':'CreditMemo', 'Refund':'RefundReceipt', 'Refund Receipt':'RefundReceipt', 'Supplier Credit':'VendorCredit', 'Vendor Credit':'VendorCredit' };
function fail(message) { throw Object.assign(Error(message), { status:409, code:'BUSINESS_STOCK_COST_UNVERIFIED' }); }
function decimal(value, places = 6) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) fail('Native inventory report has an invalid number.');
  const number = Number(value), scale = 10 ** places;
  if (!Number.isFinite(number) || !Number.isSafeInteger(Math.round(number * scale)) || Math.abs(number * scale - Math.round(number * scale)) > 0.00001) fail('Native inventory report exceeds exact quantity or cent precision.');
  return places === 2 ? Math.round(number * 100) : number;
}
function table(report, name, day) {
  date(day);
  if (Buffer.byteLength(canonicalReport(report)) > 2000000 || report?.Header?.ReportName !== name || report.Header.EndPeriod !== day || report.Header.Currency !== 'CAD' || report.Header.ReportBasis !== 'Accrual' || name === 'InventoryValuationDetail' && report.Header.StartPeriod !== day || !Array.isArray(report.Columns?.Column) || !Array.isArray(report.Rows?.Row)) fail('The native inventory report is not the complete CAD accrual report for the requested day.');
  if ((report.Header.Option || []).some(o => /truncat|incomplete/i.test(o.Name) && o.Value !== 'false')) fail('Native inventory report is truncated.');
  const columns = report.Columns.Column;
  const column = aliases => {
    const hits = columns.flatMap((c,i) => [c.ColType, c.ColTitle, ...(c.MetaData || []).filter(m=>m.Name==='ColKey').map(m=>m.Value)].some(v => aliases.includes(String(v || '').toLowerCase().replace(/[^a-z0-9]/g,''))) ? [i] : []);
    if (hits.length !== 1) fail('Native inventory report has no unique ' + aliases[0] + ' column.'); return hits[0];
  };
  return { column, rows:report.Rows.Row };
}
function nativeReturnValuations(report, day, records, opening) {
  const t = table(report, 'InventoryValuationDetail', day), type=t.column(['txntype','transactiontype']), on=t.column(['txdate','date']), qty=t.column(['quantity','qty','qnt']), amount=t.column(['fifocost','amount','invvalue']);
  const found = new Map();
  const walk = (rows, itemId) => { for (const row of rows) {
    if (row.type === 'Section') { walk(row.Rows?.Row || [], row.Header?.ColData?.[0]?.id || itemId); continue; }
    if (row.type !== 'Data') continue;
    const cells=row.ColData, entity=LABELS[cells?.[type]?.value], id=cells?.[type]?.id;
    if (!entity) continue;
    if (!/^\d{1,30}$/.test(itemId || '') || !/^\d{1,30}$/.test(id || '') || cells[on]?.value !== day) fail('Native return valuation lacks exact item/transaction/date identity.');
    const key=entity+':'+id+':'+itemId, old=found.get(key) || {quantity:0,cents:0,unitCostCents:null};
    const rowQuantity=decimal(cells[qty]?.value), rowCents=decimal(cells[amount]?.value,2), unit=rowCents/rowQuantity;
    if((entity==='VendorCredit'?rowQuantity>=0:rowQuantity<=0) || !Number.isFinite(unit) || unit<0 || old.unitCostCents!==null && old.unitCostCents!==unit) fail('Native return contains mixed cost layers.');
    old.unitCostCents=unit;
    old.quantity=Math.round((old.quantity+decimal(cells[qty]?.value))*1000000)/1000000; old.cents+=decimal(cells[amount]?.value,2); found.set(key,old);
  } }; walk(t.rows,null);
  const proofs={};
  for (const {entity,record} of records.filter(r=>RETURNS.has(r.entity))) for (const [lineIndex,line] of (record.Line || []).entries()) {
    const detail=line[line.DetailType], itemId=detail?.ItemRef?.value;
    if (!opening.items.some(i=>i.itemId===itemId)) continue;
    const actual=found.get(entity+':'+record.Id+':'+itemId), sign=entity==='VendorCredit'?-1:1;
    if (!actual || actual.quantity !== sign*detail.Qty || sign*actual.cents < 0 || !Number.isSafeInteger(actual.cents)) fail('Native return quantity/cost cannot be attributed to its exact record and item.');
    const unitCostCents=sign*actual.cents/detail.Qty;
    proofs[hash({entity,record,lineIndex})]={recordHash:hash(record),evidenceHash:hash({day,entity,id:record.Id,itemId,lineIndex,actual}),unitCostCents};
  }
  return proofs;
}
function compareItemValuation(report, day, state) {
  const t=table(report,'InventoryValuationSummary',day), item=t.column(['itemname','productservice','item','name']), qty=t.column(['quantity','qty','qnt']), asset=t.column(['assetvalue','invvalue','asset']);
  const actual=new Map();
  const walk=rows=>{for(const row of rows){if(row.type==='Section'){walk(row.Rows?.Row||[]);continue;} if(row.type!=='Data')continue;
    const id=row.ColData?.[item]?.id; if(!/^\d{1,30}$/.test(id||'') || actual.has(id)) fail('Native item valuation lacks unique physical item identities.');
    actual.set(id,{quantity:decimal(row.ColData[qty]?.value),valueCents:decimal(row.ColData[asset]?.value,2)});
  }};walk(t.rows);
  const checks=require('./business-stock-cost').summarizeStockState(state).items.map(expected=>{const observed=actual.get(expected.itemId); return {...expected,actualQuantity:observed?.quantity??null,actualValueCents:observed?.valueCents??null,status:observed?.quantity===expected.quantity&&observed?.valueCents===expected.valueCents?'passed':'failed'};});
  if(checks.some(c=>c.status!=='passed')) fail('Per-item inventory quantity or asset value differs from native valuation.');
  return checks;
}
function returnRecordHash(record) {
  // Settlement balances, links, current bank destination and provider metadata
  // do not change returned stock cost. Keep every inventory-accounting field.
  const view=require('./general-write-postings').accountingView(record);
  const body=Object.fromEntries(['Id','TxnDate','CurrencyRef','GlobalTaxCalculation','Line','TxnTaxDetail','CustomerRef','VendorRef','ARAccountRef','APAccountRef'].filter(k=>view[k]!==undefined).map(k=>[k,view[k]]));
  if(body.Line) body.Line=body.Line.map(({LinkedTxn,...line})=>line);
  return hash(body);
}
function evidence(scope,day,records,report) { const body={version:1,scope:scoped(scope),day,records:records.filter(r=>RETURNS.has(r.entity)),reportJson:canonicalReport(report)}; if(Buffer.byteLength(canonical(body))>2500000)fail('Retained inventory valuation exceeds its evidence budget.');return {...body,evidenceHash:hash(body)}; }
async function retainedValuations(models,scope,day,records,opening,session) {
  const Model=models.GeneralDayCloses || require('../models/GeneralDayClose');
  const close=await Model.findOne({...scope,fromDate:day,throughDate:day,ok:true,'stock.returns.day':day}).sort({verifiedAt:-1}).session(session).maxTimeMS(3000).lean();
  const saved=close?.stock?.returns, {evidenceHash,...body}=saved||{};
  if (!saved || canonical(body.scope)!==canonical(scoped(scope)) || body.day!==day || body.version!==1 || hash(body)!==evidenceHash) fail('The saved return needs its retained native valuation close before further stock work.');
  // Reparse the original report against the exact saved response, never trust supplied costs.
  for(const row of records.filter(r=>RETURNS.has(r.entity))) if(!body.records.some(r=>r.entity===row.entity&&returnRecordHash(r.record)===returnRecordHash(row.record))) fail('Retained return valuation belongs to a different record version.');
  return nativeReturnValuations(JSON.parse(body.reportJson),day,records,opening);
}
// Scoped, bounded report reads. Transactional admission uses only a previously
// warmed exact-record cache; it never performs network work inside MongoDB.
function createValuationReader({access,now=()=>Date.now()}) {
  const cache=new Map();
  return async function read({scope,day,records,summary=false,session=null}) {
    scope=scoped(scope); const key=hash({scope,day,records,summary}), prior=cache.get(key);
    if(prior && now()>=prior.at && now()-prior.at<30000) return structuredClone(prior.value);
    if(session) fail('Native inventory valuation must be refreshed before transactional admission.');
    if(!access?.authorize || !access?.resolveClient) fail('Native inventory valuation access is unavailable.');
    const actor=await access.authorize(scope,'operations.verify'), client=await access.resolveClient(scope);
    const {QBOClient}=require('./qbo-client');
    const guard=async()=>{const a=await access.authorize(scope,'operations.verify');if(a.actorId!==actor.actorId||a.ownerId!==actor.ownerId||!(client instanceof QBOClient)||client.apiCall!==QBOClient.prototype.apiCall||client.realmId!==scope.realmId||String(client.connection?.realmId)!==scope.realmId||String(client.connection?._id)!==scope.connectionId||String(client.connection?.userId)!==actor.ownerId||client.connection?.status!=='active'||client.apiBase!=='https://'+(scope.environment==='production'?'quickbooks.api.intuit.com':'sandbox-quickbooks.api.intuit.com')+'/v3/company/'+scope.realmId)fail('Native valuation authority changed.');};
    date(day); const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),60000); timer.unref?.();
    try {const value={};for(const name of [ ...(records.some(r=>RETURNS.has(r.entity))?['InventoryValuationDetail']:[]), ...(summary?['InventoryValuationSummary']:[]) ]) {await guard();value[name]=await require('./qbo-request-meter').runWithCaller('business-stock-valuation',()=>client.apiCall('GET','reports/'+name+'?'+new URLSearchParams({start_date:day,end_date:day,accounting_method:'Accrual'}),undefined,0,0,{signal:controller.signal,beforeAttempt:guard}));await guard(); table(value[name],name,day);}cache.clear();cache.set(key,{at:now(),value});return structuredClone(value);}finally{clearTimeout(timer);controller.abort();}
  };
}
module.exports={nativeReturnValuations,compareItemValuation,evidence,retainedValuations,createValuationReader,returnRecordHash};
