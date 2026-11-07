'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/modules/business-agent-cadence');

const MIN = 60000;
const agent = { id: 'a'.repeat(24), ownerId: 'b'.repeat(24), grant: { id: 'c'.repeat(64), authorityHash: 'd'.repeat(64) } };
const own = { version: 1, agentId: agent.id, grantId: agent.grant.id, authorityHash: agent.grant.authorityHash, ownerId: agent.ownerId };
const settings = { decisionIntervalMinutes: 60 };
// Halifax wall time -> instant, so every test reads in local business terms.
const at = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return c.zonedTime(day, h * 60 + m); };
const current = (day, extra = {}) => ({ verifiedThrough: require('../src/modules/business-calendar').shift(day, -1), openingDate: '2026-01-01', blockers: [], currentOperation: null, ...extra });
const todayAt = (now, runs = [], receipts = []) => { const day = c.localParts(now).date; return c.summarizeToday({ rhythm: c.dayRhythm(day), runs, receipts, now }); };

test('Halifax time uses real offsets across daylight saving, including the missing and repeated hours', () => {
  assert.equal(new Date(at('2026-10-30', '08:30')).toISOString(), '2026-10-30T11:30:00.000Z', 'ADT is UTC-3');
  assert.equal(new Date(at('2026-12-01', '08:30')).toISOString(), '2026-12-01T12:30:00.000Z', 'AST is UTC-4');
  assert.equal(new Date(at('2027-03-14', '02:30')).toISOString(), '2027-03-14T06:00:00.000Z', 'a slot in the spring-forward gap runs at 03:00');
  assert.equal(new Date(at('2026-11-01', '01:30')).toISOString(), '2026-11-01T04:30:00.000Z', 'the repeated fall-back hour runs once, at its first occurrence');
  assert.deepEqual(c.localParts(Date.parse('2026-10-31T01:30:00Z')), { date: '2026-10-30', minutes: 22 * 60 + 30, seconds: 0, weekday: 5 });
  assert.equal(c.localTime('2026-10-30T17:15:00Z'), '2:15 PM');
});

test('days before v3 keep their own rhythm: weekday, Saturday precedence and a closed Sunday', () => {
  const friday = c.dayRhythm('2026-10-30'), saturday = c.dayRhythm('2026-10-24'), sunday = c.dayRhythm('2026-10-25');
  assert.deepEqual([friday.target, friday.ceiling, friday.slots.length, friday.open, friday.close], [150, 300, 10, 480, 1080]);
  assert.deepEqual([saturday.target, saturday.ceiling, saturday.slots.length, saturday.open, saturday.close], [30, 60, 4, 600, 840]);
  assert.deepEqual([sunday.target, sunday.ceiling, sunday.slots.length, sunday.open], [0, 0, 0, null]);
  assert.equal(c.dayRhythm('2026-10-30', 2).target, 300);assert.equal(c.dayRhythm('2026-10-30', 0.5).target, 75);
  assert.deepEqual(friday.slots.map(slot => slot.minute), [510, 570, 630, 690, 750, 810, 870, 930, 990, 1050], 'hourly slices 08:30-17:30');
  assert.deepEqual(saturday.slots.map(slot => slot.minute), [630, 690, 750, 810], 'hourly slices 10:30-13:30');
  const frozen = { ...friday, target: 12, ceiling: 24 };
  assert.equal(c.frozenRhythm({ rhythm: frozen }, '2026-10-30').target, 12, 'the day keeps its first rhythm');
  assert.equal(c.frozenRhythm({ rhythm: frozen }, '2026-11-02').target, 220, 'a new day takes a new rhythm');
  const v1 = { version: 1, day: '2026-10-30', target: 20, ceiling: 40, open: 480, close: 1080, slots: [{ n: 1, minute: 510 }] };
  assert.equal(c.frozenRhythm({ rhythm: v1 }, '2026-10-30').target, 20, 'a day frozen under an earlier rhythm version keeps it');
});

test('v3: the business runs every hour of every day with a believable hourly shape', () => {
  for (const day of ['2026-10-31', '2026-11-01', '2026-11-03', '2026-11-06']) {
    const r = c.dayRhythm(day);
    assert.deepEqual([r.version, r.target, r.ceiling, r.slots.length, r.open, r.close], [3, 220, 440, 24, 0, 1440], day);
  }
  // Rhythm v4 from 2026-11-07: capacity from the metered budget, flat weights, target = ceiling.
  for (const day of ['2026-11-07', '2026-12-25', '2027-07-04']) {
    const r = c.dayRhythm(day);
    assert.deepEqual([r.version, r.target, r.ceiling, r.slots.length, r.open, r.close], [4, 4900, 4900, 24, 0, 1440], day);
    assert.ok(r.slots.every(slot => slot.weight === 1), day);
  }
  const r = c.dayRhythm('2026-11-01');
  assert.deepEqual(r.slots.map(slot => slot.minute), Array.from({ length: 24 }, (_, hour) => hour * 60 + 30), 'hourly slices 00:30-23:30');
  assert.ok(r.slots.every(slot => slot.weight > 0), 'no hour is ever empty');
  const day = todayAt(at('2026-11-01', '23:45')), share = n => day.slots[n - 1].expected - (n > 1 ? day.slots[n - 2].expected : 0);
  assert.equal(day.slots.at(-1).expected, 220);
  assert.ok(share(12) > share(20) && share(20) > share(3), 'heavier 08:00-18:00, lighter evenings, lightest overnight');
  assert.equal(day.sliceCap, c.HOURLY_CAP, 'one batch, like any rolling hour, carries at most the hourly cap of new records');
  // Today (Oct 31) was frozen under v2 before the switch: it moves to v3 with its saved records kept.
  const v2 = { ...c.dayRhythm('2026-10-24'), day: '2026-10-31' };
  assert.equal(c.frozenRhythm({ rhythm: v2 }, '2026-10-31').version, 3);
  const now = at('2026-10-31', '03:10'), saved = todayAt(now, [{ id: 'v2', status: 'verified', decisionKey: 'slot-20261031-r2-s1', createdAt: now - MIN, createCount: 5 }], Array.from({ length: 5 }, (_, i) => ({ operationId: 'v2', entity: 'invoice', logicalKey: 'k' + i })));
  assert.equal(saved.saved, 5, 'work done under v2 still counts');
  assert.deepEqual(saved.dueSlot, { n: 4, records: 6, decisionKey: 'slot-20261031-r3-s4' }, 'only the v3 shortfall is due, never a repeat');
});

