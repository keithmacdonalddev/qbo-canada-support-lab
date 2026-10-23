'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const ID = /^[a-f0-9]{24}$/;
const FIELDS = new Set(['environment', 'realmId', 'connectionId', 'actorId', 'operationId', 'planHash', 'phase', 'nextOrdinal', 'logicalKey', 'revision', 'dispatchKey', 'qboId', 'action', 'evidenceHash', 'sourceHash', 'evidenceRevision', 'recordCount', 'throughDate', 'reportEvidenceHash', 'reportSourceHash', 'decisionSource', 'agentId', 'agentGrantId', 'agentAuthorityHash']);
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_AUDIT_UNAVAILABLE' }); }
function createBusinessAuditWriter({ scope, actorId, ownerId, Audits, transaction, access }) {
  scope = scoped(scope);
  if (!ID.test(actorId || '') || !ID.test(ownerId || '') || !Audits || typeof transaction !== 'function' || typeof access?.authorize !== 'function') throw new TypeError('Business audit needs exact authority and storage');
  return async function writeAudit(eventKey, details, session) {
    if (typeof eventKey !== 'string' || !/^business-(plan|step|run|period|period-evidence):[a-zA-Z0-9:-]{1,220}$/.test(eventKey) || !details || Object.keys(details).some(key => !FIELDS.has(key)) || Object.values(details).some(value => value !== null && !['string', 'number'].includes(typeof value)) || !ID.test(details.operationId || '') || !ID.test(details.actorId || '') || ['realmId', 'environment', 'connectionId'].some(key => details[key] !== scope[key])) fail('Audit needs bounded scoped operation metadata.');
    if (['reportEvidenceHash', 'reportSourceHash'].some(key => details[key] !== undefined && !/^[a-f0-9]{64}$/.test(details[key])) || (details.reportEvidenceHash === undefined) !== (details.reportSourceHash === undefined)) fail('Approval report hashes must be complete and exact.');
    const retained = JSON.parse(canonical(details)); if (Buffer.byteLength(canonical(retained)) > 10000) fail('Audit metadata exceeds its budget.');
    const id = hash({ scope, actorId, ownerId, eventKey }).slice(0, 24), params = { eventKey, ...scope, details: retained };
    const actionType = retained.decisionSource === 'agent-standing-authority' ? 'ai_plan' : 'manual';
    const save = async currentSession => {
      if (!currentSession?.inTransaction?.()) fail('Operation audit requires a transaction.');
      const stopRequest = eventKey === 'business-period:' + details.operationId + ':stop-request' && details.action === 'Business period stop requested';
      const settledStop = eventKey.startsWith('business-run:' + details.operationId + ':') && /^business-run:[a-f0-9]{24}:[0-9]+$/.test(eventKey) && details.phase === 'stop-settled';
      const completionRepair = eventKey === 'business-period:' + details.operationId + ':committed' && details.action === 'Business period verified' && /^[a-f0-9]{64}$/.test(details.evidenceHash || '');
      const action = completionRepair ? 'operations.recover' : stopRequest || settledStop ? 'operations.stop' : details.phase === 'prepared' && eventKey.startsWith('business-plan:') ? 'operations.preview' : 'operations.record';
      const actor = await access.authorize(scope, action, { session: currentSession });
      if (actor?.actorId !== actorId || actor?.ownerId !== ownerId) fail('The operation audit actor changed.');
      const row = await Audits.findOne({ _id: id }).session(currentSession).maxTimeMS(3000).lean();
      if (row) {
        if (String(row.userId) !== ownerId || String(row.actorUserId || row.userId) !== actorId || row.realmId !== scope.realmId || row.action !== 'Business operation evidence recorded' || row.actionType !== actionType || row.outcome !== 'success' || canonical(row.inputParams) !== canonical(params)) fail('The saved audit event differs from this operation.');
      } else await Audits.create([{ _id: id, userId: ownerId, ...(actorId !== ownerId ? { actorUserId: actorId } : {}), realmId: scope.realmId, action: 'Business operation evidence recorded', actionType, outcome: 'success', inputParams: params }], { session: currentSession });
      return { id, eventKey };
    };
    return session ? save(session) : transaction(save);
  };
}
module.exports = { createBusinessAuditWriter };
