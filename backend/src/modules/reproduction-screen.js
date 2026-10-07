'use strict';

const { randomUUID, createHash } = require('crypto');
const { owns } = require('./reproduction-policy');
const fail = (message) => Object.assign(new Error(message), { status: 409 });
const origins = { production: 'https://qbo.intuit.com', sandbox: 'https://app.sandbox.qbo.intuit.com' };
const digest = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex');
const keyFor = (scope) => [scope.userId, scope.actorId, scope.caseId].map(String).join(':');

// In-memory, single-use rendezvous. No cookies, QBO tokens or app credentials
// cross the companion boundary. A restart invalidates every pending request.
function createScreenBroker({ now = Date.now, ttlMs = 45000 } = {}) {
  const clients = new Map();
  const pending = new Map();
  function heartbeat(scope, ready) {
    for (const [key, expiry] of clients) if (expiry < now()) clients.delete(key);
    const key = keyFor(scope);
    if (ready === true) clients.set(key, now() + 20000);
    else clients.delete(key);
  }
  async function poll(scope) {
    const entry = pending.get(keyFor(scope));
    if (!entry) return null;
    await entry.assertActive();
    if (now() >= entry.request.expiresAt) return null;
    return entry.request;
  }
  async function capability(nonce, redeem) {
    if (typeof nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(nonce)) throw fail('Screen capability unavailable.');
    const entry = [...pending.values()].find((value) => value.request.nonce === nonce);
    if (!entry || entry.received || now() >= entry.request.expiresAt || (redeem && entry.redeemed) || (!redeem && !entry.redeemed)) throw fail('Screen capability unavailable.');
    if (redeem) entry.redeemed = true;
    await entry.assertActive();
    if (![...pending.values()].includes(entry) || now() >= entry.request.expiresAt) throw fail('Screen capability unavailable.');
    return entry.request;
  }
  async function receive(scope, body) {
    const entry = pending.get(keyFor(scope));
    if (!entry || body?.nonce !== entry.request.nonce || entry.received || now() >= entry.request.expiresAt) throw fail('This screen request expired or was already used.');
    // Reserve before awaiting authority checks: duplicate tabs cannot race receipts.
    entry.received = true;
    try {
      await entry.assertActive();
      if (pending.get(keyFor(scope)) !== entry || now() >= entry.request.expiresAt) throw fail('This screen request is no longer active.');
      if (!body?.error && !entry.redeemed) throw fail('The companion did not redeem this request.');
      // A redeemed response proves the companion is still connected even when
      // QBO was not ready. Keep a bounded recovery from mistaking that for a
      // disconnected browser; unredeemed error receipts never renew readiness.
      if (entry.redeemed) clients.set(keyFor(scope), now() + 20000);
      const evidence = validateEvidence(entry.request, body);
      entry.resolve(evidence);
    } catch (err) { entry.reject(err); throw err; }
  }
  async function request(scope, target, assertActive) {
    const key = keyFor(scope);
    await assertActive();
    if ((clients.get(key) || 0) <= now()) throw fail('Screen reader is not connected. Keep this case page open and check the Chrome companion connection.');
    if (pending.has(key)) throw fail('A screen check is already in progress.');
    const request = { ...target, caseId: String(scope.caseId), runId: scope.runId, revision: scope.revision,
      realmId: String(scope.realmId), environment: scope.environment, nonce: randomUUID(), requestedAt: now(), expiresAt: now() + ttlMs };
    let timer;
    let cancelled = false;
    try {
      return await new Promise((resolve, reject) => {
        const entry = { request, assertActive, resolve, reject, received: false };
        pending.set(key, entry);
        const tick = async () => {
          try {
            if (now() >= request.expiresAt) throw fail('The screen reader did not return evidence in time.');
            await assertActive();
            if (!cancelled) timer = setTimeout(tick, 1000);
          } catch (err) { reject(err); }
        };
        timer = setTimeout(tick, Math.min(1000, ttlMs));
      });
    } finally { cancelled = true; clearTimeout(timer); pending.delete(key); }
  }
  return { heartbeat, poll, receive, request, capability };
}

