'use strict';
const { hash, canonical } = require('./business-calendar');
const C = require('./report-evidence-contract');
const { scoped } = require('./qbo-write-contract');
const { createDefinitionsService } = require('./rebuild-definitions');
const { createContextService } = require('./rebuild-context');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessTransaction } = require('./business-transaction');
function createReportEvidenceService(dependencies = {}) {
  const connection = dependencies.connection || require('mongoose').connection;
  const models = dependencies.models || Object.fromEntries(Object.entries({ Users: 'User', Connections: 'Connection', Memberships: 'CompanyMembership', Audits: 'AuditLog' }).map(([key, name]) => [key, require('../models/' + name)]));
  const definitions = dependencies.definitions || createDefinitionsService(), resolve = dependencies.resolveContext || createContextService().resolve;
  const transaction = dependencies.transaction || createBusinessTransaction(connection), now = dependencies.now || (() => Date.now());
  const accessFor = dependencies.accessFor || createBusinessRuntimeAccess;
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  const clone = value => JSON.parse(canonical(value));
  function catalog() { const s = definitions.getSummary(); return { version: s.catalogVersion, asOfDate: s.asOfDate, hash: s.hashes.catalog }; }
  function definition(key) { return definitions.listReports({ offset: 0, limit: 1000 }).items.find(row => row.key === key) || null; }
  async function bind(user, action = 'reports.observe', ownerOnly = false) {
    const ownerId = String(user.id), actorId = String(user.actorId || user.id), context = await resolve(user);
    if (!context.connection?.connected) C.fail('Connect the company before inspecting its retained manual report checks.');
    const scope = scoped({ realmId: context.connection.realmId, environment: context.environment, connectionId: context.connection.connectionId });
    const access = accessFor({ ...models, ownerId, actorId }); await access.authorize(scope, action);
    if (ownerOnly && ownerId !== actorId) C.fail('Only the connected company owner can record or withdraw manual report checks.', 403);
    return { scope, ownerId, actorId, access, companyName: context.connection.companyName };
  }
  async function ready(bound, session) {
    if (dependencies.assertReady) return dependencies.assertReady(bound, session);
    try {
      const setup = require('./business-storage-setup');
      await setup.assertProfileSetupCompleted(connection.db, { ...bound.scope, ownerId: bound.ownerId }, 'continual-business', session);
      if (!session && (await setup.inspectStorage(connection.db, 'continual-business')).some(row => row.create || row.missingIndexes.length)) C.fail('Complete the reviewed company storage preparation before recording report evidence.');
    } catch { C.fail('Complete the reviewed company storage preparation before recording report evidence.'); }
  }
  async function fence(bound, session) {
    if (!session?.inTransaction?.() || bound.actorId !== bound.ownerId) C.fail('The report decision requires the current owner and a transaction.', 403);
    await bound.access.authorize(bound.scope, 'reports.manual.record', { session }); await ready(bound, session);
    const records = [
      [models.Users, { _id: bound.ownerId }],
      [models.Connections, { _id: bound.scope.connectionId, userId: bound.ownerId, realmId: bound.scope.realmId, status: 'active' }],
      [models.Memberships, { userId: bound.ownerId, realmId: bound.scope.realmId, status: 'active' }],
    ];
    for (const [Model, filter] of records) {
      const row = await Model.findOne(filter).select('_id businessObservationVersion').session(session).maxTimeMS(3000).lean(), version = row?.businessObservationVersion ?? 0;
      if (!row || !Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER) C.fail('Current report-owner observation authority needs recovery.');
      const changed = await Model.updateOne({ ...filter, _id: row._id, businessObservationVersion: row.businessObservationVersion === undefined ? { $exists: false } : version }, { $inc: { businessObservationVersion: 1 } }, { session });
      if (changed.matchedCount !== 1) C.fail('The company or report-owner authority changed.');
    }
  }
  function eventFilter(bound, id) { return { _id: id, userId: bound.ownerId, realmId: bound.scope.realmId }; }
  async function terminal(bound, id, session, supplied) {
    const observation = supplied || await read(models.Audits, eventFilter(bound, id), session);
    const withdrawal = await read(models.Audits, eventFilter(bound, C.withdrawalId(id)), session);
    const payload = observation ? C.validateObservation(observation, bound.scope, bound.ownerId) : null;
    const decision = withdrawal ? C.validateWithdrawal(withdrawal, bound.scope, bound.ownerId) : null;
    if (decision && (decision.observationId !== id || (payload ? decision.requestHash !== payload.requestHash || decision.observationHash !== observation.afterState.evidenceHash : decision.observationHash !== null))) C.fail('The report withdrawal differs from its retained original check.');
    return observation || withdrawal ? { observation, payload, withdrawal, decision } : null;
  }
  function view(bound, value) {
    const p = value.payload, d = value.decision, current = p && definition(p.request.reportKey);
    return { ...bound.scope, id: p ? String(value.observation._id) : d.observationId, requestHash: p?.requestHash || d.requestHash, request: clone(p?.request || d.request),
      evidenceHash: value.observation?.afterState.evidenceHash || null, recordedAt: p?.recordedAt || null, recorded: !!p, withdrawn: !!d,
      definition: p ? clone(p.definition) : null, definitionHash: p?.definitionHash || null, catalog: p ? clone(p.catalog) : null, definitionCurrent: !!p && !!current && hash(current) === p.definitionHash,
      withdrawal: d ? { id: String(value.withdrawal._id), decisionHash: value.withdrawal.afterState.decisionHash, reason: d.reason, recordedAt: d.recordedAt } : null,
      sourceType: 'owner-manual', limitation: 'Owner-recorded evidence for the stated report, period, basis and filters. The app keeps the reference, not the source file. It does not independently confirm the source, current balances or official bank reconciliation.' };
  }
  async function save(user, body) {
    const request = clone(C.bounded(body, 24000)), bound = await bind(user, 'reports.manual.record', true), requestHash = C.envelope(request, bound.scope);
    await ready(bound); const id = C.identity(bound.scope, bound.ownerId, request.requestKey);
    const result = await transaction(async session => {
      await fence(bound, session);
      const prior = await terminal(bound, id, session);
      if (prior) { if ((prior.payload?.requestHash || prior.decision.requestHash) !== requestHash) C.fail('This saved request identifier belongs to different report choices.'); return { ...view(bound, prior), reused: true }; }
      const currentCatalog = catalog(), report = definition(request.reportKey);
      if (request.catalogHash !== currentCatalog.hash || !report) C.fail('The report catalog changed. Refresh and review the exact definition before saving.');
      C.validateRequest(request, report, bound.scope, now());
      const payload = { version: 1, kind: C.OBS_KIND, scope: bound.scope, ownerId: bound.ownerId, requestHash, request, definition: clone(report), definitionHash: hash(report), catalog: currentCatalog, recordedAt: new Date(now()).toISOString() };
      const event = { _id: id, userId: bound.ownerId, realmId: bound.scope.realmId, action: C.OBSERVATION, actionType: 'manual', outcome: 'success', aiDriven: false, approvalEvent: 'explicit-manual-report-check', createdAt: new Date(payload.recordedAt), afterState: { version: 1, kind: C.OBS_KIND, scope: bound.scope, requestHash, evidenceHash: hash(payload), payload } };
      C.validateObservation(event, bound.scope, bound.ownerId);
      await models.Audits.create([event], { session });
      return { ...view(bound, { observation: event, payload, withdrawal: null, decision: null }), reused: false };
    });
    await bound.access.authorize(bound.scope, 'reports.observe'); return result;
  }
  async function withdraw(user, body) {
    if (!C.exact(body, ['request','reason']) || !C.text(body.reason, 20, 2000)) C.fail('Choose the exact saved or unconfirmed manual check and explain its withdrawal.', 400);
    const request = clone(C.bounded(body.request, 24000)), reason = body.reason.trim(), bound = await bind(user, 'reports.manual.record', true), requestHash = C.envelope(request, bound.scope);
    await ready(bound); const id = C.identity(bound.scope, bound.ownerId, request.requestKey);
    const result = await transaction(async session => {
      await fence(bound, session); const prior = await terminal(bound, id, session);
      if (prior && (prior.payload?.requestHash || prior.decision.requestHash) !== requestHash) C.fail('This report request differs from its original saved choices.');
      if (prior?.decision) return { ...view(bound, prior), reused: true };
      const payload = { version: 1, kind: C.WITHDRAW_KIND, scope: bound.scope, ownerId: bound.ownerId, observationId: id, observationHash: prior?.observation?.afterState.evidenceHash || null, requestHash, request, reason, recordedAt: new Date(now()).toISOString() };
      const event = { _id: C.withdrawalId(id), userId: bound.ownerId, realmId: bound.scope.realmId, action: C.WITHDRAWAL, actionType: 'manual', outcome: 'success', aiDriven: false, approvalEvent: 'explicit-manual-report-check', createdAt: new Date(payload.recordedAt), afterState: { version: 1, kind: C.WITHDRAW_KIND, scope: bound.scope, requestHash, decisionHash: hash(payload), payload } };
      C.validateWithdrawal(event, bound.scope, bound.ownerId); await models.Audits.create([event], { session });
      return { ...view(bound, { observation: prior?.observation || null, payload: prior?.payload || null, withdrawal: event, decision: payload }), reused: false };
    });
    await bound.access.authorize(bound.scope, 'reports.observe'); return result;
  }
  async function inspect(user, id) {
    if (!C.ID.test(id || '')) C.fail('Choose an exact saved report check.', 400);
    const bound = await bind(user), value = await terminal(bound, id);
    if (!value) C.fail('This report check is unavailable in the selected company connection.', 404);
    await bound.access.authorize(bound.scope, 'reports.observe'); return view(bound, value);
  }
  function cursor(value, bound, reportKey) {
    if (value === undefined) return null;
    try {
      if (typeof value !== 'string' || value.length > 512 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw Error();
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (!C.exact(decoded, ['version','scopeHash','reportKey','at','id']) || decoded.version !== 1 || decoded.scopeHash !== hash(bound.scope) || decoded.reportKey !== reportKey || !C.ID.test(decoded.id || '') || new Date(decoded.at).toISOString() !== decoded.at) throw Error();
      return decoded;
    } catch { C.fail('Use a valid saved report history cursor for this company and report.', 400); }
  }
  function nextCursor(bound, reportKey, row) { return Buffer.from(canonical({ version: 1, scopeHash: hash(bound.scope), reportKey, at: new Date(row.createdAt).toISOString(), id: String(row._id) })).toString('base64url'); }
  async function list(user, input) {
    if (!input || Object.keys(input).some(key => !['reportKey','after'].includes(key)) || typeof input.reportKey !== 'string' || !/^report\.[a-z0-9-]{1,100}$/.test(input.reportKey)) C.fail('Choose one report and its supported history cursor.', 400);
    const bound = await bind(user), reportKey = input.reportKey, started = now(), items = [];
    let scan = cursor(input.after, bound, reportKey), scanned = 0, reads = 0, last = null, more = false;
    const budget = () => { if (!Number.isFinite(now()) || now() < started || now() - started > 8000) C.fail('Saved report history exceeded its read budget. Retry; no empty-history claim is available.'); };
    while (scanned < 500 && items.length < 20) {
      budget();
      const filter = { userId: bound.ownerId, realmId: bound.scope.realmId, ...(scan ? { $or: [{ createdAt: { $lt: new Date(scan.at) } }, { createdAt: new Date(scan.at), _id: { $lt: scan.id } }] } : {}) };
      // The index bounds the owner/realm prefix, not the _id tie sort. Projected
      // row and time budgets are explicit; driver timeout is never an empty page.
      const rows = await models.Audits.find(filter).select('_id userId realmId action createdAt afterState.kind afterState.scope').hint({ userId: 1, realmId: 1, createdAt: -1 }).sort({ createdAt: -1, _id: -1 }).limit(100).maxTimeMS(3000).lean();
      budget(); if (!rows.length) { more = false; break; }
      let consumed = 0;
      for (const row of rows) {
        if (!C.ID.test(String(row._id)) || !Number.isFinite(new Date(row.createdAt).getTime())) C.fail('The saved history cursor cannot be verified.');
        if (reads > 77) { more = true; break; }
        last = row; consumed++; scanned++; budget();
        if (C.isReportEvidenceEvent(row)) {
          const saved = await read(models.Audits, eventFilter(bound, String(row._id))); reads++; budget();
          if (!saved || !C.exact(saved.afterState?.scope, ['realmId','environment','connectionId']) || saved.afterState.scope.realmId !== bound.scope.realmId) C.fail('A retained manual report history entry could not be verified.');
          const originalScope = saved.afterState.scope;
          if (saved.action === C.OBSERVATION) {
            const p = C.validateObservation(saved, originalScope, bound.ownerId);
            if (C.sameScope(originalScope, bound.scope) && p.request.reportKey === reportKey) { const state = await terminal(bound, String(saved._id), undefined, saved); reads++; items.push(view(bound, state)); }
          } else {
            const p = C.validateWithdrawal(saved, originalScope, bound.ownerId);
            if (C.sameScope(originalScope, bound.scope) && p.request.reportKey === reportKey) { const state = await terminal(bound, p.observationId); reads += 2; if (p.observationHash === null) items.push(view(bound, state)); }
          }
        }
        if (items.length >= 20) break;
      }
      more = consumed < rows.length || rows.length === 100;
      if (consumed < rows.length || items.length >= 20 || reads >= 80 || scanned >= 500) break;
      if (rows.length < 100) { more = false; break; }
      scan = { at: new Date(last.createdAt).toISOString(), id: String(last._id) };
    }
    let canRecord = false, blockReason = bound.actorId === bound.ownerId ? 'Your current company permission does not allow recording manual report checks.' : 'The connected company owner records manual report evidence.';
    if (bound.actorId === bound.ownerId) {
      try { await bound.access.authorize(bound.scope, 'reports.manual.record'); await ready(bound); canRecord = true; blockReason = null; }
      catch (error) { if (error.code === 'REPORT_EVIDENCE_UNAVAILABLE') blockReason = error.message; else if (error.status !== 403) throw error; }
    }
    budget(); await bound.access.authorize(bound.scope, 'reports.observe');
    const current = definition(reportKey), result = { ...bound.scope, scopeHash: hash(bound.scope), companyName: bound.companyName, catalog: catalog(), definition: current, definitionHash: current ? hash(current) : null, assertionDefinitions: current ? C.assertionDefinitions(current) : [], canRecord: canRecord && !!current, blockReason: current ? blockReason : 'This report is historical and no longer part of the current catalog.', items, next: more && last ? nextCursor(bound, reportKey, last) : null, historyComplete: !more, readAt: new Date(now()).toISOString(), qboReads: 0 };
    C.bounded(result, 900000); return result;
  }
  return { list, inspect, save, withdraw };
}
module.exports = { createReportEvidenceService };
