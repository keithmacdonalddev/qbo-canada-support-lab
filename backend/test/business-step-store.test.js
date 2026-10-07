'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessStepStore, proofRequest } = require('../src/modules/business-step-store');
const { hash } = require('../src/modules/business-calendar');
const dispatchFixture = require('./helpers/business-dispatch-fixture');
const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) };
const op = 'b'.repeat(24), later = 'c'.repeat(24), key = hash('invoice'), childKey = hash('payment');
const clone = value => structuredClone(value);
function matches(row, filter) { return row && Object.entries(filter).every(([key, value]) => row[key] === value); }
function harness() {
  const h = { rows: new Map(), audits: new Map(), intents: new Map(), clock: Date.parse('2026-10-06T12:00:00.000Z'), allowed: true, stopped: false, barrier: null, fences: 0, serial: 0 };
  const index = row => row.environment + ':' + row.realmId + ':' + row.logicalKey;
  h.intent = (logicalKey = key, dependencies = [], operationId = op) => ({ version: 1, kind: 'create', scope, operationId, logicalKey, planHash: hash(operationId), fingerprint: hash(logicalKey), entity: logicalKey === childKey ? 'Payment' : 'Invoice', dependencies });
  h.intents.set(key, h.intent());
  h.row = (logicalKey = key) => h.rows.get(index({ ...scope, logicalKey }));
  function unique(row) { for (const existing of h.rows.values()) if (row.qboId && existing.logicalKey !== row.logicalKey && existing.environment === row.environment && existing.realmId === row.realmId && existing.entity === row.entity && existing.qboId === row.qboId) throw new Error('duplicate physical record'); }
  const Steps = {
    findOne(filter) { let session; const query = { session(value) { session = value; return query; }, lean: async () => { (h.readSessions ||= []).push(session); const row = clone([...h.rows.values()].find(row => matches(row, filter)) || null); if (h.afterRead) { const hook = h.afterRead; h.afterRead = null; hook(); } return row; } }; return query; },
    async create(rows, options) { assert.ok(options.session); for (const row of rows) { if (h.rows.has(index(row))) throw new Error('duplicate logical activity'); unique(row); h.rows.set(index(row), clone(row)); } },
    findOneAndUpdate(filter, change, options) { return { lean: async () => {
      assert.ok(options.session); const row = [...h.rows.values()].find(row => matches(row, filter)); if (!row) return null;
      const next = { ...row, ...clone(change.$set) }; unique(next); h.rows.set(index(next), next); return clone(next);
    } }; },
  };
  let queue = Promise.resolve();
  const transaction = work => {
    const result = queue.then(async () => {
      const before = clone({ rows: h.rows, audits: h.audits, barrier: h.barrier, fences: h.fences });
      let result;
      try { result = await work({ fixture: true }); }
      catch (error) { Object.assign(h, before); throw error; }
      if (h.loseCommitReply) { h.loseCommitReply = false; throw new Error('commit reply lost'); }
      return result;
    }); queue = result.catch(() => {}); return result;
  };
  h.receipt = (row = h.row(), source = 'create-response', qboId = '100') => ({ version: 1, scope, entity: row.entity, logicalKey: row.logicalKey, dispatchKey: row.dispatch.key, requestHash: row.dispatch.requestHash, qboId, syncToken: '0', evidenceHash: hash('response'), source });
  h.readback = row => ({ version: 1, scope, logicalKey: row.logicalKey, entity: row.entity, qboId: row.qboId, fingerprint: row.fingerprint, kind: 'business-readback', compilationHash: row.dispatch.compilationHash, matchesIntent: true, observedHash: hash('content'), evidenceHash: hash('readback'), syncToken: '0', observedAt: new Date(h.clock).toISOString(), relationships: row.dependencies.map(link => { const parent = h.row(link.logicalKey); return { logicalKey: link.logicalKey, entity: parent.entity, qboId: parent.qboId, syncToken: parent.verification.syncToken }; }) });
  h.deps = { Steps, transaction, now: () => h.clock, token: () => 'worker-token-' + String(++h.serial).padStart(8, '0'),
    assertReady: async () => { if (h.notReady) throw new Error('indexes unavailable'); },
    authorize: async () => { if (!h.allowed) throw new Error('permission revoked'); return { actorId: 'actor' }; },
    loadIntent: async (requestedScope, operationId, logicalKey) => { const intent = h.intents.get(logicalKey); return intent ? { ...clone(intent), scope: requestedScope, operationId, planHash: hash(operationId) } : null; },
    fence: async input => {
      assert.ok(input.session); if (h.currentOperation && input.intent.operationId !== h.currentOperation) throw new Error('operation is no longer current'); if (['claim', 'dispatch'].includes(input.phase) && h.stopped) throw new Error('stopped');
      if (input.phase === 'dispatch') { if (h.barrier) throw new Error('unresolved writer barrier'); h.barrier = input.dispatch.key; }
      if (['saved', 'recover'].includes(input.phase)) { assert.equal(h.barrier, input.dispatch.key); h.barrier = null; }
      if (h.rejectFence) throw new Error('writer revision changed');
      h.fences++; return { scope: input.scope, operationId: input.intent.operationId, planHash: input.intent.planHash, phase: input.phase, fenceHash: hash('fence') };
    },
    writeAudit: async (eventKey, details, session) => { assert.ok(session); if (h.failAudit) throw new Error('audit unavailable'); const receipt = { eventKey, id: String(h.audits.size + 1) }; h.audits.set(eventKey, { ...receipt, details }); return receipt; },
    loadRecovery: async row => h.recovery || { status: 'found', receipt: h.receipt(row, 'request-correlated-readback') },
    loadReadback: async row => h.proof || h.readback(row),
  };
  h.dispatchEvidence = (requestHash, logicalKey = key, operationId = op) => ({ scope, operationId, logicalKey, ...dispatchFixture(scope, h.intents.get(logicalKey) || h.intent(logicalKey), requestHash, h.row), writerRevision: 0, observedAt: new Date(h.clock).toISOString() });
  h.store = createBusinessStepStore(h.deps);
  h.dispatch = async (logicalKey = key) => { const handle = await h.store.claim(scope, op, logicalKey); return h.store.beginDispatch(scope, op, logicalKey, handle, h.dispatchEvidence(hash('validated request ' + logicalKey), logicalKey, op)); };
  h.saved = async (logicalKey = key, qboId = '100') => { const handle = await h.dispatch(logicalKey); await h.store.recordSaved(scope, op, logicalKey, handle, h.receipt(h.row(logicalKey), 'create-response', qboId)); };
  return h;
}
test('claim, dispatch, saved response and verified read-back remain distinct durable stages', async () => {
  const h = harness(); const handle = await h.dispatch(); assert.equal(h.row().state, 'dispatched'); assert.ok(h.barrier);
  await h.store.recordSaved(scope, op, key, handle, h.receipt()); assert.equal(h.row().state, 'saved'); assert.equal(h.barrier, null);
  assert.equal(h.row().verification, null); const creation = clone(h.row().receipt);
  await h.store.verifySaved(scope, op, key); assert.equal(h.row().state, 'verified'); assert.deepEqual(h.row().receipt, creation); assert.equal(h.audits.size, 5);
});
test('competing workers get only one live claim; expired pre-dispatch claim can be replaced', async () => {
  const h = harness(); const results = await Promise.allSettled([h.store.claim(scope, op, key), h.store.claim(scope, op, key)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const old = results.find(result => result.status === 'fulfilled').value; h.clock += 60001;
  const current = await h.store.claim(scope, op, key); assert.notEqual(current.leaseToken, old.leaseToken);
  await assert.rejects(h.store.beginDispatch(scope, op, key, old, h.dispatchEvidence(hash('request'), key, op)), /owns/);
  await h.store.beginDispatch(scope, op, key, current, h.dispatchEvidence(hash('request'), key, op)); assert.equal(h.row().attempts, 2);
});
test('expired dispatch is never reclaimed, even when no record is found during recovery', async () => {
  const h = harness(); await h.dispatch(); h.clock += 600001;
  await assert.rejects(h.store.claim(scope, op, key), /already dispatched/);
  for (const status of ['not_found', 'ambiguous']) { h.recovery = { status }; const result = await h.store.recover(scope, op, key); assert.equal(result.replayAllowed, false); assert.equal(result.recovered, false); assert.equal(h.row().state, 'dispatched'); }
  assert.ok(h.barrier);
});
test('a lost dispatch commit reply leaves a durable barrier, never another send permission', async () => {
  const h = harness(); const handle = await h.store.claim(scope, op, key); h.loseCommitReply = true;
  await assert.rejects(h.store.beginDispatch(scope, op, key, handle, h.dispatchEvidence(hash('request'), key, op)), /reply lost/);
  assert.equal(h.row().state, 'dispatched'); assert.ok(h.barrier);
  await assert.rejects(h.store.beginDispatch(scope, op, key, handle, h.dispatchEvidence(hash('request'), key, op)));
  const recovered = createBusinessStepStore(h.deps); await recovered.recover(scope, op, key);
  assert.equal(h.row().state, 'saved'); assert.equal(h.barrier, null);
});
test('stop fences new dispatch but permits settling an already-sent response', async () => {
  const h = harness(); const handle = await h.store.claim(scope, op, key); h.stopped = true;
  await assert.rejects(h.store.beginDispatch(scope, op, key, handle, h.dispatchEvidence(hash('request'), key, op)), /stopped/); assert.equal(h.row().dispatch, null);
  h.stopped = false; const sent = await h.store.beginDispatch(scope, op, key, handle, h.dispatchEvidence(hash('request'), key, op)); h.stopped = true;
  await h.store.recordSaved(scope, op, key, sent, h.receipt()); assert.equal(h.row().state, 'saved');
});
test('audit or writer-fence failure rolls back the dispatch and its barrier together', async () => {
  for (const flag of ['failAudit', 'rejectFence']) {
    const h = harness(); const handle = await h.store.claim(scope, op, key); h[flag] = true;
    await assert.rejects(h.store.beginDispatch(scope, op, key, handle, h.dispatchEvidence(hash('request'), key, op)));
    assert.equal(h.row().state, 'claimed'); assert.equal(h.row().dispatch, null); assert.equal(h.barrier, null); assert.equal(h.audits.size, 1);
  }
});
test('failure saving a successful response retains dispatch evidence for recovery', async () => {
  const h = harness(); const handle = await h.dispatch(); h.failAudit = true;
  await assert.rejects(h.store.recordSaved(scope, op, key, handle, h.receipt()), /audit/);
  assert.equal(h.row().state, 'dispatched'); assert.ok(h.barrier); h.failAudit = false;
  await h.store.recover(scope, op, key); assert.equal(h.row().state, 'saved');
});
test('unknown transition fences stale workers and recovery cannot use an uncorrelated match', async () => {
  const h = harness(); const handle = await h.dispatch(); await h.store.markUnknown(scope, op, key, handle);
  await assert.rejects(h.store.recordSaved(scope, op, key, handle, h.receipt()), /owns/);
  for (const override of [{ source: 'name-match' }, { dispatchKey: hash('other') }, { requestHash: hash('other') }, { scope: { ...scope, realmId: '456' } }, { syncToken: 'false' }]) {
    h.recovery = { status: 'found', receipt: { ...h.receipt(h.row(), 'request-correlated-readback'), ...override } };
    await assert.rejects(h.store.recover(scope, op, key)); assert.equal(h.row().state, 'unknown'); assert.ok(h.barrier);
  }
  h.recovery = null; await h.store.recover(scope, op, key); assert.equal(h.row().state, 'saved');
});
test('saved receipt is immutable after a lost save reply', async () => {
  const h = harness(); const handle = await h.dispatch(); h.loseCommitReply = true;
  await assert.rejects(h.store.recordSaved(scope, op, key, handle, h.receipt()), /reply lost/); const receipt = clone(h.row().receipt);
  await assert.rejects(h.store.recordSaved(scope, op, key, handle, h.receipt(h.row(), 'create-response', '999')));
  assert.deepEqual(h.row().receipt, receipt); assert.equal((await h.store.evidence(scope, op, key)).qboId, '100');
});
test('different activities cannot adopt the same physical record', async () => {
  const h = harness(); await h.saved(); const second = hash('another invoice'); h.intents.set(second, h.intent(second));
  const handle = await h.dispatch(second);
  await assert.rejects(h.store.recordSaved(scope, op, second, handle, h.receipt(h.row(second))), /duplicate physical/);
  assert.equal(h.row(second).state, 'dispatched'); assert.ok(h.barrier);
});
test('fresh verified parent content and exact relationships are required', async () => {
  const h = harness(); h.intents.set(childKey, h.intent(childKey, [{ logicalKey: key, fingerprint: hash(key), entity: 'Invoice' }]));
  const child = await h.store.claim(scope, op, childKey);
  await assert.rejects(h.store.beginDispatch(scope, op, childKey, child, h.dispatchEvidence(hash('payment'), childKey, op)), /prerequisite/);
  await h.saved(); await h.store.verifySaved(scope, op, key);
  const dispatch = await h.store.beginDispatch(scope, op, childKey, child, h.dispatchEvidence(hash('payment'), childKey, op));
  await h.store.recordSaved(scope, op, childKey, dispatch, h.receipt(h.row(childKey), 'create-response', '200'));
  const valid = h.readback(h.row(childKey)); h.proof = { ...valid, relationships: [{ ...valid.relationships[0], qboId: '999' }] };
  await assert.rejects(h.store.verifySaved(scope, op, childKey), /relationships/);
  h.proof = valid; await h.store.verifySaved(scope, op, childKey); assert.equal(h.row(childKey).state, 'verified');
});
test('stale or wrong-fingerprint parent evidence cannot authorize dispatch', async () => {
  for (const change of ['stale', 'intent']) {
    const h = harness(); await h.saved(); await h.store.verifySaved(scope, op, key);
    if (change === 'stale') h.clock += 300001; else h.row().fingerprint = hash('different parent intent');
    h.intents.set(childKey, h.intent(childKey, [{ logicalKey: key, fingerprint: hash(key), entity: 'Invoice' }]));
    const handle = await h.store.claim(scope, op, childKey);
    await assert.rejects(h.store.beginDispatch(scope, op, childKey, handle, h.dispatchEvidence(hash('payment'), childKey, op)), /prerequisite/);
  }
});
test('readback mismatches, malformed versions and stale observations never verify saved records', async () => {
  const h = harness(); await h.saved();
  for (const change of [{ matchesIntent: false }, { fingerprint: hash('other') }, { syncToken: '' }, { syncToken: '01' }, { qboId: '999' }, { observedAt: '2026-10-06T11:50:00.000Z' }, { observedAt: '2026-10-06T12:01:00.000Z' }, { relationships: [{ logicalKey: key }] }]) {
    h.proof = { ...h.readback(h.row()), ...change }; await assert.rejects(h.store.verifySaved(scope, op, key)); assert.equal(h.row().state, 'saved');
  }
});
test('later operations can inspect original verified evidence but cannot reassign or recreate it', async () => {
  const h = harness(); await h.saved(); await h.store.verifySaved(scope, op, key);
  const evidence = await h.store.evidence(scope, later, key); assert.equal(evidence.originOperationId, op); assert.equal(evidence.creationAuthorized, false); assert.equal(evidence.fresh, true);
  await assert.rejects(h.store.claim(scope, later, key), /another operation/); assert.equal(h.row().operationId, op);
  h.intents.get(key).fingerprint = hash('changed economics'); await assert.rejects(h.store.evidence(scope, later, key), /differs/);
});
test('authority, readiness, scope and finite attempts are required', async () => {
  for (const flag of ['notReady', 'allowed']) { const h = harness(); h[flag] = flag === 'notReady'; await assert.rejects(h.store.claim(scope, op, key)); assert.equal(h.rows.size, 0); }
  const h = harness(); await assert.rejects(h.store.claim({ ...scope, realmId: { $ne: null } }, op, key));
  await h.store.claim(scope, op, key); h.row().attempts = 20; h.clock += 60001;
  await assert.rejects(h.store.claim(scope, op, key), /recovery/);
  await assert.rejects(h.store.claim({ ...scope, connectionId: 'd'.repeat(24) }, op, key), /another operation/);
});
test('permission is rechecked inside retried transactions before a transition', async () => {
  const h = harness(); const handle = await h.store.claim(scope, op, key);
  const original = h.deps.transaction;
  h.deps.transaction = work => original(async session => { h.allowed = false; return work(session); });
  await assert.rejects(createBusinessStepStore(h.deps).beginDispatch(scope, op, key, handle, h.dispatchEvidence(hash('request'), key, op)), /revoked/);
  assert.equal(h.row().state, 'claimed'); assert.equal(h.barrier, null);
});

test('failed re-verification invalidates previous evidence and blocks children and grandchildren', async () => {
  const h = harness(); await h.saved(); await h.store.verifySaved(scope, op, key);
  h.intents.set(childKey, h.intent(childKey, [{ logicalKey: key, fingerprint: hash(key), entity: 'Invoice' }]));
  await h.saved(childKey, '200'); await h.store.verifySaved(scope, op, childKey);
  h.proof = { ...h.readback(h.row()), matchesIntent: false };
  await assert.rejects(h.store.verifySaved(scope, op, key), /Read-back/);
  assert.equal(h.row().state, 'saved'); assert.equal(h.row().verification, null); assert.equal(h.row().receipt.qboId, '100');
  assert.equal((await h.store.evidence(scope, op, key)).fresh, false);
  assert.equal((await h.store.evidence(scope, op, childKey)).fresh, false);
  const grand = hash('deposit'); const intent = h.intent(grand, [{ logicalKey: childKey, fingerprint: hash(childKey), entity: 'Payment' }]); intent.entity = 'Deposit'; h.intents.set(grand, intent);
  const handle = await h.store.claim(scope, op, grand);
  await assert.rejects(h.store.beginDispatch(scope, op, grand, handle, h.dispatchEvidence(hash('deposit request'), grand, op)), /prerequisite/);
});
test('a later operation refreshes prior saved records without changing original ownership', async () => {
  const h = harness(); await h.saved(); await h.store.verifySaved(scope, op, key); const receipt = clone(h.row().receipt);
  h.clock += 300001; h.currentOperation = later;
  assert.equal((await h.store.evidence(scope, later, key)).fresh, false);
  await h.store.verifySaved(scope, later, key);
  assert.equal(h.row().operationId, op); assert.equal(h.row().planHash, hash(op)); assert.deepEqual(h.row().receipt, receipt);
  assert.equal((await h.store.evidence(scope, later, key)).fresh, true);
  h.intents.set(childKey, h.intent(childKey, [{ logicalKey: key, fingerprint: hash(key), entity: 'Invoice' }], later));
  const handle = await h.store.claim(scope, later, childKey);
  await h.store.beginDispatch(scope, later, childKey, handle, h.dispatchEvidence(hash('new payment'), childKey, later));
  assert.equal(h.row(childKey).state, 'dispatched');
});
test('proof adapter projection preserves real BSON IDs as strings and omits unrelated fields', () => {
  const { Types } = require('mongoose');
  const row = { ...scope, connectionId: new Types.ObjectId(scope.connectionId), operationId: new Types.ObjectId(op), logicalKey: key, entity: 'Invoice', planHash: hash(op), fingerprint: hash(key), revision: 2, state: 'dispatched', dependencies: [], dispatch: { key: hash('dispatch') }, receipt: null, unrelatedRawData: 'must not cross boundary' };
  const projected = proofRequest(row);
  assert.equal(projected.connectionId, scope.connectionId); assert.equal(projected.operationId, op);
  assert.equal(Object.hasOwn(projected, 'unrelatedRawData'), false); assert.notEqual(projected.dispatch, row.dispatch);
});
test('readback transport failure cannot leave a previous successful verification reusable', async () => {
  const h = harness(); await h.saved(); await h.store.verifySaved(scope, op, key);
  h.deps.loadReadback = async () => { throw new Error('read failed'); };
  await assert.rejects(createBusinessStepStore(h.deps).verifySaved(scope, op, key), /read failed/);
  assert.equal(h.row().state, 'saved'); assert.equal(h.row().verification, null);
});

test('evidence returns the exact validated root revision and shares one read snapshot session', async () => {
  const h = harness(); await h.saved(); await h.store.verifySaved(scope, op, key); h.readSessions = [];
  // Deliberately stress the projection with a fixture interleaving; real adapter reads
  // use one snapshot and should not expose this nontransactional state change.
  h.afterRead = () => { h.row().verification.syncToken = '1'; h.row().verification.observedHash = hash('changed content'); };
  const evidence = await h.store.evidence(scope, op, key);
  assert.equal(evidence.fresh, true); assert.equal(evidence.verification.syncToken, '1'); assert.equal(evidence.verification.observedHash, hash('changed content'));
  assert.ok(h.readSessions.length >= 2); assert.ok(h.readSessions[0]); assert.ok(h.readSessions.every(session => session === h.readSessions[0]));
});

test('content-only or differently compiled proofs never become verified steps', async () => {
  for (const change of [p => { p.kind = 'business-content'; }, p => { p.compilationHash = hash('other compilation'); }]) {
    const h = harness(); await h.saved(); h.proof = h.readback(h.row()); change(h.proof);
    await assert.rejects(h.store.verifySaved(scope, op, key), /Read-back/); assert.equal(h.row().state, 'saved'); assert.equal(h.row().verification, null);
  }
});
test('old stored proof without completion kind and compilation binding cannot satisfy dependency reads', async () => {
  const h = harness(); await h.saved(); await h.store.verifySaved(scope, op, key);
  delete h.row().verification.compilationHash;
  assert.equal((await h.store.evidence(scope, op, key)).fresh, false);
});

test('original compilation survives dispatch, lost reply and later operation reads without adopting ownership', async () => {
  const h = harness(), handle = await h.store.claim(scope, op, key), evidence = h.dispatchEvidence(hash('immutable body'));
  evidence.artifact.rawObservation = { unrelated: 'never retain' };
  h.loseCommitReply = true;
  await assert.rejects(h.store.beginDispatch(scope, op, key, handle, evidence), /reply lost/);
  assert.equal(h.row().state, 'dispatched');
  const stored = await h.store.compilation(scope, later, key);
  assert.equal(Object.hasOwn(stored, 'rawObservation'), false);
  assert.equal(stored.compilationHash, evidence.compilationHash); assert.equal(stored.request.body, evidence.artifact.request.body); assert.equal(h.row().operationId, op);
  stored.request.body = '{}'; evidence.artifact.request = { ...evidence.artifact.request, body: '{}' };
  assert.notEqual((await h.store.compilation(scope, op, key)).request.body, '{}');
});
test('compilation storage rolls back with failed dispatch audit and rejects mutated artifacts', async () => {
  const h = harness(), handle = await h.store.claim(scope, op, key), evidence = h.dispatchEvidence(hash('request'));
  h.failAudit = true; await assert.rejects(h.store.beginDispatch(scope, op, key, handle, evidence), /audit/);
  assert.equal(h.row().state, 'claimed'); assert.equal(h.row().compilation, undefined);
  h.failAudit = false; const altered = clone(evidence); altered.artifact.intentHash = hash('other');
  await assert.rejects(h.store.beginDispatch(scope, op, key, handle, altered), /artifact changed/);
  await h.store.beginDispatch(scope, op, key, handle, evidence);
  h.row().compilation.relationships.push({ logicalKey: hash('injected') });
  await assert.rejects(h.store.compilation(scope, op, key), /artifact changed/);
});
test('compiled dependency record and version must match the stored verified graph', async () => {
  const h = harness(); await h.saved(); await h.store.verifySaved(scope, op, key);
  h.intents.set(childKey, h.intent(childKey, [{ logicalKey: key, entity: 'Invoice', fingerprint: hash(key) }]));
  const handle = await h.store.claim(scope, op, childKey), evidence = h.dispatchEvidence(hash('child'), childKey);
  evidence.artifact.relationships[0].syncToken = '9'; evidence.compilationHash = hash(evidence.artifact);
  await assert.rejects(h.store.beginDispatch(scope, op, childKey, handle, evidence), /parent graph/);
  assert.equal(h.row(childKey).state, 'claimed'); assert.equal(h.barrier, null);
});

test('missing or null creation disposition never grants a new step claim', async () => {
  for (const kind of [undefined, null, 'unknown', 'existing']) {
    const h = harness(); h.intents.get(key).kind = kind;
    await assert.rejects(h.store.claim(scope, op, key), /disposition|cannot be recreated/);
    assert.equal(h.rows.size, 0); assert.equal(h.audits.size, 0); assert.equal(h.fences, 0);
  }
});
