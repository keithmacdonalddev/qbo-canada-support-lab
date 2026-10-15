'use strict';
const { hash, date, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { createContextService } = require('./rebuild-context');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessTransaction } = require('./business-transaction');
const setup = require('./business-storage-setup');
const { assertPeriodControl } = require('./qbo-write-period');
const { businessDate } = require('./business-activity-preview');
const PROFILE = 'continual-business';
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_SETUP_REQUIRED' }); }
function createBusinessSetupService(dependencies = {}) {
  const connection = dependencies.connection || require('mongoose').connection;
  const models = dependencies.models || Object.fromEntries(Object.entries({ Users: 'User', Connections: 'Connection', Memberships: 'CompanyMembership', Policies: 'CompanyWritePolicy', Writers: 'CompanyWriter', Receipts: 'QboWriteReceipt', Audits: 'AuditLog' }).map(([key, name]) => [key, require('../models/' + name)]));
  const resolveContext = dependencies.resolveContext || createContextService().resolve;
  const accessFor = dependencies.accessFor || createBusinessRuntimeAccess;
  const transaction = dependencies.transaction || createBusinessTransaction(connection);
  const now = dependencies.now || (() => Date.now());
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function bind(user, ownerOnly = false) {
    const actorId = String(user.actorId || user.id), ownerId = String(user.id), context = await resolveContext(user);
    if (!context.connection?.connected) fail('Connect the company before preparing business access.');
    const scope = scoped({ realmId: context.connection.realmId, environment: context.environment, connectionId: context.connection.connectionId });
    const access = accessFor({ actorId, ownerId, ...models }); await access.authorize(scope, 'operations.read');
    if (ownerOnly && actorId !== ownerId) fail('Only the connected company owner can prepare storage and write coordination.', 403);
    if (!connection.db) fail('Business storage is unavailable.');
    return { actorId, ownerId, scope, target: { ...scope, ownerId }, access, companyName: context.connection.companyName };
  }
  async function fence(bound, session) {
    const { scope, ownerId, access } = bound;
    await access.authorize(scope, 'operations.execute', { session });
    const owner = await models.Users.updateOne({ _id: ownerId, role: { $in: ['agent', 'supervisor'] } }, { $inc: { connectionSwitchVersion: 1 } }, { session });
    const selected = await models.Connections.updateOne({ _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }, { $inc: { businessSetupVersion: 1 } }, { session });
    const member = await models.Memberships.updateOne({ userId: ownerId, realmId: scope.realmId, status: 'active', role: 'lab-owner' }, { $inc: { businessSetupVersion: 1 } }, { session });
    if ([owner, selected, member].some(row => row.matchedCount !== 1)) fail('Current company-owner authority changed.');
  }
  async function receipt(bound, session) {
    const completed = await (dependencies.assertSetup || setup.assertProfileSetupCompleted)(connection.db, bound.target, PROFILE, session);
    const storage = await (dependencies.inspectStorage || setup.inspectStorage)(connection.db, PROFILE);
    if (storage.some(row => row.create || row.missingIndexes.length)) fail('Prepared business storage changed. Review and restore its exact collections and indexes.');
    return completed;
  }
  async function status(user) {
    const bound = await bind(user), { scope } = bound;
    let storage, setupReceipt = null;
    try { setupReceipt = await receipt(bound); storage = { ready: true }; }
    catch { storage = { ready: false, reason: 'Review and complete business storage preparation.' }; }
    const policy = await read(models.Policies, { environment: scope.environment, realmId: scope.realmId });
    return { ...scope, companyName: bound.companyName, owner: bound.actorId === bound.ownerId, storage, setupReceipt,
      coordination: policy ? { state: policy.state, revision: policy.revision, sameConnection: String(policy.connectionId) === scope.connectionId, periodControl: policy.periodControl || null } : { state: 'unprepared' },
      profile: PROFILE, qboWrites: 0, calendarVerified: false };
  }
  async function preview(user) {
    const bound = await bind(user, true);
    return (dependencies.previewSetup || setup.previewSetup)(connection.db, bound.target, bound.scope.environment, PROFILE);
  }
  async function apply(user, input) {
    if (!input || Object.keys(input).join(',') !== 'planHash' || !/^[a-f0-9]{64}$/.test(input.planHash || '')) fail('Apply the exact reviewed storage preview.', 400);
    const bound = await bind(user, true);
    return (dependencies.applySetup || setup.applySetup)(connection.db, connection.getClient(), bound.target, bound.scope.environment, input.planHash, PROFILE);
  }
  async function prepareCoordination(user) {
    const bound = await bind(user, true), { scope, ownerId } = bound;
    const completed = await receipt(bound), id = scope.environment + ':' + scope.realmId;
    const preparationEvidenceHash = hash({ version: 2, scope, ownerId, setup: completed, dispatch: 'all-writes-require-durable-admission' });
    return transaction(async session => {
      await fence(bound, session); await receipt(bound, session);
      const company = { environment: scope.environment, realmId: scope.realmId };
      const policy = await read(models.Policies, company, session), writer = await read(models.Writers, company, session);
      if (policy || writer) {
        if (!policy || !writer || String(policy.connectionId) !== scope.connectionId || String(writer.connectionId) !== scope.connectionId || policy.preparationEvidenceHash !== preparationEvidenceHash) fail('Existing company coordination requires reviewed recovery; it was not replaced.');
        return { state: policy.state, preparationEvidenceHash, reused: true };
      }
      const auditId = hash({ preparationEvidenceHash, event: 'preparing' }).slice(0, 24);
      await models.Policies.create([{ _id: id, contractVersion: 1, ...scope, state: 'preparing', revision: 0, preparationEvidenceHash }], { session });
      await models.Writers.create([{ _id: id, contractVersion: 1, ...scope, operationId: null, planHash: null, unresolved: null, revision: 0 }], { session });
      await models.Audits.create([{ _id: auditId, userId: ownerId, realmId: scope.realmId, action: 'Company write coordination preparation started', actionType: 'manual', outcome: 'success', afterState: { ...scope, preparationEvidenceHash, qboWrites: 0, calendarVerified: false } }], { session });
      return { state: 'preparing', preparationEvidenceHash, reused: false };
    });
  }
  async function legacyWork(scope, session) {
    if (dependencies.legacyWork) return dependencies.legacyWork(scope, session);
    const queries = [
      ['seedruns', { realmId: scope.realmId, status: { $in: ['pending', 'in_progress'] } }],
      ['generationruns', { realmId: scope.realmId, $or: [{ status: { $in: ['pending', 'in_progress'] } }, { 'steps.state': { $in: ['sending', 'uncertain'] } }] }],
      ['issuepackruns', { realmId: scope.realmId, status: { $in: ['pending', 'in_progress', 'running'] } }],
      ['aisessions', { realmId: scope.realmId, $or: [{ 'reproduction.status': 'running' }, { 'reproduction.outcomeUnknown': true }] }],
      ['aiplans', { realmId: scope.realmId, status: 'executing' }],
    ];
    const blockers = [];
    for (const [collection, filter] of queries) if (await connection.db.collection(collection).findOne(filter, { session, projection: { _id: 1 }, maxTimeMS: 3000 })) blockers.push(collection);
    return blockers;
  }
  async function recordPeriodControls(user, input) {
    if (!input || Object.keys(input).sort().join(',') !== 'closedThrough,evidenceNote,reconciledThrough' || typeof input.evidenceNote !== 'string' || input.evidenceNote.trim().length < 10 || input.evidenceNote.length > 2000) fail('Record both protected dates (or none) and a short evidence note.', 400);
    for (const key of ['closedThrough', 'reconciledThrough']) if (input[key] !== null) {
      try { date(input[key]); } catch { fail('Choose a valid protected accounting date.', 400); }
      if (input[key] > businessDate(new Date(now()))) fail('Protected dates must be elapsed business days.', 400);
    }
    const bound = await bind(user, true), { scope, ownerId } = bound;
    const choice = { version: 1, status: 'owner-recorded', scope, ownerId, closedThrough: input.closedThrough, reconciledThrough: input.reconciledThrough, evidenceNote: input.evidenceNote.trim() };
    return transaction(async session => {
      await fence(bound, session); await receipt(bound, session);
      const company = { environment: scope.environment, realmId: scope.realmId }, policy = await read(models.Policies, company, session), writer = await read(models.Writers, company, session);
      if (!policy || !writer || String(policy.connectionId) !== scope.connectionId || String(writer.connectionId) !== scope.connectionId || !['preparing', 'active'].includes(policy.state)) fail('Prepare company write coordination first.');
      const previous = policy.periodControl;
      if (previous) {
        assertPeriodControl(previous, scope, ownerId);
        const { contentHash, recordedAt, ...oldChoice } = previous;
        if (canonical(oldChoice) === canonical(choice)) return { periodControl: previous, reused: true };
        for (const key of ['closedThrough', 'reconciledThrough']) if (previous[key] && (!choice[key] || choice[key] < previous[key])) fail('Protected dates cannot move backwards through this action. A reviewed reopening process is required.');
      }
      if (writer.operationId !== null || writer.planHash !== null || writer.unresolved !== null) fail('Finish the current operation or recover its uncertain request before changing protected dates.');
      const value = { ...choice, recordedAt: new Date(now()).toISOString() }, periodControl = { ...value, contentHash: hash(value) };
      const saved = await models.Policies.findOneAndUpdate({ _id: policy._id, ...scope, state: policy.state, revision: policy.revision }, { $set: { periodControl }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!saved) fail('Company protected dates changed while saving.');
      await models.Audits.create([{ _id: hash({ periodControl: periodControl.contentHash }).slice(0, 24), userId: ownerId, realmId: scope.realmId, action: 'Company protected accounting dates recorded', actionType: 'manual', outcome: 'success', beforeState: { periodControl: previous || null }, afterState: { periodControl, qboWrites: 0, reconciliationVerifiedByApi: false } }], { session });
      return { periodControl, reused: false };
    });
  }
  async function activateCoordination(user, input) {
    if (!input || Object.keys(input).join(',') !== 'preparationEvidenceHash' || !/^[a-f0-9]{64}$/.test(input.preparationEvidenceHash || '')) fail('Activate the exact reviewed write-coordination preparation.', 400);
    const bound = await bind(user, true), { scope, ownerId } = bound;
    return transaction(async session => {
      await fence(bound, session); await receipt(bound, session);
      const company = { environment: scope.environment, realmId: scope.realmId }, policy = await read(models.Policies, company, session), writer = await read(models.Writers, company, session);
      if (!policy || !writer || String(policy.connectionId) !== scope.connectionId || String(writer.connectionId) !== scope.connectionId || policy.preparationEvidenceHash !== input.preparationEvidenceHash) fail('Exact company coordination is required.');
      if (policy.state === 'active') return { state: 'active', reused: true };
      if (writer.operationId !== null || writer.planHash !== null || writer.unresolved !== null) fail('Exact settled company coordination is required.');
      assertPeriodControl(policy.periodControl, scope, ownerId);
      const blockers = await legacyWork(scope, session);
      if (blockers.length || await read(models.Receipts, { ...scope, state: { $in: ['possibly-sent', 'unknown'] } }, session)) fail('An earlier worker or uncertain request still needs recovery. Finish it before enabling company writes.');
      if (policy.state !== 'preparing') fail('Company preparation changed.');
      const changed = await models.Policies.findOneAndUpdate({ _id: policy._id, ...scope, state: 'preparing', revision: policy.revision }, { $set: { state: 'active' }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!changed) fail('Company preparation changed during activation.');
      await models.Audits.create([{ _id: hash({ preparation: input.preparationEvidenceHash, event: 'active' }).slice(0, 24), userId: ownerId, realmId: scope.realmId, action: 'Company write coordination enabled', actionType: 'manual', outcome: 'success', afterState: { ...scope, preparationEvidenceHash: input.preparationEvidenceHash, quiescentAt: new Date(now()).toISOString(), qboWrites: 0, calendarVerified: false } }], { session });
      return { state: 'active', reused: false };
    });
  }
  return { status, preview, apply, prepareCoordination, recordPeriodControls, activateCoordination };
}
module.exports = { createBusinessSetupService };