function validateEvidence(request, body) {
  if (body?.error) throw fail(String(body.error).slice(0, 300));
  const e = body?.evidence;
  if (!e || JSON.stringify(e).length > 24000) throw fail('Screen evidence was missing or too large.');
  const url = new URL(e.url);
  if (url.origin !== origins[request.environment] || url.pathname !== '/app/purchaseorder'
      || url.searchParams.get('txnId') !== request.id || url.hash || url.username || url.password) throw fail('The browser was on a different record or site.');
  if (e.realmId !== request.realmId || e.docNumber !== request.docNumber || e.entityType !== 'PurchaseOrder'
      || e.id !== request.id || e.field !== request.field || e.readerVersion !== 1) throw fail('Company or purchase order identity did not match.');
  if (!Number.isFinite(e.capturedAt) || e.capturedAt < request.requestedAt || e.capturedAt > request.expiresAt) throw fail('Screen evidence was not captured during this request.');
  if (!Array.isArray(e.rows) || e.rows.length !== request.lines.length || !e.rows.length) throw fail('Not all purchase order rows were visible.');
  const expected = request.lines.map((l) => ({ ...l }));
  for (const row of e.rows) {
    const labels = request.field === 'receivedQuantity' ? ['received'] : ['billed', 'billed quantity', 'billed qty', 'qty billed'];
    if (typeof row.label !== 'string' || !labels.includes(row.label.toLowerCase())
        || !Number.isFinite(row.value) || row.value < 0 || typeof row.text !== 'string'
        || !/^\d+(?:\.\d+)?$/.test(row.text.trim()) || Number(row.text) !== row.value) throw fail('The requested labelled numeric quantity was not observed.');
    const index = expected.findIndex((l) => l.item === row.item && l.quantity === row.quantity && l.description === row.description);
    if (index < 0) throw fail('Visible line items did not match the saved purchase order.');
    expected.splice(index, 1);
  }
  return { kind: 'observed_screen', readerVersion: 1, entityType: 'PurchaseOrder', id: request.id,
    docNumber: request.docNumber, realmId: request.realmId, environment: request.environment,
    field: request.field, url: url.href, capturedAt: e.capturedAt,
    rows: e.rows.map(({ item, description, quantity, label, text, value }) => ({ item, description, quantity, label, text, value })),
    actual: e.rows.reduce((sum, row) => sum + row.value, 0),
    runId: request.runId, revision: request.revision };
}

function makeScreenInspector({ broker, scope, state, qbo, assertActive }) {
  const inspect = async ({ id, field = 'billedQuantity' }) => {
    if (!['billedQuantity', 'receivedQuantity'].includes(field)) throw fail('Unsupported screen field.');
    if (!/^\d+$/.test(String(id)) || !owns(state.ownedRecords, 'PurchaseOrder', id)) throw fail('Only purchase orders created by this case can be inspected.');
    await assertActive();
    const before = (await qbo.read('purchaseorder', id)).PurchaseOrder;
    if (!before || !before.DocNumber) throw fail('The saved purchase order could not be identified.');
    const lines = (before.Line || []).map((line) => ({ id: line.Id, item: line.ItemBasedExpenseLineDetail?.ItemRef?.name,
      quantity: line.ItemBasedExpenseLineDetail?.Qty, description: line.Description || '' }));
    if (!lines.length || lines.length > 100 || lines.some((l) => !l.id || !l.item || !Number.isFinite(l.quantity))) throw fail('This reader currently requires purchase orders with item quantity lines.');
    const revision = state.revision;
    const evidence = await broker.request({ ...scope, revision }, { entityType: 'PurchaseOrder', id: String(id),
      docNumber: String(before.DocNumber), field, lines }, assertActive);
    await assertActive();
    const after = (await qbo.read('purchaseorder', id)).PurchaseOrder;
    if (state.revision !== revision || digest(before) !== digest(after)) throw fail('The purchase order changed during the screen check. Check it again.');
    return evidence;
  };
  const readinessFailures = new Set([
    'The visible purchase order number could not be verified.',
    'The QuickBooks Company ID dialog could not be read. Company identity remains unverified.',
    'QuickBooks did not finish loading before the screen check expired.',
    'QuickBooks is still loading.',
    'The purchase order was not ready.',
  ]);
  return async (target) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try { return { ...await inspect(target), captureAttempts: attempt }; }
      catch (err) {
        if (attempt === 2 || !readinessFailures.has(err.message)) throw err;
        // One new scoped capability, fresh API reads and all authority checks.
        // No retry for wrong company, manual edits, unsupported labels or Stop.
        await assertActive();
      }
    }
  };
}
const screenBroker = createScreenBroker();
module.exports = { createScreenBroker, validateEvidence, makeScreenInspector, screenBroker };
