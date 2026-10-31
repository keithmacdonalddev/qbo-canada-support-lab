'use strict';
// When the accountant reviews the business, and how much same-day activity a
// business day should carry. Pure: every answer comes from saved state passed in,
// so a restart resumes the same slot, backoff and review ceiling.
// Plan: docs/plans/continuous-business-activity-2026-10-30.md (v2) §3a, §3c, §3e.
const { shift } = require('./business-calendar');

const ZONE = 'America/Halifax';
// Rhythm v3 (owner direction 2026-10-31: the business runs 24/7, 365 days a year): 220 records every
// day in 24 hourly slices at :30, weighted heavier 08:00-18:00 and lighter in the evening and overnight
// (online orders, evening jobs, overnight closing work), never zero. It applies from V3_FROM, which
// switched mid-day: counts come from saved receipts, so nothing already done that day is repeated.
// Earlier days keep v2 (150 per weekday in ten slices, 30 on Saturday, closed Sunday) or a frozen v1.
const RHYTHM_VERSION = 3;
const V3_FROM = '2026-10-31';
// Relative share of each Halifax hour (00:00-23:00); 60 in all.
const HOURLY_WEIGHTS = Object.freeze([1, 1, 1, 1, 1, 1, 2, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 2, 2, 2, 2, 1, 1]);
// Activity hours and same-day slots in Halifax local minutes after midnight. v3 is one table for
// every day; the v2 weekday and Saturday tables remain for earlier days.
const SCHEDULES = Object.freeze({
  everyDay: Object.freeze({ open: 0, close: 24 * 60, target: 220, slots: Object.freeze(Array.from({ length: 24 }, (_, hour) => hour * 60 + 30)) }), // hourly 00:30-23:30
  weekday: Object.freeze({ open: 8 * 60, close: 18 * 60, target: 150, slots: Object.freeze([510, 570, 630, 690, 750, 810, 870, 930, 990, 1050]) }), // hourly 08:30-17:30
  saturday: Object.freeze({ open: 10 * 60, close: 14 * 60, target: 30, slots: Object.freeze([630, 690, 750, 810]) }), // hourly 10:30-13:30
});
// Continuous operation (owner direction 2026-10-31): while work is due the accountant runs back to back,
// one minute after the previous review. It pauses only when nothing is due or a hard limit is reached.
// Minimum minutes between model reviews of each kind while it keeps making progress.
const SPACING_MINUTES = Object.freeze({ poll: 2, recovery: 1, 'catch-up': 1, management: 1, slice: 1, obligations: 1 });
// With nothing due, saved state is re-checked at least this often (the owner's interval can only shorten it).
const PAUSE_RECHECK_MINUTES = 15;
// Same-day slices may add at most this many new records in any rolling hour, on top of the daily ceiling,
// so a business that fell behind catches up steadily instead of in one burst.
const HOURLY_CAP = 60;
// Under the all-day rhythm a review starts once at least this many records are due (or the rest of the day's
// target, if fewer remain), so the accountant keeps pace through the hour instead of waiting for a slot.
const MIN_DUE = 5;
// Prepared, queued and executing batches share this capacity; recovery never removes their reservations.
const MAX_IN_FLIGHT = 3;
// The daily management review (business-management-review.js): 00:10 Halifax every day, right after
// the previous day's close and before the first slice. At most two attempts a day; the day's saved plan ends it.
const MANAGEMENT_MINUTES = Object.freeze({ everyDay: 10 });
const MANAGEMENT_ATTEMPTS = 2;
// Consecutive model reviews that fail or make no progress wait 5, 15, then 30 minutes. Waiting on QuickBooks is
// polled without a model, and a review that saved or queued records resets the count.
const BACKOFF_MINUTES = Object.freeze([5, 15, 30]);
// Hard ceiling on model reviews per Halifax day across every role and outcome, sized for back-to-back reviews.
const REVIEW_CEILING = 400;
const MIDNIGHT_CLOSE_MINUTES = 5;
// QuickBooks request budget (Phase 0 meter: transport attempts by UTC day, unsaved counts included).
// Intuit's Builder tier allows 500,000 metered ("CorePlus") calls a month: reads, queries and reports.
// Creates and updates ("Core" data-in calls) are not metered, so writes never count here.
// Scheme (sync tuning, 2026-10-31):
// - Activity budget: 10,000 metered NON-sync attempts (read + query + report) per UTC day. At it, no
//   new discretionary slice is scheduled or admitted; recovery, obligations, calendar closes and
//   continuation proceed. Background sync is excluded, so it can never starve the business.
// - Sync is expected at about 300 a day (an adaptive combined change read, one before writes, snapshot
//   re-reads and a nightly count sweep; business-agent-sync.js), shown separately but not limited here.
// - Monthly guard: 450,000 metered attempts (sync included) month to date also stops new slices,
//   leaving 50,000 of the free allowance for sync, recovery and verification.
// 31 x (10,000 + ~300) is about 319,000, so the monthly guard is a backstop against runaway use.
const METERED_CATEGORIES = Object.freeze(['sync', 'read', 'query', 'report']);
const ACTIVITY_CATEGORIES = Object.freeze(['read', 'query', 'report']);
const DAILY_REQUEST_BUDGET = 10000;
const MONTHLY_METERED_BUDGET = 450000;
const FREE_MONTHLY_ALLOWANCE = 500000;
const EXPECTED_DAILY_SYNC = 300;
// summary: the meter summary ({ today: { attempts }, month: { attempts } }) or null when it could not be
// read. Any unreadable or malformed count is treated as reached (fail closed).
function requestBudget(summary, { limit = DAILY_REQUEST_BUDGET, monthlyLimit = MONTHLY_METERED_BUDGET } = {}) {
  const counts = attempts => {
    if (!attempts || typeof attempts !== 'object') return null;
    const values = METERED_CATEGORIES.map(key => Number(attempts[key]));
    return values.every(value => Number.isFinite(value) && value >= 0) ? Object.fromEntries(METERED_CATEGORIES.map((key, i) => [key, values[i]])) : null;
  };
  const day = counts(summary?.today?.attempts), month = counts(summary?.month?.attempts);
  const base = { limit, monthlyLimit, allowance: FREE_MONTHLY_ALLOWANCE, expectedDailySync: EXPECTED_DAILY_SYNC };
  if (!summary || summary.unavailable || !day || !month) return { ...base, used: null, sync: null, meteredToday: null, meteredMonth: null, reached: true, unavailable: true, scope: null };
  const sum = (row, keys) => keys.reduce((total, key) => total + row[key], 0);
  const used = sum(day, ACTIVITY_CATEGORIES), meteredToday = sum(day, METERED_CATEGORIES), meteredMonth = sum(month, METERED_CATEGORIES);
  const monthly = meteredMonth >= monthlyLimit, daily = used >= limit;
  return { ...base, used, sync: day.sync, meteredToday, meteredMonth, reached: daily || monthly, unavailable: false, scope: monthly ? 'month' : daily ? 'day' : null };
}
// Plain-language reason a reached budget gives, for the cadence, the tools and the work list.
// tail: what continues, appended after the reason.
function requestBudgetReason(budget, tail = 'recovery, obligations and calendar closes continue') {
  const n = value => Number(value).toLocaleString('en-CA');
  if (!budget?.reached) return '';
  if (budget.unavailable) return 'today’s QuickBooks request count could not be read, so new sales and expenses wait' + (tail ? '; ' + tail : '');
  if (budget.scope === 'month') return 'this month’s metered QuickBooks requests reached the ' + n(budget.monthlyLimit) + ' guard (' + n(budget.meteredMonth) + ' of the ' + n(budget.allowance) + ' free allowance); new sales and expenses resume next month (UTC)' + (tail ? '; ' + tail : '');
  return 'today’s QuickBooks request budget of ' + n(budget.limit) + ' is used (' + n(budget.used) + ' reads, queries and reports; sync and writes are not counted); new sales and expenses resume after midnight UTC' + (tail ? '; ' + tail : '');
}
// A prepared (previewed) slice holds its planned records against the day only briefly.
const PREVIEW_HOLD_MS = 30 * 60000;
// An executing operation that shows no progress for this long gets a recovery review.
const STALLED_POLL_MS = 20 * 60000;
// Retained (writer-holding) statuses that need the accountant to resume or finish them.
const RETAINED = new Set(['approved', 'reserved', 'blocked', 'stopped', 'awaiting-evidence']);
const ACTIVE = new Set(['running', 'committing']);
const MINUTE = 60000;
// Batch types that make up a scheduled same-day slice. Duty and list batches
// (receiving orders, settling adopted obligations, corrections, additions) are
// naturally single-use per target and keep the accountant's own identity. Policy v8
// discretionary work (terms invoices and bills, estimates and their conversion, stock
// orders) is slice work; collecting or paying its own open records is an obligation
// duty like settling adopted ones (bounded by each record's open balance).
const SLICE_TYPES = new Set(['settled-service-sale', 'paid-operating-expense', 'paid-cash-expense', 'supplier-credit', 'customer-credit', 'customer-refund', 'bank-transfer', 'journal-entry', 'invoice-on-terms', 'bill-on-terms', 'send-estimate', 'convert-own-estimate', 'order-stock']);
const SLOT_KEY = /^slot-(\d{8})-r(\d+)-s(\d+)(?:-b(\d+))?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
// Halifax wall clock of an instant: { date: 'YYYY-MM-DD', minutes, weekday (0 = Sunday) }.
function localParts(ms) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  const date = p.year + '-' + p.month + '-' + p.day, hour = Number(p.hour) % 24;
  return { date, minutes: hour * 60 + Number(p.minute), seconds: Number(p.second), weekday: weekdayOf(date) };
}
const weekdayOf = day => new Date(day + 'T00:00:00Z').getUTCDay();
const wallUtc = ms => { const p = localParts(ms), [y, m, d] = p.date.split('-').map(Number); return Date.UTC(y, m - 1, d) + p.minutes * MINUTE + p.seconds * 1000; };
const offsetAt = ms => wallUtc(ms) - Math.floor(ms / 1000) * 1000;
// The instant of a Halifax local time, using the real offset (ADT -03:00 / AST -04:00).
// A repeated (fall-back) time resolves to its first occurrence; a missing
// (spring-forward) time resolves to the end of the gap, e.g. 02:30 -> 03:00.
function zonedTime(day, minutes) {
  const [y, m, d] = day.split('-').map(Number), naive = Date.UTC(y, m - 1, d) + minutes * MINUTE;
  const valid = ms => { const p = localParts(ms); return p.date === day && p.minutes === minutes; };
  const early = naive - offsetAt(naive - 12 * 3600000), late = naive - offsetAt(naive + 12 * 3600000);
  const first = Math.min(early, late), second = Math.max(early, late);
  if (valid(first)) return first;
  if (valid(second)) return second;
  // Gap: find the transition instant between the two candidates to the minute.
  let low = first, high = second;
  while (high - low > MINUTE) { const mid = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE; if (offsetAt(mid) === offsetAt(second)) high = mid; else low = mid; }
  return high;
}
const nextDay = day => shift(day, 1);
function managementMinutes() { return MANAGEMENT_MINUTES.everyDay; }
const managementAt = day => zonedTime(day, managementMinutes(day));
// management: { lastPlanDay } (the latest saved daily plan's day, or null when none was ever saved);
// omitted (null) when the review is unavailable. The first-ever review runs at once; later ones at the day's time.
function managementDue(management, state, day, now) {
  if (!management || management.lastPlanDay === day) return false;
  const tries = state?.management?.day === day ? Number(state.management.attempts) || 0 : 0;
  return tries < MANAGEMENT_ATTEMPTS && (!management.lastPlanDay || now >= managementAt(day));
}
const roundHalfUp = value => Math.floor(value + 0.5);
const shortDate = day => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || ''); return match ? MONTHS[Number(match[2]) - 1] + ' ' + Number(match[3]) : null; };
const dayLabel = day => WEEKDAYS[weekdayOf(day)] + ' ' + shortDate(day);
function monthEnd(day) { const [y, m] = day.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }

