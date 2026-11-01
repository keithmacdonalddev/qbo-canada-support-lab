'use strict';
// Only pre-admission work may expire. Receipts and writer barriers always win over
// local state. The run revision conflicts with gate admission in the same transaction.
const { businessDate } = require('./business-activity-preview');
const { hash } = require('./business-calendar');
const company = scope => ({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId });
function unsentBatch(batch) { return batch.state === 'sending' && (batch.sends === undefined || batch.sends === 0) && !batch.transport && !batch.sentAt && !batch.answeredAt; }
function unsentRun(run) {
  return ['prepared', 'sending', 'held', 'needs-correction'].includes(run.status) && !(run.dirty || []).length && !(run.owned || []).length && !Object.keys(run.items || {}).length && (run.batches || []).every(unsentBatch);
}
function refusalReason(run) {
  const detail = run.errorDetail;
  if (detail?.detail?.qboStage !== 'write_admission' || detail.detail.outcomeUnknown !== false) return null;
  if (detail.code === 'GENERAL_WRITE_REPLAN_REQUIRED') return detail.message;
  const key = require('./business-error-detail').fingerprint(detail);
  const repeated = (run.errorHistory || []).find(row => row.count >= 3 && row.key === key);
  return repeated ? 'Retired after ' + repeated.count + ' identical admission refusals: ' + detail.message + ' Nothing was sent. Replan the still-needed work with a new decisionKey.' : null;
}
function createGeneralUnsentRetirement({ models = {}, Runs = models.GeneralWriteRuns, now = () => Date.now(), transaction = models.transaction } = {}) {
  // Isolated callers must supply their offline stores; never fall back to a live
  // connection for an injected fake run store.
  const live = Runs?.modelName === 'GeneralWriteRun';
  const Receipts = models.Receipts || (live ? require('../models/QboWriteReceipt') : null);
  const Writers = models.Writers || (live ? require('../models/CompanyWriter') : null);
  const Audits = models.Audits || (live ? require('../models/AuditLog') : null);
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function provesUnsent(scope, run, batch = null, session) {
    if (!Receipts || !Writers || run.status === 'unknown' || (batch ? !unsentBatch(batch) || batch.items.some(item => run.items?.[item.ref]) : !unsentRun(run))) return false;
    const identity = batch ? { $or: [{ 'general.batchIndex': batch.index }, { 'general.requestId': batch.requestId }] } : {};
    if (await read(Receipts, { ...company(scope), kind: 'general-write', 'general.runId': String(run._id), ...identity }, session)) return false;
    const writer = await read(Writers, company(scope), session);
    if (!writer || String(writer.connectionId) !== String(scope.connectionId)) return false;
    // Reserved claims also fence a request preparing to enter admission.
    const identities = new Set([String(run._id), ...(batch ? [batch.requestId] : (run.batches || []).map(row => row.requestId))]);
    const contains = value => value && typeof value === 'object' ? Object.values(value).some(contains) : identities.has(String(value));
    return !contains(writer.unresolved) && !(writer.resourceClaims || []).some(contains);
  }
  async function retire(scope, run) {
    const today = businessDate(new Date(now()));
    if (!run.day || run.day >= today && !refusalReason(run) || run.caseAuthority || run.retirement?.reason || !unsentRun(run) && !refusalReason(run) || !Audits || !Receipts || !Writers) return run;
    const transact = transaction || (live ? require('./business-transaction').createBusinessTransaction(Runs.db) : null);
    if (!transact) return run;
    return transact(async session => {
      const current = await read(Runs, { _id: run._id, ...company(scope) }, session);
      if (!current || current.status === 'expired-unsent' || current.retirement?.reason || current.day >= today && !refusalReason(current) || current.caseAuthority) return current || run;
      const refusal = refusalReason(current), whole = unsentRun(current);
      const batch = whole ? null : (current.batches || []).find(row => row.state !== 'answered');
      if (!whole && (!refusal || !batch || Object.values(current.items || {}).some(item => !['saved','deleted'].includes(item.outcome)) || current.batches.some(row => row !== batch && row.state !== 'answered'))) return current;
      if (!await provesUnsent(scope, current, batch, session)) return current;
      const status = whole ? 'expired-unsent' : 'needs-correction';
      const reason = whole ? refusal : 'Batch ' + batch.index + ' was not sent. Refusal: ' + current.errorDetail.message + ' Saved records in items remain accepted; do not recreate them. Replan only unsent refs: ' + current.plan.operations.filter(op => !current.items[op.ref]).map(op => op.ref).join(', ') + '.';
      const auditId = hash({ kind: 'general-expired-unsent', runId: String(current._id), revision: current.revision }).slice(0, 24);
      const retirement = { ...(reason ? { reason, errorDetail: current.errorDetail, errorHistory: current.errorHistory } : {}), version: 1, at: new Date(now()).toISOString(), preparedDay: current.day, currentDay: today, auditId, ...(whole ? { noReceipts: true, noDispatch: true } : { batchIndex: batch.index, requestId: batch.requestId, batchNoReceipts: true, batchNoDispatch: true, retainedSavedEffects: true }) };
      const saved = await Runs.findOneAndUpdate({ _id: current._id, ...company(scope), revision: current.revision, status: current.status }, { $set: { status, retirement, lastError: reason || null, errorDetail: reason ? current.errorDetail : null, errorHistory: reason ? current.errorHistory : [], progressAt: new Date(now()) }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!saved) throw Object.assign(new Error('The general write changed during unsent expiry; retry with fresh evidence.'), { code: 'GENERAL_UNSENT_CHANGED', status: 409 });
      await Audits.create([{ _id: auditId, userId: current.ownerId, actorUserId: current.actorId, realmId: scope.realmId, action: reason ? 'Unsent general write retired after admission refusal' : 'Prior-day unsent general write expired', actionType: 'ai_executed', aiDriven: Boolean(current.agentAuthority), outcome: 'skipped', beforeState: { ...company(scope), runId: String(current._id), status: current.status, revision: current.revision, errorDetail: current.errorDetail || null }, afterState: { status, retirement, qboWrites: 0 } }], { session });
      return saved;
    });
  }
  return { retire, provesUnsent };
}
module.exports = { createGeneralUnsentRetirement, unsentRun, unsentBatch };
