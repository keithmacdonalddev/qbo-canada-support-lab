'use strict';
// Counts QuickBooks API transport attempts per company per UTC day, by category.
// Best-effort and cheap: the transport records into memory; a timer flushes batched $inc updates.
// Metering can never delay, fail or alter a QuickBooks request.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const CATEGORIES = Object.freeze(['sync', 'report', 'query', 'read', 'write']);
// Only server-owned labels are retained: never a stack, endpoint, ID or caller text.
const SOURCE_CALLERS = Object.freeze({
  "modules/account-automation-review.js": "source-modules-account-automation-review",
  "modules/account-recovery.js": "source-modules-account-recovery",
  "modules/ai-orchestrator.js": "source-modules-ai-orchestrator",
  "modules/ai-provider.js": "source-modules-ai-provider",
  "modules/ai-session-streams.js": "source-modules-ai-session-streams",
  "modules/ai-tool-bridge.js": "source-modules-ai-tool-bridge",
  "modules/ai-tools.js": "source-modules-ai-tools",
  "modules/blueprint-draft-write.js": "source-modules-blueprint-draft-write",
  "modules/business-activity-batch.js": "source-modules-business-activity-batch",
  "modules/business-added-roles.js": "source-modules-business-added-roles",
  "modules/business-agent-service.js": "source-modules-business-agent-service",
  "modules/business-agent-store.js": "source-modules-business-agent-store",
  "modules/business-agent-sync.js": "source-modules-business-agent-sync",
  "modules/business-agent-tools.js": "source-modules-business-agent-tools",
  "modules/business-agent-usage.js": "source-modules-business-agent-usage",
  "modules/business-approval-report-evidence.js": "source-modules-business-approval-report-evidence",
  "modules/business-baseline.js": "source-modules-business-baseline",
  "modules/business-calendar.js": "source-modules-business-calendar",
  "modules/business-company-query.js": "source-modules-business-company-query",
  "modules/business-compilation-runtime.js": "source-modules-business-compilation-runtime",
  "modules/business-continuity-service.js": "source-modules-business-continuity-service",
  "modules/business-country.js": "source-modules-business-country",
  "modules/business-dated-tax.js": "source-modules-business-dated-tax",
  "modules/business-dispatch.js": "source-modules-business-dispatch",
  "modules/business-error-detail.js": "source-modules-business-error-detail",
  "modules/business-execution-service.js": "source-modules-business-execution-service",
  "modules/business-governance-service.js": "source-modules-business-governance-service",
  "modules/business-history-adoption-service.js": "source-modules-business-history-adoption-service",
  "modules/business-history-adoption.js": "source-modules-business-history-adoption",
  "modules/business-inventory-review.js": "source-modules-business-inventory-review",
  "modules/business-link-repair-balances.js": "source-modules-business-link-repair-balances",
  "modules/business-link-repair.js": "source-modules-business-link-repair",
  "modules/business-management-review.js": "source-modules-business-management-review",
  "modules/business-master-apply.js": "source-modules-business-master-apply",
  "modules/business-master-attribution.js": "source-modules-business-master-attribution",
  "modules/business-master-preparation-recovery.js": "source-modules-business-master-preparation-recovery",
  "modules/business-master-preparation-runner.js": "source-modules-business-master-preparation-runner",
  "modules/business-master-preparation-store.js": "source-modules-business-master-preparation-store",
  "modules/business-master-runtime.js": "source-modules-business-master-runtime",
  "modules/business-master-service.js": "source-modules-business-master-service",
  "modules/business-observation-store.js": "source-modules-business-observation-store",
  "modules/business-operation-candidate.js": "source-modules-business-operation-candidate",
  "modules/business-operation-plan-store.js": "source-modules-business-operation-plan-store",
  "modules/business-operation-recovery.js": "source-modules-business-operation-recovery",
  "modules/business-operation-retirement.js": "source-modules-business-operation-retirement",
  "modules/business-period-evidence.js": "source-modules-business-period-evidence",
  "modules/business-policy-amendment.js": "source-modules-business-policy-amendment",
  "modules/business-population-plan.js": "source-modules-business-population-plan",
  "modules/business-population-proof.js": "source-modules-business-population-proof",
  "modules/business-population-reader.js": "source-modules-business-population-reader",
  "modules/business-population-runtime.js": "source-modules-business-population-runtime",
  "modules/business-population-service.js": "source-modules-business-population-service",
  "modules/business-population-verification.js": "source-modules-business-population-verification",
  "modules/business-record-inventory.js": "source-modules-business-record-inventory",
  "modules/business-reference.js": "source-modules-business-reference",
  "modules/business-report-evidence.js": "source-modules-business-report-evidence",
  "modules/business-report-source.js": "source-modules-business-report-source",
  "modules/business-runtime-audit.js": "source-modules-business-runtime-audit",
  "modules/business-setup-service.js": "source-modules-business-setup-service",
  "modules/business-step-store.js": "source-modules-business-step-store",
  "modules/business-stock-general-history.js": "source-modules-business-stock-general-history",
  "modules/business-stock-general.js": "source-modules-business-stock-general",
  "modules/business-stock-source.js": "source-modules-business-stock-source",
  "modules/business-ui-link-correction.js": "source-modules-business-ui-link-correction",
  "modules/business-unknown-recovery.js": "source-modules-business-unknown-recovery",
  "modules/business-verification-runtime.js": "source-modules-business-verification-runtime",
  "modules/business-writer-fence.js": "source-modules-business-writer-fence",
  "modules/case-changes.js": "source-modules-case-changes",
  "modules/checkpoint.js": "source-modules-checkpoint",
  "modules/codex-cli.js": "source-modules-codex-cli",
  "modules/coverage.js": "source-modules-coverage",
  "modules/general-write-close-gate.js": "source-modules-general-write-close-gate",
  "modules/general-write-day-close.js": "source-modules-general-write-day-close",
  "modules/general-write-recovery.js": "source-modules-general-write-recovery",
  "modules/general-write-service.js": "source-modules-general-write-service",
  "modules/general-write-transport.js": "source-modules-general-write-transport",
  "modules/generation-engine.js": "source-modules-generation-engine",
  "modules/generation-plan.js": "source-modules-generation-plan",
  "modules/generation-settlement.js": "source-modules-generation-settlement",
  "modules/issuepack-engine.js": "source-modules-issuepack-engine",
  "modules/period-close-reader.js": "source-modules-period-close-reader",
  "modules/period-close-service.js": "source-modules-period-close-service",
  "modules/qbo-request-meter.js": "source-modules-qbo-request-meter",
  "modules/qbo-write-contract.js": "source-modules-qbo-write-contract",
  "modules/qbo-write-gate.js": "source-modules-qbo-write-gate",
  "modules/qbo-write-period.js": "source-modules-qbo-write-period",
  "modules/rebuild-definitions.js": "source-modules-rebuild-definitions",
  "modules/report-evidence-service.js": "source-modules-report-evidence-service",
  "modules/report-json.js": "source-modules-report-json",
  "modules/reproduction-approvals.js": "source-modules-reproduction-approvals",
  "modules/reproduction-business.js": "source-modules-reproduction-business",
  "modules/reproduction-engine.js": "source-modules-reproduction-engine",
  "modules/reproduction-reconcile.js": "source-modules-reproduction-reconcile",
  "modules/reproduction-runner.js": "source-modules-reproduction-runner",
  "modules/reproduction-screen.js": "source-modules-reproduction-screen",
  "modules/storage-target.js": "source-modules-storage-target",
  "routes/ai-tools-mcp.js": "source-routes-ai-tools-mcp",
  "routes/ai.js": "source-routes-ai",
  "routes/auth.js": "source-routes-auth",
  "routes/business-agent.js": "source-routes-business-agent",
  "routes/business-plan.js": "source-routes-business-plan",
  "routes/checkpoint.js": "source-routes-checkpoint",
  "routes/company.js": "source-routes-company",
  "routes/explore.js": "source-routes-explore",
  "routes/issuepacks.js": "source-routes-issuepacks",
  "routes/qbo.js": "source-routes-qbo",
  "routes/seed.js": "source-routes-seed"
});
const CALLERS = Object.freeze(['qbo-direct', ...Object.values(SOURCE_CALLERS), 'untagged', 'business-reference', 'business-transaction', 'business-receivables', 'business-tax-policy', 'business-period-guard', 'business-stock', 'business-deposit-guard', 'business-report-operation', 'business-report-preparation', 'business-report-baseline', 'business-report-book', 'business-write', 'business-sync', 'business-daily-check', 'business-month-close']);
const callerTag = value => CALLERS.includes(value) ? value : 'untagged';
const context = new AsyncLocalStorage();
const MAX_PENDING = 500;
const dayOf = clock => new Date(clock).toISOString().slice(0, 10);
const scopeKey = scope => [scope.environment, scope.realmId, scope.connectionId].join(':');
const zero = () => Object.fromEntries(CATEGORIES.map(key => [key, 0]));
function validScope(scope) {
  return scope && ['production', 'sandbox'].includes(scope.environment) && /^[0-9A-Za-z]{1,40}$/.test(String(scope.realmId || '')) && /^[0-9a-f]{24}$/.test(String(scope.connectionId || ''));
}
// Work run inside this wrapper (and anything it awaits) is classified as background synchronization.
function runWithCategory(category, fn) { return context.run({ ...context.getStore(), category }, fn); }
function runWithCaller(caller, fn) { return context.run({ ...context.getStore(), caller: callerTag(caller) }, fn); }
function currentCaller() { return callerTag(context.getStore()?.caller || (context.getStore()?.category === 'sync' ? 'business-sync' : 'untagged')); }
// Capture at apiCall entry, before awaits erase synchronous caller frames. Only
// checked-in source labels survive; stack text and request contents are discarded.
function callerForRequest(stack) {
  const selected = currentCaller();
  if (selected !== 'untagged') return selected;
  for (const frame of String(stack || '').split('\n')) {
    const match = /[\\/](modules|routes)[\\/]([a-z0-9-]+\.js):[0-9]+:[0-9]+/.exec(frame);
    const label = match && SOURCE_CALLERS[match[1] + '/' + match[2]];
    if (label) return label;
  }
  return 'qbo-direct';
}
const mergeCallers = (target, source) => { for (const [tag, counts] of Object.entries(source || {})) { const name = callerTag(tag), row = target[name] ||= { attempts: zero(), succeeded: zero() }; for (const kind of ['attempts', 'succeeded']) for (const category of CATEGORIES) row[kind][category] += Number(counts?.[kind]?.[category]) || 0; } };
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
  function record(scope, category, kind = 'attempts', caller = currentCaller()) {
    try {
      if (!validScope(scope) || !CATEGORIES.includes(category) || !['attempts', 'succeeded'].includes(kind)) return;
      const clean = { environment: scope.environment, realmId: String(scope.realmId), connectionId: String(scope.connectionId) };
      const day = dayOf(now()), key = scopeKey(clean) + ':' + day;
      let entry = pending.get(key);
      if (!entry) { if (pending.size >= MAX_PENDING) return; entry = { scope: clean, day, attempts: zero(), succeeded: zero(), callers: {} }; pending.set(key, entry); }
      entry[kind][category]++;
      const tag = callerTag(caller), purpose = entry.callers[tag] ||= { attempts: zero(), succeeded: zero() };
      purpose[kind][category]++;
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
        for (const [tag, counts] of Object.entries(entry.callers)) for (const kind of ['attempts', 'succeeded']) for (const category of CATEGORIES) if (counts[kind][category]) inc['callers.' + tag + '.' + kind + '.' + category] = counts[kind][category];
        if (!Object.keys(inc).length) { inflight.delete(key); continue; }
        const _id = createHash('sha256').update(key).digest('hex').slice(0, 48);
        try {
          await Day.updateOne({ _id, ...entry.scope, day: entry.day }, { $inc: inc, $set: { updatedAt: new Date(now()) } }, { upsert: true, maxTimeMS: 3000 }); // Filter equality fields form the new row.
          inflight.delete(key);
        } catch {
          inflight.delete(key);
          // Return unsaved counts to memory; the next flush retries them.
          const back = pending.get(key) || (pending.size < MAX_PENDING ? { scope: entry.scope, day: entry.day, attempts: zero(), succeeded: zero(), callers: {} } : null);
          if (back) { mergeCallers(back.callers, entry.callers); for (const kind of ['attempts', 'succeeded']) for (const category of CATEGORIES) back[kind][category] += entry[kind][category]; pending.set(key, back); }
        }
      }
      if (pending.size) schedule();
    })().finally(() => { flushing = null; });
    return flushing;
  }
  const sum = (target, source) => { for (const category of CATEGORIES) target[category] += Number(source?.[category]) || 0; return target; };
  const totals = (attempts, succeeded, callers = {}) => ({ attempts, succeeded, total: CATEGORIES.reduce((n, key) => n + attempts[key], 0), callers: Object.fromEntries(Object.entries(callers).map(([tag, row]) => [tag, { ...row, total: CATEGORIES.reduce((n, key) => n + row.attempts[key], 0) }])) });
  // Read-only: today's and this month's totals (UTC), including counts not yet flushed by this process.
  async function summary(scope) {
    const clean = { environment: scope.environment, realmId: String(scope.realmId), connectionId: String(scope.connectionId) };
    const clock = now(), today = dayOf(clock), monthStart = today.slice(0, 8) + '01';
    const day = { attempts: zero(), succeeded: zero(), callers: {} }, month = { attempts: zero(), succeeded: zero(), callers: {} };
    let persisted = false;
    reading++;
    try {
      // Let a flush already in progress settle (bounded) so its batch is counted exactly once.
      if (flushing) { let timeout; await Promise.race([flushing.catch(() => {}), new Promise(resolve => { timeout = setTimeout(resolve, summaryWaitMs); })]); clearTimeout(timeout); }
      if (connected()) {
        const rows = await model().find({ ...clean, day: { $gte: monthStart, $lte: today } }).select('day attempts succeeded callers').maxTimeMS(3000).lean();
        for (const row of rows) { mergeCallers(month.callers, row.callers); if (row.day === today) mergeCallers(day.callers, row.callers); sum(month.attempts, row.attempts); sum(month.succeeded, row.succeeded); if (row.day === today) { sum(day.attempts, row.attempts); sum(day.succeeded, row.succeeded); } }
        persisted = true;
      }
    } finally { reading--; }
    // Unsaved counts: pending plus any batch still being written (only after a slow flush outlasted the wait above).
    for (const entry of [...pending.values(), ...inflight.values()]) {
      if (scopeKey(entry.scope) !== scopeKey(clean) || entry.day < monthStart || entry.day > today) continue;
      mergeCallers(month.callers, entry.callers); if (entry.day === today) mergeCallers(day.callers, entry.callers);
      sum(month.attempts, entry.attempts); sum(month.succeeded, entry.succeeded);
      if (entry.day === today) { sum(day.attempts, entry.attempts); sum(day.succeeded, entry.succeeded); }
    }
    return { timezone: 'UTC', day: today, persisted, measured: 'QuickBooks API transport attempts made by this app; token refreshes are not included.', today: totals(day.attempts, day.succeeded, day.callers), month: totals(month.attempts, month.succeeded, month.callers) };
  }
  function close() { if (timer) clearTimeout(timer); timer = null; }
  return { record, flush, summary, close, pendingSize: () => pending.size + inflight.size };
}
let singleton;
function getQboRequestMeter() { return singleton ||= createQboRequestMeter(); }
module.exports = { createQboRequestMeter, getQboRequestMeter, runWithCategory, runWithCaller, currentCaller, callerForRequest, categorize, CATEGORIES, CALLERS };
