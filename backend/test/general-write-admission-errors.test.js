'use strict';
// Sanitized stored Vendor run 14bc98000f3c4b0a48a9d3b3 (2026-11-01T00:47:54.476Z).
// Real admit -> guardBatch -> published context, with isolated storage; no DB/QBO.
const test = require('node:test'), assert = require('node:assert/strict');
const { createGeneralGateTransport, buildGeneralBatch } = require('../src/modules/general-write-transport');
const { createGeneralWriteService, createGeneralWriteContext } = require('../src/modules/general-write-service');
const { businessErrorDetail, attachBusinessError, failureFields } = require('../src/modules/business-error-detail');
const { MongoServerError, ClientSession } = require('mongoose').mongo;
const { createBusinessTransaction } = require('../src/modules/business-transaction');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, ownerId = 'b'.repeat(24), runId = '14bc98000f3c4b0a48a9d3b3';
const now = () => Date.parse('2026-11-01T00:47:54.476Z');
const query = value => ({ select() { return this; }, sort() { return this; }, maxTimeMS() { return this; }, limit() { return this; }, session() { return this; }, lean: async () => typeof value === 'function' ? value() : value });
function fixture(t, admissionError = null, currencyRows = []) {
  t.mock.method(require('../src/modules/business-authority'), 'readPublishedBusiness', async () => ({ view: { business: { openingDate: '2023-09-01' }, mappings: { salesTax: '16', purchaseTax: '16' } } }));
  const item = { bId: '1', ref: 'supplier', op: 'create', entity: 'Vendor', operation: 'create', payload: { DisplayName: 'Example winter supply vendor', CompanyName: 'Example Winter Supply', CurrencyRef: { value: 'CAD' } } };
  const batch = { index: 0, attempt: 1, requestId: '820a00f97def697506d0f7802595c241', items: [item], state: 'sending', sends: 1 };
  const run = { _id: runId, contract: 'general-write-v1', ...scope, ownerId, actorId: ownerId, status: 'sending', day: '2026-10-31', decisionKey: 'winter-20261031-deicing-supplier-onboarding', plan: { operations: [item] }, batches: [batch], items: {}, dirty: [], revision: 1 };
  let touches = 0, writes = 0;
  const models = {
    GeneralWriteRuns: { findOne: filter => query(filter._id === runId ? run : null), findOneAndUpdate: () => { writes++; return query(run); } },
    Calendars: { findOne: () => query({ _id: 'sandbox:123', verifiedThrough: '2026-10-30', baseline: {}, revision: 31, writerRevision: 3945 }), findOneAndUpdate: () => query(() => { touches++; const error = typeof admissionError === 'function' ? admissionError(touches) : admissionError; if (error) throw error; return {}; }) },
    Policies: { findOne: () => query({ periodControl: {} }) }, Records: { find: (filter, projection, options) => query(() => { if (currencyRows.length > (options?.batchSize || 101)) throw new MongoServerError({ code: 2, message: 'cannot set maxTimeMS on getMore command for a non-awaitData cursor' }); return currencyRows; }) }, Steps: { findOne: () => query(null) },
  };
  const copy = { read: async () => { throw Error('Vendor create must not fetch a record'); } };
  const service = createGeneralWriteService({ models, copy, contextFor: createGeneralWriteContext({ models, now }), now });
  const transport = createGeneralGateTransport({ models, scope, runId, batchIndex: 0, admissionGuard: input => service.guardBatch(input), now });
  const admit = session => transport.admit({ request: buildGeneralBatch(scope, batch), receiptId: 'offline-receipt', dispatchKey: 'offline-dispatch', writer: { operationId: null, planHash: null, unresolved: null }, ownerId, actorId: ownerId, session, periodProof: { proofs: [{ evidence: { records: [] } }] } });
  return { admit, counters: () => ({ touches, writes }) };
}
test('stored vendor admission shape passes the real guard and never calls QuickBooks', async t => {
  const h = fixture(t); assert.equal((await h.admit({ inTransaction: () => true })).kind, 'general-write'); assert.deepEqual(h.counters(), { touches: 1, writes: 1 });
});
test('unexpected guard failure keeps the cause code, message, source and scrubbed stack after persistence', async t => {
  const failure = Object.assign(new TypeError('Unexpected guard failure; password=private-value'), { code: 'EXACT_GUARD_FAILURE', stack: 'TypeError: password=private-value\n    at readContext (C:\\Projects\\qbo\\backend\\src\\modules\\general-write-service.js:314:23)\n    at guard (C:\\Projects\\qbo\\backend\\src\\modules\\general-write-service.js:82:148)' });
  const h = fixture(t, failure);
  await assert.rejects(h.admit({ inTransaction: () => true }), error => {
    assert.equal(error.code, 'QBO_WRITE_ADMISSION_DENIED'); assert.equal(error.cause, failure); assert.equal(error.outcomeUnknown, false); assert.equal(error.qboStage, 'write_admission');
    const saved = failureFields(null, attachBusinessError(error, { operationId: runId }));
    const detail = businessErrorDetail(JSON.parse(JSON.stringify(saved.errorDetail))), cause = detail.detail.cause;
    assert.equal(cause.code, 'EXACT_GUARD_FAILURE'); assert.match(cause.message, /Unexpected guard failure/); assert.equal(cause.check.file, 'backend/src/modules/general-write-service.js'); assert.equal(cause.check.line, 314); assert.ok(cause.stackTrace.some(frame => frame.includes('general-write-service.js:314:23'))); assert.ok(!JSON.stringify(saved).includes('private-value')); return true;
  }); assert.deepEqual(h.counters(), { touches: 1, writes: 0 });
});
test('the installed transaction driver retries an original transient MongoDB error at admission', async t => {
  const conflict = new MongoServerError({ message: 'Write conflict during admission', code: 112, errorLabels: ['TransientTransactionError'] });
  const h = fixture(t, touches => touches === 1 ? conflict : null);
  let commits = 0, aborts = 0, ended = 0;
  const session = { clientOptions: { serverSelectionTimeoutMS: 1000 }, transaction: { state: 'NO_TRANSACTION' }, inTransaction: () => true,
    startTransaction() { this.transaction.state = 'STARTING_TRANSACTION'; },
    async abortTransaction() { aborts++; this.transaction.state = 'TRANSACTION_ABORTED'; },
    async commitTransaction() { commits++; this.transaction.state = 'TRANSACTION_COMMITTED'; },
    async endSession() { ended++; }, withTransaction: ClientSession.prototype.withTransaction };
  const result = await createBusinessTransaction({ startSession: async () => session })(s => h.admit(s));
  assert.equal(result.kind, 'general-write'); assert.deepEqual(h.counters(), { touches: 2, writes: 1 }); assert.equal(aborts, 1); assert.equal(commits, 1); assert.equal(ended, 1); assert.equal(conflict.code, 112); assert.ok(conflict.hasErrorLabel('TransientTransactionError'));
});
test('a permanent MongoDB failure remains definitely unsent and keeps the driver cause', async t => {
  const failure = new MongoServerError({ message: 'Admission storage unavailable', code: 26 }); const h = fixture(t, failure);
  await assert.rejects(h.admit({ inTransaction: () => true }), error => {
    assert.equal(error, failure); assert.equal(error.code, 26); assert.equal(error.qboStage, 'write_admission'); assert.equal(error.outcomeUnknown, false);
    const cause = failureFields(null, error).errorDetail.detail.cause; assert.equal(cause.code, 26); assert.equal(cause.message, 'Admission storage unavailable'); assert.ok(cause.stackTrace.length); return true;
  }); assert.equal(h.counters().writes, 0);
});

