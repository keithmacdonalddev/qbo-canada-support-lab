'use strict';
const { hash, canonical, date, shift } = require('./business-calendar');
const FRESH_MS = 5 * 60 * 1000;
function problem(message, status = 409) { return Object.assign(new Error(message), { status }); }
function same(a, b) { return String(a) === String(b); }
function validHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function requireDate(value) { try { date(value); } catch { throw problem('Business period has an invalid date'); } }
function scopeFilter(scope) {
  if (!scope || typeof scope.realmId !== 'string' || !/^\d{1,30}$/.test(scope.realmId) || !['production', 'sandbox'].includes(scope.environment) || typeof scope.connectionId !== 'string' || !/^[a-f0-9]{24}$/i.test(scope.connectionId)) throw problem('Exact connected company scope is required', 400);
  return { realmId: scope.realmId, environment: scope.environment, connectionId: scope.connectionId };
}
function assertRun(run, scope) {
  const filter = scopeFilter(scope);
  if (!run || run.contractVersion !== 1 || Object.entries(filter).some(([key, value]) => !same(run[key], value))) throw problem('Operation does not belong to this company connection');
  requireDate(run.fromDate); requireDate(run.throughDate);
  if (run.fromDate > run.throughDate || !validHash(run.planHash) || !validHash(run.blueprintHash) || !validHash(run.baselineHash) || !validHash(run.expectedRecordSetHash)) throw problem('Operation has invalid immutable evidence');
  if (!Number.isSafeInteger(run.expectedRevision) || run.expectedRevision < 0 || !Number.isSafeInteger(run.recordCount) || run.recordCount < 0 || run.recordCount > 10000) throw problem('Operation has invalid progress bounds');
  if (!Array.isArray(run.requiredAssertions) || !run.requiredAssertions.length || run.requiredAssertions.length > 100 || run.requiredAssertions.some(check => !check || typeof check.key !== 'string' || !check.key || check.key.length > 100 || !['accrual-ledger', 'open-balances-at-date', 'manual-confirmation', 'record-readback'].includes(check.evidenceType) || check.currency !== 'CAD' || (check.evidenceType === 'accrual-ledger' && check.basis !== 'Accrual')) || new Set(run.requiredAssertions.map(check => check.key)).size !== run.requiredAssertions.length) throw problem('Operation needs exact named verification requirements');
  if (run.expectedCursor !== null) {
    requireDate(run.expectedCursor);
    if (shift(run.expectedCursor, 1) !== run.fromDate) throw problem('Business period must immediately follow the verified cursor');
  }
}
function assertRunApproval(run) {
  const approval = run?.approval, stamp = typeof approval?.approvedAt === 'string' ? Date.parse(approval.approvedAt) : NaN;
  if (!approval || !validHash(run.planHash) || approval.planHash !== run.planHash || !validHash(approval.fenceHash) || typeof approval.auditId !== 'string' || !approval.auditId || approval.auditId.length > 100 || typeof approval.actorId !== 'string' || !/^[a-f0-9]{24}$/.test(approval.actorId) || !Number.isFinite(stamp) || new Date(stamp).toISOString() !== approval.approvedAt) throw problem('Operation needs its exact durable approval before execution');
}
function fresh(value, now) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false; const stamp = Date.parse(value); return Number.isFinite(stamp) && [new Date(stamp).toISOString(), new Date(stamp).toISOString().replace('.000Z', 'Z')].includes(value) && stamp <= now && now - stamp <= FRESH_MS; }
function validatePeriodProof(run, proof, now = Date.now()) {
  assertRun(run, { realmId: run.realmId, environment: run.environment, connectionId: String(run.connectionId) });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (run.throughDate > today) throw problem('A future business period cannot be verified');
  if (proof && Buffer.byteLength(canonical(proof)) > 8000000) throw problem('Period evidence exceeds the storage budget');
  if (!proof || proof.version !== 1 || proof.complete !== true || proof.planHash !== run.planHash || proof.blueprintHash !== run.blueprintHash || proof.baselineHash !== run.baselineHash || !same(proof.operationId, run._id) || proof.realmId !== run.realmId || proof.environment !== run.environment || !same(proof.connectionId, run.connectionId) || proof.fromDate !== run.fromDate || proof.throughDate !== run.throughDate) throw problem('Verification must match the exact operation, company and period');
  if (!validHash(run.expectedRecordSetHash) || !fresh(proof.observedAt, now) || !Array.isArray(proof.records) || proof.records.length !== run.recordCount || !validHash(proof.expectedRecordSetHash)) throw problem('Record verification is incomplete or stale');
  const logical = new Set(), physical = new Set();
  for (const record of proof.records) {
    if (!record || !validHash(record.logicalKey) || !validHash(record.fingerprint) || !validHash(record.observedHash) || record.state !== 'verified' || typeof record.entity !== 'string' || !record.entity || typeof record.qboId !== 'string' || !record.qboId || typeof record.syncToken !== 'string' || !record.syncToken || typeof record.auditId !== 'string' || !record.auditId || !fresh(record.observedAt, now) || (!Array.isArray(record.relationships) || record.relationships.length > 20)) throw problem('Every managed record needs fresh saved content, version, relationship and audit evidence');
    const id = canonical([record.entity, record.qboId]);
    if (logical.has(record.logicalKey) || physical.has(id)) throw problem('Record verification contains duplicate identities');
    logical.add(record.logicalKey); physical.add(id);
  }
  const expectations = proof.records.map(record => ({ logicalKey: record.logicalKey, entity: record.entity, fingerprint: record.fingerprint, relationships: record.relationships.map(link => link.logicalKey).sort() })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
  if (hash(expectations) !== proof.expectedRecordSetHash || proof.expectedRecordSetHash !== run.expectedRecordSetHash) throw problem('Verified records differ from the saved operation record set');
  const recordSetHash = hash([...proof.records].sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)));
  const records = new Map(proof.records.map(record => [record.logicalKey, record]));
  for (const record of proof.records) for (const link of record.relationships) {
    const parent = records.get(link.logicalKey);
    if (!parent || parent.qboId !== link.qboId || parent.entity !== link.entity || parent.syncToken !== link.syncToken) throw problem('Verified relationships do not match the observed record versions');
  }
  if (!Array.isArray(proof.assertions) || proof.assertions.length !== run.requiredAssertions.length) throw problem('Required business assertions are incomplete');
  const assertions = new Set();
  for (const assertion of proof.assertions) {
    const requirement = run.requiredAssertions.find(check => check.key === assertion?.key);
    if (!assertion || !requirement || requirement.evidenceType !== assertion.evidenceType || requirement.currency !== assertion.currency || (requirement.basis ?? null) !== (assertion.basis ?? null) || assertions.has(assertion.key) || assertion.status !== 'passed' || assertion.recordSetHash !== recordSetHash || !validHash(assertion.sourceHash) || !fresh(assertion.observedAt, now) || assertion.fromDate !== run.fromDate || assertion.throughDate !== run.throughDate || assertion.currency !== 'CAD' || !['accrual-ledger', 'open-balances-at-date', 'manual-confirmation', 'record-readback'].includes(assertion.evidenceType)) throw problem('Named business checks are missing, failed, stale or refer to different record evidence');
    if (assertion.evidenceType === 'accrual-ledger' && assertion.basis !== 'Accrual') throw problem('Ledger checks require an explicit accrual basis');
    if (proof.records.some(record => Date.parse(record.observedAt) > Date.parse(assertion.observedAt))) throw problem('Business checks must follow the record observations they certify');
    assertions.add(assertion.key);
  }
  if (Buffer.byteLength(canonical(proof)) > 8000000) throw problem('Period evidence exceeds the storage budget');
  const evidenceHash = hash(proof);
  if (run.verificationCandidateHash !== evidenceHash || !Number.isSafeInteger(run.evidenceRevision) || run.evidenceRevision < 1) throw problem('Verification differs from the frozen operation evidence revision');
  return { evidenceHash, evidenceRevision: run.evidenceRevision, recordSetHash, observedAt: proof.observedAt };
}

