'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const ID = /^[a-f0-9]{24}$/;
const FIELDS = new Set(['environment', 'realmId', 'connectionId', 'actorId', 'operationId', 'planHash', 'phase', 'nextOrdinal', 'logicalKey', 'revision', 'dispatchKey', 'qboId', 'action', 'evidenceHash', 'sourceHash', 'evidenceRevision', 'recordCount', 'throughDate']);
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_AUDIT_UNAVAILABLE' }); }
function createBusinessAuditWriter({ scope, actorId, ownerId, Audits, transaction, access }) {
  scope = scoped(scope);
  if (!ID.test(actorId || '') || !ID.test(ownerId || '') || !Audits || typeof transaction !== 'function' || typeof access?.authorize !== 'function') throw new TypeError('Business audit needs exact authority and storage');
  return async function writeAudit(eventKey, details, session) {
    if (typeof eventKey !== 'string' || !/^business-(plan|step|run|period|period-evidence):[a-zA-Z0-9:-]{1,220}$/.test(eventKey) || !details || Object.keys(details).some(key => !FIELDS.has(key)) || Object.values(details).some(value => value !== null && !['string', 'number'].includes(typeof value)) || !ID.test(details.operationId || '') || !ID.test(details.actorId || '') || ['realmId', 'environment', 'connectionId'].some(key => details[key] !== scope[key])) fail('Audit needs bounded scoped operation metadata.');
    const retained = JSON.parse(canonical(details)); if (Buffer.byteLength(canonical(retained)) > 10000) fail('Audit metadata exceeds its budget.');
    const id = hash({ scope, actorId, ownerId, eventKey }).slice(0, 24), params = { eventKey, ...scope, details: retained };
    const save = async currentSession => {
      if (!currentSession?.inTransaction?.()) fail('Operation audit requires a transaction.');
      const actor = await access.authorize(scope, 'operations.record', { session: currentSession });
      if (actor?.actorId !== actorId || actor?.ownerId !== ownerId) fail('The operation audit actor changed.');
      const row = await Audits.findOne({ _id: id }).session(currentSession).maxTimeMS(3000).lean();
      if (row) {
        if (String(row.userId) !== ownerId || String(row.actorUserId || row.userId) !== actorId || row.realmId !== scope.realmId || row.action !== 'Business operation evidence recorded' || row.actionType !== 'manual' || row.outcome !== 'success' || canonical(row.inputParams) !== canonical(params)) fail('The saved audit event differs from this operation.');
      } else await Audits.create([{ _id: id, userId: ownerId, ...(actorId !== ownerId ? { actorUserId: actorId } : {}), realmId: scope.realmId, action: 'Business operation evidence recorded', actionType: 'manual', outcome: 'success', inputParams: params }], { session: currentSession });
      return { id, eventKey };
    };
    return session ? save(session) : transaction(save);
  };
}
module.exports = { createBusinessAuditWriter };
