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
    if (!calendar || calendar.contractVersion !== 1 || !same(calendar.currentOperationId, run._id) || calendar.businessKey !== run.businessKey || !same(calendar.blueprintId, run.blueprintId) || calendar.blueprintHash !== run.blueprintHash || calendar.baseline?.status !== 'verified' || calendar.baseline.evidenceHash !== run.baselineHash || !revision(calendar.writerRevision) || calendar.revision !== run.expectedRevision + (afterCommit ? 1 : 0) || calendar.verifiedThrough !== (afterCommit && !run.activityBatch ? run.throughDate : run.expectedCursor)) fail('The calendar no longer matches this operation');
    if (afterCommit ? (!calendar.pendingCommit || !same(calendar.pendingCommit.operationId, run._id) || calendar.pendingCommit.planHash !== run.planHash || calendar.pendingCommit.evidenceHash !== run.verificationCandidateHash) : calendar.pendingCommit !== null) fail('The calendar completion receipt is not in the required state');
    const writer = await Writers.findOne({ _id: scope.environment + ':' + scope.realmId, ...scopeFilter(scope) }).session(session).lean();
    if (writer?.populationDelegation) fail('The company writer is delegated to its population job.');
    if (!writer || writer.contractVersion !== 1 || !revision(writer.revision)) fail('The company writer has not been explicitly prepared');
    return { run, calendar, writer };
  }
  function owner(state) {
    if (state.writer.populationDelegation) fail('This company writer is delegated to its bulk population job.');
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
    if (liveClaims(state.writer, now()).length || liveQueue(state.writer, now()).length || state.run.status !== 'reserved' || state.calendar.stopRequested || state.writer.unresolved !== null) fail('Only an unstopped reserved operation may claim an idle company writer');
    if (state.writer.operationId !== null || state.writer.planHash !== null) owner(state);
    return touch(state, scope, session, { operationId: state.run._id, planHash: state.run.planHash, resourceClaims: liveClaims(state.writer, now()), resourceQueue: liveQueue(state.writer, now()) });
  }
  async function assertSettled(run, scope, session) {
    const state = await snapshot(run, scope, session); owner(state);
    if (liveClaims(state.writer, now()).length || state.run.status !== 'awaiting-evidence' || state.run.deferredSteps?.length || state.calendar.stopRequested || state.writer.unresolved !== null) fail('An unresolved or stopped company writer cannot complete a period');
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
      if (state.run.authorityHash && (!validHash(dispatch?.policyHash) || (dispatch.policyAmendmentHash || null) !== (state.run.policyAmendmentHash || null))) fail('The approved policy head changed before dispatch');
      if (!dispatch || !validHash(dispatch.evidenceHash) || !validHash(dispatch.compilationHash) || dispatch.observationWriterRevision !== state.writer.revision) fail('Company observations changed before dispatch; read and compile again');
      if (current.state !== 'claimed' || current.dispatch || current.receipt || state.writer.unresolved !== null || !dispatch || !validHash(dispatch.key) || !validHash(dispatch.requestHash) || dispatch.actorId !== actorId || dispatch.key !== hash({ ...scopeFilter(scope), operationId: intent.operationId, logicalKey: intent.logicalKey, fingerprint: intent.fingerprint, requestHash: dispatch.requestHash, ...(current.retryGeneration ? { retryGeneration: current.retryGeneration } : {}) })) fail('A request cannot pass an existing or mismatched dispatch barrier');
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
      if (checking && (!['saved', 'verified', 'needs-check'].includes(current.state) || !current.receipt)) fail('Read-back requires the original saved receipt');
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

// Resource claims are additive to the legacy exclusive writer. Only reservations that
// have NEVER been admitted expire. A receipt-bound or unknown claim has no expiry.
const { randomUUID } = require('node:crypto');
const CLAIM_TTL = 300000, MAX_COMPANY_REQUESTS = 4;
const liveResourceAttempts = new Set();
function trackResourceAttempt(receiptId, live) { if (live) liveResourceAttempts.add(receiptId); else liveResourceAttempts.delete(receiptId); }
const liveClaims = (writer, clock) => claimsOf(writer).filter(row => row.state !== 'reserved' || row.expiresAt > clock);
const liveQueue = (writer, clock) => (writer.resourceQueue || []).filter(row => row.expiresAt > clock);
function resourcesForBatch(batch, { history = false, itemTypes = {} } = {}) {
  const resources = new Set(), reads = new Set(), uncertainty = new Set();
  let exclusive = history;
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'LinkedTxn' && Array.isArray(child)) for (const link of child) {
        if (!/^\d{1,30}$/.test(String(link?.TxnId || '')) || typeof link?.TxnType !== 'string') fail('Resource claims require resolved transaction links');
        resources.add('record:' + (link.TxnType === 'BillPaymentCheck' ? 'billpayment' : link.TxnType.toLowerCase()) + ':' + link.TxnId);
      }
      // Known services share a read claim; Item edits exclude those readers.
      // Inventory and unknown types take a write claim on the same Item key.
      if (key === 'ItemRef' && child?.value != null) {
        const id = String(child.value), target = ['Service', 'NonInventory'].includes(itemTypes[id]) ? reads : resources;
        target.add('record:item:' + id);
      }
      walk(child);
    }
  };
  for (const item of batch.items || []) {
    const entity = String(item.entity).toLowerCase(), payload = item.payload || {}, before = item.before;
    const target = item.id ?? payload.Id;
    if (target != null) {
      if (!before || String(before.Id) !== String(target)) fail('Resource claims require the complete saved before record');
      resources.add('record:' + entity + ':' + target);
      // History changes and removals affect earlier accounting evidence; serialize
      // globally until their complete downstream re-verification finishes.
      if (before?.TxnDate || payload.TxnDate || ['delete', 'void'].includes(item.operation)) exclusive = true;
    }
    for (const record of [payload, before]) {
      walk(record);
      for (const [key, kind] of [['CustomerRef', 'customer'], ['VendorRef', 'vendor'], ['EmployeeRef', 'employee'], ['EntityRef', 'entity']]) {
        const party = record?.[key]?.value;
        if (party != null) uncertainty.add('party:' + kind + ':' + party + ':' + entity);
      }
      // Name identity is the only party for a newly-created list record.
      if (record?.DisplayName || record?.Name) uncertainty.add('name:' + entity + ':' + hash(String(record.DisplayName || record.Name).trim().toLowerCase()));
    }
    if (![...uncertainty].some(key => key.endsWith(':' + entity)) && !payload.DisplayName && !payload.Name) uncertainty.add('entity:' + entity);
  }
  return { resources: [...resources].sort(), reads: [...reads].filter(key => !resources.has(key)).sort(), uncertainty: [...uncertainty].sort(), exclusive };
}
function claimsOf(writer) {
  if (writer.resourceClaims !== undefined && !Array.isArray(writer.resourceClaims)) fail('Company resource claims need recovery');
  return writer.resourceClaims || [];
}
function unscopedBarrier(writer) {
  const barrier = writer?.unresolved;
  return Boolean(barrier && !claimsOf(writer).some(row => row.barrier?.key === barrier.key && row.barrier?.requestHash === barrier.requestHash && row.barrier?.transportConsumed?.receiptId === barrier.transportConsumed?.receiptId));
}
function writerForRequest(writer, request) {
  if (!writer) return writer;
  const claim = claimsOf(writer).find(row => row.requestHash === request.requestHash);
  return { ...writer, unresolved: claim?.barrier || (writer.unresolved?.kind === 'general-write' && !unscopedBarrier(writer) ? null : writer.unresolved) };
}
function claimsPointer(claims, writer) {
  return unscopedBarrier(writer) ? writer.unresolved : claims.find(row => row.barrier)?.barrier || null;
}
function resourceConflict(a, b) {
  if (a.exclusive || b.exclusive) return true;
  const own = new Set(a.resources), other = new Set(b.resources);
  if ((a.reads || []).some(key => other.has(key)) || (b.reads || []).some(key => own.has(key)) || b.resources.some(key => own.has(key))) return true;
  // Party/entity uncertainty holds only after an outcome becomes unknown.
  if (a.state === 'unknown') for (const key of a.uncertainty) own.add(key);
  if (b.state === 'unknown') for (const key of b.uncertainty) other.add(key);
  return [...own].some(key => other.has(key)) ||
    (a.state === 'unknown' && a.uncertainty.some(key => b.uncertainty.includes(key))) ||
    (b.state === 'unknown' && b.uncertainty.some(key => a.uncertainty.includes(key)));
}
function createCompanyResourceClaims({ Writers, transaction, now = () => Date.now(), token = randomUUID, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const read = (scope, session) => Writers.findOne({ ...scopeFilter(scope) }).session(session).maxTimeMS(3000).lean();
  const pending = writer => {
    if (writer.resourceQueue !== undefined && !Array.isArray(writer.resourceQueue)) fail('Company resource queue needs recovery');
    return (writer.resourceQueue || []).filter(row => row.expiresAt > now());
  };
  const active = writer => claimsOf(writer).filter(row => row.state !== 'reserved' || row.expiresAt > now());
  async function save(writer, scope, session, claims, queue) {
    const result = await Writers.findOneAndUpdate({ _id: writer._id, ...scopeFilter(scope), revision: writer.revision }, { $set: { resourceClaims: claims, resourceQueue: queue, unresolved: claimsPointer(claims, writer) }, $inc: { revision: 1 } }, { new: true, session }).lean();
    if (!result) fail('Company resource ownership changed');
    return result;
  }
  async function acquire(scope, requestHash, spec) {
    const id = token();
    await transaction(async session => {
      const writer = await read(scope, session);
      if (!writer || writer.contractVersion !== 1 || !revision(writer.revision) || writer.populationDelegation || writer.operationId !== null || writer.planHash !== null || unscopedBarrier(writer)) fail('Another operation owns this company writer');
      const claims = active(writer), queue = pending(writer), existing = claims.find(row => row.requestHash === requestHash);
      if (existing) {
        if (liveResourceAttempts.has(existing.barrier?.transportConsumed?.receiptId)) fail('An in-flight request already owns this company resource');
        if (!['unknown', 'admitted'].includes(existing.state) || existing.replayToken && existing.replayExpiresAt > now()) fail('An in-flight request already owns this company resource');
        if (canonical({ resources: existing.resources, ...(existing.reads ? { reads: existing.reads } : {}), uncertainty: existing.uncertainty, exclusive: existing.exclusive }) !== canonical(spec)) fail('The unknown request resources changed');
        // Keep the original requestid replay contract, including a possibly-sent
        // receipt after a crash/lost commit reply. Exact receipt proof is rechecked
        // by transport admission; this never releases or recreates its resources.
        existing.state = 'unknown';
        existing.replayToken = id; existing.replayExpiresAt = now() + CLAIM_TTL; existing.replayGranted = false;
      } else {
        if (claims.some(row => row.state === 'unknown' && resourceConflict(spec, row))) fail('An unknown request owns this company resource; recover its exact receipt first');
        if (queue.length >= 1000) fail('Company resource queue is full');
        queue.push({ id, requestHash, ...spec, expiresAt: now() + CLAIM_TTL });
      }
      await save(writer, scope, session, claims, queue);
    });
    for (;;) {
      const granted = await transaction(async session => {
        const writer = await read(scope, session), claims = active(writer), queue = pending(writer);
        const replay = claims.find(row => row.requestHash === requestHash && row.replayToken === id);
        if (replay) {
          if (!replay.replayGranted && claims.filter(row => row.state !== 'unknown' || row.replayGranted && row.replayExpiresAt > now()).length >= MAX_COMPANY_REQUESTS) return null;
          replay.replayGranted = true;
          await save(writer, scope, session, claims, queue);
          return { id: replay.id, token: id, requestHash };
        }
        const index = queue.findIndex(row => row.id === id), own = queue[index];
        if (!own) fail('The unsent resource reservation expired');
        if (writer.operationId !== null || writer.planHash !== null || writer.populationDelegation || writer.unresolved && writer.unresolved.kind !== 'general-write') fail('An exclusive operation owns this company writer');
        if (claims.some(row => row.state === 'unknown' && resourceConflict(own, row))) {
          await save(writer, scope, session, claims, queue.filter(row => row.id !== id));
          return { blocked: true };
        }
        if (claims.filter(row => row.state !== 'unknown' || row.replayGranted && row.replayExpiresAt > now()).length >= MAX_COMPANY_REQUESTS || claims.some(row => resourceConflict(own, row)) || queue.slice(0, index).some(row => resourceConflict(own, row))) return null;
        claims.push({ ...own, state: 'reserved' });
        await save(writer, scope, session, claims, queue.filter(row => row.id !== id));
        return { id, token: id, requestHash };
      });
      if (granted?.blocked) fail('An unknown request owns this company resource; recover its exact receipt first');
      if (granted) return granted;
      await delay(20);
    }
  }
  function assertClaim(writer, handle) {
    const claim = claimsOf(writer).find(row => row.id === handle?.id && row.requestHash === handle?.requestHash);
    if (!claim || (claim.state === 'reserved' ? claim.id !== handle.token || claim.expiresAt <= now() : claim.state !== 'unknown' || !claim.replayGranted || claim.replayToken !== handle.token || claim.replayExpiresAt <= now())) fail('The unsent resource reservation changed or expired');
    return claim;
  }
  async function abandon(scope, handle) {
    if (!handle) return;
    await transaction(async session => {
      const writer = await read(scope, session), claims = claimsOf(writer), claim = claims.find(row => row.id === handle.id && row.requestHash === handle.requestHash);
      if (!claim || claim.state === 'admitted') return; // A lost admission reply is NOT permission to release.
      if (claim.state === 'unknown' && claim.replayToken === handle.token) { delete claim.replayToken; delete claim.replayExpiresAt; delete claim.replayGranted; }
      else if (claim.state !== 'reserved' || claim.id !== handle.token) return;
      await save(writer, scope, session, claim.state === 'reserved' ? claims.filter(row => row.id !== claim.id) : claims, pending(writer));
    });
  }
  return { acquire, assertClaim, abandon };
}
module.exports.resourcesForBatch = resourcesForBatch;
module.exports.claimsOf = claimsOf;
module.exports.writerForRequest = writerForRequest;
module.exports.claimsPointer = claimsPointer;
module.exports.resourceConflict = resourceConflict;
module.exports.createCompanyResourceClaims = createCompanyResourceClaims;

module.exports.unscopedBarrier = unscopedBarrier;

// All clients in this backend share the same four HTTP slots, including GETs.
// Never race or cancel a possibly-sent SDK promise; release only after it ends.
const companyRequestSlots = new Map();
async function withCompanyRequestSlot(scope, work) {
  const key = scope.environment + ':' + scope.realmId;
  let state = companyRequestSlots.get(key);
  if (!state) { state = { active: 0, queue: [] }; companyRequestSlots.set(key, state); }
  if (state.active >= MAX_COMPANY_REQUESTS) await new Promise(resolve => state.queue.push(resolve));
  else state.active++;
  try { return await work(); }
  finally {
    const next = state.queue.shift();
    if (next) next();
    else { state.active--; if (!state.active) companyRequestSlots.delete(key); }
  }
}
module.exports.withCompanyRequestSlot = withCompanyRequestSlot;

module.exports.trackResourceAttempt = trackResourceAttempt;