test('an explicit admission refusal keeps its own code, check and problems', async t => {
  const failure = Object.assign(new Error('Waiting for a shared resource'), { code: 'QBO_RESOURCE_BUSY', qboStage: 'write_admission', outcomeUnknown: false, businessDetail: { problems: [{ ref: 'supplier', message: 'Reserved by another batch' }] } });
  attachBusinessError(failure, { check: { module: 'existing-guard', function: 'checkResources', file: 'backend/src/modules/general-write-guards.js', line: 92 } });
  const h = fixture(t, failure);
  await assert.rejects(h.admit({ inTransaction: () => true }), error => {
    assert.equal(error, failure); const detail = failureFields(null, error).errorDetail;
    assert.equal(detail.code, 'QBO_RESOURCE_BUSY'); assert.equal(detail.message, 'Waiting for a shared resource'); assert.equal(detail.check.function, 'checkResources'); assert.deepEqual(detail.detail.problems, [{ ref: 'supplier', message: 'Reserved by another batch' }]); assert.equal(detail.detail.cause.code, 'QBO_RESOURCE_BUSY'); return true;
  });
});
test('large multibyte diagnostics cannot evict the retained cause', async t => {
  const failure = Object.assign(new Error('界'.repeat(2000)), { code: 'GENERAL_WRITE_REFUSED', stack: 'Error: '+ '界'.repeat(2000) + '\n' + Array(20).fill('    at guard (C:/Projects/qbo/backend/src/modules/general-write-service.js:314:23)').join('\n'), businessDetail: { problems: Array(20).fill({ message: '界'.repeat(300) }) } });
  const h = fixture(t, failure);
  await assert.rejects(h.admit({ inTransaction: () => true }), error => {
    const cause = businessErrorDetail(failureFields(null, error).errorDetail).detail.cause;
    assert.equal(cause.code, 'GENERAL_WRITE_REFUSED'); assert.equal(cause.check.line, 314); assert.ok(cause.stackTrace.length); assert.ok(Buffer.byteLength(JSON.stringify(error.errorDetail.detail)) <= 3500); return true;
  });
});

