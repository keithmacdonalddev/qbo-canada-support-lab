'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { scoped } = require('./qbo-write-contract');

// These sources match the current app's structured read-tool surface. Unsupported
// CDC entities and singleton preferences use complete replacement observations.
const ENTITIES = Object.freeze(['Preferences', 'CompanyInfo', 'Customer', 'Vendor', 'Item', 'Account', 'Invoice', 'Bill', 'Payment', 'BillPayment', 'Estimate', 'PurchaseOrder', 'SalesReceipt', 'CreditMemo', 'VendorCredit', 'RefundReceipt', 'Purchase', 'Deposit', 'Transfer', 'JournalEntry', 'TimeActivity', 'Employee', 'Class', 'Department', 'Term', 'PaymentMethod', 'TaxCode', 'TaxRate']);
const SNAPSHOT_ONLY = new Set(['TimeActivity', 'TaxCode', 'TaxRate', 'CompanyInfo', 'Preferences']);
const SINGLETONS = new Set(['CompanyInfo', 'Preferences']);
const LISTS = new Set(['Customer', 'Vendor', 'Item', 'Account', 'Employee', 'Class', 'Department', 'Term', 'PaymentMethod', 'TaxCode', 'TaxRate']);
const PAGE_SIZE = 100, CDC_LIMIT = 1000, MAX_AGE_MS = 29 * 86400000, OVERLAP_MS = 60000;
const QID = /^[A-Za-z0-9_-]{1,64}$/;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => Object.assign(new Error(message), { status: 409, code: 'BUSINESS_SYNC_INCOMPLETE' });
const stamp = value => { const n = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(n) ? n : null; };
const iso = value => new Date(value).toISOString();
const refreshInterval = (entity, intervalMs) => entity === 'TimeActivity' ? Math.max(intervalMs, 300000) : intervalMs;
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
function parseBody(body, entity, cdc, clock) {
  if (!plain(body) || body.Fault || body.fault) throw fail('QuickBooks returned an incomplete source response.');
  const serverTime = stamp(body.time);
  if (serverTime === null || serverTime > clock + 300000 || serverTime < clock - 300000) throw fail('QuickBooks source time is missing or ahead of this server.');
  let blocks;
  if (cdc) {
    if (!Array.isArray(body.CDCResponse) || body.CDCResponse.length !== 1 || !plain(body.CDCResponse[0]) || body.CDCResponse[0].Fault || !Array.isArray(body.CDCResponse[0].QueryResponse)) throw fail('The change response is incomplete.');
    blocks = body.CDCResponse[0].QueryResponse;
  } else {
    if (!plain(body.QueryResponse)) throw fail('The source query response is missing.');
    blocks = [body.QueryResponse];
  }
  const rows = [], ids = new Set(); let declared = 0;
  for (const block of blocks) {
    if (!plain(block) || block.Fault || block.fault || Object.keys(block).some(key => ![entity, 'startPosition', 'maxResults', 'totalCount'].includes(key))) throw fail('The source response contains an unexpected or failed entity.');
    if (block[entity] !== undefined && !Array.isArray(block[entity])) throw fail('The source record list is malformed.');
    const members = block[entity] || [];
    if (block.maxResults !== undefined && (!Number.isInteger(block.maxResults) || block.maxResults !== members.length)) throw fail('The source page size does not match its records.');
    if (block.startPosition !== undefined && block.startPosition !== 1) throw fail('The source did not start at the requested keyset.');
    if (block.totalCount !== undefined && (!Number.isInteger(block.totalCount) || block.totalCount < members.length)) throw fail('The declared source count is incomplete.');
    declared += block.totalCount ?? members.length;
    for (const record of members) {
      if (!plain(record) || !QID.test(record.Id || '') || ids.has(record.Id) || (record.sparse === true && record.status !== 'Deleted') || (!cdc && record.status === 'Deleted')) throw fail('Source record identities are missing, partial or repeated.');
      if (Buffer.byteLength(JSON.stringify(record)) > 2000000) throw fail('A source record exceeds the observation size budget.');
      ids.add(record.Id); rows.push(record);
    }
  }
  if (rows.length > (cdc ? CDC_LIMIT : PAGE_SIZE) || (!cdc && declared > rows.length && rows.length < PAGE_SIZE)) throw fail('The source page omitted declared records.');
  const saturated = cdc && (rows.length >= CDC_LIMIT || declared >= CDC_LIMIT);
  if (cdc && !saturated && declared > rows.length) throw fail('The change response omitted declared records.');
  return { rows, serverTime, saturated };
}
function sourceStart(entity, clock, previous) {
  return { entity, mode: SNAPSHOT_ONLY.has(entity) ? 'snapshot' : 'cdc', phase: 'bootstrap', status: 'bootstrap', generation: randomUUID(),
    startedAt: iso(clock), since: null, lastId: null, observed: 0, count: previous?.count ?? 0,
    lastSuccessAt: previous?.lastSuccessAt || null, nextAt: null, error: null };
}
function publicSnapshot(state, entities, clock, intervalMs) {
  const sources = entities.map(entity => {
    const row = state.sources?.[entity];
    if (!row) return { entity, status: 'waiting', count: 0, lastSuccessAt: null, error: null };
    const cadence = refreshInterval(entity, intervalMs), completedAt = stamp(row.lastSuccessAt), freshFor = Math.max(cadence * 2, 120000);
    const recentComplete = completedAt !== null && completedAt <= clock && clock - completedAt <= freshFor;
    const refreshing = row.mode === 'snapshot' && row.status === 'bootstrap' && recentComplete;
    const current = recentComplete && (row.status === 'current' || refreshing);
    return { entity, status: current ? 'current' : row.status === 'current' ? 'stale' : row.status, mode: row.mode, refreshing, refreshEverySeconds: cadence / 1000, freshUntil: completedAt === null ? null : iso(completedAt + freshFor), count: row.count || 0,
      observed: row.observed || 0, lastSuccessAt: row.lastSuccessAt || null, error: row.error || null };
  });
  const complete = sources.every(row => row.status === 'current');
  const summaryFresh = stamp(state.summaryAt) !== null && stamp(state.summaryAt) <= clock && clock - stamp(state.summaryAt) <= Math.max(intervalMs * 4, 120000);
  const error = sources.some(row => ['error', 'saturated'].includes(row.status)) || Boolean(state.summaryError);
  return { status: complete && summaryFresh ? 'current' : error ? 'attention' : sources.some(row => row.status === 'stale') ? 'stale' : 'catching-up',
    lastSuccessAt: complete ? sources.map(row => row.lastSuccessAt).sort()[0] : null, sources,
    company: { ...(state.company || { counts: {}, totals: {}, recent: [] }), provisional: !complete || !summaryFresh },
    summaryAt: state.summaryAt || null, summaryError: state.summaryError || null };
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
    const control = { signal: controller.signal, beforeAttempt: async () => { controller.signal.throwIfAborted(); await check(); if (attempts >= maxRequests) throw fail('This sync slice has used its request allowance.'); attempts++; }, onFailure: () => {} };
    try {
      let visited = 0;
      while (requests < maxRequests && visited < entities.length) {
        await check(); controller.signal.throwIfAborted();
        const index = state.nextEntity % entities.length, entity = entities[index]; state.nextEntity = (index + 1) % entities.length; visited++;
        let source = state.sources[entity]; const clock = now();
        if (source && (!plain(source) || source.entity !== entity || !['bootstrap', 'catchup', 'incremental'].includes(source.phase) || typeof source.generation !== 'string' || stamp(source.startedAt) === null || (source.lastId !== null && !QID.test(source.lastId || '')) || (source.since !== null && stamp(source.since) === null))) throw fail('A saved source cursor is invalid.');
        if (stamp(source?.nextAt) !== null && stamp(source.nextAt) > clock) continue;
        if (!source || clock - stamp(source.startedAt) > MAX_AGE_MS && source.phase !== 'incremental' || source.phase === 'incremental' && (stamp(source.since) === null || clock - stamp(source.since) > MAX_AGE_MS) || SNAPSHOT_ONLY.has(entity) && source.phase === 'incremental') source = sourceStart(entity, clock, source);
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
                state.company = null; state.summaryAt = null;
              }
              state.homeCurrency = currency; observedHomeCurrency = currency;
            }
            await persistRows(entity, parsed.rows, source, started, now()); changed ||= parsed.rows.length > 0;
            source.observed += parsed.rows.length; source.error = null;
            if (!SINGLETONS.has(entity) && parsed.rows.length === PAGE_SIZE) { source.lastId = parsed.rows.at(-1).Id; source.status = 'bootstrap'; }
            else if (!SNAPSHOT_ONLY.has(entity)) { source.phase = 'catchup'; source.status = 'catching-up'; source.lastId = null; }
            else {
              await finishGeneration(entity, source, now()); source.phase = 'incremental'; source.status = 'current'; source.count = source.observed;
              source.lastSuccessAt = iso(now()); source.nextAt = iso(now() + refreshInterval(entity, intervalMs)); changed = true;
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
            if (source.phase === 'catchup') { await finishGeneration(entity, source, now()); changed = true; }
            source.phase = 'incremental'; source.status = 'current'; source.error = null;
            source.since = iso(Math.min(started, parsed.serverTime) - OVERLAP_MS);
            source.lastSuccessAt = iso(now()); source.nextAt = iso(now() + intervalMs);
          }
          await save(state); observedSource = true;
        } catch (error) {
          signal?.throwIfAborted();
          // Keep original cursor and never claim a partially persisted source current.
          const retained = { ...originalSource, status: 'error' }; state.sources[entity] = retained; retained.nextAt = iso(now() + intervalMs); retained.error = error.code === 'BUSINESS_SYNC_INCOMPLETE' ? error.message : error.status === 429 ? 'QuickBooks is limiting requests. This source will retry after the wait.' : Number.isInteger(error.status) ? 'QuickBooks could not read this source (HTTP ' + error.status + '). Its last complete observation is retained.' : 'This source could not be synchronized. Its last complete observation is retained.';
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
      return publicSnapshot(state, entities, now(), intervalMs);
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  function tick({ maxRequests = 8, timeoutMs = 120000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) return Promise.reject(new TypeError('Use a sync time allowance of 1–120 seconds.'));
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 40) return Promise.reject(new TypeError('Use a bounded sync slice of 1–40 requests.'));
    if (ticking) return ticking;
    perform.maxRequests = maxRequests; perform.timeoutMs = timeoutMs;
    // Requests made by a sync slice are measured as background synchronization.
    ticking = require('./qbo-request-meter').runWithCategory('sync', () => perform()).finally(() => { ticking = null; }); return ticking;
  }
  async function snapshot() { return publicSnapshot(await stateRead(), entities, now(), intervalMs); }
  return { tick, snapshot };
}
module.exports = { createBusinessAgentSync, summarizeCompanyMirror, ENTITIES, SNAPSHOT_ONLY: Object.freeze([...SNAPSHOT_ONLY]), PAGE_SIZE, CDC_LIMIT };
