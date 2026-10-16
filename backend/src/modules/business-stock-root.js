'use strict';
const { hash, canonical, shift } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { validateStockCostPolicy, emptyStockState } = require('./business-stock-cost');
const { validateInventoryObservation, TYPES } = require('./business-record-inventory');
const { accountSelection, balances } = require('./business-financial-movements');
const { unpackReport } = require('./business-report-source');
const { assertMasterRun, assertMasterApproval, verifiedParents } = require('./business-master-preparation-transport');
const { compileMasterEntry, verifyMasterReadback } = require('./business-master-preparation-plan');
const { assertMasterRecordSet } = require('./business-master-record-evidence');
const KEYS = Object.freeze(['inventoryAsset','costOfGoods']), HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(Error(message), {status:409,code:'BUSINESS_STOCK_COST_UNVERIFIED'}); }
const equal = (a,b) => canonical(a) === canonical(b);
const read = (Model,filter,session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
function stockIdentities(view) {
  validateStockCostPolicy(view.business.stockCosting);
  return Array.from({length:5},(_,index) => ({itemKey:'workshop-stock-'+(index+1),itemId:view.masterBindings?.['workshop-stock-'+(index+1)],assetAccountId:view.mappings.inventoryAsset,costAccountId:view.mappings.costOfGoods}));
}
function originFor(run,row) {
  const attempt = row.attempts.at(-1);
  if (row.state !== 'verified' || attempt?.ownerAttribution || attempt?.outcome?.outcome !== 'saved' || run.plan.inventoryBefore.Item.includes(row.qboId) || attempt.payload?.QtyOnHand !== 0 || row.readback?.fields?.QtyOnHand !== 0) fail('Stock cost needs original verified zero-quantity Item creation, without attribution or unknown history.');
  return {itemKey:row.key,itemId:row.qboId,masterRunId:String(run._id),planHash:run.planHash,receiptId:attempt.receiptId,requestHash:attempt.requestHash,syncToken:row.readback.syncToken,readbackHash:hash(row.readback)};
}
async function originalStockItems(models,scope,ownerId,identities,session,pinned) {
  const MasterRuns = models.MasterRuns || require('../models/MasterPreparationRun'), origins = [], current = [];
  for (const identity of identities) {
    const filter = pinned ? {_id:pinned.find(row => row.itemId === identity.itemId)?.masterRunId,...scope,ownerId} : {...scope,ownerId,records:{$elemMatch:{entity:'Item',qboId:identity.itemId}}};
    const runs = await MasterRuns.find(filter).limit(2).session(session).maxTimeMS(3000).lean();
    if (runs.length !== 1) fail('Each stock Item needs one original scoped verified master preparation.');
    const run = assertMasterRun(runs[0],scope,ownerId), approval = assertMasterApproval(run);
    if (!await read(models.Audits,{_id:approval.auditId,userId:ownerId,realmId:scope.realmId,action:'Business master preparation approved',outcome:'success','afterState.approvalHash':approval.contentHash,'afterState.planHash':run.planHash,'afterState.runId':String(run._id)},session)) fail('The original stock preparation approval is unavailable.');
    const matches = run.records.filter(row => row.entity === 'Item' && row.key === identity.itemKey && row.qboId === identity.itemId);
    if (matches.length !== 1) fail('The exact stock role lost its original created identity.');
    const row = matches[0], origin = originFor(run,row);
    await assertMasterRecordSet(models,scope,run,[row],session);
    if (pinned && !equal(origin,pinned.find(value => value.itemId === identity.itemId))) fail('The original accepted zero-stock source changed.');
    origins.push(origin); current.push({identity,compiled:compileMasterEntry(run.plan,row.ordinal,verifiedParents(run)),originalReadback:row.readback});
  }
  return {origins,current};
}
function validateStockRoot(value,scope,view) {
  const {rootHash,...root} = value || {};
  if (root.version !== 1 || !equal(root.scope,scoped(scope)) || hash(root) !== rootHash || ![root.blueprintHash,root.baselineHash,root.inventoryHash,root.policyHash].every(value => HASH.test(value || '')) || !Array.isArray(root.origins) || root.origins.length !== 5 || !Array.isArray(root.items) || root.items.length !== 5 || !Number.isInteger(root.fiscalYearStartMonth) || root.fiscalYearStartMonth < 1 || root.fiscalYearStartMonth > 12 || !Number.isSafeInteger(root.openingCostCents) || Buffer.byteLength(canonical(value)) > 1000000) fail('The immutable zero-stock root is unavailable or changed.');
  if (view && (root.policyHash !== hash(validateStockCostPolicy(view.business.stockCosting)) || !equal(root.items,stockIdentities(view)))) fail('Stock method, tax evidence or physical account/item identities differ from publication.');
  const {sourceHash,...source} = root.zeroSource || {};
  if (source.version !== 1 || !equal(source.scope,scope) || hash(source) !== sourceHash || source.recordsHash !== root.inventoryHash || source.completeMetadata !== true || !Number.isSafeInteger(source.transactionCount) || source.transactionCount < 0 || !Array.isArray(source.items) || source.items.length !== 5 || !Array.isArray(source.otherInventory) || source.inventoryItemCount !== source.items.length + source.otherInventory.length || !HASH.test(source.originalSourceHash || '') || !Array.isArray(root.accounts) || !equal(root.accounts.map(row => row.key),KEYS) || root.accounts[0].id === root.accounts[1].id || root.items.some(item => item.assetAccountId !== root.accounts[0].id || item.costAccountId !== root.accounts[1].id)) fail('The retained zero-stock source is incomplete.');
  const otherIds = new Set();
  for (const other of source.otherInventory) {
    if (typeof other.itemId !== 'string' || !/^\d{1,30}$/.test(other.itemId) || root.items.some(item => item.itemId === other.itemId) || otherIds.has(other.itemId) || typeof other.assetAccountId !== 'string' || typeof other.costAccountId !== 'string' || !/^\d{1,30}$/.test(other.assetAccountId) || !/^\d{1,30}$/.test(other.costAccountId) || other.assetAccountId === root.accounts[0].id || other.costAccountId === root.accounts[1].id || !HASH.test(other.recordHash || '')) fail('Other inventory must have separate physical stock and cost accounts.');
    otherIds.add(other.itemId);
  }
  const created = [];
  for (const item of root.items) {
    const matches = source.items.filter(row => row.Id === item.itemId), raw = matches[0];
    if (matches.length !== 1 || raw.Type !== 'Inventory' || raw.Active !== true || raw.TrackQtyOnHand !== true || raw.QtyOnHand !== 0 || raw.AssetAccountRef?.value !== item.assetAccountId || raw.ExpenseAccountRef?.value !== item.costAccountId || typeof raw.InvStartDate !== 'string' || raw.InvStartDate > root.openingDate || !Number.isFinite(Date.parse(raw.MetaData?.CreateTime)) || Date.parse(raw.MetaData.LastUpdatedTime) !== Date.parse(raw.MetaData.CreateTime) || raw.SyncToken !== root.origins.find(origin => origin.itemId === item.itemId)?.syncToken) fail('The zero root needs every exact active Item, zero units, start date and stock accounts.');
    created.push(Date.parse(raw.MetaData.CreateTime));
  }
  const updated = source.latestTransactionUpdate;
  if (source.transactionCount ? !Number.isFinite(Date.parse(updated)) || Date.parse(updated) >= Math.min(...created) : updated !== null) fail('Prior transaction activity cannot be excluded from this newly created stock root.');
  emptyStockState({scope,rootHash,throughDate:shift(root.openingDate,-1),items:root.items});
  return value;
}
async function buildStockRoot({models,scope,ownerId,view,baseline,stockObservation,company,now}) {
  scope = scoped(scope); const policy = validateStockCostPolicy(view.business.stockCosting);
  const today = require('./business-activity-preview').businessDate(new Date(now));
  if (policy.methodEvidence.observedOn > today || policy.purchaseTax.confirmedOn > today) fail('Stock policy observations cannot be future-dated.');
  const {inventory,stockSource} = stockObservation || {};
  const observation = validateInventoryObservation(inventory,scope);
  if (Date.parse(observation.observedAt) > now || now - Date.parse(observation.startedAt) > 180000 || hash(inventory.records) !== hash(baseline.inventorySources.records)) fail('The fresh stock inventory must match the exact accepted opening observation.');
  if (company?.version !== 2 || company.country !== 'CA' || !equal(company.scope,scope) || !Number.isInteger(company.fiscalYearStartMonth)) fail('The observed company fiscal calendar is required.');
  const {sourceHash: originalSourceHash, ...originalSource} = stockSource || {};
  if (!HASH.test(originalSourceHash || '') || hash(originalSource) !== originalSourceHash || !equal(originalSource.scope, scope) || originalSource.recordsHash !== hash(inventory.records) || !Array.isArray(originalSource.items)) fail('The original complete stock metadata source changed.');
  for (const raw of originalSource.items) if (inventory.records.Item.filter(row => row.id === raw.Id && row.contentHash === hash(raw)).length !== 1) fail('A full stock metadata record differs from the complete inventory.');
  const items = stockIdentities(view), originals = await originalStockItems(models,scope,ownerId,items);
  for (const {identity,compiled,originalReadback} of originals.current) {
    const raw = stockSource?.items?.find(row => row.Id === identity.itemId), compact = inventory.records.Item.find(row => row.id === identity.itemId);
    if (!raw || !compact || hash(raw) !== compact.contentHash) fail('The full zero-stock record does not match the complete inventory.');
    if (!equal(verifyMasterReadback(compiled,raw,identity.itemId),originalReadback)) fail('The stock Item changed after its original verified zero creation. Unknown intervening history cannot start this cost proof.');
  }
  if (stockSource?.transactionCount !== TYPES.filter(type => !['Customer','Vendor','Item','Account'].includes(type)).reduce((sum,type) => sum + inventory.records[type].length,0)) fail('The complete transaction metadata count changed.');
  const selected = accountSelection(scope,view.mappings,baseline.sources.accounts,KEYS), opening = balances(unpackReport('TrialBalance',baseline.sources.reports.TrialBalance,baseline.sources.version),baseline.sources.accounts,selected,baseline.payload.period);
  if (opening.inventoryAsset !== 0) fail('The new managed stock root requires an observed zero inventory-asset balance.');
  const selectedIds = new Set(items.map(item => item.itemId));
  const zeroBody = {...originalSource,originalSourceHash,inventoryItemCount:originalSource.items.length,items:originalSource.items.filter(row => selectedIds.has(row.Id)),otherInventory:originalSource.items.filter(row => !selectedIds.has(row.Id)).map(row => ({itemId:row.Id,assetAccountId:row.AssetAccountRef?.value || null,costAccountId:row.ExpenseAccountRef?.value || null,recordHash:hash(row)}))};
  const zeroSource = {...zeroBody,sourceHash:hash(zeroBody)};
  const root = {version:1,scope,blueprintHash:view.contentHash,baselineHash:baseline.evidenceHash,inventoryHash:hash(inventory.records),openingDate:view.business.openingDate,policyHash:hash(policy),fiscalYearStartMonth:company.fiscalYearStartMonth,openingCostCents:opening.costOfGoods,accounts:selected,items,origins:originals.origins,zeroSource};
  return validateStockRoot({...root,rootHash:hash(root)},scope,view);
}
async function assertStockRootOrigins(models,root,ownerId,session) {
  validateStockRoot(root,root.scope); await originalStockItems(models,root.scope,ownerId,root.items,session,root.origins); return root;
}
module.exports = {KEYS,stockIdentities,validateStockRoot,buildStockRoot,assertStockRootOrigins};