test('v3: obligations and specialists work at any hour', () => {
  const now = at('2026-11-01', '03:10');
  const due = c.decide({ now, settings, agent, today: todayAt(now, [{ id: 'f', status: 'verified', decisionKey: 'slot-20261101-r3-s3', createdAt: now - MIN, createCount: 3 }], Array.from({ length: 30 }, (_, i) => ({ operationId: 'f', entity: 'invoice', logicalKey: 'k' + i }))), obligations: { count: 2 }, state: {}, business: current('2026-11-01') });
  assert.deepEqual([due.kind, due.callModel], ['obligations', true], 'due obligations are settled overnight too');
  assert.equal(c.specialistAllowed({ now, state: {} }).allowed, true);
});

test('today counts unique native create receipts, separating saved from verified, and reserves in-flight work', () => {
  const now = at('2026-10-30', '11:45');
  const runs = [
    { id: 'r1', status: 'verified', decisionKey: c.slotKey('2026-10-30', 2, 1), createdAt: now - 3 * 3600000, createCount: 3 },
    { id: 'r2', status: 'running', decisionKey: c.slotKey('2026-10-30', 2, 2), createdAt: now - 60 * MIN, createCount: 5 },
    { id: 'r3', status: 'retired', decisionKey: 'old-free-key-0001', createdAt: now - 4 * 3600000, createCount: 9 },
    { id: 'r4', status: 'previewed', decisionKey: 'stale-preview-0001', createdAt: now - 3 * 3600000, recordCount: 7 },
  ];
  const receipts = [
    { operationId: 'r1', entity: 'invoice', logicalKey: 'a' }, { operationId: 'r1', entity: 'payment', logicalKey: 'b' }, { operationId: 'r1', entity: 'deposit', logicalKey: 'c' },
    { operationId: 'r1', entity: 'deposit', logicalKey: 'c' }, // a second receipt for the same logical record is one record
    { operationId: 'r2', entity: 'estimate', logicalKey: 'd' }, { operationId: 'r2', entity: 'invoice', logicalKey: 'e' },
  ];
  const today = todayAt(now, runs, receipts);
  assert.deepEqual([today.saved, today.verified, today.reserved, today.inFlight], [5, 3, 3, 1]);
  assert.deepEqual(today.byEntity, { invoice: 2, payment: 1, deposit: 1, estimate: 1 });
  assert.deepEqual(today.reservedByRun, { r2: 3 }, 'retired and long-abandoned previews reserve nothing');
  assert.equal(today.label, 'Fri Oct 30');assert.equal(today.currentSlot, 4);
  assert.deepEqual(today.dueSlot, { n: 4, records: 52, decisionKey: 'slot-20261030-r2-s4' }, 'cumulative expected through slot 4 is 60; 8 are saved or reserved; the rolling hour allows 60');
});

test('batches follow each other while today is behind; each gets the next identity; the rolling hour caps them', () => {
  const now = at('2026-10-30', '10:05');
  assert.deepEqual(todayAt(now, [{ id: 'x', status: 'previewed', decisionKey: c.slotKey('2026-10-30', 2, 2), createdAt: now - MIN, createCount: 3 }]).dueSlot, { n: 2, records: 27, decisionKey: 'slot-20261030-r2-s2-b2' }, 'a prepared batch reserves its records and the rest stays due (the tools execute the prepared one first)');
  assert.equal(todayAt(now, [{ id: 'x', status: 'retired', decisionKey: c.slotKey('2026-10-30', 2, 2), createdAt: now - MIN, createCount: 3 }]).dueSlot.decisionKey, 'slot-20261030-r2-s2-b2');
  assert.deepEqual(c.slotOf('slot-20261030-r1-s2-b2'), { day: '2026-10-30', version: 1, n: 2, batch: 2 });
  assert.equal(c.slotOf('free-form-key'), null);
  // At 16:05 with nothing done the cumulative gap is 120; the rolling hour (1,000) does not bind.
  assert.equal(todayAt(at('2026-10-30', '16:05')).dueSlot.records, 120);
  // A larger (synthetic) day lets the rolling hourly cap bind before the daily ceiling.
  const t = at('2026-10-30', '16:05'), big = { ...c.dayRhythm('2026-10-30'), target: 1500, ceiling: 3000 };
  const hour = c.summarizeToday({ rhythm: big, now: t, runs: [{ id: 'h', status: 'approved', decisionKey: c.slotKey('2026-10-30', 2, 8), createdAt: t - 20 * MIN, createCount: c.HOURLY_CAP }] });
  assert.deepEqual([hour.dueSlot, hour.hourUsed, hour.hourResetAt], [null, c.HOURLY_CAP, new Date(t + 40 * MIN).toISOString()], 'behind, but the hour is full: work continues when the oldest batch leaves the window');
  const capped = c.decide({ now: t, settings, agent, today: hour, state: {}, business: current('2026-10-30') });
  assert.deepEqual([capped.kind, capped.callModel], ['coverage', true], 'with no slice room, the open-hours heartbeat advances coverage');
  assert.equal(todayAt(at('2026-10-30', '07:59')).dueSlot, null, 'nothing is due before business hours');
  assert.equal(todayAt(at('2026-10-30', '18:30')).dueSlot, null, 'a shortfall is not replayed after hours');
  assert.equal(todayAt(at('2026-10-25', '12:00')).dueSlot, null, 'a v2 Sunday has no slices');
  assert.equal(c.isSlice([{ type: 'add-customer' }]), false);
  // Policy v8: discretionary new work is slice work (slot, ceiling and capacity admission); collecting or
  // paying its own open records is an obligation duty, like settling adopted ones.
  for (const type of ['invoice-on-terms', 'bill-on-terms', 'send-estimate', 'convert-own-estimate', 'order-stock']) assert.equal(c.isSlice([{ type }]), true, type);
  for (const type of ['collect-own-invoice', 'pay-own-bill', 'collect-adopted-invoice', 'pay-adopted-bill']) assert.equal(c.isSlice([{ type }]), false, type);assert.equal(c.isSlice([{ type: 'receive-purchase-order' }, { type: 'settled-service-sale' }]), true);
});

test('the daily ceiling is twice the target, counting saved records and reservations', () => {
  const now = at('2026-10-30', '13:10');
  const full = todayAt(now, [{ id: 'r', status: 'verified', decisionKey: 'duty-0001', createdAt: now - MIN, createCount: 300 }], Array.from({ length: 300 }, (_, i) => ({ operationId: 'r', entity: 'payment', logicalKey: 'k' + i })));
  assert.equal(full.ceilingReached, true);assert.equal(full.dueSlot, null);assert.equal(full.remaining, 0);
  const reserved = todayAt(now, [{ id: 'r', status: 'approved', decisionKey: 'duty-0002', createdAt: now - MIN, createCount: 300 }]);
  assert.equal(reserved.ceilingReached, true, 'reserved in-flight work counts toward the ceiling');
});

