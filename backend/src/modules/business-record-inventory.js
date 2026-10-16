'use strict';
const { ENTITIES } = require('./record-queries');
const { hash, canonical, date } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const TYPES = Object.freeze([...ENTITIES]);
const LISTS = new Set(['Customer', 'Vendor', 'Item', 'Account']);
const ID = /^[a-f0-9]{24}$/, QID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/, HASH = /^[a-f0-9]{64}$/;
const LIMITS = Object.freeze({ page: 1000, records: 100000, compactBytes: 25000000, pageBytes: 8000000, recordBytes: 1000000, rawBytes: 300000000, milliseconds: 180000 });
const POLICY = 'all-current-records-including-inactive-lists-two-complete-scans-v1';
const POLICIES = Object.freeze({ 1: POLICY, 2: 'all-current-records-including-inactive-lists-two-complete-scans-bill-link-multiset-v2' });
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_INVENTORY_UNVERIFIED' }); }
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function encoded(value, limit) { let text; try { text = canonical(value); } catch { fail('Inventory response is not plain JSON.'); } if (typeof text !== 'string' || Buffer.byteLength(text) > limit) fail('Inventory response exceeds its evidence budget.'); return text; }
function stamp(value) { const n = typeof value === 'string' ? Date.parse(value) : NaN; if (!Number.isFinite(n) || new Date(n).toISOString() !== value) fail('Inventory observation time is invalid.'); return n; }
function compact(type, record, version = 1) {
  if (![1, 2].includes(version)) fail('Choose the retained inventory comparison version.');
  if (!plain(record) || typeof record.Id !== 'string' || !QID.test(record.Id) || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken) || (record.sparse !== undefined && record.sparse !== false)) fail('Inventory record identity or version is incomplete.');
  // Bill-level links are an unordered relationship collection in the observed API.
  // Keep every complete member, duplicate, type and all other array ordering.
  let compared = record;
  if (version === 2 && type === 'Bill' && Array.isArray(record.LinkedTxn)) {
    if (record.LinkedTxn.some(link => !plain(link))) fail('Bill links must retain complete JSON members.');
    const links = record.LinkedTxn.map(link => ({ link, key: canonical(link) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    compared = { ...record, LinkedTxn: links.map(row => row.link) };
  }
  const contentHash = hash(JSON.parse(encoded(compared, LIMITS.recordBytes)));
  if (LISTS.has(type)) {
    if (typeof record.Active !== 'boolean') fail('Inventory list activity is missing.');
    return { id: record.Id, syncToken: record.SyncToken, contentHash, active: record.Active };
  }
  try { date(record.TxnDate); } catch { fail('Inventory transaction date is missing or invalid.'); }
  return { id: record.Id, syncToken: record.SyncToken, contentHash, transactionDate: record.TxnDate };
}
const ordered = records => records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const manifestHash = entities => hash(TYPES.map(entity => ({ entity, records: entities[entity] })));
function validateInventoryObservation(value, scope) {
  if (!exact(value, ['version', 'policy', 'scope', 'coverage', 'scans', 'records', 'sourceHash']) || ![1, 2].includes(value.version) || value.policy !== POLICIES[value.version] || canonical(value.scope) !== canonical(scoped(scope)) || canonical(value.coverage) !== canonical(TYPES) || !exact(value.records, TYPES) || !Array.isArray(value.scans) || value.scans.length !== 2) fail('The current inventory source is incomplete or scoped elsewhere.');
  let count = 0, bytes = 0;
  for (const type of TYPES) {
    const rows = value.records[type]; if (!Array.isArray(rows)) fail('Inventory records are missing.');
    let previous = null;
    for (const row of rows) {
      if (!exact(row, ['id', 'syncToken', 'contentHash', LISTS.has(type) ? 'active' : 'transactionDate']) || typeof row.id !== 'string' || !QID.test(row.id) || typeof row.syncToken !== 'string' || !VERSION.test(row.syncToken) || !HASH.test(row.contentHash || '') || (previous !== null && previous >= row.id)) fail('Inventory record identities are repeated or invalid.');
      if (LISTS.has(type)) { if (typeof row.active !== 'boolean') fail('Inventory list activity is missing.'); }
      else { try { date(row.transactionDate); } catch { fail('Inventory transaction date is invalid.'); } }
      previous = row.id; count++; bytes += Buffer.byteLength(encoded(row, LIMITS.recordBytes));
      if (count > LIMITS.records || bytes > LIMITS.compactBytes) fail('Inventory exceeds its retained evidence budget.');
    }
  }
  const digest = manifestHash(value.records);
  for (const scan of value.scans) {
    if (!exact(scan, ['startedAt', 'observedAt', 'count', 'manifestHash']) || scan.count !== count || scan.manifestHash !== digest || stamp(scan.observedAt) < stamp(scan.startedAt)) fail('The two complete inventory scans do not agree.');
  }
  if (stamp(value.scans[1].startedAt) < stamp(value.scans[0].observedAt) || stamp(value.scans[1].observedAt) - stamp(value.scans[0].startedAt) > LIMITS.milliseconds) fail('Inventory scan intervals are invalid.');
  const { sourceHash, ...source } = value;
  if (!HASH.test(sourceHash || '') || hash(source) !== sourceHash) fail('The retained inventory observation changed.');
  return { count, startedAt: value.scans[0].startedAt, observedAt: value.scans[1].observedAt };
}
function inventorySummary(value, scope) {
  const observation = validateInventoryObservation(value, scope);
  return { version: value.version, ...observation, sourceHash: value.sourceHash, coverage: [...TYPES], status: 'matching-scans', atomic: false, ownership: 'unverified',
    entities: TYPES.map(entity => {
      const rows = value.records[entity];
      return LISTS.has(entity) ? { entity, count: rows.length, active: rows.filter(row => row.active).length, inactive: rows.filter(row => !row.active).length }
        : { entity, count: rows.length, earliestDate: rows.reduce((v, row) => !v || row.transactionDate < v ? row.transactionDate : v, null), latestDate: rows.reduce((v, row) => !v || row.transactionDate > v ? row.transactionDate : v, null) };
    }),
    limitation: 'Two matching reads of the named record types show observed stability, not an atomic snapshot, deleted history, all QuickBooks features or business ownership. Transaction dates do not reconstruct past record contents.' };
}
// Fixed GET-only surface. Compact identities are private evidence for later review;
// no records are adopted, changed, or authorized for subsequent writes here.
function createBusinessInventoryReader({ access, now = () => Date.now(), stockMetadata = false, version = 1 }) {
  if (![1, 2].includes(version)) throw new TypeError('Inventory comparison version must be explicit');
  if (typeof stockMetadata !== 'boolean') throw new TypeError('Stock metadata mode must be explicit');
  if ([access?.authorize, access?.resolveClient, now].some(fn => typeof fn !== 'function')) throw new TypeError('Inventory observations require current scoped access');
  return async function read(scope, { signal } = {}) {
    scope = scoped(scope);
    const started = now(), controller = new AbortController(), abort = () => controller.abort();
    if (!Number.isFinite(started)) fail('Inventory observation time is invalid.');
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, LIMITS.milliseconds); timer.unref?.();
    const check = () => { const current = now(); if (controller.signal.aborted || !Number.isFinite(current) || current < started || current - started > LIMITS.milliseconds) fail('Inventory observation was cancelled or exceeded three minutes.'); };
    const call = factory => new Promise((resolve, reject) => {
      const cancelled = () => { try { check(); } catch (error) { reject(error); } };
      if (controller.signal.aborted) return cancelled();
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { check(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
    });
    try {
      check(); const actor = await call(() => access.authorize(scope, 'baseline.capture', { signal: controller.signal })); check();
      if (!ID.test(actor?.actorId || '') || !ID.test(actor?.ownerId || '')) fail('Current inventory authority is required.');
      const client = await call(() => access.resolveClient(scope, { signal: controller.signal })); check();
      const { QBOClient } = require('./qbo-client');
      const guard = () => {
        const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
        if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall || client.query !== QBOClient.prototype.query || client.apiBase !== base || client.realmId !== scope.realmId || String(client.connection?._id) !== scope.connectionId || String(client.connection?.realmId) !== scope.realmId || client.connection?.status !== 'active' || String(client.connection?.userId) !== actor.ownerId) fail('Inventory client changed company or owner.');
      };
      const authority = async () => { check(); guard(); const current = await call(() => access.authorize(scope, 'baseline.capture', { signal: controller.signal })); check(); guard(); if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId) fail('Inventory authority changed during observation.'); };
      let rawBytes = 0, stockAttempts = 0, stockFailure = null;
      const stockControl = stockMetadata ? { signal: controller.signal, onFailure: error => { stockFailure ||= error; abort(); }, beforeAttempt: async () => { await authority(); if (stockAttempts++ >= 240) fail('Stock-root inventory exceeds its request budget.'); } } : null;
      async function scan() {
        const scanStart = now(), records = {}, seenByType = {}, jobs = [...TYPES], stock = { items: [], transactionCount: 0, latestTransactionUpdate: null, completeMetadata: true }; let next = 0, count = 0, bytes = 0, stockBytes = 0;
        async function entity(type) {
          const values = records[type] = [], seen = seenByType[type] = new Set(); let declared = null;
          for (let start = 1; ; start += LIMITS.page) {
            await authority();
            const query = 'SELECT * FROM ' + type + (LISTS.has(type) ? ' WHERE Active IN (true, false)' : '') + ' ORDERBY Id ASC STARTPOSITION ' + start + ' MAXRESULTS ' + LIMITS.page;
            const body = stockMetadata ? await client.query(query, stockControl) : await call(() => client.query(query)); check(); guard(); await authority();
            rawBytes += Buffer.byteLength(encoded(body, LIMITS.pageBytes)); if (rawBytes > LIMITS.rawBytes) fail('Inventory reads exceed their response budget.');
            if (!plain(body) || Object.keys(body).some(key => !['QueryResponse', 'time'].includes(key)) || !plain(body.QueryResponse)) fail('A complete inventory query response is required.');
            const page = body.QueryResponse, rows = page[type] === undefined ? [] : page[type];
            if (Object.keys(page).some(key => ![type, 'startPosition', 'maxResults', 'totalCount'].includes(key)) || !Array.isArray(rows) || rows.length > LIMITS.page || (rows.length && page.startPosition !== start) || (page.startPosition !== undefined && page.startPosition !== start) || (page.maxResults !== undefined && page.maxResults !== rows.length)) fail('Inventory pagination is incomplete.');
            if (page.totalCount !== undefined) { if (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || page.totalCount > LIMITS.records || (declared !== null && declared !== page.totalCount)) fail('Inventory count changed or exceeds its budget.'); declared = page.totalCount; }
            for (const record of rows) {
              const row = compact(type, record, version); if (seen.has(row.id)) fail('Inventory pagination repeated a record.');
              count++; bytes += Buffer.byteLength(encoded(row, LIMITS.recordBytes)); if (count > LIMITS.records || bytes > LIMITS.compactBytes) fail('Inventory exceeds its retained evidence budget.');
              if (stockMetadata) {
                if (type === 'Item' && record.Type === 'Inventory') {
                  stockBytes += Buffer.byteLength(encoded(record, LIMITS.recordBytes));
                  if (stock.items.length >= 100 || stockBytes > 2500000) fail('Stock-origin metadata exceeds its source budget.');
                  stock.items.push(JSON.parse(canonical(record)));
                } else if (!LISTS.has(type)) {
                  stock.transactionCount++;
                  const created = Date.parse(record.MetaData?.CreateTime), updated = Date.parse(record.MetaData?.LastUpdatedTime);
                  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created) stock.completeMetadata = false;
                  else if (stock.latestTransactionUpdate === null || updated > Date.parse(stock.latestTransactionUpdate)) stock.latestTransactionUpdate = new Date(updated).toISOString();
                }
              }
              seen.add(row.id); values.push(row);
            }
            if (rows.length < LIMITS.page) { if (declared !== null && declared !== values.length) fail('Inventory pagination omitted records.'); ordered(values); return; }
          }
        }
        const workers = Array.from({ length: 2 }, async () => { while (next < jobs.length) { check(); try { await entity(jobs[next++]); } catch (error) { if (stockMetadata) { stockFailure ||= error; abort(); } throw error; } } });
        if (stockMetadata) { const settled = await Promise.allSettled(workers); const failed = settled.find(row => row.status === 'rejected'); if (failed) throw stockFailure || failed.reason; }
        else await Promise.all(workers);
        check(); stock.items.sort((a, b) => a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0); return { records, stock, evidence: { startedAt: new Date(scanStart).toISOString(), observedAt: new Date(now()).toISOString(), count, manifestHash: manifestHash(records) } };
      }
      guard(); const first = await scan(); check(); const second = await scan(); check();
      if (first.evidence.count !== second.evidence.count || first.evidence.manifestHash !== second.evidence.manifestHash) fail('QuickBooks records changed between inventory scans. Capture a fresh observation.');
      await authority();
      const source = { version, policy: POLICIES[version], scope, coverage: [...TYPES], scans: [first.evidence, second.evidence], records: first.records };
      const result = { ...source, sourceHash: hash(source) }; validateInventoryObservation(result, scope);
      if (!stockMetadata) return result;
      if (canonical(first.stock) !== canonical(second.stock)) fail('Stock metadata changed between complete inventory scans.');
      const stock = { version: 1, scope, recordsHash: hash(first.records), ...first.stock };
      return { inventory: result, stockSource: { ...stock, sourceHash: hash(stock) } };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
module.exports = { createBusinessInventoryReader, validateInventoryObservation, inventorySummary, compactInventoryRecord: compact, TYPES, LIMITS };
