'use strict';
const { scoped } = require('./qbo-write-contract');
const { hash, canonical } = require('./business-calendar');
const { createBusinessTransactionReader } = require('./business-reference');
const TRANSACTIONS = new Set(['Estimate','TimeActivity','Invoice','Payment','Deposit','PurchaseOrder','Bill','SalesReceipt','BillPayment','CreditMemo','Purchase','VendorCredit','RefundReceipt','Transfer','JournalEntry','Customer','Vendor','Item']);
const { runWithCaller } = require('./qbo-request-meter');
const ACTIVE_LISTS = new Set(['Customer','Vendor','Item']);
const QID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_VERIFICATION_UNAVAILABLE' }); }
// Batch exact IDs in one full SELECT per type (up to 50). These are current
// provider observations after the writer fence, never mirror/create responses.
// GET queries avoid introducing a POST read exception into the write gate.
function createBusinessTransactionBatchReader({ access, observations, now = () => Date.now() }) {
  const readRecord = createBusinessTransactionReader({ ...access, now, observationStore: null });
  let retained = null;
  const read = async function read(scope, steps, { signal, writerFence } = {}) {
    scope = scoped(scope); signal?.throwIfAborted();
    const unique = [...new Map(steps.map(step => [step.entity + ':' + step.qboId, step])).values()];
    // Reuse within this operation for at most sixty seconds. A new writer revision
    // needs independent receipt/sync proof that only verification bookkeeping
    // changed. Saves invalidate computed parents even without SyncToken changes.
    // Keep each original observation time.
    let fenceHash = null;
    if (writerFence) {
      require('./business-link-repair-contract').assertReadFence({ ...writerFence, unresolved: writerFence.unresolved ?? null });
      if (canonical(writerFence.scope) !== canonical(scope) || !/^[a-f0-9]{24}$/.test(writerFence.operationId || '') || !Number.isSafeInteger(writerFence.revision) || writerFence.revision < 0) fail('The batch reader requires its exact company writer revision.');
      fenceHash = hash(writerFence);
    }
    const previous = retained;
    let reusable = previous && previous.operationId === writerFence?.operationId && previous.scopeHash === hash(scope) && now() >= previous.started && now() - previous.started <= 60000;
    if (reusable) {
      try { reusable = typeof observations?.unchanged === 'function' ? await observations.unchanged(scope, previous.started, { signal }) === true : previous.fenceHash === fenceHash; }
      catch { signal?.throwIfAborted(); reusable = false; }
    }
    const reused = new Map();
    if (fenceHash && reusable) {
      const actor = await access.authorize(scope, 'operations.read', { signal });
      if (actor?.actorId !== previous.actor.actorId || actor?.ownerId !== previous.actor.ownerId) fail('The batch reader changed authority.');
      for (const step of unique) {
        const key = step.entity + ':' + step.qboId, observed = previous.records.get(key);
        if (observed && now() >= Date.parse(observed.observedAt) && now() - Date.parse(observed.observedAt) <= 60000) reused.set(key, structuredClone(observed));
      }
    }
    const groups = new Map();
    for (const step of unique) {
      if (!TRANSACTIONS.has(step.entity) || !QID.test(step.qboId || '')) fail('Choose exact supported saved records.');
      if (reused.has(step.entity + ':' + step.qboId)) continue;
      if (!groups.has(step.entity)) groups.set(step.entity, []);
      groups.get(step.entity).push(step);
    }
    const jobs = [];
    for (const [entity, rows] of groups) for (let i = 0; i < rows.length; i += 50) jobs.push({ entity, rows: rows.slice(i, i + 50) });
    const started = reusable ? previous.started : now();
    const result = new Map(reused), controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => controller.abort(), 60000); deadline.unref?.();
    let next = 0, failure;
    const check = () => controller.signal.throwIfAborted();
    try {
      await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
        while (!failure && next < jobs.length) {
          const { entity, rows } = jobs[next++];
          try {
            if (rows.length === 1) { const step = rows[0]; result.set(entity + ':' + step.qboId, await readRecord(scope, entity, step.qboId, { signal: controller.signal })); continue; }
            check(); const actor = await access.authorize(scope, 'operations.read', { signal: controller.signal }); check();
            const client = await access.resolveClient(scope, { signal: controller.signal }); check();
            const { QBOClient } = require('./qbo-client');
            const guard = () => {
              const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
              if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall || client.query !== QBOClient.prototype.query || client.apiBase !== base || client.realmId !== scope.realmId || String(client.connection?._id) !== scope.connectionId || String(client.connection?.realmId) !== scope.realmId || client.connection?.status !== 'active' || !/^[a-f0-9]{24}$/.test(actor?.ownerId || '') || !actor?.actorId || String(client.connection?.userId) !== actor.ownerId) fail('The batch reader changed company or owner.');
            };
            const authorize = async () => { check(); guard(); const current = await access.authorize(scope, 'operations.read', { signal: controller.signal }); check(); guard(); if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId) fail('The batch reader changed authority.'); };
            const ids = rows.map(row => row.qboId).sort(), query = 'SELECT * FROM ' + entity + ' WHERE Id IN (' + ids.map(id => "'" + id + "'").join(',') + ')' + (ACTIVE_LISTS.has(entity) ? ' AND Active IN (true,false)' : '') + ' MAXRESULTS 50';
            await authorize();
            const body = await runWithCaller('business-transaction', () => client.query(query, { signal: controller.signal, beforeAttempt: authorize, onFailure: error => { failure ||= error; controller.abort(); } }));
            await authorize();
            const page = body?.QueryResponse, values = page?.[entity];
            if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(body).some(key => !['QueryResponse', 'time'].includes(key)) || !page || Object.getPrototypeOf(page) !== Object.prototype || Object.keys(page).some(key => ![entity, 'startPosition', 'maxResults', 'totalCount'].includes(key)) || !Array.isArray(values) || values.length !== ids.length || page.startPosition !== undefined && page.startPosition !== 1 || page.maxResults !== undefined && page.maxResults !== values.length || page.totalCount !== undefined && page.totalCount !== values.length) fail('The batch query omitted or truncated an exact saved record.');
            const seen = new Set(), observedAt = new Date(now()).toISOString();
            for (const record of values) {
              if (!record || Object.getPrototypeOf(record) !== Object.prototype || !ids.includes(record.Id) || seen.has(record.Id) || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken) || record.sparse !== undefined && record.sparse !== false || record.status === 'Deleted' || Buffer.byteLength(canonical(record)) > 256000) fail('The batch query returned a partial, repeated or unrelated record.');
              seen.add(record.Id); const copied = JSON.parse(canonical(record)), recordHash = hash(copied);
              result.set(entity + ':' + record.Id, { scope, entity, record: copied, recordHash, observedAt, source: { version: 1, kind: 'qbo-full-entity-query', scope, entity, id: record.Id, recordHash, query } });
            }
          } catch (error) { failure ||= error; controller.abort(); }
        }
      }));
      if (failure) throw failure;
      check();
      if (fenceHash) {
        const actor = await access.authorize(scope, 'operations.read', { signal: controller.signal }); check();
        retained = { fenceHash, scopeHash: hash(scope), operationId: writerFence.operationId, started, actor, records: new Map([...(reusable ? previous.records : []), ...[...result].map(([key, value]) => [key, structuredClone(value)])]) };
      }
      return result;
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
  Object.defineProperty(read, 'supports', { value: entity => TRANSACTIONS.has(entity) });
  read.clear = () => { retained = null; };
  return read;
}
module.exports = { createBusinessTransactionBatchReader };
