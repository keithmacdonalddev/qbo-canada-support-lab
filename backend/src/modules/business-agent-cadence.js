'use strict';
// When the accountant reviews the business, and how much same-day activity a
// business day should carry. Pure: every answer comes from saved state passed in,
// so a restart resumes the same slot, backoff and review ceiling.
// Plan: docs/plans/continuous-business-activity-2026-10-30.md (v2) §3a, §3c, §3e.
const { shift } = require('./business-calendar');

const ZONE = 'America/Halifax';
// Rhythm v2 (owner direction 2026-10-30: a medium-sized business): 150 records per weekday in ten
// hourly slices, 30 on Saturday in four. v1 (20/weekday, six slots) remains valid for a day frozen under it.
const RHYTHM_VERSION = 2;
// Business hours and same-day activity slots in Halifax local minutes after midnight.
// Saturday has its own table; Sunday has no business hours and no slices.
const SCHEDULES = Object.freeze({
  weekday: Object.freeze({ open: 8 * 60, close: 18 * 60, target: 150, slots: Object.freeze([510, 570, 630, 690, 750, 810, 870, 930, 990, 1050]) }), // hourly 08:30-17:30
  saturday: Object.freeze({ open: 10 * 60, close: 14 * 60, target: 30, slots: Object.freeze([630, 690, 750, 810]) }), // hourly 10:30-13:30
});
// Minimum minutes between model reviews of each kind while it keeps making progress.
const SPACING_MINUTES = Object.freeze({ poll: 2, recovery: 2, 'catch-up': 2, slice: 15, obligations: 15 });
// Consecutive model reviews without progress wait 5, 15, 30, then 60 minutes.
const BACKOFF_MINUTES = Object.freeze([5, 15, 30, 60]);
// Hard ceiling on model reviews per Halifax day across every role and outcome: ten slices plus
// recovery, catch-up and obligations with room for backoff retries.
const REVIEW_CEILING = 80;
const MIDNIGHT_CLOSE_MINUTES = 5;
// Enforced daily QuickBooks request budget (Phase 0 meter, UTC day, attempts including unsaved counts).
// 12,000/day is about 360,000/month, under Intuit's 500,000-call Builder allowance. At the budget no new
// discretionary slice is scheduled or admitted; recovery, obligations, calendar closes and continuation are.
const DAILY_REQUEST_BUDGET = 12000;
// requests: the meter summary ({ today: { total } }) or null when it could not be read (treated as reached).
function requestBudget(summary, limit = DAILY_REQUEST_BUDGET) {
  const used = Number(summary?.today?.total);
  if (!summary || summary.unavailable || !Number.isFinite(used)) return { used: null, limit, reached: true, unavailable: true };
  return { used, limit, reached: used >= limit, unavailable: false };
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
// naturally single-use per target and keep the accountant's own identity.
const SLICE_TYPES = new Set(['settled-service-sale', 'paid-operating-expense', 'paid-cash-expense', 'supplier-credit', 'customer-credit', 'customer-refund', 'bank-transfer', 'journal-entry']);
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
const roundHalfUp = value => Math.floor(value + 0.5);
const shortDate = day => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || ''); return match ? MONTHS[Number(match[2]) - 1] + ' ' + Number(match[3]) : null; };
const dayLabel = day => WEEKDAYS[weekdayOf(day)] + ' ' + shortDate(day);
function monthEnd(day) { const [y, m] = day.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }

