'use strict';
const { hash, canonical } = require('./business-calendar');
const { assertRun, assertRunApproval } = require('./business-period-store');
const ID = /^[a-f0-9]{24}$/i, HASH = /^[a-f0-9]{64}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409 }); }
function validHash(value) { return typeof value === 'string' && HASH.test(value); }
function same(a, b) { return String(a) === String(b); }
function revision(value) { return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER; }
function scopeFilter(scope) {
  if (!scope || typeof scope.realmId !== 'string' || !/^\d{1,30}$/.test(scope.realmId) || !['production', 'sandbox'].includes(scope.environment) || typeof scope.connectionId !== 'string' || !ID.test(scope.connectionId)) fail('An exact company connection is required');
  return { realmId: scope.realmId, environment: scope.environment, connectionId: scope.connectionId };
}
function businessWriterIntegrationStatus() {
  return { ready: false, reason: 'Company-wide writer coordination is not connected to every QBO write path.' };
}
async function assertBusinessWriterIntegration() { const state = businessWriterIntegrationStatus(); if (!state.ready) fail(state.reason); }

// Internal transactional adapter. The step/period stores own permission and audit.
// Production default is CLOSED until the shared QBO transport participates.
function createBusinessWriterFence({ Runs, Calendars, Writers, Steps, assertIntegration = assertBusinessWriterIntegration, now = () => Date.now() }) {
  if (!Runs || !Calendars || !Writers || !Steps || typeof assertIntegration !== 'function') throw new TypeError('Company writer needs explicit stores and integration readiness');
  async function ready(scope, session, phase) {
    scopeFilter(scope);
    if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) fail('Writer fencing requires the caller transaction');
    await assertIntegration({ scope, session, phase });
  }
  async function snapshot(runLike, scope, session, afterCommit = false, phase = null) {
    await ready(scope, session, phase);
    const id = String(runLike.operationId || runLike._id || '');
    if (!ID.test(id) || !validHash(runLike.planHash)) fail('A saved operation identity is required');
    const run = await Runs.findOne({ _id: id, ...scopeFilter(scope), planHash: runLike.planHash }).session(session).lean();
    assertRun(run, scope); assertRunApproval(run);
    if (!revision(run.writerRevision)) fail('Operation writer revision is missing or exhausted');
    const calendar = await Calendars.findOne({ _id: scope.environment + ':' + scope.realmId, ...scopeFilter(scope) }).session(session).lean();
    if (!calendar || calendar.contractVersion !== 1 || !same(calendar.currentOperationId, run._id) || calendar.businessKey !== run.businessKey || !same(calendar.blueprintId, run.blueprintId) || calendar.blueprintHash !== run.blueprintHash || calendar.baseline?.status !== 'verified' || calendar.baseline.evidenceHash !== run.baselineHash || !revision(calendar.writerRevision) || calendar.revision !== run.expectedRevision + (afterCommit ? 1 : 0) || calendar.verifiedThrough !== (afterCommit ? run.throughDate : run.expectedCursor)) fail('The calendar no longer matches this operation');
    if (afterCommit ? (!calendar.pendingCommit || !same(calendar.pendingCommit.operationId, run._id) || calendar.pendingCommit.planHash !== run.planHash || calendar.pendingCommit.evidenceHash !== run.verificationCandidateHash) : calendar.pendingCommit !== null) fail('The calendar completion receipt is not in the required state');
    const writer = await Writers.findOne({ _id: scope.environment + ':' + scope.realmId, ...scopeFilter(scope) }).session(session).lean();
    if (!writer || writer.contractVersion !== 1 || !revision(writer.revision)) fail('The company writer has not been explicitly prepared');
    return { run, calendar, writer };
  }
  function owner(state) {
    if (!same(state.writer.operationId, state.run._id) || state.writer.planHash !== state.run.planHash) fail('Another operation owns this company writer');
  }
  async function touch(state, scope, session, writerChange = {}, invalidateEvidence = false) {
    const { run, calendar, writer } = state;
    if (invalidateEvidence && !revision(run.evidenceRevision)) fail('Operation evidence revision is missing or exhausted');
    const changedRun = await Runs.findOneAndUpdate({ _id: run._id, ...scopeFilter(scope), planHash: run.planHash, status: run.status, writerRevision: run.writerRevision, ...(invalidateEvidence ? { evidenceRevision: run.evidenceRevision } : {}) }, { $inc: { writerRevision: 1, ...(invalidateEvidence ? { evidenceRevision: 1 } : {}) }, ...(invalidateEvidence ? { $set: { verificationCandidateHash: null } } : {}) }, { new: true, session }).lean();
    const changedCalendar = await Calendars.findOneAndUpdate({ _id: calendar._id, ...scopeFilter(scope), currentOperationId: run._id, blueprintHash: run.blueprintHash, revision: calendar.revision, writerRevision: calendar.writerRevision, stopRequested: calendar.stopRequested }, { $inc: { writerRevision: 1 } }, { new: true, session }).lean();
    const changedWriter = await Writers.findOneAndUpdate({ _id: writer._id, ...scopeFilter(scope), operationId: writer.operationId, planHash: writer.planHash, revision: writer.revision }, { $set: writerChange, $inc: { revision: 1 } }, { new: true, session }).lean();
    if (!changedRun || !changedCalendar || !changedWriter) fail('Company writer state changed before the transition');
    return { runRevision: changedRun.writerRevision, calendarRevision: changedCalendar.writerRevision, writerRevision: changedWriter.revision };
  }
  async function reserve(run, scope, session) {
    const state = await snapshot(run, scope, session, false, 'reserve');
    if (state.run.status !== 'reserved' || state.calendar.stopRequested || state.writer.unresolved !== null) fail('Only an unstopped reserved operation may claim an idle company writer');
    if (state.writer.operationId !== null || state.writer.planHash !== null) owner(state);
    return touch(state, scope, session, { operationId: state.run._id, planHash: state.run.planHash });
  }
  async function assertSettled(run, scope, session) {
    const state = await snapshot(run, scope, session); owner(state);
    if (state.run.status !== 'awaiting-evidence' || state.calendar.stopRequested || state.writer.unresolved !== null) fail('An unresolved or stopped company writer cannot complete a period');
    return touch(state, scope, session);
  }
  async function release(run, scope, session) {
    const state = await snapshot(run, scope, session, true); owner(state);
    if (state.run.status !== 'verified' || state.writer.unresolved !== null || state.run.verification?.evidenceHash !== state.calendar.pendingCommit.evidenceHash) fail('Only the exact verified completion receipt may release the writer');
    // Caller clears Calendar.pendingCommit/currentOperationId in this SAME transaction.
    return touch(state, scope, session, { operationId: null, planHash: null, lastReleasedOperationId: state.run._id });
  }
  async function fenceStep({ scope, intent, actorId, phase, dispatch, receipt = null, step = null, runLeaseToken, session }) {
    if (!intent || !validHash(intent.logicalKey) || !validHash(intent.fingerprint) || typeof actorId !== 'string' || !actorId || actorId.length > 100 || !['claim', 'dispatch', 'unknown', 'saved', 'recover', 'verification-start', 'verify'].includes(phase)) fail('A valid step transition is required');
    const state = await snapshot(intent, scope, session, false, phase); owner(state);
    const writes = ['claim', 'dispatch'].includes(phase), settlement = ['saved', 'recover'].includes(phase), checking = ['verification-start', 'verify'].includes(phase);
    if (writes ? (!['reserved', 'running'].includes(state.run.status) || state.calendar.stopRequested) : !['reserved', 'running', 'blocked', 'stopped', 'awaiting-evidence'].includes(state.run.status)) fail('This operation cannot make that step transition');
    if (writes && (state.run.leaseToken ? (runLeaseToken !== state.run.leaseToken || !Number.isFinite(new Date(state.run.leaseExpiresAt).getTime()) || new Date(state.run.leaseExpiresAt).getTime() <= now()) : runLeaseToken !== undefined)) fail('The operation worker lease changed or expired before the step transition');
    let current;
    if (phase !== 'claim') {
      if (!step || !Number.isSafeInteger(step.revision) || step.revision < 1 || typeof step.leaseToken !== 'string' || !step.leaseToken) fail('Exact step ownership is required');
      current = await Steps.findOne({ ...scopeFilter(scope), logicalKey: intent.logicalKey, entity: intent.entity, fingerprint: intent.fingerprint, state: step.state, revision: step.revision, leaseToken: step.leaseToken }).session(session).lean();
      if (!current || canonical(current.dependencies) !== canonical(intent.dependencies) || (!checking && (!same(current.operationId, state.run._id) || current.planHash !== state.run.planHash))) fail('The step no longer matches its immutable operation intent');
    }
    const change = {};
    if (phase === 'dispatch') {
      if (!dispatch || !validHash(dispatch.evidenceHash) || !validHash(dispatch.compilationHash) || dispatch.observationWriterRevision !== state.writer.revision) fail('Company observations changed before dispatch; read and compile again');
      if (current.state !== 'claimed' || current.dispatch || current.receipt || state.writer.unresolved !== null || !dispatch || !validHash(dispatch.key) || !validHash(dispatch.requestHash) || dispatch.actorId !== actorId || dispatch.key !== hash({ ...scopeFilter(scope), operationId: intent.operationId, logicalKey: intent.logicalKey, fingerprint: intent.fingerprint, requestHash: dispatch.requestHash })) fail('A request cannot pass an existing or mismatched dispatch barrier');
      change.unresolved = { ...dispatch, operationId: String(state.run._id), logicalKey: intent.logicalKey, entity: intent.entity, stepRevision: step.revision + 1 };
    } else if (settlement || phase === 'unknown') {
      const barrier = state.writer.unresolved;
      if (!['dispatched', 'unknown'].includes(current.state) || !barrier || !dispatch || !same(barrier.operationId, state.run._id) || barrier.logicalKey !== intent.logicalKey || barrier.entity !== intent.entity || barrier.key !== current.dispatch?.key || barrier.requestHash !== current.dispatch?.requestHash || canonical(dispatch) !== canonical(current.dispatch)) fail('The unresolved writer does not match this step dispatch');
      if (settlement) {
        if (current.receipt || !receipt || receipt.dispatchKey !== barrier.key || receipt.requestHash !== barrier.requestHash || typeof receipt.qboId !== 'string' || !/^\d{1,30}$/.test(receipt.qboId) || typeof receipt.syncToken !== 'string' || !VERSION.test(receipt.syncToken) || !validHash(receipt.evidenceHash) || (phase === 'recover' ? receipt.source !== 'request-correlated-readback' : !['create-response', 'request-correlated-readback'].includes(receipt.source))) fail('Only a matching validated saved receipt may settle the writer');
        change.unresolved = null;
      }
    } else {
      if (state.writer.unresolved !== null) fail('The unresolved company request must be settled first');
      if (checking && (!['saved', 'verified'].includes(current.state) || !current.receipt)) fail('Read-back requires the original saved receipt');
    }
    // Any step transition invalidates previously frozen period proof in this same transaction.
    const revisions = await touch(state, scope, session, change, true);
    return { scope: scopeFilter(scope), operationId: intent.operationId, planHash: intent.planHash, phase, fenceHash: hash({ ...revisions, operationId: intent.operationId, logicalKey: intent.logicalKey, phase }) };
  }
  async function graphSnapshot({ scope, intent, expected = null, session }) {
    const state = await snapshot(intent, scope, session); owner(state);
    if (!['reserved', 'running', 'blocked', 'stopped', 'awaiting-evidence'].includes(state.run.status) || state.writer.unresolved !== null) fail('The graph requires a settled company writer');
    const value = { scope: scopeFilter(scope), operationId: String(state.run._id), revision: state.writer.revision };
    if (expected && canonical(expected) !== canonical(value)) fail('Company activity changed before graph verification could be saved');
    return value;
  }
  return { reserve, assertSettled, release, fenceStep, graphSnapshot };
}
module.exports = { createBusinessWriterFence, businessWriterIntegrationStatus, assertBusinessWriterIntegration };
