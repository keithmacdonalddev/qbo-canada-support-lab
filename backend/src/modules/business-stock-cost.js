'use strict';
// Pure managed-stock cost predictions. No provider, database or write authority.
const { hash, canonical, date, shift } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/, QID = /^\d{1,30}$/;
const LIMITS = Object.freeze({ items: 100, lots: 2000, rows: 1000, allocations: 4000, bytes: 2500000, quantity: 1000000 });
function fail(message) { throw Object.assign(Error(message), { status: 409, code: 'BUSINESS_STOCK_COST_UNVERIFIED' }); }
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(label + ' has unsupported or missing fields.');
}
function equal(a, b) { return canonical(a) === canonical(b); }
function integer(value, { positive = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > max) fail('Stock quantities and costs must use supported whole units and exact cents.');
  return value;
}
function quantity(value, { positive = false, max = LIMITS.quantity } = {}) {
  const scaled = Math.round(value * 1000000);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (positive ? 0.000001 : 0) || value > max || !Number.isSafeInteger(scaled) || Math.abs(value * 1000000 - scaled) > 0.00001) fail('Stock quantities require at most six decimal places within the supported bounds.');
  return value;
}
function addQuantity(a, b, max = LIMITS.quantity) { return quantity(Math.round((a + b) * 1000000) / 1000000, { max }); }
function add(a, b) { if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) fail('Stock cost exceeds exact-cent capacity.'); return a + b; }
function cost(units, cents) { quantity(units, { positive: true }); if (typeof cents !== 'number' || !Number.isFinite(cents) || cents < 0) fail('Stock costs must be non-negative.'); const total = units * cents, rounded = Math.round(total); if (!Number.isSafeInteger(rounded) || Math.abs(total - rounded) > 0.00001) fail('Stock cost exceeds exact-cent capacity; sub-cent allocations require native rounding evidence.'); return rounded; }
function day(value) { try { date(value); } catch { fail('Stock cost needs a valid accounting date.'); } return value; }
function reference(value) { if (typeof value !== 'string' || value.trim().length < 5 || value.length > 500 || /[\u0000-\u001f]/.test(value)) fail('Retain a readable source reference for the observed stock-cost policy.'); return value.trim(); }
function validateStockCostPolicy(value) {
  exact(value, ['version', 'method', 'methodEvidence', 'purchaseTax'], 'Stock-cost policy');
  if (value.version !== 1 || value.method !== 'FIFO') fail('FIFO cost proof requires an explicitly observed FIFO method or documented inference; unknown or moving-average methods are unavailable.');
  exact(value.methodEvidence, ['kind', 'reference', 'observedOn'], 'Costing-method evidence');
  exact(value.purchaseTax, ['treatment', 'evidenceReference', 'confirmedOn'], 'Purchase-tax cost treatment');
  if (!['owner-observation', 'documented-inference'].includes(value.methodEvidence.kind) || value.purchaseTax.treatment !== 'fully-recoverable') fail('This proof requires a retained owner observation or documented inference and supported fully recoverable purchase-tax treatment.');
  day(value.methodEvidence.observedOn); day(value.purchaseTax.confirmedOn);
  reference(value.methodEvidence.reference); reference(value.purchaseTax.evidenceReference);
  return JSON.parse(canonical(value));
}
function itemIdentity(item) {
  if (typeof item.itemKey !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(item.itemKey) || ![item.itemId, item.assetAccountId, item.costAccountId].every(value => typeof value === 'string' && QID.test(value)) || item.assetAccountId === item.costAccountId) fail('Each stock identity needs its exact physical item and distinct asset/cost accounts.');
}
function validateOrigin(source, scope) {
  exact(source, ['operationId', 'scopeHash', 'logicalKey', 'qboId', 'lineIndex', 'compilationHash', 'requestHash', 'receiptHash', 'receiptSource', ...(source?.entity !== undefined ? ['entity'] : [])], 'Original stock-line provenance');
  if (!ID.test(source.operationId || '') || !['request-correlated-readback', 'owner-attributed-readback', 'population-readback', 'general-copy-replay'].includes(source.receiptSource) || source.scopeHash !== hash(scope) || (typeof source.qboId !== 'string' || !QID.test(source.qboId)) || ![source.logicalKey, source.compilationHash, source.requestHash, source.receiptHash].every(value => HASH.test(value || ''))) fail('Original stock-line receipt provenance is incomplete or scoped elsewhere.');
  if (source.entity !== undefined && !['Bill','Purchase','CreditMemo','RefundReceipt'].includes(source.entity)) fail('Unknown general stock source entity.');
  integer(source.lineIndex, { max: 99 });
  return source;
}
function lotKeyFor(scope, itemId, source) { return hash({ version: 1, scope, itemId, logicalKey: source.logicalKey, qboId: source.qboId, lineIndex: source.lineIndex, requestHash: source.requestHash, receiptHash: source.receiptHash }); }
function validateStockState(value, scope = value?.scope) {
  exact(value, ['version', 'scope', 'rootHash', 'throughDate', 'items', 'stateHash', ...(value?.orderingVersion !== undefined ? ['orderingVersion'] : [])], 'Carried stock state');
  scope = scoped(scope);
  if (value.orderingVersion !== undefined && value.orderingVersion !== 2) fail('Unknown stock ordering version.');
  if (value.version !== 1 || !equal(value.scope, scope) || !HASH.test(value.rootHash || '') || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > LIMITS.items) fail('The carried FIFO state needs its exact company and accepted zero root.');
  day(value.throughDate);
  const { stateHash, ...body } = value;
  if (hash(body) !== stateHash || Buffer.byteLength(canonical(value)) > LIMITS.bytes) fail('The retained FIFO state changed or exceeds its evidence budget.');
  const items = new Set(), keys = new Set(), lots = new Set(), physicalLots = new Set(), logicalLots = new Set(); let lotCount = 0, previousItem = null;
  for (const item of value.items) {
    exact(item, ['itemKey', 'itemId', 'assetAccountId', 'costAccountId', 'lots'], 'Carried stock item'); itemIdentity(item);
    if (items.has(item.itemId) || keys.has(item.itemKey) || (previousItem !== null && previousItem >= item.itemId) || !Array.isArray(item.lots)) fail('Physical stock identities must remain unique and ordered, including dormant roles.');
    items.add(item.itemId); keys.add(item.itemKey); previousItem = item.itemId;
    let previous = null, units = 0;
    for (const lot of item.lots) {
      exact(lot, ['lotKey', 'txnDate', 'originalQuantity', 'remainingQuantity', 'unitCostCents', 'source', ...(lot?.returnEvidenceHash !== undefined ? ['returnEvidenceHash'] : [])], 'Original remaining purchase lot');
      validateOrigin(lot.source, scope); if (lot.returnEvidenceHash !== undefined && !HASH.test(lot.returnEvidenceHash)) fail('A return layer lost its native valuation evidence.'); day(lot.txnDate); if (value.orderingVersion === 2) { quantity(lot.originalQuantity, { positive: true }); quantity(lot.remainingQuantity, { positive: true, max: lot.originalQuantity }); }
      else { integer(lot.originalQuantity, { positive: true, max: LIMITS.quantity }); integer(lot.remainingQuantity, { positive: true, max: lot.originalQuantity }); integer(lot.unitCostCents, { positive: true }); }
      cost(lot.originalQuantity, lot.unitCostCents);
      if (++lotCount > LIMITS.lots) fail('Remaining stock layers exceed their evidence budget.');
      const physicalLot = (lot.source.entity || 'Bill') + ':' + lot.source.qboId + ':' + lot.source.lineIndex, logicalLot = lot.source.logicalKey + ':' + lot.source.lineIndex;
      if (lot.lotKey !== lotKeyFor(scope, item.itemId, lot.source) || lots.has(lot.lotKey) || physicalLots.has(physicalLot) || logicalLots.has(logicalLot) || lot.txnDate > value.throughDate || (previous && (previous.txnDate > lot.txnDate || (previous.txnDate === lot.txnDate && (value.orderingVersion === 2 ? (previous.originalQuantity < lot.originalQuantity || (previous.originalQuantity === lot.originalQuantity && previous.lotKey >= lot.lotKey)) : (previous.unitCostCents !== lot.unitCostCents || previous.lotKey >= lot.lotKey)))))) fail('Remaining purchase layers are repeated, unordered, ambiguous or outside the carried period.');
      lots.add(lot.lotKey); physicalLots.add(physicalLot); logicalLots.add(logicalLot); previous = lot; units = addQuantity(units, lot.remainingQuantity); if (units > LIMITS.quantity) fail('Carried stock quantity exceeds its supported budget.');
    }
  }
  return value;
}
function emptyStockState({ scope, rootHash, throughDate, items }) {
  scope = scoped(scope);
  if (!Array.isArray(items) || items.some(item => !plain(item) || Object.keys(item).sort().join(',') !== 'assetAccountId,costAccountId,itemId,itemKey')) fail('An empty stock state requires independently validated zero-origin identities.');
  const body = { version: 1, scope, rootHash, throughDate, items: structuredClone(items).map(item => ({ ...item, lots: [] })).sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0) };
  return validateStockState({ ...body, stateHash: hash(body) }, scope);
}
function summarizeStockState(state) {
  validateStockState(state);
  let valueCents = 0, quantity = 0, lotCount = 0;
  const items = state.items.map(item => {
    const units = item.lots.reduce((sum, lot) => addQuantity(sum, lot.remainingQuantity), 0), cents = item.lots.reduce((sum, lot) => add(sum, cost(lot.remainingQuantity, lot.unitCostCents)), 0);
    valueCents = add(valueCents, cents); quantity = addQuantity(quantity, units, LIMITS.quantity * LIMITS.items); lotCount += item.lots.length;
    return { itemKey: item.itemKey, itemId: item.itemId, quantity: units, valueCents: cents, lotCount: item.lots.length };
  });
  return { version: 1, quantity, valueCents, lotCount, items };
}
function validateStockRows(rows, state, period, { general = state.orderingVersion === 2 } = {}) {
  if (!Array.isArray(rows) || rows.length > LIMITS.rows) fail('Stock-cost work exceeds its line budget.');
  day(period?.fromDate); day(period?.throughDate);
  if (period.fromDate !== shift(state.throughDate, 1) || period.throughDate < period.fromDate || period.fromDate.slice(0, 7) !== period.throughDate.slice(0, 7)) fail('Stock-cost periods must be contiguous and stay within one calendar month.');
  const identities = new Set(), physical = new Set(), itemMap = new Map(state.items.map(item => [item.itemId, item]));
  for (const row of rows) {
    exact(row, ['entity', 'txnDate', 'itemId', 'quantity', 'source', ...(['Bill', 'Purchase', 'CreditMemo', 'RefundReceipt'].includes(row?.entity) ? ['unitCostCents'] : []), ...(row?.returnEvidenceHash !== undefined ? ['returnEvidenceHash'] : [])], 'Accepted stock-cost line');
    if (!['Bill', 'Purchase', 'Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt'].includes(row.entity) || !itemMap.has(row.itemId)) fail('Only original managed stock bills, purchases, sales and evidenced returns are supported.');
    if (!general && !['Bill', 'SalesReceipt'].includes(row.entity)) fail('Only original managed stock bills and sales receipts are supported.');
    day(row.txnDate); validateOrigin(row.source, state.scope);
    if (general) quantity(row.quantity, { positive: true }); else integer(row.quantity, { positive: true, max: LIMITS.quantity });
    const key = row.source.logicalKey + ':' + row.source.lineIndex;
    const physicalKey = row.entity + ':' + row.source.qboId + ':' + row.source.lineIndex;
    if (identities.has(key) || physical.has(physicalKey) || row.txnDate < period.fromDate || row.txnDate > period.throughDate) fail('A stock line is repeated or outside its original accounting period.'); identities.add(key); physical.add(physicalKey);
    if (['Bill', 'Purchase', 'CreditMemo', 'RefundReceipt'].includes(row.entity)) { if (!general) integer(row.unitCostCents, { positive: true }); cost(row.quantity, row.unitCostCents); }
    if (['CreditMemo', 'RefundReceipt'].includes(row.entity) && !HASH.test(row.returnEvidenceHash || '')) fail('A stock return requires independent native valuation evidence; its sales price is not its cost.');
  }
  return rows;
}
function calculateStockCost(opening, rows, period, { general = opening?.orderingVersion === 2 || Array.isArray(rows) && rows.some(row => row?.source?.receiptSource === 'general-copy-replay') } = {}) {
  validateStockState(opening); validateStockRows(rows, opening, period, { general });
  const items = structuredClone(opening.items), itemMap = new Map(items.map(item => [item.itemId, item]));
  const incoming = row => ['Bill', 'Purchase', 'CreditMemo', 'RefundReceipt'].includes(row.entity);
  // Intuit's same-date receipt rule: larger received quantity first. A logical hash
  // only orders equal-cost ties; it must never choose between unequal-cost layers.
  if (general) for (const item of items) item.lots.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || b.originalQuantity - a.originalQuantity || a.lotKey.localeCompare(b.lotKey));
  const ordered = [...rows].sort((a, b) => a.txnDate.localeCompare(b.txnDate) || Number(incoming(b)) - Number(incoming(a)) || (general && incoming(a) && incoming(b) ? b.quantity - a.quantity : 0) || a.source.logicalKey.localeCompare(b.source.logicalKey) || a.source.lineIndex - b.source.lineIndex);
  const allocations = [], purchases = []; let purchaseCents = 0, costOfSalesCents = 0, allocationCount = 0;
  for (const txnDate of [...new Set(ordered.map(row => row.txnDate))]) {
    const onDate = ordered.filter(row => row.txnDate === txnDate);
    for (const item of items) {
      const receipts = onDate.filter(row => row.itemId === item.itemId && incoming(row)), outgoing = onDate.filter(row => row.itemId === item.itemId && !incoming(row));
      if (!general && (new Set(receipts.map(row => row.unitCostCents)).size > 1 || ((outgoing.length > 1 || receipts.length && outgoing.length) && new Set([...receipts.map(row => row.unitCostCents), ...item.lots.map(lot => lot.unitCostCents)]).size > 1))) fail('Unequal-cost stock purchases and sales on the same date require ordering evidence this FIFO proof does not have.');
      if (general) for (const row of receipts) if (receipts.some(other => other !== row && other.quantity === row.quantity && other.unitCostCents !== row.unitCostCents)) fail('Equal-quantity unequal-cost same-day receipts require native ordering evidence this FIFO proof does not have.');
      if (general && outgoing.length > 1 && new Set([...receipts.map(row => row.unitCostCents), ...item.lots.map(lot => lot.unitCostCents)]).size > 1) fail('Multiple same-day sales across unequal cost layers require native ordering evidence.');
    }
    for (const row of onDate) {
      const item = itemMap.get(row.itemId);
      if (incoming(row)) {
        const lot = { lotKey: lotKeyFor(opening.scope, row.itemId, row.source), txnDate: row.txnDate, originalQuantity: row.quantity, remainingQuantity: row.quantity, unitCostCents: row.unitCostCents, source: structuredClone(row.source), ...(row.returnEvidenceHash ? { returnEvidenceHash: row.returnEvidenceHash } : {}) };
        if (items.some(value => value.lots.some(old => old.lotKey === lot.lotKey || (old.source.lineIndex === lot.source.lineIndex && ((old.source.entity || 'Bill') === (lot.source.entity || 'Bill') && old.source.qboId === lot.source.qboId || old.source.logicalKey === lot.source.logicalKey))))) fail('A saved purchase lot cannot be added again.');
        item.lots.push(lot); item.lots.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || (general ? b.originalQuantity - a.originalQuantity : 0) || a.lotKey.localeCompare(b.lotKey));
        const amountCents = cost(row.quantity, row.unitCostCents);
        if (row.returnEvidenceHash) {
          costOfSalesCents = add(costOfSalesCents, -amountCents);
          allocations.push({ itemId: row.itemId, logicalKey: row.source.logicalKey, lineIndex: row.source.lineIndex, qboId: row.source.qboId, quantity: -row.quantity, amountCents: -amountCents, sourceHash: hash(row.source), consumed: [], returnEvidenceHash: row.returnEvidenceHash });
        } else {
          purchaseCents = add(purchaseCents, amountCents);
          purchases.push({ itemId: row.itemId, lotKey: lot.lotKey, quantity: row.quantity, amountCents });
        }
      } else {
        let remaining = row.quantity, amountCents = 0; const consumed = [];
        while (remaining > 0) {
          const lot = item.lots[0]; if (!lot || lot.txnDate > row.txnDate) fail('The managed FIFO layers cannot cover this sale without negative stock.');
          const quantity = Math.min(remaining, lot.remainingQuantity), cents = cost(quantity, lot.unitCostCents);
          if (++allocationCount > LIMITS.allocations) fail('FIFO consumption exceeds its retained allocation budget.');
          consumed.push({ lotKey: lot.lotKey, quantity, unitCostCents: lot.unitCostCents, amountCents: cents, sourceHash: hash(lot.source) });
          amountCents = add(amountCents, cents); remaining = addQuantity(remaining, -quantity); lot.remainingQuantity = addQuantity(lot.remainingQuantity, -quantity); if (!lot.remainingQuantity) item.lots.shift();
        }
        costOfSalesCents = add(costOfSalesCents, amountCents);
        allocations.push({ itemId: row.itemId, logicalKey: row.source.logicalKey, lineIndex: row.source.lineIndex, qboId: row.source.qboId, quantity: row.quantity, amountCents, sourceHash: hash(row.source), consumed });
      }
    }
  }
  const body = { version: 1, ...(general ? { orderingVersion: 2 } : {}), scope: opening.scope, rootHash: opening.rootHash, throughDate: period.throughDate, items };
  const closing = validateStockState({ ...body, stateHash: hash(body) }), start = summarizeStockState(opening), end = summarizeStockState(closing);
  if (add(start.valueCents, purchaseCents - costOfSalesCents) !== end.valueCents) fail('Carried FIFO value does not reconcile to original purchase and consumption costs.');
  const result = { version: 1, openingHash: opening.stateHash, closing, purchaseCents, costOfSalesCents, inventoryChangeCents: purchaseCents - costOfSalesCents, purchases, allocations };
  if (Buffer.byteLength(canonical(result)) > LIMITS.bytes) fail('The complete FIFO calculation exceeds its evidence budget.');
  return result;
}
module.exports = { LIMITS, validateStockCostPolicy, validateStockState, emptyStockState, summarizeStockState, calculateStockCost, validateStockRows, lotKeyFor, quantity, cost, calculateGeneralStockCost: (opening, rows, period) => calculateStockCost(opening, rows, period, { general: true }) };
