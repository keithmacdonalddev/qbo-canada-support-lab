'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessWriterFence, businessWriterIntegrationStatus } = require('../src/modules/business-writer-fence');
const { createBusinessPeriodStore } = require('../src/modules/business-period-store');
const { createBusinessStepStore } = require('../src/modules/business-step-store');
const { hash } = require('../src/modules/business-calendar');
const dispatchFixture = require('./helpers/business-dispatch-fixture');
const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) };
const id = 'b'.repeat(24), nextId = 'c'.repeat(24), key = hash('invoice');
const clone = value => structuredClone(value);
const at = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
function matches(row, filter) { return row && Object.entries(filter).every(([key, value]) => key === '$or' ? value.some(filter => matches(row, filter)) : value && typeof value === 'object' && '$in' in value ? value.$in.includes(at(row, key)) : at(row, key) === value); }
function harness() {
  const h = { clock: Date.parse('2026-10-06T12:00:00.000Z'), data: { Runs: [], Calendars: [], Writers: [], Steps: [] }, audits: new Map(), serial: 0 };
  const run = { _id: id, contractVersion: 1, ...scope, businessKey: 'business', blueprintId: 'd'.repeat(24), planId: 'e'.repeat(24), blueprintHash: hash('blueprint'), planHash: hash(id), baselineHash: hash('baseline'), fromDate: '2026-10-01', throughDate: '2026-10-06', expectedCursor: '2026-09-30', expectedRevision: 1, status: 'reserved', verification: null, recordCount: 1, writerRevision: 0, requiredAssertions: [{ key: 'readback', evidenceType: 'record-readback', currency: 'CAD' }] };
  run.approval = { actorId: 'f'.repeat(24), planHash: run.planHash, fenceHash: hash('approval fence'), auditId: 'approval-audit', approvedAt: new Date(h.clock).toISOString() };
  const records = [{ logicalKey: key, entity: 'Invoice', qboId: '100', syncToken: '0', fingerprint: hash(key), observedHash: hash('saved'), auditId: 'audit-1', state: 'verified', observedAt: new Date(h.clock).toISOString(), relationships: [] }];
  run.expectedRecordSetHash = hash(records.map(record => ({ logicalKey: record.logicalKey, entity: record.entity, fingerprint: record.fingerprint, relationships: [] })));
  h.proof = { version: 1, ...scope, operationId: id, complete: true, planHash: run.planHash, blueprintHash: run.blueprintHash, baselineHash: run.baselineHash, fromDate: run.fromDate, throughDate: run.throughDate, expectedRecordSetHash: run.expectedRecordSetHash, records, observedAt: new Date(h.clock).toISOString(), assertions: [{ key: 'readback', evidenceType: 'record-readback', currency: 'CAD', status: 'passed', recordSetHash: hash(records), sourceHash: hash('report'), observedAt: new Date(h.clock).toISOString(), fromDate: run.fromDate, throughDate: run.throughDate }] };
  run.evidenceRevision = 1; run.verificationCandidateHash = hash(h.proof);
  h.data.Runs.push(run);
  h.data.Calendars.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, businessKey: run.businessKey, blueprintId: run.blueprintId, blueprintHash: run.blueprintHash, baseline: { status: 'verified', evidenceHash: run.baselineHash }, openingDate: '2023-09-01', verifiedThrough: run.expectedCursor, revision: 1, writerRevision: 0, currentOperationId: id, stopRequested: false, pendingCommit: null });
  h.data.Writers.push({ _id: 'sandbox:123', contractVersion: 1, ...scope, revision: 0, operationId: id, planHash: run.planHash, unresolved: null });
  h.run = (op = id) => h.data.Runs.find(row => row._id === op); h.calendar = () => h.data.Calendars[0]; h.writer = () => h.data.Writers[0]; h.step = (logicalKey = key) => h.data.Steps.find(row => row.logicalKey === logicalKey);
  function unique(name, row) {
    if (name !== 'Steps') return;
    if (h.data.Steps.some(item => item.logicalKey !== row.logicalKey && row.qboId && item.environment === row.environment && item.realmId === row.realmId && item.entity === row.entity && item.qboId === row.qboId)) throw new Error('duplicate physical record');
  }
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, {
    findOne(filter) { let session; const query = { session(value) { session = value; return query; }, lean: async () => { if (session) assert.equal(session.inTransaction(), true); return clone(h.data[name].find(row => matches(row, filter)) || null); } }; return query; },
    findOneAndUpdate(filter, change, options) { return { lean: async () => {
      if (name !== 'Runs') assert.ok(options.session); if (name === 'Calendars' && change.$set?.currentOperationId === null && h.failFinalClear) { h.failFinalClear = false; return null; }
      const row = h.data[name].find(row => matches(row, filter)); if (!row) return null;
      const next = { ...row, ...clone(change.$set || {}) }; for (const [key, value] of Object.entries(change.$inc || {})) next[key] += value;
      unique(name, next); Object.assign(row, next); return clone(row);
    } }; },
    async create(rows, options) { assert.ok(options.session); for (const row of rows) { if (h.data[name].some(item => item.logicalKey === row.logicalKey)) throw new Error('duplicate logical key'); unique(name, row); h.data[name].push(clone(row)); } },
  }]));
  let queue = Promise.resolve();
  h.transaction = work => {
    const result = queue.then(async () => {
      const before = clone(h.data), audits = clone(h.audits);
      let result; try { result = await work({ inTransaction: () => true }); } catch (error) { h.data = before; h.audits = audits; throw error; }
      if (h.loseReply) { h.loseReply = false; throw new Error('commit reply lost'); } return result;
    }); queue = result.catch(() => {}); return result;
  };
  h.audit = async (eventKey, details) => { if (h.onAudit) await h.onAudit(details); if (h.failAudit) throw new Error('audit failed'); if (!h.audits.has(eventKey)) h.audits.set(eventKey, { id: String(h.audits.size + 1), eventKey, details }); return h.audits.get(eventKey); };
  h.fence = createBusinessWriterFence({ ...h.models, now: () => h.clock, assertIntegration: async () => { if (h.notIntegrated) throw new Error('not integrated'); } });
  h.intent = (operationId = id, logicalKey = key) => ({ version: 1, kind: 'create', scope, operationId, logicalKey, fingerprint: hash(logicalKey), entity: 'Invoice', planHash: hash(operationId), dependencies: h.dependencies?.get(logicalKey) || [] });
  h.receipt = (row = h.step(), source = 'create-response', qboId = '100') => ({ version: 1, scope, entity: row.entity, logicalKey: row.logicalKey, dispatchKey: row.dispatch.key, requestHash: row.dispatch.requestHash, qboId, syncToken: '0', evidenceHash: hash('receipt'), source });
  h.graph = async input => {
    if (h.beforeGraph) await h.beforeGraph(input);
    const rows = [...h.data.Steps].sort((a, b) => a.dependencies.length - b.dependencies.length || a.logicalKey.localeCompare(b.logicalKey));
    const records = rows.map(row => ({ logicalKey: row.logicalKey, entity: row.entity, fingerprint: row.fingerprint, qboId: row.qboId, stepRevision: row.revision, compilationHash: row.dispatch.compilationHash }));
    const writerFence = { scope, operationId: id, revision: h.writer().revision }, roots = [...input.roots].sort();
    if (input.mode === 'prepare') {
      const manifest = { version: 1, scope, roots, records, writerFence };
      const result = { ...manifest, kind: 'business-graph-preparation', prepared: true, recordCount: records.length, evidenceHash: hash(manifest) };
      if (h.afterGraph) await h.afterGraph(input, result); return result;
    }
    for (const record of records) { const row = h.step(record.logicalKey); record.proof = { version: 1, kind: 'business-readback', scope, compilationHash: record.compilationHash, logicalKey: row.logicalKey, entity: row.entity, qboId: row.qboId, fingerprint: row.fingerprint, matchesIntent: true, syncToken: '0', observedAt: new Date(h.clock).toISOString(), observedHash: hash('saved:' + row.logicalKey), evidenceHash: hash('readback:' + row.logicalKey), relationships: row.dependencies.map(link => ({ logicalKey: link.logicalKey, entity: h.step(link.logicalKey).entity, qboId: h.step(link.logicalKey).qboId, syncToken: '0' })) }; }
    const result = { version: 1, scope, roots, records, writerFence, complete: true, persisted: false, recordCount: records.length, order: records.map(record => record.logicalKey), failures: [] };
    if (h.editGraphProof) h.editGraphProof(result);
    result.evidenceHash = hash({ graph: hash({ scope, roots, records: result.records, failures: result.failures }), writerFence: result.writerFence });
    if (h.afterGraph) await h.afterGraph(input, result); return result;
  };
  h.steps = createBusinessStepStore({ Steps: h.models.Steps, loadIntent: async (_scope, operationId, logicalKey) => h.intent(operationId, logicalKey), authorize: async () => ({ actorId: 'actor' }), assertReady: async () => {}, transaction: h.transaction, fence: h.fence.fenceStep, writeAudit: h.audit, now: () => h.clock, token: () => 'worker-token-' + String(++h.serial).padStart(8, '0'),
    loadGraphReadback: h.graph, graphSnapshot: h.fence.graphSnapshot,
    loadRecovery: async row => h.recovery || { status: 'found', receipt: h.receipt(row, 'request-correlated-readback') },
    loadReadback: async row => { if (h.readbackFailure) throw new Error('readback failed'); return { version: 1, scope, logicalKey: row.logicalKey, entity: row.entity, qboId: row.qboId, fingerprint: row.fingerprint, kind: 'business-readback', compilationHash: row.dispatch.compilationHash, matchesIntent: true, observedHash: hash('saved'), evidenceHash: hash('readback'), syncToken: '0', observedAt: new Date(h.clock).toISOString(), relationships: [] }; },
  });
  h.period = createBusinessPeriodStore({ ...h.models, Writer: h.fence, transaction: h.transaction, loadProof: async () => clone(h.proof), authorize: async () => ({ actorId: 'actor' }), writeAudit: h.audit, assertReady: async () => {}, now: () => h.clock });
  h.dispatchEvidence = (requestHash, logicalKey = key) => ({ scope, operationId: id, logicalKey, ...dispatchFixture(scope, h.intent(id, logicalKey), requestHash, h.step), writerRevision: h.writer().revision, observedAt: new Date(h.clock).toISOString() });
  h.dispatch = async (logicalKey = key) => { const handle = await h.steps.claim(scope, id, logicalKey); return h.steps.beginDispatch(scope, id, logicalKey, handle, h.dispatchEvidence(hash('request ' + logicalKey), logicalKey)); };
  return h;
}
test('default writer readiness is mechanically closed before any persistence', async () => {
  const h = harness(), before = clone(h.data); assert.equal(businessWriterIntegrationStatus().ready, false);
  const fence = createBusinessWriterFence(h.models);
  await assert.rejects(h.transaction(session => fence.reserve(h.run(), scope, session)), /not connected/);
  assert.deepEqual(h.data, before);
});
test('writer transitions require an active transaction and explicit prepared writer state', async () => {
  const h = harness(); await assert.rejects(h.fence.reserve(h.run(), scope, null), /transaction/);
  h.data.Writers = []; await assert.rejects(h.transaction(session => h.fence.reserve(h.run(), scope, session)), /prepared/);
});
test('period reservation acquires calendar and company writer together and recovers repeated requests', async () => {
  const h = harness(); h.run().status = 'approved'; h.calendar().currentOperationId = null; h.writer().operationId = null; h.writer().planHash = null;
  await h.period.reserve(id, scope); assert.equal(h.run().status, 'reserved'); assert.equal(h.writer().operationId, id); assert.equal(h.calendar().currentOperationId, id);
  await h.period.reserve(id, scope); assert.equal(h.writer().operationId, id); assert.equal(h.writer().unresolved, null);
});
test('competing operation cannot replace company writer ownership', async () => {
  const h = harness(); h.run().status = 'approved'; h.calendar().currentOperationId = null; h.writer().operationId = null; h.writer().planHash = null;
  h.data.Runs.push({ ...clone(h.run()), _id: nextId, planHash: hash(nextId), approval: { ...h.run().approval, planHash: hash(nextId) } });
  const results = await Promise.allSettled([h.period.reserve(id, scope), h.period.reserve(nextId, scope)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(h.writer().operationId, h.calendar().currentOperationId);
});
test('writer conflict rolls back an attempted calendar reservation', async () => {
  const h = harness(); h.run().status = 'approved'; h.calendar().currentOperationId = null; h.writer().operationId = nextId; h.writer().planHash = hash(nextId);
  await assert.rejects(h.period.reserve(id, scope), /Another operation/);
  assert.equal(h.run().status, 'approved'); assert.equal(h.calendar().currentOperationId, null); assert.equal(h.writer().operationId, nextId);
});
test('dispatch writes the permanent barrier in the same transaction as the step marker', async () => {
  const h = harness(); const handle = await h.dispatch();
  assert.equal(h.step().state, 'dispatched'); assert.equal(h.writer().unresolved.key, handle.dispatch.key); assert.equal(h.writer().unresolved.stepRevision, h.step().revision);
  assert.ok(h.run().writerRevision > 0); assert.ok(h.calendar().writerRevision > 0);
  h.clock += 3600000; await assert.rejects(h.steps.claim(scope, id, hash('another invoice')), /unresolved/); assert.equal(h.data.Steps.length, 1);
});
test('a phase label without a validated receipt cannot release a dispatch barrier', async () => {
  const h = harness(); const handle = await h.dispatch(), row = h.step();
  const intent = { contractVersion: 1, ...scope, ...h.intent(), dependencies: [] };
  await assert.rejects(h.transaction(session => h.fence.fenceStep({ scope, intent, actorId: 'actor', phase: 'saved', dispatch: row.dispatch, step: { state: row.state, ...handle }, session })), /receipt/);
  assert.equal(h.writer().unresolved.key, row.dispatch.key); assert.equal(h.step().state, 'dispatched');
});
test('audit failure rolls back barrier settlement while preserving possibly-sent state', async () => {
  const h = harness(); const handle = await h.dispatch(); const writer = clone(h.writer()); h.failAudit = true;
  await assert.rejects(h.steps.recordSaved(scope, id, key, handle, h.receipt()), /audit/);
  assert.deepEqual(h.writer(), writer); assert.equal(h.step().state, 'dispatched'); assert.equal(h.step().receipt, null);
});
test('stopped operations can settle their exact external response but cannot start another request', async () => {
  const h = harness(); const handle = await h.dispatch(); h.calendar().stopRequested = true; h.run().status = 'stopped';
  await h.steps.recordSaved(scope, id, key, handle, h.receipt()); assert.equal(h.writer().unresolved, null); assert.equal(h.step().state, 'saved');
  await assert.rejects(h.steps.claim(scope, id, hash('another')), /cannot make/);
});
test('unknown recovery retains barrier on absence and releases only correlated outcome', async () => {
  const h = harness(); const handle = await h.dispatch(); await h.steps.markUnknown(scope, id, key, handle);
  h.recovery = { status: 'not_found' }; await h.steps.recover(scope, id, key); assert.ok(h.writer().unresolved);
  h.recovery = null; await h.steps.recover(scope, id, key); assert.equal(h.writer().unresolved, null); assert.equal(h.step().state, 'saved');
});
test('duplicate physical IDs roll back the receipt and preserve the new request barrier', async () => {
  const h = harness(); let handle = await h.dispatch(); await h.steps.recordSaved(scope, id, key, handle, h.receipt());
  const other = hash('other invoice'); handle = await h.dispatch(other);
  await assert.rejects(h.steps.recordSaved(scope, id, other, handle, h.receipt(h.step(other))), /duplicate physical/);
  assert.equal(h.step(other).state, 'dispatched'); assert.equal(h.writer().unresolved.logicalKey, other);
});
test('unresolved writer prevents calendar advancement even with otherwise passing frozen proof', async () => {
  const h = harness(); await h.dispatch(); h.run().status = 'awaiting-evidence'; h.run().verificationCandidateHash = hash(h.proof);
  await assert.rejects(h.period.finish(id, scope), /unresolved/);
  assert.equal(h.calendar().verifiedThrough, '2026-09-30'); assert.equal(h.run().status, 'awaiting-evidence'); assert.ok(h.writer().unresolved);
});
test('successful period finish releases writer with final calendar receipt repair', async () => {
  const h = harness(); h.run().status = 'awaiting-evidence'; await h.period.finish(id, scope);
  assert.equal(h.run().status, 'verified'); assert.equal(h.calendar().verifiedThrough, '2026-10-06'); assert.equal(h.calendar().pendingCommit, null); assert.equal(h.calendar().currentOperationId, null); assert.equal(h.writer().operationId, null); assert.equal(h.writer().lastReleasedOperationId, id);
  await h.period.finish(id, scope); assert.equal(h.calendar().revision, 2);
});
test('failed final calendar clear rolls back writer release and repair resumes safely', async () => {
  const h = harness(); h.run().status = 'awaiting-evidence'; h.failFinalClear = true;
  await assert.rejects(h.period.finish(id, scope), /Calendar changed/);
  assert.equal(h.calendar().verifiedThrough, '2026-10-06'); assert.ok(h.calendar().pendingCommit); assert.equal(h.writer().operationId, id);
  await h.period.repair(scope); assert.equal(h.writer().operationId, null); assert.equal(h.calendar().pendingCommit, null); assert.equal(h.calendar().revision, 2);
});
test('lost final release response can be recovered without releasing or advancing twice', async () => {
  const h = harness(); h.run().status = 'awaiting-evidence'; h.failFinalClear = true; await assert.rejects(h.period.finish(id, scope));
  h.loseReply = true; await assert.rejects(h.period.repair(scope), /reply lost/);
  assert.equal(h.writer().operationId, null); assert.equal(h.calendar().pendingCommit, null);
  await h.period.repair(scope); assert.equal(h.calendar().revision, 2);
});
test('changed connection, cursor, baseline and prepared revisions reject step writes', async () => {
  for (const change of [h => { h.writer().connectionId = 'f'.repeat(24); }, h => { h.calendar().verifiedThrough = '2026-09-29'; }, h => { h.calendar().baseline.status = 'drifted'; }, h => { delete h.run().writerRevision; }]) {
    const h = harness(); change(h); await assert.rejects(h.steps.claim(scope, id, key)); assert.equal(h.data.Steps.length, 0);
  }
});
test('historical readback uses current writer without reassigning original step ownership', async () => {
  const h = harness(); const handle = await h.dispatch(); await h.steps.recordSaved(scope, id, key, handle, h.receipt()); await h.steps.verifySaved(scope, id, key);
  h.data.Runs.push({ ...clone(h.run()), _id: nextId, planHash: hash(nextId), approval: { ...h.run().approval, planHash: hash(nextId) }, status: 'reserved' }); h.calendar().currentOperationId = nextId; h.writer().operationId = nextId; h.writer().planHash = hash(nextId); h.clock += 300001;
  await h.steps.verifySaved(scope, nextId, key); assert.equal(h.step().operationId, id); assert.equal(h.step().planHash, hash(id)); assert.equal((await h.steps.evidence(scope, nextId, key)).fresh, true);
});

test('failed re-verification atomically invalidates frozen period completion proof', async () => {
  const h = harness(); const handle = await h.dispatch(); await h.steps.recordSaved(scope, id, key, handle, h.receipt()); await h.steps.verifySaved(scope, id, key);
  h.run().status = 'awaiting-evidence'; h.run().verificationCandidateHash = hash(h.proof); const evidenceRevision = h.run().evidenceRevision;
  h.readbackFailure = true; await assert.rejects(h.steps.verifySaved(scope, id, key), /readback failed/);
  assert.equal(h.step().state, 'saved'); assert.equal(h.step().verification, null);
  assert.equal(h.run().verificationCandidateHash, null); assert.equal(h.run().evidenceRevision, evidenceRevision + 1);
  await assert.rejects(h.period.finish(id, scope), /frozen/); assert.equal(h.calendar().verifiedThrough, '2026-09-30'); assert.equal(h.writer().operationId, id);
});

test('writer advancement invalidates an older compiled request before any send marker', async () => {
  const h = harness(), handle = await h.steps.claim(scope, id, key);
  const evidence = h.dispatchEvidence(hash('request'));
  await h.steps.claim(scope, id, hash('another activity'));
  await assert.rejects(h.steps.beginDispatch(scope, id, key, handle, evidence), /observations changed/);
  assert.equal(h.step().state, 'claimed'); assert.equal(h.writer().unresolved, null);
  await h.steps.beginDispatch(scope, id, key, handle, h.dispatchEvidence(hash('request')));
  assert.equal(h.step().state, 'dispatched');
});

async function savedGraph() {
  const h = harness(), child = hash('linked child'); h.dependencies = new Map();
  const first = await h.dispatch(); await h.steps.recordSaved(scope, id, key, first, h.receipt()); await h.steps.verifySaved(scope, id, key);
  h.dependencies.set(child, [{ logicalKey: key, entity: 'Invoice', fingerprint: hash(key) }]);
  const second = await h.dispatch(child); await h.steps.recordSaved(scope, id, child, second, h.receipt(h.step(child), 'create-response', '200'));
  h.graphRoot = child; return h;
}
test('whole graph invalidation and proof persistence use the concrete writer atomically', async () => {
  const h = await savedGraph(), receipts = h.data.Steps.map(row => clone(row.receipt)), revision = h.writer().revision;
  const result = await h.steps.verifyGraph(scope, id, [h.graphRoot]);
  assert.equal(result.complete, true); assert.equal(result.persisted, true); assert.equal(result.recordCount, 2); assert.equal(h.writer().revision, revision + 4);
  assert.deepEqual(h.data.Steps.map(row => row.receipt), receipts);
  for (const row of h.data.Steps) { assert.equal(row.state, 'verified'); assert.equal(row.verification.graphEvidenceHash, result.evidenceHash); }
  assert.equal((await h.steps.evidence(scope, id, h.graphRoot)).fresh, true); assert.equal(h.run().verificationCandidateHash, null);
});
test('provider read failure leaves every related record without reusable old proof', async () => {
  const h = await savedGraph(); h.beforeGraph = async input => { if (input.mode === 'read') throw new Error('provider read failed'); };
  await assert.rejects(h.steps.verifyGraph(scope, id, [h.graphRoot]), /provider read failed/);
  assert.ok(h.data.Steps.every(row => row.state === 'saved' && row.verification === null));
  h.beforeGraph = null; assert.equal((await h.steps.verifyGraph(scope, id, [h.graphRoot])).complete, true); assert.equal(h.data.Steps.length, 2);
});
test('changed writer during preparation prevents invalidation from starting', async () => {
  const h = await savedGraph(), before = clone(h.data.Steps);
  h.afterGraph = async input => { if (input.mode === 'prepare') h.writer().revision++; };
  await assert.rejects(h.steps.verifyGraph(scope, id, [h.graphRoot]), /Company activity changed/); assert.deepEqual(h.data.Steps, before);
});
test('changed writer after read prevents any graph verification commit', async () => {
  const h = await savedGraph(); h.afterGraph = async input => { if (input.mode === 'read') h.writer().revision++; };
  await assert.rejects(h.steps.verifyGraph(scope, id, [h.graphRoot]), /Company activity changed/); assert.ok(h.data.Steps.every(row => row.state === 'saved' && row.verification === null));
});
test('a late verification audit failure rolls back every record proof', async () => {
  const h = await savedGraph(); let count = 0;
  h.onAudit = async details => { if (details.phase === 'verify' && ++count === 2) throw new Error('late audit failed'); };
  await assert.rejects(h.steps.verifyGraph(scope, id, [h.graphRoot]), /late audit failed/);
  assert.ok(h.data.Steps.every(row => row.state === 'saved' && row.verification === null));
});
test('incomplete graph returns honest unverified status and never persists partial passes', async () => {
  const h = await savedGraph(); h.editGraphProof = result => { result.complete = false; result.records[1].proof = null; result.failures = [{ logicalKey: h.graphRoot, issues: ['balance differs'] }]; };
  const result = await h.steps.verifyGraph(scope, id, [h.graphRoot]); assert.equal(result.complete, false); assert.equal(result.persisted, false); assert.ok(h.data.Steps.every(row => row.state === 'saved' && row.verification === null));
});
test('altered proof kind and reversed dependency order cannot be committed', async () => {
  for (const edit of [result => { result.records[0].proof.kind = 'business-content'; }, result => { result.records.reverse(); result.order.reverse(); }]) {
    const h = await savedGraph(); h.editGraphProof = edit;
    await assert.rejects(h.steps.verifyGraph(scope, id, [h.graphRoot])); assert.ok(h.data.Steps.every(row => row.state === 'saved' && row.verification === null));
  }
});
test('cancelled graph commit rolls back earlier proof and audit changes', async () => {
  const h = await savedGraph(), controller = new AbortController();
  h.onAudit = async details => { if (details.phase === 'verify') controller.abort(); };
  await assert.rejects(h.steps.verifyGraph(scope, id, [h.graphRoot], { signal: controller.signal }), /cancelled/); assert.ok(h.data.Steps.every(row => row.state === 'saved' && row.verification === null));
});
test('proof expiry during the last audit rolls back the complete graph transaction', async () => {
  const h = await savedGraph(); let count = 0;
  h.onAudit = async details => { if (details.phase === 'verify' && ++count === 2) h.clock += 300001; };
  await assert.rejects(h.steps.verifyGraph(scope, id, [h.graphRoot]), /Read-back/); assert.ok(h.data.Steps.every(row => row.state === 'saved' && row.verification === null));
});
test('lost final commit acknowledgement leaves one complete graph and retry creates no records', async () => {
  const h = await savedGraph(); h.afterGraph = async input => { if (input.mode === 'read') h.loseReply = true; };
  await assert.rejects(h.steps.verifyGraph(scope, id, [h.graphRoot]), /commit reply lost/); assert.ok(h.data.Steps.every(row => row.state === 'verified'));
  h.afterGraph = null; const result = await h.steps.verifyGraph(scope, id, [h.graphRoot]); assert.equal(result.complete, true); assert.equal(h.data.Steps.length, 2);
});

test('writer refuses a reserved run with missing or mismatched durable approval', async () => {
  for (const change of [run => { run.approval = null; }, run => { run.approval.planHash = hash('other'); }]) {
    const h = harness(); change(h.run());
    await assert.rejects(h.steps.claim(scope, id, key), /durable approval/);
    assert.equal(h.data.Steps.length, 0); assert.equal(h.writer().unresolved, null);
  }
});

test('replaced run workers cannot claim or mark an unsent step', async () => {
  const h = harness(), old = 'old-worker-lease-0001', current = 'new-worker-lease-0002';
  h.run().leaseToken = current; h.run().leaseExpiresAt = new Date(h.clock + 600000);
  const before = clone(h.data);
  for (const runLeaseToken of [undefined, old]) {
    await assert.rejects(h.steps.claim(scope, id, key, 60000, { runLeaseToken }), /worker lease/);
    assert.deepEqual(h.data, before);
  }
  const handle = await h.steps.claim(scope, id, key, 60000, { runLeaseToken: current });
  h.run().leaseToken = old; const markedBefore = clone(h.data);
  await assert.rejects(h.steps.beginDispatch(scope, id, key, handle, h.dispatchEvidence(hash('request')), { runLeaseToken: current }), /worker lease/);
  assert.deepEqual(h.data, markedBefore); assert.equal(h.writer().unresolved, null); assert.equal(h.step().state, 'claimed');
  h.run().leaseToken = current; h.run().leaseExpiresAt = new Date(h.clock);
  await assert.rejects(h.steps.beginDispatch(scope, id, key, handle, h.dispatchEvidence(hash('request')), { runLeaseToken: current }), /worker lease/);
  h.run().leaseExpiresAt = new Date(h.clock + 600000);
  await h.steps.beginDispatch(scope, id, key, handle, h.dispatchEvidence(hash('request')), { runLeaseToken: current });
  assert.equal(h.step().state, 'dispatched'); assert.ok(h.writer().unresolved);
});
