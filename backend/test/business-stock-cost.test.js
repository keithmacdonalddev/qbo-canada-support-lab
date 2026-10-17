'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { LIMITS, validateStockCostPolicy, emptyStockState, validateStockState, summarizeStockState, calculateStockCost, lotKeyFor } = require('../src/modules/business-stock-cost');
const scope = { environment: 'sandbox', realmId: '123456', connectionId: 'a'.repeat(24) };
const identity = { itemKey: 'workshop-stock-1', itemId: '101', assetAccountId: '9', costAccountId: '10' };
const period = { fromDate: '2026-10-01', throughDate: '2026-10-31' };
const opening = (throughDate = '2026-09-30', items = [identity]) => emptyStockState({ scope, rootHash: hash('independently verified zero master root'), throughDate, items });
const source = (key, lineIndex = 0) => ({ operationId: 'b'.repeat(24), scopeHash: hash(scope), logicalKey: hash(key), qboId: String(1000 + Number.parseInt(hash(key).slice(0, 12), 16)), lineIndex, compilationHash: hash('compiled ' + key), requestHash: hash('request ' + key), receiptHash: hash('receipt ' + key), receiptSource: 'request-correlated-readback' });
const buy = (key, txnDate, quantity, unitCostCents) => ({ entity: 'Bill', txnDate, itemId: identity.itemId, quantity, unitCostCents, source: source(key) });
const sell = (key, txnDate, quantity) => ({ entity: 'SalesReceipt', txnDate, itemId: identity.itemId, quantity, source: source(key) });
const rehash = value => { const { stateHash, ...body } = value; return { ...body, stateHash: hash(body) }; };
test('independent unequal-cost example consumes oldest layers and reconciles each sale and closing value', () => {
  const rows = [buy('first', '2026-10-01', 20, 600), buy('second', '2026-10-02', 30, 700), sell('sale one', '2026-10-03', 15), sell('sale two', '2026-10-04', 20)];
  const result = calculateStockCost(opening(), rows, period);
  assert.equal(result.purchaseCents, 33000); assert.equal(result.costOfSalesCents, 22500); assert.equal(result.inventoryChangeCents, 10500);
  assert.deepEqual(result.allocations.map(row => row.amountCents), [9000, 13500]);
  assert.deepEqual(result.allocations[1].consumed.map(row => [row.quantity, row.unitCostCents, row.amountCents]), [[5, 600, 3000], [15, 700, 10500]]);
  assert.deepEqual(summarizeStockState(result.closing), { version: 1, quantity: 15, valueCents: 10500, lotCount: 1, items: [{ itemKey: identity.itemKey, itemId: '101', quantity: 15, valueCents: 10500, lotCount: 1 }] });
});
test('opening buffer retains original receipt costs across adjacent months and keeps dormant physical items', () => {
  const dormant = { itemKey: 'workshop-stock-2', itemId: '102', assetAccountId: '9', costAccountId: '10' };
  const september = calculateStockCost(opening('2026-08-31', [identity, dormant]), [buy('September buffer', '2026-09-28', 20, 600)], { fromDate: '2026-09-01', throughDate: '2026-09-30' });
  const october = calculateStockCost(september.closing, [buy('October receipt', '2026-10-01', 25, 700), sell('October sale', '2026-10-02', 25)], period);
  assert.equal(october.costOfSalesCents, 15500); assert.equal(summarizeStockState(october.closing).valueCents, 14000);
  assert.equal(october.closing.rootHash, september.closing.rootHash); assert.equal(october.closing.items.length, 2); assert.deepEqual(october.closing.items[1].lots, []);
  assert.equal(october.allocations[0].consumed[0].sourceHash, hash(source('September buffer')));
});
test('calculation never mutates frozen opening lots and repeats the same consumption on recovery', () => {
  const first = calculateStockCost(opening(), [buy('saved purchase', '2026-10-01', 30, 2050)], { fromDate: '2026-10-01', throughDate: '2026-10-05' });
  const before = structuredClone(first.closing), rows = [sell('saved sale', '2026-10-06', 12)];
  const a = calculateStockCost(first.closing, rows, { fromDate: '2026-10-06', throughDate: '2026-10-31' });
  const b = calculateStockCost(first.closing, rows, { fromDate: '2026-10-06', throughDate: '2026-10-31' });
  assert.deepEqual(first.closing, before); assert.deepEqual(a, b); assert.equal(a.costOfSalesCents, 24600); assert.equal(summarizeStockState(a.closing).quantity, 18);
});
test('future purchases cannot cover an earlier sale and negative stock cannot be guessed', () => {
  assert.throws(() => calculateStockCost(opening(), [sell('early sale', '2026-10-01', 1), buy('later purchase', '2026-10-02', 5, 600)], period), /negative stock/);
  assert.throws(() => calculateStockCost(opening(), [buy('small receipt', '2026-10-01', 5, 600), sell('large sale', '2026-10-02', 6)], period), /negative stock/);
});
test('unequal-cost same-day order is unavailable; equal-cost ties remain deterministic', () => {
  assert.throws(() => calculateStockCost(opening(), [buy('same day one', '2026-10-01', 5, 600), buy('same day two', '2026-10-01', 5, 700)], period), /ordering evidence/);
  assert.throws(() => calculateStockCost(opening(), [buy('old lot', '2026-10-01', 5, 600), buy('new lot', '2026-10-02', 5, 700), sell('ambiguous sale', '2026-10-02', 5)], period), /ordering evidence/);
  const rows = [buy('equal one', '2026-10-01', 5, 600), buy('equal two', '2026-10-01', 5, 600), sell('equal sale', '2026-10-01', 7)];
  assert.deepEqual(calculateStockCost(opening(), rows, period), calculateStockCost(opening(), [...rows].reverse(), period));
});
test('stock-line provenance, company identity and duplicate original lines cannot be invented', () => {
  const row = buy('original', '2026-10-01', 5, 600);
  assert.throws(() => calculateStockCost(opening(), [row, structuredClone(row)], period), /repeated/);
  const samePhysical = buy('different logical identity', '2026-10-01', 5, 600); samePhysical.source.qboId = row.source.qboId;
  assert.throws(() => calculateStockCost(opening(), [row, samePhysical], period), /repeated/);
  const foreign = structuredClone(row); foreign.source.scopeHash = hash({ ...scope, realmId: '654321' });
  assert.throws(() => calculateStockCost(opening(), [foreign], period), /scoped elsewhere/);
  const unsupported = { ...row, entity: 'InventoryAdjustment' }; delete unsupported.unitCostCents;
  assert.throws(() => calculateStockCost(opening(), [unsupported], period), /Only original managed/);
  const changed = calculateStockCost(opening(), [row], period).closing; changed.items[0].lots[0].remainingQuantity--;
  assert.throws(() => validateStockState(changed), /changed/);
  changed.items[0].lots[0].remainingQuantity = 6;
  assert.throws(() => validateStockState(rehash(changed)), /whole units/);
});
test('fractional units, unsupported costs and overflow refuse instead of rounding', () => {
  for (const [quantity, cents] of [[0, 600], [1.5, 600], [5, 600.1], [5, 0], [5, Number.MAX_SAFE_INTEGER]]) assert.throws(() => calculateStockCost(opening(), [buy('invalid', '2026-10-01', quantity, cents)], period), /whole units|capacity/);
  assert.throws(() => calculateStockCost(opening(), [buy('unscoped item', '2026-10-01', 5, 600), { ...sell('unknown item', '2026-10-02', 1), itemId: '999' }], period), /Only original managed/);
});
test('periods stay contiguous and monthly while purchase layers survive a fiscal-year boundary', () => {
  const march = calculateStockCost(opening('2026-02-28'), [buy('prior fiscal stock', '2026-03-30', 10, 600)], { fromDate: '2026-03-01', throughDate: '2026-03-31' });
  const april = calculateStockCost(march.closing, [sell('new fiscal sale', '2026-04-01', 4)], { fromDate: '2026-04-01', throughDate: '2026-04-30' });
  assert.equal(april.costOfSalesCents, 2400); assert.equal(summarizeStockState(april.closing).valueCents, 3600);
  assert.throws(() => calculateStockCost(opening(), [], { fromDate: '2026-10-02', throughDate: '2026-10-31' }), /contiguous/);
  assert.throws(() => calculateStockCost(opening(), [], { fromDate: '2026-10-01', throughDate: '2026-11-01' }), /one calendar month/);
});
test('empty quantities and definition hashes alone do not select the costing method or tax treatment', () => {
  const policy = { version: 1, method: 'FIFO', methodEvidence: { kind: 'owner-observation', reference: 'Company stock settings observation', observedOn: '2026-10-16' }, purchaseTax: { treatment: 'fully-recoverable', evidenceReference: 'Confirmed purchase HST treatment for this company', confirmedOn: '2026-10-16' } };
  assert.deepEqual(validateStockCostPolicy(policy), policy);
  for (const method of ['MAC', 'unknown', null]) assert.throws(() => validateStockCostPolicy({ ...policy, method }), /explicitly observed FIFO/);
  assert.throws(() => validateStockCostPolicy({ ...policy, purchaseTax: { ...policy.purchaseTax, treatment: 'capitalize-PST' } }), /supported fully recoverable/);
  assert.throws(() => validateStockCostPolicy({ ...policy, methodEvidence: { ...policy.methodEvidence, kind: 'inferred-from-quantity' } }), /retained owner observation/);
  assert.throws(() => validateStockCostPolicy({ ...policy, methodEvidence: { ...policy.methodEvidence, reference: 'x' } }), /source reference/);
});
test('carried lot and line capacity is finite before larger evidence can be accepted', () => {
  const state = opening(), many = Array.from({ length: LIMITS.lots + 1 }, (_, index) => { const src = source('lot ' + index); return { lotKey: lotKeyFor(scope, identity.itemId, src), txnDate: '2026-09-01', originalQuantity: 1, remainingQuantity: 1, unitCostCents: 1, source: src }; }).sort((a, b) => a.lotKey.localeCompare(b.lotKey));
  state.items[0].lots = many; assert.throws(() => validateStockState(rehash(state)), /budget/);
  assert.throws(() => calculateStockCost(opening(), Array(LIMITS.rows + 1).fill(buy('many', '2026-10-01', 1, 1)), period), /line budget/);
});

