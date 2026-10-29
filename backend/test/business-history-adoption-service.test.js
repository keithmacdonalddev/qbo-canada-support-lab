'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { createHistoryAdoptionService } = require('../src/modules/business-history-adoption-service');

const scope = { environment: 'production', realmId: '123', connectionId: 'c'.repeat(24) };
const company = { environment: 'production', realmId: '123' };
const terms = { jobId: 'a'.repeat(24), through: '2026-10-17', authorityHash: 'f'.repeat(64), importedHash: 'e'.repeat(64), manifestHash: 'd'.repeat(64), original: { operationId: 'b'.repeat(24), planHash: '9'.repeat(64) }, limitations: {} };
function store(rows) {
  const match = (row, q) => Object.entries(q).every(([k, v]) => { const value = k.split('.').reduce((o, p) => o?.[p], row); return v === null ? value == null : String(value) === String(v); });
  const one = value => { const api = { session: () => api, maxTimeMS: () => api, lean: () => Promise.resolve(value) }; return api; };
  return { rows, findOne: q => one(rows.find(r => match(r, q)) || null), findOneAndUpdate: (q, u) => { const row = rows.find(r => match(r, q)); if (row) { Object.assign(row, u.$set || {}); for (const [k, n] of Object.entries(u.$inc || {})) row[k] = (row[k] || 0) + n; } return one(row ? { ...row } : null); }, create: async list => { rows.push(...list); return list; } };
}
function setup({ ready = true, unmet = [] } = {}) {
  const calendar = { _id: 'cal', ...scope, revision: 3, writerRevision: 2, verifiedThrough: null, pendingCommit: null, adoption: null, stopRequested: false, currentOperationId: terms.original.operationId };
  const writer = { _id: 'w', ...company, connectionId: scope.connectionId, revision: 7, unresolved: null, populationDelegation: { jobId: terms.jobId }, operationId: terms.original.operationId, planHash: terms.original.planHash };
  const run = { _id: terms.original.operationId, ...scope, planHash: terms.original.planHash, status: 'blocked', executionRevision: 1, writerRevision: 1, leaseToken: null };
  const models = { Calendars: store([calendar]), Writers: store([writer]), Runs: store([run]), Policies: store([{ _id: 'p', ...company, connectionId: scope.connectionId, revision: 4, state: 'active' }]), Audits: store([]), Jobs: store([{ _id: terms.jobId, ...scope, revision: 1, status: 'populated' }]), PopulationRecords: store([]) };
  const service = createHistoryAdoptionService({ models, transaction: work => work('session'), now: () => Date.parse('2026-10-29T12:00:00Z'), bind: async () => ({ scope, ownerId: 'o'.repeat(24), actorId: 'o'.repeat(24), access: {} }), fence: async () => {} });
  // Replace the evidence pipeline with fixed results; the readers are covered by their own tests.
  const reviewed = { ready, unmet, terms, through: '2026-10-20', gap: null, contentHash: '4'.repeat(64), termsHash: hash(terms), evidenceHash: '1'.repeat(64), evidence: { ok: true }, stock: { stateHash: '2'.repeat(64), replayHash: '3'.repeat(64), costCents: 10 } };
  reviewed.reviewHash = hash({ termsHash: reviewed.termsHash, through: reviewed.through, evidenceHash: reviewed.evidenceHash, stock: reviewed.stock });
  return { models, service, reviewed, calendar, writer, run };
}
test('adoption is refused unless the review is ready and unchanged', async () => {
  const { service } = setup();
  await assert.rejects(service.adopt({ id: 'x' }, { reviewHash: 'nope', reason: 'short', confirmProduction: true }), /exact reviewed history/);
});

test('adoption settles the import in one transaction and is idempotent', async () => {
  const { models, reviewed, calendar, writer, run } = setup();
  const service = createHistoryAdoptionService({ models, transaction: work => work('session'), now: () => Date.parse('2026-10-29T12:00:00Z'), bind: async () => ({ scope, ownerId: 'o'.repeat(24), actorId: 'o'.repeat(24), access: {} }), fence: async () => {},
    overrides: { evidence: async () => reviewed, pending: async () => ({ unmet: [], termsHash: reviewed.termsHash, writer, job: { status: 'populated', revision: 1 }, original: { ...terms.original } }) } });
  const input = { reviewHash: reviewed.reviewHash, reason: 'Owner directed the accountant to take over the imported history.', confirmProduction: true };
  await assert.rejects(service.adopt({}, { ...input, reviewHash: '0'.repeat(64) }), /changed after the adoption review/);
  const result = await service.adopt({}, input);
  assert.equal(result.adopted, true);
  assert.equal(result.qboWrites, 0);
  assert.equal(calendar.verifiedThrough, '2026-10-20');
  assert.equal(calendar.adoption.importedThrough, '2026-10-17');
  assert.equal(calendar.adoption.kind, 'adopted-history');
  assert.equal(calendar.currentOperationId, null);
  assert.equal(writer.populationDelegation, null);
  assert.equal(writer.operationId, null);
  assert.equal(run.status, 'retired');
  assert.equal(run.retirement.kind, 'superseded-by-population');
  assert.equal(models.Audits.rows.length, 1);
  assert.equal(models.Audits.rows[0].afterState.qboWrites, 0);
  assert.equal(models.Jobs.rows[0].status, 'adopted', 'the population job is closed');
  const again = await service.adopt({}, input);
  assert.equal(again.reused, true);
  assert.equal(models.Audits.rows.length, 1);
});

test('adoption is refused when the evidence is not ready', async () => {
  const { models, reviewed } = setup();
  const service = createHistoryAdoptionService({ models, transaction: work => work('session'), now: () => Date.now(), bind: async () => ({ scope, ownerId: 'o'.repeat(24), actorId: 'o'.repeat(24), access: {} }), fence: async () => {},
    overrides: { evidence: async () => ({ ...reviewed, ready: false, unmet: [{ code: 'activity-after', detail: 'Later activity exists.' }] }) } });
  await assert.rejects(service.adopt({}, { reviewHash: reviewed.reviewHash, reason: 'Owner directed the accountant to take over the imported history.', confirmProduction: true }), /not ready: Later activity exists/);
});
