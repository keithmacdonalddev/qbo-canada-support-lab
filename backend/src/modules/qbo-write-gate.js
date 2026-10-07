'use strict';
const { randomUUID } = require('node:crypto');
const { hash } = require('./business-calendar');
const { assertRunApproval } = require('./business-period-store');
const { denied, scoped, classifyWriteResponse } = require('./qbo-write-contract');
const { normalizePermissions } = require('./rebuild-permissions');
const ID = /^[a-f0-9]{24}$/i, HASH = /^[a-f0-9]{64}$/;
const same = (a, b) => String(a) === String(b);
const fresh = (stamp, clock) => { const value = typeof stamp === 'string' ? Date.parse(stamp) : NaN; return Number.isFinite(value) && new Date(value).toISOString() === stamp && value <= clock && clock - value <= 300000; };
const validRevision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
function createQboWriteGate({ Policies, Writers, Receipts, Audits, Connections, Memberships, Runs, Calendars, Steps, Users, transaction, assertReady, now = () => Date.now(), nonce = randomUUID }) {
  if ([Policies, Writers, Receipts, Audits, Connections, Memberships, Runs, Calendars, Steps].some(value => !value) || [transaction, assertReady, now, nonce].some(value => typeof value !== 'function')) throw new TypeError('Write admission needs explicit storage adapters');
  const company = scope => ({ environment: scope.environment, realmId: scope.realmId });
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function fenceWorkspace(scope, ownerId, actorId, session) {
    if (!Users) throw denied('Business workspace authority storage is required.');
    // OAuth switches write these same user documents. A concurrent switch then
    // conflicts with this transaction, so admission retries against the new scope.
    for (const id of [...new Set([ownerId, actorId])].sort()) {
      const user = await Users.findOne({ _id: id }).select('_id role connectionSwitchVersion').session(session).maxTimeMS(3000).lean();
      const version = user?.connectionSwitchVersion ?? 0;
      if (!user || !['agent', 'supervisor'].includes(user.role) || !validRevision(version)) throw denied('Business workspace user is unavailable.');
      const versionFilter = user.connectionSwitchVersion === undefined ? { $exists: false } : version;
      const touched = await Users.findOneAndUpdate({ _id: id, role: user.role, connectionSwitchVersion: versionFilter }, { $inc: { connectionSwitchVersion: 1 } }, { new: true, session }).select('_id').lean();
      if (!touched) throw denied('Business workspace selection changed before dispatch.');
    }
    if (actorId !== ownerId && await read(Connections, { userId: actorId, status: 'active' }, session)) throw denied('The actor now works in its own company workspace.');
    const selected = await Connections.findOne({ userId: ownerId, status: 'active' }).sort({ updatedAt: -1 }).select('_id').session(session).maxTimeMS(3000).lean();
    if (!selected || !same(selected._id, scope.connectionId)) throw denied('The selected company connection changed before dispatch.');
  }
  async function policyState(scope, session) {
    const [policy, writer] = session ? [await read(Policies, company(scope), session), await read(Writers, company(scope), session)] : await Promise.all([read(Policies, company(scope)), read(Writers, company(scope))]);
    if (!policy && !writer) return null;
    if (!policy || !writer || policy.contractVersion !== 1 || writer.contractVersion !== 1 || !validRevision(policy.revision) || !validRevision(writer.revision) || !same(policy.connectionId, scope.connectionId) || !same(writer.connectionId, scope.connectionId)) throw denied('Company write coordination needs recovery before another request.');
    return { policy, writer };
  }
  async function audit(id, input, outcome, details, session) {
    await Audits.create([{ _id: id, userId: input.ownerId, actorUserId: input.actorId !== input.ownerId ? input.actorId : undefined, realmId: input.scope.realmId,
      action: outcome === 'started' ? 'QuickBooks write dispatch recorded' : 'QuickBooks write response recorded', actionType: 'manual', outcome: outcome === 'saved' ? 'success' : outcome === 'rejected' ? 'failure' : 'partial',
      inputParams: { environment: input.scope.environment, connectionId: input.scope.connectionId, dispatchKey: input.dispatchKey, requestHash: input.requestHash, entity: input.entity, operation: input.operation }, afterState: details,
    }], { session });
  }
  async function begin({ request, permit, ownerId, actorId }) {
    const scope = scoped(request.scope);
    if (!ID.test(ownerId || '') || !ID.test(actorId || '')) throw denied('The actual write actor and company owner are required.');
    const initial = await policyState(scope);
    if (!initial && !permit) return { coordinated: false };
    if (!initial) throw denied('Business dispatch requires prepared company write coordination.');
    if (initial.policy.state !== 'active') throw denied('Company writes are paused while coordination is prepared.');
    if (request.entity === 'batch') throw denied('Coordinated batch writes need per-item recovery and are not enabled.');
    await assertReady();
    const dispatchKey = permit?.dispatchKey || hash({ scope, requestHash: request.requestHash, nonce: nonce() });
    const receiptId = hash({ scope, dispatchKey }), startAuditId = hash({ receiptId, event: 'started' }).slice(0, 24);
    const ticket = { coordinated: true, scope, receiptId, dispatchKey, requestHash: request.requestHash, kind: permit ? 'business' : 'legacy', ownerId, actorId, entity: request.entity, operation: request.operation };
    return transaction(async session => {
      const state = await policyState(scope, session);
      if (!state || state.policy.state !== 'active') throw denied('Company write preparation or scope changed.');
      const connection = await read(Connections, { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, session);
      if (!connection) throw denied('The company connection is no longer active.');
      const membership = permit || actorId !== ownerId ? await read(Memberships, { userId: actorId, realmId: scope.realmId, status: 'active' }, session) : null;
      if ((permit || actorId !== ownerId) && !membership) throw denied('Company access changed before the request.');
      if (permit) {
        await fenceWorkspace(scope, ownerId, actorId, session);
        if (!normalizePermissions(membership.role, membership.permissionOverrides || []).includes('operations.execute')) throw denied('Current business execution permission is required.');
        // Take a write conflict with concurrent membership changes in this transaction.
        const authorized = await Memberships.findOneAndUpdate({ _id: membership._id, userId: actorId, realmId: scope.realmId, status: 'active', role: membership.role }, { $inc: { businessSetupVersion: 1 } }, { new: true, session }).lean();
        if (!authorized) throw denied('Business execution permission changed before dispatch.');
      }
      const { writer, policy } = state;
      let unresolved;
      if (permit) {
        if (!same(permit.scope?.connectionId, scope.connectionId) || permit.scope?.realmId !== scope.realmId || permit.scope?.environment !== scope.environment || permit.requestHash !== request.requestHash || !same(writer.operationId, permit.operationId) || writer.unresolved?.key !== dispatchKey || writer.unresolved?.logicalKey !== permit.logicalKey || writer.unresolved?.requestHash !== request.requestHash || writer.unresolved?.actorId !== actorId || writer.unresolved?.transportConsumed || request.operation !== 'create') throw denied('This permission does not match the exact unsent business request.');
        const step = await read(Steps, { ...scope, logicalKey: permit.logicalKey, operationId: permit.operationId, state: 'dispatched' }, session);
        const run = await read(Runs, { _id: permit.operationId, ...scope, planHash: writer.planHash, status: { $in: ['reserved', 'running'] } }, session);
        const calendar = await read(Calendars, { ...scope, currentOperationId: permit.operationId, stopRequested: false, pendingCommit: null }, session);
        if (!step || !run || !calendar || !fresh(step.dispatch?.observedAt, now()) || !HASH.test(step.dispatch?.compilationHash || '') || step.dispatch?.compilationHash !== writer.unresolved?.compilationHash || !HASH.test(step.dispatch?.evidenceHash || '') || step.dispatch?.evidenceHash !== writer.unresolved?.evidenceHash || !validRevision(step.dispatch?.observationWriterRevision) || writer.revision !== step.dispatch.observationWriterRevision + 1 || step.entity.toLowerCase() !== request.entity || step.planHash !== run.planHash || step.dispatch?.key !== dispatchKey || step.dispatch?.requestHash !== request.requestHash || calendar.blueprintHash !== run.blueprintHash || calendar.baseline?.status !== 'verified' || calendar.baseline.evidenceHash !== run.baselineHash || calendar.verifiedThrough !== run.expectedCursor || calendar.revision !== run.expectedRevision || !validRevision(run.writerRevision) || !validRevision(run.evidenceRevision) || !validRevision(calendar.writerRevision)) throw denied('Business step, stop state or calendar changed before sending.');
        assertRunApproval(run);
        if (run.leaseToken && (permit.leaseToken !== run.leaseToken || !Number.isFinite(new Date(run.leaseExpiresAt).getTime()) || new Date(run.leaseExpiresAt).getTime() <= now())) throw denied('The operation worker lease changed or expired before sending.');
        if (permit.leaseToken && !run.leaseToken) throw denied('The operation worker lease is no longer held.');
        const touchedRun = await Runs.findOneAndUpdate({ _id: run._id, ...scope, writerRevision: run.writerRevision, evidenceRevision: run.evidenceRevision, status: run.status, ...(run.leaseToken ? { leaseToken: run.leaseToken, leaseExpiresAt: run.leaseExpiresAt } : {}) }, { $inc: { writerRevision: 1, evidenceRevision: 1 }, $set: { verificationCandidateHash: null } }, { new: true, session }).lean();
        const touchedCalendar = await Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, writerRevision: calendar.writerRevision, stopRequested: false, currentOperationId: run._id }, { $inc: { writerRevision: 1 } }, { new: true, session }).lean();
        if (!touchedRun || !touchedCalendar) throw denied('Business ownership changed before sending.');
        unresolved = { ...writer.unresolved, transportConsumed: { receiptId, consumedAt: new Date(now()).toISOString() } };
      } else {
        if (writer.operationId !== null || writer.planHash !== null || writer.unresolved !== null) throw denied('Another operation or unresolved request owns this company.');
        unresolved = { key: dispatchKey, requestHash: request.requestHash, actorId, entity: request.entity, kind: 'legacy', transportConsumed: { receiptId, consumedAt: new Date(now()).toISOString() } };
      }
      const policyTouched = await Policies.findOneAndUpdate({ _id: policy._id, ...scope, state: 'active', revision: policy.revision }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      const writerTouched = await Writers.findOneAndUpdate({ _id: writer._id, ...scope, revision: writer.revision, operationId: writer.operationId, planHash: writer.planHash }, { $set: { unresolved }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!policyTouched || !writerTouched) throw denied('Company write admission changed.');
      await Receipts.create([{ _id: receiptId, contractVersion: 1, ...scope, ownerId, actorId, kind: ticket.kind, ...(permit ? { operationId: permit.operationId, logicalKey: permit.logicalKey } : {}), dispatchKey, requestHash: request.requestHash, entity: request.entity, operation: request.operation, state: 'possibly-sent', observed: null, sentAt: new Date(now()), startAuditId }], { session });
      await audit(startAuditId, { ...ticket, scope }, 'started', { state: 'possibly-sent', receiptId }, session);
      return ticket;
    });
  }
  async function complete(ticket, request, response, intuitTid) {
    if (!ticket?.coordinated) return { outcome: 'uncoordinated' };
    const observed = classifyWriteResponse(request, response, intuitTid);
    const resultAuditId = hash({ receiptId: ticket.receiptId, event: 'response', observed }).slice(0, 24);
    return transaction(async session => {
      const stored = await read(Receipts, { _id: ticket.receiptId, ...ticket.scope, dispatchKey: ticket.dispatchKey, requestHash: request.requestHash }, session);
      if (!stored || stored.state !== 'possibly-sent') throw denied('The request receipt already changed; recover its saved result.', true);
      const state = await policyState(ticket.scope, session), writer = state?.writer;
      if (!writer || writer.unresolved?.key !== ticket.dispatchKey || writer.unresolved?.transportConsumed?.receiptId !== ticket.receiptId) throw denied('The response no longer matches the company request barrier.', true);
      const saved = await Receipts.findOneAndUpdate({ _id: stored._id, state: 'possibly-sent', requestHash: request.requestHash }, { $set: { state: observed.outcome, observed, observedAt: new Date(now()), resultAuditId } }, { new: true, session }).lean();
      if (!saved) throw denied('The response receipt changed while saving.', true);
      if (stored.kind === 'business' && observed.outcome === 'rejected') {
        const step = await read(Steps, { ...ticket.scope, operationId: stored.operationId, logicalKey: stored.logicalKey, state: { $in: ['dispatched', 'unknown'] }, 'dispatch.key': stored.dispatchKey, receipt: null }, session);
        const run = await read(Runs, { _id: stored.operationId, ...ticket.scope, status: { $in: ['reserved', 'running', 'blocked', 'stopped'] } }, session);
        const calendar = await read(Calendars, { ...ticket.scope, currentOperationId: stored.operationId, pendingCommit: null }, session);
        if (!step || !run || !calendar || !validRevision(run.writerRevision) || !validRevision(run.evidenceRevision) || !validRevision(calendar.writerRevision)) throw denied('Rejected dispatch needs operation recovery.', true);
        const rejection = { version: 1, dispatchKey: stored.dispatchKey, requestHash: stored.requestHash, receiptId: stored._id, evidenceHash: hash(observed), httpStatus: observed.httpStatus, faultCodes: observed.faultCodes };
        const rejected = await Steps.findOneAndUpdate({ _id: step._id, ...ticket.scope, logicalKey: stored.logicalKey, state: step.state, revision: step.revision, leaseToken: step.leaseToken }, { $set: { state: 'rejected', rejection, lastAuditId: resultAuditId }, $inc: { revision: 1 } }, { new: true, session }).lean();
        const stopped = await Runs.findOneAndUpdate({ _id: run._id, ...ticket.scope, status: run.status, writerRevision: run.writerRevision, evidenceRevision: run.evidenceRevision }, { $set: { status: run.status === 'stopped' ? 'stopped' : 'blocked', verificationCandidateHash: null }, $inc: { writerRevision: 1, evidenceRevision: 1 } }, { new: true, session }).lean();
        const touched = await Calendars.findOneAndUpdate({ _id: calendar._id, ...ticket.scope, currentOperationId: run._id, writerRevision: calendar.writerRevision }, { $inc: { writerRevision: 1 } }, { new: true, session }).lean();
        if (!rejected || !stopped || !touched) throw denied('Rejected dispatch changed during settlement.', true);
      }
      const unresolved = (stored.kind === 'legacy' && ['saved', 'rejected'].includes(observed.outcome)) || observed.outcome === 'rejected' ? null : { ...writer.unresolved, responseReceiptId: ticket.receiptId };
      const updated = await Writers.findOneAndUpdate({ _id: writer._id, ...ticket.scope, revision: writer.revision, 'unresolved.key': ticket.dispatchKey }, { $set: { unresolved }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!updated) throw denied('The company request changed while saving its response.', true);
      await audit(resultAuditId, ticket, observed.outcome, { state: observed.outcome, receiptId: ticket.receiptId, ...observed }, session);
      return { ...observed, receiptId: ticket.receiptId };
    });
  }
  return { begin, complete };
}
let defaultGate;
function getQboWriteGate() {
  if (defaultGate) return defaultGate;
  const mongoose = require('mongoose');
  const models = { Users: require('../models/User'), Policies: require('../models/CompanyWritePolicy'), Writers: require('../models/CompanyWriter'), Receipts: require('../models/QboWriteReceipt'), Audits: require('../models/AuditLog'), Connections: require('../models/Connection'), Memberships: require('../models/CompanyMembership'), Runs: require('../models/OperationRun'), Calendars: require('../models/BusinessCalendar'), Steps: require('../models/OperationStep') };
  const { createBusinessTransaction } = require('./business-transaction');
  const assertReady = async () => {
    if (mongoose.connection.readyState !== 1) throw denied('Write coordination storage is unavailable.');
    const required = [models.Policies, models.Writers, models.Receipts, models.Audits];
    const names = required.map(model => model.collection.name);
    const collections = await mongoose.connection.db.listCollections({ name: { $in: names } }, { nameOnly: true }).toArray();
    if (collections.length !== names.length) throw denied('Write coordination storage needs explicit preparation.');
    for (const [Model, fields] of [[models.Policies, ['environment', 'realmId']], [models.Writers, ['environment', 'realmId']], [models.Receipts, ['environment', 'realmId', 'dispatchKey']]]) {
      const indexes = await Model.collection.indexes();
      if (!indexes.some(index => index.unique === true && !index.sparse && !index.partialFilterExpression && Object.keys(index.key).join(',') === fields.join(',') && fields.every(key => index.key[key] === 1))) throw denied('Write coordination uniqueness is not installed.');
    }
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw denied('Write coordination requires database transactions.');
  };
  defaultGate = createQboWriteGate({ ...models, transaction: createBusinessTransaction(mongoose.connection), assertReady });
  return defaultGate;
}
module.exports = { createQboWriteGate, getQboWriteGate };
