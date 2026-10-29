'use strict';
const {hash,canonical,shift} = require('./business-calendar');
const {scoped} = require('./qbo-write-contract');
const {validateStockState,summarizeStockState,calculateStockCost,emptyStockState} = require('./business-stock-cost');
const {validateStockRoot,KEYS} = require('./business-stock-root');
const {validateStockSource,stockBillIds} = require('./business-stock-source');
const {balances,accountSelection,loadMovementBasis} = require('./business-financial-movements');
const {unpackReport} = require('./business-report-source');
const {validateCompilation} = require('./business-readback');
const {taxExpectation} = require('./business-verification-runtime');
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/;
function fail(message) { throw Object.assign(Error(message),{status:409,code:'BUSINESS_STOCK_COST_UNVERIFIED'}); }
const equal = (a,b) => canonical(a) === canonical(b);
const read = (Model,filter,session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
const fiscalYear = (day,month) => Number(day.slice(0,4)) - (Number(day.slice(5,7)) < month ? 1 : 0);
function money(value) { if (typeof value !== 'number' || !Number.isFinite(value)) fail('Original stock cost needs an exact monetary value.'); const cents = Math.round(value * 100); if (!Number.isSafeInteger(cents) || cents < 0 || Math.abs(value*100-cents) > Number.EPSILON*Math.max(1,Math.abs(value*100))*4) fail('Original stock cost is not exact cents.'); return cents; }
function sourceFor(scope,run,step,lineIndex) {return {operationId:String(run._id),scopeHash:hash(scope),logicalKey:step.logicalKey,qboId:step.qboId,lineIndex,compilationHash:step.compilation.compilationHash,requestHash:step.dispatch.requestHash,receiptHash:step.receipt.evidenceHash,receiptSource:step.receipt.source};}
async function acceptedStockStep(models,scope,run,intent,step,session,cache) {
  if (!intent || !step || intent.kind !== 'create' || intent.step.entity !== step.entity || intent.logicalKey !== step.logicalKey || String(step.operationId) !== String(run._id) || step.planHash !== run.planHash || !['saved','verified'].includes(step.state) || step.compilation?.intentHash !== hash(intent.step) || step.dispatch?.compilationHash !== step.compilation?.compilationHash || step.dispatch?.requestHash !== step.compilation?.request?.requestHash || step.receipt?.qboId !== step.qboId || step.receipt?.version !== 1 || step.receipt?.dispatchKey !== step.dispatch?.key || step.receipt?.requestHash !== step.dispatch?.requestHash || step.fingerprint !== hash(intent.step) || step.compilation?.logicalKey !== step.logicalKey || step.compilation?.entity !== step.entity || step.compilation?.evidenceHash !== step.dispatch?.evidenceHash) fail('The exact original accepted stock intent is unavailable.');
  const descriptor = require('./business-operation-plan-store').validateOperationEntry(intent,scope,run.fromDate,run.throughDate);
  const plan = await read(models.Plans,{_id:run.planId,...scope,operationId:String(run._id),planHash:run.planHash},session);
  if (!plan || hash(plan.manifest) !== run.planHash || !equal(plan.manifest.records.find(row => row.logicalKey === step.logicalKey),descriptor)) fail('The stock source lost its immutable approved plan.');
  require('./business-period-store').assertRun(run,scope); require('./business-period-store').assertRunApproval(run);
  const policy = await require('./business-policy-amendment').effectiveBusinessPolicy(models,scope,{...run,policyAmendmentHash:step.dispatch.policyAmendmentHash},intent,session,cache);
  if (hash(policy) !== step.dispatch.policyHash || policy.stepHash !== hash(intent.step)) fail('The original stock tax policy changed.');
  if (step.receipt?.source === 'owner-attributed-readback') await require('./business-owner-attribution').assertOwnerAttribution(models,scope,step,session);
  else {
    const receipt = await read(models.Receipts,{_id:hash({scope,dispatchKey:step.dispatch.key}),...scope},session);
    if (!receipt) fail('The original stock transport receipt is unavailable.');
    const {businessTransportEvidence,assertBusinessTransportAudits} = require('./business-dispatch-receipt');
    const evidence = businessTransportEvidence({...scope,operationId:String(run._id),logicalKey:step.logicalKey,entity:step.entity,dispatch:step.dispatch},receipt);
    if (!evidence || evidence.result.receipt.qboId !== step.qboId || evidence.result.receipt.evidenceHash !== step.receipt.evidenceHash || step.receipt.source !== 'request-correlated-readback') fail('The saved stock source does not match its original accepted transport.');
    const audits = []; for (const expected of evidence.audits) audits.push(await read(models.Audits,{_id:expected.id,realmId:scope.realmId},session));
    assertBusinessTransportAudits(receipt,evidence,audits);
  }
  return policy;
}
function stockRows(scope,state,run,intent,step,policy) {
  const request = validateCompilation(step.compilation), payload = JSON.parse(request.body), rows = [], original = intent.step;
  if (!equal(request.scope,scope) || payload.TxnDate !== original.txnDate || payload.CurrencyRef?.value !== 'CAD' || payload.GlobalTaxCalculation !== 'TaxExcluded' || !Array.isArray(payload.Line) || payload.Line.length !== original.details.lines.length) fail('Original stock dates, currency or line intent changed.');
  for (const [lineIndex,line] of payload.Line.entries()) {
    const detail = line?.[line.DetailType], item = state.items.find(item => item.itemId === detail?.ItemRef?.value);
    if (!item) { if (line.DetailType === 'ItemBasedExpenseLineDetail' || step.entity === 'SalesReceipt') fail('Stock activity names an item outside its carried identity set.'); continue; }
    const wanted = original.details.lines[lineIndex], binding = original.references.filter(ref => ref.entity === 'Item' && ref.key === item.itemKey);
    if (!['Bill','SalesReceipt'].includes(step.entity) || line.DetailType !== (step.entity === 'Bill'?'ItemBasedExpenseLineDetail':'SalesItemLineDetail') || binding.length !== 1 || binding[0].id !== item.itemId || wanted.itemKey !== item.itemKey || wanted.quantity !== detail.Qty || !Number.isSafeInteger(detail.Qty) || detail.Qty <= 0 || wanted.unitPriceCents !== money(detail.UnitPrice) || wanted.amountCents !== money(line.Amount) || wanted.amountCents !== detail.Qty*money(detail.UnitPrice) || wanted.accountMapping !== (step.entity === 'Bill'?'inventoryAsset':'supplyIncome')) fail('The stock line differs from its original whole quantity, physical item or exact cost.');
    const taxKey = step.entity === 'Bill'?'purchaseTax':'salesTax', tax = original.references.filter(ref => ref.entity === 'TaxCode' && ref.key === taxKey);
    if (tax.length !== 1 || detail.TaxCodeRef?.value !== tax[0].id || policy.tax?.[taxKey] !== tax[0].id) fail('The original stock tax mapping changed.');
    for (const [key,id] of [['inventoryAsset',item.assetAccountId],['costOfGoods',item.costAccountId]]) { const selected = original.references.find(ref => ref.entity === 'Account' && ref.key === key); if (selected && selected.id !== id) fail('The original stock account differs from its published role.'); }
    rows.push({entity:step.entity,txnDate:payload.TxnDate,itemId:item.itemId,quantity:detail.Qty,source:sourceFor(scope,run,step,lineIndex),...(step.entity === 'Bill'?{unitCostCents:money(detail.UnitPrice)}:{})});
  }
  return rows;
}
async function loadStockBasis(models,scope,run,manifest,stepRows,session) {
  const state = manifest.stockCostExpectation.opening, rows = [], cache = new Map();
  for (const descriptor of manifest.records.filter(row => row.kind === 'create' && ['Bill','SalesReceipt','Invoice','CreditMemo'].includes(row.entity))) {
    const step = stepRows.find(row => row.logicalKey === descriptor.logicalKey), intent = await read(models.Intents,{...scope,planId:run.planId,planHash:run.planHash,logicalKey:descriptor.logicalKey},session);
    if (!intent || !step) fail('The complete original stock activity set is required.');
    if (!['Bill','SalesReceipt'].includes(step.entity)) { if (intent.step.references.some(ref => ref.entity === 'Item' && state.items.some(item => item.itemId === ref.id))) fail('Unsupported stock invoice or credit activity cannot be treated as a FIFO sale.'); continue; }
    if (step.entity === 'Bill' && intent.step.details.lines.every(line => line.accountMapping === 'operatingExpense')) continue;
    const policy = await acceptedStockStep(models,scope,run,intent,step,session,cache); rows.push(...stockRows(scope,state,run,intent,step,policy));
  }
  require('./business-stock-cost').validateStockRows(rows,state,manifest.stockCostExpectation.period);
  if (Buffer.byteLength(canonical(rows)) > 500000) fail('Original stock lines exceed their evidence budget.');
  return rows.sort((a,b) => a.source.logicalKey.localeCompare(b.source.logicalKey) || a.source.lineIndex-b.source.lineIndex);
}
async function loadPurchaseOrigins(models,state,session) {
  validateStockState(state); const result = [], cache = new Map();
  for (const qboId of stockBillIds(state)) {
    const lots = state.items.flatMap(item => item.lots.filter(lot => lot.source.qboId === qboId)), source = lots[0].source;
    if (source.receiptSource === 'population-readback') { result.push(await require('./business-adopted-stock').adoptedPurchaseOrigin({Records:models.PopulationRecords || require('../models/BusinessPopulationRecord')},state.scope,state,qboId,lots,{taxExpectation,session})); continue; }
    const run = await read(models.Runs,{_id:source.operationId,...state.scope},session), step = await read(models.Steps,{...state.scope,logicalKey:source.logicalKey},session);
    if (!run || !step || step.entity !== 'Bill' || step.qboId !== qboId || run.status !== 'verified' || !run.verification?.evidenceHash) fail('A carried purchase must belong to a fully committed original business period.');
    const intent = await read(models.Intents,{...state.scope,planId:run.planId,planHash:run.planHash,logicalKey:source.logicalKey},session), policy = await acceptedStockStep(models,state.scope,run,intent,step,session,cache);
    const rows = stockRows(state.scope,state,run,intent,step,policy);
    for (const lot of lots) { const row = rows.find(row => row.source.lineIndex === lot.source.lineIndex && row.itemId === state.items.find(item => item.lots.includes(lot)).itemId); if (!row || !equal(row.source,lot.source) || row.txnDate !== lot.txnDate || row.quantity !== lot.originalQuantity || row.unitCostCents !== lot.unitCostCents) fail('A remaining purchase layer differs from the original accepted line.'); }
    const tax = taxExpectation(policy,step.compilation); if (!tax) fail('The original purchase tax expectation is unavailable.');
    result.push({qboId,source:sourceFor(state.scope,run,step,0),payload:JSON.parse(step.compilation.request.body),tax});
  }
  if (Buffer.byteLength(canonical(result)) > 500000) fail('Original purchase content exceeds its evidence budget.');
  return result;
}
function matchesPayload(wanted,actual) {
  if (wanted === null || typeof wanted !== 'object') return typeof wanted === 'number' ? typeof actual === 'number' && wanted === actual : wanted === actual;
  if (Array.isArray(wanted)) return Array.isArray(actual) && wanted.length === actual.length && wanted.every((value,index) => matchesPayload(value,actual[index]));
  return actual && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(wanted).every(([key,value]) => key === 'LinkedTxn' ? true : matchesPayload(value,actual[key]));
}
function assertPurchaseContent(origins,source) {
  for (const origin of origins) {
    const actual = source.bills.find(row => row.Id === origin.qboId), wanted = origin.payload;
    if (!actual || !matchesPayload(Object.fromEntries(Object.entries(wanted).filter(([key]) => ['TxnDate','CurrencyRef','VendorRef','APAccountRef','GlobalTaxCalculation','Line'].includes(key))),actual) || !Array.isArray(actual.Line) || actual.Line.length !== wanted.Line.length || ['ClassRef','DepartmentRef','ProjectRef'].some(key => !wanted[key] && actual[key]?.value)) fail('A remaining purchase changed its original accounting date, quantities, prices, accounts or tax.');
    for (const [index,line] of actual.Line.entries()) { const expected = wanted.Line[index], detail = line[line.DetailType], intended = expected[expected.DetailType]; if (['ClassRef','ProjectRef','CustomerRef','AccountRef'].some(key => !intended?.[key] && detail?.[key]?.value)) fail('A remaining purchase gained an unsupported cost relationship.'); }
    const tax = actual.TxnTaxDetail, expected = origin.tax, lines = tax?.TaxLine || [], used = new Set();
    if (money(tax?.TotalTax) !== expected.totalTaxCents || lines.length !== expected.lines.length || money(actual.TotalAmt) !== wanted.Line.reduce((sum,line) => sum+money(line.Amount),0)+expected.totalTaxCents) fail('A remaining purchase changed its original tax or total.');
    for (const row of expected.lines) { const index = lines.findIndex((line,index) => !used.has(index) && line.DetailType === 'TaxLineDetail' && money(line.Amount) === row.amountCents && line.TaxLineDetail?.TaxRateRef?.value === row.rateId && line.TaxLineDetail?.TaxPercent === row.percent && line.TaxLineDetail?.PercentBased === true && money(line.TaxLineDetail?.NetAmountTaxable) === row.taxableCents); if (index < 0) fail('A remaining purchase changed its original tax rate.'); used.add(index); }
  }
}
function reportBalances(expectation,observation) {
  const {sourceHash,evaluation,...source} = observation || {};
  if (![2,3].includes(source.version) || hash(source) !== sourceHash || !equal(source.scope,expectation.scope) || !equal(source.period,expectation.period) || !equal(accountSelection(expectation.scope,Object.fromEntries(expectation.accounts.map(row => [row.key,row.id])),source.accounts,KEYS),expectation.accounts)) fail('The exact selected stock accounts or report source changed.');
  return balances(unpackReport('TrialBalance',source.reports.TrialBalance,source.version),source.accounts,expectation.accounts,expectation.period);
}
function validateStockExpectation(value,scope,period,entries) {
  const {expectationHash,...body} = value || {};
  if (body.version !== 1 || !equal(body.scope,scoped(scope)) || !equal(body.period,period) || hash(body) !== expectationHash || ![body.rootHash,body.policyHash].every(value => HASH.test(value || '')) || !Number.isInteger(body.fiscalYearStartMonth) || body.fiscalYearStartMonth < 1 || body.fiscalYearStartMonth > 12 || !Array.isArray(body.accounts) || !equal(body.accounts.map(row => row.key),KEYS) || body.accounts[0].id === body.accounts[1].id || !Array.isArray(body.purchaseOrigins) || !Number.isSafeInteger(body.openingCostCents)) fail('The original stock-cost expectation changed.');
  validateStockState(body.opening,scope); require('./business-stock-cost').validateStockRows([],body.opening,period);
  if (body.opening.rootHash !== body.rootHash || body.opening.items.some(item => item.assetAccountId !== body.accounts[0].id || item.costAccountId !== body.accounts[1].id) || body.carry?.stateHash !== body.opening.stateHash || body.carry.rootHash !== body.rootHash || body.carry.throughDate !== body.opening.throughDate || !['zero-root','committed-period','adopted-history'].includes(body.carry.kind) || !Number.isSafeInteger(body.carry.costCents) || body.openingCostCents !== (fiscalYear(body.carry.throughDate,body.fiscalYearStartMonth) === fiscalYear(period.throughDate,body.fiscalYearStartMonth)?body.carry.costCents:0)) fail('The stock opening differs from its exact carried period or fiscal calendar.');
  if (body.carry.kind === 'adopted-history' && (!ID.test(body.carry.jobId || '') || !HASH.test(body.carry.replayHash || ''))) fail('The carried stock state needs its adopted-history replay receipt.');
  if (body.carry.kind === 'committed-period' && (!ID.test(body.carry.operationId || '') || ![body.carry.planHash,body.carry.evidenceHash].every(value => HASH.test(value || '')) || !Number.isSafeInteger(body.carry.evidenceRevision) || body.carry.evidenceRevision < 1 || !body.carry.completionAuditId)) fail('The carried stock state needs its original committed evidence receipt.');
  validateStockSource(body.startingStockSource,scope,body.opening.items,stockBillIds(body.opening));
  if (body.startingStockSource.fiscalYearStartMonth !== body.fiscalYearStartMonth || !equal(body.purchaseOrigins.map(row => row.qboId),stockBillIds(body.opening))) fail('The original purchase-source set or company fiscal calendar changed.');
  const stockStart = Date.parse(body.startingStockSource.startedAt), stockEnd = Date.parse(body.startingStockSource.observedAt), reportStart = Date.parse(body.startingReports?.startedAt), reportEnd = Date.parse(body.startingReports?.observedAt);
  if (![stockStart,stockEnd,reportStart,reportEnd].every(Number.isFinite) || stockEnd > reportStart || reportStart > reportEnd || reportEnd-stockStart > 300000) fail('Starting reports must follow the same bounded stock observation.');
  assertPurchaseContent(body.purchaseOrigins,body.startingStockSource);
  if (!equal(reportBalances(body,body.startingReports),{inventoryAsset:summarizeStockState(body.opening).valueCents,costOfGoods:body.openingCostCents})) fail('Starting stock balances differ from carried purchase costs.');
  assertQuantities(body.opening,body.startingStockSource);
  for (const entry of entries || []) for (const ref of entry.step.references.filter(ref => ref.entity === 'Account' && KEYS.includes(ref.key))) { const selected = body.accounts.find(row => row.key === ref.key); if (ref.id !== selected.id || ref.definition?.hash !== selected.definitionHash) fail('A stock activity changed its exact approved stock account.'); }
  if (entries) {
    const planned = [];
    for (const [ordinal,entry] of entries.entries()) if (entry.kind === 'create' && ['Bill','SalesReceipt'].includes(entry.step.entity)) for (const [lineIndex,line] of entry.step.details.lines.entries()) {
      const item = body.opening.items.find(item => item.itemKey === line.itemKey);
      if (!item) continue;
      planned.push({entity:entry.step.entity,txnDate:entry.step.txnDate,itemId:item.itemId,quantity:line.quantity,...(entry.step.entity === 'Bill'?{unitCostCents:line.unitPriceCents}:{}),source:{operationId:'0'.repeat(24),scopeHash:hash(scope),logicalKey:entry.step.logicalKey,qboId:'9'+String(ordinal+1).padStart(29,'0'),lineIndex,compilationHash:hash(entry.step),requestHash:hash({step:entry.step,kind:'capacity'}),receiptHash:hash({ordinal,lineIndex,kind:'capacity'}),receiptSource:'request-correlated-readback'}});
    }
    calculateStockCost(body.opening,planned,period);
  }
  if (Buffer.byteLength(canonical(value)) > 8000000) fail('The stock expectation exceeds its storage budget.');
  return value;
}
function assertQuantities(state,source) {
  for (const expected of summarizeStockState(state).items) { const item = state.items.find(row => row.itemId === expected.itemId), actual = source.items.find(row => row.Id === expected.itemId); if (!actual || actual.Type !== 'Inventory' || actual.Active !== true || actual.TrackQtyOnHand !== true || actual.QtyOnHand !== expected.quantity || actual.AssetAccountRef?.value !== item.assetAccountId || actual.ExpenseAccountRef?.value !== item.costAccountId || (typeof actual.InvStartDate !== 'string' || actual.InvStartDate > shift(state.throughDate,1))) fail('Current stock quantity or account routing differs from its carried purchase layers.'); }
}
function createStockExpectation({scope,period,root,opening,carry,stockSource,reports,purchaseOrigins}) {
  validateStockRoot(root,scope);
  const openingCostCents = fiscalYear(carry.throughDate,root.fiscalYearStartMonth) === fiscalYear(period.throughDate,root.fiscalYearStartMonth)?carry.costCents:0;
  for (const item of stockSource.items) if (item.InvStartDate !== root.zeroSource.items.find(row => row.Id === item.Id)?.InvStartDate) fail('A stock Item changed its original accepted starting date.');
  const retainedReports = Object.fromEntries(['version','scope','period','startedAt','observedAt','accounts'].map(key => [key,reports[key]]));
  retainedReports.reports = {TrialBalance:reports.reports.TrialBalance}; retainedReports.observationHash = reports.sourceHash;
  const startingReports = {...retainedReports,sourceHash:hash(retainedReports)};
  const body = {version:1,scope,period,rootHash:root.rootHash,policyHash:root.policyHash,fiscalYearStartMonth:root.fiscalYearStartMonth,accounts:root.accounts,opening,carry,openingCostCents,purchaseOrigins,startingStockSource:stockSource,startingReports};
  return validateStockExpectation({...body,expectationHash:hash(body)},scope,period);
}
function compareStockCosts(expectation,basis,observation,stockSource,{openingOnly=false} = {}) {
  validateStockExpectation(expectation,expectation.scope,expectation.period);
  const calculation = calculateStockCost(expectation.opening,openingOnly?[]:basis,expectation.period), state = openingOnly?expectation.opening:calculation.closing;
  let actual = null, reason = null, quantities = [];
  try {
    validateStockSource(stockSource,expectation.scope,state.items,stockBillIds(expectation.opening));
    if (stockSource.fiscalYearStartMonth !== expectation.fiscalYearStartMonth) fail('The observed company fiscal calendar changed.');
    assertPurchaseContent(expectation.purchaseOrigins,stockSource); actual = reportBalances(expectation,observation);
    quantities = summarizeStockState(state).items.map(expected => { const item = stockSource.items.find(row => row.Id === expected.itemId), identity = state.items.find(row => row.itemId === expected.itemId), available = item?.Type === 'Inventory' && item.Active === true && item.TrackQtyOnHand === true && Number.isSafeInteger(item.QtyOnHand) && item.QtyOnHand >= 0 && item.AssetAccountRef?.value === identity.assetAccountId && item.ExpenseAccountRef?.value === identity.costAccountId && typeof item.InvStartDate === 'string' && item.InvStartDate === expectation.startingStockSource.items.find(row => row.Id === item.Id)?.InvStartDate; return {...expected,actualQuantity:available?item.QtyOnHand:null,status:!available?'unavailable':item.QtyOnHand === expected.quantity?'passed':'failed'}; });
  } catch (error) { if (!['BUSINESS_STOCK_COST_UNVERIFIED','BUSINESS_FINANCIAL_MOVEMENTS_UNVERIFIED'].includes(error.code)) throw error; reason = error.message; }
  const closingValue = summarizeStockState(state).valueCents, expectedCost = expectation.openingCostCents + (openingOnly?0:calculation.costOfSalesCents);
  const checks = [['inventoryAsset',closingValue],['costOfGoods',expectedCost]].map(([key,expectedCents]) => { const actualCents = actual?.[key] ?? null; return {key,accountId:expectation.accounts.find(row => row.key === key).id,expectedCents,actualCents,differenceCents:actualCents === null?null:actualCents-expectedCents,status:actualCents === null?'unavailable':actualCents === expectedCents?'passed':'failed'}; });
  const status = reason || quantities.some(row => row.status === 'unavailable')?'unavailable':[...checks,...quantities].every(row => row.status === 'passed')?'passed':'failed';
  const attributed = new Set([...expectation.opening.items.flatMap(item => item.lots.map(lot => lot.source)), ...basis.map(row => row.source)].filter(source => source.receiptSource === 'owner-attributed-readback').map(source => source.logicalKey + ':' + source.lineIndex)).size;
  return {version:1,status,ownerAttributedSourceLines:attributed,method:'FIFO',policyTrust:'retained-method-and-tax-policy-evidence',policyHash:expectation.policyHash,rootHash:expectation.rootHash,openingHash:expectation.opening.stateHash,stockSourceHash:stockSource?.sourceHash || null,checks,quantities,...(!openingOnly?{calculation}:{}),...(reason?{reason}:{}),limitation:'Managed original purchase layers and the selected inventory-asset/COGS accounts only. Method and fully recoverable purchase tax rely on the retained policy evidence, which may explicitly be a documented inference and selected test-business treatment. This comparison does not establish that the company setting was directly observed. Unsupported adjustments, returns, independent QuickBooks per-item valuation, physical counts and bank reconciliation are not certified.'};
}
module.exports = {fiscalYear,loadStockBasis,loadPurchaseOrigins,validateStockExpectation,createStockExpectation,compareStockCosts,assertQuantities};
