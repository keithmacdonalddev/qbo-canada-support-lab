'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreenBroker, validateEvidence, makeScreenInspector } = require('../src/modules/reproduction-screen');
const scope = { userId: 'owner', actorId: 'actor', caseId: 'case', runId: 'run', realmId: '123456', environment: 'production', revision: 4 };
const target = { entityType: 'PurchaseOrder', id: '608', docNumber: 'REPRO-T7', field: 'billedQuantity', lines: [{ id: '1', item: 'Hours', quantity: 6, description: 'Test hours' }] };
const request = { ...scope, ...target, nonce: 'nonce', requestedAt: 1000, expiresAt: 2000 };
const response = () => ({ nonce: 'nonce', evidence: { entityType: 'PurchaseOrder', id: '608', docNumber: 'REPRO-T7', field: 'billedQuantity', realmId: '123456', readerVersion: 1,
  url: 'https://qbo.intuit.com/app/purchaseorder?txnId=608', capturedAt: 1500,
  rows: [{ item: 'Hours', description: 'Test hours', quantity: 6, label: 'Billed', text: '5', value: 5 }] } });
const turn = () => new Promise(setImmediate);

test('labelled screen observation preserves five billed, independently of API Received', () => {
  const result = validateEvidence(request, response());
  assert.equal(result.kind, 'observed_screen'); assert.equal(result.actual, 5); assert.equal(result.revision, 4);
  assert.equal(result.rows[0].quantity, 6);
});
test('rejects different company, record, site, environment, stale capture and derived field', () => {
  for (const change of [{ realmId: '999999' }, { id: '609' }, { docNumber: 'OTHER' }, { url: 'https://evil.example/app/purchaseorder?txnId=608' },
    { url: 'https://app.sandbox.qbo.intuit.com/app/purchaseorder?txnId=608' }, { capturedAt: 999 }, { capturedAt: 2001 }, { field: 'Received' }]) {
    const body = response(); Object.assign(body.evidence, change);
    assert.throws(() => validateEvidence(request, body));
  }
});
test('rejects missing, fabricated, mismatched and duplicate quantity rows', () => {
  for (const rows of [[], [{ ...response().evidence.rows[0], label: 'Received' }], [{ ...response().evidence.rows[0], quantity: 5 }],
    [{ ...response().evidence.rows[0], text: '' }], [{ ...response().evidence.rows[0], value: 3.5 }],
    [response().evidence.rows[0], response().evidence.rows[0]]]) {
    const body = response(); body.evidence.rows = rows;
    assert.throws(() => validateEvidence(request, body));
  }
});
test('broker binds actor, owner and case, consumes once, and removes pending request', async () => {
  const broker = createScreenBroker({ now: () => 1500 });
  broker.heartbeat(scope, true);
  const result = broker.request(scope, target, async () => {});
  await turn();
  for (const other of [{ actorId: 'other' }, { userId: 'other' }, { caseId: 'other' }]) {
    assert.equal(await broker.poll({ ...scope, ...other }), null);
    await assert.rejects(broker.receive({ ...scope, ...other }, response()));
  }
  const pending = await broker.poll(scope);
  assert.deepEqual(await broker.capability(pending.nonce, true), pending);
  await assert.rejects(broker.capability(pending.nonce, true), /unavailable/);
  const body = response(); body.nonce = pending.nonce;
  await broker.receive(scope, body);
  assert.equal((await result).actual, 5);
  await assert.rejects(broker.receive(scope, body));
  assert.equal(await broker.poll(scope), null);
});
test('disconnected, expired and stopped requests cannot leave usable evidence', async () => {
  const broker = createScreenBroker({ ttlMs: 10 });
  await assert.rejects(broker.request(scope, target, async () => {}), /not connected/);
  broker.heartbeat(scope, true);
  await assert.rejects(broker.request(scope, target, async () => {}), /in time/);
  assert.equal(await broker.poll(scope), null);
  let stopped = false;
  const task = broker.request(scope, target, async () => { if (stopped) throw new Error('Stopped'); });
  const rejected = assert.rejects(task, /Stopped/);
  await turn();
  const pending = await broker.poll(scope);
  stopped = true;
  await assert.rejects(broker.receive(scope, { ...response(), nonce: pending.nonce }), /Stopped/);
  await rejected;
});
test('authority revocation during receipt validation fails closed', async () => {
  const broker = createScreenBroker({ now: () => 1500 });
  let active = true;
  broker.heartbeat(scope, true);
  const task = broker.request(scope, target, async () => { if (!active) throw new Error('Role revoked'); });
  const rejected = assert.rejects(task, /Role revoked/);
  await turn(); const pending = await broker.poll(scope); active = false;
  await assert.rejects(broker.receive(scope, { ...response(), nonce: pending.nonce }), /Role revoked/);
  await rejected;
});
test('inspector refuses pre-existing PO and changes occurring during capture', async () => {
  const state = { ownedRecords: [{ entityType: 'PurchaseOrder', id: '608' }], revision: 4 };
  const record = { Id: '608', DocNumber: 'REPRO-T7', SyncToken: '0', Line: [{ Id: '1', Description: 'Test hours', ItemBasedExpenseLineDetail: { ItemRef: { name: 'Hours' }, Qty: 6 } }] };
  let reads = 0;
  const inspector = makeScreenInspector({ scope, state, assertActive: async () => {},
    qbo: { read: async () => ({ PurchaseOrder: { ...record, SyncToken: String(reads++) } }) },
    broker: { request: async () => validateEvidence(request, response()) } });
  await assert.rejects(inspector({ id: '609' }), /created by this case/); assert.equal(reads, 0);
  await assert.rejects(inspector({ id: '608' }), /changed during/);
});

