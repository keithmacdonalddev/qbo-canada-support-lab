'use strict';
const { hash } = require('./business-calendar');
const { assertRun, assertRunApproval } = require('./business-period-store');
// Fixed activity still proves whole-account movement, so posting work shares its
// ledger proof resource. New independent lists/quotes have no ledger or existing-
// record effect. Allow those alongside the fixed operation without changing its
// scalar barrier or observation revision. Closes, history and unknown owners stay
// exclusive. This is an adapter for the retained fixed-workflow proof contract.
async function allowsFixedWriter({ writer, scope, batch, Runs, Plans, session, now }) {
  if (!writer.operationId || !writer.planHash || writer.populationDelegation || writer.workflowKind || !Runs || !Plans) return false;
  const read = (Model, filter) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  const run = await read(Runs, { _id: writer.operationId, ...scope, planHash: writer.planHash });
  if (!run?.activityBatch || run.activityBatch.day !== require('./business-activity-preview').businessDate(new Date(now)) || !['reserved','running','blocked','awaiting-evidence'].includes(run.status)) return false;
  assertRun(run, scope); assertRunApproval(run);
  const plan = await read(Plans, { _id: run.planId, ...scope, operationId: run._id, planHash: run.planHash });
  if (!plan?.manifest || hash(plan.manifest) !== run.planHash || !Array.isArray(plan.manifest.records) || plan.manifest.records.length !== run.recordCount || hash(plan.manifest.activityBatch || null) !== hash(run.activityBatch)) return false;
  if (!batch.items?.length || batch.dirtyDates?.length) return false;
  if (writer.unresolved && !writer.unresolved.entity) return false;
  return batch.items.every(item => {
    if (item.operation !== 'create' || item.id || item.before || item.payload?.Id || !['Customer','Vendor','Employee','Estimate'].includes(item.entity)) return false;
    // Fixed list creation may have the same native name; no parallel name guess.
    if (writer.unresolved && String(writer.unresolved.entity).toLowerCase() === item.entity.toLowerCase()) return false;
    if (item.entity !== 'Estimate' && plan.manifest.records.some(row => row.kind === 'create' && ['Customer','Vendor','Employee'].includes(row.entity))) return false;
    const linked = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) => key === 'LinkedTxn' || linked(child));
    return !linked(item.payload);
  });
}
module.exports = { allowsFixedWriter };