test('cadence precedence: owner, active execution, recovery, held, slice, coverage, quiet', () => {
  const now = at('2026-10-30', '11:35'), day = '2026-10-30', today = todayAt(now);
  const decide = (extra = {}) => c.decide({ now, settings, agent, today, state: {}, business: current(day), ...extra });
  assert.deepEqual([decide({ ownerRequested: true, business: current(day, { blockers: [{ code: 'calendar-stopped', title: 'Stopped' }] }) }).kind, decide({ ownerRequested: true }).callModel], ['owner', true]);
  const active = decide({ business: current(day, { currentOperation: { operationId: 'o', status: 'running', agentAuthority: own }, blockers: [{ code: 'current-operation' }] }) });
  assert.deepEqual([active.kind, active.callModel, Date.parse(active.nextReviewAt) - now], ['slice', true, 0], 'independent activity is reviewed while execution continues');
  const retained = decide({ business: current(day, { currentOperation: { operationId: 'o', status: 'blocked', agentAuthority: own }, blockers: [{ code: 'current-operation' }] }) });
  assert.deepEqual([retained.kind, retained.callModel], ['recovery', true], 'retained own work gets a recovery review before anything else');
  assert.equal(decide({agent:{...agent,grant:{id:'e'.repeat(64),authorityHash:'f'.repeat(64)}},business:current(day,{currentOperation:{operationId:'o',status:'blocked',agentAuthority:own},blockers:[{code:'current-operation'}]})}).kind,'recovery','renewal keeps same-owner work recoverable');
  const foreign = decide({ business: current(day, { currentOperation: { operationId: 'o', status: 'blocked', agentAuthority: { ...own, ownerId: 'f'.repeat(24) } }, blockers: [{ code: 'current-operation' }] }) });
  assert.deepEqual([foreign.kind, foreign.callModel], ['held', false]);
  const blocked = decide({ business: current(day, { blockers: [{ code: 'uncertain-write', title: 'A QuickBooks request needs recovery' }] }) });
  assert.deepEqual([blocked.kind, blocked.callModel], ['held', false]);assert.match(blocked.reason, /a QuickBooks request needs recovery/);
  const behind = decide({ business: current(day, { verifiedThrough: '2026-10-27' }) });
  assert.equal(behind.kind, 'slice', 'an older verified cursor no longer triggers a catch-up review (monthly close)');
  const slice = decide();assert.deepEqual([slice.kind, slice.callModel, slice.reason], ['slice', true, 'today is 60 records behind schedule']);
  // On schedule through slot 5 (75 expected, 80 in progress): nothing is due, so the coverage heartbeat runs, spaced hourly.
  const noon = at(day, '12:40'), slotRun = [4, 5].map(n => ({ id: 'f' + n, status: 'approved', decisionKey: c.slotKey(day, 2, n), createdAt: noon - 2 * 3600000, createCount: 40 }));
  const waiting = todayAt(noon, slotRun);
  const idle = c.decide({ now: noon, settings, agent, today: waiting, state: { day, lastReviewAt: new Date(noon - 10 * MIN).toISOString() }, business: current(day) });
  assert.deepEqual([idle.kind, idle.callModel, Date.parse(idle.nextReviewAt) - noon], ['coverage', false, 50 * MIN], 'the heartbeat waits for the hourly review spacing');
  const filled = todayAt(now, slotRun);
  const elapsed = decide({ today: filled, state: { day, lastReviewAt: new Date(now - 61 * MIN).toISOString() } });
  assert.deepEqual([elapsed.kind, elapsed.callModel], ['coverage', true], 'with nothing else due, an hour after the last review the coverage heartbeat runs');
  const night = c.decide({ now: at(day, '22:00'), settings, agent, today: todayAt(at(day, '22:00')), state: {}, business: current(day) });
  assert.deepEqual([night.kind, night.callModel, night.reason, Date.parse(night.nextReviewAt) - at(day, '22:00')], ['quiet', false, 'outside that day’s activity hours', 60 * MIN], 'a v2 evening with nothing actionable: no model call');
  const late = c.decide({ now: at(day, '23:30'), settings, agent, today: todayAt(at(day, '23:30')), state: {}, business: current(day) });
  assert.equal(late.nextReviewAt, new Date(at('2026-10-31', '00:05')).toISOString(), 'the wake after midnight closes the day just ended');
});

test('the review ceiling resets at Halifax midnight, and there is no calendar-close review', () => {
  const now = at('2026-10-31', '00:05');
  const close = c.decide({ now, settings, agent, today: todayAt(now), state: { day: '2026-10-30', reviews: 60 }, business: current('2026-10-30') });
  assert.notEqual(close.kind, 'catch-up', 'the daily books check moves the cursor without a model review');
  assert.equal(close.state.reviews, 0, 'the review ceiling resets at Halifax midnight');
  assert.equal(c.decide({ now: at('2026-10-25', '12:00'), settings, agent, today: todayAt(at('2026-10-25', '12:00')), state: {}, business: current('2026-10-25') }).reason, 'no activity was planned that day');
});

test('an execution that stops advancing gets a bounded recovery review', () => {
  const day = '2026-10-30', start = at(day, '09:00'), business = current(day, { currentOperation: { operationId: 'o', status: 'running', agentAuthority: own, completedRecords: 2 }, blockers: [{ code: 'current-operation' }] });
  const first = c.decide({ now: start, settings, agent, business, today: todayAt(start), state: {} });
  assert.equal(first.kind, 'slice');
  const later = c.decide({ now: start + 21 * MIN, settings, agent, business, today: todayAt(start + 21 * MIN), state: first.state });
  assert.deepEqual([later.kind, later.callModel], ['recovery', true]);assert.match(later.reason, /has not advanced/);
});

