'use strict';
const { randomUUID } = require('node:crypto');
const { hash, canonical } = require('./business-calendar');
const { denied, scoped, freezeWriteRequest } = require('./qbo-write-contract');
const { assertPeriodControl } = require('./qbo-write-period');
const { assertMasterPlan, compileMasterEntry, verifyMasterReadback } = require('./business-master-preparation-plan');
const { assertMasterRun, assertMasterApproval, verifiedParents, dispatchKeyFor } = require('./business-master-preparation-transport');
const { assertMasterDispatchEvidence } = require('./business-master-dispatch-evidence');
const { fenceBusinessOwner } = require('./business-owner-fence');
const { assertMasterFailure } = require('./business-master-preparation-failure');
const same = (a, b) => String(a) === String(b);
const validWorkerLease = (run, now) => Boolean(run.leaseToken && Number.isFinite(new Date(run.leaseExpiresAt).getTime()) && new Date(run.leaseExpiresAt).getTime() > now);
const activeLease = (run, now) => Boolean(run.leaseToken && (!Number.isFinite(new Date(run.leaseExpiresAt).getTime()) || new Date(run.leaseExpiresAt).getTime() > now));
function createMasterPreparationStore({ models, scope, ownerId, actorId, access, transaction, assertReady, transport, assertQuiescent, now = () => Date.now(), token = randomUUID }) {
  scope = scoped(scope);
  if (![ownerId, actorId].every(id => /^[a-f0-9]{24}$/.test(id || '')) || !models?.MasterRuns || [transaction, assertReady, transport?.fenceSource, assertQuiescent].some(value => typeof value !== 'function')) throw new TypeError('Master preparation requires scoped durable adapters');
  const { MasterRuns, Policies, Writers, Receipts, Audits } = models;
  const company = { environment: scope.environment, realmId: scope.realmId };
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  const load = async (id, session) => assertMasterRun(await read(MasterRuns, { _id: id, ...scope, ownerId }, session), scope, ownerId);
  async function authorize(action, session) { await assertReady({ scope, ownerId, session }); await fenceBusinessOwner({ models, scope, ownerId, actorId, access, action, session }); }
  async function coordination(session, writes = false) {
    const policy = await read(Policies, company, session), writer = await read(Writers, company, session);
    if (!policy || !writer || policy.contractVersion !== 1 || writer.contractVersion !== 1 || !same(policy.connectionId, scope.connectionId) || !same(writer.connectionId, scope.connectionId) || (writes && policy.state !== 'active')) throw denied('Current company write coordination is required.');
    if (writes) assertPeriodControl(policy.periodControl, scope, ownerId);
    return { policy, writer };
  }
  async function touchPolicy(policy, session) {
    const value = await Policies.findOneAndUpdate({ _id: policy._id, ...scope, revision: policy.revision, state: policy.state }, { $inc: { revision: 1 } }, { new: true, session }).lean();
    if (!value) throw denied('Company coordination changed during this decision.');
  }
  async function change(run, fields, session) {
    const value = await MasterRuns.findOneAndUpdate({ _id: run._id, ...scope, ownerId, revision: run.revision, claim: run.claim }, { $set: fields, $inc: { revision: 1 } }, { new: true, session }).lean();
    if (!value) throw denied('Master preparation changed during this decision.'); return value;
  }
  async function audit(run, action, details, session) {
    const id = hash({ masterRun: String(run._id), revision: run.revision, action, details }).slice(0, 24);
    await Audits.create([{ _id: id, userId: ownerId, realmId: scope.realmId, action, actionType: 'manual', outcome: 'success', afterState: { runId: String(run._id), planHash: run.planHash, ...details } }], { session }); return id;
  }
  function owns(writer, run) {
    if (!same(writer.operationId, run._id) || writer.workflowKind !== 'master-preparation' || writer.planHash !== run.planHash) throw denied('Another workflow owns this company writer.');
  }
  async function updateWriter(writer, fields, session) {
    const value = await Writers.findOneAndUpdate({ _id: writer._id, ...scope, revision: writer.revision, operationId: writer.operationId, planHash: writer.planHash }, { $set: fields, $inc: { revision: 1 } }, { new: true, session }).lean();
    if (!value) throw denied('The company writer changed during master preparation.');
  }
  function assertFreshPlan(plan) {
    assertMasterPlan(plan); const observed = Date.parse(plan.observedAt);
    if (observed > now() || now() - observed > 300000) throw denied('Refresh master prerequisites before saving or approving this plan.');
  }
  async function propose(plan) {
    assertMasterPlan(plan);
    if (plan.ownerId !== ownerId || canonical(plan.scope) !== canonical(scope)) throw denied('The master proposal belongs to another owner or company.');
    return transaction(async session => {
      await authorize('operations.preview', session); const { policy } = await coordination(session, true); await touchPolicy(policy, session);
      const existing = await read(MasterRuns, { ...company, claim: 'open' }, session);
      if (existing) return { existing: true, run: assertMasterRun(existing, scope, ownerId) };
      assertFreshPlan(plan);
      const id = hash({ masterPreparation: plan.planHash }).slice(0, 24), run = { _id: id, contractVersion: 1, ...scope, ownerId, sourceDraftId: plan.source.id, sourceDraftHash: plan.source.contentHash, planHash: plan.planHash, plan, claim: 'open', state: 'proposed', revision: 0, approval: null, stopRequested: false, leaseToken: null, leaseExpiresAt: null, records: plan.entries.map(entry => ({ ordinal: entry.ordinal, key: entry.key, entity: entry.entity, state: 'pending', attempts: [], qboId: null, readback: null })) };
      await transport.fenceSource(run, session);
      run.lastAuditId = await audit(run, 'Business master preparation proposed', { recordCount: run.records.length, qboWrites: 0 }, session);
      await MasterRuns.create([run], { session }); return { existing: false, run };
    });
  }
  async function approve(id, planHash, productionConfirmed, currentPlan) {
    return transaction(async session => {
      await authorize('operations.execute', session); const run = await load(id, session);
      if (run.planHash !== planHash || productionConfirmed !== (scope.environment === 'production')) throw denied('Confirm this exact master plan and target environment.');
      if (run.approval) { assertMasterApproval(run); return run; }
      if (run.state !== 'proposed' || run.claim !== 'open') throw denied('Only the open proposed master plan may be approved.');
      assertFreshPlan(currentPlan);
      const comparable = value => { const { planHash: ignoredHash, observedAt: ignoredTime, ...content } = value; void ignoredHash; void ignoredTime; return content; };
      if (canonical(comparable(currentPlan)) !== canonical(comparable(run.plan))) throw denied('Master prerequisites changed after review. Close the unsent proposal and prepare it again.');
      const { policy, writer } = await coordination(session, true);
      if (writer.operationId !== null || writer.planHash !== null || writer.unresolved !== null) throw denied('Another company operation must settle before master approval.');
      await touchPolicy(policy, session); await assertQuiescent({ scope, session }); await transport.fenceSource(run, session);
      const auditId = hash({ runId: String(run._id), planHash, phase: 'approved' }).slice(0, 24), source = { version: 1, scope, runId: String(run._id), ownerId, planHash, approvedAt: new Date(now()).toISOString(), productionConfirmed, auditId };
      const approval = { ...source, contentHash: hash(source) };
      await Audits.create([{ _id: auditId, userId: ownerId, realmId: scope.realmId, action: 'Business master preparation approved', actionType: 'manual', outcome: 'success', afterState: { runId: String(run._id), planHash, approvalHash: approval.contentHash, recordCount: run.records.length, productionConfirmed } }], { session });
      return change(run, { approval, state: 'approved', lastAuditId: auditId }, session);
    });
  }
  async function claim(id, { resume = false } = {}) {
    return transaction(async session => {
      await authorize('operations.execute', session); const run = await load(id, session); assertMasterApproval(run);
      if (run.claim !== 'open' || !['approved', 'running', 'stopped', 'blocked'].includes(run.state) || activeLease(run, now()) || (run.stopRequested && !resume) || run.records.some(row => ['reserved', 'possibly-sent', 'unknown', 'rejected'].includes(row.state))) throw denied('Review stopped, refused or uncertain master work before continuing.');
      const { policy, writer } = await coordination(session, true); await touchPolicy(policy, session); await transport.fenceSource(run, session);
      if (writer.operationId !== null || writer.planHash !== null) owns(writer, run);
      if (writer.unresolved !== null) throw denied('The saved master response needs readback recovery before any new create.');
      await assertQuiescent({ scope, runId: String(run._id), session });
      const leaseToken = token(), lastAuditId = await audit(run, 'Business master worker claimed', { leaseTokenHash: hash(leaseToken), resume }, session);
      await updateWriter(writer, { operationId: run._id, planHash: run.planHash, workflowKind: 'master-preparation' }, session);
      return change(run, { state: 'running', stopRequested: false, lastFailure: null, leaseToken, leaseExpiresAt: new Date(now() + 300000), lastAuditId }, session);
    });
  }
  async function reserve(id, leaseToken, ordinal, preflight) {
    return transaction(async session => {
      await authorize('operations.execute', session); const run = await load(id, session); assertMasterApproval(run);
      const { policy, writer } = await coordination(session, true); owns(writer, run);
      if (run.state !== 'running' || run.stopRequested || run.leaseToken !== leaseToken || !validWorkerLease(run, now()) || writer.unresolved !== null || run.records.slice(0, ordinal).some(row => row.state !== 'verified')) throw denied('The current master worker cannot reserve this ordinal.');
      const record = run.records[ordinal]; if (!record || record.state !== 'pending' || record.attempts.length) throw denied('This master ordinal needs explicit attempt recovery.');
      const compiled = compileMasterEntry(run.plan, ordinal, verifiedParents(run)), request = freezeWriteRequest(scope, 'POST', compiled.entity.toLowerCase(), compiled.payload);
      assertMasterDispatchEvidence(run, ordinal, request.requestHash, preflight, policy.periodControl, now()); await transport.fenceSource(run, session); await touchPolicy(policy, session);
      record.state = 'reserved'; record.attempts.push({ number: 1, dispatchKey: dispatchKeyFor(String(run._id), ordinal, 1), requestHash: request.requestHash, payload: compiled.payload, preflight, leaseToken, state: 'reserved', receiptId: null, qboId: null, reservedAt: new Date(now()) });
      const lastAuditId = await audit(run, 'Business master attempt reserved', { ordinal, attempt: 1, dispatchKey: record.attempts[0].dispatchKey }, session);
      return change(run, { records: run.records, leaseExpiresAt: new Date(now() + 300000), lastAuditId }, session);
    });
  }
  async function verify(id, ordinal, leaseToken, recordValue) {
    return transaction(async session => {
      await authorize('operations.recover', session); const run = await load(id, session), row = run.records[ordinal], attempt = row?.attempts.at(-1);
      if (!row || !['saved', 'verified'].includes(row.state) || !row.qboId || run.leaseToken !== leaseToken || !validWorkerLease(run, now())) throw denied('The exact accepted master record and worker are required for verification.');
      const { writer } = await coordination(session); owns(writer, run);
      const receipt = await read(Receipts, { _id: attempt.receiptId, ...scope, ownerId, kind: 'master-preparation', state: 'saved', 'workflow.runId': String(run._id), 'workflow.ordinal': ordinal, 'workflow.attempt': attempt.number }, session);
      if (!receipt || receipt.observed?.qboId !== row.qboId || receipt.requestHash !== attempt.requestHash || receipt.dispatchKey !== attempt.dispatchKey || run.plan.inventoryBefore[row.entity].includes(row.qboId)) throw denied('The accepted master identity or mandatory receipt is incomplete.');
      const compiled = compileMasterEntry(run.plan, ordinal, verifiedParents(run)), proof = verifyMasterReadback(compiled, recordValue, row.qboId);
      if (row.state === 'verified' && canonical(row.readback) === canonical(proof)) return run;
      if (writer.unresolved?.key !== attempt.dispatchKey || writer.unresolved?.transportConsumed?.receiptId !== attempt.receiptId) throw denied('The exact accepted master request barrier changed.');
      row.state = attempt.state = 'verified'; row.readback = attempt.readback = proof;
      const lastAuditId = await audit(run, 'Business master record independently verified', { ordinal, attempt: attempt.number, qboId: row.qboId, projectionHash: proof.projectionHash }, session);
      await updateWriter(writer, { unresolved: null }, session);
      return change(run, { records: run.records, lastAuditId }, session);
    });
  }
  async function stop(id) {
    return transaction(async session => {
      await authorize('operations.stop', session); const run = await load(id, session);
      const live = activeLease(run, now());
      if (run.claim === 'closed' || (run.stopRequested && (live || !run.leaseToken))) return run;
      const { writer } = await coordination(session), ownUnresolved = same(writer.operationId, run._id) && Boolean(writer.unresolved);
      const lastAuditId = await audit(run, 'Business master stop requested', { activeWorker: live, unresolved: ownUnresolved, settledExpiredWorker: run.stopRequested, qboWrites: 0 }, session);
      return change(run, { stopRequested: true, ...(!live && run.state !== 'complete' ? { state: ownUnresolved ? 'blocked' : 'stopped', leaseToken: null, leaseExpiresAt: null } : {}), lastAuditId }, session);
    });
  }
  async function finish(id, leaseToken) {
    return transaction(async session => {
      await authorize('operations.recover', session); const run = await load(id, session);
      if (run.state === 'complete') return run;
      if (run.leaseToken !== leaseToken || run.records.some(row => row.state !== 'verified')) throw denied('Every prepared record needs exact-ID readback before completion.');
      const { writer } = await coordination(session); owns(writer, run); if (writer.unresolved !== null) throw denied('An unresolved master request prevents completion.');
      const lastAuditId = await audit(run, 'Business master creation completed', { confirmedCreates: run.records.length, admittedRequests: run.records.reduce((count, row) => count + row.attempts.filter(value => value.receiptId).length, 0), applied: false }, session);
      await updateWriter(writer, { operationId: null, planHash: null, workflowKind: null, lastReleasedOperationId: run._id }, session);
      return change(run, { state: 'complete', leaseToken: null, leaseExpiresAt: null, lastAuditId }, session);
    });
  }
  // Private worker cleanup retains exact lease and plan correlation even after
  // account revocation. It never dispatches or releases an unresolved company request.
  async function releaseWorker(id, leaseToken, failure = null) {
    failure = assertMasterFailure(failure);
    if (typeof leaseToken !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(leaseToken)) throw denied('Exact worker settlement is required.');
    return transaction(async session => {
      await assertReady({ scope, ownerId, session }); const run = await load(id, session);
      if (run.leaseToken !== leaseToken || ['complete', 'closed'].includes(run.state)) return run;
      const { writer } = await coordination(session); owns(writer, run);
      const state = writer.unresolved ? 'blocked' : run.stopRequested ? 'stopped' : 'blocked';
      const lastAuditId = await audit(run, 'Business master worker settled', { state, unresolved: Boolean(writer.unresolved), acceptedRecords: run.records.filter(row => row.qboId).length, failure }, session);
      return change(run, { state, leaseToken: null, leaseExpiresAt: null, lastFailure: failure, lastAuditId }, session);
    });
  }
  return { propose, approve, claim, reserve, verify, stop, finish, releaseWorker, load };
}
module.exports = { createMasterPreparationStore, activeLease };
