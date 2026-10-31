'use strict';
// Reconstruct general stock from the exact saved batch and native gate receipt.
// Used in priorActivityRows so the existing immutable period proof owns the carry.
const { hash, canonical } = require('./business-calendar');
function fail(message) { throw Object.assign(Error(message), { status: 409, code: 'BUSINESS_STOCK_COST_UNVERIFIED' }); }
const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
async function acceptedGeneralItem(models, scope, run, ref, session) {
  const item = run.items?.[ref], op = run.plan?.operations?.find(row => row.ref === ref);
  const batch = [...(run.batches || [])].reverse().find(row => row.attempt === item?.attempt && row.items.some(row => row.ref === ref));
  const sent = batch?.items.find(row => row.ref === ref), gated = batch?.transport?.items?.find(row => row.ref === ref);
  if (!item || item.op !== 'create' || item.outcome !== 'saved' || op?.op !== 'create' || item.entity !== op.entity || batch?.state !== 'answered' || gated?.outcome !== 'saved' || gated.qboId !== item.qboId || sent?.entity !== item.entity || sent.op !== 'create' || canonical(sent.payload) !== canonical(item.request) || !require('./general-write-recovery').matchesRequest(item.request, item.record)) fail('General stock lost its original saved create and resolved request.');
  const receipt = await read(models.Receipts, { _id: batch.transport.receiptId, ...scope }, session);
  const request = require('./general-write-transport').buildGeneralBatch(scope, batch);
  const native = receipt?.observed?.items?.find(row => row.ref === ref);
  if (receipt?.kind !== 'general-write' || receipt.state !== 'saved' || receipt.general?.runId !== String(run._id) || receipt.general.batchIndex !== batch.index || receipt.general.requestId !== batch.requestId || receipt.requestHash !== request.requestHash || native?.outcome !== 'saved' || native.qboId !== item.qboId || native.mismatch) fail('General stock lost its exact successful native transport receipt.');
  const dispatchKey = hash({ version: 1, kind: 'general-write', runId: String(run._id), batchIndex: batch.index, sends: batch.sends });
  const receiptId = hash({ scope, dispatchKey }), startId = hash({ receiptId, event: 'started' }).slice(0, 24), resultId = hash({ receiptId, event: 'response', observed: receipt.observed }).slice(0, 24);
  if (String(receipt._id) !== receiptId || receipt.dispatchKey !== dispatchKey || String(receipt.ownerId) !== String(run.ownerId) || String(receipt.actorId) !== String(run.actorId) || receipt.startAuditId !== startId || receipt.resultAuditId !== resultId || receipt.periodProof?.kind !== 'general-period-proof' || receipt.periodProof.runId !== String(run._id) || receipt.periodProof.batchIndex !== batch.index) fail('General stock transport authority or audit identity changed.');
  const params = { environment: scope.environment, connectionId: scope.connectionId, dispatchKey, requestHash: request.requestHash, entity: 'batch', operation: 'create' };
  for (const [id, action, outcome, afterState] of [[startId,'QuickBooks write dispatch recorded','partial',{state:'possibly-sent',receiptId}],[resultId,'QuickBooks write response recorded','success',{state:'saved',receiptId,...receipt.observed}]]) {
    const audit = await read(models.Audits, { _id: id, userId: run.ownerId, realmId: scope.realmId }, session);
    if (!audit || String(audit.actorUserId || audit.userId) !== String(run.actorId) || audit.action !== action || audit.actionType !== 'manual' || audit.outcome !== outcome || canonical(audit.inputParams) !== canonical(params) || canonical(audit.afterState) !== canonical(afterState)) fail('General stock lost its original native transport audit.');
  }
  const raw = batch.transport.response?.find(row => String(row.bId) === String(sent.bId));
  const { bId, ...body } = raw || {};
  if (require('node:crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex') !== native.responseHash || native.syncToken !== item.record.SyncToken) fail('General stock response content differs from its native receipt.');
  const response = batch.transport.response?.find(row => String(row.bId) === String(sent.bId))?.[item.entity];
  if (!response || hash(response) !== hash(item.record)) fail('General stock differs from its original native response.');
  return { item, receipt, request };
}
function sourceFor(scope, run, ref, accepted, lineIndex) {
  const { item, receipt, request } = accepted;
  return { operationId: String(run._id), scopeHash: hash(scope), logicalKey: hash({ runId: String(run._id), ref }), qboId: item.qboId, lineIndex, compilationHash: hash(item.request), requestHash: request.requestHash, receiptHash: hash(receipt.observed), receiptSource: 'general-copy-replay', ...(['Bill','Purchase','CreditMemo','RefundReceipt'].includes(item.entity) ? { entity: item.entity } : {}) };
}
async function readGeneralStockRows(models, active, session) {
  const scope = active.value.scope, day = require('./business-calendar').shift(active.calendar.verifiedThrough, 1);
  const Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun');
  const runs = await Runs.find({ ...scope, contract: 'general-write-v1', day }).sort({ _id: 1 }).limit(101).session(session).maxTimeMS(3000).lean();
  if (runs.length > 100) fail('General stock exceeds its complete-day run budget.');
  const { state } = await require('./business-stock-history').readCommittedStockOpening(models, active, session), rows = [];
  for (const run of runs) for (const [ref, item] of Object.entries(run.items || {})) {
    const relevant = (item.record?.Line || []).some(line => state.items.some(item => item.itemId === line?.[line.DetailType]?.ItemRef?.value));
    if (!relevant || ['Estimate','PurchaseOrder'].includes(item.entity)) continue;
    const accepted = await acceptedGeneralItem(models, scope, run, ref, session);
    rows.push(...require('./business-stock-general').stockLines(item.entity, item.record, state, index => sourceFor(scope, run, ref, accepted, index)));
  }
  return rows;
}
async function generalPurchaseOrigin(models, state, qboId, lots, session) {
  const first = lots[0].source, Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun');
  const run = await read(Runs, { _id: first.operationId, ...state.scope, contract: 'general-write-v1' }, session);
  const ref = Object.keys(run?.items || {}).find(ref => hash({ runId: String(run._id), ref }) === first.logicalKey);
  if (!ref) fail('The carried general stock origin is unavailable.');
  const accepted = await acceptedGeneralItem(models, state.scope, run, ref, session);
  const rows = require('./business-stock-general').stockLines(accepted.item.entity, accepted.item.record, state, index => sourceFor(state.scope, run, ref, accepted, index));
  for (const lot of lots) {
    const row = rows.find(row => row.source.lineIndex === lot.source.lineIndex);
    if (!row || canonical(row.source) !== canonical(lot.source) || row.quantity !== lot.originalQuantity || row.txnDate !== lot.txnDate || row.unitCostCents !== lot.unitCostCents) fail('A carried general stock layer changed its original cost or quantity.');
  }
  return { qboId: (first.entity && first.entity !== 'Bill' ? first.entity + ':' : '') + qboId, entity: first.entity || 'Bill', source: first, payload: accepted.item.record, nativeTax: accepted.item.record.TxnTaxDetail || null };
}
module.exports = { acceptedGeneralItem, sourceFor, readGeneralStockRows, generalPurchaseOrigin };
