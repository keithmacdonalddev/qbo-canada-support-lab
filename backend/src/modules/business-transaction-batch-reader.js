'use strict';
const { scoped } = require('./qbo-write-contract');
const { createBusinessTransactionReader } = require('./business-reference');
// A query, mirror or write response can retain pre-child balances/backlinks and
// computed TimeActivity states. Read each exact record after the graph's writer
// fence, using the same full-entity GET contract as compilation and period guards.
function createBusinessTransactionBatchReader({ access, now = () => Date.now() }) {
  const readRecord = createBusinessTransactionReader({ ...access, now, observationStore: null });
  return async function read(scope, steps, { signal } = {}) {
    scope = scoped(scope); signal?.throwIfAborted();
    const unique = [...new Map(steps.map(step => [step.entity + ':' + step.qboId, step])).values()];
    const result = new Map(), controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    let next = 0, failure;
    try {
      await Promise.all(Array.from({ length: Math.min(3, unique.length) }, async () => {
        while (!failure && next < unique.length) {
          const step = unique[next++];
          try {
            const observed = await readRecord(scope, step.entity, step.qboId, { signal: controller.signal });
            result.set(step.entity + ':' + step.qboId, observed);
          } catch (error) { failure ||= error; controller.abort(); }
        }
      }));
      if (failure) throw failure;
      signal?.throwIfAborted();
      return result;
    } finally { signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
module.exports = { createBusinessTransactionBatchReader };