// One day's rhythm. It is frozen at the day's first evaluation and stored, so a later
// change applies from the next business day and never resets counts mid-day.
function dayRhythm(day, level = 1) {
  const scale = [0.5, 1, 2].includes(level) ? level : 1;
  if (day >= V3_FROM) {
    const every = SCHEDULES.everyDay, target = roundHalfUp(every.target * scale);
    return { version: 3, day, level: scale, target, ceiling: 2 * target, open: every.open, close: every.close, slots: every.slots.map((minute, index) => ({ n: index + 1, minute, weight: HOURLY_WEIGHTS[index] })) };
  }
  const weekday = weekdayOf(day), schedule = weekday === 0 ? null : weekday === 6 ? SCHEDULES.saturday : SCHEDULES.weekday;
  const target = schedule ? roundHalfUp(schedule.target * scale) : 0;
  return { version: 2, day, level: scale, target, ceiling: 2 * target, open: schedule ? schedule.open : null, close: schedule ? schedule.close : null, slots: schedule ? schedule.slots.map((minute, index) => ({ n: index + 1, minute })) : [] };
}
function frozenRhythm(state, day) {
  const saved = state?.rhythm;
  // A rhythm already frozen for this day is kept, so a code change never resets a day mid-way; the one
  // exception is the v3 switch, which replaces an earlier version from V3_FROM on.
  if (saved && saved.day === day && Number.isSafeInteger(saved.version) && saved.version >= 1 && Array.isArray(saved.slots) && Number.isSafeInteger(saved.target) && !(saved.version < 3 && day >= V3_FROM)) return saved;
  return dayRhythm(day);
}
const slotKey = (day, version, n, batch = 1) => 'slot-' + day.replace(/-/g, '') + '-r' + version + '-s' + n + (batch > 1 ? '-b' + batch : '');
function slotOf(decisionKey) { const match = SLOT_KEY.exec(decisionKey || ''); return match ? { day: match[1].slice(0, 4) + '-' + match[1].slice(4, 6) + '-' + match[1].slice(6), version: Number(match[2]), n: Number(match[3]), batch: Number(match[4] || 1) } : null; }
const isSlice = activities => (activities || []).some(row => SLICE_TYPES.has(row?.type));
const isSliceKey = (decisionKey, rhythm) => { const value = slotOf(decisionKey); return Boolean(value && value.day === rhythm.day); };
const inHours = (rhythm, local) => rhythm.open !== null && local.date === rhythm.day && local.minutes >= rhythm.open && local.minutes < rhythm.close;

