'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { SUPPORTED } = require('./business-transaction-compiler');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/, QBO_ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_RECEIPT_UNVERIFIED' }); }
const same = (a, b) => String(a) === String(b);
function businessTransportEvidence(input, row) {
  const scope = scoped(input), operationId = String(input.operationId || ''), logicalKey = input.logicalKey, dispatch = input.dispatch;
  if (!ID.test(operationId) || !HASH.test(logicalKey || '') || !SUPPORTED.has(input.entity) || !dispatch || !HASH.test(dispatch.key || '') || !HASH.test(dispatch.requestHash || '') || !ID.test(dispatch.actorId || '')) fail('Exact original dispatch evidence is required.');
  const receiptId = hash({ scope, dispatchKey: dispatch.key });
  if (row.contractVersion !== 1 || row._id !== receiptId || !same(row.connectionId, scope.connectionId) || row.realmId !== scope.realmId || row.environment !== scope.environment || !same(row.operationId, operationId) || row.logicalKey !== logicalKey || row.kind !== 'business' || row.operation !== 'create' || row.entity !== input.entity.toLowerCase() || row.dispatchKey !== dispatch.key || row.requestHash !== dispatch.requestHash || !same(row.actorId, dispatch.actorId) || !ID.test(String(row.ownerId || ''))) fail('Transport receipt does not match the original company request.');
  if (row.state !== 'saved') return null;
  const observed = row.observed;
  if (!observed || observed.outcome !== 'saved' || observed.operation !== 'create' || observed.entity !== row.entity || !Number.isInteger(observed.httpStatus) || observed.httpStatus < 200 || observed.httpStatus > 299 || !HASH.test(observed.responseHash || '') || typeof observed.qboId !== 'string' || !QBO_ID.test(observed.qboId) || typeof observed.syncToken !== 'string' || !VERSION.test(observed.syncToken)) fail('Transport response does not prove an exact saved record.');
  const startAuditId = hash({ receiptId, event: 'started' }).slice(0, 24), resultAuditId = hash({ receiptId, event: 'response', observed }).slice(0, 24);
  if (!same(row.startAuditId, startAuditId) || !same(row.resultAuditId, resultAuditId)) fail('Transport receipt audit identity changed.');
  const params = { environment: scope.environment, connectionId: scope.connectionId, dispatchKey: dispatch.key, requestHash: dispatch.requestHash, entity: row.entity, operation: 'create' };

  const audits = [
    { id: startAuditId, action: 'QuickBooks write dispatch recorded', outcome: 'partial', afterState: { state: 'possibly-sent', receiptId } },
    { id: resultAuditId, action: 'QuickBooks write response recorded', outcome: 'success', afterState: { state: 'saved', receiptId, ...observed } },
  ];
  const result = { status: 'found', replayAllowed: false, receipt: { version: 1, scope, entity: input.entity, logicalKey, dispatchKey: dispatch.key, requestHash: dispatch.requestHash, qboId: observed.qboId, syncToken: observed.syncToken, source: 'request-correlated-readback', evidenceHash: hash({ version: 1, kind: 'business-transport-receipt', scope, operationId, logicalKey, receiptId, dispatchKey: dispatch.key, requestHash: dispatch.requestHash, observed, startAuditId, resultAuditId }) } };
  return { scope, params, audits, result };
}
function assertBusinessTransportAudits(row, evidence, audits) {
  if (!Array.isArray(audits) || audits.length !== 2) fail('The original transport audit is unavailable or changed.');
  for (const expected of evidence.audits) {
    const matches = audits.filter(audit => same(audit?._id, expected.id));
    const audit = matches[0];
    if (matches.length !== 1 || audit.realmId !== evidence.scope.realmId || !same(audit.userId, row.ownerId) || !same(audit.actorUserId || audit.userId, row.actorId) || audit.action !== expected.action || audit.actionType !== 'manual' || audit.outcome !== expected.outcome || canonical(audit.inputParams) !== canonical(evidence.params) || canonical(audit.afterState) !== canonical(expected.afterState)) fail('The original transport audit is unavailable or changed.');
  }
}
function createBusinessDispatchReceiptReader({ Receipts, Audits, transaction, authorize, assertReady }) {
  if (!Receipts || !Audits || [transaction, authorize, assertReady].some(fn => typeof fn !== 'function')) throw new TypeError('Receipt recovery needs explicit trusted storage and authority');
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  // Compatible with the step store's loadRecovery adapter. This reads the exact
  // persisted transport outcome; it does not assert current QBO content matches intent.
  return async function loadRecovery(input) {
    const scope = scoped(input), operationId = String(input.operationId || ''), logicalKey = input.logicalKey, dispatch = input.dispatch;
    if (!ID.test(operationId) || !HASH.test(logicalKey || '') || !SUPPORTED.has(input.entity) || !['dispatched', 'unknown'].includes(input.state) || !dispatch || !HASH.test(dispatch.key || '') || !HASH.test(dispatch.requestHash || '') || !ID.test(dispatch.actorId || '')) fail('Exact original dispatch evidence is required.');
    await assertReady(scope);
    const actor = await authorize(scope, 'operations.recover'); if (!ID.test(actor?.actorId || '')) fail('Company recovery permission is required.');
    const receiptId = hash({ scope, dispatchKey: dispatch.key });
    return transaction(async session => {
      const current = await authorize(scope, 'operations.recover'); if (current?.actorId !== actor.actorId) fail('The recovery actor changed.');
      const row = await read(Receipts, { _id: receiptId, ...scope, operationId, logicalKey, kind: 'business', operation: 'create', dispatchKey: dispatch.key, requestHash: dispatch.requestHash }, session);
      if (!row) return { status: 'unresolved', replayAllowed: false };
      const evidence = businessTransportEvidence(input, row);
      if (!evidence) return { status: 'unresolved', replayAllowed: false };
      const audits = [];
      for (const expected of evidence.audits) audits.push(await read(Audits, { _id: expected.id, realmId: scope.realmId }, session));
      assertBusinessTransportAudits(row, evidence, audits);
      const last = await authorize(scope, 'operations.recover'); if (last?.actorId !== actor.actorId) fail('The recovery actor changed.');
      return evidence.result;
    });
  };
}
module.exports = { createBusinessDispatchReceiptReader, businessTransportEvidence, assertBusinessTransportAudits };
