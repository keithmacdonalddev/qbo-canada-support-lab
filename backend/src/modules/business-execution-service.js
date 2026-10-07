'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { assertRun, assertRunApproval } = require('./business-period-store');
const { createBusinessRuntime, loadModels } = require('./business-runtime');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessStorageReadiness } = require('./business-runtime-storage');
const { createBusinessTransaction } = require('./business-transaction');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_EXECUTION_UNAVAILABLE' }); }
const publicRequest = request => request ? { pending: request.pending === true, requestedAt: request.requestedAt, completedAt: request.completedAt || null, result: request.result || null } : null;
// Browser requests durably enqueue explicit execution; workers use the existing
// runtime lease/receipts. A scan never invents approval or a new operation.
function createBusinessExecutionService({ models = loadModels(), connection = require('mongoose').connection, transaction = createBusinessTransaction(connection), assertReady = createBusinessStorageReadiness({ connection, models }), resolveContext = require('./rebuild-context').createContextService().resolve, accessFor = input => createBusinessRuntimeAccess({ ...input, ...models }), runtimeFor = input => createBusinessRuntime({ ...input, models, connection, transaction, assertReady }), now = () => Date.now(), defer = work => setImmediate(work) } = {}) {
  const { Runs, Audits } = models;
  if (!Runs || !Audits || [transaction, assertReady, resolveContext, accessFor, runtimeFor, now, defer].some(value => typeof value !== 'function')) throw new TypeError('Background execution requires concrete scoped stores');
  const jobs = new Map(); let interval = null, scanPromise = null, closed = false, lastScanError = null, scanCursor = null;
  const read = (filter, session) => Runs.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function context(user, action) {
    const value = await resolveContext(user), scope = scoped({ realmId: value.connection?.realmId, environment: value.environment, connectionId: value.connection?.connectionId });
    const actorId = String(user.actorId || user.id), ownerId = String(user.id);
    const access = accessFor({ actorId, ownerId }); await access.authorize(scope, action);
    return { scope, actorId, ownerId, access };
  }
  async function permissions(selected) {
    try { await selected.access.authorize(selected.scope, 'operations.execute'); return { execute: true, stop: true }; }
    catch (error) { if (error.status === 403) return { execute: false, stop: false }; throw error; }
  }
  function requestIdentity(run) {
    const request = run?.executionRequest, scope = scoped({ realmId: run?.realmId, environment: run?.environment, connectionId: String(run?.connectionId) });
    if (!request || request.version !== 1 || !['execute', 'stop'].includes(request.mode) || !ID.test(request.actorId || '') || !ID.test(request.ownerId || '') || !HASH.test(request.id || '') || request.planHash !== run.planHash || typeof request.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(request.requestKey) || request.id !== hash({ scope, operationId: String(run._id), actorId: request.actorId, ownerId: request.ownerId, planHash: request.planHash, requestKey: request.requestKey, mode: request.mode })) fail('The saved execution request is invalid.');
    return { scope, operationId: String(run._id), actorId: request.actorId, ownerId: request.ownerId, request };
  }
  async function audit(identity, phase, outcome, session, performedBy = identity.actorId) {
    const id = hash({ requestId: identity.request.id, phase }).slice(0, 24), params = { ...identity.scope, operationId: identity.operationId, requestId: identity.request.id, planHash: identity.request.planHash, phase, outcome, performedBy };
    const existing = await Audits.findOne({ _id: id }).session(session).maxTimeMS(3000).lean();
    if (existing) { if (String(existing.userId) !== identity.ownerId || String(existing.actorUserId || existing.userId) !== performedBy || existing.realmId !== identity.scope.realmId || existing.action !== 'Business execution request recorded' || existing.actionType !== 'manual' || existing.outcome !== (outcome === 'verified' ? 'success' : 'partial') || canonical(existing.inputParams) !== canonical(params)) fail('Execution request audit changed.'); }
    else await Audits.create([{ _id: id, userId: identity.ownerId, ...(performedBy !== identity.ownerId ? { actorUserId: performedBy } : {}), realmId: identity.scope.realmId, action: 'Business execution request recorded', actionType: 'manual', outcome: outcome === 'verified' ? 'success' : 'partial', inputParams: params }], { session });
  }
  async function settle(identity, error, observed) {
    // Recording a stopped/denied worker is necessary even if its former actor has
    // lost permission. Only this private worker path settles the exact saved request.
    return transaction(async session => {
      const run = await read({ _id: identity.operationId, ...identity.scope }, session);
      if (!run || run.executionRequest?.id !== identity.request.id || !run.executionRequest.pending) return;
      requestIdentity(run);
      const expiry = new Date(run.leaseExpiresAt).getTime();
      if (run.leaseToken && (!Number.isFinite(expiry) || expiry > now())) return;
      if (['running', 'reserved', 'committing'].includes(run.status) && !error) return;
      // Another worker may have completed while this worker lost its lease. Let
      // recovery obtain the runtime's full completion proof, not an error winner.
      if (error && run.status === 'verified') return;
      const result = { state: observed?.state || (run.status === 'verified' ? 'verification-required' : run.status), complete: observed?.complete === true && run.status === 'verified', ...(error ? { error: 'The operation needs attention before it can continue.' } : {}) };
      await audit(identity, 'settled', result.state, session);
      const saved = await Runs.findOneAndUpdate({ _id: run._id, ...identity.scope, 'executionRequest.id': identity.request.id, 'executionRequest.pending': true, executionRevision: run.executionRevision, status: run.status }, { $set: { executionRequest: { ...run.executionRequest, pending: false, completedAt: new Date(now()).toISOString(), result } } }, { new: true, session }).lean();
      if (!saved) fail('The execution request changed while settling.');
    });
  }
  function kick(operationId) {
    if (closed || jobs.has(operationId) || jobs.size >= 3) return;
    const work = new Promise(resolve => defer(resolve)).then(async () => {
      await assertReady(); const run = await read({ _id: operationId });
      if (!run?.executionRequest?.pending) return;
      const identity = requestIdentity(run); assertRun(run, identity.scope); assertRunApproval(run);
      const expiry = new Date(run.leaseExpiresAt).getTime();
      if (run.leaseToken && (!Number.isFinite(expiry) || expiry > now())) return;
      let error, observed;
      try {
        const runtime = runtimeFor(identity);
        if (identity.request.mode === 'stop') {
          const current = await runtime.inspect();
          if (!['verified', 'committing', 'stopped'].includes(current.status)) {
            try { await runtime.stop(); } catch (stopError) {
              // Completion can release calendar ownership while Stop is queued.
              // Only a terminal/commit state permits receipt repair without Stop.
              const latest = await runtime.inspect();
              if (!['verified', 'committing', 'stopped'].includes(latest.status)) throw stopError;
            }
          }
        }
        observed = await runtime.execute();
      } catch (caught) { error = caught; }
      await settle(identity, error, observed);
    }).catch(() => { lastScanError = 'Saved business work needs recovery; no request was replayed.'; }).finally(() => jobs.delete(operationId));
    jobs.set(operationId, work);
  }
  async function request(user, operationId, body) {
    if (!ID.test(operationId || '') || !body || Object.keys(body).sort().join(',') !== 'planHash,requestKey' || !HASH.test(body.planHash || '') || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestKey)) fail('Choose the exact saved plan and request identifier.', 400);
    const selected = await context(user, 'operations.execute'); await assertReady();
    const result = await transaction(async session => {
      await selected.access.authorize(selected.scope, 'operations.execute', { session });
      const run = await read({ _id: operationId, ...selected.scope }, session); assertRun(run, selected.scope); assertRunApproval(run);
      if (run.planHash !== body.planHash || ['previewed', 'stopped'].includes(run.status)) fail('This operation is not an approved runnable plan.');
      const request = { version: 1, mode: 'execute', planHash: body.planHash, requestKey: body.requestKey, actorId: selected.actorId, ownerId: selected.ownerId, requestedAt: new Date(now()).toISOString(), pending: true };
      request.id = hash({ scope: selected.scope, operationId, actorId: selected.actorId, ownerId: selected.ownerId, planHash: request.planHash, requestKey: request.requestKey, mode: request.mode });
      if (run.executionRequest?.pending || run.executionRequest?.id === request.id) { requestIdentity(run); return { accepted: true, reused: true, operationId, execution: publicRequest(run.executionRequest) }; }
      if (run.status === 'verified') return { accepted: false, operationId, execution: publicRequest(run.executionRequest), state: 'verified' };
      const identity = { ...selected, operationId, request };
      await audit(identity, 'queued', 'queued', session);
      const saved = await Runs.findOneAndUpdate({ _id: operationId, ...selected.scope, planHash: body.planHash, status: run.status, executionRevision: run.executionRevision, executionRequest: run.executionRequest === undefined ? { $exists: false } : run.executionRequest }, { $set: { executionRequest: request } }, { new: true, session }).lean();
      if (!saved) fail('Another request changed this operation.');
      return { accepted: true, reused: false, operationId, execution: publicRequest(request) };
    });
    if (result.accepted && result.execution?.pending) kick(operationId);
    return result;
  }
  async function inspect(user, operationId) {
    if (!ID.test(operationId || '')) fail('Choose an exact operation.', 400);
    const selected = await context(user, 'operations.read'); await assertReady();
    const value = await runtimeFor({ ...selected, operationId }).inspect();
    const run = await read({ _id: operationId, ...selected.scope });
    const allowed = await permissions(selected);
    await selected.access.authorize(selected.scope, 'operations.read');
    return { ...value, scope: selected.scope, permissions: allowed, execution: publicRequest(run?.executionRequest) };
  }
  async function list(user, { after, limit = 50 } = {}) {
    if ((after !== undefined && !ID.test(after)) || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('Use a valid bounded operation page.', 400);
    const selected = await context(user, 'operations.read'); await assertReady();
    const rows = await Runs.find({ ...selected.scope, ...(after ? { _id: { $lt: after } } : {}) }).select('_id planHash status fromDate throughDate recordCount nextOrdinal executionRequest').sort({ _id: -1 }).limit(limit + 1).maxTimeMS(3000).lean();
    const allowed = await permissions(selected);
    await selected.access.authorize(selected.scope, 'operations.read');
    return { scope: selected.scope, permissions: allowed, operations: rows.slice(0, limit).map(row => ({ operationId: String(row._id), planHash: row.planHash, status: row.status, fromDate: row.fromDate, throughDate: row.throughDate, recordCount: row.recordCount, completedRecords: row.nextOrdinal || 0, execution: publicRequest(row.executionRequest) })), next: rows.length > limit ? String(rows[limit - 1]._id) : null };
  }
  async function stop(user, operationId) {
    if (!ID.test(operationId || '')) fail('Choose an exact operation.', 400);
    const selected = await context(user, 'operations.stop'); await assertReady();
    const stoppedQueued = await transaction(async session => {
      await selected.access.authorize(selected.scope, 'operations.stop', { session });
      const run = await read({ _id: operationId, ...selected.scope }, session); assertRun(run, selected.scope);
      if (run.status !== 'approved' || !run.executionRequest?.pending || run.leaseToken) return false;
      const identity = requestIdentity(run); await audit(identity, 'settled', 'stopped', session, selected.actorId);
      const saved = await Runs.findOneAndUpdate({ _id: run._id, ...selected.scope, status: 'approved', executionRevision: run.executionRevision, 'executionRequest.id': identity.request.id, 'executionRequest.pending': true }, { $set: { status: 'stopped', executionRequest: { ...run.executionRequest, pending: false, completedAt: new Date(now()).toISOString(), result: { state: 'stopped', complete: false } } } }, { new: true, session }).lean();
      if (!saved) fail('The queued operation changed while stopping.'); return true;
    });
    if (!stoppedQueued) {
      await runtimeFor({ ...selected, operationId }).stop();
      await transaction(async session => {
        await selected.access.authorize(selected.scope, 'operations.stop', { session });
        const run = await read({ _id: operationId, ...selected.scope }, session); assertRun(run, selected.scope);
        if (['stopped', 'verified'].includes(run.status)) return;
        if (run.executionRequest?.pending && run.executionRequest.mode === 'stop' && run.executionRequest.actorId === selected.actorId) { requestIdentity(run); return; }
        const request = { version: 1, mode: 'stop', actorId: selected.actorId, ownerId: selected.ownerId, planHash: run.planHash, requestKey: hash({ previous: run.executionRequest?.id || null, operationId, revision: run.executionRevision, actorId: selected.actorId, mode: 'stop' }), requestedAt: new Date(now()).toISOString(), pending: true };
        request.id = hash({ scope: selected.scope, operationId, actorId: request.actorId, ownerId: request.ownerId, planHash: request.planHash, requestKey: request.requestKey, mode: request.mode });
        if (run.executionRequest?.pending) await audit(requestIdentity(run), 'superseded', 'stop-requested', session, selected.actorId);
        await audit({ ...selected, operationId, request }, 'queued', 'stop-requested', session);
        const saved = await Runs.findOneAndUpdate({ _id: run._id, ...selected.scope, executionRevision: run.executionRevision, status: run.status, executionRequest: run.executionRequest === undefined ? { $exists: false } : run.executionRequest }, { $set: { executionRequest: request } }, { new: true, session }).lean();
        if (!saved) fail('The operation changed while requesting stop recovery.');
      });
      kick(operationId);
    }
    return { operationId, stopRequested: true };
  }
  async function scan() {
    if (closed) return;
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      await assertReady();
      const filter = { 'executionRequest.pending': true, $or: [{ leaseToken: null }, { leaseToken: { $exists: false } }, { leaseExpiresAt: { $lte: new Date(now()) } }] };
      let rows = await Runs.find({ ...filter, ...(scanCursor ? { _id: { $gt: scanCursor } } : {}) }).select('_id').sort({ _id: 1 }).limit(100).maxTimeMS(3000).lean();
      if (!rows.length && scanCursor) { scanCursor = null; rows = await Runs.find(filter).select('_id').sort({ _id: 1 }).limit(100).maxTimeMS(3000).lean(); }
      // Rotate after attempted jobs, including corrupt requests. One damaged row
      // must never keep later valid work at the back of the recovery queue.
      for (const row of rows) { if (jobs.size >= 3) break; scanCursor = String(row._id); kick(scanCursor); }
      lastScanError = null;
    })().catch(() => { lastScanError = 'Business execution storage is not ready for recovery.'; }).finally(() => { scanPromise = null; });
    return scanPromise;
  }
  function start() { if (interval || closed) return; interval = setInterval(() => { void scan(); }, 10000); interval.unref?.(); void scan(); }
  function close() { closed = true; if (interval) clearInterval(interval); interval = null; } // Does not interrupt possibly-sent provider requests.
  return { request, inspect, list, stop, scan, start, close, idle: () => Promise.all([...jobs.values()]), diagnostics: () => ({ activeWorkers: jobs.size, scanning: Boolean(scanPromise), error: lastScanError }) };
}
let service;
function getBusinessExecutionService() { return service ||= createBusinessExecutionService(); }
module.exports = { createBusinessExecutionService, getBusinessExecutionService };
