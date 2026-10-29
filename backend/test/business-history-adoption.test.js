'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { createBusinessHistoryAdoption, creationIdentity } = require('../src/modules/business-history-adoption');

const scope = { environment: 'production', realmId: '123', connectionId: 'c'.repeat(24) };
const AUTH = 'a'.repeat(64);
const matches = (row, query) => Object.entries(query).every(([key, want]) => {
  const value = key.split('.').reduce((obj, part) => obj?.[part], row);
  if (key === '$or') return want.some(part => matches(row, part));
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    if ('$in' in want) return want.$in.includes(value);
    if ('$gte' in want) return value >= want.$gte && value <= want.$lte;
    if ('$exists' in want) return (value !== undefined) === want.$exists;
  }
  return String(value) === String(want);
});
function model(rows) {
  const chain = list => { const api = { session: () => api, maxTimeMS: () => api, select: () => api, sort: () => api, limit: () => api, lean: () => api, then: (ok, ko) => Promise.resolve(list).then(ok, ko), cursor: () => list }; return api; };
  return {
    rows,
    findOne: query => { const found = rows.find(row => matches(row, query)) || null; const api = { session: () => api, maxTimeMS: () => api, lean: () => Promise.resolve(found) }; return api; },
    find: query => chain(rows.filter(row => matches(row, query))),
    aggregate: pipeline => ({ option: async () => { const list = rows.filter(row => matches(row, pipeline[0].$match)); return list.length ? [{ total: list.length, saved: list.filter(row => row.state === 'saved').length, contentChecked: list.filter(row => row.state === 'saved' && row.financialProof).length }] : []; } }),
  };
}
function fixture(change = () => {}) {
  const steps = [1, 2].map(n => ({ operationId: 'o'.repeat(24), environment: 'production', realmId: '123', logicalKey: 'k' + n, entity: 'Invoice', fingerprint: 'f' + n, state: 'saved', compilation: { compilationHash: 'h' + n }, receipt: { n }, dispatch: { n }, qboId: String(n) })).concat([{ operationId: 'o'.repeat(24), environment: 'production', realmId: '123', logicalKey: 'k3', state: 'claimed' }]);
  const importedHash = hash(steps.filter(row => row.state === 'saved').map(creationIdentity));
  const manifest = [{ logicalKey: 'p1' }, { logicalKey: 'p2' }];
  const state = {
    calendar: { ...scope, authorityHash: AUTH, openingDate: '2023-09-01', verifiedThrough: null, adoption: null, pendingCommit: null, stopRequested: false, currentOperationId: 'o'.repeat(24) },
    writer: { environment: 'production', realmId: '123', connectionId: scope.connectionId, unresolved: null, operationId: 'o'.repeat(24), planHash: 'p'.repeat(64), populationDelegation: { kind: 'business-population', jobId: 'j'.repeat(24), manifestHash: hash(manifest), importedHash, authorityHash: AUTH, originalOperationId: 'o'.repeat(24) } },
    job: { _id: 'j'.repeat(24), ...scope, status: 'populated', manifest, manifestHash: hash(manifest), importedHash, authorityHash: AUTH, fromDate: '2023-09-01', throughDate: '2026-10-17', createdThrough: '2026-10-17', batch: null, leaseToken: null, verification: { status: 'completed' } },
    run: { _id: 'o'.repeat(24), ...scope, status: 'blocked', planHash: 'p'.repeat(64), leaseToken: null, executionRequest: null },
    records: manifest.map((row, i) => ({ environment: 'production', realmId: '123', authorityHash: AUTH, txnDate: '2024-01-0' + (i + 1), logicalKey: row.logicalKey, state: 'saved', financialProof: { ok: true }, coverageGaps: i ? ['time-invoice-billing-unverified'] : [] })),
    steps, receipts: [],
  };
  change(state);
  const models = { Calendars: model([state.calendar]), Writers: model([state.writer]), Jobs: model([state.job]), Runs: model([state.run]), Records: model(state.records), Steps: model(state.steps), Receipts: model(state.receipts) };
  return createBusinessHistoryAdoption({ models, now: () => Date.parse('2026-10-28T12:00:00Z') });
}

test('a complete, idle population is ready for adoption with stable reviewed terms', async () => {
  const result = await fixture().review(scope);
  assert.deepEqual(result.unmet, []);
  assert.equal(result.ready, true);
  assert.equal(result.terms.through, '2026-10-17');
  assert.equal(result.terms.recordCount, 2);
  assert.deepEqual(result.terms.limitations, { 'estimate-invoice-conversion-unverified': 0, 'time-invoice-billing-unverified': 1, 'record-verification-failed': 0 });
  assert.equal(result.limitedRecords, 1);
  assert.deepEqual(result.original, { operationId: 'o'.repeat(24), planHash: 'p'.repeat(64), status: 'blocked', savedRecords: 2, claimedSteps: 1 });
  assert.equal(result.termsHash, (await fixture().review(scope)).termsHash);
  assert.equal(result.qboWrites, 0);
});

const refusals = [
  ['uncertain-write', s => { s.writer.unresolved = { any: true }; }],
  ['calendar-advanced', s => { s.calendar.verifiedThrough = '2026-10-17'; }],
  ['completion-pending', s => { s.calendar.pendingCommit = { x: 1 }; }],
  ['job-unfinished', s => { s.job.status = 'running'; }],
  ['recheck-running', s => { s.job.verification.status = 'running'; }],
  ['job-batch', s => { s.job.batch = { state: 'prepared' }; }],
  ['imported-changed', s => { s.writer.populationDelegation.importedHash = 'x'.repeat(64); }],
  ['original-changed', s => { s.steps[0].qboId = '999'; }],
  ['original-uncertain', s => { s.steps[2].state = 'dispatched'; }],
  ['original-active', s => { s.run.status = 'running'; }],
  ['records-incomplete', s => { s.records[1].state = 'pending'; }],
  ['content-unchecked', s => { s.records[0].financialProof = null; }],
  ['receipt-uncertain', s => { s.receipts.push({ environment: 'production', realmId: '123', state: 'possibly-sent' }); }],
  ['authority-changed', s => { s.calendar.authorityHash = 'b'.repeat(64); }],
  ['opening-mismatch', s => { s.job.fromDate = '2024-01-01'; }],
];
for (const [code, change] of refusals) test('adoption is not ready when ' + code, async () => {
  const result = await fixture(change).review(scope);
  assert.equal(result.ready, false);
  assert.ok(result.unmet.some(item => item.code === code), JSON.stringify(result.unmet));
});

test('no population delegation means nothing to adopt', async () => {
  const result = await fixture(s => { s.writer.populationDelegation = null; }).review(scope);
  assert.equal(result.ready, false);
  assert.deepEqual(result.unmet.map(item => item.code), ['no-population']);
});
