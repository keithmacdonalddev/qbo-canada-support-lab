'use strict';

// The company owner's decision on a reproduction case's request to delete or void
// a record that existed before the case (see reproduction-engine queueApproval).
// Approval runs exactly the saved change, once, and only if QuickBooks still
// holds the version the owner was shown; anything else changes nothing.

const DECISIONS = new Set(['approve', 'decline']);
const APPROVABLE = new Set(['deleteRecord', 'voidTransaction']);
// Longer than any decision can take (a read and a write, each with rate-limit retries).
const LOCK_MS = 20 * 60 * 1000;
const STALE_CLAIM_MS = LOCK_MS;
const fail = (status, message) => { throw Object.assign(new Error(message), { status, caseDecision: true }); };

function createApprovals(dependencies = {}) {
  const AISession = dependencies.AISession || require('../models/AISession');
  const AIPlan = dependencies.AIPlan || require('../models/AIPlan');
  const Connection = dependencies.Connection || require('../models/Connection');
  const config = dependencies.config || require('../config');
  const createQBOClient = dependencies.createQBOClient || require('./qbo-client').createQBOClient;
  const createAuditEntry = dependencies.createAuditEntry || require('../middleware/auditLogger').createAuditEntry;
  const handlers = dependencies.handlers || require('./ai-tools').toolHandlers;
  // A run still executing in this process, whatever its saved lease says.
  const isActive = dependencies.isActive || ((id) => Boolean(require('./reproduction-runner').waitForIdle(id)));
  const stepFields = (fields) => ({ $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => ['steps.$.' + k, v])) });

  async function decide({ userId, actorId, sessionId, planId, stepNumber, decision }) {
    if (!DECISIONS.has(decision)) fail(400, 'Choose approve or decline.');
    if (![sessionId, planId].every((v) => /^[a-f0-9]{24}$/i.test(String(v))) || !Number.isInteger(Number(stepNumber))) fail(400, 'Unknown change.');
    // Members (including a coding agent's account) can see the request but not grant it.
    if (!actorId || String(actorId) !== String(userId)) fail(403, 'Only the company owner can approve changes to existing records.');
    if (isActive(sessionId)) fail(409, 'Wait for the case run to finish, then decide.');
    const now = Date.now();
    const lock = new Date(now + LOCK_MS);
    // Lock the case for the decision: a run cannot start meanwhile (startCase checks
    // this lock) and a decision cannot start during a run.
    // A run whose execution lease has lapsed was interrupted and is not running.
    const session = await AISession.findOneAndUpdate({
      _id: sessionId, userId, mode: 'reproduce',
      $and: [
        { $or: [{ 'reproduction.status': { $ne: 'running' } }, { 'reproduction.leaseExpiresAt': { $lt: new Date(now) } }] },
        { $or: [{ 'reproduction.decisionLockUntil': { $exists: false } }, { 'reproduction.decisionLockUntil': null },
          { 'reproduction.decisionLockUntil': { $lt: new Date(now) } }] },
      ],
    },{ $set: { 'reproduction.decisionLockUntil': lock } }, { new: true });
    if (!session) {
      const exists = await AISession.findOne({ _id: sessionId, userId, mode: 'reproduce' });
      if (!exists) fail(404, 'Case not found.');
      fail(409, exists.reproduction?.status === 'running' ? 'Wait for the case run to finish, then decide.' : 'Another decision on this case is in progress.');
    }
    try {
      return await decideLocked({ session, userId, actorId, planId, n: Number(stepNumber), decision, now });
    } finally {
      // Release only this decision's own lock.
      await AISession.updateOne({ _id: session._id, 'reproduction.decisionLockUntil': lock }, { $unset: { 'reproduction.decisionLockUntil': 1 } });
    }
  }

  async function decideLocked({ session, userId, actorId, planId, n, decision, now }) {
    if (!session.plans.some((p) => String(p) === String(planId))) fail(404, 'That change is not part of this case.');
    // A decision abandoned by a crash or reload: if nothing was sent it can be
    // decided again; if it may have reached QuickBooks it is never sent again.
    const abandoned = await AIPlan.findOne({ _id: planId, sessionId: session._id, userId, steps: { $elemMatch: {
      stepNumber: n, 'approval.state': 'deciding', 'approval.claimedAt': { $lt: new Date(now - STALE_CLAIM_MS) } } } });
    if (abandoned) {
      const old = abandoned.steps.find((s) => s.stepNumber === n);
      const theirs = { _id: planId, steps: { $elemMatch: { stepNumber: n, 'approval.state': 'deciding', 'approval.claimedAt': old.approval.claimedAt } } };
      if (old.status === 'pending') {
        await AIPlan.updateOne({ _id: planId, steps: { $elemMatch: { ...theirs.steps.$elemMatch, status: 'pending' } } }, stepFields({ 'approval.state': 'needed' }));
      } else {
        const error = 'An earlier approval was interrupted after it may have reached QuickBooks. Check the record in QuickBooks; it will not be sent again.';
        await AIPlan.updateOne(theirs, stepFields({ status: 'failed', error, result: { success: false, outcomeUnknown: true }, 'approval.state': 'unknown' }));
        await AISession.updateOne({ _id: session._id }, { $set: { 'reproduction.outcomeUnknown': true } });
        fail(409, error);
      }
    }
    // Claim the step so a double click or second tab cannot run it twice.
    const claimedAt = new Date(now);
    const plan = await AIPlan.findOneAndUpdate(
      { _id: planId, sessionId: session._id, userId, steps: { $elemMatch: { stepNumber: n, status: 'pending', 'approval.state': 'needed' } } },
      { $set: { 'steps.$.approval.state': 'deciding', 'steps.$.approval.decidedBy': String(actorId), 'steps.$.approval.claimedAt': claimedAt } },
      { new: true });
    if (!plan) fail(409, 'This change has already been decided.');
    // Every later write is to this decision's own claim, so a superseded attempt
    // can never overwrite the record of a newer one.
    const setStep = async (_planId, _n, fields) => {
      const saved = await AIPlan.updateOne({ _id: plan._id, steps: { $elemMatch: { stepNumber: n, 'approval.claimedAt': claimedAt } } }, stepFields(fields));
      if (saved.matchedCount !== 1) fail(409, 'This decision was superseded. Check the case before trying again.');
    };
    const step = plan.steps.find((s) => s.stepNumber === n);
    const input = step.toolInput || {};
    if (!APPROVABLE.has(step.toolName)) {
      await setStep(plan._id, n, { status: 'rejected', 'approval.state': 'declined', 'approval.decidedAt': new Date() });
      fail(400, 'Only deleting or voiding an existing record can be approved here. Nothing was changed.');
    }
    const audit = async (action, details) => {
      const entry = await createAuditEntry(userId, session.realmId, action, {
        aiDriven: true, approvalEvent: plan._id, tool: step.toolName,
        ...details, inputParams: { ...input, caseId: String(session._id), stepNumber: n, ownerDecision: decision },
      });
      if (!entry) console.error('[case approvals] audit entry not saved:', action);
      return entry;
    };

    if (decision === 'decline') {
      await setStep(plan._id, n, { status: 'rejected', 'approval.state': 'declined', 'approval.decidedAt': new Date() });
      await audit('Owner declined case change: ' + step.toolName, { actionType: 'ai_plan_reject', outcome: 'success' });
      return { state: 'declined' };
    }

    const release = () => setStep(plan._id, n, { 'approval.state': 'needed' });
    const connection = await Connection.findOne({ userId, realmId: session.realmId, status: 'active' });
    const environment = session.reproduction?.environment;
    if (!connection || (environment && environment !== config.qbo.environment)) {
      await release();
      fail(409, 'The case company is not connected in the same environment. Nothing was changed.');
    }
    const entity = input.entityType.toLowerCase();
    let qbo;
    let before;
    try {
      qbo = await createQBOClient(connection);
      before = (await qbo.read(entity, input.id))[input.entityType];
    } catch (err) {
      // QuickBooks reports a deleted or missing record as Object Not Found (code 610).
      const missing = qbo && Number(err.status) === 400 && /Object Not Found|\b610\b/i.test(String(err.message));
      if (!missing) {
        await release().catch(() => {});
        throw err;
      }
    }
    if (!before || String(before.SyncToken) !== String(step.approval.syncToken)) {
      const error = before ? 'The record changed in QuickBooks after this was proposed. Nothing was changed.' : 'The record no longer exists in QuickBooks. Nothing was changed.';
      await setStep(plan._id, n, { status: 'failed', error, 'approval.state': 'stale', 'approval.decidedAt': new Date() });
      await audit('Owner approval refused, record changed: ' + step.toolName, { actionType: 'ai_plan_approve', outcome: 'failure', beforeState: before || null });
      return { state: 'stale', error };
    }

    try {
      await setStep(plan._id, n, { status: 'executing' });
    } catch (err) {
      await release().catch(() => {});
      throw err;
    }
    if (!await audit('Owner approved case change: ' + step.toolName, { actionType: 'ai_plan_approve', beforeState: before, outcome: 'partial' })) {
      await setStep(plan._id, n, { status: 'pending', 'approval.state': 'needed' });
      fail(500, 'The approval could not be audited. Nothing was changed.');
    }
    let result;
    try {
      if (step.toolName === 'deleteRecord') {
        const response = await qbo.apiCall('POST', entity + '?operation=delete', { Id: before.Id, SyncToken: before.SyncToken });
        if (String(response?.[input.entityType]?.Id) !== String(input.id) || response[input.entityType]?.status !== 'Deleted') {
          throw new Error('QuickBooks did not return a confirmed deletion receipt.');
        }
        result = { success: true, data: { entityType: input.entityType, id: String(input.id), deleted: true } };
      } else {
        // Void the exact version the owner approved: a later edit conflicts.
        const pinned = new Proxy(qbo, { get(target, key) {
          if (key === 'read') return async (e, id) => (e === entity && String(id) === String(input.id) ? { [input.entityType]: before } : target.read(e, id));
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        result = await handlers.voidTransaction({ entityType: input.entityType, id: input.id, summary: input.summary }, { qbo: pinned });
        if (!result || result.success === false) throw Object.assign(new Error(result?.error || 'QuickBooks refused the change.'), { definite: true });
      }
    } catch (err) {
      const definite = err.definite || (Number(err.status) >= 400 && Number(err.status) < 500);
      // Record the failure even if this attempt was superseded meanwhile.
      await setStep(plan._id, n, { status: 'failed', error: err.message, result: { success: false, outcomeUnknown: !definite },
        'approval.state': 'failed', 'approval.decidedAt': new Date() }).catch((saveErr) => console.error('[case approvals] failure not recorded:', saveErr.message));
      if (!definite) await AISession.updateOne({ _id: session._id }, { $set: { 'reproduction.outcomeUnknown': true } });
      await audit('Owner-approved case change failed: ' + step.toolName, { actionType: 'ai_executed', outcome: 'failure', error: err.message });
      return { state: 'failed', outcomeUnknown: !definite,
        error: definite ? err.message : 'QuickBooks did not confirm the result. Check the record in QuickBooks before doing anything else.' };
    }
    try {
      await setStep(plan._id, n, { status: 'completed', result, executedAt: new Date(),
        'approval.state': 'approved', 'approval.decidedAt': new Date() });
    } catch (err) {
      await audit('Owner-approved change made in QuickBooks but not recorded in the case: ' + step.toolName,
        { actionType: 'ai_executed', afterState: result.data, outcome: 'partial', error: err.message });
      fail(500, 'The change was made in QuickBooks, but the case could not record it. Do not approve it again.');
    }
    await audit('Owner-approved case change saved: ' + step.toolName, { actionType: 'ai_executed', afterState: result.data, outcome: 'success' });
    return { state: 'approved', result };
  }

  return { decide };
}

module.exports = { ...createApprovals(), createApprovals };