// Internal persistence boundary; intentionally no default authorization/evidence adapters.
// No public route may pass client-supplied verification claims into loadProof.
function createBusinessPeriodStore({ Calendars, Runs, Writer, loadProof, authorize, writeAudit, assertReady, transaction, now = () => Date.now() }) {
  for (const fn of [loadProof, authorize, writeAudit, assertReady, transaction, now]) if (typeof fn !== 'function') throw new TypeError('Business period store requires trusted adapters');
  if (!Writer || ['reserve', 'assertSettled', 'release'].some(key => typeof Writer[key] !== 'function')) throw new TypeError('Business period storage requires a company-writer coordinator');
  const calendarId = scope => scope.environment + ':' + scope.realmId;
  async function authority(scope, action) {
    scopeFilter(scope); await assertReady();
    const actor = await authorize(scope, action);
    if (!actor || typeof actor.actorId !== 'string' || !actor.actorId) throw problem('Business operation permission is required', 403);
    return actor;
  }
  async function audit(eventKey, details) {
    const receipt = await writeAudit(eventKey, details);
    if (!receipt?.id || receipt.eventKey !== eventKey) throw problem('Durable operation audit could not be recorded');
    return String(receipt.id);
  }
  async function readRun(id, scope) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id)) throw problem('A valid operation identifier is required', 400);
    const run = await Runs.findOne({ _id: id, ...scopeFilter(scope) }).lean(); assertRun(run, scope); assertRunApproval(run); return run;
  }
  function matchingCalendar(run, scope) {
    return { _id: calendarId(scope), ...scopeFilter(scope), businessKey: run.businessKey, blueprintId: run.blueprintId, blueprintHash: run.blueprintHash, 'baseline.status': 'verified', 'baseline.evidenceHash': run.baselineHash, verifiedThrough: run.expectedCursor, revision: run.expectedRevision, stopRequested: false };
  }
  async function repair(scope) {
    const actor = await authority(scope, 'operations.recover');
    const calendar = await Calendars.findOne({ _id: calendarId(scope), ...scopeFilter(scope) }).lean();
    if (!calendar?.pendingCommit) return calendar;
    const commit = calendar.pendingCommit;
    const run = await readRun(String(commit.operationId), scope);
    if (typeof commit.actorId !== 'string' || !commit.actorId || !validHash(commit.recordSetHash) || !validHash(commit.evidenceHash) || calendar.businessKey !== run.businessKey || calendar.blueprintHash !== run.blueprintHash || calendar.baseline?.evidenceHash !== run.baselineHash || commit.planHash !== run.planHash || commit.blueprintHash !== run.blueprintHash || calendar.verifiedThrough !== run.throughDate || calendar.revision !== run.expectedRevision + 1 || !same(calendar.currentOperationId, run._id)) throw problem('Calendar commit requires evidence recovery before more activity');
    const auditId = await audit('business-period:' + run._id + ':committed', { ...scope, actorId: commit.actorId, action: 'Business period verified', operationId: String(run._id), evidenceHash: commit.evidenceHash, throughDate: run.throughDate });
    const repaired = await Runs.findOneAndUpdate({ _id: run._id, ...scopeFilter(scope), planHash: commit.planHash, blueprintHash: commit.blueprintHash, status: { $in: ['committing', 'verified'] }, evidenceRevision: commit.evidenceRevision, verificationCandidateHash: commit.evidenceHash, $or: [{ verification: null }, { 'verification.evidenceHash': commit.evidenceHash }] }, { $set: { status: 'verified', leaseToken: null, leaseExpiresAt: null, verification: { ...commit, completionAuditId: auditId } } }, { new: true }).lean();
    if (!repaired) throw problem('Operation receipt changed during calendar recovery');
    await authority(scope, 'operations.recover');
    return transaction(async session => {
      const attemptActor = await authority(scope, 'operations.recover');
      if (attemptActor.actorId !== actor.actorId) throw problem('Recovery actor changed before writer release', 403);
      await Writer.release(run, scope, session);
      const cleared = await Calendars.findOneAndUpdate({ _id: calendar._id, ...scopeFilter(scope), revision: calendar.revision, 'pendingCommit.operationId': commit.operationId, 'pendingCommit.evidenceHash': commit.evidenceHash, currentOperationId: run._id }, { $set: { pendingCommit: null, currentOperationId: null, lastVerifiedOperationId: run._id } }, { new: true, session }).lean();
      if (!cleared) throw problem('Calendar changed during receipt recovery');
      return cleared;
    });
  }
  async function reserve(id, scope) {
    const actor = await authority(scope, 'operations.execute');
    const run = await readRun(id, scope);
    if (!['approved', 'reserved'].includes(run.status)) throw problem('Only the exact approved operation may reserve the business calendar');
    const calendar = await repair(scope);
    if (!calendar || (run.expectedCursor === null && run.fromDate !== calendar.openingDate)) throw problem('An explicit verified baseline and continuous starting date are required');
    await audit('business-period:' + run._id + ':reservation', { ...scope, actorId: actor.actorId, action: 'Business period reservation prepared', operationId: String(run._id), planHash: run.planHash });
    await authority(scope, 'operations.execute');
    return transaction(async session => {
      const attemptActor = await authority(scope, 'operations.execute');
      if (attemptActor.actorId !== actor.actorId) throw problem('Operation actor changed before reservation', 403);
      const exactRun = { _id: run._id, ...scopeFilter(scope), planHash: run.planHash, blueprintHash: run.blueprintHash, expectedRevision: run.expectedRevision, expectedCursor: run.expectedCursor };
      const claimed = await Runs.findOneAndUpdate({ ...exactRun, status: 'approved' }, { $set: { status: 'reserved' } }, { new: true, session }).lean();
      if (!claimed) {
        const existingRun = await Runs.findOne({ ...exactRun, status: 'reserved' }).session(session).lean();
        const existingCalendar = await Calendars.findOne({ ...matchingCalendar(run, scope), currentOperationId: run._id, pendingCommit: null }).session(session).lean();
        if (!existingRun || !existingCalendar) throw problem('Business calendar is busy, stopped, changed or not yet verified');
        assertRunApproval(existingRun);
        await Writer.reserve(run, scope, session);
        return existingCalendar;
      }
      assertRunApproval(claimed);
      const reserved = await Calendars.findOneAndUpdate({ ...matchingCalendar(run, scope), currentOperationId: null, pendingCommit: null }, { $set: { currentOperationId: run._id } }, { new: true, session }).lean();
      if (!reserved) throw problem('Business calendar is busy, stopped, changed or not yet verified');
      await Writer.reserve(run, scope, session);
      return reserved;
    });
  }

  async function finish(id, scope, { leaseToken } = {}) {
    const assertLease = value => {
      if (value?.leaseToken ? (value.leaseToken !== leaseToken || !Number.isFinite(new Date(value.leaseExpiresAt).getTime()) || new Date(value.leaseExpiresAt).getTime() <= now()) : leaseToken !== undefined) throw problem('The operation worker lease changed or expired before completion');
    };
    const actor = await authority(scope, 'operations.verify');
    const run = await readRun(id, scope);
    const calendar = await Calendars.findOne({ _id: calendarId(scope), ...scopeFilter(scope) }).lean();
    if (calendar?.pendingCommit && same(calendar.pendingCommit.operationId, id)) return repair(scope);
    if (run.status === 'verified') return calendar;
    assertLease(run);
    if (run.status !== 'awaiting-evidence') throw problem('Operation must finish its saved record checks before period verification');
    if (run.expectedCursor === null && run.fromDate !== calendar?.openingDate) throw problem('First verified interval must start at the business opening date');
    const proof = await loadProof(run);
    const validation = validatePeriodProof(run, proof, now());
    const auditId = await audit('business-period:' + run._id + ':prepared:' + validation.evidenceHash, { ...scope, actorId: actor.actorId, action: 'Business period verification prepared', operationId: String(run._id), evidenceHash: validation.evidenceHash });
    await authority(scope, 'operations.verify');
    validatePeriodProof(run, proof, now());
    const commit = { operationId: String(run._id), planHash: run.planHash, blueprintHash: run.blueprintHash, ...validation, actorId: actor.actorId, preparedAuditId: auditId, committedAt: new Date(now()).toISOString() };
    await transaction(async session => {
      const attemptActor = await authority(scope, 'operations.verify');
      if (attemptActor.actorId !== actor.actorId) throw problem('Operation actor changed before verification', 403);
      validatePeriodProof(run, proof, now());
      const currentRun = await Runs.findOne({ _id: run._id, ...scopeFilter(scope), planHash: run.planHash }).session(session).lean();
      assertLease(currentRun);
      await Writer.assertSettled(run, scope, session);
      const claimed = await Runs.findOneAndUpdate({ _id: run._id, ...scopeFilter(scope), status: 'awaiting-evidence', planHash: run.planHash, blueprintHash: run.blueprintHash, evidenceRevision: validation.evidenceRevision, verificationCandidateHash: validation.evidenceHash, ...(currentRun?.leaseToken ? { leaseToken, leaseExpiresAt: currentRun.leaseExpiresAt } : {}) }, { $set: { status: 'committing' } }, { new: true, session }).lean();
      if (!claimed) throw problem('Operation state or evidence changed before calendar commit');
      const saved = await Calendars.findOneAndUpdate({ ...matchingCalendar(run, scope), currentOperationId: run._id, pendingCommit: null }, { $set: { verifiedThrough: run.throughDate, pendingCommit: commit }, $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!saved) throw problem('Calendar changed or stopped; no business date was advanced');
    });
    return repair(scope);
  }
  async function requestStop(id, scope) {
    const actor = await authority(scope, 'operations.stop');
    const run = await readRun(id, scope);
    await audit('business-period:' + run._id + ':stop-request', { ...scope, actorId: actor.actorId, action: 'Business period stop requested', operationId: id });
    await authority(scope, 'operations.stop');
    const stopped = await Calendars.findOneAndUpdate({ _id: calendarId(scope), ...scopeFilter(scope), currentOperationId: run._id }, { $set: { stopRequested: true } }, { new: true }).lean();
    if (!stopped) throw problem('The operation no longer owns this business calendar');
    // A stop request cannot undo an external request already sent. The runner must
    // settle its durable receipt before declaring the operation stopped.
    return stopped;
  }
  return { reserve, finish, repair, requestStop };
}
module.exports = { createBusinessPeriodStore, validatePeriodProof, assertRun, assertRunApproval };