// Today's activity, counted from native create receipts by business date.
// runs: accountant-owned same-day batch operations dated `day`
//   [{ id, status, decisionKey, createdAt, createCount, recordCount }]
// receipts: saved native create receipts of those runs [{ operationId, entity, logicalKey }]
function summarizeToday({ rhythm, runs = [], receipts = [], now }) {
  const savedByRun = new Map(), byEntity = {};
  for (const row of receipts) {
    const id = String(row.operationId), key = String(row.logicalKey || '');
    if (!key) continue;
    if (!savedByRun.has(id)) savedByRun.set(id, new Set());
    const keys = savedByRun.get(id);
    if (keys.has(key)) continue;
    keys.add(key);
    const entity = String(row.entity || 'record').toLowerCase();
    byEntity[entity] = (byEntity[entity] || 0) + 1;
  }
  let saved = 0, verified = 0, reserved = 0, inFlight = 0;const reservedByRun = {}, plannedByRun = {};
  for (const [id, keys] of savedByRun) { saved += keys.size; if (runs.some(run => String(run.id) === id && run.status === 'verified')) verified += keys.size; }
  // Each slot's share follows its weight (v3 hourly weights; earlier rhythms are uniform). One slice, and all
  // slices in any rolling hour, carry at most HOURLY_CAP new records.
  const count = rhythm.slots.length, weights = rhythm.slots.map(slot => Number.isFinite(slot.weight) && slot.weight > 0 ? slot.weight : 1), totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const sliceCap = count ? HOURLY_CAP : 0;
  let cumulative = 0;const shares = weights.map(value => (cumulative += value));
  const plannedOf = run => Number.isSafeInteger(run.createCount) ? run.createCount : Number(run.recordCount) || 0;
  // A prepared slice over the slot allowance can never be approved, so it neither fills its slot nor reserves.
  const oversized = run => run.status === 'previewed' && isSliceKey(run.decisionKey, rhythm) && plannedOf(run) > sliceCap;
  const live = run => run.status !== 'retired' && !(run.status === 'previewed' && !(Number(run.createdAt) > now - PREVIEW_HOLD_MS)) && !oversized(run);
  for (const run of runs) if (!['verified', 'retired'].includes(run.status)) plannedByRun[String(run.id)] = plannedOf(run);
  for (const run of runs) {
    if (['verified', 'retired'].includes(run.status) || !live(run)) continue;
    const planned = plannedOf(run);
    const left = Math.max(0, planned - (savedByRun.get(String(run.id))?.size || 0));
    inFlight++;
    if (left) { reserved += left; reservedByRun[String(run.id)] = left; }
  }
  const used = saved + reserved, local = localParts(now);
  // The rolling hour: live slices created in the last 60 minutes, by their planned or saved records.
  const hourByRun = {};let hourUsed = 0, hourFirst = Infinity;
  for (const run of runs) {
    const hourAt = Number(run.hourAt ?? run.createdAt);
    if ((!live(run) && !run.hourlyActivity) || !(run.hourlyActivity || isSliceKey(run.decisionKey, rhythm)) || !(hourAt > now - 60 * MINUTE)) continue;
    const records = Math.max(run.status === 'verified' || run.status === 'retired' ? 0 : plannedOf(run), savedByRun.get(String(run.id))?.size || 0);
    if (!records) continue;
    hourByRun[String(run.id)] = records;hourUsed += records;hourFirst = Math.min(hourFirst, hourAt);
  }
  const hourLeft = Math.max(0, HOURLY_CAP - hourUsed);
  const slots = rhythm.slots.map((slot, index) => {
    const owned = runs.filter(run => { const value = slotOf(run.decisionKey); return value && value.day === rhythm.day && value.version === rhythm.version && value.n === slot.n; });
    return { n: slot.n, at: new Date(zonedTime(rhythm.day, slot.minute)).toISOString(), expected: roundHalfUp(rhythm.target * shares[index] / totalWeight), filled: owned.some(live), batches: owned.length };
  });
  const ceilingReached = used >= rhythm.ceiling;
  // The all-day rhythm (v3, one weighted slot per hour) expects work continuously: the cumulative share of every
  // finished hour plus the elapsed part of the current one. Earlier rhythms expect each slot's share at its time.
  const hourly = rhythm.version >= 3 && count === 24;
  const expectedAtMinute = minute => { const h = Math.min(23, Math.floor(minute / 60)); return Math.floor(rhythm.target * ((h ? shares[h - 1] : 0) + weights[h] * Math.min(1, (minute - h * 60) / 60)) / totalWeight); };
  const nowMinute = local.date === rhythm.day ? local.minutes + local.seconds / 60 : null;
  const elapsed = inHours(rhythm, local) ? hourly ? slots[Math.min(23, Math.floor(local.minutes / 60))] : slots.filter(slot => Date.parse(slot.at) <= now).at(-1) || null : null;
  const expectedNow = !elapsed ? 0 : hourly ? expectedAtMinute(nowMinute) : elapsed.expected;
  const behind = Math.max(0, expectedNow - used), enough = Math.max(1, Math.min(hourly ? MIN_DUE : 1, rhythm.target - used));
  // Work is due whenever today is behind its expected count, batch after batch, within the daily ceiling and the
  // rolling hourly cap; a v2 shortfall is never replayed after that day's hours.
  const due = elapsed && behind >= enough && !ceilingReached && hourLeft > 0 && inFlight < MAX_IN_FLIGHT
    ? { n: elapsed.n, records: Math.min(behind, rhythm.ceiling - used, hourLeft), decisionKey: slotKey(rhythm.day, rhythm.version, elapsed.n, elapsed.batches + 1) } : null;
  // Behind but at the hourly cap: work continues when the oldest slice of the hour leaves the window.
  const hourResetAt = elapsed && behind >= enough && !ceilingReached && !hourLeft && Number.isFinite(hourFirst) ? new Date(hourFirst + 60 * MINUTE).toISOString() : null;
  // When more work is next due: under v3 the minute today's expected count first runs `enough` ahead of what is done.
  let next = null;
  if (hourly && nowMinute !== null && used < rhythm.target) { for (let m = Math.ceil(nowMinute); m < 24 * 60; m++) if (expectedAtMinute(m) - used >= enough) { next = { at: new Date(zonedTime(rhythm.day, m)).toISOString() }; break; } }
  else if (!hourly) next = slots.find(slot => Date.parse(slot.at) > now) || null;
  // Prepared or unfinished batches of today: a prepared slice is executed, never prepared again.
  const open = runs.filter(run => live(run) && run.status !== 'verified').slice(0, 10).map(run => ({ operationId: String(run.id), status: run.status, decisionKey: run.decisionKey || null }));
  return { day: rhythm.day, label: dayLabel(rhythm.day), rhythmVersion: rhythm.version, target: rhythm.target, ceiling: rhythm.ceiling, saved, verified, reserved, inFlight, inFlightLimit: MAX_IN_FLIGHT, byEntity,
    reservedByRun, plannedByRun, sliceCap, hourCap: HOURLY_CAP, hourUsed, hourByRun, hourResetAt, behind, expectedNow, open, currentSlot: elapsed ? elapsed.n : null, slotCount: count, remaining: Math.max(0, rhythm.target - used), ceilingReached, businessHours: inHours(rhythm, local), slots, dueSlot: due, nextSlotAt: next ? next.at : null };
}