test('exact stored failure: 131 currency/account rows admit without transaction getMore error 2', async t => {
  const records = [{ entity: 'Preferences', qboId: '1', record: { CurrencyPrefs: { HomeCurrency: { value: 'CAD' }, MultiCurrencyEnabled: true } } },
    ...Array.from({ length: 130 }, (_, i) => ({ entity: 'Account', qboId: String(i + 1), record: { Active: true, AccountType: 'Bank', CurrencyRef: { value: 'CAD' } } }))];
  const h = fixture(t, null, records);
  assert.equal((await h.admit({ inTransaction: () => true })).kind, 'general-write');
  assert.equal(h.counters().writes, 1);
});
test('transactional daily counts enumerate >101 runs, plans, receipts and general runs without getMore', async () => {
  const { createBusinessAgentStore } = require('../src/modules/business-agent-store');
  const source = {
    Runs: Array.from({ length: 120 }, (_, i) => ({ _id: 'fixed-' + i, planId: 'plan-' + i, status: 'blocked', recordCount: 2, createdAt: new Date(now()), activityBatch: {} })),
    Plans: Array.from({ length: 120 }, (_, i) => ({ _id: 'plan-' + i, manifest: { createCount: 2 } })),
    Receipts: Array.from({ length: 143 }, (_, i) => ({ operationId: 'fixed-' + (i % 120), entity: 'Invoice', logicalKey: 'receipt-' + i })),
    GeneralWriteRuns: Array.from({ length: 120 }, (_, i) => ({ _id: 'general-' + i, status: 'complete', createdAt: new Date(now()), plan: { operations: [] }, items: {}, batches: [] })),
  };
  const calls = [], session = { inTransaction: () => true };
  const models = Object.fromEntries(Object.entries(source).map(([name, rows]) => [name, { find(filter, projection, options) { calls.push({ name, filter, options }); return query(() => { if (rows.length > (options?.batchSize || 101)) throw new MongoServerError({ code: 2, message: 'cannot set maxTimeMS on getMore command for a non-awaitData cursor' }); return rows; }); } }]));
  const store = createBusinessAgentStore({ models, connection: {}, transaction: work => work(session), now });
  const facts = await store.todayActivity(scope, 'c'.repeat(24), '2026-10-31', { fresh: true, session });
  assert.equal(facts.runs.length, 240); assert.equal(facts.receipts.length, 143); assert.equal(facts.runs[0].createCount, 2);
  assert.deepEqual(calls.map(c => [c.name, c.options.batchSize]), [['Runs', 200], ['Plans', 200], ['Receipts', 5000], ['GeneralWriteRuns', 5001]]);
});

test('MongoDB cause retains driver file and line when its short stack has no backend frame', async t => {
  const failure = new MongoServerError({ code: 2, message: 'cannot set maxTimeMS on getMore command for a non-awaitData cursor' });
  failure.stack = 'MongoServerError: ' + failure.message + '\n    at Connection.sendCommand (C:\\Projects\\qbo\\node_modules\\mongodb\\lib\\cmap\\connection.js:306:27)';
  const h = fixture(t, failure);
  await assert.rejects(h.admit({ inTransaction: () => true }), error => { const cause = failureFields(null, error).errorDetail.detail.cause; assert.equal(cause.code, 2); assert.equal(cause.location.line, 306); assert.match(cause.location.file, /node_modules\/mongodb\/lib\/cmap\/connection.js$/); assert.ok(cause.stackTrace[1].includes(':306:27')); return true; });
});
