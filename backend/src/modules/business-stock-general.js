'use strict';
// General stock admission and line-derived posting evidence. No live calls. The
// opening is the accepted FIFO carry, not Item.PurchaseCost or today's quantity.
const { hash, canonical } = require('./business-calendar');
const { calculateGeneralStockCost: calculateStockCost, quantity, cost, summarizeStockState } = require('./business-stock-cost');
const RECEIPTS = new Set(['Bill', 'Purchase']);
const SALES = new Set(['Invoice', 'SalesReceipt']);
const RETURNS = new Set(['CreditMemo', 'RefundReceipt', 'VendorCredit']);
const NON_POSTING = new Set(['Estimate', 'PurchaseOrder']);
const STOCK_ENTITIES = Object.freeze(['Bill', 'Purchase', 'Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt', 'VendorCredit', 'JournalEntry', 'Transfer', 'Deposit']);
function fail(message) { throw Object.assign(Error(message), { status: 409, code: 'BUSINESS_STOCK_COST_UNVERIFIED' }); }
function stockLines(entity, record, opening, sourceFor, returnValuations = {}, { pending = false } = {}) {
  if (!record || NON_POSTING.has(entity) || record.status === 'Voided' || record.PrivateNote?.startsWith?.('Voided')) return [];
  const rows = [], seenItems = new Set();
  for (const [lineIndex, line] of (record.Line || []).entries()) {
    const detail = line?.[line.DetailType], item = opening.items.find(item => item.itemId === String(detail?.ItemRef?.value));
    if (!item) continue;
    if (seenItems.has(item.itemId)) fail('Repeated inventory items in one record need native line-order evidence.');
    seenItems.add(item.itemId);
    if (!RECEIPTS.has(entity) && !SALES.has(entity) && !RETURNS.has(entity)) fail(entity + ' inventory movement is not supported.');
    if (entity === 'Purchase' && record.Credit === true) fail('Stock supplier refunds require a separate valuation contract.');
    const wanted = RECEIPTS.has(entity) || entity === 'VendorCredit' ? 'ItemBasedExpenseLineDetail' : 'SalesItemLineDetail';
    if (line.DetailType !== wanted) fail('Inventory line type differs from its stock movement.');
    quantity(detail.Qty, { positive: true });
    if (record.CurrencyRef?.value && record.CurrencyRef.value !== 'CAD' || record.GlobalTaxCalculation !== 'TaxExcluded') fail('Stock proof requires CAD and fully recoverable tax-excluded purchase costs.');
    const unitCostCents = Number(detail.UnitPrice) * 100;
    if (typeof detail.UnitPrice !== 'number' || !Number.isFinite(detail.UnitPrice) || detail.UnitPrice < 0 || cost(detail.Qty, unitCostCents) !== Math.round(line.Amount * 100)) fail('Stock line quantity times price must equal its exact-cent amount.');
    const row = { entity, txnDate: record.TxnDate, itemId: item.itemId, quantity: detail.Qty, source: sourceFor(lineIndex) };
    if (RECEIPTS.has(entity)) row.unitCostCents = unitCostCents;
    if (RETURNS.has(entity) && !pending) {
      // This evidence is server-owned; it is NEVER read from the proposed payload.
      const proof = returnValuations[hash({ entity, record, lineIndex })];
      if (!proof || proof.recordHash !== hash(record) || !/^[a-f0-9]{64}$/.test(proof.evidenceHash || '')) fail('Stock returns need independent native cost valuation evidence.');
      if (!Number.isFinite(proof.unitCostCents) || proof.unitCostCents < 0) fail('Native return cost is invalid.');
      if (entity === 'VendorCredit') { if (proof.unitCostCents !== unitCostCents) fail('Supplier return native cost differs from its credit amount.'); }
      row.unitCostCents = proof.unitCostCents;
      row.returnEvidenceHash = proof.evidenceHash;
    }
    rows.push(row);
  }
  return rows;
}
function sourceOf(scope, entity, record, lineIndex) {
  const logicalKey = hash({ entity, id: record.Id }), recordHash = hash(record);
  return { operationId: recordHash.slice(0, 24), scopeHash: hash(scope), logicalKey, qboId: record.Id, lineIndex, compilationHash: recordHash, requestHash: recordHash, receiptHash: recordHash, receiptSource: 'general-copy-replay', ...(['Bill','Purchase','CreditMemo','RefundReceipt'].includes(entity) ? { entity } : {}) };
}
function replayStockRecords({ opening, records, period, returnValuations = {} }) {
  const rows = records.flatMap(({ entity, record }) => stockLines(entity, record, opening, index => sourceOf(opening.scope, entity, record, index), returnValuations));
  const calculation = calculateStockCost(opening, rows, period);
  const costs = new Map();
  for (const allocation of calculation.allocations) costs.set(allocation.logicalKey + ':' + allocation.lineIndex, allocation.amountCents);
  return { calculation, rows, costs, basisHash: hash({ openingHash: opening.stateHash, records, period, returnValuations }) };
}
function stockPostingCost(basis, entity, record, lineIndex) {
  return require('./business-stock-evidence').generalStockLineCost(basis, entity, record, lineIndex);
}
function checkPurchaseReceipts(entries, local, stock = {}) {
  const used = new Map();
  for (const entry of entries) for (const link of entry.after?.LinkedTxn || []) if (link.TxnType === 'PurchaseOrder' && !(entry.after.Line || []).some(line => (line.LinkedTxn || []).some(target => target.TxnType === 'PurchaseOrder' && String(target.TxnId) === String(link.TxnId)))) fail('Header purchase-order links require exact line allocations.');
  for (const entry of entries) for (const line of entry.after?.Line || []) for (const link of line.LinkedTxn || []) {
    if (link.TxnType !== 'PurchaseOrder') continue;
    const po = local.get('PurchaseOrder', String(link.TxnId));
    if (!po || !link.TxnLineId) fail('A partial receipt needs its exact purchase-order id and line id from the copy.');
    if (po.POStatus !== 'Open' || !po.TxnDate || po.TxnDate > entry.after.TxnDate || po.CurrencyRef?.value && po.CurrencyRef.value !== 'CAD') fail('A receipt needs an open CAD purchase order dated no later than the receipt.');
    if (entry.entity !== 'Bill' || String(po.VendorRef?.value) !== String(entry.after.VendorRef?.value)) fail('A stock receipt must use its purchase order supplier.');
    const original = po.Line?.find(row => String(row.Id) === String(link.TxnLineId));
    const detail = line.ItemBasedExpenseLineDetail, ordered = original?.ItemBasedExpenseLineDetail;
    if (!detail || !ordered || detail.ItemRef?.value !== ordered.ItemRef?.value || (line.LinkedTxn || []).length !== 1) fail('A partial receipt must match exactly one purchase-order item line.');
    const key = po.Id + ':' + link.TxnLineId;
    if (!used.has(key)) {
      let received = 0;
      const seen = new Set();
      const forward = (stock.receiptHistory || []).filter(row => [...(row.record.LinkedTxn || []), ...(row.record.Line || []).flatMap(line => line.LinkedTxn || [])].some(link => link.TxnType === 'PurchaseOrder' && String(link.TxnId) === po.Id)).map(row => ({ TxnType: row.entity, TxnId: row.record.Id }));
      for (const child of [...(po.LinkedTxn || []), ...forward]) {
        const childKey = child.TxnType + ':' + child.TxnId;
        if (seen.has(childKey)) continue; seen.add(childKey);
        if (!['Bill', 'Purchase'].includes(child.TxnType)) fail('Purchase-order receipt history has an unsupported linked record.');
        const prior = (stock.receiptHistory || []).find(row => row.entity === child.TxnType && row.record.Id === String(child.TxnId))?.record || local.get(child.TxnType, String(child.TxnId));
        if (!prior) fail('Every previous partial receipt must be current in the copy.');
        if (String(prior.VendorRef?.value) !== String(po.VendorRef?.value) || prior.TxnDate < po.TxnDate || prior.TxnDate > entry.after.TxnDate || prior.CurrencyRef?.value && prior.CurrencyRef.value !== 'CAD') fail('A previous partial receipt has a different supplier, date or currency.');
        if (prior.status === 'Voided' || prior.PrivateNote?.startsWith?.('Voided')) continue;
        let allocated = false;
        for (const old of prior.Line || []) {
          const targets = (old.LinkedTxn || []).filter(target => target.TxnType === 'PurchaseOrder' && String(target.TxnId) === po.Id);
          if (!targets.length) continue;
          const parentLine = po.Line?.find(row => String(row.Id) === String(targets[0].TxnLineId));
          if (targets.length !== 1 || (old.LinkedTxn || []).length !== 1 || !targets[0].TxnLineId || !parentLine || old.ItemBasedExpenseLineDetail?.ItemRef?.value !== parentLine.ItemBasedExpenseLineDetail?.ItemRef?.value) fail('A previous partial receipt cannot be allocated to an exact purchase-order item line.');
          allocated = true;
          quantity(old.ItemBasedExpenseLineDetail?.Qty, { positive: true });
          if (String(targets[0].TxnLineId) === String(link.TxnLineId)) received += old.ItemBasedExpenseLineDetail.Qty;
        }
        if (!allocated) fail('A backlinked previous receipt has no complete forward purchase-order line allocation.');
      }
      used.set(key, received);
    }
    quantity(ordered.Qty, { positive: true }); quantity(detail.Qty, { positive: true });
    const total = Math.round((used.get(key) + detail.Qty) * 1000000) / 1000000;
    if (total > ordered.Qty) fail('Partial receipts exceed the purchase-order line remaining quantity.');
    used.set(key, total);
  }
}
function checkStockPlan(entries, local, stock) {
  if (!stock?.opening || !Array.isArray(stock.records)) fail('Inventory requires a complete current-day copy and the accepted FIFO opening.');
  for(const entry of entries) for(const line of entry.after?.Line||[]) { const id=line[line.DetailType]?.ItemRef?.value; if(local.get('Item',id)?.Type==='Inventory' && !stock.opening.items.some(i=>i.itemId===id)) fail('This inventory item is outside the accepted managed stock root.'); }
  checkPurchaseReceipts(entries, local, stock);
  let records = structuredClone(stock.records), pendingReturns = false; const returnedItems=new Set(), unpricedItems=new Set();
  for (const entry of entries) {
    if (NON_POSTING.has(entry.entity)) continue;
    const record = entry.after ? { ...entry.after, Id: entry.id || '9' + String(entry.order + 1).padStart(29, '0') } : null;
    if(record && (record.Line||[]).some(line=>unpricedItems.has(line[line.DetailType]?.ItemRef?.value))) fail('Wait for native valuation of the sold-out item return before dependent stock work.');
    if (RETURNS.has(entry.entity) && record) {
      const before = replayStockRecords({ ...stock, records });
      // Projection only: use an ordinary receipt/sale to test capacity. It is
      // never retained as accepted stock or represented as native cost evidence.
      const rows = stockLines(entry.entity, record, stock.opening, index => sourceOf(stock.opening.scope, entry.entity, record, index), {}, { pending:true });
      const projection = [];
      for (const row of rows) {
        const item = before.calculation.closing.items.find(i=>i.itemId===row.itemId);
        const costs = new Set(item.lots.map(lot=>lot.unitCostCents));
        if (costs.size > 1 || entry.entity==='VendorCredit' && costs.size!==1) fail('A proposed return requires homogeneous accepted FIFO cost layers; mixed layers need native return-layer evidence.');
        returnedItems.add(row.itemId);
        if(!costs.size) unpricedItems.add(row.itemId);
        const unitCostCents = costs.size ? [...costs][0] : 0;
        if (entry.entity === 'VendorCredit' && Math.round(record.Line[row.source.lineIndex].Amount*100) !== cost(row.quantity,unitCostCents)) fail('Supplier return credit must equal the homogeneous accepted stock cost.');
        if (entry.entity !== 'VendorCredit') cost(row.quantity,unitCostCents);
        const type = entry.entity==='VendorCredit'?'SalesItemLineDetail':'ItemBasedExpenseLineDetail';
        projection.push({Amount:cost(row.quantity,unitCostCents)/100,DetailType:type,[type]:{ItemRef:{value:row.itemId},Qty:row.quantity,UnitPrice:unitCostCents/100}});
      }
      if(projection.length) records.push({entity:entry.entity==='VendorCredit'?'Invoice':'Bill',record:{Id:record.Id,TxnDate:record.TxnDate,CurrencyRef:{value:'CAD'},GlobalTaxCalculation:'TaxExcluded',Line:projection}});
      pendingReturns ||= rows.length > 0;
    } else if (record) records.push({ entity:entry.entity,record });
    try {
      const result = replayStockRecords({ ...stock, records });
      // Pending returns do not grant permission to mix cost layers in the same plan.
      if(pendingReturns && result.calculation.closing.items.some(item=>returnedItems.has(item.itemId) && new Set(item.lots.map(l=>l.unitCostCents)).size>1)) fail('Mixed-cost return plans need native layer-order evidence.');
    } catch(error) { error.ref=entry.ref;throw error; }
  }
  return true;
}
// Read only the mirrored current day, from the independently accepted opening.
// Every stock source must be current; every enumerated record is checked through
// the hardened observation store, including its generation and write barrier.
async function readGeneralStockContext({ models, scope, active, day, observations, session = null, purchaseOrderIds = [], readValuation = null, verifyValuation = false }) {
  const { state: opening } = await require('./business-stock-history').readCommittedStockOpening(models, active, session);
  const agent = await models.Agents.findOne(scope).session(session).maxTimeMS(3000).lean();
  const sources = agent?.sync?.sources || {}, records = [], receiptHistory = [];
  if (agent?.sync?.summaryError || ['attention', 'resyncing'].includes(agent?.sync?.amountReconciliation?.status)) fail('Stock source reconciliation is incomplete.');
  const sourceView = () => Object.fromEntries(['Item', ...STOCK_ENTITIES].map(entity => [entity, sources[entity]]));
  for (const entity of ['Item', ...STOCK_ENTITIES]) {
    const source = sources[entity];
    if (source?.status !== 'current' || source.phase !== 'incremental' || !source.generation || source.error || source.reconcileError) fail('The complete ' + entity + ' stock source is not current.');
    const clock = Date.now(), completed = new Date(source.lastSuccessAt).getTime(), cadence = Number.isSafeInteger(source.everyMs) && source.everyMs >= 1000 ? source.everyMs : 60000;
    const coverage = new Date(source.mode === 'cdc' ? source.since : source.startedAt).getTime();
    if (!Number.isFinite(completed) || completed > clock || clock - completed > Math.max(120000, cadence * 2) || !Number.isFinite(coverage) || coverage > completed) fail('Stock source freshness or coverage is unavailable, including empty sources.');
    if (await models.Receipts.findOne({ ...scope, $or: [{ entity: entity.toLowerCase() }, { entity: 'batch' }], sentAt: { $gte: new Date(coverage) } }).session(session).maxTimeMS(3000).lean()) fail('Stock source has a write after its coverage watermark; wait for complete synchronization.');
    const rows = await models.Records.find({ ...scope, entity, deleted: false, generation: source.generation, ...(entity === 'Item' ? {} : RECEIPTS.has(entity) && purchaseOrderIds.length ? { $or: [{ 'record.TxnDate': day }, { 'record.Line.LinkedTxn.TxnId': { $in: purchaseOrderIds } }, { 'record.LinkedTxn.TxnId': { $in: purchaseOrderIds } }] } : { 'record.TxnDate': day }) }).sort({ qboId: 1 }).limit(1001).session(session).maxTimeMS(3000).lean();
    if (rows.length > 1000) fail('Current-day stock exceeds its complete-copy budget.');
    for (const stored of rows) {
      const observed = await observations.read(scope, entity, stored.qboId, { transactions: true });
      if (!observed || hash(observed.record) !== hash(stored.record)) fail('The stock copy has a stale, pending or changed record.');
      const record = observed.record;
      if (RECEIPTS.has(entity)) receiptHistory.push({ entity, record });
      if (entity !== 'Item' && record.TxnDate !== day) continue;
      if (entity === 'Item') {
        const item = opening.items.find(item => item.itemId === record.Id);
        if (record.Type === 'Inventory' && !item && opening.items.some(i=>i.assetAccountId===record.AssetAccountRef?.value||i.costAccountId===record.ExpenseAccountRef?.value)) fail('An unmanaged inventory item shares managed asset or COGS routing.');
        if (item && (record.Type !== 'Inventory' || record.Active !== true || record.TrackQtyOnHand !== true || record.AssetAccountRef?.value !== item.assetAccountId || record.ExpenseAccountRef?.value !== item.costAccountId || record.InvStartDate !== active.value.stockRoot.zeroSource.items.find(row => row.Id === item.itemId)?.InvStartDate)) fail('An inventory item changed its accepted tracking, start date or asset/COGS routing.');
      } else {
        // Direct asset journals/deposits/transfers cannot silently bypass quantity replay.
        const assetIds = new Set(opening.items.map(item => item.assetAccountId));
        const hasAssetRef = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) => /AccountRef$/.test(key) && assetIds.has(String(child?.value)) || hasAssetRef(child));
        if (hasAssetRef(record)) fail('An unmodelled inventory asset posting exists in the current day.');
        records.push({ entity, record });
      }
    }
  }
  const returns = records.filter(row=>RETURNS.has(row.entity) && (row.record.Line||[]).some(line=>opening.items.some(i=>i.itemId===line[line.DetailType]?.ItemRef?.value)));
  const valuation = readValuation && (verifyValuation || returns.length) ? await readValuation({scope,day,records:returns,session,summary:verifyValuation}) : {};
  const returnValuations = returns.length ? require('./business-stock-valuation').nativeReturnValuations(valuation.InventoryValuationDetail,day,returns,opening) : {};
  const period = { fromDate: day, throughDate: day }, replay = replayStockRecords({ opening, records, period, returnValuations });
  const valuationChecks = verifyValuation ? require('./business-stock-valuation').compareItemValuation(valuation.InventoryValuationSummary,day,replay.calculation.closing) : [];
  const returnEvidence = valuation.InventoryValuationDetail ? require('./business-stock-valuation').evidence(scope,day,returns,valuation.InventoryValuationDetail) : null;
  for (const expected of summarizeStockState(replay.calculation.closing).items) {
    const observed = await observations.read(scope, 'Item', expected.itemId, { transactions: true });
    if (!observed || observed.record.QtyOnHand !== expected.quantity) fail('Current on-hand differs from the complete opening-plus-day replay (an adjustment or missing movement may exist).');
  }
  const after = await models.Agents.findOne(scope).session(session).maxTimeMS(3000).lean();
  if (canonical(JSON.parse(JSON.stringify(sourceView()))) !== canonical(JSON.parse(JSON.stringify(Object.fromEntries(['Item', ...STOCK_ENTITIES].map(entity => [entity, after?.sync?.sources?.[entity]])))))) fail('The stock copy watermark changed during replay.');
  return { opening, records, receiptHistory, period, replay, returnValuations, returnEvidence, valuationChecks, ...(verifyValuation ? {valuationReport:valuation.InventoryValuationSummary} : {}), basisHash: hash({replay:replay.basisHash,valuationChecks}) };
}
module.exports = { checkPurchaseReceipts, STOCK_ENTITIES, stockLines, replayStockRecords, stockPostingCost, checkStockPlan, readGeneralStockContext };