// Progress means the calendar cursor, the retained operation, today's verified creates, or
// any unfinished owned operation (status, records sent, queued) changed.
const isActive = run => Boolean(run && (ACTIVE.has(run.status) || run.executionPending === true));
function progressSignature(business, today, owned = [], obligations = null) {
  const op = business?.currentOperation;
  const runs = (Array.isArray(owned) ? owned : []).map(run => run.operationId + ':' + run.status + ':' + (run.completedRecords || 0) + ':' + (run.executionPending ? 1 : 0)).sort().join(',');
  return [business?.verifiedThrough || '', op ? op.operationId + ':' + op.status + ':' + (op.completedRecords || 0) + ':' + (op.executionPending ? 1 : 0) : '', today && !today.unavailable ? today.verified + ':' + today.saved : '', runs, obligations && Number.isSafeInteger(obligations.count) ? obligations.count : ''].join('|');
}
// A run's disposition (store.unfinishedRuns); without one, executing work is active and the rest continues.
const dispositionOf = run => run.disposition || (isActive(run) ? 'active' : 'continue');
function ownRetained(operation, agent) {
  const origin = operation?.agentAuthority, grant = agent?.grant;
  return Boolean(origin && grant && origin.agentId === agent.id && origin.grantId === grant.id && origin.authorityHash === grant.authorityHash);
}
// The next uninterrupted period to close: never across a month-end, at most 31 days, through yesterday.
function nextClose(business, todayDay) {
  const from = business?.verifiedThrough ? shift(business.verifiedThrough, 1) : business?.openingDate || null, yesterday = shift(todayDay, -1);
  if (!from || from > yesterday) return null;
  const through = [yesterday, monthEnd(from), shift(from, 30)].sort()[0];
  return { closedThrough: business?.verifiedThrough || null, fromDate: from, throughDate: through, behindDays: Math.round((Date.parse(yesterday) - Date.parse(from)) / 86400000) + 1 };
}

