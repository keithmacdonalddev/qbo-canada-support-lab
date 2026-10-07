'use strict';
const assert = require('node:assert/strict');
const { hash, canonical } = require('../../src/modules/business-calendar');
const { createBusinessRunState } = require('../../src/modules/business-run-state');
const { createBusinessPeriodStore } = require('../../src/modules/business-period-store');
const { createBusinessWriterFence } = require('../../src/modules/business-writer-fence');
const { createBusinessOperationRunner } = require('../../src/modules/business-operation-runner');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, operationId = 'b'.repeat(24), actorId = 'c'.repeat(24);
const clone = value => structuredClone(value);
const at = (row, path) => path.split('.').reduce((value, key) => value?.[key], row);
const match = (row, filter) => row && Object.entries(filter).every(([key, value]) => key === '$or' ? value.some(option => match(row, option)) : value && typeof value === 'object' && !(value instanceof Date) ? ('$in' in value ? value.$in.includes(at(row, key)) : '$exists' in value ? (at(row, key) !== undefined) === value.$exists : canonical(at(row, key)) === canonical(value)) : value instanceof Date ? new Date(at(row, key)).getTime() === value.getTime() : at(row, key) === value);
function harness(count = 3, requiredAssertions = [{ key: 'records', evidenceType: 'record-readback', currency: 'CAD' }]) {
  const entries = Array.from({ length: count }, (_, index) => ({ kind: 'create', step: { logicalKey: hash('activity ' + index), entity: 'Estimate', dependencies: [] } }));
  const descriptors = entries.map(row => ({ logicalKey: row.step.logicalKey, entity: row.step.entity, fingerprint: hash(row.step), relationships: [] }));
  const manifest = { version: 1, scope, businessKey: 'flagship', blueprintId: 'e'.repeat(24), blueprintHash: hash('blueprint'), baselineHash: hash('baseline'), fromDate: '2026-10-06', throughDate: '2026-10-06', expectedCursor: '2026-10-05', expectedRevision: 1, expectedRecordSetHash: hash([...descriptors].sort((a, b) => a.logicalKey.localeCompare(b.logicalKey))), requiredAssertions, recordCount: count, records: descriptors }, planHash = hash(manifest), clock = Date.parse('2026-10-06T12:00:00.000Z');
  const h = { clock, entries, data: { Runs: [], Calendars: [], Writers: [], Plans: [], Steps: [], Evidence: [] }, audits: [], allowed: true, sequence: 0, dispatchCalls: [], writes: 0, graphCalls: [], pages: [], evidenceReady: true };
  const run = { _id: operationId, ...scope, contractVersion: 1, businessKey: 'flagship', blueprintId: 'e'.repeat(24), blueprintHash: hash('blueprint'), baselineHash: hash('baseline'), planId: 'f'.repeat(24), planHash, fromDate: '2026-10-06', throughDate: '2026-10-06', expectedCursor: '2026-10-05', expectedRevision: 1,
    recordCount: count, expectedRecordSetHash: hash([...descriptors].sort((a, b) => a.logicalKey.localeCompare(b.logicalKey))), requiredAssertions, status: 'approved', verification: null, writerRevision: 0, evidenceRevision: 0, executionRevision: 0, nextOrdinal: 0,
    approval: { actorId, planHash, fenceHash: hash('approval'), auditId: 'approval', approvedAt: new Date(clock).toISOString() } };
  h.data.Runs.push(run); h.data.Plans.push({ _id: run.planId, ...scope, operationId, planHash, manifest });
  h.data.Calendars.push({ _id: 'sandbox:123', ...scope, contractVersion: 1, businessKey: run.businessKey, blueprintId: run.blueprintId, blueprintHash: run.blueprintHash, baseline: { status: 'verified', evidenceHash: run.baselineHash }, openingDate: '2026-10-01', verifiedThrough: run.expectedCursor, revision: 1, writerRevision: 0, currentOperationId: null, stopRequested: false, pendingCommit: null });
  h.data.Writers.push({ _id: 'sandbox:123', ...scope, contractVersion: 1, revision: 0, operationId: null, planHash: null, unresolved: null });
  h.run = () => h.data.Runs[0]; h.calendar = () => h.data.Calendars[0]; h.writer = () => h.data.Writers[0];
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, {
    find(filter) { let maximum = Infinity; const query = { select() { return query; }, session() { return query; }, maxTimeMS() { return query; }, limit(value) { maximum = value; return query; }, lean: async () => clone(h.data[name].filter(row => match(row, filter)).slice(0, maximum)) }; return query; },
    async create(rows) { for (const row of rows) { if (h.data[name].some(item => item._id === row._id)) throw new Error('duplicate identity'); h.data[name].push(clone(row)); } },
    findOne(filter) { const query = { session() { return query; }, maxTimeMS() { return query; }, lean: async () => clone(h.data[name].find(row => match(row, filter)) || null) }; return query; },
    findOneAndUpdate(filter, change, options = {}) { return { lean: async () => { const row = h.data[name].find(row => match(row, filter)); if (!row) return null; Object.assign(row, clone(change.$set || {})); for (const [key, value] of Object.entries(change.$inc || {})) row[key] = (row[key] || 0) + value; return clone(row); } }; },
  }]));
  let queue = Promise.resolve();
  h.transaction = work => { const result = queue.then(async () => { const before = clone(h.data), audits = clone(h.audits); try { return await work({ inTransaction: () => true }); } catch (error) { h.data = before; h.audits = audits; throw error; } }); queue = result.catch(() => {}); return result; };
  h.authorize = async () => { if (!h.allowed) throw new Error('permission revoked'); return { actorId }; };
  h.assertReady = async () => {};
  h.writeAudit = async (eventKey, details) => { if (h.failAudit) throw new Error('audit unavailable'); const old = h.audits.find(row => row.eventKey === eventKey); if (old) return old; const row = { id: String(h.audits.length + 1), eventKey, details }; h.audits.push(row); return row; };
  h.writerFence = createBusinessWriterFence({ ...h.models, assertIntegration: async () => {} });
  h.state = createBusinessRunState({ ...h.models, transaction: h.transaction, authorize: h.authorize, assertReady: h.assertReady, writeAudit: h.writeAudit, now: () => h.clock, token: () => 'worker-lease-' + String(++h.sequence).padStart(16, '0') });
  h.periods = createBusinessPeriodStore({ ...h.models, Writer: h.writerFence, transaction: h.transaction, authorize: h.authorize, assertReady: h.assertReady, writeAudit: h.writeAudit, loadProof: async () => clone(h.proof), now: () => h.clock });
  h.saveStep = key => {
    const descriptor = descriptors.find(row => row.logicalKey === key); let row = h.data.Steps.find(row => row.logicalKey === key);
    if (!row) { row = { ...scope, ...descriptor, _id: key, qboId: String(1000 + descriptors.indexOf(descriptor)), receipt: { qboId: String(1000 + descriptors.indexOf(descriptor)) }, lastAuditId: 'saved-' + key }; h.data.Steps.push(row); h.writes++; }
    row.dispatch = { compilationHash: hash('compiled ' + key) }; row.state = 'verified'; row.verification = { compilationHash: row.dispatch.compilationHash, kind: 'business-readback', observedHash: hash('body ' + key), evidenceHash: hash('proof ' + key), graphEvidenceHash: hash('graph ' + key), syncToken: '0', observedAt: new Date(h.clock).toISOString(), relationships: [] }; return row;
  };
  h.plans = { page: async (_scope, op, offset, limit) => { assert.deepEqual(_scope, scope); assert.equal(op, operationId); h.pages.push(offset); return { operationId, planHash, status: h.run().status, offset, recordCount: count, entries: clone(entries.slice(offset, offset + limit)) }; } };
  h.steps = { verifyGraph: async (_scope, op, keys) => { h.graphCalls.push(...keys); if (h.graphFail) return { complete: false, persisted: false }; keys.forEach(h.saveStep); return { complete: true, persisted: true }; } };
  h.dispatch = async (_scope, op, key, options) => {
    assert.deepEqual(_scope, scope); assert.equal(op, operationId); assert.equal(options.leaseToken, h.run().leaseToken); h.dispatchCalls.push({ key, ...options });
    if (h.onDispatch) return h.onDispatch(key, options);
    if (options.recoveryOnly) { h.writer().unresolved = null; return { state: 'saved', complete: false }; }
    h.saveStep(key); return { state: 'verified', complete: true };
  };
  h.prepareEvidence = async () => {
    if (!h.evidenceReady) return { prepared: false };
    const records = h.data.Steps.map(row => ({ logicalKey: row.logicalKey, entity: row.entity, fingerprint: row.fingerprint, qboId: row.qboId, state: 'verified', observedHash: row.verification.observedHash, syncToken: row.verification.syncToken, observedAt: row.verification.observedAt, auditId: row.lastAuditId, relationships: [] }));
    const recordSetHash = hash([...records].sort((a, b) => a.logicalKey.localeCompare(b.logicalKey))), current = h.run();
    h.proof = { version: 1, ...scope, operationId, planHash, blueprintHash: current.blueprintHash, baselineHash: current.baselineHash, complete: true, fromDate: current.fromDate, throughDate: current.throughDate, observedAt: new Date(h.clock).toISOString(), expectedRecordSetHash: current.expectedRecordSetHash, records,
      assertions: [{ key: 'records', evidenceType: 'record-readback', currency: 'CAD', status: 'passed', recordSetHash, sourceHash: hash('observed records'), observedAt: new Date(h.clock).toISOString(), fromDate: current.fromDate, throughDate: current.throughDate }] };
    current.evidenceRevision++; current.verificationCandidateHash = hash(h.proof); return { prepared: true };
  };
  h.runner = () => createBusinessOperationRunner({ state: h.state, plans: h.plans, steps: h.steps, dispatch: h.dispatch, periods: h.periods, prepareEvidence: h.prepareEvidence });
  h.execute = options => h.runner()(scope, operationId, options);
  return h;
}
module.exports = { harness, scope, operationId, hash, clone };
