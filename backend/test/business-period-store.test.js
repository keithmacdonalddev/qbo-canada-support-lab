'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { createBusinessPeriodStore, validatePeriodProof, assertRun } = require('../src/modules/business-period-store');
const scope = { realmId: '123', environment: 'sandbox', connectionId: '000000000000000000000001' };
const id = '000000000000000000000002';
const timestamp = '2026-10-06T12:00:00.000Z';
const clone = value => structuredClone(value);
function fixture() {
  const run = { _id: id, contractVersion: 1, ...scope, businessKey: 'harbour-pine', blueprintId: '000000000000000000000003', planId: '000000000000000000000004', blueprintHash: hash('blueprint'), planHash: hash('plan'), baselineHash: hash('baseline'), fromDate: '2026-10-01', throughDate: '2026-10-06', expectedCursor: '2026-09-30', expectedRevision: 3, status: 'awaiting-evidence', verification: null, recordCount: 1, requiredAssertions: [{ key: 'trial-balance', evidenceType: 'accrual-ledger', basis: 'Accrual', currency: 'CAD' }] };
  run.approval = { actorId: 'f'.repeat(24), planHash: run.planHash, fenceHash: hash('approval fence'), auditId: 'approval-audit', approvedAt: timestamp };
  const records = [{ logicalKey: hash('invoice'), entity: 'Invoice', qboId: '100', syncToken: '0', fingerprint: hash('intent'), observedHash: hash('saved record'), auditId: 'audit-1', state: 'verified', observedAt: timestamp, relationships: [] }];
  run.expectedRecordSetHash = hash(records.map(record => ({ logicalKey: record.logicalKey, entity: record.entity, fingerprint: record.fingerprint, relationships: [] })));
  const proof = { version: 1, operationId: id, ...scope, complete: true, planHash: run.planHash, blueprintHash: run.blueprintHash, baselineHash: run.baselineHash, fromDate: run.fromDate, throughDate: run.throughDate, expectedRecordSetHash: run.expectedRecordSetHash, records, observedAt: timestamp, assertions: [{ key: 'trial-balance', status: 'passed', recordSetHash: hash(records), sourceHash: hash('report'), observedAt: timestamp, fromDate: run.fromDate, throughDate: run.throughDate, currency: 'CAD', basis: 'Accrual', evidenceType: 'accrual-ledger' }] };
  run.evidenceRevision = 1; run.verificationCandidateHash = hash(proof);
  const calendar = { _id: 'sandbox:123', contractVersion: 1, ...scope, businessKey: run.businessKey, openingDate: '2023-09-01', blueprintId: run.blueprintId, blueprintHash: run.blueprintHash, baseline: { status: 'verified', evidenceHash: run.baselineHash }, verifiedThrough: run.expectedCursor, revision: run.expectedRevision, currentOperationId: id, stopRequested: false, pendingCommit: null };
  return { run, proof, calendar };
}
function at(value, key) { return key.split('.').reduce((item, part) => item?.[part], value); }
function matches(value, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(item => matches(value, item));
    const actual = at(value, key);
    if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.includes(actual);
    return actual === expected;
  });
}
function memory(value) {
  const db = { value: clone(value), failNextUpdate: false, writes: 0 };
  db.findOne = filter => { const query = { session() { return query; }, lean: async () => matches(db.value, filter) ? clone(db.value) : null }; return query; };
  db.findOneAndUpdate = (filter, change, options = {}) => ({ lean: async () => {
    if (db.failStatus && db.failStatus === change.$set?.status) { db.failStatus = null; throw new Error('simulated interrupted persistence'); }
    db.lastSession = options.session;
    if (db.failNextUpdate) { db.failNextUpdate = false; throw new Error('simulated interrupted persistence'); }
    if (!matches(db.value, filter)) return null;
    Object.assign(db.value, clone(change.$set || {}));
    for (const [key, value] of Object.entries(change.$inc || {})) db.value[key] += value;
    db.writes++; return clone(db.value);
  } });
  return db;
}
function harness(options = {}) {
  const data = fixture(); const Calendars = memory(data.calendar), Runs = memory(data.run), audits = new Map();
  let queue = Promise.resolve();
  const transaction = work => {
    const result = queue.then(async () => {
      const calendars = clone(Calendars.value), runs = clone(Runs.value), calendarWrites = Calendars.writes, runWrites = Runs.writes;
      try { return await work({ fixtureSession: true }); }
      catch (error) { Calendars.value = calendars; Runs.value = runs; Calendars.writes = calendarWrites; Runs.writes = runWrites; throw error; }
    });
    queue = result.catch(() => {}); return result;
  };
  const Writer = { reserve: async (_run, _scope, session) => { assert.ok(session); }, assertSettled: async (_run, _scope, session) => { assert.ok(session); }, release: async (_run, _scope, session) => { assert.ok(session); } };
  const deps = { transaction, Calendars, Runs, Writer, loadProof: async () => clone(data.proof), authorize: async () => ({ actorId: 'actor' }), assertReady: async () => {}, now: () => Date.parse(timestamp), writeAudit: async (key, details) => {
    if (!audits.has(key)) audits.set(key, { id: String(audits.size + 1), eventKey: key, details });
    return audits.get(key);
  }, ...options };
  return { data, Calendars, Runs, audits, deps, store: createBusinessPeriodStore(deps) };
}
test('exact fresh evidence permits one atomic period advancement and durable verification receipt', async () => {
  const h = harness(); const result = await h.store.finish(id, scope);
  assert.equal(result.verifiedThrough, '2026-10-06'); assert.equal(result.revision, 4);
  assert.equal(result.pendingCommit, null); assert.equal(result.currentOperationId, null);
  assert.equal(h.Runs.value.status, 'verified'); assert.ok(h.Runs.value.verification.completionAuditId);
  await h.store.finish(id, scope); assert.equal(h.Calendars.value.revision, 4);
});
test('a crash after calendar commit retains authoritative proof and is repaired without advancing twice', async () => {
  const h = harness(); h.Runs.failStatus = 'verified';
  await assert.rejects(h.store.finish(id, scope), /interrupted persistence/);
  assert.equal(h.Calendars.value.verifiedThrough, '2026-10-06'); assert.ok(h.Calendars.value.pendingCommit);
  assert.equal(h.Runs.value.status, 'committing');
  const recovered = createBusinessPeriodStore(h.deps);
  await recovered.repair(scope);
  assert.equal(h.Calendars.value.revision, 4); assert.equal(h.Calendars.value.pendingCommit, null);
  assert.equal(h.Runs.value.status, 'verified'); assert.equal(h.audits.size, 2);
});
test('concurrent verification cannot advance the same cursor twice', async () => {
  const h = harness(); await Promise.allSettled([h.store.finish(id, scope), h.store.finish(id, scope)]);
  assert.equal(h.Calendars.value.revision, 4); assert.equal(h.Calendars.value.verifiedThrough, '2026-10-06');
  if (h.Calendars.value.pendingCommit) await h.store.repair(scope);
  assert.equal(h.Runs.value.status, 'verified');
});
test('stop, changed blueprint, stale cursor, missing baseline and busy operation prevent advancement', async () => {
  for (const change of [{ stopRequested: true }, { blueprintHash: hash('changed') }, { verifiedThrough: '2026-09-29' }, { baseline: { status: 'unverified', evidenceHash: hash('baseline') } }, { currentOperationId: 'other' }]) {
    const h = harness(); Object.assign(h.Calendars.value, change);
    await assert.rejects(h.store.finish(id, scope)); assert.equal(h.Calendars.value.revision, 3);
  }
});
test('permission loss between evidence and commit prevents advancement', async () => {
  let calls = 0; const h = harness({ authorize: async () => { if (++calls > 1) throw new Error('permission revoked'); return { actorId: 'actor' }; } });
  await assert.rejects(h.store.finish(id, scope), /revoked/); assert.equal(h.Calendars.value.revision, 3);
});
test('a missing audit receipt fails closed before calendar advancement', async () => {
  const h = harness({ writeAudit: async () => null });
  await assert.rejects(h.store.finish(id, scope), /audit/); assert.equal(h.Calendars.value.revision, 3);
});
test('unfinished or uncertain execution cannot enter verification', async () => {
  for (const status of ['running', 'blocked', 'stopped', 'approved']) {
    const h = harness(); h.Runs.value.status = status;
    await assert.rejects(h.store.finish(id, scope), /saved record checks/); assert.equal(h.Calendars.value.revision, 3);
  }
});
test('reserve requires approved exact current state and rejects competing operations', async () => {
  const h = harness(); h.Runs.value.status = 'approved'; h.Calendars.value.currentOperationId = null;
  const results = await Promise.allSettled([h.store.reserve(id, scope), h.store.reserve(id, scope)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(h.Calendars.writes, 1);
  await h.store.reserve(id, scope);
  assert.equal(h.Calendars.writes, 1);
  assert.equal(h.Calendars.value.currentOperationId, id); assert.equal(h.Calendars.value.verifiedThrough, '2026-09-30');
});
test('scope mismatch and invalid run identifiers cannot read or mutate another company', async () => {
  const h = harness();
  await assert.rejects(h.store.finish(id, { ...scope, realmId: '456' }));
  await assert.rejects(h.store.finish({ $ne: null }, scope), /identifier/);
  assert.equal(h.Calendars.writes, 0);
});
test('record evidence must match expected keys, versions, freshness and physical uniqueness', () => {
  for (const mutate of [
    data => { data.proof.records[0].syncToken = ''; },
    data => { data.proof.records[0].state = 'sending'; },
    data => { data.proof.records[0].logicalKey = hash('other'); },
    data => { data.proof.records[0].observedAt = '2026-10-06T11:00:00Z'; },
    data => { data.proof.records[0].auditId = ''; },
    data => { data.proof.complete = false; },
    data => { data.proof.records[0].relationships = [{ logicalKey: hash('absent'), entity: 'Invoice', qboId: '100', syncToken: '0' }]; },
  ]) { const data = fixture(); mutate(data); assert.throws(() => validatePeriodProof(data.run, data.proof, Date.parse(timestamp))); }
});
test('assertions cannot substitute manual evidence, another basis, an earlier report or a different period', () => {
  for (const change of [{ evidenceType: 'manual-confirmation' }, { basis: 'Cash' }, { throughDate: '2026-10-05' }, { recordSetHash: hash('other') }, { observedAt: '2026-10-06T11:59:59Z' }, { status: 'unverified' }]) {
    const data = fixture(); Object.assign(data.proof.assertions[0], change);
    assert.throws(() => validatePeriodProof(data.run, data.proof, Date.parse(timestamp)));
  }
});
test('calendar dates cannot skip unverified business days', () => {
  const data = fixture(); data.run.fromDate = '2026-10-02';
  assert.throws(() => assertRun(data.run, scope), /immediately follow/);
});

test('a requested stop fences completion without falsely settling external activity', async () => {
  const h = harness(); await h.store.requestStop(id, scope);
  assert.equal(h.Calendars.value.stopRequested, true);
  assert.equal(h.Runs.value.status, 'awaiting-evidence');
  await assert.rejects(h.store.finish(id, scope), /changed or stopped/);
  assert.equal(h.Calendars.value.revision, 3);
});
test('future business periods and ambiguous observation timestamps cannot be verified', () => {
  const data = fixture(); data.run.throughDate = '2026-10-07'; data.proof.throughDate = data.run.throughDate;
  assert.throws(() => validatePeriodProof(data.run, data.proof, Date.parse(timestamp)), /future business period/);
  const other = fixture(); other.proof.observedAt = '2026-10-06 12:00:00';
  assert.throws(() => validatePeriodProof(other.run, other.proof, Date.parse(timestamp)), /stale/);
});

test('a matching logical key cannot substitute a different QBO entity type', () => {
  const data = fixture(); data.proof.records[0].entity = 'Bill';
  data.proof.assertions[0].recordSetHash = hash(data.proof.records);
  assert.throws(() => validatePeriodProof(data.run, data.proof, Date.parse(timestamp)), /saved operation record set/);
});

test('run state changes during proof loading abort the whole calendar transition', async () => {
  const h = harness(); h.deps.loadProof = async () => { h.Runs.value.status = 'stopped'; return clone(h.data.proof); };
  const store = createBusinessPeriodStore(h.deps);
  await assert.rejects(store.finish(id, scope), /state or evidence changed/);
  assert.equal(h.Calendars.value.revision, 3); assert.equal(h.Calendars.value.pendingCommit, null);
  assert.equal(h.Runs.value.status, 'stopped');
});
test('changed frozen evidence revision cannot commit old proof', async () => {
  const h = harness(); h.deps.loadProof = async () => { h.Runs.value.evidenceRevision++; return clone(h.data.proof); };
  await assert.rejects(createBusinessPeriodStore(h.deps).finish(id, scope), /state or evidence changed/);
  assert.equal(h.Calendars.value.revision, 3);
});
test('failed calendar CAS rolls back the run claim in the same transaction', async () => {
  const h = harness(); h.Calendars.value.stopRequested = true;
  await assert.rejects(h.store.finish(id, scope));
  assert.equal(h.Runs.value.status, 'awaiting-evidence'); assert.equal(h.Calendars.value.revision, 3);
});
test('transaction adapter uses one session, returns committed result and always cleans up', async () => {
  const { createBusinessTransaction } = require('../src/modules/business-transaction');
  const events = []; const session = { withTransaction: async (fn, options) => { events.push(options); await fn(); }, endSession: async () => { events.push('ended'); } };
  const execute = createBusinessTransaction({ startSession: async () => session });
  assert.equal(await execute(async received => { assert.equal(received, session); return 42; }), 42);
  assert.equal(events[0].writeConcern.w, 'majority'); assert.equal(events[0].timeoutMS, 15000); assert.equal(events[1], 'ended');
  await assert.rejects(execute(async () => { throw new Error('failure'); }), /failure/);
  assert.equal(events.at(-1), 'ended');
});

test('transaction callback retries recheck permission before making another attempt', async () => {
  const h = harness(); let revoked = false;
  h.deps.authorize = async () => { if (revoked) throw new Error('permission revoked on retry'); return { actorId: 'actor' }; };
  h.deps.transaction = async work => {
    const run = clone(h.Runs.value), calendar = clone(h.Calendars.value);
    await work({ fixtureSession: true });
    // Model a driver's aborted first attempt followed by a callback retry.
    h.Runs.value = run; h.Calendars.value = calendar; revoked = true;
    return work({ fixtureSession: true });
  };
  await assert.rejects(createBusinessPeriodStore(h.deps).finish(id, scope), /revoked on retry/);
  assert.equal(h.Calendars.value.revision, 3); assert.equal(h.Runs.value.status, 'awaiting-evidence');
});

test('calendar repair rechecks the same recovery actor before releasing company ownership', async () => {
  const h = harness(); h.Runs.failStatus = 'verified'; await assert.rejects(h.store.finish(id, scope));
  let calls = 0, releases = 0;
  h.deps.authorize = async () => ({ actorId: ++calls >= 3 ? 'another-actor' : 'actor' });
  h.deps.Writer.release = async () => { releases++; };
  await assert.rejects(createBusinessPeriodStore(h.deps).repair(scope), /Recovery actor changed/);
  assert.equal(releases, 0); assert.ok(h.Calendars.value.pendingCommit); assert.equal(h.Calendars.value.currentOperationId, id);
});

test('approved status without an exact durable approval cannot reserve the calendar', async () => {
  for (const change of [run => { run.approval = null; }, run => { run.approval.planHash = hash('other'); }, run => { run.approval.auditId = ''; }, run => { run.approval.fenceHash = 'invalid'; }]) {
    const h = harness(); h.Runs.value.status = 'approved'; h.Calendars.value.currentOperationId = null; change(h.Runs.value);
    await assert.rejects(h.store.reserve(id, scope), /durable approval/);
    assert.equal(h.Runs.value.status, 'approved'); assert.equal(h.Calendars.value.currentOperationId, null); assert.equal(h.audits.size, 0);
  }
});
