'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { scoped } = require('./qbo-write-contract');
const { localParts, dayRhythm } = require('./business-agent-cadence');
const amounts = require('./business-agent-reconciliation');

// These sources match the current app's structured read-tool surface. Unsupported
// CDC entities and singleton preferences use complete replacement observations.
// Request economy (docs/plans/continuous-business-activity-2026-10-30.md, sync tuning). The app
// makes almost every change itself, so the cadence is adaptive:
// - every incremental change-tracked source is read together in ONE change (CDC) call, every
//   5 minutes during the day's activity hours (America/Halifax, business-agent-cadence.js; all day
//   under rhythm v3) and every 15 outside;
// - a write-bearing step asks for a read within the last two minutes (tick freshWithinMs), and
//   that combined call is what satisfies the write gate;
// - a combined response at the change limit, or one QuickBooks rejects, falls back to per-source
//   reads (each source's own CDC call, and a full re-read if that is saturated too);
// - snapshot sources are re-read every 30 minutes during activity hours and 2 hours outside
//   (TimeActivity) or every 6 hours (tax codes and rates, company info, preferences);
// - from 02:00 Halifax a nightly sweep compares each change-tracked source's QuickBooks COUNT
//   with the mirror and fully re-reads any source that differs; a cursor older than 29 days
//   is always fully re-read.
// Steady state under the all-day rhythm v3 is about 370 requests a day.
const ENTITIES = Object.freeze(['Preferences', 'CompanyInfo', 'Customer', 'Vendor', 'Item', 'Account', 'Invoice', 'Bill', 'Payment', 'BillPayment', 'Estimate', 'PurchaseOrder', 'SalesReceipt', 'CreditMemo', 'VendorCredit', 'RefundReceipt', 'Purchase', 'Deposit', 'Transfer', 'JournalEntry', 'TimeActivity', 'Employee', 'Class', 'Department', 'Term', 'PaymentMethod', 'TaxCode', 'TaxRate']);
const SNAPSHOT_ONLY = new Set(['TimeActivity', 'TaxCode', 'TaxRate', 'CompanyInfo', 'Preferences']);
const SINGLETONS = new Set(['CompanyInfo', 'Preferences']);
const LISTS = new Set(['Customer', 'Vendor', 'Item', 'Account', 'Employee', 'Class', 'Department', 'Term', 'PaymentMethod', 'TaxCode', 'TaxRate']);
const PAGE_SIZE = 1000, CDC_LIMIT = 1000, MAX_AGE_MS = 29 * 86400000, OVERLAP_MS = 60000;
const QID = /^[A-Za-z0-9_-]{1,64}$/;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => Object.assign(new Error(message), { status: 409, code: 'BUSINESS_SYNC_INCOMPLETE' });
const stamp = value => { const n = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(n) ? n : null; };
const iso = value => new Date(value).toISOString();
// Refresh cadence per source kind at an instant; the configured monitoring interval can only slow them.
const MINUTE = 60000, CDC_OPEN_MS = 5 * MINUTE, CDC_CLOSED_MS = 15 * MINUTE, TIME_OPEN_MS = 30 * MINUTE, TIME_CLOSED_MS = 120 * MINUTE, REFERENCE_EVERY_MS = 360 * MINUTE;
const RECONCILE_FROM_MINUTES = 120; // nightly sweep from 02:00 Halifax
function inBusinessHours(clock) { const local = localParts(clock), rhythm = dayRhythm(local.date); return rhythm.open !== null && local.minutes >= rhythm.open && local.minutes < rhythm.close; }
const refreshInterval = (entity, intervalMs, clock) => { const open = inBusinessHours(clock); return Math.max(intervalMs, entity === 'TimeActivity' ? (open ? TIME_OPEN_MS : TIME_CLOSED_MS) : SNAPSHOT_ONLY.has(entity) ? REFERENCE_EVERY_MS : open ? CDC_OPEN_MS : CDC_CLOSED_MS); };
// A source stays current for twice the cadence it was read under (saved as everyMs), at least two minutes.
const cadenceOf = (row, entity, intervalMs, clock) => Number.isSafeInteger(row?.everyMs) && row.everyMs >= 1000 ? row.everyMs : refreshInterval(entity, intervalMs, clock);
const safeText = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : '';
function cents(value) { const n = typeof value === 'number' ? value : NaN; return Number.isFinite(n) && Number.isSafeInteger(Math.round(n * 100)) ? Math.round(n * 100) : null; }
function recordSummary(entity, record, homeCurrency) {
  const currency = safeText(record.CurrencyRef?.value, 8) || homeCurrency || null;
  const home = currency === homeCurrency;
  const balance = cents(record.Balance), amount = cents(record.TotalAmt);
  const homeBalance = homeCurrency ? cents(record.HomeBalance) ?? (home ? balance : null) : null;
  const accountBalance = entity === 'Account' && record.AccountType === 'Bank' && home ? cents(record.CurrentBalance) : null;
  return { name: safeText(record.DisplayName || record.Name || record.CompanyName), docNumber: safeText(record.DocNumber, 80),
    txnDate: /^\d{4}-\d{2}-\d{2}$/.test(record.TxnDate || '') ? record.TxnDate : null,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(record.DueDate || '') ? record.DueDate : null,
    active: record.Active !== false, currency, amountCents: amount, balanceCents: balance,
    homeBalanceCents: homeBalance, bankBalanceCents: accountBalance,
    status: record.status === 'Deleted' ? 'Deleted' : balance !== null ? balance === 0 ? 'Paid' : amount !== null && balance < amount ? 'Partly paid' : 'Open' : record.Active === false ? 'Inactive' : 'Recorded' };
}
// entity: one source name, or for a change (CDC) response the list of requested sources.
// Returns { rows, byEntity, serverTime, saturated }; CDC identities are unique per entity.
function parseBody(body, entity, cdc, clock) {
  if (!plain(body) || body.Fault || body.fault) throw fail('QuickBooks returned an incomplete source response.');
  const serverTime = stamp(body.time);
  if (serverTime === null || serverTime > clock + 300000 || serverTime < clock - 300000) throw fail('QuickBooks source time is missing or ahead of this server.');
  const wanted = cdc ? [].concat(entity) : [entity];
  let blocks;
  if (cdc) {
    if (!Array.isArray(body.CDCResponse) || body.CDCResponse.length !== 1 || !plain(body.CDCResponse[0]) || body.CDCResponse[0].Fault || !Array.isArray(body.CDCResponse[0].QueryResponse)) throw fail('The change response is incomplete.');
    blocks = body.CDCResponse[0].QueryResponse;
  } else {
    if (!plain(body.QueryResponse)) throw fail('The source query response is missing.');
    blocks = [body.QueryResponse];
  }
  const rows = [], byEntity = Object.fromEntries(wanted.map(name => [name, []])), ids = new Set(), named = new Set(); let declared = 0;
  for (const block of blocks) {
    if (!plain(block) || block.Fault || block.fault) throw fail('The source response contains an unexpected or failed entity.');
    // Each block carries at most one requested source; a block with none has no changes.
    const names = Object.keys(block).filter(key => !['startPosition', 'maxResults', 'totalCount'].includes(key));
    if (names.length > 1 || names.some(name => !wanted.includes(name) || named.has(name))) throw fail('The source response contains an unexpected or failed entity.');
    const name = names[0]; if (name) named.add(name);
    if (name && !Array.isArray(block[name])) throw fail('The source record list is malformed.');
    const members = name ? block[name] : [];
    if (block.maxResults !== undefined && (!Number.isInteger(block.maxResults) || block.maxResults !== members.length)) throw fail('The source page size does not match its records.');
    if (block.startPosition !== undefined && block.startPosition !== 1) throw fail('The source did not start at the requested keyset.');
    if (block.totalCount !== undefined && (!Number.isInteger(block.totalCount) || block.totalCount < members.length)) throw fail('The declared source count is incomplete.');
    declared += block.totalCount ?? members.length;
    for (const record of members) {
      if (!plain(record) || !QID.test(record.Id || '') || ids.has(name + ':' + record.Id) || (record.sparse === true && record.status !== 'Deleted') || (!cdc && record.status === 'Deleted')) throw fail('Source record identities are missing, partial or repeated.');
      if (Buffer.byteLength(JSON.stringify(record)) > 2000000) throw fail('A source record exceeds the observation size budget.');
      ids.add(name + ':' + record.Id); rows.push(record); byEntity[name].push(record);
    }
  }
  if (rows.length > (cdc ? CDC_LIMIT : PAGE_SIZE) || (!cdc && declared > rows.length && rows.length < PAGE_SIZE)) throw fail('The source page omitted declared records.');
  // The change limit applies to the whole response, across every requested source.
  const saturated = cdc && (rows.length >= CDC_LIMIT || declared >= CDC_LIMIT);
  if (cdc && !saturated && declared > rows.length) throw fail('The change response omitted declared records.');
  return { rows, byEntity, serverTime, saturated };
}
// A COUNT query response: { QueryResponse: { totalCount } }; an empty QueryResponse means zero.
function parseCount(body, clock) {
  if (!plain(body) || body.Fault || body.fault || !plain(body.QueryResponse)) throw fail('QuickBooks returned an incomplete count response.');
  const serverTime = stamp(body.time);
  if (serverTime === null || serverTime > clock + 300000 || serverTime < clock - 300000) throw fail('QuickBooks source time is missing or ahead of this server.');
  const keys = Object.keys(body.QueryResponse);
  if (keys.some(key => key !== 'totalCount')) throw fail('The count response contains unexpected data.');
  const count = body.QueryResponse.totalCount ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) throw fail('The count response is malformed.');
  return count;
}
const badCursor = (source, entity) => !plain(source) || source.entity !== entity || !['bootstrap', 'catchup', 'incremental'].includes(source.phase) || typeof source.generation !== 'string' || stamp(source.startedAt) === null || (source.lastId !== null && !QID.test(source.lastId || '')) || (source.since !== null && stamp(source.since) === null);
// Consecutive failures of one source wait one, two, four... monitoring intervals, at most 30 minutes,
// so a persistent rejection cannot keep spending requests.
const retryAt = (source, clock, intervalMs) => iso(clock + Math.min(intervalMs * 2 ** Math.min(Math.max(0, (Number(source?.failures) || 0) - 1), 10), 30 * 60000));
const sourceError = error => error.code === 'BUSINESS_SYNC_INCOMPLETE' ? error.message : error.status === 429 ? 'QuickBooks is limiting requests. This source will retry after the wait.' : Number.isInteger(error.status) ? 'QuickBooks could not read this source (HTTP ' + error.status + '). Its last complete observation is retained.' : 'This source could not be synchronized. Its last complete observation is retained.';
function sourceStart(entity, clock, previous) {
  return { entity, mode: SNAPSHOT_ONLY.has(entity) ? 'snapshot' : 'cdc', phase: 'bootstrap', status: 'bootstrap', generation: randomUUID(),
    startedAt: iso(clock), since: null, lastId: null, observed: 0, count: previous?.count ?? 0,
    lastSuccessAt: previous?.lastSuccessAt || null, ...(Number.isSafeInteger(previous?.everyMs) ? { everyMs: previous.everyMs } : {}), nextAt: null, error: null };
}
const cdcExpired = (source, clock) => source && !SNAPSHOT_ONLY.has(source.entity) && source.phase === 'incremental' && (stamp(source.since) === null || clock - stamp(source.since) > MAX_AGE_MS || stamp(source.lastSuccessAt) !== null && clock - stamp(source.lastSuccessAt) > MAX_AGE_MS);
function publicSnapshot(state, entities, clock, intervalMs) {
  const sources = entities.map(entity => {
    const row = state.sources?.[entity];
    if (!row) return { entity, status: 'waiting', count: 0, lastSuccessAt: null, error: null };
    const cadence = cadenceOf(row, entity, intervalMs, clock), completedAt = stamp(row.lastSuccessAt), freshFor = Math.max(cadence * 2, 120000);
    const recentComplete = completedAt !== null && completedAt <= clock && clock - completedAt <= freshFor;
    const refreshing = row.mode === 'snapshot' && row.status === 'bootstrap' && recentComplete;
    const current = recentComplete && (row.status === 'current' || refreshing);
    return { entity, status: current ? 'current' : row.status === 'current' ? 'stale' : row.status, mode: row.mode, refreshing, refreshEverySeconds: cadence / 1000, freshUntil: completedAt === null ? null : iso(completedAt + freshFor), count: row.count || 0,
      observed: row.observed || 0, lastSuccessAt: row.lastSuccessAt || null, error: row.error || null, ...(row.reconcileError ? { reconcileError: row.reconcileError } : {}) };
  });
  const complete = sources.every(row => row.status === 'current');
  // The company summary is refreshed after every observation, so it shares the change-read window
  // (or, with no change-tracked sources, the longest snapshot window).
  const windows = sources.filter(row => row.refreshEverySeconds).map(row => ({ cdc: row.mode !== 'snapshot', ms: row.refreshEverySeconds * 2000 }));
  const summaryWindow = Math.max(intervalMs * 4, 120000, ...(windows.some(row => row.cdc) ? windows.filter(row => row.cdc) : windows).map(row => row.ms));
  const summaryFresh = stamp(state.summaryAt) !== null && stamp(state.summaryAt) <= clock && clock - stamp(state.summaryAt) <= summaryWindow;
  // When the next source read is due (a source without a saved schedule is due now).
  const nextDueAt = entities.reduce((min, entity) => Math.min(min, stamp(state.sources?.[entity]?.nextAt) ?? clock), Infinity);
  const error = sources.some(row => ['error', 'saturated'].includes(row.status)) || Boolean(state.summaryError);
  const amountProblem = ['attention', 'resyncing'].includes(state.amountReconciliation?.status);
  return { status: amountProblem ? 'attention' : complete && summaryFresh ? 'current' : error ? 'attention' : sources.some(row => row.status === 'stale') ? 'stale' : 'catching-up',
    lastSuccessAt: complete ? sources.map(row => row.lastSuccessAt).sort()[0] : null, sources,
    company: { ...(state.company || { counts: {}, totals: {}, recent: [] }), provisional: !complete || !summaryFresh || amountProblem },
    amountReconciliation: state.amountReconciliation ? copy(state.amountReconciliation) : null,
    summaryAt: state.summaryAt || null, summaryFreshUntil: stamp(state.summaryAt) === null ? null : iso(stamp(state.summaryAt) + summaryWindow), summaryError: state.summaryError || null, nextDueAt: Number.isFinite(nextDueAt) ? iso(nextDueAt) : null };
}
async function summarizeCompanyMirror({ Records, scope, homeCurrency = null, now = () => Date.now() }) {
  scope = scoped(scope);
  const storedScope = { ...scope, connectionId: Records.schema?.path('connectionId')?.cast(scope.connectionId) || scope.connectionId };
  const grouped = await Records.aggregate([
    { $match: { ...storedScope, deleted: false } },
    { $project: { entity: 1, summary: 1 } },
    { $group: { _id: '$entity', records: { $sum: 1 }, active: { $sum: { $cond: ['$summary.active', 1, 0] } },
      open: { $sum: { $cond: [{ $gt: ['$summary.balanceCents', 0] }, 1, 0] } },
      balance: { $sum: '$summary.homeBalanceCents' }, bank: { $sum: '$summary.bankBalanceCents' },
      missingCurrency: { $sum: { $cond: [{ $and: [{ $gt: ['$summary.balanceCents', 0] }, { $eq: [{ $ifNull: ['$summary.homeBalanceCents', null] }, null] }] }, 1, 0] } } } },
  ]).option({ maxTimeMS: 5000 });
  const byType = Object.fromEntries(grouped.map(row => [row._id, row]));
  const counts = { customers: byType.Customer?.active || 0, vendors: byType.Vendor?.active || 0, items: byType.Item?.active || 0,
    accounts: byType.Account?.active || 0, openInvoices: byType.Invoice?.open || 0, openBills: byType.Bill?.open || 0,
    records: grouped.reduce((total, row) => total + row.records, 0) };
  const rows = await Records.find({ ...scope, deleted: false, entity: { $nin: [...SINGLETONS] } }).select('entity qboId summary changedAt lastObservedAt').sort({ changedAt: -1, _id: 1 }).limit(20).maxTimeMS(5000).lean();
  return { counts, totals: { receivables: homeCurrency ? (byType.Invoice?.balance || 0) / 100 : null, payables: homeCurrency ? (byType.Bill?.balance || 0) / 100 : null,
    cash: homeCurrency ? (byType.Account?.bank || 0) / 100 : null, currency: homeCurrency,
    incompleteCurrency: !homeCurrency || Boolean(byType.Invoice?.missingCurrency || byType.Bill?.missingCurrency) },
    entityCounts: Object.fromEntries(grouped.map(row => [row._id, row.records])),
    recent: rows.map(row => ({ entity: row.entity, qboId: row.qboId, name: row.summary.name, docNumber: row.summary.docNumber,
      txnDate: row.summary.txnDate, amount: row.summary.amountCents === null ? null : row.summary.amountCents / 100,
      balance: row.summary.balanceCents === null ? null : row.summary.balanceCents / 100, currency: row.summary.currency,
      status: row.summary.status, changedAt: row.changedAt, lastObservedAt: row.lastObservedAt })), observedAt: iso(now()) };
}
function originalClient(client, scope) {
  const { QBOClient } = require('./qbo-client');
  const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
  if (!(client instanceof QBOClient) || client.query !== QBOClient.prototype.query || client.apiCall !== QBOClient.prototype.apiCall || client.apiBase !== base || String(client.realmId) !== scope.realmId || String(client.connection?._id) !== scope.connectionId || String(client.connection?.realmId) !== scope.realmId || client.connection?.status !== 'active') throw fail('The synchronization client no longer matches the selected company.');
}
function createBusinessAgentSync({ client, scope, Records, loadState, saveState, authorize, signal, now = () => Date.now(), entities = ENTITIES, homeCurrency = null, intervalMs = 30000, assertClient = originalClient }) {
  scope = scoped(scope);
  if (!client || typeof client.query !== 'function' || typeof client.apiCall !== 'function' || !Records || [loadState, saveState, authorize, now, assertClient].some(fn => typeof fn !== 'function') || !Array.isArray(entities) || !entities.length || new Set(entities).size !== entities.length || entities.some(entity => !ENTITIES.includes(entity)) || (homeCurrency !== null && !/^[A-Z]{3}$/.test(homeCurrency)) || !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new TypeError('Company sync needs concrete scoped adapters and supported sources.');
  let ticking = null, observedHomeCurrency = homeCurrency;
  async function check() { signal?.throwIfAborted(); assertClient(client, scope); await authorize(); signal?.throwIfAborted(); assertClient(client, scope); }
  async function stateRead() {
    await check(); const value = await loadState();
    if (value == null || (plain(value) && Object.keys(value).length === 0)) return { version: 1, sources: {}, nextEntity: 0 };
    if (!plain(value) || value.version !== 1 || !plain(value.sources) || Object.keys(value.sources).some(entity => !ENTITIES.includes(entity)) || !Number.isInteger(value.nextEntity) || value.nextEntity < 0) throw fail('Saved synchronization cursors need recovery.');
    return copy(value);
  }
  async function save(value) { await check(); await saveState(copy(value)); await check(); }
  async function persistRows(entity, rows, source, started, observed) {
    if (!rows.length) return;
    await check();
    const ops = rows.map(record => ({ updateOne: {
      filter: { ...scope, entity, qboId: record.Id, $or: [{ lastReadStartedAt: { $lte: new Date(started) } }, { lastReadStartedAt: { $exists: false } }] },
      update: { $set: { record: copy(record), generation: source.generation, deleted: record.status === 'Deleted', lastReadStartedAt: new Date(started),
        lastObservedAt: new Date(observed), changedAt: stamp(record.MetaData?.LastUpdatedTime) === null ? null : new Date(record.MetaData.LastUpdatedTime), summary: recordSummary(entity, record, observedHomeCurrency) },
        $setOnInsert: { _id: createHash('sha256').update(JSON.stringify({ ...scope, entity, qboId: record.Id })).digest('hex'), version: 1, ...scope, entity, qboId: record.Id } }, upsert: true,
    } }));
    await Records.bulkWrite(ops, { ordered: true }); await check();
  }
  async function finishGeneration(entity, source, clock) {
    await check();
    // A superseded worker cannot tombstone observations made by a newer read.
    await Records.updateMany({ ...scope, entity, generation: { $ne: source.generation }, lastReadStartedAt: { $lte: new Date(source.startedAt) } },
      { $set: { deleted: true, lastObservedAt: new Date(clock) } });
    await check();
  }
  // Nightly reconciliation (from 02:00 Halifax, once per Halifax day per source): a COUNT per
  // current change-tracked source against the mirror's undeleted records, using the summary just
  // refreshed. A difference starts a full re-read (with tombstoning) of that source only. A count
  // that cannot be read is recorded and retried the next night.
  async function reconcile(state, canRequest, charge, control, readCurrent) {
    const local = localParts(now());
    if (local.minutes < RECONCILE_FROM_MINUTES || !plain(state.company?.entityCounts) || !state.summaryAt || state.summaryError) return;
    const summaryAt = stamp(state.summaryAt);
    for (const entity of entities) {
      const source = state.sources[entity];
      if (SNAPSHOT_ONLY.has(entity) || !source || source.phase !== 'incremental' || source.status !== 'current' || source.reconciledOn === local.date || !source.reconciledOn) continue;
      // The comparison needs a summary computed after this source's latest observation.
      if (!(summaryAt >= stamp(source.lastSuccessAt))) continue;
      if (!canRequest()) return;
      await check(); charge();
      let count;
      try { count = parseCount(await readCurrent(() => client.query('SELECT COUNT(*) FROM ' + entity + (LISTS.has(entity) ? ' WHERE Active IN (true, false)' : ''), control)), now()); await check(); }
      catch (error) { signal?.throwIfAborted(); if (control.signal.aborted) return; state.sources[entity] = { ...source, reconciledOn: local.date, reconcileError: 'The nightly count check could not be read; it retries tomorrow night.' }; await save(state); continue; }
      const mirrored = Number(state.company.entityCounts[entity]) || 0;
      if (count === mirrored) { const { reconcileError, ...kept } = source; state.sources[entity] = { ...kept, reconciledOn: local.date }; }
      else { state.sources[entity] = { ...sourceStart(entity, now(), source), reconcileError: 'The nightly check found ' + count + ' records in QuickBooks and ' + mirrored + ' here, so this source is being fully re-read.' }; }
      await save(state);
    }
  }
  // Amount checks share the same persisted company state, lease, transport and slice allowance.
  // Keep a pending resync across slices/restarts; never reset its one-recheck limit at midnight.
  function prepareAmounts(state) {
    const clock = now(), local = localParts(clock), definitions = amounts.DEFINITIONS.filter(row => entities.includes(row.entity));
    const previous = state.amountReconciliation, invalidated = Boolean(previous && previous.basisVersion !== 2);
    // Obsolete Invoice/Bill-only evidence must stop affecting status even while
    // its replacement source is still bootstrapping or was restarted today.
    if (invalidated) delete state.amountReconciliation;
    if (!definitions.length || local.minutes < RECONCILE_FROM_MINUTES) return invalidated;
    if (previous?.basisVersion === 2 && (previous.day === local.date || Object.values(previous.checks).some(row => ['waiting', 'resyncing'].includes(row.status)))) return false;
    // Bootstrap/catchup already consumes its allowance. The first nightly proof is on the next
    // Halifax day, alongside the first COUNT sweep (no implicit report calls during bootstrap).
    if (!definitions.every(({ entity }) => {
      const source = state.sources[entity];
      return source?.phase === 'incremental' && source.status === 'current' && stamp(source.startedAt) !== null && localParts(stamp(source.startedAt)).date < local.date;
    })) return invalidated;
    state.amountReconciliation = { version: 1, basisVersion: 2, day: local.date, status: 'checking', startedAt: iso(clock), checkedAt: null,
      toleranceCents: 0, note: amounts.TIMING_NOTE, checks: Object.fromEntries(definitions.map(({ key, entity }) => [key, { entity, status: 'waiting', attempts: 0, refreshAfter: iso(clock) }])) };
    return true;
  }
  function amountFreshnessDue(state, entity, clock) {
    const proof = state.amountReconciliation;
    const source = state.sources[entity];
    return source?.phase === 'incremental' && source.status === 'current' && Object.values(proof?.checks || {}).some(row =>
      ['waiting', 'resyncing'].includes(row.status) && (row.entity === entity || amounts.agingEntities(row.entity).includes(entity))
      && (stamp(source.lastSuccessAt) < stamp(row.refreshAfter) || clock - stamp(source.lastSuccessAt) > 120000));
  }
  async function reconcileAmounts(state, canRequest, charge, control, readCurrent) {
    const proof = state.amountReconciliation;
    if (!proof || proof.basisVersion !== 2) return;
    for (const { key, entity, report } of amounts.DEFINITIONS) {
      const previous = proof.checks[key], source = state.sources[entity];
      if (!previous || !['waiting', 'resyncing'].includes(previous.status) || source?.phase !== 'incremental' || source.status !== 'current') continue;
      // Saturation or an expired multi-slice bootstrap can replace the recovery generation.
      // A complete newer full read is valid recovery evidence; an older generation is not.
      if (previous.status === 'resyncing' && source.generation !== previous.resyncGeneration && !(stamp(source.startedAt) >= stamp(previous.refreshAfter))) continue;
      const dependencies = report ? amounts.agingEntities(entity).filter(type => entities.includes(type)) : [entity];
      if (dependencies.some(type => state.sources[type]?.phase !== 'incremental' || state.sources[type]?.status !== 'current' || amountFreshnessDue(state, type, now())) || !canRequest()) continue;
      let result;
      try {
        await check();
        const mirrored = report ? Object.fromEntries(await Promise.all(dependencies.map(async type => [type, await amounts.readAmountMirror(Records, scope, type)])))
          : await amounts.readAmountMirror(Records, scope, entity); await check();
        if (!canRequest()) return;
        charge();
        if (report) {
          const params = new URLSearchParams({ aging_method: 'Current', report_date: localParts(now()).date });
          const body = await readCurrent(() => client.apiCall('GET', 'reports/' + report + '?' + params, undefined, 0, 0, control)); await check();
          const live = amounts.parseAgingReport(body, report, observedHomeCurrency, now());
          const expected = amounts.agingMirrorTotal(entity, mirrored, observedHomeCurrency);
          const differenceCents = expected.mirrorCents === null ? null : live.qboCents - expected.mirrorCents;
          if (differenceCents !== null && !Number.isSafeInteger(differenceCents)) throw fail('The aging difference exceeds the exact cent amount budget.');
          result = { ...live, ...expected, differenceCents,
            status: expected.mirrorCents === null ? 'unverified' : expected.mirrorCents === live.qboCents ? 'matched' : 'mismatched', note: amounts.REPORT_NOTE };
        } else {
          const body = await readCurrent(() => client.query('SELECT * FROM Account WHERE Active IN (true, false) MAXRESULTS ' + PAGE_SIZE, control)); await check();
          const parsed = parseBody(body, entity, false, now());
          if (parsed.rows.length >= PAGE_SIZE) throw fail('The single Account query reached its page limit; account amounts are unverified.');
          result = { ...amounts.compareAccounts(mirrored, parsed.rows, observedHomeCurrency), qboAt: iso(parsed.serverTime) };
        }
      } catch (error) {
        signal?.throwIfAborted(); if (control.signal.aborted) return;
        result = { status: 'error', error: sourceError(error) };
      }
      const checkedAt = iso(now());
      const next = { ...previous, ...result, attempts: previous.attempts + 1, cdcAt: source.lastSuccessAt, checkedAt };
      if (result.status === 'mismatched' && previous.attempts === 0) {
        next.initialMismatch = { ...result, checkedAt, cdcAt: source.lastSuccessAt };
        const replacement = sourceStart(entity, now(), source);
        // Keep the nightly count result: the amount recovery must not spend another COUNT.
        replacement.reconciledOn = source.reconciledOn;
        replacement.reconcileError = 'The nightly amount check differs from QuickBooks. This source is being fully re-read before one re-check.';
        state.sources[entity] = replacement;
        next.status = 'resyncing'; next.resyncGeneration = replacement.generation; next.refreshAfter = replacement.startedAt;
      } else if (result.status === 'mismatched') {
        next.error = 'The amount still differs from QuickBooks after a full resync and one re-check. Treat these figures as unverified.';
      }
      proof.checks[key] = next; proof.checkedAt = checkedAt; proof.status = amounts.amountStatus(proof.checks); await save(state);
    }
  }
  async function perform() {
    const state = await stateRead(); observedHomeCurrency = state.homeCurrency || homeCurrency; let attempts = 0, requests = 0, changed = false, observedSource = false;
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, perform.timeoutMs); deadline.unref?.();
    const maxRequests = perform.maxRequests;
    const readCurrent = factory => new Promise((resolve, reject) => {
      const aborted = () => reject(fail('The synchronization observation was cancelled or exceeded its time allowance.'));
      if (controller.signal.aborted) return aborted();
      controller.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
    });
    const control = { signal: controller.signal, beforeAttempt: async () => { controller.signal.throwIfAborted(); await check(); if (attempts >= maxRequests) throw Object.assign(fail('This sync slice has used its request allowance.'), { allowance: true }); attempts++; }, onFailure: () => {} };
    try {
      if (prepareAmounts(state)) await save(state);
      // One combined change read covers every incremental change-tracked source that is not
      // being read on its own. It runs when any of them is due, and each covered source is then
      // current as of that response; nothing is persisted from a response at the change limit.
      const groupClock = now(), grouped = new Set(entities.filter(entity => {
        const source = state.sources[entity];
        return source && !SNAPSHOT_ONLY.has(entity) && !badCursor(source, entity) && source.phase === 'incremental' && source.solo !== true && !cdcExpired(source, groupClock);
      }));
      const members = [...grouped];
      // freshWithinMs (write gate): also read when any covered source was last read longer ago.
      const tooOld = entity => perform.freshWithinMs && !(groupClock - (stamp(state.sources[entity].lastSuccessAt) ?? -Infinity) <= perform.freshWithinMs);
      if (members.length && members.some(entity => !(stamp(state.sources[entity].nextAt) > groupClock) || tooOld(entity) || amountFreshnessDue(state, entity, groupClock))) {
        const originals = Object.fromEntries(members.map(entity => [entity, copy(state.sources[entity])]));
        const since = iso(Math.min(...members.map(entity => stamp(originals[entity].since)))), started = now(); requests++;
        // Sources handed to their own reads are read in this same slice when its allowance permits.
        const split = fields => { for (const entity of members) { state.sources[entity] = { ...originals[entity], ...fields, solo: true, nextAt: null }; grouped.delete(entity); } };
        try {
          const params = new URLSearchParams({ entities: members.join(','), changedSince: since });
          const body = await readCurrent(() => client.apiCall('GET', 'cdc?' + params, undefined, 0, 0, control)); await check();
          const parsed = parseBody(body, members, true, now());
          if (parsed.saturated) { split({ status: 'saturated', error: 'The combined change response reached its limit. Each source is being read on its own before it can be current.' }); await save(state); }
          else {
            for (const entity of members) { await persistRows(entity, parsed.byEntity[entity], originals[entity], started, now()); changed ||= parsed.byEntity[entity].length > 0; }
            const clock = now(), nextSince = iso(Math.min(started, parsed.serverTime) - OVERLAP_MS), success = iso(clock), everyMs = refreshInterval(members[0], intervalMs, clock), next = iso(clock + everyMs);
            for (const entity of members) { const { failures, ...kept } = originals[entity]; state.sources[entity] = { ...kept, phase: 'incremental', status: 'current', error: null, since: nextSince, lastSuccessAt: success, everyMs, nextAt: next, reconciledOn: kept.reconciledOn || localParts(clock).date }; }
            await save(state); observedSource = true;
          }
        } catch (error) {
          signal?.throwIfAborted();
          // Every original cursor is kept. A malformed or rejected combined response is retried
          // per source (which finds the failing one); a transient failure retries combined.
          const perSource = !controller.signal.aborted && !error.allowance && (error.code === 'BUSINESS_SYNC_INCOMPLETE' || (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && ![401, 403, 429].includes(error.status)));
          if (perSource) split({ status: 'error', error: sourceError(error) });
          else for (const entity of members) { const failures = (Number(originals[entity].failures) || 0) + 1; state.sources[entity] = { ...originals[entity], status: 'error', error: sourceError(error), failures, nextAt: retryAt({ failures }, now(), intervalMs) }; }
          await save(state);
        }
      }
      // A slice that ran out of time during the combined read stops here; its cursors are kept.
      let visited = controller.signal.aborted ? entities.length : 0;
      while (requests < maxRequests && visited < entities.length) {
        await check(); controller.signal.throwIfAborted();
        const index = state.nextEntity % entities.length, entity = entities[index]; state.nextEntity = (index + 1) % entities.length; visited++;
        let source = state.sources[entity]; const clock = now();
        if (grouped.has(entity)) continue;
        if (source && badCursor(source, entity)) throw fail('A saved source cursor is invalid.');
        // A source read on its own also answers the write gate's freshness demand.
        const demanded = source && source.phase === 'incremental' && !SNAPSHOT_ONLY.has(entity) && perform.freshWithinMs && !(clock - (stamp(source.lastSuccessAt) ?? -Infinity) <= perform.freshWithinMs);
        if (stamp(source?.nextAt) !== null && stamp(source.nextAt) > clock && !demanded && !cdcExpired(source, clock) && !amountFreshnessDue(state, entity, clock)) continue;
        if (!source || clock - stamp(source.startedAt) > MAX_AGE_MS && source.phase !== 'incremental' || cdcExpired(source, clock) || SNAPSHOT_ONLY.has(entity) && source.phase === 'incremental') source = sourceStart(entity, clock, source);
        else source = copy(source);
        state.sources[entity] = source;
        const originalSource = copy(source);
        const started = now(); visited = 0; requests++;
        try {
          let body, parsed;
          if (source.phase === 'bootstrap') {
            const filters = []; if (LISTS.has(entity)) filters.push('Active IN (true, false)');
            if (source.lastId) filters.push("Id > '" + source.lastId + "'");
            const query = 'SELECT * FROM ' + entity + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + (SINGLETONS.has(entity) ? '' : ' ORDERBY Id ASC MAXRESULTS ' + PAGE_SIZE);
            body = await readCurrent(() => client.query(query, control)); await check();
            parsed = parseBody(body, entity, false, now());
            if (source.lastId && parsed.rows.some(record => record.Id === source.lastId)) throw fail('The keyset source repeated its previous cursor.');
            if (SINGLETONS.has(entity) && parsed.rows.length !== 1) throw fail('The company singleton source is missing or repeated.');
            if (source.since === null) source.since = iso(Math.min(started, parsed.serverTime) - OVERLAP_MS);
            if (entity === 'Preferences') {
              const currency = parsed.rows[0]?.CurrencyPrefs?.HomeCurrency?.value;
              if (!/^[A-Z]{3}$/.test(currency || '')) throw fail('The company home currency could not be independently observed.');
              if (state.homeCurrency !== currency) {
                for (const other of Object.keys(state.sources)) if (other !== entity) delete state.sources[other];
                state.company = null; state.summaryAt = null; delete state.amountReconciliation;
              }
              state.homeCurrency = currency; observedHomeCurrency = currency;
            }
            await persistRows(entity, parsed.rows, source, started, now()); changed ||= parsed.rows.length > 0;
            source.observed += parsed.rows.length; source.error = null;
            if (!SINGLETONS.has(entity) && parsed.rows.length === PAGE_SIZE) { source.lastId = parsed.rows.at(-1).Id; source.status = 'bootstrap'; }
            else if (!SNAPSHOT_ONLY.has(entity)) { source.phase = 'catchup'; source.status = 'catching-up'; source.lastId = null; }
            else {
              await finishGeneration(entity, source, now()); source.phase = 'incremental'; source.status = 'current'; source.count = source.observed;
              const clock = now(); source.everyMs = refreshInterval(entity, intervalMs, clock); source.lastSuccessAt = iso(clock); source.nextAt = iso(clock + source.everyMs); changed = true;
            }
          } else {
            const params = new URLSearchParams({ entities: entity, changedSince: source.since });
            body = await readCurrent(() => client.apiCall('GET', 'cdc?' + params, undefined, 0, 0, control)); await check();
            parsed = parseBody(body, entity, true, now());
            if (parsed.saturated) {
              const replacement = sourceStart(entity, now(), source); replacement.status = 'saturated'; replacement.nextAt = iso(now() + intervalMs);
              replacement.error = 'The change response reached its limit. This source is being re-read before it can be current.';
              state.sources[entity] = replacement; await save(state); continue;
            }
            await persistRows(entity, parsed.rows, source, started, now()); changed ||= parsed.rows.length > 0;
            // A completed full read counts as reconciled for its Halifax day.
            if (source.phase === 'catchup') { await finishGeneration(entity, source, now()); changed = true; source.reconciledOn = localParts(now()).date; delete source.reconcileError; }
            source.phase = 'incremental'; source.status = 'current'; source.error = null; delete source.solo;
            source.since = iso(Math.min(started, parsed.serverTime) - OVERLAP_MS);
            const clock = now(); source.everyMs = refreshInterval(entity, intervalMs, clock); source.lastSuccessAt = iso(clock); source.nextAt = iso(clock + source.everyMs);
            source.reconciledOn ||= localParts(clock).date;
          }
          delete source.failures;
          await save(state); observedSource = true;
        } catch (error) {
          signal?.throwIfAborted();
          // Keep original cursor and never claim a partially persisted source current.
          const retained = { ...originalSource, status: 'error', failures: (Number(originalSource.failures) || 0) + 1 }; state.sources[entity] = retained; retained.nextAt = retryAt(retained, now(), intervalMs); retained.error = sourceError(error);
          await save(state); if (controller.signal.aborted) break;
        }
      }
      if (changed || !state.company || !state.summaryAt || state.summaryError) {
        try {
          await check(); state.company = await summarizeCompanyMirror({ Records, scope, homeCurrency: observedHomeCurrency, now });
          for (const source of Object.values(state.sources)) if (source.status === 'current') source.count = state.company.entityCounts[source.entity] || 0;
          state.summaryAt = iso(now()); state.summaryError = null; await save(state);
        } catch (error) { signal?.throwIfAborted(); state.summaryError = 'The company summary could not be refreshed. Earlier figures may be stale.'; await save(state); }
      }
      if (!changed && observedSource && state.company && state.summaryAt && !state.summaryError) { state.summaryAt = iso(now()); await save(state); }
      await reconcileAmounts(state, () => requests < maxRequests && !controller.signal.aborted, () => { requests++; }, control, readCurrent);
      await reconcile(state, () => requests < maxRequests && !controller.signal.aborted, () => { requests++; }, control, readCurrent);
      return publicSnapshot(state, entities, now(), intervalMs);
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  // freshWithinMs: the write gate's demand that change-tracked sources were read within this long.
  function tick({ maxRequests = 8, timeoutMs = 120000, freshWithinMs = null } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) return Promise.reject(new TypeError('Use a sync time allowance of 1–120 seconds.'));
    if (freshWithinMs !== null && (!Number.isInteger(freshWithinMs) || freshWithinMs < 1000 || freshWithinMs > 3600000)) return Promise.reject(new TypeError('Use a freshness demand of 1–3,600 seconds.'));
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 40) return Promise.reject(new TypeError('Use a bounded sync slice of 1–40 requests.'));
    if (ticking) return ticking;
    perform.maxRequests = maxRequests; perform.timeoutMs = timeoutMs; perform.freshWithinMs = freshWithinMs;
    // Requests made by a sync slice are measured as background synchronization.
    ticking = require('./qbo-request-meter').runWithCategory('sync', () => perform()).finally(() => { ticking = null; }); return ticking;
  }
  async function snapshot() { return publicSnapshot(await stateRead(), entities, now(), intervalMs); }
  return { tick, snapshot };
}
module.exports = { recordSummary, createBusinessAgentSync, summarizeCompanyMirror, ENTITIES, SNAPSHOT_ONLY: Object.freeze([...SNAPSHOT_ONLY]), PAGE_SIZE, CDC_LIMIT };
