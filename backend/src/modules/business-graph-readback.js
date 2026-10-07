'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { validateCompilation, verifyBusinessContent, verifyBusinessReadback } = require('./business-readback');
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/i;
const MAX_RECORDS = 1000, MAX_BYTES = 32000000;
function fail(message, code = 'BUSINESS_GRAPH_UNVERIFIED') { throw Object.assign(new Error(message), { status: 409, code }); }
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => String(a?.[key]) === String(b?.[key]));
function rootKeys(values) {
  if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(key => typeof key !== 'string' || !HASH.test(key)) || new Set(values).size !== values.length) fail('Choose one to one hundred distinct managed activity keys.');
  return [...values].sort();
}
function normalizeStep(row, scope) {
  if (!row || !sameScope(row, scope) || row.contractVersion !== 1 || !['saved', 'verified'].includes(row.state) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !ID.test(String(row.operationId)) || !HASH.test(row.planHash || '') || !Array.isArray(row.dependencies) || row.dependencies.length > 20) fail('A related activity is missing or its save is unresolved.');
  const compiled = row.compilation, request = validateCompilation(compiled), receipt = row.receipt;
  if (!sameScope(request.scope, scope) || compiled.logicalKey !== row.logicalKey || compiled.entity !== row.entity || compiled.intentHash !== row.fingerprint || compiled.compilationHash !== row.dispatch?.compilationHash || compiled.evidenceHash !== row.dispatch?.evidenceHash || request.requestHash !== row.dispatch?.requestHash || !HASH.test(row.dispatch?.key || '') || !receipt || receipt.version !== 1 || receipt.dispatchKey !== row.dispatch.key || receipt.requestHash !== request.requestHash || receipt.qboId !== row.qboId) fail('A related record no longer matches its original dispatch and receipt.');
  const expected = compiled.relationships.map(link => ({ logicalKey: link.logicalKey, entity: link.entity, fingerprint: link.fingerprint })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
  const actual = row.dependencies.map(link => ({ logicalKey: link.logicalKey, entity: link.entity, fingerprint: link.fingerprint })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
  if (canonical(expected) !== canonical(actual)) fail('The saved dependency graph differs from original compilation.');
  return { ...scope, contractVersion: 1, operationId: String(row.operationId), planHash: row.planHash, logicalKey: row.logicalKey, entity: row.entity, fingerprint: row.fingerprint, state: row.state, revision: row.revision, qboId: row.qboId,
    dependencies: actual, compilation: structuredClone(compiled), dispatch: structuredClone(row.dispatch), receipt: structuredClone(receipt) };
}
function topology(scope, roots, entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_RECORDS) fail('The related-record graph exceeds its supported size.');
  const nodes = new Map(), physical = new Set(); let bytes = 0;
  for (const entry of entries) {
    const step = normalizeStep(entry.step, scope), key = step.logicalKey, physicalKey = step.entity + ':' + step.qboId;
    if (nodes.has(key) || physical.has(physicalKey)) fail('A managed activity or physical record appears twice.');
    bytes += Buffer.byteLength(JSON.stringify(entry)); if (bytes > MAX_BYTES) fail('The related-record evidence exceeds its size budget.');
    nodes.set(key, { ...entry, step, parents: [], children: [], linkedChildren: [] }); physical.add(physicalKey);
  }
  for (const node of nodes.values()) for (const link of node.step.compilation.relationships) {
    const parent = nodes.get(link.logicalKey);
    if (!parent || parent.step.entity !== link.entity || parent.step.fingerprint !== link.fingerprint || parent.step.qboId !== link.qboId) fail('An exact originating managed activity is missing.');
    node.parents.push(link.logicalKey); parent.children.push(node.step.logicalKey);
    if (link.kind === 'linked') parent.linkedChildren.push(node.step.logicalKey);
  }
  const reached = new Set(), queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i], node = nodes.get(key); if (!node) fail('A requested activity is missing.');
    if (reached.has(key)) continue; reached.add(key); queue.push(...node.parents, ...node.children);
  }
  if (reached.size !== nodes.size) fail('Unrelated activities cannot be included in one verification graph.');
  const degrees = new Map([...nodes].map(([key, node]) => [key, node.parents.length]));
  const ready = [...nodes.keys()].filter(key => degrees.get(key) === 0).sort(), order = [];
  for (let i = 0; i < ready.length; i++) {
    const key = ready[i]; order.push(key);
    for (const child of nodes.get(key).children.sort()) { degrees.set(child, degrees.get(child) - 1); if (degrees.get(child) === 0) ready.push(child); }
  }
  if (order.length !== nodes.size) fail('Managed activity dependencies contain a cycle.');
  return { nodes, order };
}
function reconcileBusinessGraph({ scope, roots, entries, now = Date.now() }) {
  scope = scoped(scope); roots = rootKeys(roots);
  if (!Number.isFinite(now)) fail('A valid verification clock is required.');
  const { nodes, order } = topology(scope, roots, entries), content = new Map(), completed = new Map(), failures = new Map();
  const observation = key => { const node = nodes.get(key); return { ...node.observed, logicalKey: key, fingerprint: node.step.fingerprint, state: 'saved' }; };
  const input = key => {
    const node = nodes.get(key), step = node.step;
    return { compiled: step.compilation, receipt: { ...step.receipt, scope, entity: step.entity, logicalKey: key }, observed: node.observed, taxPolicy: node.taxPolicy, now,
      parents: node.parents.map(observation), descendants: node.linkedChildren.map(childKey => { const child = nodes.get(childKey); return { ...observation(childKey), compilationHash: child.step.compilation.compilationHash, creationReceipt: { ...child.step.receipt, scope, entity: child.step.entity, logicalKey: childKey }, verification: content.get(childKey) }; }) };
  };
  const recordFailure = (key, messages) => failures.set(key, { logicalKey: key, entity: nodes.get(key).step.entity, status: 'unverified', issues: messages });
  // Child content is checked first, without falsely claiming its parent closure.
  for (const key of [...order].reverse()) {
    const node = nodes.get(key);
    if (node.linkedChildren.some(child => content.get(child)?.matchesIntent !== true)) { recordFailure(key, ['A linked downstream activity is unverified.']); continue; }
    const proof = verifyBusinessContent(input(key)); content.set(key, proof);
    if (!proof.matchesIntent) recordFailure(key, proof.issues);
  }
  // Now close the actual parent graph in forward order, using this same snapshot.
  for (const key of order) {
    const node = nodes.get(key); if (content.get(key)?.matchesIntent !== true) continue;
    if (node.parents.some(parent => !completed.has(parent))) { recordFailure(key, ['An originating activity is unverified.']); continue; }
    const value = input(key); value.parents = node.parents.map(parent => ({ ...observation(parent), state: 'verified', verification: completed.get(parent) }));
    const proof = verifyBusinessReadback(value); if (proof.matchesIntent) completed.set(key, proof); else recordFailure(key, proof.issues);
  }
  const records = order.map(key => ({ logicalKey: key, entity: nodes.get(key).step.entity, qboId: nodes.get(key).step.qboId, fingerprint: nodes.get(key).step.fingerprint, stepRevision: nodes.get(key).step.revision, compilationHash: nodes.get(key).step.compilation.compilationHash, proof: completed.get(key) || null }));
  const complete = completed.size === nodes.size;
  return { version: 1, scope, roots, complete, recordCount: nodes.size, order, records, failures: [...failures.values()].sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)),
    observedAt: records.filter(value => value.proof).map(value => value.proof.observedAt).sort()[0] || null,
    evidenceHash: hash({ scope, roots, records, failures: [...failures.values()].sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)) }), persisted: false };
}
// This reader owns no defaults and performs no writes. Its model snapshot loads both
// directions so omitting a known saved child cannot turn a used source into unused.
function createBusinessGraphReader({ Steps, transaction, assertReady, authorize, readFence, readRecord, loadTaxPolicy, now = () => Date.now() }) {
  if (!Steps || [transaction, assertReady, authorize, readFence, readRecord, loadTaxPolicy, now].some(value => typeof value !== 'function')) throw new TypeError('Graph reading needs explicit company-scoped adapters');
  function checkedFence(value, scope) {
    if (!value || !sameScope(value.scope, scope) || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.unresolved !== null || !ID.test(value.operationId || '')) fail('The company writer has an unresolved or unavailable state.');
    return { scope, revision: value.revision, operationId: value.operationId };
  }
  return async ({ scope, roots, signal, mode = 'read', expectedWriterFence = null }) => {
    scope = scoped(scope); roots = rootKeys(roots);
    if (!['prepare', 'read'].includes(mode)) fail('Unsupported graph read mode.');
    const started = now(), controller = new AbortController();
    const abort = () => controller.abort(signal?.reason); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => controller.abort(Object.assign(new Error('Graph verification exceeded its three-minute read budget.'), { status: 409, code: 'BUSINESS_GRAPH_EXPIRED' })), 180000);
    deadline.unref?.();
    const check = () => { if (controller.signal.aborted) { if (controller.signal.reason?.code === 'BUSINESS_GRAPH_EXPIRED') throw controller.signal.reason; fail('Graph verification was cancelled.', 'BUSINESS_GRAPH_CANCELLED'); } if (now() - started > 180000) { const error = Object.assign(new Error('Graph verification exceeded its three-minute read budget.'), { status: 409, code: 'BUSINESS_GRAPH_EXPIRED' }); controller.abort(error); throw error; } };
    const read = factory => new Promise((resolve, reject) => {
      const cancelled = () => { try { check(); } catch (error) { reject(error); } };
      if (controller.signal.aborted) { cancelled(); return; }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { check(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
    });
    try {
      await read(() => assertReady({ signal: controller.signal })); check();
      const actor = await read(() => authorize(scope, 'operations.read', { signal: controller.signal })); check();
      if (!actor?.actorId) fail('Company read permission is required.');
      const fence = checkedFence(await read(() => readFence(scope, { signal: controller.signal })), scope); check();
      if (expectedWriterFence && canonical(expectedWriterFence) !== canonical(fence)) fail('Company activity changed before the verification read.');
      const rows = await read(() => transaction(async session => {
        check(); const current = await read(() => authorize(scope, 'operations.read', { signal: controller.signal })); check(); if (current?.actorId !== actor.actorId) fail('The company reader changed.');
        const found = new Map(), expanded = new Set(), pending = [...roots]; let bytes = 0;
        while (pending.length) {
          check(); const batch = [...new Set(pending.splice(0, 100))].filter(key => !expanded.has(key)); if (!batch.length) continue;
          const query = { environment: scope.environment, realmId: scope.realmId };
          const retain = row => {
            const normalized = normalizeStep(row, scope), key = normalized.logicalKey;
            if (!found.has(key)) {
              bytes += Buffer.byteLength(JSON.stringify(normalized));
              if (found.size >= MAX_RECORDS || bytes > MAX_BYTES) fail('The related-record graph exceeds its supported budget.');
              found.set(key, normalized);
            }
            if (!expanded.has(key)) pending.push(key); for (const link of normalized.dependencies) if (!expanded.has(link.logicalKey)) pending.push(link.logicalKey);
          };
          const scan = async (filter, accept) => {
            check();
            const cursor = Steps.find(filter).select('contractVersion realmId environment connectionId operationId planHash logicalKey fingerprint entity dependencies state revision qboId compilation dispatch receipt').session(session).limit(MAX_RECORDS + 1).maxTimeMS(10000).lean().cursor({ batchSize: 1 });
            let closed = null;
            const close = () => { if (!closed) closed = Promise.resolve().then(() => cursor.close()); return closed; };
            const cancelCursor = () => { close().catch(() => {}); };
            controller.signal.addEventListener('abort', cancelCursor, { once: true });
            try {
              let count = 0;
              for (;;) { const row = await read(() => cursor.next()); check(); if (!row) break; if (++count > MAX_RECORDS) fail('The related-record graph exceeds its supported budget.'); accept(row); }
            } finally {
              controller.signal.removeEventListener('abort', cancelCursor);
              let cleanupTimer;
              try { await Promise.race([close(), new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('Graph cursor cleanup timed out.')), 5000); cleanupTimer.unref?.(); })]); }
              finally { clearTimeout(cleanupTimer); }
            }
          };
          const directKeys = new Set();
          await scan({ ...query, logicalKey: { $in: batch } }, row => { directKeys.add(row.logicalKey); retain(row); });
          if (batch.some(key => !directKeys.has(key))) fail('A required managed activity is missing from storage.');
          await scan({ ...query, 'dependencies.logicalKey': { $in: batch }, state: { $in: ['saved', 'verified', 'dispatched', 'unknown'] } }, retain);
          for (const key of batch) expanded.add(key);
        }
        return [...found.values()].sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
      }, { signal: controller.signal })); check();
      if (mode === 'prepare') {
        topology(scope, roots, rows.map(step => ({ step })));
        const currentActor = await read(() => authorize(scope, 'operations.read', { signal: controller.signal })); check();
        const after = checkedFence(await read(() => readFence(scope, { signal: controller.signal })), scope); check();
        if (currentActor?.actorId !== actor.actorId || canonical(fence) !== canonical(after)) fail('Company activity changed during graph preparation.');
        const records = rows.map(step => ({ logicalKey: step.logicalKey, entity: step.entity, fingerprint: step.fingerprint, qboId: step.qboId, stepRevision: step.revision, compilationHash: step.compilation.compilationHash }));
        const manifest = { version: 1, scope, roots, records, writerFence: fence };
        return { ...manifest, kind: 'business-graph-preparation', recordCount: records.length, evidenceHash: hash(manifest), prepared: true };
      }
      const entries = new Array(rows.length); let next = 0, firstError = null, retainedBytes = 0;
      const worker = async () => {
        while (!firstError && next < rows.length) {
          const index = next++, step = rows[index];
          try {
            check(); const observed = await read(() => readRecord(scope, step.entity, step.qboId, { signal: controller.signal })); check();
            const taxPolicy = await read(() => loadTaxPolicy(scope, step.compilation, { signal: controller.signal })); check();
            const entry = { step, observed, taxPolicy };
            retainedBytes += Buffer.byteLength(JSON.stringify(entry));
            if (retainedBytes > MAX_BYTES) fail('The related-record evidence exceeds its size budget.');
            entries[index] = entry;
          } catch (error) { firstError ||= error; controller.abort(); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, rows.length) }, worker)); if (firstError) throw firstError;
      check(); const currentActor = await read(() => authorize(scope, 'operations.read', { signal: controller.signal })); check();
      const after = checkedFence(await read(() => readFence(scope, { signal: controller.signal })), scope); check();
      if (currentActor?.actorId !== actor.actorId || canonical(fence) !== canonical(after)) fail('Company activity changed while related records were being read.');
      const result = reconcileBusinessGraph({ scope, roots, entries, now: now() }); check();
      return { ...result, writerFence: fence, evidenceHash: hash({ graph: result.evidenceHash, writerFence: fence }), durationMs: now() - started };
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
module.exports = { reconcileBusinessGraph, createBusinessGraphReader, MAX_RECORDS, MAX_BYTES };