test('physical IDs are strings and mixed numeric aliases cannot evade account or source identity', () => {
  for (const key of ['itemId','assetAccountId','costAccountId']) assert.throws(() => opening('2026-09-30',[{...identity,[key]:Number(identity[key])}]), error => error.code === 'BUSINESS_STOCK_COST_UNVERIFIED');
  assert.throws(() => opening('2026-09-30',[{...identity,assetAccountId:'9',costAccountId:9}]), /physical item/);
  const row = buy('numeric physical source','2026-10-01',5,600); row.source.qboId = 123;
  assert.throws(() => calculateStockCost(opening(),[row],period), /provenance/);
});
test('missing or sparse stock rows return the bounded unavailable error', () => {
  for (const rows of [[null],[undefined],Array(1)]) assert.throws(() => calculateStockCost(opening(),rows,period), error => error.code === 'BUSINESS_STOCK_COST_UNVERIFIED');
});
test('multiple same-day sales cannot allocate unequal carried purchase layers by arbitrary logical key', () => {
  const carried = calculateStockCost(opening(),[buy('older','2026-10-01',2,100),buy('newer','2026-10-02',2,200)],{fromDate:'2026-10-01',throughDate:'2026-10-02'}).closing;
  const sales = [sell('sale A','2026-10-03',2),sell('sale B','2026-10-03',2)];
  for (const rows of [sales,[...sales].reverse()]) assert.throws(() => calculateStockCost(carried,rows,{fromDate:'2026-10-03',throughDate:'2026-10-31'}), /ordering evidence/);
});
test('a carried or new purchase cannot claim the same original logical line under a different physical ID', () => {
  const state = calculateStockCost(opening(),[buy('one original','2026-10-01',5,600)],{fromDate:'2026-10-01',throughDate:'2026-10-01'}).closing, lot = state.items[0].lots[0], other = structuredClone(lot);
  other.source.qboId = '99999'; other.source.requestHash = hash('different request'); other.lotKey = lotKeyFor(scope,identity.itemId,other.source);
  state.items[0].lots.push(other); state.items[0].lots.sort((a,b) => a.lotKey.localeCompare(b.lotKey));
  assert.throws(() => validateStockState(rehash(state)), /repeated/);
});

test('documented FIFO inference remains explicitly labelled rather than becoming an owner observation',()=>{
 const policy={version:1,method:'FIFO',methodEvidence:{kind:'documented-inference',reference:'Official FIFO default guidance plus retained company inventory creation evidence; setting not directly observed',observedOn:'2026-10-16'},purchaseTax:{treatment:'fully-recoverable',evidenceReference:'Delegated fictional-business purchase HST assumption, not a filed tax fact',confirmedOn:'2026-10-16'}};
 const observed=validateStockCostPolicy(policy);assert.deepEqual(observed,policy);assert.equal(observed.methodEvidence.kind,'documented-inference');
 assert.throws(()=>validateStockCostPolicy({...policy,method:'MAC'}),/FIFO/);assert.throws(()=>validateStockCostPolicy({...policy,purchaseTax:{...policy.purchaseTax,treatment:'unconfirmed'}}),/fully recoverable/);
 assert.throws(()=>validateStockCostPolicy({...policy,methodEvidence:{...policy.methodEvidence,reference:''}}),/source reference/);
});
