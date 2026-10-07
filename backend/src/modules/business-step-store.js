'use strict';
const { randomUUID } = require('node:crypto');
const { hash, canonical } = require('./business-calendar');
const { validateCompilation } = require('./business-readback');
const ID = /^[a-f0-9]{24}$/i, HASH = /^[a-f0-9]{64}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const ENTITIES = new Set(['Estimate', 'PurchaseOrder', 'Invoice', 'SalesReceipt', 'Bill', 'Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'Deposit', 'JournalEntry', 'TimeActivity']);
const MAX_ATTEMPTS = 20, FRESH_MS = 300000;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function validHash(value) { return typeof value === 'string' && HASH.test(value); }
function scopeOf(scope) {
  if (!scope || typeof scope.realmId !== 'string' || !/^\d{1,30}$/.test(scope.realmId) || !['production', 'sandbox'].includes(scope.environment) || typeof scope.connectionId !== 'string' || !ID.test(scope.connectionId)) fail('Exact company connection is required', 400);
  return { realmId: scope.realmId, environment: scope.environment, connectionId: scope.connectionId };
}
function sameScope(a, b) { return ['realmId', 'environment', 'connectionId'].every(key => String(a?.[key]) === String(b?.[key])); }
function fresh(value, now) { const stamp = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(stamp) && new Date(stamp).toISOString() === value && stamp <= now && now - stamp <= FRESH_MS; }
function validateIntent(intent, scope, operationId, logicalKey) {
  if (!intent || intent.version !== 1 || !sameScope(intent.scope, scope) || intent.operationId !== operationId || intent.logicalKey !== logicalKey || !validHash(intent.planHash) || !validHash(intent.fingerprint) || !ENTITIES.has(intent.entity) || !Array.isArray(intent.dependencies) || intent.dependencies.length > 20 || intent.dependencies.some(link => !link || !validHash(link.logicalKey) || link.logicalKey === logicalKey || !validHash(link.fingerprint) || !ENTITIES.has(link.entity)) || new Set(intent.dependencies.map(link => link.logicalKey)).size !== intent.dependencies.length) fail('The saved step intent is missing or invalid');
  return { contractVersion: 1, ...scope, operationId, planHash: intent.planHash, logicalKey, fingerprint: intent.fingerprint, entity: intent.entity, dependencies: intent.dependencies.map(link => ({ logicalKey: link.logicalKey, fingerprint: link.fingerprint, entity: link.entity })) };
}
function assertIdentity(row, intent, requireOwner = true) {
  if (!row || row.contractVersion !== 1 || !sameScope(row, intent) || row.logicalKey !== intent.logicalKey || row.entity !== intent.entity || row.fingerprint !== intent.fingerprint || canonical(row.dependencies) !== canonical(intent.dependencies) || (requireOwner && (String(row.operationId) !== intent.operationId || row.planHash !== intent.planHash))) fail('Existing activity belongs to another operation or differs from the saved intent');
}
function assertHandle(row, handle, now, requireLive = false) {
  if (!handle || handle.revision !== row.revision || handle.leaseToken !== row.leaseToken || typeof handle.leaseToken !== 'string' || !handle.leaseToken || (requireLive && !(new Date(row.leaseExpiresAt).getTime() > now))) fail('This worker no longer owns the step revision');
}
function publicHandle(row) { return { revision: row.revision, leaseToken: row.leaseToken }; }
function proofRequest(row) {
  // Lean Mongo documents still contain BSON IDs. Normalize before cloning plain evidence.
  return { ...scopeOf({ realmId: row.realmId, environment: row.environment, connectionId: String(row.connectionId) }),
    operationId: String(row.operationId), logicalKey: row.logicalKey, entity: row.entity, planHash: row.planHash,
    fingerprint: row.fingerprint, revision: row.revision, state: row.state, qboId: row.qboId || null,
    dependencies: structuredClone(row.dependencies), dispatch: structuredClone(row.dispatch), receipt: structuredClone(row.receipt) };
}
function validateReceipt(value, row) {
  if (!value || value.version !== 1 || !sameScope(value.scope, row) || value.entity !== row.entity || value.logicalKey !== row.logicalKey || value.dispatchKey !== row.dispatch?.key || value.requestHash !== row.dispatch?.requestHash || typeof value.qboId !== 'string' || !/^\d{1,30}$/.test(value.qboId) || typeof value.syncToken !== 'string' || !VERSION.test(value.syncToken) || !validHash(value.evidenceHash) || !['create-response', 'request-correlated-readback'].includes(value.source)) fail('A receipt must prove the exact scoped dispatch and saved record');
  return { version: 1, dispatchKey: value.dispatchKey, requestHash: value.requestHash, qboId: value.qboId, syncToken: value.syncToken, evidenceHash: value.evidenceHash, source: value.source };
}

function validateReadback(proof, row, clock) {
  if (!proof || proof.kind !== 'business-readback' || proof.compilationHash !== row.dispatch?.compilationHash || !validHash(proof.compilationHash) || proof.version !== 1 || !sameScope(proof.scope, row) || proof.logicalKey !== row.logicalKey || proof.entity !== row.entity || proof.qboId !== row.qboId || proof.fingerprint !== row.fingerprint || proof.matchesIntent !== true || !validHash(proof.observedHash) || !validHash(proof.evidenceHash) || typeof proof.syncToken !== 'string' || !VERSION.test(proof.syncToken) || !fresh(proof.observedAt, clock) || !Array.isArray(proof.relationships) || proof.relationships.length !== row.dependencies.length || new Set(proof.relationships.map(link => link.logicalKey)).size !== row.dependencies.length) fail('Read-back does not prove the exact saved intent and relationships');
}
function verificationData(proof) {
  return { version: 1, kind: 'business-readback', compilationHash: proof.compilationHash, observedHash: proof.observedHash, evidenceHash: proof.evidenceHash, syncToken: proof.syncToken, observedAt: proof.observedAt, relationships: proof.relationships.map(link => ({ logicalKey: link.logicalKey, entity: link.entity, qboId: link.qboId, syncToken: link.syncToken })) };
}

// Internal only. No default models, authority, audit, dispatch or evidence adapters.
// fence MUST atomically write/fence the exact calendar/run/global-writer revision in
// the supplied transaction. A dispatched/unknown step holds a non-expiring writer
// barrier until its outcome is settled. A read-only preflight is NOT this contract.
function createBusinessStepStore({ Steps, loadIntent, authorize, assertReady, transaction, fence, writeAudit, loadRecovery, loadReadback, loadGraphReadback, graphSnapshot, now = () => Date.now(), token = randomUUID }) {
  for (const fn of [loadIntent, authorize, assertReady, transaction, fence, writeAudit, loadRecovery, now, token]) if (typeof fn !== 'function') throw new TypeError('Step storage requires explicit trusted adapters');
  if (typeof loadReadback !== 'function' && typeof loadGraphReadback !== 'function') throw new TypeError('Step storage requires a saved-record verification adapter');
  async function context(scope, operationId, logicalKey, action) {
    scope = scopeOf(scope);
    if (typeof operationId !== 'string' || !ID.test(operationId) || !validHash(logicalKey)) fail('Valid operation and activity identifiers are required', 400);
    await assertReady();
    const actor = await authorize(scope, action);
    if (!actor || typeof actor.actorId !== 'string' || !actor.actorId) fail('Business operation permission is required', 403);
    const savedIntent = await loadIntent(scope, operationId, logicalKey);
    const intent = validateIntent(savedIntent, scope, operationId, logicalKey);
    const kind = savedIntent.kind;
    if (!['create', 'existing'].includes(kind)) fail('The saved activity disposition is invalid');
    return { scope, actorId: actor.actorId, intent, kind, action };
  }
  const filter = ctx => ({ environment: ctx.scope.environment, realmId: ctx.scope.realmId, logicalKey: ctx.intent.logicalKey });
  async function guarded(ctx, phase, session, dispatch = null, receipt = null, step = null) {
    const actor = await authorize(ctx.scope, ctx.action);
    if (actor?.actorId !== ctx.actorId) fail('The operation actor changed', 403);
    const result = await fence({ scope: ctx.scope, intent: ctx.intent, actorId: ctx.actorId, phase, dispatch, receipt, runLeaseToken: ctx.runLeaseToken, step: step ? { state: step.state, revision: step.revision, leaseToken: step.leaseToken } : null, session });
    if (!result || !sameScope(result.scope, ctx.scope) || result.operationId !== ctx.intent.operationId || result.planHash !== ctx.intent.planHash || result.phase !== phase || !validHash(result.fenceHash)) fail('The current company writer could not be fenced');
  }
  async function audit(ctx, row, phase, session) {
    const eventKey = 'business-step:' + hash({ scope: ctx.scope, logicalKey: row.logicalKey, revision: row.revision, phase });
    const receipt = await writeAudit(eventKey, { ...ctx.scope, actorId: ctx.actorId, operationId: ctx.intent.operationId, logicalKey: row.logicalKey, phase, revision: row.revision, dispatchKey: row.dispatch?.key || null, qboId: row.qboId || null }, session);
    if (!receipt || receipt.eventKey !== eventKey || typeof receipt.id !== 'string' || !receipt.id) fail('Step transition audit was not saved');
    return receipt.id;
  }
  async function read(ctx, session) { return Steps.findOne(filter(ctx)).session(session).lean(); }
  async function replace(ctx, before, change, phase, session) {
    const next = { ...before, ...change, revision: before.revision + 1 };
    next.lastAuditId = await audit(ctx, next, phase, session);
    const saved = await Steps.findOneAndUpdate({ ...filter(ctx), operationId: before.operationId, planHash: before.planHash, state: before.state, revision: before.revision, leaseToken: before.leaseToken }, { $set: { ...change, revision: next.revision, lastAuditId: next.lastAuditId } }, { new: true, session }).lean();
    if (!saved) fail('Step changed before its transition could be saved');
    return saved;
  }
  async function verifiedClosure(ctx, roots, session, clock) {
    const invalid = () => { const error = new Error('Every prerequisite needs fresh verified content and exact saved relationships'); error.status = 409; error.code = 'BUSINESS_EVIDENCE_UNVERIFIED'; throw error; };
    const expected = new Map(), rows = new Map(), queue = [...roots];
    for (let index = 0; index < queue.length; index++) {
      const link = queue[index];
      if (!link || !validHash(link.logicalKey) || !validHash(link.fingerprint) || !ENTITIES.has(link.entity)) invalid();
      if (expected.has(link.logicalKey)) { if (canonical(expected.get(link.logicalKey)) !== canonical(link)) invalid(); continue; }
      if (expected.size >= 1000) invalid();
      expected.set(link.logicalKey, link);
      const row = await Steps.findOne({ ...ctx.scope, logicalKey: link.logicalKey, entity: link.entity, fingerprint: link.fingerprint, state: 'verified' }).session(session).lean();
      if (row?.verification?.kind !== 'business-readback' || !validHash(row?.dispatch?.compilationHash) || row.verification?.compilationHash !== row.dispatch.compilationHash || !row?.qboId || row.receipt?.qboId !== row.qboId || !fresh(row.verification?.observedAt, clock) || typeof row.verification?.syncToken !== 'string' || !VERSION.test(row.verification.syncToken) || !validHash(row.verification?.observedHash) || !Array.isArray(row.dependencies) || row.dependencies.length > 20) invalid();
      rows.set(link.logicalKey, row); queue.push(...row.dependencies);
    }
    // Verify every stored link version, not only the direct parent's timestamp.
    for (const row of rows.values()) {
      const links = row.verification.relationships;
      if (!Array.isArray(links) || links.length !== row.dependencies.length || new Set(links.map(link => link.logicalKey)).size !== links.length) invalid();
      for (const dependency of row.dependencies) {
        const parent = rows.get(dependency.logicalKey), link = links.find(link => link.logicalKey === dependency.logicalKey);
        if (!parent || !link || link.entity !== parent.entity || link.qboId !== parent.qboId || link.syncToken !== parent.verification.syncToken) invalid();
      }
    }
    // Stored dependency cycles are never accepted as verification.
    const visiting = new Set(), done = new Set();
    const visit = key => { if (visiting.has(key)) invalid(); if (done.has(key)) return; visiting.add(key); for (const link of rows.get(key).dependencies) visit(link.logicalKey); visiting.delete(key); done.add(key); };
    for (const key of rows.keys()) visit(key);
    return rows;
  }
  async function claim(scope, operationId, logicalKey, leaseMs = 60000, { runLeaseToken } = {}) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) fail('Step lease must be 1 to 300 seconds', 400);
    const ctx = await context(scope, operationId, logicalKey, 'operations.execute');
    if (runLeaseToken !== undefined && (typeof runLeaseToken !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(runLeaseToken))) fail('Invalid operation worker lease');
    ctx.runLeaseToken = runLeaseToken;
    if (ctx.kind !== 'create') fail('An earlier activity requires its existing saved receipt; it cannot be recreated');
    const leaseToken = token();
    if (typeof leaseToken !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(leaseToken)) fail('Invalid worker lease token');
    return transaction(async session => {
      await guarded(ctx, 'claim', session);
      const row = await read(ctx, session), clock = now();
      if (row) {
        assertIdentity(row, ctx.intent);
        if (row.state !== 'claimed' || row.dispatch || row.receipt || !Number.isFinite(new Date(row.leaseExpiresAt).getTime()) || new Date(row.leaseExpiresAt).getTime() > clock || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.attempts >= MAX_ATTEMPTS) fail('Activity is busy, already dispatched or requires recovery');
        return publicHandle(await replace(ctx, row, { leaseToken, leaseExpiresAt: new Date(clock + leaseMs), attempts: row.attempts + 1 }, 'claim', session));
      }
      const next = { ...ctx.intent, state: 'claimed', revision: 1, attempts: 1, leaseToken, leaseExpiresAt: new Date(clock + leaseMs), dispatch: null, receipt: null, verification: null };
      next.lastAuditId = await audit(ctx, next, 'claim', session);
      await Steps.create([next], { session });
      return publicHandle(next);
    });
  }
  async function beginDispatch(scope, operationId, logicalKey, handle, compilation, { runLeaseToken } = {}) {
    if (!compilation || !sameScope(compilation.scope, scope) || compilation.operationId !== operationId || compilation.logicalKey !== logicalKey || !validHash(compilation.intentHash) || !validHash(compilation.requestHash) || !validHash(compilation.evidenceHash) || !validHash(compilation.compilationHash) || !Number.isSafeInteger(compilation.writerRevision) || compilation.writerRevision < 0 || compilation.writerRevision >= Number.MAX_SAFE_INTEGER || !fresh(compilation.observedAt, now())) fail('Current compiled request evidence and writer revision are required', 400);
    const { requestHash, evidenceHash, compilationHash, writerRevision, observedAt, intentHash } = compilation;
    let artifact;
    try {
      artifact = structuredClone({ ...Object.fromEntries(['version', 'logicalKey', 'entity', 'intentHash', 'request', 'evidenceHash', 'relationships'].map(key => [key, compilation.artifact?.[key]])), compilationHash });
      if (Buffer.byteLength(JSON.stringify(artifact)) > 8500000) fail('The original compiled artifact exceeds its storage budget', 400);
    } catch { fail('The original compiled artifact cannot be saved within its storage budget', 400); }
    const request = validateCompilation(artifact);
    if (!sameScope(request.scope, scope) || artifact.logicalKey !== logicalKey || artifact.intentHash !== intentHash || artifact.evidenceHash !== evidenceHash || request.requestHash !== requestHash) fail('The original compiled artifact differs from dispatch evidence');
    const ctx = await context(scope, operationId, logicalKey, 'operations.execute');
    if (runLeaseToken !== undefined && (typeof runLeaseToken !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(runLeaseToken))) fail('Invalid operation worker lease');
    ctx.runLeaseToken = runLeaseToken;
    return transaction(async session => {
      const row = await read(ctx, session); assertIdentity(row, ctx.intent); assertHandle(row, handle, now(), true);
      if (row.state !== 'claimed' || row.dispatch || row.receipt) fail('This activity may already have been sent; read-back recovery is required');
      if (row.fingerprint !== intentHash) fail('The compiled transaction differs from this step intent');
      if (!fresh(observedAt, now())) fail('Compiled observations expired before dispatch');
      const parents = await verifiedClosure(ctx, row.dependencies, session, now());
      if (artifact.entity !== row.entity || artifact.relationships.length !== row.dependencies.length || artifact.relationships.some(link => {
        const expected = row.dependencies.find(value => value.logicalKey === link.logicalKey), parent = parents.get(link.logicalKey);
        return !expected || expected.entity !== link.entity || expected.fingerprint !== link.fingerprint || parent?.qboId !== link.qboId || parent?.verification?.syncToken !== link.syncToken;
      })) fail('The compiled artifact no longer matches the saved parent graph');
      const dispatch = { key: hash({ ...ctx.scope, operationId, logicalKey, fingerprint: row.fingerprint, requestHash }), requestHash, evidenceHash, compilationHash, observationWriterRevision: writerRevision, observedAt, actorId: ctx.actorId, markedAt: new Date(now()).toISOString() };
      await guarded(ctx, 'dispatch', session, dispatch, null, row);
      const saved = await replace(ctx, row, { state: 'dispatched', dispatch, compilation: artifact }, 'dispatch', session);
      return { ...publicHandle(saved), dispatch };
    });
  }
  async function markUnknown(scope, operationId, logicalKey, handle) {
    const ctx = await context(scope, operationId, logicalKey, 'operations.recover');
    return transaction(async session => {
      const row = await read(ctx, session); assertIdentity(row, ctx.intent); assertHandle(row, handle, now());
      if (row.state !== 'dispatched') fail('Only an unsettled dispatch may become unknown');
      await guarded(ctx, 'unknown', session, row.dispatch, null, row);
      return publicHandle(await replace(ctx, row, { state: 'unknown' }, 'unknown', session));
    });
  }
  async function saveReceipt(ctx, handle, value, phase) {
    return transaction(async session => {
      const row = await read(ctx, session); assertIdentity(row, ctx.intent); assertHandle(row, handle, now());
      if (!['dispatched', 'unknown'].includes(row.state) || row.receipt) fail('The dispatch already has a saved outcome');
      const receipt = validateReceipt(value, row);
      if (phase === 'recover' && receipt.source !== 'request-correlated-readback') fail('Recovery requires request-correlated saved-record evidence');
      await guarded(ctx, phase, session, row.dispatch, receipt, row);
      // The physical-ID unique index is mandatory; failure rolls back audit/state.
      return replace(ctx, row, { state: 'saved', receipt, qboId: receipt.qboId }, phase, session);
    });
  }
  async function recordSaved(scope, operationId, logicalKey, handle, value) {
    const ctx = await context(scope, operationId, logicalKey, 'operations.record');
    const row = await saveReceipt(ctx, handle, value, 'saved'); return publicHandle(row);
  }
  async function recover(scope, operationId, logicalKey) {
    const ctx = await context(scope, operationId, logicalKey, 'operations.recover');
    const row = await read(ctx); assertIdentity(row, ctx.intent);
    if (!['dispatched', 'unknown'].includes(row.state)) fail('Only an unresolved dispatch requires recovery');
    const proof = await loadRecovery(proofRequest(row));
    // Absence, multiple matches and guesses NEVER make this activity replayable.
    if (!proof || proof.status !== 'found') return { state: row.state, recovered: false, replayAllowed: false };
    const saved = await saveReceipt(ctx, publicHandle(row), proof.receipt, 'recover');
    return { ...publicHandle(saved), state: saved.state, recovered: true, replayAllowed: false };
  }
  async function verifySaved(scope, operationId, logicalKey) {
    if (typeof loadReadback !== 'function') fail('This runtime requires complete graph verification.');
    const ctx = await context(scope, operationId, logicalKey, 'operations.verify');
    // This readback-only path may refresh an identical intent for a later operation.
    // The original operation, plan and creation receipt remain immutable.
    const row = await transaction(async session => {
      const current = await read(ctx, session); assertIdentity(current, ctx.intent, false);
      if (!['saved', 'verified'].includes(current.state) || !current.receipt) fail('A saved creation receipt is required before verification');
      await guarded(ctx, 'verification-start', session, current.dispatch, null, current);
      return replace(ctx, current, { state: 'saved', verification: null }, 'verification-start', session);
    });
    // Invalidate previous evidence before a new read; failure cannot retain a known stale pass.
    const proof = await loadReadback(proofRequest(row)), clock = now();
    validateReadback(proof, row, clock);
    return transaction(async session => {
      const current = await read(ctx, session); assertIdentity(current, ctx.intent, false); assertHandle(current, publicHandle(row), now());
      if (!fresh(proof.observedAt, now())) fail('Read-back evidence became stale');
      const parents = await verifiedClosure(ctx, row.dependencies, session, now());
      for (const link of proof.relationships) {
        if (!row.dependencies.some(expected => expected.logicalKey === link.logicalKey)) fail('Read-back contains an unrelated relationship');
        const parent = parents.get(link.logicalKey);
        if (!parent || parent.entity !== link.entity || parent.qboId !== link.qboId || parent.verification?.syncToken !== link.syncToken) fail('Read-back relationships differ from verified parent records');
      }
      await guarded(ctx, 'verify', session, row.dispatch, null, current);
      const verification = verificationData(proof);
      const saved = await replace(ctx, current, { state: 'verified', verification }, 'verify', session);
      return { ...publicHandle(saved), state: saved.state };
    });
  }
  async function verifyGraph(scope, operationId, roots, { signal } = {}) {
    if (typeof loadGraphReadback !== 'function' || typeof graphSnapshot !== 'function') fail('Complete graph verification adapters are not connected');
    scope = scopeOf(scope);
    if (!Array.isArray(roots) || !roots.length || roots.length > 100 || roots.some(key => !validHash(key)) || new Set(roots).size !== roots.length) fail('Choose distinct managed activity roots', 400);
    roots = [...roots].sort();
    const cancelled = () => { if (signal?.aborted) fail('Graph verification was cancelled'); };
    const envelope = (input, prepared) => {
      let value; try { value = structuredClone(input); } catch { fail('Graph evidence cannot be retained'); }
      if (!value || value.version !== 1 || !sameScope(value.scope, scope) || canonical(value.roots) !== canonical(roots) || !Array.isArray(value.records) || !value.records.length || value.records.length > 1000 || value.recordCount !== value.records.length || !sameScope(value.writerFence?.scope, scope) || value.writerFence?.operationId !== operationId || !Number.isSafeInteger(value.writerFence?.revision) || value.writerFence.revision < 0 || value.writerFence.revision >= Number.MAX_SAFE_INTEGER || !validHash(value.evidenceHash)) fail('The exact current graph evidence is required');
      if (Buffer.byteLength(JSON.stringify(value)) > 32000000) fail('Graph proof exceeds its storage budget');
      const keys = new Set();
      for (const record of value.records) {
        if (!record || !validHash(record.logicalKey) || keys.has(record.logicalKey) || !ENTITIES.has(record.entity) || !validHash(record.fingerprint) || typeof record.qboId !== 'string' || !/^\d{1,30}$/.test(record.qboId) || !Number.isSafeInteger(record.stepRevision) || record.stepRevision < 1 || record.stepRevision >= Number.MAX_SAFE_INTEGER || !validHash(record.compilationHash)) fail('Graph records have invalid identities');
        keys.add(record.logicalKey);
      }
      if (roots.some(key => !keys.has(key))) fail('The graph omits a requested activity');
      if (prepared) {
        if (value.kind !== 'business-graph-preparation' || value.prepared !== true || value.evidenceHash !== hash({ version: 1, scope: value.scope, roots: value.roots, records: value.records, writerFence: value.writerFence })) fail('The prepared graph manifest changed');
      } else {
        if (value.persisted !== false || typeof value.complete !== 'boolean' || !Array.isArray(value.failures) || !Array.isArray(value.order) || canonical(value.order) !== canonical(value.records.map(record => record.logicalKey)) || value.evidenceHash !== hash({ graph: hash({ scope: value.scope, roots: value.roots, records: value.records, failures: value.failures }), writerFence: value.writerFence })) fail('The graph read-back manifest changed');
        if (value.complete && value.failures.length) fail('An incomplete graph cannot be committed');
      }
      return value;
    };
    cancelled(); const prepared = envelope(await loadGraphReadback({ scope, roots, signal, mode: 'prepare' }), true); cancelled();
    const contexts = new Map();
    for (const record of prepared.records) { cancelled(); contexts.set(record.logicalKey, await context(scope, operationId, record.logicalKey, 'operations.verify')); }
    const primary = contexts.get(roots[0]);
    if ([...contexts.values()].some(ctx => ctx.actorId !== primary.actorId || ctx.intent.planHash !== primary.intent.planHash)) fail('Graph actors or approved operation plans differ');
    const snapshot = async (expected, session) => {
      const actor = await authorize(scope, 'operations.verify'); if (actor?.actorId !== primary.actorId) fail('The graph verifier changed', 403);
      const current = await graphSnapshot({ scope, intent: primary.intent, expected, session });
      if (!current || !sameScope(current.scope, scope) || current.operationId !== operationId || !Number.isSafeInteger(current.revision) || current.revision < 0 || current.revision >= Number.MAX_SAFE_INTEGER || (expected && canonical(expected) !== canonical(current))) fail('The graph writer snapshot no longer matches');
      return structuredClone(current);
    };
    const invalidated = await transaction(async session => {
      cancelled(); await snapshot(prepared.writerFence, session);
      const rows = new Map();
      for (const expected of prepared.records) {
        cancelled(); const ctx = contexts.get(expected.logicalKey), row = await read(ctx, session); assertIdentity(row, ctx.intent, false);
        if (!['saved', 'verified'].includes(row.state) || !row.receipt || row.revision !== expected.stepRevision || row.qboId !== expected.qboId || row.entity !== expected.entity || row.fingerprint !== expected.fingerprint || row.dispatch?.compilationHash !== expected.compilationHash) fail('The prepared graph changed before verification started');
        await guarded(ctx, 'verification-start', session, row.dispatch, null, row);
        const saved = await replace(ctx, row, { state: 'saved', verification: null }, 'verification-start', session); rows.set(expected.logicalKey, saved);
      }
      cancelled(); const writerFence = await snapshot(null, session); cancelled(); return { rows, writerFence };
    });
    // No QBO or provider reads run inside a retryable database transaction.
    cancelled(); const graph = envelope(await loadGraphReadback({ scope, roots, signal, mode: 'read', expectedWriterFence: invalidated.writerFence }), false); cancelled();
    if (canonical(graph.writerFence) !== canonical(invalidated.writerFence) || graph.records.length !== invalidated.rows.size) fail('The observed graph differs from its invalidated snapshot');
    for (const record of graph.records) {
      const row = invalidated.rows.get(record.logicalKey);
      if (!row || row.entity !== record.entity || row.fingerprint !== record.fingerprint || row.qboId !== record.qboId || row.revision !== record.stepRevision || row.dispatch.compilationHash !== record.compilationHash) fail('A graph activity changed while records were read');
    }
    if (!graph.complete) return { state: 'unverified', complete: false, persisted: false, recordCount: graph.recordCount, failures: graph.failures, evidenceHash: graph.evidenceHash };
    for (const record of graph.records) validateReadback(record.proof, invalidated.rows.get(record.logicalKey), now());
    const committed = await transaction(async session => {
      cancelled(); await snapshot(graph.writerFence, session); const savedRecords = [];
      for (const record of graph.records) {
        cancelled(); const ctx = contexts.get(record.logicalKey), row = invalidated.rows.get(record.logicalKey), current = await read(ctx, session);
        assertIdentity(current, ctx.intent, false); assertHandle(current, publicHandle(row), now());
        if (current.state !== 'saved' || canonical(current.receipt) !== canonical(row.receipt) || current.qboId !== row.qboId || canonical(current.dispatch) !== canonical(row.dispatch)) fail('The saved graph changed before proof persistence');
        validateReadback(record.proof, current, now());
        const parents = await verifiedClosure(ctx, current.dependencies, session, now());
        for (const link of record.proof.relationships) {
          const parent = parents.get(link.logicalKey);
          if (!current.dependencies.some(expected => expected.logicalKey === link.logicalKey) || !parent || parent.entity !== link.entity || parent.qboId !== link.qboId || parent.verification?.syncToken !== link.syncToken) fail('Graph proof differs from the completed parent chain');
        }
        await guarded(ctx, 'verify', session, current.dispatch, null, current);
        const saved = await replace(ctx, current, { state: 'verified', verification: { ...verificationData(record.proof), graphEvidenceHash: graph.evidenceHash } }, 'verify', session);
        savedRecords.push({ logicalKey: record.logicalKey, entity: saved.entity, qboId: saved.qboId, revision: saved.revision });
      }
      for (const record of graph.records) validateReadback(record.proof, invalidated.rows.get(record.logicalKey), now());
      cancelled(); return { state: 'verified', complete: true, persisted: true, recordCount: savedRecords.length, roots, records: savedRecords, evidenceHash: graph.evidenceHash };
    });
    // Commit acknowledgement can arrive after the evidence lifetime, too.
    for (const record of graph.records) validateReadback(record.proof, invalidated.rows.get(record.logicalKey), now());
    return committed;
  }
  async function evidence(scope, operationId, logicalKey) {
    const ctx = await context(scope, operationId, logicalKey, 'operations.read');
    return transaction(async session => {
      const actor = await authorize(ctx.scope, ctx.action);
      if (actor?.actorId !== ctx.actorId) fail('The operation actor changed', 403);
      let row = await read(ctx, session);
      if (!row) return { state: 'unrecorded', creationAuthorized: false };
      assertIdentity(row, ctx.intent, false);
      let current = false;
      try {
        const verified = await verifiedClosure(ctx, [{ logicalKey, entity: row.entity, fingerprint: row.fingerprint }], session, now());
        row = verified.get(logicalKey); current = true;
      } catch (error) { if (error.code !== 'BUSINESS_EVIDENCE_UNVERIFIED') throw error; }
      return { originOperationId: String(row.operationId), originPlanHash: row.planHash, state: row.state, qboId: row.qboId || null, fingerprint: row.fingerprint, receipt: row.receipt, rejection: row.rejection || null, verification: row.verification, fresh: current, creationAuthorized: false };
    });
  }
  async function compilation(scope, operationId, logicalKey) {
    const ctx = await context(scope, operationId, logicalKey, 'operations.read');
    return transaction(async session => {
      const actor = await authorize(ctx.scope, ctx.action);
      if (actor?.actorId !== ctx.actorId) fail('The operation actor changed', 403);
      const row = await read(ctx, session); assertIdentity(row, ctx.intent, false);
      const artifact = row.compilation, request = validateCompilation(artifact);
      if (!sameScope(request.scope, ctx.scope) || artifact.logicalKey !== logicalKey || artifact.entity !== row.entity || artifact.intentHash !== row.fingerprint || artifact.compilationHash !== row.dispatch?.compilationHash || artifact.evidenceHash !== row.dispatch?.evidenceHash || request.requestHash !== row.dispatch?.requestHash) fail('The stored compilation no longer matches its original dispatch');
      return structuredClone(Object.fromEntries(['version', 'logicalKey', 'entity', 'intentHash', 'request', 'evidenceHash', 'relationships', 'compilationHash'].map(key => [key, artifact[key]])));
    });
  }
  return { claim, beginDispatch, markUnknown, recordSaved, recover, verifySaved, verifyGraph, evidence, compilation };
}
module.exports = { createBusinessStepStore, proofRequest, MAX_ATTEMPTS };
