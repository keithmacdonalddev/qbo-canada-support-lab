'use strict';
const { hash, canonical, date, shift } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { businessDate } = require('./business-activity-preview');
const { evaluateBooks } = require('./book-evidence');
const { validateInventoryObservation, inventorySummary, TYPES } = require('./business-record-inventory');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
const REPORTS = ['TrialBalance', 'BalanceSheet', 'ProfitAndLoss', 'AgedReceivables', 'AgedPayables'];
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_BASELINE_UNVERIFIED' }); }
function copy(value, max = 14000000) { let text; try { text = canonical(value); } catch { fail('Baseline evidence must contain plain JSON.'); } if (Buffer.byteLength(text) > max) fail('Baseline evidence exceeds its retained size budget.'); return JSON.parse(text); }
const sameScope = (a, b) => ['environment', 'realmId', 'connectionId'].every(key => String(a?.[key]) === String(b?.[key]));
function day(value) { try { return date(value); } catch { fail('Choose a valid baseline date.', 400); } }
function stamp(value) { const time = typeof value === 'string' ? Date.parse(value) : NaN; if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail('Baseline observation timestamps are invalid.'); return time; }
function requestValue(input, scope, blueprint, now) {
  const keys = ['requestKey', 'connectionId', 'blueprintId', 'blueprintHash', 'purpose', 'fromDate', 'throughDate'];
  if (!input || Object.keys(input).sort().join(',') !== keys.sort().join(',') || typeof input.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestKey) || input.connectionId !== scope.connectionId || input.blueprintId !== blueprint.id || input.blueprintHash !== blueprint.contentHash || !['opening-balances', 'company-survey'].includes(input.purpose)) fail('Choose the exact saved business plan and observation request.', 400);
  day(input.fromDate); day(input.throughDate);
  if (input.fromDate > input.throughDate || day(input.throughDate) - day(input.fromDate) > 366 * 86400000 || input.throughDate > businessDate(new Date(now))) fail('Choose an elapsed observation period of at most one year.', 400);
  if (input.purpose === 'opening-balances' && input.throughDate !== shift(blueprint.openingDate, -1)) fail('Opening balances must be dated the day before the business opens.', 400);
  return copy(input);
}
function evaluateSources(sources, scope, period, now, fresh) {
  sources = copy(sources, 7000000);
  const { sourceHash, evaluation: ignored, ...source } = sources;
  const start = stamp(source.startedAt), end = stamp(source.observedAt);
  if (Object.keys(source).sort().join(',') !== 'accounts,observedAt,period,reports,scope,startedAt,version' || source.version !== 1 || !sameScope(source.scope, scope) || canonical(source.period) !== canonical(period) || !HASH.test(sourceHash || '') || hash(source) !== sourceHash || end < start || end - start > 180000 || (fresh && (end > now || now - start > 300000)) || !Array.isArray(source.accounts) || source.accounts.length > 4000 || !source.reports || canonical(Object.keys(source.reports).sort()) !== canonical([...REPORTS].sort())) fail('Complete scoped report sources and their observation interval are required.');
  const ids = new Set();
  for (const account of source.accounts) {
    if (!account || typeof account.Id !== 'string' || !/^\d{1,30}$/.test(account.Id) || typeof account.SyncToken !== 'string' || !/^(0|[1-9]\d{0,63})$/.test(account.SyncToken) || typeof account.AccountType !== 'string' || !account.AccountType || ids.has(account.Id) || (account.sparse !== undefined && account.sparse !== false)) fail('The retained account source is incomplete or ambiguous.');
    ids.add(account.Id);
  }
  return { sources: { ...source, sourceHash }, evaluation: copy(evaluateBooks(source.reports, source.period, {}, { records: source.accounts })) };
}
function assertBaselineDocumentSize(row) {
  const size = require('mongoose').mongo.BSON.calculateObjectSize({ ...row, createdAt: new Date(), __v: 0 });
  if (size > 15 * 1024 * 1024) fail('The combined observation exceeds its BSON storage budget. Capture requires a larger evidence storage workflow.');
}
function validateBaselineObservation(row) {
  assertBaselineDocumentSize(row);
  if (!row || ![1, 2].includes(row.contractVersion) || !ID.test(String(row._id)) || !ID.test(String(row.actorId)) || !ID.test(String(row.ownerId)) || !ID.test(String(row.auditId)) || row.status !== 'captured' || !HASH.test(row.requestHash || '') || !HASH.test(row.evidenceHash || '')) fail('The retained baseline observation is incomplete.');
  const scope = scoped({ environment: row.environment, realmId: row.realmId, connectionId: String(row.connectionId) }), payload = copy(row.payload);
  if (payload.version !== row.contractVersion || !sameScope(payload.scope, scope) || payload.actorId !== String(row.actorId) || payload.ownerId !== String(row.ownerId) || payload.requestHash !== row.requestHash || !ID.test(payload.blueprint?.id || '') || !HASH.test(payload.blueprint?.contentHash || '') || hash(payload) !== row.evidenceHash) fail('The retained baseline identity or evidence changed.');
  day(payload.blueprint.openingDate);
  const input = requestValue(row.request, scope, payload.blueprint, stamp(payload.observedAt));
  if (hash(input) !== row.requestHash || canonical(payload.period) !== canonical({ fromDate: input.fromDate, throughDate: input.throughDate }) || payload.purpose !== input.purpose) fail('The original baseline request changed.');
  const checked = evaluateSources(row.sources, scope, payload.period, 0, false);
  const inventory = row.contractVersion === 2 ? inventorySummary(row.inventorySources, scope) : 'unverified';
  const startedAt = row.contractVersion === 2 && inventory.startedAt < checked.sources.startedAt ? inventory.startedAt : checked.sources.startedAt;
  const observedAt = row.contractVersion === 2 && inventory.observedAt > checked.sources.observedAt ? inventory.observedAt : checked.sources.observedAt;
  if (canonical(checked.evaluation) !== canonical(payload.evaluation) || payload.sourceHash !== checked.sources.sourceHash || payload.startedAt !== startedAt || payload.observedAt !== observedAt || stamp(observedAt) - stamp(startedAt) > 180000 || payload.ownership !== 'unverified' || canonical(payload.inventory) !== canonical(inventory) || payload.accepted !== false || payload.activated !== false) fail('Baseline evidence does not match its original source observations.');
  if (row.contractVersion === 2) {
    const accounts = new Map(row.inventorySources.records.Account.map(record => [record.id, record.contentHash]));
    if (accounts.size !== checked.sources.accounts.length || checked.sources.accounts.some(account => accounts.get(account.Id) !== hash(account))) fail('The report accounts differ from the current inventory.');
  }
  return { payload, sources: checked.sources };
}
function view(row) {
  const { payload } = validateBaselineObservation(row);
  return { id: String(row._id), ...payload, evidenceHash: row.evidenceHash, status: 'captured', persisted: true,
    limitation: 'This is a dated report observation, not an accepted baseline. Separate report requests and current account metadata are not an atomic historical inventory. Record ownership, realistic balances, bank reconciliation and complete business activity remain unverified.' };
}
function createBusinessBaselineStore({ scope, actorId, ownerId, Baselines, Versions, Users, Connections, Memberships, Audits, access, assertReady, assertCaptureReady, transaction, readReports, readInventory, now = () => Date.now() }) {
  scope = scoped(scope);
  if (![actorId, ownerId].every(id => typeof id === 'string' && ID.test(id)) || [Baselines, Versions, Users, Connections, Memberships, Audits].some(value => !value) || [access?.authorize, assertReady, assertCaptureReady, transaction, readReports, readInventory, now].some(fn => typeof fn !== 'function')) throw new TypeError('Baseline observations require exact authority and storage');
  const read = (model, filter, session) => model.findOne(filter).session(session).maxTimeMS(3000).lean();
  const check = signal => { if (signal?.aborted) fail('Baseline observation was cancelled.'); };
  async function authority(action, session, signal) { check(signal); await assertReady(); check(signal); const current = await access.authorize(scope, action, { session, signal }); check(signal); if (current?.actorId !== actorId || current?.ownerId !== ownerId) fail('The baseline reader or company owner changed.'); if (action === 'baseline.capture') { await assertCaptureReady({ session }); check(signal); } }
  async function blueprint(id, session) {
    if (typeof id !== 'string' || !ID.test(id)) fail('Choose an exact saved business plan.', 400);
    const row = await read(Versions, { _id: id, ...scope, contractVersion: 2 }, session);
    if (!row || row.status !== 'draft' || !HASH.test(row.contentHash || '') || hash(row.definition) !== row.contentHash || !row.auditId) fail('The exact saved business plan is unavailable.');
    day(row.definition?.calendar?.openingDate);
    return { id, contentHash: row.contentHash, openingDate: row.definition.calendar.openingDate };
  }
  const auditDetails = row => ({ baselineId: String(row._id), ...scope, actorId: String(row.actorId), blueprintId: row.payload.blueprint.id, blueprintHash: row.payload.blueprint.contentHash, requestHash: row.requestHash, evidenceHash: row.evidenceHash, sourceHash: row.payload.sourceHash, purpose: row.payload.purpose, fromDate: row.payload.period.fromDate, throughDate: row.payload.period.throughDate, ...(row.contractVersion === 2 ? { inventoryVersion: 1, inventoryHash: row.payload.inventory.sourceHash, inventoryStartedAt: row.payload.inventory.startedAt, inventoryObservedAt: row.payload.inventory.observedAt } : {}), status: 'captured' });
  async function retained(row, session) {
    if (!row || !sameScope(row, scope) || String(row.ownerId) !== ownerId) fail('The baseline observation is unavailable.', 404);
    validateBaselineObservation(row);
    const audit = await read(Audits, { _id: row.auditId }, session);
    if (!audit || String(audit.userId) !== ownerId || String(audit.actorUserId || audit.userId) !== String(row.actorId) || audit.realmId !== scope.realmId || audit.action !== 'Business baseline observation saved' || audit.outcome !== 'success' || audit.actionType !== 'manual' || canonical(audit.afterState) !== canonical(auditDetails(row))) fail('The baseline audit receipt is missing or changed.');
    return view(row);
  }
  async function fence(session) {
    if (!session?.inTransaction?.()) fail('Baseline capture requires a real transaction.');
    // Write the documents whose current authority was read in this snapshot.
    // Revocation and company switching must conflict before evidence can commit.
    const counter = { $or: [{ businessObservationVersion: { $exists: false } }, { businessObservationVersion: { $type: 'number', $gte: 0, $lt: Number.MAX_SAFE_INTEGER } }] };
    for (const id of new Set([actorId, ownerId])) {
      const changed = await Users.updateOne({ _id: id, ...counter }, { $inc: { businessObservationVersion: 1 } }, { session });
      if (changed.matchedCount !== 1) fail('The baseline actor or owner changed.');
    }
    const connected = await Connections.updateOne({ _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active', ...counter }, { $inc: { businessObservationVersion: 1 } }, { session });
    const member = await Memberships.updateOne({ userId: actorId, realmId: scope.realmId, status: 'active' }, { $inc: { businessObservationVersion: 1 } }, { session });
    if (connected.matchedCount !== 1 || member.matchedCount !== 1) fail('Company access changed before baseline capture.');
  }
  async function capture(input, { signal } = {}) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype) fail('Use a complete baseline observation request.', 400);
    input = copy(input, 10000); await authority('baseline.capture', null, signal);
    if (typeof input.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestKey)) fail('A baseline request identifier is required.', 400);
    const requestHash = hash(input), id = hash({ scope, actorId, ownerId, requestKey: input.requestKey }).slice(0, 24);
    const reuse = async session => {
      const row = await read(Baselines, { _id: id }, session);
      if (!row) return null;
      if (row.requestHash !== requestHash || String(row.actorId) !== actorId) fail('This observation request already belongs to different work.');
      return retained(row, session);
    };
    const existing = await reuse(); check(signal);
    if (existing) { await authority('baseline.capture', null, signal); return { ...existing, reused: true }; }
    const selected = await blueprint(input.blueprintId); check(signal);
    try { input = requestValue(input, scope, selected, now()); }
    catch (error) { if (error.status === 400) { error.code = 'BUSINESS_BASELINE_REQUEST_INVALID'; error.notSaved = true; } throw error; }
    const period = { fromDate: input.fromDate, throughDate: input.throughDate };
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    let observed, inventorySources;
    const timer = setTimeout(abort, 180000); timer.unref?.();
    try {
      [observed, inventorySources] = await new Promise((resolve, reject) => {
        const stopped = () => reject(Object.assign(new Error('Baseline observation was cancelled or exceeded three minutes.'), { status: 409, code: 'BUSINESS_BASELINE_UNVERIFIED' }));
        if (controller.signal.aborted) return stopped();
        controller.signal.addEventListener('abort', stopped, { once: true });
        Promise.all([readReports(scope, period, { signal: controller.signal }), readInventory(scope, { signal: controller.signal })]).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stopped));
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
    check(signal);
    const inventory = inventorySummary(inventorySources, scope);
    const inventoryTimes = validateInventoryObservation(inventorySources, scope);
    if (stamp(inventoryTimes.observedAt) > now() || now() - stamp(inventoryTimes.startedAt) > 300000) fail('The current inventory observation is stale.');
    const checked = evaluateSources(observed, scope, period, now(), true);
    const payload = { version: 2, scope, actorId, ownerId, requestHash, blueprint: selected, purpose: input.purpose, period,
      startedAt: inventory.startedAt < checked.sources.startedAt ? inventory.startedAt : checked.sources.startedAt, observedAt: inventory.observedAt > checked.sources.observedAt ? inventory.observedAt : checked.sources.observedAt, sourceHash: checked.sources.sourceHash, evaluation: checked.evaluation,
      ownership: 'unverified', inventory, accepted: false, activated: false };
    const row = { _id: id, contractVersion: 2, ...scope, actorId, ownerId, status: 'captured', request: input, requestHash, payload, sources: checked.sources, inventorySources: copy(inventorySources), evidenceHash: hash(payload), auditId: hash({ baseline: id, event: 'captured' }).slice(0, 24) };
    validateBaselineObservation(row); copy(row);
    const result = await transaction(async session => {
      await authority('baseline.capture', session, signal);
      const old = await reuse(session); check(signal); if (old) return { ...old, reused: true };
      if (canonical(await blueprint(selected.id, session)) !== canonical(selected)) fail('The selected business plan changed during observation.');
      evaluateSources(row.sources, scope, period, now(), true);
      if (stamp(inventoryTimes.observedAt) > now() || now() - stamp(inventoryTimes.startedAt) > 300000) fail('The current inventory observation is stale.'); check(signal);
      await fence(session); check(signal);
      await Baselines.create([row], { session }); check(signal);
      await Audits.create([{ _id: row.auditId, userId: ownerId, ...(actorId !== ownerId ? { actorUserId: actorId } : {}), realmId: scope.realmId, action: 'Business baseline observation saved', actionType: 'manual', outcome: 'success', afterState: auditDetails(row) }], { session }); check(signal);
      return { ...view(row), reused: false };
    });
    await authority('baseline.capture', null, signal); return result;
  }
  async function inspect(id) {
    if (typeof id !== 'string' || !ID.test(id)) fail('Choose an exact baseline observation.', 400);
    await authority('baseline.read'); const result = await transaction(async session => { await authority('baseline.read', session); return retained(await read(Baselines, { _id: id, ...scope }, session), session); });
    await authority('baseline.read'); return result;
  }

  async function inventoryEvidence(id, entity, { signal } = {}) {
    if (typeof id !== 'string' || !ID.test(id) || !TYPES.includes(entity)) fail('Choose a saved observation and supported record type.', 400);
    await authority('baseline.review', null, signal);
    const result = await transaction(async session => {
      await authority('baseline.review', session, signal);
      const row = await read(Baselines, { _id: id, ...scope }, session); check(signal);
      const evidence = await retained(row, session); check(signal);
      if (row.contractVersion !== 2) fail('This older observation has no captured record inventory.');
      return { baselineId: id, scope, entity, evidenceHash: row.evidenceHash, inventoryHash: row.inventorySources.sourceHash, observedAt: evidence.inventory.observedAt, records: row.inventorySources.records[entity] };
    });
    await authority('baseline.review', null, signal); return result;
  }
  async function inventoryPage(id, input = {}, options) {
    if (!input || Object.keys(input).some(key => !['entity', 'after', 'limit'].includes(key))) fail('Use the supported captured inventory page.', 400);
    const { entity, after, limit = 20 } = input;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('Use a bounded inventory page.', 400);
    const evidence = await inventoryEvidence(id, entity, options), rows = evidence.records; let start = 0;
    if (after !== undefined) {
      try {
        if (typeof after !== 'string' || after.length > 700 || !/^[a-zA-Z0-9_-]+$/.test(after)) throw new Error();
        const cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
        if (Object.keys(cursor).sort().join(',') !== 'baselineId,entity,evidenceHash,id,inventoryHash' || cursor.baselineId !== id || cursor.entity !== entity || cursor.evidenceHash !== evidence.evidenceHash || cursor.inventoryHash !== evidence.inventoryHash || typeof cursor.id !== 'string') throw new Error();
        const index = rows.findIndex(row => row.id === cursor.id); if (index < 0) throw new Error(); start = index + 1;
      } catch { fail('The captured inventory cursor does not match this observation.', 400); }
    }
    const selected = rows.slice(start, start + limit);
    const next = start + limit < rows.length ? Buffer.from(JSON.stringify({ baselineId: id, entity, evidenceHash: evidence.evidenceHash, inventoryHash: evidence.inventoryHash, id: selected.at(-1).id })).toString('base64url') : null;
    return { ...evidence, records: selected.map(({ contentHash, ...record }) => record), total: rows.length, next, ownership: 'unclassified', currentVerified: false };
  }
  // Internal to the scoped review service; contentHash is never returned by a route.
  async function inventoryRecord(id, entity, recordId, options) {
    if (typeof recordId !== 'string' || !/^\d{1,30}$/.test(recordId)) fail('Choose a captured record identity.', 400);
    const evidence = await inventoryEvidence(id, entity, options), record = evidence.records.find(row => row.id === recordId);
    if (!record) fail('That record is not in the captured inventory.', 404);
    const { records, ...identity } = evidence; return { ...identity, record };
  }
  async function list({ after, limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('Use a bounded baseline observation page.', 400);
    let cursor;
    if (after !== undefined) {
      try { if (typeof after !== 'string' || after.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(after)) throw new Error(); cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')); if (Object.keys(cursor).sort().join(',') !== 'id,observedAt' || typeof cursor.id !== 'string' || !ID.test(cursor.id)) throw new Error(); stamp(cursor.observedAt); } catch { fail('The baseline page cursor is invalid.', 400); }
    }
    await authority('baseline.read');
    const rows = await Baselines.find({ ...scope, ownerId, ...(cursor ? { $or: [{ 'payload.observedAt': { $lt: cursor.observedAt } }, { 'payload.observedAt': cursor.observedAt, _id: { $lt: cursor.id } }] } : {}) }).select('_id status payload.blueprint payload.purpose payload.period payload.observedAt evidenceHash').sort({ 'payload.observedAt': -1, _id: -1 }).limit(limit + 1).maxTimeMS(3000).lean();
    await authority('baseline.read');
    return { scope, records: rows.slice(0, limit).map(row => ({ id: String(row._id), status: 'captured', blueprint: row.payload.blueprint, purpose: row.payload.purpose, period: row.payload.period, observedAt: row.payload.observedAt, evidenceHash: row.evidenceHash, accepted: false })), next: rows.length > limit ? Buffer.from(JSON.stringify({ observedAt: rows[limit - 1].payload.observedAt, id: String(rows[limit - 1]._id) })).toString('base64url') : null };
  }
  return { capture, inspect, list, inventoryPage, inventoryRecord };
}
module.exports = { createBusinessBaselineStore, validateBaselineObservation, evaluateSources, assertBaselineDocumentSize };