test('the hard daily review ceiling pauses every review until midnight, including owner requests', () => {
  const day = '2026-10-30', now = at(day, '11:35'), state = { day, reviews: c.REVIEW_CEILING };
  const capped = c.decide({ now, settings, agent, business: current(day, { verifiedThrough: '2026-10-25' }), today: todayAt(now), state });
  assert.deepEqual([capped.kind, capped.callModel, capped.nextReviewAt], ['ceiling', false, new Date(at('2026-10-31', '00:00')).toISOString()]);
  assert.match(capped.reason, /limit of 60 reviews/);
  assert.equal(c.decide({ now, settings, agent, business: current(day), today: todayAt(now), state }).kind, 'ceiling', 'slices and idle reviews are capped too');
  const asked = c.decide({ now, settings, agent, business: current(day), today: todayAt(now), state, ownerRequested: true });
  assert.deepEqual([asked.kind, asked.callModel], ['ceiling', false], 'the ceiling is hard: an owner request at the limit is reported, not run');
  assert.match(asked.reason, /^you asked for a review, but today’s limit of 60 reviews is reached/);
  assert.equal(c.decide({ now, settings, agent, business: current(day, { currentOperation: { operationId: 'o', status: 'blocked', agentAuthority: own }, blockers: [{ code: 'current-operation' }] }), today: todayAt(now), state }).kind, 'ceiling', 'recovery is capped too');
  assert.deepEqual(c.specialistAllowed({ now, state }), { allowed: false, nextAt: new Date(at('2026-10-31', '00:00')).toISOString() }, 'specialists cannot bypass the ceiling');
  assert.equal(c.countReview({ day, reviews: 3 }, now).reviews, 4);
  assert.equal(c.countReview({ day: '2026-10-29', reviews: 59 }, now).reviews, 1);
});

test('specialists run in a day’s activity hours, which are all day from v3', () => {
  assert.equal(c.specialistAllowed({ now: at('2026-10-30', '10:00'), state: {} }).allowed, true);
  assert.deepEqual(c.specialistAllowed({ now: at('2026-10-30', '19:00'), state: {} }), { allowed: false, nextAt: new Date(at('2026-10-31', '00:00')).toISOString() }, 'v3 opens at midnight on Oct 31');
  assert.equal(c.specialistAllowed({ now: at('2026-11-01', '03:00'), state: {} }).allowed, true, 'Sunday overnight is open');
});

test('there is no daily calendar close to catch up (monthly close): nextClose is always null', () => {
  assert.equal(c.nextClose({ verifiedThrough: '2026-09-20' }, '2026-10-30'), null);
  assert.equal(c.nextClose({ verifiedThrough: null, openingDate: '2026-10-01' }, '2026-10-30'), null);
});

// Sol's Phase 1 review (2026-10-30) findings 1, 3 and 5.
test('approved own work that holds no calendar slot is recovered before any calendar close, even overnight', () => {
  const now = at('2026-10-31', '00:05'), approved = { operationId: 'a1', status: 'approved', day: '2026-10-30', agentAuthority: own, executionPending: false };
  const decision = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [approved], state: {} });
  assert.deepEqual([decision.kind, decision.callModel, decision.reason], ['recovery', true, 'finishing approved work that has not started'], 'approved unfinished work is recovered first');
  const queued = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...approved, executionPending: true }], state: {} });
  assert.deepEqual([queued.kind, queued.callModel], ['poll', false], 'queued approved work is polled without a model');
  const foreign = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...approved, agentAuthority: { ...own, ownerId: 'f'.repeat(24) } }], state: {} });
  assert.equal(foreign.kind, 'coverage', 'work under another owner is not this lineage’s recovery');
});
test('progress made between reviews, such as queued execution finishing, clears the backoff', () => {
  const day = '2026-10-30', start = at(day, '09:00'), owned = [{ operationId: 'a1', status: 'approved', day, agentAuthority: own, executionPending: true }];
  const business = current(day), noon = todayAt(start);
  let state = completedReview({ misses: 3 }, { now: start, signature: c.progressSignature(business, noon, owned), kind: 'recovery' });
  const after = c.decide({ now: start + MIN, settings, agent, business, today: noon, owned, state });
  assert.equal(after.state.misses, 4, 'the review itself queued nothing new');
  // Execution then finishes on its own: the run leaves the unfinished list and today's verified count rises.
  const done = c.summarizeToday({ rhythm: c.dayRhythm(day), now: start + 30 * MIN, runs: [{ id: 'a1', status: 'verified', decisionKey: c.slotKey(day, 1, 1), createdAt: start, createCount: 3 }], receipts: [{ operationId: 'a1', entity: 'invoice', logicalKey: 'k1' }, { operationId: 'a1', entity: 'payment', logicalKey: 'k2' }, { operationId: 'a1', entity: 'deposit', logicalKey: 'k3' }] });
  const later = c.decide({ now: start + 30 * MIN, settings, agent, business, today: done, owned: [], state: after.state });
  assert.equal(later.state.misses, 0, 'later recovery or slices do not inherit a long delay after real progress');
});
test('business hours with nothing else due run an hourly-spaced coverage heartbeat; a short owner interval does not shorten it', () => {
  const day = '2026-10-30', now = at(day, '12:40');
  const full = { ...c.summarizeToday({ rhythm: c.dayRhythm(day), now, runs: [{ id: 'r', status: 'verified', decisionKey: 'duty-0001', createdAt: now, createCount: 150 }], receipts: Array.from({ length: 150 }, (_, i) => ({ operationId: 'r', entity: 'payment', logicalKey: 'k' + i })) }), nextSlotAt: null };
  const first = c.decide({ now, settings: { decisionIntervalMinutes: 5 }, agent, business: current(day), today: full, state: {} });
  assert.deepEqual([first.kind, first.callModel], ['coverage', true]);
  const short = c.decide({ now: now + MIN, settings: { decisionIntervalMinutes: 5 }, agent, business: current(day), today: full, state: c.beginReview(first.state, { now, signature: 'x', kind: 'coverage' }) });
  assert.deepEqual([short.kind, short.callModel, Date.parse(short.nextReviewAt) - now], ['coverage', false, 60 * MIN]);
});

