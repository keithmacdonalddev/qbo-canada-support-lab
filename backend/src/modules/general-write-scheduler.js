'use strict';
// Resource-aware batch scheduling for the general governed write tool (design revision 2,
// docs/plans/general-governed-write-tool-2026-10-31.md, finding R1-4). Pure.
//
// QuickBooks batch items are unordered, so plan order alone guarantees nothing. Two items
// share a batch only when they share no resource, and an item that uses a resource after
// an earlier item goes in a strictly later batch, so plan order is kept per resource:
//   - `$ref` targets (the item needs the created id);
//   - each existing record it updates, voids, deletes, links or applies (balances and
//     backlinks have one writer at a time);
//   - each inventory item whose quantity it moves (a receipt before a sale of one item).
// Same layering idea as business-population-batch.js (consumed parents, stock items).
const MAX_BATCH = 30;
const STOCK_ENTITIES = new Set(['Bill', 'Purchase', 'VendorCredit', 'Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt']);
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function linkedRecords(payload) {
  const links = [...(payload?.LinkedTxn || []), ...(Array.isArray(payload?.Line) ? payload.Line : []).flatMap(line => line?.LinkedTxn || [])];
  return links.filter(link => !plain(link?.TxnId) && link?.$ref === undefined && link?.TxnId != null).map(link => (link.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link.TxnType) + ':' + String(link.TxnId));
}
function stockItems(entity, record, local) {
  if (!STOCK_ENTITIES.has(entity)) return [];
  return (Array.isArray(record?.Line) ? record.Line : []).map(line => line?.[line?.DetailType]?.ItemRef?.value).filter(id => id != null && !plain(id) && local.get('Item', String(id))?.Type === 'Inventory').map(id => 'stock:' + String(id));
}
// operations: [{ ref, op, entity, id?, payload, before?, dependsOn: [refs] }] in plan order.
function resourcesOf(operation, local) {
  const resources = new Set();
  if (operation.id !== undefined) resources.add('record:' + operation.entity + ':' + operation.id);
  for (const key of linkedRecords(operation.payload)) resources.add('record:' + key);
  for (const key of stockItems(operation.entity, operation.payload, local)) resources.add(key);
  // Before and after: a change or removal also claims what the record linked and moved
  // before (a removed link changes that record's balance and backlinks).
  if (operation.id !== undefined) {
    const before = operation.before || local.get(operation.entity, operation.id);
    for (const key of linkedRecords(before)) resources.add('record:' + key);
    for (const key of stockItems(operation.entity, before, local)) resources.add(key);
  }
  return [...resources].sort();
}
function scheduleBatches(operations, local, { maxBatch = MAX_BATCH } = {}) {
  const placed = new Map(), lastUse = new Map(), batches = [], resources = {};
  for (const operation of operations) {
    const own = resourcesOf(operation, local); resources[operation.ref] = own;
    let layer = 0;
    for (const name of operation.dependsOn || []) { if (!placed.has(name)) throw new Error('Operation ' + operation.ref + ' depends on ' + name + ', which is not an earlier operation.'); layer = Math.max(layer, placed.get(name) + 1); }
    for (const key of own) if (lastUse.has(key)) layer = Math.max(layer, lastUse.get(key) + 1);
    while ((batches[layer] || []).length >= maxBatch) layer++;
    (batches[layer] ||= []).push(operation.ref); placed.set(operation.ref, layer);
    for (const key of own) lastUse.set(key, layer);
  }
  return { batches: batches.filter(Boolean), resources };
}
module.exports = { scheduleBatches, resourcesOf, MAX_BATCH };