// Decide, from saved state only, whether this wake runs a model review now and when the next
// review is due. Precedence: active execution (poll, no model); retained or approved own work
// (recovery, including approved plans that do not hold the calendar slot); calendar behind
// (catch-up); the daily management review; due slice. Nothing actionable never calls the model: activity
// hours (all day under v3) re-check at the owner's interval, the next slot or the 00:05 close.
// The daily review ceiling is hard for every kind, owner requests included.
// owned: unfinished operations this agent approved [{ operationId, status, day, agentAuthority, executionPending, completedRecords, disposition }].
// Unsent ones are retired by the worker and ignored here; stranded ones (saved effects outside the slot) hold.
// obligations: due saved obligations { count } (store.dueObligations); actionable during activity hours (all day under v3).
// Returns { kind, callModel, nextReviewAt, reason, state } where state is the new durable cadence state.
// requests: requestBudget(...) for today; when reached, no new discretionary slice is scheduled.
// management: see managementDue; after recovery and catch-up, before slices and even while work is held.
function decide({ now, settings = {}, business = {}, agent = {}, today = null, owned = [], obligations = null, requests = null, state = {}, ownerRequested = false, ceiling = REVIEW_CEILING, management = null }) {
  const local = localParts(now), day = local.date, interval = Math.max(5, Number(settings.decisionIntervalMinutes) || 60) * MINUTE, recheck = Math.min(interval, PAUSE_RECHECK_MINUTES * MINUTE);
  let s = { ...(state || {}) };
  if (s.day !== day) s = { ...s, day, reviews: 0 };
  const rhythm = frozenRhythm(s, day);s.rhythm = rhythm;
  const signature = progressSignature(business, today, owned, obligations);
  // A review is judged against its own starting point; between reviews, any change (for example
  // queued execution finishing) is progress and clears the backoff.
  if (typeof s.reviewSignature === 'string') {
    if (s.reviewSignature !== signature) s.misses = 0;
    else if (s.reviewPending !== true) {
      const failureKind = (s.lastKind || 'review') + ':' + (s.reviewFailureKind || 'no-progress');
      s.misses = s.missKind && s.missKind !== failureKind ? 1 : (Number(s.misses) || 0) + 1;
      s.missKind = failureKind;
    }
    s.reviewSignature = null; s.reviewPending = false;
  }
  else if (typeof s.lastSignature === 'string' && s.lastSignature !== signature) s.misses = 0;
  s.lastSignature = signature;
  const misses = Number(s.misses) || 0, last = Date.parse(s.lastReviewAt || '') || 0;
  const midnight = zonedTime(nextDay(day), MIDNIGHT_CLOSE_MINUTES), tomorrow = zonedTime(nextDay(day), 0);
  const nextOpen = () => { for (let offset = 0; offset < 8; offset++) { const value = shift(day, offset), r = offset ? dayRhythm(value) : rhythm; if (r.open === null) continue; const at = zonedTime(value, offset ? Math.max(r.open, MIDNIGHT_CLOSE_MINUTES) : r.open); if (at > now) return at; } return now + interval; };
  const result = (kind, callModel, at, reason) => ({ kind, callModel, nextReviewAt: new Date(Math.max(now + (callModel ? 0 : 1000), at)).toISOString(), reason, state: s });
  const capped = (Number(s.reviews) || 0) >= ceiling, limit = 'today’s limit of ' + ceiling + ' reviews is reached; reviews resume after midnight';
  const op = business.currentOperation, blockers = Array.isArray(business.blockers) ? business.blockers : [];
  const flight = new Set([...(today?.open || []).map(run => run.operationId), ...(Array.isArray(owned) ? owned : []).filter(run => ownRetained(run, agent) && run.disposition !== 'unsent').map(run => run.operationId), ...(op && ownRetained(op, agent) ? [op.operationId] : [])]);
  const capacity = Math.max(Number(today?.inFlight) || 0, flight.size) < MAX_IN_FLIGHT;
  // A writer or uncertain request belongs to its exact operation. Stops, publication, imports,
  // calendar completion and coordination still hold the whole company. The tools prove resource independence.
  const operationHold = (!op || ownRetained(op, agent)) && blockers.every(item => item.code === 'current-operation' || item.code === 'uncertain-write') && (op || (owned || []).some(run => ownRetained(run, agent)));
  const newActivity = (!op || ownRetained(op, agent)) && capacity && today && !today.unavailable && today.dueSlot && !requests?.reached && !nextClose(business, day) && (!blockers.length || operationHold);
  const independentDuties = (!op || ownRetained(op, agent)) && capacity && !nextClose(business, day) && (!blockers.length || operationHold) && rhythm.open !== null && local.minutes >= rhythm.open && local.minutes < rhythm.close && (obligations?.count > 0 || business.collectionReadiness?.eligibleInvoiceCount > 0 && business.collectionReadiness?.reusableDecisionKeys?.length > 0);
  const independentKind = newActivity ? 'slice' : independentDuties ? 'obligations' : null;
  const independentReason = () => newActivity ? sliceReason() : 'settling currently eligible invoices and bills while other operations continue or recover';
  const sliceReason = () => 'today is ' + (Number.isSafeInteger(today.behind) ? today.behind : today.dueSlot.records) + ' records behind schedule' + (op || flight.size ? '; prepare independent work while existing operations continue or recover' : '');
  const ownRuns = (Array.isArray(owned) ? owned : []).filter(run => ownRetained(run, agent) && run.operationId !== op?.operationId && dispositionOf(run) !== 'unsent');
  const behind = nextClose(business, day);

  if (ownerRequested) return capped ? result('ceiling', false, tomorrow, 'you asked for a review, but ' + limit) : result('owner', true, now, 'you asked for a review');
  let kind = null, reason = '';
  if (isActive(op) || ownRuns.some(run => dispositionOf(run) === 'active')) {
    if (s.pollSignature !== signature) { s.pollSignature = signature; s.pollSince = new Date(now).toISOString(); }
    if (now - (Date.parse(s.pollSince) || now) < STALLED_POLL_MS) {
      if (independentKind) { kind = independentKind; reason = independentReason(); }
      else return result('poll', false, now + SPACING_MINUTES.poll * MINUTE, 'sending records to QuickBooks');
    }
    if (!kind) { kind = 'recovery'; reason = 'its current operation has not advanced'; }
  } else { s.pollSignature = null; s.pollSince = null; }
  // A held state waits for the daily management review, which plans and files build requests without writing.
  let held = null;
  if (!kind && op && RETAINED.has(op.status)) {
    if (!ownRetained(op, agent)) held = result('held', false, now + recheck, 'held by work the accountant did not start');
    else { kind = 'recovery'; reason = 'finishing its interrupted work'; }
  }
  // An approved plan that never started holds no calendar slot, so it is found here; it runs
  // before any calendar close, which must never close a date such a plan targets.
  if (!kind && !held && ownRuns.some(run => dispositionOf(run) === 'prepared' && run.contract !== 'general-write-v1') && !blockers.length) { kind = 'slice'; reason = 'dispatching its prepared independent work'; }
  if (!kind && !held && ownRuns.some(run => dispositionOf(run) === 'continue')) { kind = 'recovery'; reason = 'finishing approved work that has not started'; }
  // Stopped outside the calendar slot after saving records: no tool can continue it yet, so no model
  // call; it keeps holding new work (and the calendar) until it is continued.
  if (!kind && !held && ownRuns.some(run => dispositionOf(run) === 'stranded')) held = result('held', false, Math.min(now + recheck, midnight), 'held: stopped work with saved records needs a recovery capability');
  // Other blockers (uncertain writes, imported history, stops) have no accountant tool yet: no model call.
  if (!kind && !held && blockers.length) {
    held = result('held', false, Math.min(now + recheck, midnight), 'held: ' + String(blockers[0].title || 'business work is blocked').replace(/^./, c => c.toLowerCase()));
  }
  if (!kind && !held && behind) { kind = 'catch-up'; reason = 'closing ' + shortDate(behind.fromDate) + (behind.throughDate !== behind.fromDate ? '–' + shortDate(behind.throughDate) : ''); }
  const budgetSpent = Boolean(requests?.reached), budgetReason = requestBudgetReason(requests, '');
  if (!kind && !budgetSpent && managementDue(management, s, day, now)) { kind = 'management'; reason = management.lastPlanDay ? 'the daily management review' : 'the first management review'; }
  // Alternate recovery reviews with new activity; a failed/held recovery cannot consume the
  // next slice's delay. Automatic recovery also runs between model reviews in the worker.
  if (independentKind && (!kind && held || kind === 'recovery' && (s.lastKind === 'recovery' || misses > 0))) { kind = independentKind; reason = independentReason(); held = null; }
  if (!kind && held) return held;
  if (!kind && newActivity) { kind = 'slice'; reason = sliceReason(); }
  const open = rhythm.open !== null && local.minutes >= rhythm.open && local.minutes < rhythm.close;
  // Due saved obligations are actionable in activity hours (all day under v3), spaced and backed off like any review,
  // so an obligation that cannot be settled never loops.
  if (!kind && open && obligations && obligations.count > 0) { kind = 'obligations'; reason = 'settling ' + obligations.count + ' due ' + (obligations.count === 1 ? 'invoice or bill' : 'invoices and bills'); }

  if (kind) {
    const sameKind = !s.lastKind || s.lastKind === kind;
    const failures = sameKind ? misses : 0;
    const behindTarget = today && !today.unavailable && today.saved < today.target;
    const wait = failures > 0 ? Math.min(behindTarget ? 5 : Infinity, Math.max(SPACING_MINUTES[kind], BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1])) : SPACING_MINUTES[kind];
    if (failures > 0) reason += ' · no progress on the last ' + (misses === 1 ? 'review' : misses + ' reviews') + ', waiting ' + wait + ' min';
    if (capped) return result('ceiling', false, tomorrow, limit);
    const earliest = last ? last + wait * MINUTE : now;
    return result(kind, earliest <= now, earliest, reason);
  }
  // Nothing actionable: no model call, only a cheap re-check of saved state.
  const nextSlot = today?.nextSlotAt && !today.unavailable && !today.ceilingReached && today.remaining > 0 && !budgetSpent ? Date.parse(today.nextSlotAt) : Infinity;
  const hours = open;
  const hourReset = today && !today.unavailable && today.hourResetAt && !budgetSpent ? Date.parse(today.hourResetAt) : Infinity;
  const why = capped ? limit : !capacity ? 'three operations are already prepared, queued or executing; new activity resumes as capacity frees' : budgetSpent && rhythm.target && today && !today.unavailable && today.remaining > 0 ? budgetReason : !rhythm.target ? '' : today && !today.unavailable ? (today.ceilingReached ? 'today’s activity ceiling is reached' : today.remaining === 0 ? 'today’s target is met' : Number.isFinite(hourReset) ? 'the hourly limit of ' + (today.hourCap || HOURLY_CAP) + ' new records is reached; work continues at ' + localTime(hourReset) : '') : '';
  if (hours) {
    // An all-day rhythm (v3) runs to the close just after midnight. Paused: nothing is due, so saved state is
    // re-checked at the next share, the hourly window or within 15 minutes.
    const close = rhythm.close >= 24 * 60 ? midnight : zonedTime(day, rhythm.close), check = now + recheck;
    return result('idle', false, Math.min(check, nextSlot, close, hourReset), why || (today && !today.unavailable && rhythm.target && nextSlot <= check ? 'on schedule; more work is due at ' + localTime(nextSlot) : 'nothing is due right now'));
  }
  // Only an earlier (v2) day has hours without activity.
  return result('quiet', false, Math.min(now + interval, nextOpen(), midnight, nextSlot), why || (rhythm.open === null ? 'no activity was planned that day' : 'outside that day’s activity hours'));
}
// Every model review (any role, any outcome) counts toward today's ceiling when it starts.
function countReview(state, now) {
  const day = localParts(now).date, s = { ...(state || {}) };
  if (s.day !== day) { s.day = day; s.reviews = 0; }
  return { ...s, reviews: (Number(s.reviews) || 0) + 1 };
}
// A main review also fixes the progress baseline that the next decision compares against.
// A management review plans rather than writes, so it never counts as a review without progress.
function beginReview(state, { now, signature, kind }) {
  const next = { ...countReview(state, now), ...(state?.lastKind && state.lastKind !== kind ? { misses: 0, missKind: null } : {}), reviewFailureKind: null, reviewSignature: kind === 'management' ? null : signature, reviewPending: true, lastReviewAt: new Date(now).toISOString(), lastKind: kind };
  if (kind === 'management') { const day = localParts(now).date, prior = next.management?.day === day ? Number(next.management.attempts) || 0 : 0; next.management = { day, attempts: prior + 1 }; }
  return next;
}
// Only a recorded terminal outcome makes a review eligible for no-progress backoff.
// A crash leaves the baseline pending; it still consumes its daily review allowance.
function finishReview(state, { failureKind = 'no-progress' } = {}) { return { ...(state || {}), reviewPending: false, reviewFailureKind: failureKind }; }
const timeFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hour: 'numeric', minute: '2-digit', hour12: true });
// "2:15 PM" in Halifax time, for text the accountant and the work list read.
const localTime = value => { const ms = typeof value === 'number' ? value : Date.parse(value || ''); return Number.isFinite(ms) ? timeFormat.format(new Date(ms)).replace(/\s*a\.m\./i, ' AM').replace(/\s*p\.m\./i, ' PM') : null; };
// Specialists are read-only reporters: they run in the day's activity hours (all day under v3) under the same ceiling.
function specialistAllowed({ now, state = {}, ceiling = REVIEW_CEILING }) {
  const local = localParts(now), rhythm = frozenRhythm(state, local.date), reviews = state?.day === local.date ? Number(state.reviews) || 0 : 0;
  if (reviews >= ceiling) return { allowed: false, nextAt: new Date(zonedTime(nextDay(local.date), 0)).toISOString() };
  if (inHours(rhythm, local)) return { allowed: true, nextAt: null };
  for (let offset = 0; offset < 8; offset++) { const value = shift(local.date, offset), r = offset ? dayRhythm(value) : rhythm; if (r.open === null) continue; const at = zonedTime(value, r.open); if (at > now) return { allowed: false, nextAt: new Date(at).toISOString() }; }
  return { allowed: false, nextAt: new Date(now + 86400000).toISOString() };
}

module.exports = { MAX_IN_FLIGHT, MIN_DUE, HOURLY_CAP, PAUSE_RECHECK_MINUTES, V3_FROM, HOURLY_WEIGHTS, MANAGEMENT_MINUTES, MANAGEMENT_ATTEMPTS, managementMinutes, managementAt, managementDue, DAILY_REQUEST_BUDGET, MONTHLY_METERED_BUDGET, FREE_MONTHLY_ALLOWANCE, EXPECTED_DAILY_SYNC, METERED_CATEGORIES, requestBudget, requestBudgetReason, ZONE, RHYTHM_VERSION, SCHEDULES, SPACING_MINUTES, BACKOFF_MINUTES, REVIEW_CEILING, PREVIEW_HOLD_MS, STALLED_POLL_MS, SLICE_TYPES,
  localParts, zonedTime, dayRhythm, frozenRhythm, slotKey, slotOf, isSlice, summarizeToday, progressSignature, nextClose, decide, countReview, beginReview, finishReview, specialistAllowed, shortDate, dayLabel, monthEnd, localTime };
