'use strict';
process.env.QBO_ENVIRONMENT = 'production'; // The fixture intercepts every SDK request.
const test = require('node:test'), assert = require('node:assert/strict');
const { BSON, MongoClient } = require('mongodb');
const { harness, clone, scope } = require('./helpers/master-transport-fixture');
const { hash } = require('../src/modules/business-calendar');
const { assertMasterRecordSet } = require('../src/modules/business-master-record-evidence');
const Receipts = require('../src/models/QboWriteReceipt'), Audits = require('../src/models/AuditLog');
async function completeHistory() {
  const h = harness(); await h.send();
  const original = h.data.Receipts[0], start = h.data.Audits.find(row => row.action === 'QuickBooks write dispatch recorded'), end = h.data.Audits.find(row => row.action === 'QuickBooks write response recorded');
  const rows = [], receipts = [], audits = [];
  for (let ordinal = 0; ordinal < 100; ordinal++) {
    const row = clone(h.run().records[0]), attempt = row.attempts[0], receipt = clone(original);
    row.ordinal = ordinal; row.state = attempt.state = 'verified'; row.qboId = attempt.qboId = String(1000 + ordinal);
    attempt.dispatchKey = hash({ version: 1, masterRunId: String(h.run()._id), ordinal, attempt: 1 });
    attempt.requestHash = hash({ fixtureRequest: ordinal });
    Object.assign(receipt, { dispatchKey: attempt.dispatchKey, requestHash: attempt.requestHash });
    receipt.workflow.ordinal = ordinal; receipt._id = attempt.receiptId = hash({ scope, dispatchKey: attempt.dispatchKey });
    receipt.observed.qboId = row.qboId; attempt.outcome = clone(receipt.observed);
    receipt.startAuditId = hash({ receiptId: receipt._id, event: 'started' }).slice(0, 24);
    receipt.resultAuditId = hash({ receiptId: receipt._id, event: 'response', observed: receipt.observed }).slice(0, 24);
    const params = { environment: scope.environment, connectionId: scope.connectionId, dispatchKey: receipt.dispatchKey, requestHash: receipt.requestHash, entity: receipt.entity, operation: 'create' };
    audits.push({ ...clone(start), _id: receipt.startAuditId, inputParams: params, afterState: { state: 'possibly-sent', receiptId: receipt._id } }, { ...clone(end), _id: receipt.resultAuditId, inputParams: params, afterState: { state: 'saved', receiptId: receipt._id, ...receipt.observed } });
    rows.push(row); receipts.push(receipt);
  }
  return { run: h.run(), rows, receipts, audits };
}
function mongooseQueries(t, history, failure) {
  const client = new MongoClient('mongodb://127.0.0.1:1', { serverSelectionTimeoutMS: 10 }), session = client.startSession(), calls = [];
  // A real disconnected driver session survives Mongoose option cloning. No socket is opened.
  t.after(async () => { await session.endSession(); await client.close(); });
  for (const [Model, name, records] of [[Receipts, 'receipts', history.receipts], [Audits, 'audits', history.audits]]) t.mock.method(Model.collection, 'find', (filter, options) => {
    calls.push({ name, filter, options });
    assert.equal(options.session, session); assert.equal(options.maxTimeMS, 3000);
    assert.equal(options.limit, options.batchSize);
    assert.equal(options.batchSize, name === 'receipts' ? 1001 : 201);
    return { toArray: async () => { if (failure) throw failure; return clone(records.slice(0, options.limit)); } };
  });
  return { session, calls, models: { Receipts, Audits } };
}
test('real Mongoose sends bounded complete first batches for 100 records and all 200 audits', async t => {
  const h = await completeHistory(), q = mongooseQueries(t, h);
  await assertMasterRecordSet(q.models, scope, h.run, h.rows, q.session);
  assert.deepEqual(q.calls.map(row => row.name), ['receipts', 'audits']);
  assert.ok(BSON.calculateObjectSize({ receipts: h.receipts, audits: h.audits }) < 16000000);
});
for (const missing of [false, true]) test((missing ? 'missing' : 'changed') + ' audit beyond the old 101-document boundary refuses the full set', async t => {
  const h = await completeHistory();
  if (missing) h.audits.pop(); else h.audits[199].afterState.responseHash = hash('changed late audit');
  const q = mongooseQueries(t, h);
  await assert.rejects(assertMasterRecordSet(q.models, scope, h.run, h.rows, q.session), /audit is missing or changed/);
});
test('a duplicate workflow receipt beyond document 100 is still rejected', async t => {
  const h = await completeHistory(); h.receipts.push({ ...clone(h.receipts[99]), _id: hash('duplicate mandatory receipt') });
  const q = mongooseQueries(t, h);
  await assert.rejects(assertMasterRecordSet(q.models, scope, h.run, h.rows, q.session), /multiple or missing mandatory receipts/);
});
test('1001 same-run receipts still exceed the retained attempt budget', async t => {
  const h = await completeHistory(); while (h.receipts.length < 1001) h.receipts.push({ ...clone(h.receipts[0]), _id: hash({ extra: h.receipts.length }) });
  const q = mongooseQueries(t, h);
  await assert.rejects(assertMasterRecordSet(q.models, scope, h.run, h.rows, q.session), /approved attempt budget/);
});
test('cursor continuation failure is propagated without accepting a partial evidence set', async t => {
  const h = await completeHistory(), error = Object.assign(new Error('fixture getMore refusal'), { code: 2 }), q = mongooseQueries(t, h, error);
  await assert.rejects(assertMasterRecordSet(q.models, scope, h.run, h.rows, q.session), value => value === error);
  assert.equal(q.calls.length, 1);
});
