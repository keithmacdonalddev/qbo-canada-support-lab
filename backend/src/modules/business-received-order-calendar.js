'use strict';
const { hash } = require('./business-calendar');
// Refuse a new receipt before it creates an ordering ambiguity with today's sale.
// Sale prices are irrelevant: compare the original purchase cost and FIFO layers.
function assertReceiptSaleCosts({ receipts, day, activity, opening, adoptedThrough = null }) {
  const events = new Map([...(activity.prerequisites || []), ...activity.events, ...(activity.future || [])].map(event => [event.logicalKey, event]));
  // Adopted occurrences and their dependent follow-ups are not calendar writes.
  const inherited = key => {
    const event = events.get(key);
    return Boolean(event && (event.txnDate <= adoptedThrough || event.dependsOn.some(inherited)));
  };
  for (const sale of activity.events.filter(event => event.entity === 'SalesReceipt' && event.txnDate === day && !(adoptedThrough && inherited(event.logicalKey)))) {
    for (const line of activity.detailProposal.byLogicalKey[sale.logicalKey].details.lines) {
      const incoming = receipts.flatMap(receipt => receipt.lines).filter(row => row.itemKey === line.itemKey);
      if (!incoming.length) continue;
      const item = opening.items.find(row => row.itemKey === line.itemKey);
      const originalCosts = sale.dependsOn.flatMap(key => activity.detailProposal.byLogicalKey[key].details.lines).filter(row => row.itemKey === line.itemKey && row.accountMapping === 'inventoryAsset').map(row => row.unitPriceCents);
      const costs = [...originalCosts, ...(item?.lots || []).map(lot => lot.unitCostCents), ...incoming.map(row => row.unitPriceCents)];
      if (!item || !originalCosts.length || costs.some(cost => !Number.isSafeInteger(cost) || cost < 1 || cost !== incoming[0].unitPriceCents)) throw Object.assign(Error('This receipt would mix unequal purchase costs with a scheduled sale of the same item today. Receive it on another day; same-day FIFO ordering is unverified.'), { status: 409, code: 'BUSINESS_PO_RECEIPT_UNVERIFIED' });
    }
  }
}
// A receipt made ahead of the calendar replaces its unsaved scheduled bill.
// Later sales/payments keep their dates and depend on the actual receiving bill.
async function replaceReceivedOrderBills({ models, scope, prepared, activity, history }) {
  const intents = await models.Intents.find({ ...scope, kind: 'create', 'step.details.purchaseOrderReceipt.source.kind': 'managed' }).limit(501).maxTimeMS(3000).lean();
  if (intents.length > 500) throw Error('Receiving calendar replacements exceed their bounded history.');
  const events = [...activity.prerequisites, ...activity.events, ...activity.future], replacements = new Map();
  for (const intent of intents) {
    const selected = intent.step.details.purchaseOrderReceipt;
    const scheduled = events.filter(event => event.entity === 'Bill' && event.dependsOn.includes(selected.source.logicalKey) && (prepared.steps.some(step => step.logicalKey === event.logicalKey || step.dependencies.some(link => link.logicalKey === event.logicalKey)) || prepared.earlierRequirements.some(row => row.logicalKey === event.logicalKey)));
    if (!scheduled.length) continue;
    const saved = await models.Steps.findOne({ ...scope, logicalKey: intent.logicalKey, entity: 'Bill', state: 'verified' }).maxTimeMS(3000).lean();
    const run = saved && await models.Runs.findOne({ ...scope, _id: saved.operationId, status: 'verified' }).maxTimeMS(3000).lean();
    if (!run) continue;
    const original = (await history(scope, [intent.logicalKey])).entries.find(row => row.logicalKey === intent.logicalKey);
    if (!original || original.fingerprint !== intent.fingerprint || original.qboId !== saved.qboId) throw Error('The earlier receiving bill lost its original ownership.');
    for (const event of scheduled) {
      if (replacements.has(event.logicalKey)) throw Error('Several receiving bills claim the same scheduled purchase order.');
      replacements.set(event.logicalKey, original);
    }
  }
  if (!replacements.size) return prepared;
  prepared.steps = prepared.steps.filter(step => !replacements.has(step.logicalKey));
  for (const step of prepared.steps) {
    for (const link of step.dependencies) if (replacements.has(link.logicalKey)) { link.logicalKey = replacements.get(link.logicalKey).logicalKey; link.source = 'prior_period'; link.state = 'unverified'; }
    for (const link of step.details.references) if (replacements.has(link.logicalKey)) link.logicalKey = replacements.get(link.logicalKey).logicalKey;
    if (replacements.has(step.details.amountSourceKey)) step.details.amountSourceKey = replacements.get(step.details.amountSourceKey).logicalKey;
    step.blockers = step.blockers.map(row => replacements.has(row.key) ? { ...row, kind: 'prior_record', key: replacements.get(row.key).logicalKey } : row);
    step.detailsHash = hash({ calendarFingerprint: step.calendarFingerprint, details: step.details });
  }
  prepared.earlierRequirements = prepared.earlierRequirements.filter(row => !replacements.has(row.logicalKey));
  const needed = new Set(prepared.steps.flatMap(step => step.dependencies.map(link => link.logicalKey)));
  for (const source of replacements.values()) if (needed.has(source.logicalKey) && !prepared.earlierRequirements.some(row => row.logicalKey === source.logicalKey)) prepared.earlierRequirements.push({ logicalKey: source.logicalKey, entity: 'Bill', txnDate: source.step.txnDate });
  prepared.receivedOrderReplacements = [...replacements].map(([scheduledKey, row]) => ({ scheduledKey, logicalKey: row.logicalKey, qboId: row.qboId }));
  prepared.limitations = [...(prepared.limitations || []), 'Stock already received early uses its saved receiving bill for later scheduled sales and supplier payments; the scheduled bill is not created again.'];
  return prepared;
}
module.exports = { assertReceiptSaleCosts, replaceReceivedOrderBills };
