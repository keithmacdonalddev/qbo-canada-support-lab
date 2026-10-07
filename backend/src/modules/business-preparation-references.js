'use strict';
const { canonical, hash } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { createBusinessReferenceReader, bindBusinessReference } = require('./business-reference');
const ID = /^[a-f0-9]{24}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => a?.[key] === b?.[key]);
function fail(message) { throw Object.assign(new Error(message), { status: 409, businessPlanError: true, code: 'BUSINESS_PREPARATION_CHANGED' }); }
// Server-owned read-only preparation. Full definitions are observed here, never
// approved here. Unresolved choices and earlier-transaction blockers are retained.
async function bindPreparedOperationReferences(prepared, { authorize, resolveClient, now = () => Date.now(), signal } = {}) {
  if ([authorize, resolveClient, now].some(value => typeof value !== 'function')) throw new TypeError('Preparation needs current authority and a scoped company client');
  const serialized = canonical(prepared);
  if (Buffer.byteLength(serialized) > 8000000) fail('The prepared activity exceeds its observation budget.');
  const copy = JSON.parse(serialized), scope = scoped(copy.scope);
  const { operationHash, preparedAt, readyToExecute, persisted, summary, limitations, ...payload } = copy;
  if (copy.version !== 1 || readyToExecute !== false || persisted !== false || hash(payload) !== operationHash || !Array.isArray(payload.steps) || payload.steps.length > 500) fail('Prepare the current activity again before reading its record definitions.');
  const started = now(), controller = new AbortController();
  const stamp = Date.parse(preparedAt);
  if (!Number.isFinite(started) || !Number.isFinite(stamp) || stamp > started || started - stamp > 300000) fail('The prepared activity is stale. Prepare it again.');
  const unique = new Map();
  for (const step of payload.steps) {
    if (!Array.isArray(step.references) || step.references.length > 100) fail('The prepared record choices are incomplete.');
    for (const ref of step.references.filter(value => value.status === 'resolved')) {
      if (typeof ref.syncToken !== 'string' || !VERSION.test(ref.syncToken)) fail('A selected record has no exact version.');
      const key = ref.entity + ':' + ref.id, existing = unique.get(key);
      if (existing && existing.syncToken !== ref.syncToken) fail('The same company record has conflicting observed versions.');
      unique.set(key, ref);
    }
  }
  if (unique.size > 250) fail('This operation needs more than 250 distinct record reads. Shorten its period.');
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 180000); timer.unref?.();
  const check = () => { const time = now(); if (controller.signal.aborted || !Number.isFinite(time) || time < started || time - started > 180000) fail('Record preparation was cancelled or exceeded its three-minute budget.'); };
  const call = factory => new Promise((resolve, reject) => {
    const cancelled = () => { try { check(); } catch (error) { reject(error); } };
    if (controller.signal.aborted) { cancelled(); return; }
    controller.signal.addEventListener('abort', cancelled, { once: true });
    Promise.resolve().then(() => { check(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
  });
  try {
    const actor = await call(() => authorize(scope, 'operations.preview', { signal: controller.signal })); check();
    if (!ID.test(actor?.actorId || '') || !ID.test(actor?.ownerId || '')) fail('Current company preparation permission is required.');
    const read = createBusinessReferenceReader({ now, authorize: async (...args) => {
      const current = await authorize(...args);
      if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId) fail('The company reader changed during preparation.');
      return current;
    }, resolveClient: async (...args) => {
      const client = await resolveClient(...args);
      const { QBOClient } = require('./qbo-client');
      if (!(client instanceof QBOClient) || client.read !== QBOClient.prototype.read || client.apiCall !== QBOClient.prototype.apiCall || String(client.connection?.userId) !== actor.ownerId) fail('Preparation requires the original company reader.');
      return client;
    } });
    const observations = new Map(), jobs = [...unique.entries()]; let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        check(); const [key, ref] = jobs[next++];
        const observed = await call(() => read(scope, ref.entity, ref.id, { signal: controller.signal })); check();
        if (observed.record.SyncToken !== ref.syncToken) fail('A chosen company record changed during preparation. Prepare the activity again.');
        observations.set(key, observed);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker)); check();
    for (const step of payload.steps) step.references = step.references.map(ref => ref.status !== 'resolved' ? ref : {
      ...ref, ...bindBusinessReference({ scope, key: ref.key, entity: ref.entity, observed: observations.get(ref.entity + ':' + ref.id), now: now() }),
    });
    const current = await call(() => authorize(scope, 'operations.preview', { signal: controller.signal })); check();
    if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId || !sameScope(scope, payload.scope)) fail('The company reader changed during preparation.');
    payload.referenceDefinitions = { version: 1, distinctRecords: observations.size, observedAt: new Date(now()).toISOString(),
      sourceHash: hash([...observations.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, recordHash: value.recordHash, observedAt: value.observedAt }))) };
    if (Buffer.byteLength(canonical(payload)) > 8000000) fail('The bound activity exceeds its observation budget.');
    return { ...payload, operationHash: hash(payload), preparedAt: new Date(now()).toISOString(), readyToExecute: false, persisted: false, summary, limitations };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}
module.exports = { bindPreparedOperationReferences };
