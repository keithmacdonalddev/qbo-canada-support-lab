'use strict';

// Settles reproduction case writes whose outcome is unknown: a step left
// 'executing' when a run stopped, or one QuickBooks never confirmed
// (result.outcomeUnknown). It only READS QuickBooks and never sends a write
// again. A create is matched to the record it made; an update, void or delete is
// judged from the record's current state. Anything it cannot prove stays
// unresolved, with candidates the company owner can choose between.

const { escapeQueryString, unwrapBody, recordSummary } = require('./ai-tools');
const { checkSavedRecord } = require('./reproduction-policy');

const LOCK_MS = 10 * 60 * 1000;
// QuickBooks timestamps come from Intuit's clock, the step time from ours.
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const QUERY_MARGIN_MS = 24 * 60 * 60 * 1000;
// Longest a create request can take to land (five clamped 429 retries plus the call).
const REQUEST_TIMEOUT_MS = 6 * 60 * 1000;
const PAGE = 100;
const MAX_PAGES = 5;
const LIST_TYPES = ['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'Class', 'Department', 'Term'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status, caseReconcile: true }); };
const isUnresolved = (step) => step.status === 'executing' || step.result?.outcomeUnknown === true;
const isNotFound = (err) => Number(err?.status) === 400 && /Object Not Found|\b610\b/i.test(String(err?.message));
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const sameText = (a, b) => typeof b === 'string' && a.toLowerCase() === b.trim().toLowerCase();
const near = (a, b) => Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.005;
const businessLines = (lines) => (Array.isArray(lines) ? lines.filter((line) => line && line.DetailType !== 'SubTotalLineDetail') : []);
const partyOf = (record) => record?.CustomerRef || record?.VendorRef || record?.EntityRef || record?.EmployeeRef || null;

function qboTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// When the step was saved, from its MongoDB subdocument id.
function stepStartedAt(step, fallback) {
  const id = step?._id;
  if (id && typeof id.getTimestamp === 'function') return id.getTimestamp().getTime();
  if (typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)) return parseInt(id.slice(0, 8), 16) * 1000;
  const time = fallback ? new Date(fallback).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

// What the create asked for. Strong keys identify one record; soft keys
// (date and amounts) only confirm it, since QuickBooks may adjust amounts for tax.
function fingerprint(entityType, input) {
  const record = unwrapBody(entityType, input) || {};
  const lines = businessLines(record.Line);
  const party = partyOf(record);
  const strong = {
    name: text(record.DisplayName) || text(record.Name),
    docNumber: text(record.DocNumber),
    privateNote: text(record.PrivateNote),
    party: party?.value != null ? String(party.value) : null,
  };
  // Transfer accounts are shared by many records: supporting evidence only.
  const soft = {
    fromAccount: record.FromAccountRef?.value != null ? String(record.FromAccountRef.value) : null,
    toAccount: record.ToAccountRef?.value != null ? String(record.ToAccountRef.value) : null,
    txnDate: text(record.TxnDate),
    amount: Number.isFinite(Number(record.Amount)) && record.Amount !== null && record.Amount !== '' ? Number(record.Amount) : null,
    totalAmt: Number.isFinite(Number(record.TotalAmt)) && record.TotalAmt !== null && record.TotalAmt !== '' ? Number(record.TotalAmt) : null,
    lineTotal: lines.length && lines.every((line) => Number.isFinite(Number(line.Amount)))
      ? lines.reduce((sum, line) => sum + Number(line.Amount), 0) : null,
  };
  return { strong, soft, hasStrong: Object.values(strong).some((value) => value !== null) };
}

function matchesStrong(record, { strong }) {
  if (strong.name && !sameText(strong.name, record.DisplayName ?? record.Name)) return false;
  if (strong.docNumber && !sameText(strong.docNumber, record.DocNumber)) return false;
  if (strong.privateNote && !sameText(strong.privateNote, record.PrivateNote)) return false;
  if (strong.party && String(partyOf(record)?.value) !== strong.party) return false;
  return true;
}

function matchesSoft(record, { soft }) {
  if (soft.fromAccount && String(record.FromAccountRef?.value) !== soft.fromAccount) return false;
  if (soft.toAccount && String(record.ToAccountRef?.value) !== soft.toAccount) return false;
  if (soft.txnDate && record.TxnDate !== soft.txnDate) return false;
  if (soft.amount !== null && !near(soft.amount, record.Amount)) return false;
  if (soft.totalAmt !== null && !near(soft.totalAmt, record.TotalAmt)) return false;
  if (soft.lineTotal !== null && !near(soft.lineTotal, businessLines(record.Line).reduce((sum, line) => sum + (Number(line.Amount) || 0), 0))) return false;
  return true;
}

function candidateSummary(record) {
  const party = partyOf(record);
  return {
    id: String(record.Id), docNumber: record.DocNumber || null, name: record.DisplayName || record.Name || null,
    txnDate: record.TxnDate || null, totalAmt: record.TotalAmt ?? record.Amount ?? null,
    party: party ? party.name || String(party.value) : null, createdAt: record.MetaData?.CreateTime || null,
  };
}

// Is every field the update asked for now on the record? Reference fields are
// compared by Id; Line must hold exactly the requested business lines.
function holds(expected, actual, key) {
  if (key === 'Line') {
    const want = businessLines(expected);
    const have = businessLines(actual);
    if (want.length !== have.length) return false;
    return want.every((line, i) => holds(line, line?.Id != null ? have.find((h) => String(h?.Id) === String(line.Id)) : have[i]));
  }
  if (expected === null || expected === undefined) return actual === null || actual === undefined || actual === '';
  if (typeof expected === 'number') return near(expected, actual);
  if (typeof expected === 'boolean') return actual === expected || String(actual) === String(expected);
  if (typeof expected === 'string') {
    if (typeof actual === 'number') return near(expected, actual);
    return actual !== null && actual !== undefined && String(actual).trim() === expected.trim();
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length >= expected.length && expected.every((item, i) => holds(item, actual[i]));
  }
  if (typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(expected, 'value') && Object.keys(expected).every((k) => ['value', 'name', 'type'].includes(k))) {
      return String(actual.value) === String(expected.value);
    }
    return Object.entries(expected).every(([k, v]) => holds(v, actual[k], k));
  }
  return false;
}