// One day's rhythm. It is frozen at the day's first evaluation and stored, so a later
// change applies from the next business day and never resets counts mid-day.
function dayRhythm(day, level = 1) {
  const weekday = weekdayOf(day), schedule = weekday === 0 ? null : weekday === 6 ? SCHEDULES.saturday : SCHEDULES.weekday;
  const scale = [0.5, 1, 2].includes(level) ? level : 1, target = schedule ? roundHalfUp(schedule.target * scale) : 0;
  return { version: RHYTHM_VERSION, day, level: scale, target, ceiling: 2 * target, open: schedule ? schedule.open : null, close: schedule ? schedule.close : null, slots: schedule ? schedule.slots.map((minute, index) => ({ n: index + 1, minute })) : [] };
}
function frozenRhythm(state, day) {
  const saved = state?.rhythm;
  // Any rhythm version already frozen for this day is kept, so a code change never resets a day mid-way.
  if (saved && saved.day === day && Number.isSafeInteger(saved.version) && saved.version >= 1 && Array.isArray(saved.slots) && Number.isSafeInteger(saved.target)) return saved;
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
  const count = rhythm.slots.length, sliceCap = count ? 2 * Math.ceil(rhythm.target / count) : 0;
  const plannedOf = run => Number.isSafeInteger(run.createCount) ? run.createCount : Number(run.recordCount) || 0;
  // A prepared slice over the slot allowance can never be approved, so it neither fills its slot nor reserves.
  const oversized = run => run.status === 'previewed' && isSliceKey(run.decisionKey, rhythm) && plannedOf(run) > sliceCap;
  const live = run => run.status !== 'retired' && !(run.status === 'previewed' && !(Number(run.createdAt) > now - PREVIEW_HOLD_MS)) && !oversized(run);
  for (const run of runs) if (!['verified', 'retired'].includes(run.status)) plannedByRun[String(run.id)] = plannedOf(run);
  for (const run of runs) {
    if (['verified', 'retired'].includes(run.status) || !live(run)) continue;
    const planned = plannedOf(run);
    const left = Math.max(0, planned - (savedByRun.get(String(run.id))?.size || 0));
    if (left) { reserved += left; inFlight++; reservedByRun[String(run.id)] = left; }
  }
  const used = saved + reserved, local = localParts(now);
  const slots = rhythm.slots.map(slot => {
    const owned = runs.filter(run => { const value = slotOf(run.decisionKey); return value && value.day === rhythm.day && value.version === rhythm.version && value.n === slot.n; });
    return { n: slot.n, at: new Date(zonedTime(rhythm.day, slot.minute)).toISOString(), expected: roundHalfUp(rhythm.target * slot.n / count), filled: owned.some(live), batches: owned.length };
  });
  const elapsed = inHours(rhythm, local) ? slots.filter(slot => Date.parse(slot.at) <= now).at(-1) || null : null;
  const ceilingReached = used >= rhythm.ceiling;
  // One live batch per slot; a shortfall rolls into the next slot and is never replayed after hours.
  const due = elapsed && !elapsed.filled && used < elapsed.expected && !ceilingReached
    // A late slot never lumps the whole missed day into one slice: at most twice a slot's share.
    ? { n: elapsed.n, records: Math.min(elapsed.expected - used, rhythm.ceiling - used, sliceCap), decisionKey: slotKey(rhythm.day, rhythm.version, elapsed.n, elapsed.batches + 1) } : null;
  const next = slots.find(slot => Date.parse(slot.at) > now) || null;
  // Prepared or unfinished batches of today: a prepared slice is executed, never prepared again.
  const open = runs.filter(run => live(run) && run.status !== 'verified').slice(0, 10).map(run => ({ operationId: String(run.id), status: run.status, decisionKey: run.decisionKey || null }));
  return { day: rhythm.day, label: dayLabel(rhythm.day), rhythmVersion: rhythm.version, target: rhythm.target, ceiling: rhythm.ceiling, saved, verified, reserved, inFlight, byEntity,
    reservedByRun, plannedByRun, sliceCap, open, currentSlot: elapsed ? elapsed.n : null, slotCount: count, remaining: Math.max(0, rhythm.target - used), ceilingReached, businessHours: inHours(rhythm, local), slots, dueSlot: due, nextSlotAt: next ? next.at : null };
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
// (catch-up); due slice. Nothing actionable never calls the model: business hours re-check at
// the owner's interval or the next slot, other hours at the interval, opening or 00:05.
// The daily review ceiling is hard for every kind, owner requests included.
// owned: unfinished operations this agent approved [{ operationId, status, day, agentAuthority, executionPending, completedRecords, disposition }].
// Unsent ones are retired by the worker and ignored here; stranded ones (saved effects outside the slot) hold.
// obligations: due saved obligations { count } (store.dueObligations); actionable during business hours.
// Returns { kind, callModel, nextReviewAt, reason, state } where state is the new durable cadence state.
// requests: requestBudget(...) for today; when reached, no new discretionary slice is scheduled.
function decide({ now, settings = {}, business = {}, agent = {}, today = null, owned = [], obligations = null, requests = null, state = {}, ownerRequested = false, ceiling = REVIEW_CEILING }) {
  const local = localParts(now), day = local.date, interval = Math.max(5, Number(settings.decisionIntervalMinutes) || 60) * MINUTE;
  let s = { ...(state || {}) };
  if (s.day !== day) s = { ...s, day, reviews: 0 };
  const rhythm = frozenRhythm(s, day);s.rhythm = rhythm;
  const signature = progressSignature(business, today, owned, obligations);
  // A review is judged against its own starting point; between reviews, any change (for example
  // queued execution finishing) is progress and clears the backoff.
  if (typeof s.reviewSignature === 'string') { s.misses = s.reviewSignature === signature ? (Number(s.misses) || 0) + 1 : 0; s.reviewSignature = null; }
  else if (typeof s.lastSignature === 'string' && s.lastSignature !== signature) s.misses = 0;
  s.lastSignature = signature;
  const misses = Number(s.misses) || 0, last = Date.parse(s.lastReviewAt || '') || 0;
  const midnight = zonedTime(nextDay(day), MIDNIGHT_CLOSE_MINUTES), tomorrow = zonedTime(nextDay(day), 0);
  const nextOpen = () => { for (let offset = 0; offset < 8; offset++) { const value = shift(day, offset), r = offset ? dayRhythm(value) : rhythm; if (r.open === null) continue; const at = zonedTime(value, r.open); if (at > now) return at; } return now + interval; };
  const result = (kind, callModel, at, reason) => ({ kind, callModel, nextReviewAt: new Date(Math.max(now + (callModel ? 0 : 1000), at)).toISOString(), reason, state: s });
  const capped = (Number(s.reviews) || 0) >= ceiling, limit = 'today’s limit of ' + ceiling + ' reviews is reached; reviews resume after midnight';
  const op = business.currentOperation, blockers = Array.isArray(business.blockers) ? business.blockers : [];
  const ownRuns = (Array.isArray(owned) ? owned : []).filter(run => ownRetained(run, agent) && run.operationId !== op?.operationId && dispositionOf(run) !== 'unsent');
  const behind = nextClose(business, day);

  if (ownerRequested) return capped ? result('ceiling', false, tomorrow, 'you asked for a review, but ' + limit) : result('owner', true, now, 'you asked for a review');
  let kind = null, reason = '';
  if (isActive(op) || ownRuns.some(run => dispositionOf(run) === 'active')) {
    if (s.pollSignature !== signature) { s.pollSignature = signature; s.pollSince = new Date(now).toISOString(); }
    if (now - (Date.parse(s.pollSince) || now) < STALLED_POLL_MS) return result('poll', false, now + SPACING_MINUTES.poll * MINUTE, 'sending records to QuickBooks');
    kind = 'recovery'; reason = 'its current operation has not advanced';
  } else { s.pollSignature = null; s.pollSince = null; }
  if (!kind && op && RETAINED.has(op.status)) {
    if (!ownRetained(op, agent)) return result('held', false, now + interval, 'held by work the accountant did not start');
    kind = 'recovery'; reason = 'finishing its interrupted work';
  }
  // An approved plan that never started holds no calendar slot, so it is found here; it runs
  // before any calendar close, which must never close a date such a plan targets.
  if (!kind && ownRuns.some(run => dispositionOf(run) === 'continue')) { kind = 'recovery'; reason = 'finishing approved work that has not started'; }
  // Stopped outside the calendar slot after saving records: no tool can continue it yet, so no model
  // call; it keeps holding new work (and the calendar) until it is continued.
  if (!kind && ownRuns.some(run => dispositionOf(run) === 'stranded')) return result('held', false, Math.min(now + interval, midnight), 'held: stopped work with saved records needs a recovery capability');
  // Other blockers (uncertain writes, imported history, stops) have no accountant tool yet: no model call.
  if (!kind && blockers.length) {
    return result('held', false, Math.min(now + interval, midnight), 'held: ' + String(blockers[0].title || 'business work is blocked').replace(/^./, c => c.toLowerCase()));
  }
  if (!kind && behind) { kind = 'catch-up'; reason = 'closing ' + shortDate(behind.fromDate) + (behind.throughDate !== behind.fromDate ? '–' + shortDate(behind.throughDate) : ''); }
  const budgetSpent = Boolean(requests?.reached), budgetReason = 'today\u2019s QuickBooks request budget of ' + (requests?.limit ?? DAILY_REQUEST_BUDGET).toLocaleString('en-CA') + ' is used; new activity resumes after midnight UTC';
  if (!kind && today && !today.unavailable && today.dueSlot && !budgetSpent) { kind = 'slice'; reason = 'business hours'; }
  const open = rhythm.open !== null && local.minutes >= rhythm.open && local.minutes < rhythm.close;
  // Due saved obligations are actionable in business hours, spaced and backed off like any review,
  // so an obligation that cannot be settled never loops.
  if (!kind && open && obligations && obligations.count > 0) { kind = 'obligations'; reason = 'settling ' + obligations.count + ' due ' + (obligations.count === 1 ? 'invoice or bill' : 'invoices and bills'); }

  if (kind) {
    const wait = misses > 0 ? Math.max(SPACING_MINUTES[kind], BACKOFF_MINUTES[Math.min(misses, BACKOFF_MINUTES.length) - 1]) : SPACING_MINUTES[kind];
    if (misses > 0) reason += ' · no progress on the last ' + (misses === 1 ? 'review' : misses + ' reviews') + ', waiting ' + wait + ' min';
    if (capped) return result('ceiling', false, tomorrow, limit);
    const earliest = last ? last + wait * MINUTE : now;
    return result(kind, earliest <= now, earliest, reason);
  }
  // Nothing actionable: no model call, only a cheap re-check of saved state.
  const nextSlot = today?.nextSlotAt && !today.unavailable && !today.ceilingReached && today.remaining > 0 && !budgetSpent ? Date.parse(today.nextSlotAt) : Infinity;
  const hours = open;
  const why = capped ? limit : budgetSpent && rhythm.target && today && !today.unavailable && today.remaining > 0 ? budgetReason : !rhythm.target ? '' : today && !today.unavailable ? (today.ceilingReached ? 'today’s activity ceiling is reached' : today.remaining === 0 ? 'today’s activity is in QuickBooks' : '') : '';
  if (hours) {
    const close = zonedTime(day, rhythm.close), check = now + interval;
    return result('idle', false, Math.min(check, nextSlot, close), why || (nextSlot <= check ? 'next activity slot' : 'business hours'));
  }
  return result('quiet', false, Math.min(now + interval, nextOpen(), midnight, nextSlot), why || (rhythm.open === null ? 'closed today' : 'after business hours'));
}
// Every model review (any role, any outcome) counts toward today's ceiling when it starts.
function countReview(state, now) {
  const day = localParts(now).date, s = { ...(state || {}) };
  if (s.day !== day) { s.day = day; s.reviews = 0; }
  return { ...s, reviews: (Number(s.reviews) || 0) + 1 };
}
// A main review also fixes the progress baseline that the next decision compares against.
function beginReview(state, { now, signature, kind }) {
  return { ...countReview(state, now), reviewSignature: signature, lastReviewAt: new Date(now).toISOString(), lastKind: kind };
}
const timeFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hour: 'numeric', minute: '2-digit', hour12: true });
// "2:15 PM" in Halifax time, for text the accountant and the work list read.
const localTime = value => { const ms = typeof value === 'number' ? value : Date.parse(value || ''); return Number.isFinite(ms) ? timeFormat.format(new Date(ms)).replace(/\s*a\.m\./i, ' AM').replace(/\s*p\.m\./i, ' PM') : null; };
// Specialists are read-only reporters: they run in business hours under the same ceiling.
function specialistAllowed({ now, state = {}, ceiling = REVIEW_CEILING }) {
  const local = localParts(now), rhythm = frozenRhythm(state, local.date), reviews = state?.day === local.date ? Number(state.reviews) || 0 : 0;
  if (reviews >= ceiling) return { allowed: false, nextAt: new Date(zonedTime(nextDay(local.date), 0)).toISOString() };
  if (inHours(rhythm, local)) return { allowed: true, nextAt: null };
  for (let offset = 0; offset < 8; offset++) { const value = shift(local.date, offset), r = offset ? dayRhythm(value) : rhythm; if (r.open === null) continue; const at = zonedTime(value, r.open); if (at > now) return { allowed: false, nextAt: new Date(at).toISOString() }; }
  return { allowed: false, nextAt: new Date(now + 86400000).toISOString() };
}

module.exports = { DAILY_REQUEST_BUDGET, requestBudget, ZONE, RHYTHM_VERSION, SCHEDULES, SPACING_MINUTES, BACKOFF_MINUTES, REVIEW_CEILING, PREVIEW_HOLD_MS, STALLED_POLL_MS, SLICE_TYPES,
  localParts, zonedTime, dayRhythm, frozenRhythm, slotKey, slotOf, isSlice, summarizeToday, progressSignature, nextClose, decide, countReview, beginReview, specialistAllowed, shortDate, dayLabel, monthEnd, localTime };
