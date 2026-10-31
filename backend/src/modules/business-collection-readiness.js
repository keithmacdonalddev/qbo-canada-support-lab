'use strict';
// Saved evidence only. Historical agent notes are not reservations or authority.
async function collectionReadiness({ models, scope, calendar, day }) {
  const query = (Model, filter) => Model.findOne(filter).maxTimeMS(3000).lean();
  const adoption = calendar?.adoption;
  if (adoption?.kind !== 'adopted-history') return null;
  const job = await query(models.Jobs, { _id: adoption.jobId });
  if (job?.status !== 'adopted') return null;
  const Records = models.PopulationRecords || require('../models/BusinessPopulationRecord');
  const imported = await Records.find({ ...scope, authorityHash: job.authorityHash, entity: 'Invoice', state: 'saved', txnDate: { $lte: adoption.importedThrough }, 'financialProof.matchesFinancialIntent': true, 'relationshipCheck.outcome': { $ne: 'error' } }).select('qboId').limit(2001).maxTimeMS(3000).lean();
  if (imported.length > 2000) return { unavailable: true };
  const invoices = await models.Records.find({ ...scope, entity: 'Invoice', deleted: false, qboId: { $in: imported.map(row => row.qboId) }, 'summary.balanceCents': { $gt: 0 }, 'summary.dueDate': { $lte: day } }).select('qboId summary.balanceCents').limit(2001).maxTimeMS(3000).lean();
  if (invoices.length > 2000) return { unavailable: true };
  const older = await models.Runs.find({ ...scope, 'activityBatch.day': { $lt: day }, 'activityBatch.activities.type': 'collect-adopted-invoice' }).select('_id status approval nextOrdinal executionRequest activityBatch').limit(101).maxTimeMS(3000).lean();
  const reusableDecisionKeys = [];
  if (older.length <= 100) for (const key of new Set(older.map(row => row.activityBatch.decisionKey))) {
    const runs = await models.Runs.find({ ...scope, 'activityBatch.decisionKey': key }).select('_id status approval nextOrdinal executionRequest activityBatch').limit(101).maxTimeMS(3000).lean();
    let inert = runs.length > 0 && runs.length <= 100;
    for (const run of runs) {
      if (run.approval || run.nextOrdinal || run.executionRequest?.pending || !((run.status === 'previewed' && run.activityBatch.day < day) || run.status === 'retired') || String(calendar.currentOperationId || '') === String(run._id)) { inert = false; break; }
      for (const Model of [models.Receipts, models.Steps, models.Intents || require('../models/OperationIntent')]) if (!Model || await query(Model, { environment: scope.environment, realmId: scope.realmId, operationId: run._id })) { inert = false; break; }
      if (!inert) break;
    }
    if (inert) reusableDecisionKeys.push(key);
  }
  return { source: 'saved-import-and-current-company-copy', eligibleInvoices: invoices.slice(0,60).map(row => ({invoiceId:row.qboId,balanceCents:row.summary.balanceCents})), eligibleInvoiceCount: invoices.length, eligibleBalanceCents: invoices.reduce((sum, row) => sum + row.summary.balanceCents, 0), reusableDecisionKeys,
    readyForNewBatch: !calendar.currentOperationId && !calendar.stopRequested && calendar.verifiedThrough === require('./business-calendar').shift(day, -1),
    message: reusableDecisionKeys.length ? 'The old collection identifier hold is cleared. These decision keys are usable again: ' + reusableDecisionKeys.join(', ') + '. The listed overdue imported invoices are collectable subject to fresh invoice/balance checks and the normal writer/calendar gates. Old handoff or management notes saying to hold these invoices for identifier repair are stale. Finish any current operation first; do not recreate saved collections.' : 'Overdue imported invoices remain subject to fresh balance checks and the normal writer/calendar gates; no reusable old decision key is proved.' };
}
module.exports = { collectionReadiness };