// GPT-6.1 Sol round-2 review (2026-10-30) findings 1 and 4.
test('stranded work with saved effects holds without a model call; unsent work is left to governed retirement', () => {
  const now = at('2026-10-31', '00:05'), base = { operationId: 's1', status: 'stopped', day: '2026-10-30', agentAuthority: own, executionPending: false, holdsSlot: false };
  const stranded = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...base, disposition: 'stranded' }], state: {} });
  assert.deepEqual([stranded.kind, stranded.callModel], ['held', false], 'no recovery loop for work no tool can continue');
  assert.match(stranded.reason, /stopped work with saved records/);
  const unsent = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...base, disposition: 'unsent' }], state: {} });
  assert.equal(unsent.kind, 'coverage', 'unsent work does not block once the worker retires it');
  const queueable = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...base, status: 'approved', disposition: 'continue' }], state: {} });
  assert.equal(queueable.kind, 'recovery');
});
test('due obligations are actionable in business hours, spaced and backed off, and never overnight', () => {
  const day = '2026-10-30', now = at(day, '09:10'), obligations = { count: 3 }, business = current(day);
  const full = { ...c.summarizeToday({ rhythm: c.dayRhythm(day), now, runs: [{ id: 'r', status: 'verified', decisionKey: 'duty-0001', createdAt: now, createCount: 150 }], receipts: Array.from({ length: 150 }, (_, i) => ({ operationId: 'r', entity: 'payment', logicalKey: 'k' + i })) }), nextSlotAt: null };
  const signature = c.progressSignature(business, full, [], obligations);
  const due = c.decide({ now, settings, agent, business, today: full, obligations, state: {} });
  assert.deepEqual([due.kind, due.callModel, due.reason], ['obligations', true, 'settling 3 due invoices and bills'], 'the calendar is current and today is full, yet due obligations still get a review');
  let clock = now, next = c.decide({ now: now + MIN, settings, agent, business, today: full, obligations, state: completedReview(due.state, { now, signature, kind: 'obligations' }) });
  for (const wait of [60, 60, 60, 60]) {
    assert.deepEqual([next.callModel, Date.parse(next.nextReviewAt) - clock], [false, wait * MIN], 'an obligation that cannot be settled waits max(hourly spacing, 15/30/60 backoff)');
    clock = Date.parse(next.nextReviewAt);
    const ready = c.decide({ now: clock, settings, agent, business, today: full, obligations, state: next.state });
    assert.equal(ready.callModel, true);
    next = c.decide({ now: clock + MIN, settings, agent, business, today: full, obligations, state: completedReview(ready.state, { now: clock, signature, kind: 'obligations' }) });
  }
  const settled = c.decide({ now: Date.parse(next.nextReviewAt), settings, agent, business, today: full, obligations: { count: 2 }, state: next.state });
  assert.equal(settled.state.misses, 0, 'settling one counts as progress');
  const night = c.decide({ now: at(day, '22:00'), settings, agent, business, today: full, obligations, state: {} });
  assert.deepEqual([night.kind, night.callModel], ['quiet', false]);
});

// GPT-6.1 Sol final review (2026-10-30): per-slice allowance and the enforced daily request budget.
test('an oversized prepared slice neither fills its slot nor reserves, so a smaller batch can take the slot', () => {
  const now = at('2026-10-30', '08:40');
  const oversized = c.HOURLY_CAP + 1;
  const today = todayAt(now, [{ id: 'big', status: 'previewed', decisionKey: c.slotKey('2026-10-30', 2, 1), createdAt: now - MIN, createCount: oversized }]);
  assert.equal(today.sliceCap, c.HOURLY_CAP, 'one batch carries at most the hourly cap of new records');
  assert.deepEqual(today.plannedByRun, { big: oversized }, 'planned native creates come from the saved plan');
  assert.equal(today.reserved, 0);
  assert.deepEqual(today.dueSlot, { n: 1, records: 15, decisionKey: 'slot-20261030-r2-s1-b2' });
  assert.equal(c.dayRhythm('2026-10-24').slots.length && todayAt(at('2026-10-24', '10:40')).sliceCap, c.HOURLY_CAP, 'the same limit on a v2 Saturday');
});
// Sync tuning (2026-10-31): only metered (CorePlus) categories count; sync never starves activity.
const meter = (today = {}, month = today) => ({ today: { attempts: { sync: 0, read: 0, query: 0, report: 0, write: 0, ...today } }, month: { attempts: { sync: 0, read: 0, query: 0, report: 0, write: 0, ...month } } });
test('the request budget counts metered reads, queries and reports daily, never writes, and sync only toward the monthly guard', () => {
  // An explicit daily limit; without one the limit is derived from the remaining monthly guard.
  const fixed = { limit: c.DAILY_REQUEST_BUDGET };
  const spent = c.requestBudget(meter({ read: 6000, query: 2000, report: 2000, sync: 1700, write: 900 }, { read: 60000, query: 20000, report: 20000, sync: 17000, write: 9000 }), fixed);
  assert.deepEqual([spent.used, spent.limit, spent.reached, spent.scope, spent.sync, spent.meteredToday, spent.meteredMonth, spent.allowance], [10000, 10000, true, 'day', 1700, 11700, 117000, 500000]);
  assert.equal(c.requestBudget(meter({ read: 9999, write: 50000 }), fixed).reached, false, 'writes (Core data-in calls) are not metered');
  assert.equal(c.requestBudget(meter({ read: 10, sync: 40000 }), fixed).reached, false, 'background sync cannot use up the activity budget');
  const monthly = c.requestBudget(meter({ read: 10 }, { sync: 60000, read: 390000, write: 100000 }));
  assert.deepEqual([monthly.reached, monthly.scope, monthly.meteredMonth], [true, 'month', 450000]);
  assert.equal(c.requestBudget(meter({}, { read: 449999 }), fixed).reached, false, 'one below the monthly guard');
  for (const unreadable of [null, { unavailable: true }, { today: { total: 0 } }, { today: { attempts: { sync: 0, read: 0, query: 0, report: 0 } } }, meter({ read: 'x' })]) assert.deepEqual([c.requestBudget(unreadable).reached, c.requestBudget(unreadable).unavailable], [true, true], 'an unreadable count stops new slices (fail closed)');
  assert.ok(31 * (c.DAILY_REQUEST_BUDGET + c.EXPECTED_DAILY_SYNC) < c.MONTHLY_METERED_BUDGET && c.MONTHLY_METERED_BUDGET < c.FREE_MONTHLY_ALLOWANCE, 'daily limits fit the month with headroom under the free allowance');
  assert.match(c.requestBudgetReason(monthly), /^this month’s metered QuickBooks requests reached the 450,000 guard \(450,000 of the 500,000 free allowance\); new sales and expenses resume next month \(UTC\); recovery/);
});
test('the daily QuickBooks request budget stops discretionary slices only, with a visible reason', () => {
  const day = '2026-10-30', now = at(day, '11:35'), fixed = { limit: c.DAILY_REQUEST_BUDGET }, spent = c.requestBudget(meter({ read: c.DAILY_REQUEST_BUDGET }), fixed);
  assert.equal(spent.reached, true);
  assert.equal(c.requestBudget(meter({ read: 9999 }), fixed).reached, false);
  assert.equal(c.requestBudget(null).reached, true, 'an unreadable count stops new slices (fail closed)');
  const slice = c.decide({ now, settings, agent, business: current(day), today: todayAt(now), requests: spent, state: {} });
  assert.deepEqual([slice.kind, slice.callModel], ['idle', false]);
  assert.match(slice.reason, /QuickBooks request budget of 10,000 is used \(10,000 reads, queries and reports; sync and writes are not counted\); new sales and expenses resume after midnight UTC$/);
  assert.equal(c.decide({ now, settings, agent, business: current(day, { verifiedThrough: '2026-10-27' }), today: todayAt(now), requests: spent, state: {} }).kind, 'idle', 'unknown local work identity rechecks without another model');
  assert.equal(c.decide({ now, settings, agent, business: current(day, { currentOperation: { operationId: 'o', status: 'blocked', agentAuthority: own }, blockers: [{ code: 'current-operation' }] }), today: todayAt(now), requests: spent, state: {} }).kind, 'recovery', 'recovery continues');
  assert.equal(c.decide({ now, settings, agent, business: current(day), today: todayAt(now), obligations: { count: 2 }, requests: spent, state: {} }).kind, 'idle', 'unknown duty identity rechecks locally');
});

