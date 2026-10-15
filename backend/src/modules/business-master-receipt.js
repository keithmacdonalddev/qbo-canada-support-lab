'use strict';
const { hash, canonical } = require('./business-calendar');
const { denied, scoped } = require('./qbo-write-contract');
const same = (a, b) => String(a) === String(b);
async function assertMasterReceiptAudits(models, receipt, session) {
  const scope = scoped({ environment: receipt.environment, realmId: receipt.realmId, connectionId: String(receipt.connectionId) }), receiptId = hash({ scope, dispatchKey: receipt.dispatchKey }), observed = receipt.observed;
  if (receipt.contractVersion !== 1 || receipt.kind !== 'master-preparation' || receipt.operation !== 'create' || !same(receipt._id, receiptId) || !['saved', 'rejected', 'unknown'].includes(receipt.state) || observed?.outcome !== receipt.state || observed.entity !== receipt.entity || observed.operation !== 'create') throw denied('The mandatory master transport result is incomplete.');
  const started = new Date(receipt.sentAt).getTime(), ended = new Date(receipt.observedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) throw denied('The master transport observation interval is incomplete.');
  const startId = hash({ receiptId, event: 'started' }).slice(0, 24), resultId = hash({ receiptId, event: 'response', observed }).slice(0, 24);
  if (!same(receipt.startAuditId, startId) || !same(receipt.resultAuditId, resultId)) throw denied('The master transport audit identity changed.');
  const params = { environment: scope.environment, connectionId: scope.connectionId, dispatchKey: receipt.dispatchKey, requestHash: receipt.requestHash, entity: receipt.entity, operation: 'create' };
  for (const expected of [
    { id: startId, action: 'QuickBooks write dispatch recorded', outcome: 'partial', afterState: { state: 'possibly-sent', receiptId } },
    { id: resultId, action: observed.transportFailure === true ? 'QuickBooks write transport failure recorded' : 'QuickBooks write response recorded', outcome: receipt.state === 'saved' ? 'success' : receipt.state === 'rejected' ? 'failure' : 'partial', afterState: { state: receipt.state, receiptId, ...observed } },
  ]) {
    const audit = await models.Audits.findOne({ _id: expected.id, realmId: scope.realmId }).session(session).maxTimeMS(3000).lean();
    if (!audit || !same(audit.userId, receipt.ownerId) || !same(audit.actorUserId || audit.userId, receipt.actorId) || audit.action !== expected.action || audit.actionType !== 'manual' || audit.outcome !== expected.outcome || canonical(audit.inputParams) !== canonical(params) || canonical(audit.afterState) !== canonical(expected.afterState)) throw denied('The original master transport audit is missing or changed.');
  }
  return receipt;
}
function masterProgress(run) {
  return { version: 1, runId: String(run._id), planHash: run.planHash, revision: run.revision, state: run.state, claim: run.claim, leaseTokenHash: hash(run.leaseToken || null), leaseExpiresAt: run.leaseExpiresAt ? new Date(run.leaseExpiresAt).toISOString() : null, stopRequested: run.stopRequested, records: run.records.map(row => ({ ordinal: row.ordinal, entity: row.entity, key: row.key, state: row.state, qboId: row.qboId || null, attempts: row.attempts.map(value => ({ number: value.number, state: value.state, dispatchKey: value.dispatchKey, requestHash: value.requestHash, receiptId: value.receiptId || null, qboId: value.qboId || null, outcomeHash: hash(value.outcome || null) })) })) };
}
const masterProgressHash = run => hash(masterProgress(run));
module.exports = { assertMasterReceiptAudits, masterProgress, masterProgressHash };