function createReconciler(dependencies = {}) {
  const AISession = dependencies.AISession || require('../models/AISession');
  const AIPlan = dependencies.AIPlan || require('../models/AIPlan');
  const Connection = dependencies.Connection || require('../models/Connection');
  const config = dependencies.config || require('../config');
  const createQBOClient = dependencies.createQBOClient || require('./qbo-client').createQBOClient;
  const createAuditEntry = dependencies.createAuditEntry || require('../middleware/auditLogger').createAuditEntry;
  // A run still executing in this process, whatever its saved lease says.
  const isActive = dependencies.isActive || ((id) => Boolean(require('./reproduction-runner').waitForIdle(id)));
  const now = dependencies.now || (() => Date.now());
  const stepFields = (fields) => ({ $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => ['steps.$.' + k, v])) });

  /**
   * @param {{ userId, actorId, sessionId, selections?: Array<{ planId, stepNumber, recordId }> }} request
   *   selections: the owner's choice for a create the server could not match on its
   *   own: a candidate record Id, or 'none' when nothing was created.
   */
  async function reconcile({ userId, actorId, sessionId, selections = [] }) {
    if (!/^[a-f0-9]{24}$/i.test(String(sessionId))) fail(400, 'Unknown case.');
    if (!Array.isArray(selections) || selections.length > 50) fail(400, 'Invalid selections.');
    // Members (including a coding agent's account) can see the state but not settle it.
    if (!actorId || String(actorId) !== String(userId)) fail(403, 'Only the company owner can reconcile this case.');
    if (isActive(sessionId)) fail(409, 'Wait for the case run to finish, then reconcile.');
    const lock = new Date(now() + LOCK_MS);
    // The same lock as owner approvals: no run or decision can start meanwhile.
    const session = await AISession.findOneAndUpdate({
      _id: sessionId, userId, mode: 'reproduce',
      $and: [
        { $or: [{ 'reproduction.status': { $ne: 'running' } }, { 'reproduction.leaseExpiresAt': { $lt: new Date(now()) } }] },
        { $or: [{ 'reproduction.decisionLockUntil': { $exists: false } }, { 'reproduction.decisionLockUntil': null },
          { 'reproduction.decisionLockUntil': { $lt: new Date(now()) } }] },
      ],
    }, { $set: { 'reproduction.decisionLockUntil': lock } }, { new: true });
    if (!session) {
      const exists = await AISession.findOne({ _id: sessionId, userId, mode: 'reproduce' });
      if (!exists) fail(404, 'Case not found.');
      fail(409, exists.reproduction?.status === 'running' ? 'Wait for the case run to finish, then reconcile.' : 'Another decision on this case is in progress.');
    }
    try {
      return await reconcileLocked({ session, userId, selections });
    } finally {
      await AISession.updateOne({ _id: session._id, 'reproduction.decisionLockUntil': lock }, { $unset: { 'reproduction.decisionLockUntil': 1 } });
    }
  }

  async function reconcileLocked({ session, userId, selections }) {
    const state = session.reproduction || {};
    const plans = await AIPlan.find({ _id: { $in: session.plans || [] }, sessionId: session._id, userId });
    const pending = [];
    for (const plan of plans) for (const step of plan.steps || []) if (isUnresolved(step)) pending.push({ plan, step });
    const resolved = [];
    const unresolved = [];
    if (pending.length) {
      const connection = await Connection.findOne({ _id: state.connectionId, userId, realmId: session.realmId, status: 'active' });
      if (!connection || (state.environment && state.environment !== config.qbo.environment)) {
        fail(409, 'The case company is not connected in the same environment. Reconnect it, then reconcile.');
      }
      const qbo = await createQBOClient(connection);
      // Records the case already owns cannot be the product of another step.
      const owned = new Set(plans.flatMap((plan) => (plan.steps || [])
        .filter((s) => s.status === 'completed' && s.toolName === 'createRecord' && s.result?.data?.id)
        .map((s) => s.toolInput?.entityType + ':' + String(s.result.data.id))));
      for (const { plan, step } of pending) {
        const selection = selections.find((s) => String(s?.planId) === String(plan._id) && Number(s?.stepNumber) === step.stepNumber);
        let decision;
        try {
          decision = await decide({ qbo, session, step, owned, selection });
        } catch (err) {
          decision = { reason: 'QuickBooks could not be read: ' + String(err.message).slice(0, 200) };
        }
        const where = { planId: String(plan._id), stepNumber: step.stepNumber, toolName: step.toolName,
          entityType: step.toolInput?.entityType || null };
        if (!decision.status) { unresolved.push({ ...where, id: step.toolInput?.id || null, reason: decision.reason, candidates: decision.candidates }); continue; }
        const saved = await save({ session, userId, plan, step, decision, selection });
        if (saved) {
          step.status = saved.status;
          step.result = saved.result;
          if (decision.status === 'completed' && step.toolName === 'createRecord') owned.add(where.entityType + ':' + decision.result.data.id);
          resolved.push({ ...where, id: decision.result?.data?.id || step.toolInput?.id || null, decision: decision.result.reconciled, status: decision.status });
        } else {
          unresolved.push({ ...where, reason: 'The decision could not be audited or the step changed meanwhile. Nothing was recorded; try again.' });
        }
      }
    }
    const outcomeUnknown = unresolved.length > 0;
    const update = {};
    // Same rebuild as a continuation (reproduction-runner startCase), so the case
    // page lists a matched record before the next run.
    const casePlan = plans.find((plan) => String(plan._id) === String(state.planId));
    if (resolved.length && casePlan) {
      const ownedRecords = [];
      for (const step of casePlan.steps || []) {
        if (step.status !== 'completed') continue;
        if (step.toolName === 'createRecord' && step.result?.data?.id) {
          ownedRecords.push({ entityType: step.toolInput.entityType, id: String(step.result.data.id), stepNumber: step.stepNumber });
        }
        if (step.toolName === 'deleteRecord') {
          const record = ownedRecords.find((item) => item.entityType === step.toolInput.entityType && item.id === String(step.toolInput.id));
          if (record) record.deleted = true;
        }
      }
      update['reproduction.ownedRecords'] = ownedRecords;
    }
    if (!outcomeUnknown && state.outcomeUnknown) update['reproduction.outcomeUnknown'] = false;
    if (Object.keys(update).length) await AISession.updateOne({ _id: session._id, userId }, { $set: update });
    return { resolved, unresolved, outcomeUnknown };
  }

  async function decide({ qbo, session, step, owned, selection }) {
    const input = step.toolInput || {};
    const entityType = input.entityType;
    if (!/^[A-Z][A-Za-z]+$/.test(String(entityType || ''))) return { reason: 'The step has no record type to check.' };
    if (step.toolName === 'createRecord') return decideCreate({ qbo, session, step, owned, selection });
    if (!/^\d+$/.test(String(input.id ?? ''))) return { reason: 'The step has no record Id to check.' };
    let current = null;
    try {
      current = (await qbo.read(entityType.toLowerCase(), String(input.id)))?.[entityType] || null;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const before = step.beforeSyncToken ?? step.result?.beforeSyncToken ?? step.approval?.syncToken;
    const unchanged = current && before !== undefined && before !== null && String(current.SyncToken) === String(before);
    if (step.toolName === 'deleteRecord') {
      if (!current || current.status === 'Deleted') {
        return { status: 'completed', result: { success: true, data: { entityType, id: String(input.id), deleted: true }, reconciled: 'deleted' } };
      }
      return { status: 'failed', error: 'Reconciled: the record still exists in QuickBooks, so it was not deleted.', result: { success: false, reconciled: 'not_applied' } };
    }
    if (!current) return { reason: 'The record no longer exists in QuickBooks, so the change cannot be judged.' };
    if (unchanged) {
      return { status: 'failed', error: 'Reconciled: the record is unchanged in QuickBooks, so the change was not applied.', result: { success: false, reconciled: 'not_applied' } };
    }
    if (step.toolName === 'voidTransaction') {
      const zero = near(0, current.TotalAmt);
      if (zero && /void/i.test(String(current.PrivateNote || ''))) {
        return { status: 'completed', result: { success: true, data: recordSummary(entityType, current), reconciled: 'applied' } };
      }
      if (!zero) return { status: 'failed', error: 'Reconciled: the transaction still has its amount, so it was not voided.', result: { success: false, reconciled: 'not_applied' } };
      return { reason: 'The transaction has a zero total but no void note, so whether it was voided cannot be told.' };
    }
    if (step.toolName === 'updateRecord') {
      const { replaceAllLines: _flag, ...changes } = unwrapBody(entityType, input.changes) || {};
      const fields = Object.entries(changes).filter(([key]) => !['Id', 'SyncToken', 'sparse', 'MetaData'].includes(key));
      if (!fields.length) return { reason: 'The update named no fields to compare.' };
      if (fields.every(([key, value]) => holds(value, current[key], key))) {
        return { status: 'completed', result: { success: true, data: recordSummary(entityType, current), reconciled: 'applied' } };
      }
      // A newer version that does not hold the change was edited by someone else.
      if (before !== undefined && before !== null) return { reason: 'The record changed in QuickBooks but does not hold the requested values; check it in QuickBooks.' };
      return { status: 'failed', error: 'Reconciled: the record does not hold the requested values, so the change was not applied.', result: { success: false, reconciled: 'not_applied' } };
    }
    return { reason: 'This kind of change cannot be reconciled automatically.' };
  }

  async function decideCreate({ qbo, session, step, owned, selection }) {
    const entityType = step.toolInput.entityType;
    const startedAt = stepStartedAt(step, session.reproduction?.startedAt);
    if (!startedAt) return { reason: 'The time of this change is unknown, so its record cannot be matched.' };
    const since = startedAt - CLOCK_SKEW_MS;
    const until = startedAt + REQUEST_TIMEOUT_MS + CLOCK_SKEW_MS;
    const search = await recordsCreatedSince(qbo, entityType, since, until);
    if (search.error) return { reason: 'QuickBooks could not be searched: ' + search.error };
    const print = fingerprint(entityType, step.toolInput.record);
    const fresh = search.records.filter((r) => !owned.has(entityType + ':' + String(r.Id)));
    const strong = fresh.filter((r) => matchesStrong(r, print));
    const full = strong.filter((r) => matchesSoft(r, print));
    const candidates = (full.length ? full : strong).slice(0, 10);
    // A matched record becomes case-owned, so its relationships must satisfy the
    // same rules as a record the case edits (reproduction-policy).
    const ownedList = [...owned].map((key) => { const [type, id] = key.split(':'); return { entityType: type, id }; });
    const found = (record, how) => {
      try {
        checkSavedRecord(record, ownedList, entityType);
      } catch (err) {
        return { reason: 'Record ' + record.Id + ' cannot belong to this case: ' + err.message, candidates: candidates.map(candidateSummary) };
      }
      return { status: 'completed', result: { success: true, data: recordSummary(entityType, record), reconciled: how } };
    };
    const none = (how) => ({ status: 'failed', error: 'Reconciled: QuickBooks has no record from this change, so it was not created.', result: { success: false, reconciled: how } });
    const noIdentity = 'The attempted create had no identifying field (name, number, memo or party), so no record can be confirmed as its result. Check QuickBooks; only "none" (nothing was created) can be chosen here.';

    if (selection) {
      if (selection.recordId === 'none') return none('owner_confirmed_none');
      if (!print.hasStrong) return { reason: noIdentity, candidates: candidates.map(candidateSummary) };
      const chosen = candidates.find((r) => String(r.Id) === String(selection.recordId));
      if (chosen) return found(chosen, 'owner_selected');
      return { reason: 'The selected record is no longer a candidate for this change.', candidates: candidates.map(candidateSummary) };
    }
    if (print.hasStrong && full.length === 1 && search.covered) return found(full[0], 'found');
    if (!strong.length && search.covered) return none('not_found');
    if (!print.hasStrong) return { reason: noIdentity, candidates: candidates.map(candidateSummary) };
    if (!search.covered) return { reason: 'Too many records were created around this change to be sure. Choose the record, or confirm none was created.', candidates: candidates.map(candidateSummary) };
    return { reason: candidates.length > 1 ? 'More than one record could be the result of this change. Choose the right one, or confirm none was created.'
      : 'The match is not certain. Confirm the record, or confirm none was created.', candidates: candidates.map(candidateSummary) };
  }

  // Records of a type created since a time, newest first, read in bounded pages.
  // QuickBooks is asked for a day more than needed, so a misread time zone can
  // only add candidates, never hide the record; the exact window is applied here.
  // covered: every record created in [since, until] was seen.
  async function recordsCreatedSince(qbo, entityType, since, until) {
    const conditions = [`MetaData.CreateTime >= '${escapeQueryString(qboTime(since - QUERY_MARGIN_MS))}'`];
    if (LIST_TYPES.includes(entityType)) conditions.push('Active IN (true, false)');
    const base = `SELECT * FROM ${entityType} WHERE ${conditions.join(' AND ')}`;
    const createdAt = (r) => new Date(r.MetaData?.CreateTime).getTime();
    // A record without a readable creation time stays a candidate.
    const inWindow = (r) => !Number.isFinite(createdAt(r)) || (createdAt(r) >= since && createdAt(r) <= until);
    for (const order of [' ORDERBY MetaData.CreateTime DESC', '']) {
      const records = [];
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await qbo.query(`${base}${order} STARTPOSITION ${page * PAGE + 1} MAXRESULTS ${PAGE}`);
          const rows = result?.QueryResponse?.[entityType] || [];
          records.push(...rows);
          if (rows.length < PAGE) return { records: records.filter(inWindow), covered: true };
        }
        // Newest first: the window is covered once a page reaches back before it.
        const oldest = records.length ? createdAt(records[records.length - 1]) : NaN;
        return { records: records.filter(inWindow), covered: Boolean(order) && Number.isFinite(oldest) && oldest < since };
      } catch (err) {
        // Some types will not sort this way; try once unsorted.
        if (order && Number(err?.status) === 400) continue;
        return { error: String(err.message).slice(0, 200) };
      }
    }
    return { error: 'QuickBooks rejected the search.' };
  }

  async function save({ session, userId, plan, step, decision, selection }) {
    const reconciledAt = new Date(now());
    const result = { ...decision.result, reconciledAt, reconciledBy: String(userId) };
    const fields = { status: decision.status, result };
    if (decision.status === 'completed') fields.executedAt = reconciledAt;
    if (decision.error) fields.error = decision.error;
    if (step.approval) fields['approval.state'] = decision.status === 'completed' ? 'approved' : 'failed';
    const entry = await createAuditEntry(userId, session.realmId, `Case write reconciled: ${step.toolName} ${result.reconciled}`, {
      actionType: 'ai_plan', tool: step.toolName, approvalEvent: plan._id, outcome: decision.status === 'completed' ? 'success' : 'failure',
      inputParams: { caseId: String(session._id), planId: String(plan._id), stepNumber: step.stepNumber,
        entityType: step.toolInput?.entityType, id: step.toolInput?.id, reconcile: result.reconciled,
        ...(selection ? { ownerSelection: String(selection.recordId) } : {}) },
      beforeState: { status: step.status, result: step.result || null },
      afterState: { status: decision.status, result },
    });
    if (!entry) return false;
    const saved = await AIPlan.updateOne({ _id: plan._id, sessionId: session._id, userId,
      steps: { $elemMatch: { stepNumber: step.stepNumber, status: step.status } } }, stepFields(fields));
    return saved?.matchedCount === 1 ? fields : null;
  }

  return { reconcile };
}

module.exports = { ...createReconciler(), createReconciler, _internal: { fingerprint, matchesStrong, matchesSoft, holds, stepStartedAt, qboTime } };
