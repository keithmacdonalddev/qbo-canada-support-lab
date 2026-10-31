'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createQboRequestMeter, runWithCategory, categorize } = require('../src/modules/qbo-request-meter');
const scope = { environment: 'production', realmId: '123456789', connectionId: 'd'.repeat(24) };
function fakeModel() {
  const h = { rows: new Map(), updates: [], fail: false, indexes: 0 };
  h.Model = {
    createIndexes: async () => { h.indexes++; },
    updateOne: async (filter, update, options) => {
      if (h.fail) throw new Error('storage unavailable');
      assert.equal(options.upsert, true); h.updates.push({ filter, update });
      const row = h.rows.get(filter._id) || { ...filter, attempts: {}, succeeded: {} };
      for (const [path, value] of Object.entries(update.$inc)) { const [kind, category] = path.split('.'); row[kind][category] = (row[kind][category] || 0) + value; }
      h.rows.set(filter._id, row); return { matchedCount: 1 };
    },
    find: query => ({ select() { return this; }, maxTimeMS() { return this; }, lean: async () => [...h.rows.values()].filter(row => row.realmId === query.realmId && row.day >= query.day.$gte && row.day <= query.day.$lte) }),
  };
  return h;
}
test('requests are categorized by method, endpoint and synchronization context', async () => {
  assert.equal(categorize('POST', 'invoice'), 'write');
  assert.equal(categorize('GET', 'reports/ProfitAndLoss?x=1'), 'report');
  assert.equal(categorize('GET', 'query?query=SELECT'), 'query');
  assert.equal(categorize('GET', 'invoice/12'), 'read');
  assert.equal(await runWithCategory('sync', async () => { await null; return categorize('GET', 'query?query=SELECT'); }), 'sync');
  assert.equal(await runWithCategory('sync', async () => categorize('POST', 'invoice')), 'write', 'writes are never hidden as sync');
});
test('counts batch in memory, flush as $inc per company-day and include unflushed counts in the summary', async () => {
  const h = fakeModel(); let clock = Date.parse('2026-10-30T12:00:00Z');
  const meter = createQboRequestMeter({ Model: h.Model, now: () => clock, flushMs: 0, connected: () => true });
  meter.record(scope, 'sync'); meter.record(scope, 'sync'); meter.record(scope, 'sync', 'succeeded'); meter.record(scope, 'write'); meter.record(scope, 'report');
  meter.record({ ...scope, connectionId: 'not-an-id' }, 'sync'); meter.record(scope, 'unknown');
  assert.equal(h.updates.length, 0, 'recording never touches storage');
  await meter.flush();
  assert.equal(h.updates.length, 1); assert.deepEqual(h.updates[0].update.$inc, { 'attempts.sync': 2, 'attempts.report': 1, 'attempts.write': 1, 'succeeded.sync': 1 });
  assert.equal(h.updates[0].filter.day, '2026-10-30'); assert.equal(meter.pendingSize(), 0);
  clock = Date.parse('2026-10-31T09:00:00Z'); meter.record(scope, 'query');
  const view = await meter.summary(scope);
  assert.equal(view.today.total, 1, 'today includes the unflushed count'); assert.equal(view.today.attempts.query, 1);
  assert.equal(view.month.total, 5); assert.equal(view.month.attempts.sync, 2); assert.equal(view.month.succeeded.sync, 1); assert.equal(view.persisted, true);
  meter.close();
});
test('a failed flush keeps the counts for the next flush, and a disconnected store is never queried', async () => {
  const h = fakeModel(); let up = true;
  const meter = createQboRequestMeter({ Model: h.Model, now: () => Date.parse('2026-10-30T12:00:00Z'), flushMs: 0, connected: () => up });
  meter.record(scope, 'read'); h.fail = true; await meter.flush(); assert.equal(meter.pendingSize(), 1);
  h.fail = false; meter.record(scope, 'read'); await meter.flush(); assert.equal([...h.rows.values()][0].attempts.read, 2);
  up = false; meter.record(scope, 'write');
  const view = await meter.summary(scope); assert.equal(view.persisted, false); assert.equal(view.today.attempts.write, 1);
  meter.close();
});
test('the QuickBooks client meters each transport attempt and its success from the single transport path', async () => {
  const config = require('../src/config'); const previous = config.qbo.environment; config.qbo.environment = 'production';
  const { QBOClient } = require('../src/modules/qbo-client');
  const recorded = [];
  const client = Object.create(QBOClient.prototype);
  Object.defineProperty(client, 'apiBase', { value: 'https://quickbooks.api.intuit.com/v3/company/' + scope.realmId });
  Object.assign(client, { requestMeter: { record: (value, category, kind) => recorded.push([value.connectionId, category, kind]) }, connection: { _id: scope.connectionId, realmId: scope.realmId, userId: 'a'.repeat(24), status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {},
    oauthClient: { makeApiCall: async options => options.url.includes('reports/') ? { status: 400, json: {} } : { status: 200, json: { QueryResponse: {} }, headers: {} } } });
  try {
    await client.query('SELECT * FROM Customer');
    await runWithCategory('sync', () => client.apiCall('GET', 'cdc?entities=Invoice'));
    await client.apiCall('GET', 'reports/ProfitAndLoss').catch(() => {});
  } finally { config.qbo.environment = previous; }
  assert.deepEqual(recorded, [[scope.connectionId, 'query', 'attempts'], [scope.connectionId, 'query', 'succeeded'], [scope.connectionId, 'sync', 'attempts'], [scope.connectionId, 'sync', 'succeeded'], [scope.connectionId, 'report', 'attempts']]);
});
test('a 2xx response is counted even when the caller cancelled the read meanwhile', async () => {
  const config = require('../src/config'); const previous = config.qbo.environment; config.qbo.environment = 'production';
  const { QBOClient } = require('../src/modules/qbo-client');
  const recorded = [], controller = new AbortController();
  const client = Object.create(QBOClient.prototype);
  Object.defineProperty(client, 'apiBase', { value: 'https://quickbooks.api.intuit.com/v3/company/' + scope.realmId });
  Object.assign(client, { requestMeter: { record: (value, category, kind) => recorded.push([category, kind]) }, connection: { _id: scope.connectionId, realmId: scope.realmId, userId: 'a'.repeat(24), status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {},
    oauthClient: { makeApiCall: async () => { controller.abort(); return { status: 200, json: { QueryResponse: {} }, headers: {} }; } } });
  let failure;
  try { await client.query('SELECT * FROM Customer', { signal: controller.signal, beforeAttempt: async () => {}, onFailure: () => {} }).catch(error => { failure = error; }); }
  finally { config.qbo.environment = previous; }
  assert.equal(failure?.code, 'QBO_READ_CANCELLED', 'cancellation behaviour is unchanged');
  assert.deepEqual(recorded, [['query', 'attempts'], ['query', 'succeeded']]);
});
test('summaries never dip while a flush is writing, whether they wait for it or not', async () => {
  for (const summaryWaitMs of [5000, 5]) {
    const h = fakeModel(); let release; const gate = new Promise(resolve => { release = resolve; });
    const write = h.Model.updateOne; h.Model.updateOne = async (...args) => { await gate; return write(...args); };
    const meter = createQboRequestMeter({ Model: h.Model, now: () => Date.parse('2026-10-30T12:00:00Z'), flushMs: 0, summaryWaitMs, connected: () => true });
    meter.record(scope, 'sync');
    assert.equal((await meter.summary(scope)).today.total, 1);
    const flushing = meter.flush();
    const during = meter.summary(scope);
    if (summaryWaitMs > 1000) setImmediate(release);
    assert.equal((await during).today.total, 1, 'the in-flight batch is still counted');
    release(); await flushing;
    assert.equal((await meter.summary(scope)).today.total, 1, 'and counted once after it is persisted');
    meter.close();
  }
});
