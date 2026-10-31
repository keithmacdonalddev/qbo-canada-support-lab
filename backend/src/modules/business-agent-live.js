'use strict';
// The live activity feed on the first page: one chronological, newest-first list of
// what the accountant is doing now and just did. It merges three saved sources:
//   (a) the current review's progress steps (fixed labels plus numeric notes),
//   (b) operation runs and their record steps from the background runner, named from
//       the company mirror (record type, document number, customer/supplier, amount),
//   (c) key business events (reviews finished or paused, decisions, approvals).
// Only allowlisted fields are copied: never prompts, tool inputs, raw errors, run
// lastError text, record payloads or event data beyond an operation link.
const { cleanSteps, activitySummary, ENTITIES } = require('./business-agent-progress');
const { oneLine } = require('./business-agent-work');

const WINDOW_MS = 12 * 3600000, MIN_ITEMS = 6, MAX_ITEMS = 50, MAX_TEXT = 160, MAX_DETAIL = 200;
const FAST_POLL_MS = 2500, IDLE_POLL_MS = 10000;
const ACTIVE_RUN = new Set(['approved', 'reserved', 'running', 'awaiting-evidence', 'committing']);
const SENDING_RUN = new Set(['running', 'awaiting-evidence', 'committing']);
const IN_FLIGHT_STEP = new Set(['claimed', 'dispatched', 'unknown']);
const ROLE_NAMES = { receivables: 'Receivables specialist', payables: 'Payables specialist', inventory: 'Inventory specialist' };
const PARTY_REFS = ['CustomerRef', 'VendorRef', 'EntityRef'];