function completedReview(state, options) { return c.finishReview(c.beginReview(state, options)); }
test('an interrupted review does not add a no-progress miss, but completed reviews still do',()=>{
 const now=Date.parse('2026-10-31T15:00:00Z'), business={openingDate:'2026-10-01',verifiedThrough:'2026-10-29'}, signature=c.progressSignature(business,null);
 const pending=c.beginReview({misses:1},{now,signature,kind:'catch-up'});
 const interrupted=c.decide({now:now+60000,business,state:pending});
 assert.equal(interrupted.state.misses,1);assert.equal(interrupted.state.reviews,1);
 const terminal=c.decide({now:now+60000,business,state:c.finishReview(pending)});assert.equal(terminal.state.misses,2);
 const progressed=c.decide({now:now+60000,business:{...business,verifiedThrough:'2026-10-30'},state:pending});assert.equal(progressed.state.misses,0);
});

// Job E: independent activity, scoped failure streaks and bounded concurrency.
test('a blocked recovery does not delay an independent slice, but company-wide holds still apply',()=>{
 const day='2026-10-31',now=at(day,'14:00'),business=current(day,{currentOperation:{operationId:'stuck',status:'blocked',agentAuthority:own},blockers:[{code:'current-operation'},{code:'uncertain-write'}]});
 const input={now,settings,agent,business,today:todayAt(now),state:{day,lastKind:'recovery',misses:20,lastReviewAt:new Date(now-MIN).toISOString()}};
 const next=c.decide(input);assert.deepEqual([next.kind,next.callModel],['slice',false]);assert.doesNotMatch(next.reason,/no progress/);
 assert.equal(Date.parse(next.nextReviewAt),now-MIN+c.SPACING_MINUTES.slice*MIN,'the slice keeps its own spacing from the last review, not the recovery backoff');
 for(const code of ['calendar-stopped','coordination-paused','population-owned','completion-pending']){
  const held=c.decide({...input,business:{...business,currentOperation:null,blockers:[{code}]},owned:[]});assert.equal(held.kind,'held',code);
 }
 const spent=c.decide({...input,requests:{reached:true,unavailable:true}});assert.equal(spent.kind,'recovery');
});
test('only consecutive failures of the same review and failure kind back off, never below the review spacing',()=>{
 const day='2026-10-31',now=at(day,'14:00'),business=current(day),today=todayAt(now),signature=c.progressSignature(business,today);
 let state={day,misses:9,missKind:'recovery:failed',lastKind:'recovery'};
 state=completedReview(state,{now,signature,kind:'slice'});
 let next=c.decide({now:now+MIN,settings,agent,business,today,state});assert.equal(next.state.misses,1);assert.equal(Date.parse(next.nextReviewAt)-now,50*MIN);
 state=c.finishReview(c.beginReview(next.state,{now:now+5*MIN,signature,kind:'slice'}),{failureKind:'provider-timeout'});
 next=c.decide({now:now+6*MIN,settings,agent,business,today,state});assert.equal(next.state.misses,1,'different failure category resets the streak');
 // wait = max(50-minute slice spacing, 15/30/60 backoff); no five-minute cap behind target.
 for(const wait of [50,60,60,60,60]){
  const start=Date.parse(next.nextReviewAt);state=c.finishReview(c.beginReview(next.state,{now:start,signature,kind:'slice'}),{failureKind:'provider-timeout'});
  next=c.decide({now:start+MIN,settings,agent,business,today,state});assert.equal(Date.parse(next.nextReviewAt)-start,wait*MIN);
 }
});
test('up to three prepared, queued or executing operations reserve capacity without exceeding record limits',()=>{
 const day='2026-10-31',now=at(day,'17:00'),make=(id,status,n=3)=>({id,status,decisionKey:c.slotKey(day,3,17,Number(id)+1),createdAt:now-MIN,createCount:n});
 const runs=[make('1','previewed'),make('2','approved'),make('3','running')];
 for(let n=0;n<3;n++){const today=todayAt(now,runs.slice(0,n));assert.equal(today.inFlight,n);assert.ok(today.dueSlot);assert.ok(today.dueSlot.records+today.hourUsed<=c.HOURLY_CAP);assert.ok(today.dueSlot.records+today.saved+today.reserved<=today.ceiling);}
 const full=todayAt(now,runs);assert.equal(full.inFlight,3);assert.equal(full.inFlightLimit,3);assert.equal(full.dueSlot,null);
 const done=todayAt(now,[...runs.slice(0,2),{...runs[2],status:'verified'}],[{operationId:'3',entity:'Invoice',logicalKey:'saved'}]);assert.equal(done.inFlight,2);assert.ok(done.dueSlot);
 const savedButVerifying=todayAt(now,[make('1','running',1)],[{operationId:'1',entity:'Invoice',logicalKey:'saved'}]);assert.equal(savedButVerifying.inFlight,1,'verification in progress still occupies its operation slot');
 const v4day='2026-11-10',t4=at(v4day,'17:00'),capped=todayAt(t4,[{id:'1',status:'approved',decisionKey:c.slotKey(v4day,4,18),createdAt:t4-MIN,createCount:c.HOURLY_CAP}]);assert.deepEqual([capped.hourUsed,capped.dueSlot],[c.HOURLY_CAP,null],'the hourly limit still stops a second operation');
});

