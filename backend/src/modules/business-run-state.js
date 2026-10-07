'use strict';
const { randomUUID } = require('node:crypto');
const { hash } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { assertRun, assertRunApproval } = require('./business-period-store');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_RUN_CHANGED' }); }
const same = (a, b) => String(a) === String(b);
const revision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const exact = value => value === undefined ? { $exists: false } : value;
function createBusinessRunState({ Runs, Calendars, Writers, Plans, Steps, transaction, authorize, assertReady, writeAudit, now = () => Date.now(), token = randomUUID }) {
  if ([Runs, Calendars, Writers, Plans, Steps].some(value => !value) || [transaction, authorize, assertReady, writeAudit, now, token].some(value => typeof value !== 'function')) throw new TypeError('Run state requires concrete scoped stores and authority');
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function state(scope, operationId, session) {
    const run = await read(Runs, { _id: operationId, ...scope }, session); assertRun(run, scope);
    if (!revision(run.executionRevision ?? 0) || !Number.isSafeInteger(run.nextOrdinal ?? 0) || (run.nextOrdinal ?? 0) < 0 || (run.nextOrdinal ?? 0) > run.recordCount) fail('Operation progress is invalid.');
    const calendar = await read(Calendars, { _id: scope.environment + ':' + scope.realmId, ...scope }, session);
    const writer = await read(Writers, { _id: scope.environment + ':' + scope.realmId, ...scope }, session);
    return { run, calendar, writer };
  }
  function owned(value) {
    const { run, calendar, writer } = value;
    assertRunApproval(run);
    if (!calendar || calendar.contractVersion !== 1 || !same(calendar.currentOperationId, run._id) || calendar.businessKey !== run.businessKey || !same(calendar.blueprintId, run.blueprintId) || calendar.blueprintHash !== run.blueprintHash || calendar.baseline?.status !== 'verified' || calendar.baseline.evidenceHash !== run.baselineHash || calendar.verifiedThrough !== run.expectedCursor || calendar.revision !== run.expectedRevision || calendar.pendingCommit !== null || !writer || writer.contractVersion !== 1 || !same(writer.operationId, run._id) || writer.planHash !== run.planHash || !revision(writer.revision)) fail('The operation no longer owns the exact company calendar and writer.');
  }
  function handle(value, leaseToken) {
    const { run } = value; owned(value);
    if (run.leaseToken !== leaseToken || !leaseToken || !Number.isFinite(new Date(run.leaseExpiresAt).getTime()) || new Date(run.leaseExpiresAt).getTime() <= now()) fail('The operation worker lease changed or expired.');
  }
  const view = ({ run, calendar, writer }) => ({ operationId: String(run._id), planHash: run.planHash, status: run.status, recordCount: run.recordCount, nextOrdinal: run.nextOrdinal ?? 0, executionRevision: run.executionRevision ?? 0, leaseToken: run.leaseToken || null, leaseExpiresAt: run.leaseExpiresAt || null,
    fromDate: run.fromDate, throughDate: run.throughDate, stopRequested: calendar?.stopRequested === true, unresolved: writer?.unresolved || null,
    completion: run.status === 'verified' && HASH.test(run.verification?.evidenceHash || '') && HASH.test(run.verification?.recordSetHash || '') && run.verification?.planHash === run.planHash && run.verification?.blueprintHash === run.blueprintHash && same(run.verification?.operationId, run._id) && run.verification?.completionAuditId && calendar?.businessKey === run.businessKey && calendar?.verifiedThrough >= run.throughDate && calendar?.revision >= run.expectedRevision + 1 && !same(calendar?.pendingCommit?.operationId, run._id) && !same(calendar?.currentOperationId, run._id) && !same(writer?.operationId, run._id) ? { evidenceHash: run.verification.evidenceHash, throughDate: run.throughDate } : null });
  async function perform(scope, operationId, action, work) {
    scope = scoped(scope); if (!ID.test(operationId || '')) fail('An exact operation ID is required.');
    await assertReady(scope); const actor = await authorize(scope, action);
    if (!ID.test(actor?.actorId || '')) fail('Current operation authority is required.');
    return transaction(async session => {
      const current = await authorize(scope, action, { session }); if (current?.actorId !== actor.actorId) fail('The operation actor changed.');
      const value = await state(scope, operationId, session);
      return work(value, scope, actor.actorId, session);
    });
  }
  async function change(value, scope, actorId, session, phase, fields) {
    const run = value.run, next = (run.executionRevision ?? 0) + 1;
    const eventKey = 'business-run:' + run._id + ':' + next;
    const receipt = await writeAudit(eventKey, { ...scope, actorId, operationId: String(run._id), planHash: run.planHash, phase, nextOrdinal: fields.nextOrdinal ?? run.nextOrdinal ?? 0 }, session);
    if (receipt?.eventKey !== eventKey || !receipt.id) fail('The operation progress audit was not saved.');
    const saved = await Runs.findOneAndUpdate({ _id: run._id, ...scope, planHash: run.planHash, status: run.status, executionRevision: exact(run.executionRevision), leaseToken: exact(run.leaseToken) }, { $set: { ...fields, executionRevision: next, lastExecutionAuditId: String(receipt.id) } }, { new: true, session }).lean();
    if (!saved) fail('Another worker changed operation progress.');
    return view({ ...value, run: saved });
  }
  const inspect = (scope, operationId) => perform(scope, operationId, 'operations.read', async value => view(value));
  const claim = (scope, operationId) => perform(scope, operationId, 'operations.execute', async (value, selected, actorId, session) => {
    owned(value); const run = value.run;
    if (!['reserved', 'running', 'blocked', 'awaiting-evidence'].includes(run.status)) fail('This operation cannot acquire a worker.');
    if (run.leaseToken && (!Number.isFinite(new Date(run.leaseExpiresAt).getTime()) || new Date(run.leaseExpiresAt).getTime() > now())) fail('Another worker still holds this operation.');
    const leaseToken = token(); if (typeof leaseToken !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(leaseToken)) fail('Invalid operation lease token.');
    return change(value, selected, actorId, session, 'claim', { leaseToken, leaseExpiresAt: new Date(now() + 600000), nextOrdinal: run.nextOrdinal ?? 0, status: (run.nextOrdinal ?? 0) === run.recordCount ? 'awaiting-evidence' : 'running', lastError: null });
  });
  const renew = (scope, operationId, leaseToken) => perform(scope, operationId, 'operations.execute', async (value, selected, actorId, session) => {
    handle(value, leaseToken); if (!['running', 'awaiting-evidence'].includes(value.run.status)) fail('This worker cannot continue the operation.');
    return change(value, selected, actorId, session, 'renew', { leaseExpiresAt: new Date(now() + 600000) });
  });
  const advance = (scope, operationId, leaseToken, ordinal, logicalKey) => perform(scope, operationId, 'operations.execute', async (value, selected, actorId, session) => {
    handle(value, leaseToken); const run = value.run;
    if (run.status !== 'running' || value.calendar.stopRequested || value.writer.unresolved !== null || ordinal !== (run.nextOrdinal ?? 0) || ordinal >= run.recordCount || !HASH.test(logicalKey || '')) fail('The next operation activity changed or is stopped.');
    const plan = await read(Plans, { _id: run.planId, ...selected, operationId: run._id, planHash: run.planHash }, session);
    const expected = plan?.manifest?.records?.[ordinal];
    if (!plan || hash(plan.manifest) !== run.planHash || plan.manifest.recordCount !== run.recordCount || expected?.logicalKey !== logicalKey) fail('The ordered saved plan changed.');
    const row = await read(Steps, { ...selected, logicalKey }, session), stamp = Date.parse(row?.verification?.observedAt);
    if (!row || row.state !== 'verified' || row.entity !== expected.entity || row.fingerprint !== expected.fingerprint || !row.receipt || !row.qboId || !row.lastAuditId || !HASH.test(row.verification?.graphEvidenceHash || '') || !Number.isFinite(stamp) || stamp > now() || now() - stamp > 300000) fail('The activity lacks current saved graph proof.');
    handle(value, leaseToken);
    return change(value, selected, actorId, session, 'advance', { nextOrdinal: ordinal + 1, status: ordinal + 1 === run.recordCount ? 'awaiting-evidence' : 'running', leaseExpiresAt: new Date(now() + 600000) });
  });
  const release = (scope, operationId, leaseToken, reason = 'yield') => perform(scope, operationId, 'operations.execute', async (value, selected, actorId, session) => {
    handle(value, leaseToken);
    if (!['yield', 'blocked', 'stopped'].includes(reason)) fail('Unsupported worker release reason.');
    if (reason === 'stopped' && (!value.calendar.stopRequested || value.writer.unresolved !== null)) fail('A stopped operation must settle its outstanding request first.');
    return change(value, selected, actorId, session, 'release-' + reason, { leaseToken: null, leaseExpiresAt: null, status: reason === 'stopped' ? 'stopped' : reason === 'blocked' ? 'blocked' : value.run.status, lastError: reason === 'blocked' ? 'Operation requires recovery or fresh verification.' : null });
  });
  return { inspect, claim, renew, advance, release };
}
module.exports = { createBusinessRunState };
