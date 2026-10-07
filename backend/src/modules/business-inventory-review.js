'use strict';
const { scoped } = require('./qbo-write-contract');
const { canonical } = require('./business-calendar');
const { compactInventoryRecord, TYPES } = require('./business-record-inventory');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/, QID = /^\d{1,30}$/;
const LISTS = new Set(['Customer', 'Vendor', 'Item', 'Account']);
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_RECORD_REVIEW_UNVERIFIED' }); }
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
// Compare the same full-query representation used by capture. Neither a receipt
// nor a matching comparison grants adoption, accounting acceptance or write access.
function createBusinessInventoryReviewReader({ access, readOrigin, now = () => Date.now() }) {
  if ([access?.authorize, access?.resolveClient, readOrigin, now].some(fn => typeof fn !== 'function')) throw new TypeError('Inventory review requires scoped read authority');
  return async function review(evidence, { signal } = {}) {
    const scope = scoped(evidence?.scope), entity = evidence?.entity, saved = evidence?.record;
    if (!ID.test(evidence?.baselineId || '') || !HASH.test(evidence?.evidenceHash || '') || !HASH.test(evidence?.inventoryHash || '') || !TYPES.includes(entity) || typeof saved?.id !== 'string' || !QID.test(saved.id) || typeof saved.syncToken !== 'string' || !/^(0|[1-9]\d{0,63})$/.test(saved.syncToken) || !HASH.test(saved.contentHash || '')) fail('An exact captured record is required.', 400);
    const started = now(), controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 60000); timer.unref?.();
    const check = () => { const current = now(); if (controller.signal.aborted || !Number.isFinite(started) || !Number.isFinite(current) || current < started || current - started > 60000) fail('Record comparison was cancelled or exceeded one minute.'); };
    const call = factory => new Promise((resolve, reject) => {
      const stopped = () => { try { check(); } catch (error) { reject(error); } };
      if (controller.signal.aborted) return stopped();
      controller.signal.addEventListener('abort', stopped, { once: true });
      Promise.resolve().then(() => { check(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stopped));
    });
    try {
      check(); const actor = await call(() => access.authorize(scope, 'baseline.review', { signal: controller.signal })); check();
      if (!ID.test(actor?.actorId || '') || !ID.test(actor?.ownerId || '')) fail('Current record-review authority is required.');
      const client = await call(() => access.resolveClient(scope, { signal: controller.signal })); check();
      const { QBOClient } = require('./qbo-client');
      const guard = () => {
        const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
        if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall || client.query !== QBOClient.prototype.query || client.apiBase !== base || client.realmId !== scope.realmId || String(client.connection?._id) !== scope.connectionId || String(client.connection?.realmId) !== scope.realmId || client.connection?.status !== 'active' || String(client.connection?.userId) !== actor.ownerId) fail('Record review client changed company or owner.');
      };
      const authority = async () => { check(); guard(); const current = await call(() => access.authorize(scope, 'baseline.review', { signal: controller.signal })); check(); guard(); if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId) fail('Record review authority changed.'); };
      await authority();
      const query = 'SELECT * FROM ' + entity + " WHERE Id = '" + saved.id + "'" + (LISTS.has(entity) ? ' AND Active IN (true, false)' : '') + ' MAXRESULTS 2';
      const body = await call(() => client.query(query)); check(); guard();
      const observedAt = new Date(now()).toISOString();
      if (!plain(body) || Buffer.byteLength(canonical(body)) > 2000000 || Object.keys(body).some(key => !['QueryResponse', 'time'].includes(key)) || !plain(body.QueryResponse)) fail('The current record query is incomplete.');
      const page = body.QueryResponse, rows = page[entity] === undefined ? [] : page[entity];
      if (Object.keys(page).some(key => ![entity, 'startPosition', 'maxResults', 'totalCount'].includes(key)) || !Array.isArray(rows) || rows.length > 1 || (rows.length && page.startPosition !== 1) || (page.startPosition !== undefined && page.startPosition !== 1) || (page.maxResults !== undefined && page.maxResults !== rows.length) || (page.totalCount !== undefined && page.totalCount !== rows.length)) fail('The current record response is ambiguous or incomplete.');
      let current = null;
      if (rows.length) { current = compactInventoryRecord(entity, rows[0]); if (current.id !== saved.id) fail('QuickBooks returned a different record.'); }
      await authority();
      let origin;
      try {
        origin = await call(() => readOrigin({ userId: actor.ownerId, realmId: scope.realmId, environment: scope.environment, entity, id: saved.id }));
        if (!origin || origin.entity !== entity || origin.id !== saved.id || !Array.isArray(origin.sources) || typeof origin.complete !== 'boolean' || !['recorded', 'historical_match', 'unknown', 'incomplete'].includes(origin.status)) throw new Error('Incomplete origin');
      } catch { origin = { entity, id: saved.id, status: 'unavailable', complete: false, sources: [], baseline: 'unclassified' }; }
      await authority();
      const comparison = !current ? 'not-returned' : current.syncToken !== saved.syncToken ? 'different-version' : current.contentHash !== saved.contentHash ? 'different-content' : 'matches';
      const publicRecord = value => { if (!value) return null; const { contentHash, ...record } = value; return record; };
      return { scope, baselineId: evidence.baselineId, evidenceHash: evidence.evidenceHash, inventoryHash: evidence.inventoryHash, entity, id: saved.id,
        captured: { ...publicRecord(saved), observedAt: evidence.observedAt }, current: current ? { ...publicRecord(current), observedAt } : null,
        comparison, checkedAt: new Date(now()).toISOString(), origin, ownership: 'unclassified', writeAllowed: false,
        limitation: 'This is a current read compared with the captured query result. A content difference does not identify its cause; no result establishes business membership, deletion history, accounting correctness or permission to change the record.' };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
module.exports = { createBusinessInventoryReviewReader };