test('general batches use the rolling hour regardless of decision key and prepared plans do not expire',()=>{
 const day='2026-10-31',now=at(day,'16:00');
 const batch={id:'general',status:'prepared',decisionKey:'arbitrary-decision-key',hourlyActivity:true,createdAt:now-31*MIN,createCount:c.HOURLY_CAP};
 // A larger (synthetic) day so the rolling hourly cap binds before the daily ceiling.
 const today=c.summarizeToday({rhythm:{...c.dayRhythm(day),target:3000,ceiling:6000},runs:[batch],now});assert.equal(today.inFlight,1);assert.equal(today.hourUsed,c.HOURLY_CAP);assert.equal(today.dueSlot,null);assert.equal(today.hourResetAt,new Date(now+29*MIN).toISOString());
});
test('eligible collections receive an independent obligations review even when no slice is due',()=>{
 const day='2026-10-31',now=at(day,'16:00'),business=current(day,{currentOperation:{operationId:'stuck',status:'blocked',agentAuthority:own},blockers:[{code:'current-operation'}],collectionReadiness:{eligibleInvoiceCount:6,reusableDecisionKeys:['cleared']}});
 const today={...todayAt(now),dueSlot:null,remaining:0};
 const next=c.decide({now,settings,agent,business,today,state:{day,lastKind:'recovery',misses:9,lastReviewAt:new Date(now-MIN).toISOString()}});
 assert.deepEqual([next.kind,next.callModel],['obligations',false]);assert.match(next.reason,/currently eligible/);assert.doesNotMatch(next.reason,/no progress/);
 assert.equal(Date.parse(next.nextReviewAt),now-MIN+c.SPACING_MINUTES.obligations*MIN,'spaced from the last review, without the recovery backoff');
});

test('a failed earlier close alternates with today activity while the cursor remains unverified', () => {
  const day = '2026-11-02', now = at(day, '12:00');
  const business = current(day, { verifiedThrough: '2026-10-31', blockers: [{ code: 'current-operation' }], currentOperation: { operationId: 'close-day-n', status: 'awaiting-evidence', agentAuthority: own } });
  const today = todayAt(now), state = completedReview({}, { now: now - 10 * MIN, signature: c.progressSignature(business, today), kind: 'recovery' });
  const next = c.decide({ now, settings, agent, business, today, state });
  assert.equal(next.kind, 'slice'); assert.equal(next.callModel, false, 'the slice waits its spacing from the last review');
  assert.equal(Date.parse(next.nextReviewAt), now - 10 * MIN + c.SPACING_MINUTES.slice * MIN); assert.doesNotMatch(next.reason, /no progress/);
  assert.equal(c.nextClose(business, day), null); assert.equal(business.verifiedThrough, '2026-10-31');
});
test('audited unsent remainder is actionable between activity slots without replaying saved work',()=>{
 const day='2026-11-01',now=at(day,'20:20'),today={...todayAt(now),dueSlot:null,remaining:0,saved:220,inFlight:0,open:[]};
 const recovery={state:'replan-remaining',agentId:agent.id,ownerId:agent.ownerId,operationId:'original',saved:[{entity:'Payment',qboId:'501'}],remaining:[{entity:'Deposit',ref:'unsent'}]};
 const business=current(day,{errorBlockers:[{recovery}]});
 const result=c.decide({now,settings,business,today,agent});assert.equal(result.kind,'recovery');assert.equal(result.callModel,true);assert.match(result.reason,/replanning unsent work/);
 for(const mode of ['already-recovered','unknown-diagnostics','wrong-agent','manual-owner-work','request-budget','day-limit']){
  const b=structuredClone(business),input={now,settings,business:b,today,agent};
  if(mode==='already-recovered')b.errorBlockers=[];if(mode==='unknown-diagnostics')b.diagnosticsUnavailable=true;if(mode==='wrong-agent')b.errorBlockers[0].recovery.agentId='other';if(mode==='manual-owner-work')b.errorBlockers[0].recovery.agentId=null;if(mode==='request-budget')input.requests={reached:true};if(mode==='day-limit'){input.ceiling=1;input.state={day,reviews:1};}
  // Without an eligible remainder, nothing else is due: only the coverage heartbeat (or a budget/ceiling pause).
  const d=c.decide(input);assert.notEqual(d.kind,'recovery',mode);if(['request-budget','day-limit'].includes(mode))assert.equal(d.callModel,false,mode);else assert.equal(d.kind,'coverage',mode);if(mode==='request-budget')assert.match(d.reason,/unsent remainder is waiting/);
 }
 const throttled=c.decide({now,settings,business,today,agent,state:{day,reviews:1,lastKind:'recovery',lastReviewAt:new Date(now).toISOString(),misses:3}});assert.equal(throttled.kind,'recovery');assert.equal(throttled.callModel,false);assert.match(throttled.reason,/waiting/);
 const slice=c.decide({now,settings,business,today:{...today,remaining:20,behind:20,dueSlot:{records:20},inFlight:0},agent,state:{day,lastKind:'recovery',misses:1,lastReviewAt:new Date(now-10*MIN).toISOString()}});assert.equal(slice.kind,'slice');
});

function budgetFixture(extra={}){const day='2026-11-04',now=Date.parse('2026-11-04T20:30:00Z');return{now,settings,agent,business:current(day,{verifiedThrough:'2026-11-02',collectionReadiness:{eligibleInvoices:[],eligibleInvoiceCount:0,eligibleBalanceCents:0,reusableDecisionKeys:[],readyForNewBatch:true}}),today:todayAt(now),obligations:{count:1,budgetIdentityHash:'1'.repeat(64)},requests:{reached:true,scope:'day',used:10057,limit:10000},state:{},...extra};}
test('budget hold consumes changed-work identity only when the main review actually starts',()=>{
 const input=budgetFixture(),first=c.decide(input);assert.equal(first.kind,'obligations');assert.equal(first.callModel,true);assert.equal(first.state.budgetReviewedIdentity,undefined);
 const persisted=c.decide({...input,state:first.state});assert.equal(persisted.callModel,true,'decide persistence does not consume allowance');
 const begun=c.beginReview(first.state,{now:input.now,signature:c.progressSignature(input.business,input.today,[],input.obligations),kind:first.kind}),next=c.decide({...input,now:input.now+31*MIN,state:c.finishReview(begun)});
 assert.equal(next.callModel,false);assert.equal(next.kind,'idle');assert.match(next.reason,/unchanged|changed work/);assert.ok(begun.budgetReviewedIdentity);
});
test('budget candidate survives backoff, review ceiling and simulated usage hold before actual due wake',()=>{
 const input=budgetFixture(),state={day:'2026-11-04',lastKind:'obligations',lastReviewAt:new Date(input.now).toISOString(),misses:2,missKind:'obligations:no-progress'},waiting=c.decide({...input,state});assert.equal(waiting.callModel,false);assert.equal(waiting.state.budgetReviewedIdentity,undefined);
 const capped=c.decide({...input,state:{...waiting.state,reviews:c.REVIEW_CEILING}});assert.equal(capped.callModel,false);assert.equal(capped.state.budgetReviewedIdentity,undefined);
 const due=c.decide({...input,now:input.now+61*MIN,state:waiting.state});assert.equal(due.callModel,true);const usageHeld=c.decide({...input,now:input.now+62*MIN,state:due.state});assert.equal(usageHeld.callModel,true,'usage hold never calls beginReview');assert.equal(usageHeld.state.budgetReviewedIdentity,undefined);
});

