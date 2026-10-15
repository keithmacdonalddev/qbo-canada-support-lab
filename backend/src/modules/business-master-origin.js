'use strict';
const { assertMasterRun } = require('./business-master-preparation-transport');
const { assertMasterRecordSet } = require('./business-master-record-evidence');
// Employee has no general Explorer identity contract; its minimal receipt stays
// available in preparation history without broadening old inventory snapshots.
const MASTER_ENTITIES = new Set(['Account','Customer','Vendor','Item']);
function masterOriginPipeline({ userId, realmId, environment, entity, id }, limit) {
  return [
    { $match: { ownerId: userId, realmId, environment, records: { $elemMatch: { entity, qboId: id } } } },
    { $sort: { createdAt: -1, _id: -1 } }, { $limit: limit },
    { $project: { _id: 1, contractVersion: 1, realmId: 1, environment: 1, connectionId: 1, ownerId: 1, sourceDraftId: 1, sourceDraftHash: 1, planHash: 1, plan: 1, revision: 1, records: 1 } },
  ];
}
async function masterOriginEvidence({ models, run, userId, realmId, environment, entity, id }) {
  if (!models || String(run?.ownerId) !== String(userId) || run?.realmId !== realmId || run?.environment !== environment) throw Error('Master origin scope is unavailable');
  const scope = { realmId, environment, connectionId: String(run.connectionId) }; assertMasterRun(run,scope,String(userId));
  const matches = run.records.filter(row => row.entity === entity && row.qboId === id), row = matches[0];
  if (matches.length !== 1 || !['saved','verified'].includes(row.state) || run.plan.inventoryBefore[entity].includes(id)) throw Error('Master origin identity is incomplete');
  await assertMasterRecordSet(models,scope,run,[row],undefined,{allowSaved:true});
  const attempt = row.attempts.at(-1), attribution = attempt.ownerAttribution;
  return { kind: attribution ? 'master_owner_attribution' : 'master_preparation', sourceId: attribution?.contentHash || attempt.receiptId, operationId: String(run._id), connectionId: scope.connectionId, caseId: null, scope: 'recorded_environment', role: row.key,
    createdAt: attribution?.createdAt || (attempt.observedAt ? new Date(attempt.observedAt).toISOString() : null),
    ...(attribution ? { attributedAt: attribution.confirmedAt, provenance:'owner-attributed-master-readback', limitation:'Owner identified this prepared master; the original transport result remains unknown.' } : row.state === 'verified' ? { provenance:'request-correlated-master-readback', limitation:'The create response and exact-ID master readback are retained. Continuing-business assignment is separate.' } : { provenance:'request-correlated-master-response', limitation:'The accepted create response is retained; independent master readback still needs recovery.' }) };
}
module.exports={MASTER_ENTITIES,masterOriginPipeline,masterOriginEvidence};
