'use strict';
const {hash,canonical,shift} = require('./business-calendar');
const {validateStockRoot,assertStockRootOrigins} = require('./business-stock-root');
const {emptyStockState,validateStockState} = require('./business-stock-cost');
const {validateStockExpectation,loadStockBasis,loadPurchaseOrigins,compareStockCosts} = require('./business-stock-evidence');
const {loadMovementBasis,compareFinancialMovements} = require('./business-financial-movements');
const {validatePeriodProof,assertRun} = require('./business-period-store');
const {evaluateReportSources} = require('./book-evidence');
const {reportComplete} = require('./business-financial-summary');
const {checkIncomeExpectation} = require('./business-income-evidence');
const {unpackReport} = require('./business-report-source');
function fail(message) { throw Object.assign(Error(message),{status:409,code:'BUSINESS_STOCK_COST_UNVERIFIED'}); }
const equal = (a,b) => canonical(a) === canonical(b);
const read = (Model,filter,session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
async function committedReceipt(models,scope,ownerId,operationId,session) {
  const run = await read(models.Runs,{_id:operationId,...scope,status:'verified'},session); assertRun(run,scope);
  const evidence = await read(models.Evidence,{...scope,operationId,planHash:run.planHash,evidenceRevision:run.evidenceRevision,evidenceHash:run.verificationCandidateHash},session);
  if (!run.verification?.completionAuditId || run.verification.evidenceHash !== evidence?.evidenceHash || run.verification.evidenceRevision !== evidence?.evidenceRevision || run.verification.throughDate !== undefined && run.verification.throughDate !== run.throughDate || !evidence || evidence.contractVersion !== 1 || hash(evidence.proof) !== evidence.evidenceHash || run.verification.recordSetHash !== hash(evidence.proof.records)) fail('A stock carry needs its original fully committed period evidence.');
  validatePeriodProof(run,evidence.proof,Date.parse(evidence.proof.observedAt));
  const audit = await read(models.Audits,{_id:run.verification.completionAuditId,userId:ownerId,realmId:scope.realmId,action:'Business operation evidence recorded',actionType:'manual',outcome:'success','inputParams.eventKey':'business-period:'+operationId+':committed'},session), params = audit?.inputParams;
  if (!audit || !equal({realmId:params.realmId,environment:params.environment,connectionId:params.connectionId},scope) || params.details?.operationId !== operationId || params.details?.evidenceHash !== evidence.evidenceHash || params.details?.throughDate !== run.throughDate) fail('The stock carry lost its original completion audit.');
  const eventKey = 'business-period-evidence:'+operationId+':'+evidence.evidenceRevision, actorId = String(evidence.actorId), details = {...scope,actorId,operationId,evidenceHash:evidence.evidenceHash,sourceHash:evidence.sources.sourceHash,evidenceRevision:evidence.evidenceRevision,recordCount:evidence.proof.records.length};
  const observed = await read(models.Audits,{_id:evidence.auditId,userId:ownerId,realmId:scope.realmId,action:'Business operation evidence recorded',actionType:'manual',outcome:'success'},session);
  if (String(evidence.auditId) !== hash({scope,actorId,ownerId,eventKey}).slice(0,24) || !observed || String(observed.actorUserId || observed.userId) !== actorId || !equal(observed.inputParams,{eventKey,...scope,details})) fail('The original stock observation audit is unavailable or changed.');
  return {run,evidence};
}
async function assertFrozenStockOpening(models,active,expectation,session) {
  const {scope} = expectation, root = validateStockRoot(active.value.stockRoot,scope,active.view);
  validateStockExpectation(expectation,scope,expectation.period);
  if (expectation.rootHash !== root.rootHash || expectation.policyHash !== root.policyHash || active.calendar.pendingCommit || expectation.opening.throughDate !== (active.calendar.verifiedThrough || shift(root.openingDate,-1))) fail('Stock work must follow its exact accepted business calendar.');
  if (active.calendar.verifiedThrough === null) {
    const opening = emptyStockState({scope,rootHash:root.rootHash,throughDate:shift(root.openingDate,-1),items:root.items});
    if (expectation.carry.kind !== 'zero-root' || !equal(expectation.opening,opening) || expectation.carry.costCents !== root.openingCostCents) fail('The initial stock state cannot replace its accepted zero root.');
    return;
  }
  const operationId = String(active.calendar.lastVerifiedOperationId || '');
  if (expectation.carry.kind !== 'committed-period' || expectation.carry.operationId !== operationId) fail('Use the immediately preceding committed stock state.');
  const {run,evidence} = await committedReceipt(models,scope,active.value.ownerId,operationId,session), result = evidence.proof.assertions.find(row => row.key === 'stock-costs')?.stockCosts;
  if (run.throughDate !== active.calendar.verifiedThrough || run.baselineHash !== active.value.baselineHash || result?.status !== 'passed' || result.rootHash !== root.rootHash || result.calculation?.closing?.stateHash !== expectation.opening.stateHash || !equal(result.calculation.closing,expectation.opening) || result.checks.find(row => row.key === 'costOfGoods')?.actualCents !== expectation.carry.costCents || run.planHash !== expectation.carry.planHash || evidence.evidenceHash !== expectation.carry.evidenceHash || evidence.evidenceRevision !== expectation.carry.evidenceRevision || String(run.verification.completionAuditId) !== expectation.carry.completionAuditId) fail('The opening stock state differs from its exact committed receipt.');
}
async function readCommittedStockOpening(models,active,session) {
  const scope = active.value.scope, root = validateStockRoot(active.value.stockRoot,scope,active.view);
  await assertStockRootOrigins(models,root,active.value.ownerId,session);
  if (active.calendar.pendingCommit) fail('Finish the pending calendar completion before carrying stock forward.');
  if (active.calendar.verifiedThrough === null) {
    const state = emptyStockState({scope,rootHash:root.rootHash,throughDate:shift(root.openingDate,-1),items:root.items});
    return {state,carry:{kind:'zero-root',rootHash:root.rootHash,throughDate:state.throughDate,stateHash:state.stateHash,costCents:root.openingCostCents}};
  }
  const operationId = String(active.calendar.lastVerifiedOperationId || ''), {run,evidence} = await committedReceipt(models,scope,active.value.ownerId,operationId,session);
  const plan = await read(models.Plans,{_id:run.planId,...scope,operationId,planHash:run.planHash},session), manifest = plan?.manifest;
  if (!manifest || hash(manifest) !== run.planHash || !manifest.stockCostExpectation || run.throughDate !== active.calendar.verifiedThrough || run.baselineHash !== root.baselineHash || !(active.lineage?.entries || [{authority:active.authority}]).some(entry => entry.authority.contentHash === run.authorityHash)) fail('The last committed stock period is outside this business lineage.');
  const expectation = validateStockExpectation(manifest.stockCostExpectation,scope,{fromDate:run.fromDate,throughDate:run.throughDate});
  if (expectation.rootHash !== root.rootHash || expectation.policyHash !== root.policyHash || !equal(expectation.accounts,root.accounts)) fail('The previous cost proof changed its published root or accounts.');
  const keys = manifest.records.filter(row => row.kind === 'create').map(row => row.logicalKey), stepRows = [];
  for (let offset=0;offset<keys.length;offset+=200) stepRows.push(...await models.Steps.find({...scope,logicalKey:{$in:keys.slice(offset,offset+200)}}).limit(201).session(session).maxTimeMS(3000).lean());
  if (stepRows.length !== keys.length || new Set(stepRows.map(row => row.logicalKey)).size !== keys.length || stepRows.some(row => !evidence.proof.records.some(original => original.logicalKey === row.logicalKey && original.entity === row.entity && original.qboId === row.qboId && original.fingerprint === row.fingerprint))) fail('The original completed stock record set changed.');
  const financialBasis = await loadMovementBasis(models,scope,run,manifest,stepRows,session), stockBasis = await loadStockBasis(models,scope,run,manifest,stepRows,session), purchases = await loadPurchaseOrigins(models,expectation.opening,session);
  if (!equal(financialBasis,evidence.proof.financialBasis) || !equal(stockBasis,evidence.proof.stockBasis) || !equal(purchases,expectation.purchaseOrigins)) fail('The previous stock proof differs from its original accepted sources.');
  const {sourceHash,...source} = evidence.sources || {}, evaluation = evaluateReportSources(source,{allowExplicitZero:true});
  if (hash(source) !== sourceHash || !equal(source.scope,scope) || !equal(source.period,expectation.period) || evaluation.status !== 'checks-passed' || !reportComplete(evaluation,source) || evidence.proof.assertions.some(row => row.sourceHash !== (row.evidenceType === 'record-readback'?hash(evidence.proof.records):sourceHash))) fail('The previous stock report sources are unavailable or changed.');
  const financial = compareFinancialMovements(manifest.financialExpectation,financialBasis,evidence.sources), income = checkIncomeExpectation(manifest.incomeExpectation,scope,source.period,unpackReport('ProfitAndLoss',source.reports.ProfitAndLoss,source.version),source.version), stock = compareStockCosts(expectation,stockBasis,evidence.sources,evidence.proof.stockSource);
  if (financial.status !== 'passed' || !equal(financial,evidence.proof.assertions.find(row => row.key === 'financial-movements')?.financialMovements) || !income.passed || !equal(income,evidence.proof.assertions.find(row => row.key === 'profit-and-loss')?.income) || stock.status !== 'passed' || !equal(stock,evidence.proof.assertions.find(row => row.key === 'stock-costs')?.stockCosts)) fail('The last committed stock calculation does not follow its immutable original sources.');
  validateStockState(stock.calculation.closing,scope);
  const state = stock.calculation.closing, carry = {kind:'committed-period',rootHash:root.rootHash,throughDate:run.throughDate,stateHash:state.stateHash,costCents:stock.checks.find(row => row.key === 'costOfGoods').actualCents,operationId,planHash:run.planHash,evidenceHash:evidence.evidenceHash,evidenceRevision:evidence.evidenceRevision,completionAuditId:String(run.verification.completionAuditId)};
  return {state,carry};
}
module.exports = {readCommittedStockOpening,assertFrozenStockOpening};