function budgetReviewed(input){const d=c.decide(input);return c.finishReview(c.beginReview(d.state,{now:input.now,signature:c.progressSignature(input.business,input.today,input.owned||[],input.obligations),kind:d.kind}));}
test('budget-only identity includes complete duty targets and sorted collection readiness without sync timestamps',()=>{
 const input=budgetFixture(),ready={eligibleInvoices:[{invoiceId:'17',balanceCents:100},{invoiceId:'18',balanceCents:200}],eligibleInvoiceCount:2,eligibleBalanceCents:300,reusableDecisionKeys:['key-b','key-a'],readyForNewBatch:true};input.business.collectionReadiness=ready;
 const original=c.budgetWorkIdentity(input.business,input.today,[],input.obligations),reordered=structuredClone(input.business);reordered.collectionReadiness.eligibleInvoices.reverse();reordered.collectionReadiness.reusableDecisionKeys.reverse();reordered.sync={lastSuccessAt:'2026-11-04T23:00:00Z'};reordered.bookChecks={observedAt:'2026-11-04T23:00:00Z'};assert.equal(c.budgetWorkIdentity(reordered,input.today,[],input.obligations),original);
 const state=budgetReviewed(input);for(const mutate of [i=>i.obligations.budgetIdentityHash='2'.repeat(64),i=>i.business.collectionReadiness.eligibleInvoices[0].invoiceId='19',i=>{i.business.collectionReadiness.eligibleInvoices[0].balanceCents++;i.business.collectionReadiness.eligibleBalanceCents++;},i=>i.business.collectionReadiness.reusableDecisionKeys.push('key-c'),i=>i.business.collectionReadiness.readyForNewBatch=false,i=>i.business.errorBlockers=[{code:'proof',operationId:'op',recovery:{state:'ready',evidenceHash:'new-proof'}}]]){const changed=structuredClone(input);changed.now+=61*MIN;changed.state=state;mutate(changed);const d=c.decide(changed);assert.equal(d.callModel,true);assert.equal(d.state.budgetReviewedIdentity,state.budgetReviewedIdentity,'changed candidate is not consumed by decision');}
});
test('unknown or truncated budget work is an explicit local recheck, never unchanged proof',()=>{
 for(const change of [i=>delete i.obligations.budgetIdentityHash,i=>i.obligations=null,i=>i.requests.unavailable=true,i=>i.business.collectionReadiness={unavailable:true},i=>i.business.collectionReadiness.eligibleInvoiceCount=61,i=>i.business.collectionReadiness.eligibleBalanceCents=999]){const input=budgetFixture();change(input);const d=c.decide(input);assert.equal(d.callModel,false);assert.equal(d.kind,'idle');if(input.obligations)assert.match(d.reason,/unknown/);// no duty count: no duty review, only the budget recheck
assert.equal(d.state.budgetCandidateIdentity,null);assert.ok(Date.parse(d.nextReviewAt)<=input.now+15*MIN);}
});
test('budget hold preserves owner instructions, bounded management, active polls and accepted recovery',()=>{
 const input=budgetFixture(),state=budgetReviewed(input),later={...input,now:input.now+c.SPACING_MINUTES.recovery*MIN,state};assert.equal(c.decide({...later,ownerRequested:true}).kind,'owner');assert.equal(c.decide({...later,ownerRequested:true}).callModel,true);
 const managed=c.decide({...later,management:{lastPlanDay:'2026-11-03'}});assert.equal(managed.kind,'management');assert.equal(managed.callModel,true);
 const active=budgetFixture();active.business.currentOperation={operationId:'active',status:'running',agentAuthority:own};active.obligations.count=1;const activeState=budgetReviewed(active),poll=c.decide({...active,now:active.now+MIN,state:activeState});assert.equal(poll.kind,'poll');assert.equal(poll.callModel,false);assert.equal(Date.parse(poll.nextReviewAt),active.now+3*MIN);
 const recovering=c.decide({...later,business:{...input.business,currentOperation:{operationId:'retained',status:'blocked',agentAuthority:own},blockers:[{code:'current-operation'}]}});assert.equal(recovering.kind,'recovery');assert.equal(recovering.callModel,true);
});
test('UTC reset is a scheduled wake, never permission while the meter remains reached',()=>{
 const input=budgetFixture(),state=budgetReviewed(input),near={...input,now:Date.parse('2026-11-04T23:59:50Z'),state};const held=c.decide(near);assert.equal(held.nextReviewAt,'2026-11-05T00:00:00.000Z');
 const reset=c.decide({...near,now:Date.parse('2026-11-05T00:00:01Z'),state:held.state});assert.equal(reset.callModel,false);const reopened=c.decide({...near,now:Date.parse('2026-11-05T00:00:01Z'),requests:{reached:false},state:held.state});assert.equal(reopened.kind,'slice','normal under-budget cadence resumes the genuinely due independent activity');assert.equal(reopened.callModel,true);
 const monthly=c.decide({...near,now:Date.parse('2026-11-30T23:59:50Z'),requests:{...input.requests,scope:'month',monthlyLimit:450000,meteredMonth:450000},state});assert.equal(monthly.nextReviewAt,'2026-12-01T00:00:00.000Z');assert.equal(monthly.callModel,false);
});

test('under-budget progress identity and record accounting source are unchanged',()=>{
 const fs=require('node:fs'),path=require('node:path'),original=fs.readFileSync(path.join(process.cwd(),'backend/src/modules/business-agent-cadence.js'),'utf8'),candidate=fs.readFileSync(path.join(__dirname,'../src/modules/business-agent-cadence.js'),'utf8');
 const progress=source=>source.slice(source.indexOf('function progressSignature('),source.indexOf('// A run’s disposition')<0?source.indexOf('// A run\'s disposition'):source.indexOf('// A run’s disposition'));assert.equal(progress(candidate),progress(original));
 const summary=source=>source.slice(source.indexOf('function summarizeToday('),source.indexOf('// Progress means'));assert.equal(summary(candidate),summary(original));
 const sourceStore=fs.readFileSync(path.join(process.cwd(),'backend/src/modules/business-agent-store.js'),'utf8'),candidateStore=fs.readFileSync(path.join(__dirname,'../src/modules/business-agent-store.js'),'utf8'),today=source=>source.slice(source.indexOf('  async function todayActivity('),source.indexOf('  // Display/review evidence only;'));assert.equal(today(candidateStore),today(sourceStore));
});