test('unissued capabilities and unredeemed evidence cannot authorize capture', async () => {
  const broker = createScreenBroker({ now: () => 1500 });
  await assert.rejects(broker.capability('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true));
  broker.heartbeat(scope, true);
  const task = broker.request(scope, target, async () => {});
  const rejected = assert.rejects(task, /did not redeem/);
  await turn(); const pending = await broker.poll(scope);
  await assert.rejects(broker.receive(scope, { ...response(), nonce: pending.nonce }), /did not redeem/);
  await rejected;
});
test('a slow successful capture renews readiness for the next screen check', async () => {
  let clock = 1500;
  const broker = createScreenBroker({ now: () => clock });
  broker.heartbeat(scope, true);
  const first = broker.request(scope, target, async () => {});
  await turn(); const pending = await broker.poll(scope); await broker.capability(pending.nonce, true);
  clock += 25000;
  const body = response(); body.nonce = pending.nonce; body.evidence.capturedAt = clock;
  await broker.receive(scope, body); await first;
  const second = broker.request(scope, target, async () => {});
  const rejected = assert.rejects(second, /Reader not available/);
  await turn(); const next = await broker.poll(scope);
  assert.ok(next); await assert.rejects(broker.receive(scope, { nonce: next.nonce, error: 'Reader not available' }));
  await rejected;
});

test('HTTP capability route grants only issued extension capabilities and rejects replay', async () => {
  const http = require('node:http');
  const { createApp } = require('../src/app');
  const { screenBroker } = require('../src/modules/reproduction-screen');
  const server = http.createServer(createApp({ databaseReady: () => false }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/screen-reader/capability';
  const post = (nonce, origin = 'chrome-extension://' + 'a'.repeat(32), stage = 'redeem') => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ nonce, stage }) });
  let task;
  try {
    assert.equal((await post('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).status, 404);
    screenBroker.heartbeat(scope, true);
    task = screenBroker.request(scope, target, async () => {});
    await turn(); const pending = await screenBroker.poll(scope);
    assert.equal((await post(pending.nonce, 'https://evil.example')).status, 404);
    const receipt = await post(pending.nonce);
    assert.equal(receipt.status, 200); assert.equal(receipt.headers.get('cache-control'), 'no-store');
    assert.equal((await receipt.json()).request.id, '608');
    assert.equal((await post(pending.nonce)).status, 404);
    assert.equal((await post(pending.nonce, 'chrome-extension://' + 'a'.repeat(32), 'validate')).status, 200);
    const body = response(); body.nonce = pending.nonce; body.evidence.capturedAt = Date.now();
    await screenBroker.receive(scope, body); assert.equal((await task).actual, 5); task = null;
  } finally {
    if (task) {
      const pending = await screenBroker.poll(scope);
      const rejected = task.catch(() => {});
      if (pending) await screenBroker.receive(scope, { nonce: pending.nonce, error: 'Test cleanup' }).catch(() => {});
      await rejected;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Received screen observations are distinct from Billed and cannot satisfy a Billed request', () => {
  const received = response(); received.evidence.field = 'receivedQuantity';
  received.evidence.rows[0].label = 'RECEIVED'; received.evidence.rows[0].value = 3.5; received.evidence.rows[0].text = '3.5';
  const evidence = validateEvidence({ ...request, field: 'receivedQuantity' }, received);
  assert.equal(evidence.field, 'receivedQuantity'); assert.equal(evidence.actual, 3.5);
  assert.throws(() => validateEvidence(request, received), /identity did not match/);
  const mislabeled = response(); mislabeled.evidence.rows[0].label = 'RECEIVED';
  assert.throws(() => validateEvidence(request, mislabeled), /requested labelled/);
});

test('Billed-labelled response cannot satisfy a Received request', () => {
  const body = response(); body.evidence.field = 'receivedQuantity';
  assert.throws(() => validateEvidence({ ...request, field: 'receivedQuantity' }, body), /requested labelled/);
});


test('a redeemed readiness failure keeps the companion connected for bounded recovery', async () => {
  for (const redeemed of [true, false]) {
    let clock = 1500;
    const broker = createScreenBroker({ now: () => clock });
    broker.heartbeat(scope, true);
    const first = broker.request(scope, target, async () => {});
    const rejected = assert.rejects(first, /not ready/);
    await turn(); const pending = await broker.poll(scope);
    if (redeemed) await broker.capability(pending.nonce, true);
    clock += 25000;
    await assert.rejects(broker.receive(scope, { nonce: pending.nonce, error: 'not ready' }), /not ready/);
    await rejected;
    const next = broker.request(scope, target, async () => {});
    if (!redeemed) { await assert.rejects(next, /not connected/); continue; }
    const done = assert.rejects(next, /cleanup/);
    await turn(); const retry = await broker.poll(scope);
    assert.notEqual(retry.nonce, pending.nonce);
    await assert.rejects(broker.receive(scope, { nonce: retry.nonce, error: 'cleanup' }));
    await done;
  }
});

test('inspector retries readiness once with fresh reads and never retries scope or layout failures', async () => {
  const record = { Id: '608', DocNumber: 'REPRO-T7', Line: [{ Id: '1', Description: 'Test hours', ItemBasedExpenseLineDetail: { ItemRef: { name: 'Hours' }, Qty: 6 } }] };
  const state = { ownedRecords: [{ entityType: 'PurchaseOrder', id: '608' }], revision: 4 };
  const transient = 'The visible purchase order number could not be verified.';
  for (const error of [transient, 'The reader tab is in a different QuickBooks company.', 'A complete, unambiguous requested quantity column was not visible.', 'Stopped']) {
    let requests = 0; let reads = 0;
    const inspector = makeScreenInspector({ scope, state, assertActive: async () => {},
      qbo: { read: async () => { reads++; return { PurchaseOrder: record }; } },
      broker: { request: async () => { if (++requests === 1) throw new Error(error); return validateEvidence(request, response()); } } });
    if (error === transient) {
      const result = await inspector({ id: '608' });
      assert.equal(result.actual, 5); assert.equal(result.captureAttempts, 2); assert.equal(reads, 3);
    } else { await assert.rejects(inspector({ id: '608' }), { message: error }); assert.equal(requests, 1); }
  }
  let requests = 0;
  const bounded = makeScreenInspector({ scope, state, assertActive: async () => {},
    qbo: { read: async () => ({ PurchaseOrder: record }) },
    broker: { request: async () => { requests++; throw new Error(transient); } } });
  await assert.rejects(bounded({ id: '608' }), { message: transient }); assert.equal(requests, 2);
  let stopped = false; requests = 0;
  const cancelled = makeScreenInspector({ scope, state, assertActive: async () => { if (stopped) throw new Error('Stopped'); },
    qbo: { read: async () => ({ PurchaseOrder: record }) },
    broker: { request: async () => { requests++; stopped = true; throw new Error(transient); } } });
  await assert.rejects(cancelled({ id: '608' }), /Stopped/); assert.equal(requests, 1);
});