const time = value => { const ms = value instanceof Date ? value.getTime() : typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN; return Number.isFinite(ms) ? ms : null; };
const iso = ms => new Date(ms).toISOString();
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = value => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || ''); return match && MONTHS[Number(match[2]) - 1] ? MONTHS[Number(match[2]) - 1] + ' ' + Number(match[3]) : ''; };
const span = (from, through) => day(from) && day(through) && from !== through ? day(from) + '–' + day(through) : day(through) || day(from);
const money = (cents, currency) => { if (!Number.isSafeInteger(cents)) return ''; const code = /^[A-Z]{3}$/.test(currency || '') ? currency : 'CAD'; try { return (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: code }); } catch { return (cents / 100).toFixed(2) + ' ' + code; } };
const entityName = entity => has(ENTITIES, entity) ? ENTITIES[entity][0].charAt(0).toUpperCase() + ENTITIES[entity][0].slice(1) : 'Record';
function has(map, key) { return typeof key === 'string' && Object.hasOwn(map, key); }
// The first meaningful line of model-written text, skipping markdown headings such as '## Summary'.
const summary = value => oneLine(String(value || '').split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n'), MAX_DETAIL);
const recordId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;

// The display name of the customer or supplier on a mirrored record, from its reference only.
function partyOf(mirror) {
  if (!mirror) return '';
  const name = clean(mirror.summary?.name, 80);
  if (name) return name;
  for (const ref of PARTY_REFS) { const value = clean(mirror.record?.[ref]?.name, 80); if (value) return value; }
  return '';
}
// "Invoice 11063 · Cedar Ridge Homes · $712.50" from the step and its mirrored copy.
function recordText(step, mirror) {
  const docNumber = clean(mirror?.summary?.docNumber, 40), id = recordId(step.qboId);
  const head = entityName(step.entity) + (docNumber ? ' ' + docNumber : id ? ' #' + id : '');
  return [head, partyOf(mirror), money(mirror?.summary?.amountCents, mirror?.summary?.currency)].filter(Boolean).join(' · ');
}
const STEP_STATES = {
  claimed: ['running', 'Sending to QuickBooks…'], dispatched: ['running', 'Sending to QuickBooks…'],
  unknown: ['attention', 'Checking whether QuickBooks saved it'], saved: ['done', 'Saved'],
  verified: ['done', 'Saved · verified'], rejected: ['failed', 'QuickBooks rejected it'],
};
function runLabel(run) {
  const types = Array.isArray(run.activityBatch?.activities) ? run.activityBatch.activities.map(row => row?.type) : [];
  const records = Number.isSafeInteger(run.recordCount) ? plural(run.recordCount, 'record') : '';
  if (run.activityBatch) return { batch: true, text: 'Planned ' + (activitySummary(types) || 'same-day activity') + (run.activityBatch.day ? ' for ' + day(run.activityBatch.day) : ''), records };
  return { batch: false, text: 'Prepared the business calendar for ' + (span(run.fromDate, run.throughDate) || 'the next period'), records };
}
function runStatus(run, label) {
  const total = Number.isSafeInteger(run.recordCount) ? run.recordCount : null, done = Number.isSafeInteger(run.nextOrdinal) ? run.nextOrdinal : 0;
  const progress = total ? done + ' of ' + total + ' records' : plural(done, 'record');
  switch (run.status) {
    case 'approved': case 'reserved': return ['running', 'Approved · waiting to send to QuickBooks'];
    case 'running': return ['running', 'Sending to QuickBooks · ' + progress];
    case 'awaiting-evidence': return ['running', 'All records sent · checking the books'];
    case 'committing': return ['running', 'Closing the work · checking the reports'];
    case 'verified': return ['done', label.batch ? 'Finished: ' + (total === null ? 'all records' : plural(total, 'record')) + ' saved and verified' : 'Closed the business calendar through ' + (day(run.throughDate) || 'the period end') + (total === null ? '' : ' · ' + plural(total, 'record'))];
    case 'blocked': return ['attention', 'Stopped part-way after ' + progress + ' · it resumes without sending anything twice'];
    case 'stopped': return ['attention', 'Stopped after ' + progress + ' · nothing is sent twice'];
    case 'retired': return ['done', 'Retired without sending anything'];
    default: return null;
  }
}
const EVENTS = {
  'review-completed': event => ['done', event.role && ROLE_NAMES[event.role] ? ROLE_NAMES[event.role] + ' finished its review' : 'Finished the business review', summary(event.detail)],
  'specialist-report': event => ['done', (ROLE_NAMES[event.role] || 'Specialist') + ' reported to the accountant', summary(event.detail)],
  'review-yielded': () => ['info', 'Paused the review to refresh company data', 'Saved work is kept; the review continues after the next synchronization.'],
  'review-cancelled': () => ['attention', 'The review stopped before it finished', 'Saved records and decisions are kept.'],
  'review-paused': () => ['attention', 'Review paused at a usage limit', ''],
  attention: event => ['attention', clean(event.title, MAX_TEXT) || 'Business work needs attention', summary(event.detail)],
  'plan-decision': event => ['done', clean(event.title, MAX_TEXT) || 'Approved business activity', summary(event.detail)],
  decision: event => ['attention', 'Asked you to decide: ' + clean(event.title, MAX_TEXT), ''],
  'management-decision': event => ['done', 'Decided: ' + clean(event.title, MAX_TEXT), summary(event.detail)],
  'decision-response': event => ['done', clean(event.title, MAX_TEXT) || 'You answered a decision', ''],
  control: event => ['info', oneLine(event.detail, MAX_TEXT) || 'You changed business controls', ''],
  'case-linked': () => ['done', 'Linked a troubleshooting case', ''],
};

// input: { now, configured, settings, reviewing, progress, activePass, cadence, events, runs, steps, records, unavailable }
// Returns { state, active, pollMs, startedAt, role, reason, sending, items, asOf }.
function buildLiveFeed({ now = Date.now(), configured = true, settings = {}, reviewing = false, progress = null, activePass = null, cadence = null, events = [], runs = [], steps = [], records = [], unavailable = false } = {}) {
  const items = [], clock = time(now) ?? Date.now();
  const push = (id, at, kind, status, text, extra = {}) => { const ms = time(at); if (ms === null || !text) return; items.push({ id, at: iso(ms), kind, status, text: clean(text, MAX_TEXT), ...extra }); };
  const detail = value => { const text = clean(value, MAX_DETAIL); return text ? { detail: text } : {}; };

  // (a) Review progress: the start of the latest review and each tool step.
  const ownPass = Boolean(reviewing && activePass && progress && progress.passId === activePass.id);
  if (progress && typeof progress.passId === 'string' && time(progress.startedAt) !== null) {
    const pass = clean(progress.passId, 80), role = ROLE_NAMES[progress.role] || null;
    const why = ownPass && cadence?.reason ? clean(String(cadence.reason), 120) : '';
    push('review:' + pass, progress.startedAt, 'review', ownPass ? 'running' : 'done', (role ? role + ' started a review' : 'Started a business review') + (why ? ' · ' + why : ''));
    cleanSteps(progress.steps).forEach((step, index) => {
      const status = step.status === 'running' && !ownPass ? 'failed' : step.status;
      push('review:' + pass + ':' + index, step.at, 'review-step', status, step.label, { ...detail(step.note), ...(status === 'failed' ? { outcome: 'did not finish' } : {}) });
    });
  }

  // (b) Operations and their records.
  const mirrors = new Map((Array.isArray(records) ? records : []).filter(row => row && typeof row.entity === 'string').map(row => [row.entity + ':' + row.qboId, row]));
  const knownRuns = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || !run._id) continue;
    const id = String(run._id), label = runLabel(run);
    knownRuns.set(id, run);
    const purpose = run.activityBatch ? oneLine(run.activityBatch.purpose, MAX_DETAIL) : '';
    push('run:' + id + ':planned', run.createdAt, 'operation', 'done', label.text + (label.records ? ' · ' + label.records : ''), { ...detail(purpose), operationId: id });
    const status = run.status === 'previewed' ? null : runStatus(run, label);
    if (status) push('run:' + id + ':status', run.updatedAt, 'operation', status[0], status[1], { operationId: id });
  }
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || !step._id || !has(STEP_STATES, step.state)) continue;
    const [status, outcome] = STEP_STATES[step.state], qboId = recordId(step.qboId);
    const mirror = qboId ? mirrors.get(step.entity + ':' + qboId) : null;
    push('step:' + String(step._id), step.updatedAt || step.createdAt, 'record', status, recordText({ entity: step.entity, qboId }, mirror), { outcome, ...(qboId && has(ENTITIES, step.entity) ? { record: { entity: step.entity, qboId } } : {}), ...(step.operationId ? { operationId: String(step.operationId) } : {}) });
  }

  // (c) Key events.
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !has(EVENTS, event.kind)) continue;
    const [status, text, more] = EVENTS[event.kind](event);
    const operationId = typeof event.operationId === 'string' && /^[a-f0-9]{24}$/.test(event.operationId) ? event.operationId : null;
    push('event:' + clean(String(event.id || ''), 80), event.at, 'event', status, text, { ...detail(more), ...(event.role === 'owner' ? { by: 'owner' } : {}), ...(operationId ? { operationId } : {}) });
  }

  // Newest first; keep the recent window, but never fewer than the last few things done.
  const seen = new Set(), ordered = items.filter(item => !seen.has(item.id) && seen.add(item.id)).sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const recent = ordered.filter((item, index) => index < MIN_ITEMS || clock - Date.parse(item.at) <= WINDOW_MS).slice(0, MAX_ITEMS);

  const sendingRun = [...knownRuns.values()].filter(run => SENDING_RUN.has(run.status) || run.executionRequest?.pending === true).sort((a, b) => (time(b.updatedAt) || 0) - (time(a.updatedAt) || 0))[0] || null;
  const queued = [...knownRuns.values()].some(run => ACTIVE_RUN.has(run.status));
  const inFlight = (Array.isArray(steps) ? steps : []).some(step => step && IN_FLIGHT_STEP.has(step.state) && clock - (time(step.updatedAt) || 0) < 10 * 60000);
  const sending = sendingRun ? { operationId: String(sendingRun._id), done: Number.isSafeInteger(sendingRun.nextOrdinal) ? sendingRun.nextOrdinal : 0, total: Number.isSafeInteger(sendingRun.recordCount) ? sendingRun.recordCount : null, batch: Boolean(sendingRun.activityBatch) } : null;
  const state = !configured ? 'not-configured' : !settings?.monitoring ? 'stopped' : reviewing ? 'reviewing' : sending || inFlight ? 'sending' : 'idle';
  const active = state === 'reviewing' || state === 'sending' || (configured && queued);
  return { state, active, pollMs: active ? FAST_POLL_MS : IDLE_POLL_MS, startedAt: ownPass ? clean(progress.startedAt, 40) || null : reviewing ? activePass?.startedAt || null : null, role: reviewing ? (activePass?.role || 'accountant') : null, reason: ownPass && cadence?.reason ? clean(String(cadence.reason), 120) : '', sending, items: recent, asOf: iso(clock), ...(unavailable ? { unavailable: true } : {}) };
}

