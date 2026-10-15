'use strict';
const { canonical } = require('./business-calendar');
const { denied } = require('./qbo-write-contract');
const { assertMasterReceiptAudits } = require('./business-master-receipt');
const { assertMasterAttribution } = require('./business-master-attribution');
const same = (a, b) => String(a) === String(b);
async function assertMasterRecordEvidence(models, scope, run, row, session, { allowSaved = false } = {}) {
  const attempt = row?.attempts.at(-1);
  if (!attempt || !(allowSaved ? ['saved','verified'] : ['verified']).includes(row.state) || !row.qboId) throw denied('The exact verified master identity is required.');
  const receipt = await models.Receipts.findOne({ _id: attempt.receiptId, ...scope }).session(session).maxTimeMS(3000).lean();
  if (!receipt || receipt.kind !== 'master-preparation' || !same(receipt.ownerId, run.ownerId) || !same(receipt.actorId, run.ownerId) || !same(receipt.operationId, run._id) || receipt.entity !== row.entity.toLowerCase() || receipt.operation !== 'create' || receipt.dispatchKey !== attempt.dispatchKey || receipt.requestHash !== attempt.requestHash || receipt.workflow?.kind !== 'master-preparation' || receipt.workflow.runId !== String(run._id) || receipt.workflow.ordinal !== row.ordinal || receipt.workflow.attempt !== attempt.number || receipt.workflow.leaseToken !== attempt.leaseToken) throw denied('The verified master record lost its exact transport identity.');
  if (attempt.outcome?.outcome === 'unknown' || receipt.state === 'unknown' || attempt.ownerAttribution || receipt.ownerRecovery) {
    if (row.state !== 'verified' || !attempt.ownerAttribution) throw denied('The unknown master result requires its retained owner attribution.');
    return assertMasterAttribution(models, scope, run, row, session);
  }
  if (receipt.state !== 'saved' || attempt.outcome?.outcome !== 'saved' || canonical(receipt.observed) !== canonical(attempt.outcome) || receipt.observed?.qboId !== row.qboId || attempt.qboId !== row.qboId || receipt.observed.syncToken !== attempt.syncToken) throw denied('A confirmed master identity requires its actual saved transport result.');
  await assertMasterReceiptAudits(models, receipt, session);
  return { source: row.state === 'verified' ? 'request-correlated-master-readback' : 'request-correlated-master-response', qboId: row.qboId };
}
// Read two bounded snapshots inside the caller transaction instead of making
// hundreds of serial database round trips for a 100-record completion decision.
function snapshotModel(rows) {
  const byId = new Map(rows.map(row => [String(row._id), row]));
  return { findOne(filter) {
    const row = byId.get(String(filter._id)), at = key => key.split('.').reduce((value, part) => value?.[part], row);
    const equal = (a, b) => a?._bsontype === 'ObjectId' || b?._bsontype === 'ObjectId' ? same(a, b) : a === b;
    const found = row && Object.entries(filter).every(([key, value]) => equal(at(key), value));
    return { session() { return this; }, maxTimeMS() { return this; }, lean: async () => found ? row : null };
  } };
}
async function loadMasterRecordSnapshot(models, scope, run, rows, session) {
  if (!Array.isArray(rows) || rows.length > 100) throw denied('Master verification exceeds its record budget.');
  const ids = rows.map(row => row.attempts.at(-1)?.receiptId);
  if (ids.some(id => !/^[a-f0-9]{64}$/.test(id || '')) || new Set(ids).size !== ids.length) throw denied('Unique mandatory master receipts are required.');
  if (!rows.length) return { models: { Receipts: snapshotModel([]), Audits: snapshotModel([]) }, receipts: [] };
  // Include every same-run receipt so a second workflow identity cannot hide
  // behind the acknowledged receipt ID. Legal history is bounded at 100 x 10.
  const receipts = await models.Receipts.find({ environment: scope.environment, realmId: scope.realmId, $or: [{ _id: { $in: ids } }, { 'workflow.kind': 'master-preparation', 'workflow.runId': String(run._id) }] }).limit(1001).session(session).maxTimeMS(3000).lean();
  if (receipts.length > 1000) throw denied('Master transport history exceeds its approved attempt budget.');
  const current = receipts.filter(row => ids.includes(String(row._id)));
  const auditIds = [...new Set([...current.flatMap(row => [row.startAuditId, row.resultAuditId, row.terminal?.auditId]), ...rows.map(row => row.attempts.at(-1)?.ownerAttribution?.auditId)].filter(Boolean).map(String))];
  const audits = await models.Audits.find({ _id: { $in: auditIds }, realmId: scope.realmId }).limit(auditIds.length + 1).session(session).maxTimeMS(3000).lean();
  return { models: { Receipts: snapshotModel(receipts), Audits: snapshotModel(audits) }, receipts };
}
function matchingMasterReceipts(snapshot, run, row) {
  const attempt = row.attempts.at(-1);
  return snapshot.receipts.filter(receipt => receipt.dispatchKey === attempt.dispatchKey || (receipt.workflow?.kind === 'master-preparation' && receipt.workflow.runId === String(run._id) && receipt.workflow.ordinal === row.ordinal && receipt.workflow.attempt === attempt.number));
}
async function assertMasterRecordSet(models, scope, run, rows, session, options) {
  const snapshot = await loadMasterRecordSnapshot(models, scope, run, rows, session);
  for (const row of rows) {
    if (matchingMasterReceipts(snapshot, run, row).length !== 1) throw denied('The verified master ordinal has multiple or missing mandatory receipts.');
    await assertMasterRecordEvidence(snapshot.models, scope, run, row, session, options);
  }
}
module.exports = { assertMasterRecordEvidence, assertMasterRecordSet, loadMasterRecordSnapshot, matchingMasterReceipts };
