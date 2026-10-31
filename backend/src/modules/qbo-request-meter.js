'use strict';
// Counts QuickBooks API transport attempts per company per UTC day, by category.
// Best-effort and cheap: the transport records into memory; a timer flushes batched $inc updates.
// Metering can never delay, fail or alter a QuickBooks request.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const CATEGORIES = Object.freeze(['sync', 'report', 'query', 'read', 'write']);
const context = new AsyncLocalStorage();
const MAX_PENDING = 500;
const dayOf = clock => new Date(clock).toISOString().slice(0, 10);
const scopeKey = scope => [scope.environment, scope.realmId, scope.connectionId].join(':');
const zero = () => Object.fromEntries(CATEGORIES.map(key => [key, 0]));
function validScope(scope) {
  return scope && ['production', 'sandbox'].includes(scope.environment) && /^[0-9A-Za-z]{1,40}$/.test(String(scope.realmId || '')) && /^[0-9a-f]{24}$/.test(String(scope.connectionId || ''));
}
// Work run inside this wrapper (and anything it awaits) is classified as background synchronization.
function runWithCategory(category, fn) { return context.run({ category }, fn); }
function categorize(method, endpoint) {
  if (String(method).toUpperCase() !== 'GET') return 'write';
  if (context.getStore()?.category === 'sync') return 'sync';
  const path = String(endpoint || '');
  if (path.startsWith('reports/')) return 'report';
  if (path.startsWith('query?')) return 'query';
  return 'read';
}
function createQboRequestMeter({ Model = null, now = () => Date.now(), flushMs = 15000, summaryWaitMs = 2000, connected = () => require('mongoose').connection.readyState === 1 } = {}) {
  // pending: not yet sent. inflight: being written now; summaries keep counting it until it is persisted or restored.
  const pending = new Map(), inflight = new Map();
  let timer = null, flushing = null, indexed = null, reading = 0;
  const model = () => Model || (Model = require('../models/QboRequestDay'));
  function schedule() {
    if (timer || !flushMs) return;
    timer = setTimeout(() => { timer = null; void flush(); }, flushMs); timer.unref?.();
  }
  function record(scope, category, kind = 'attempts') {
    try {
      if (!validScope(scope) || !CATEGORIES.includes(category) || !['attempts', 'succeeded'].includes(kind)) return;
      const clean = { environment: scope.environment, realmId: String(scope.realmId), connectionId: String(scope.connectionId) };
      const day = dayOf(now()), key = scopeKey(clean) + ':' + day;
      let entry = pending.get(key);
      if (!entry) { if (pending.size >= MAX_PENDING) return; entry = { scope: clean, day, attempts: zero(), succeeded: zero() }; pending.set(key, entry); }
      entry[kind][category]++;
      schedule();
    } catch { /* Metering never affects the request. */ }
  }
  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      // A flush never starts while a summary is reading, so a summary cannot miss counts moving between maps.
      if (!pending.size || !connected() || reading) { if (pending.size) schedule(); return; }
      const Day = model();
      if (!indexed) indexed = Day.createIndexes().catch(() => { indexed = null; });
      const batch = [...pending.entries()]; pending.clear();
      for (const [key, entry] of batch) inflight.set(key, entry);
      for (const [key, entry] of batch) {
        const inc = {};
        for (const kind of ['attempts', 'succeeded']) for (const category of CATEGORIES) if (entry[kind][category]) inc[kind + '.' + category] = entry[kind][category];
        if (!Object.keys(inc).length) { inflight.delete(key); continue; }
        const _id = createHash('sha256').update(key).digest('hex').slice(0, 48);
        try {
          await Day.updateOne({ _id, ...entry.scope, day: entry.day }, { $inc: inc, $set: { updatedAt: new Date(now()) } }, { upsert: true, maxTimeMS: 3000 }); // Filter equality fields form the new row.
          inflight.delete(key);
        } catch {
          inflight.delete(key);
          // Return unsaved counts to memory; the next flush retries them.
          const back = pending.get(key) || (pending.size < MAX_PENDING ? { scope: entry.scope, day: entry.day, attempts: zero(), succeeded: zero() } : null);
          if (back) { for (const kind of ['attempts', 'succeeded']) for (const category of CATEGORIES) back[kind][category] += entry[kind][category]; pending.set(key, back); }
        }
      }
      if (pending.size) schedule();
    })().finally(() => { flushing = null; });
    return flushing;
  }
  const sum = (target, source) => { for (const category of CATEGORIES) target[category] += Number(source?.[category]) || 0; return target; };
  const totals = (attempts, succeeded) => ({ attempts, succeeded, total: CATEGORIES.reduce((n, key) => n + attempts[key], 0) });
  // Read-only: today's and this month's totals (UTC), including counts not yet flushed by this process.
  async function summary(scope) {
    const clean = { environment: scope.environment, realmId: String(scope.realmId), connectionId: String(scope.connectionId) };
    const clock = now(), today = dayOf(clock), monthStart = today.slice(0, 8) + '01';
    const day = { attempts: zero(), succeeded: zero() }, month = { attempts: zero(), succeeded: zero() };
    let persisted = false;
    reading++;
    try {
      // Let a flush already in progress settle (bounded) so its batch is counted exactly once.
      if (flushing) { let timeout; await Promise.race([flushing.catch(() => {}), new Promise(resolve => { timeout = setTimeout(resolve, summaryWaitMs); })]); clearTimeout(timeout); }
      if (connected()) {
        const rows = await model().find({ ...clean, day: { $gte: monthStart, $lte: today } }).select('day attempts succeeded').maxTimeMS(3000).lean();
        for (const row of rows) { sum(month.attempts, row.attempts); sum(month.succeeded, row.succeeded); if (row.day === today) { sum(day.attempts, row.attempts); sum(day.succeeded, row.succeeded); } }
        persisted = true;
      }
    } finally { reading--; }
    // Unsaved counts: pending plus any batch still being written (only after a slow flush outlasted the wait above).
    for (const entry of [...pending.values(), ...inflight.values()]) {
      if (scopeKey(entry.scope) !== scopeKey(clean) || entry.day < monthStart || entry.day > today) continue;
      sum(month.attempts, entry.attempts); sum(month.succeeded, entry.succeeded);
      if (entry.day === today) { sum(day.attempts, entry.attempts); sum(day.succeeded, entry.succeeded); }
    }
    return { timezone: 'UTC', day: today, persisted, measured: 'QuickBooks API transport attempts made by this app; token refreshes are not included.', today: totals(day.attempts, day.succeeded), month: totals(month.attempts, month.succeeded) };
  }
  function close() { if (timer) clearTimeout(timer); timer = null; }
  return { record, flush, summary, close, pendingSize: () => pending.size + inflight.size };
}
let singleton;
function getQboRequestMeter() { return singleton ||= createQboRequestMeter(); }
module.exports = { createQboRequestMeter, getQboRequestMeter, runWithCategory, categorize, CATEGORIES };