// Bounded, indexed reads for the feed: recent runs of this company, their latest record steps,
// and the mirrored copies of those records (selected fields only).
function createLiveActivityReader({ models, now = () => Date.now() }) {
  const { Runs, Steps, Records } = models;
  return async function liveActivity(scope, { windowMs = WINDOW_MS, maxRuns = 6, maxSteps = 60 } = {}) {
    const since = new Date(now() - windowMs);
    const runs = await Runs.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, createdAt: { $gte: since } })
      .select('_id status createdAt updatedAt recordCount nextOrdinal fromDate throughDate activityBatch.day activityBatch.purpose activityBatch.activities.type executionRequest.pending')
      .sort({ createdAt: -1 }).limit(maxRuns).maxTimeMS(2000).lean();
    if (!runs.length) return { runs, steps: [], records: [] };
    const steps = await Steps.find({ environment: scope.environment, realmId: scope.realmId, operationId: { $in: runs.map(run => run._id) } })
      .select('_id operationId entity state qboId createdAt updatedAt').sort({ updatedAt: -1 }).limit(maxSteps).maxTimeMS(2000).lean();
    const keys = steps.filter(step => recordId(step.qboId) && typeof step.entity === 'string').map(step => ({ entity: step.entity, qboId: step.qboId }));
    const records = keys.length && Records ? await Records.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, $or: keys })
      .select('entity qboId summary.name summary.docNumber summary.amountCents summary.currency ' + PARTY_REFS.map(ref => 'record.' + ref + '.name').join(' '))
      .limit(maxSteps).maxTimeMS(2000).lean() : [];
    return { runs, steps, records };
  };
}

module.exports = { buildLiveFeed, createLiveActivityReader, recordText, WINDOW_MS, MAX_ITEMS, FAST_POLL_MS, IDLE_POLL_MS };
