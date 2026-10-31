'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/modules/business-agent-cadence');

const MIN = 60000;
const agent = { id: 'agent', grant: { id: 'g'.repeat(64), authorityHash: 'h'.repeat(64) } };
const own = { version: 1, agentId: 'agent', grantId: agent.grant.id, authorityHash: agent.grant.authorityHash, ownerId: 'o' };
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

test('each day has its own rhythm: weekday, Saturday precedence and a closed Sunday', () => {
  const friday = c.dayRhythm('2026-10-30'), saturday = c.dayRhythm('2026-10-31'), sunday = c.dayRhythm('2026-11-01');
  assert.deepEqual([friday.target, friday.ceiling, friday.slots.length, friday.open, friday.close], [150, 300, 10, 480, 1080]);
  assert.deepEqual([saturday.target, saturday.ceiling, saturday.slots.length, saturday.open, saturday.close], [30, 60, 4, 600, 840]);
  assert.deepEqual([sunday.target, sunday.ceiling, sunday.slots.length, sunday.open], [0, 0, 0, null]);
  assert.equal(c.dayRhythm('2026-10-30', 2).target, 300);assert.equal(c.dayRhythm('2026-10-30', 0.5).target, 75);
  assert.deepEqual(friday.slots.map(slot => slot.minute), [510, 570, 630, 690, 750, 810, 870, 930, 990, 1050], 'hourly slices 08:30-17:30');
  assert.deepEqual(saturday.slots.map(slot => slot.minute), [630, 690, 750, 810], 'hourly slices 10:30-13:30');
  const frozen = { ...friday, target: 12, ceiling: 24 };
  assert.equal(c.frozenRhythm({ rhythm: frozen }, '2026-10-30').target, 12, 'the day keeps its first rhythm');
  assert.equal(c.frozenRhythm({ rhythm: frozen }, '2026-11-02').target, 150, 'a new day takes a new rhythm');
  const v1 = { version: 1, day: '2026-10-30', target: 20, ceiling: 40, open: 480, close: 1080, slots: [{ n: 1, minute: 510 }] };
  assert.equal(c.frozenRhythm({ rhythm: v1 }, '2026-10-30').target, 20, 'a day frozen under an earlier rhythm version keeps it');
});

test('today counts unique native create receipts, separating saved from verified, and reserves in-flight work', () => {
  const now = at('2026-10-30', '11:45');
  const runs = [
    { id: 'r1', status: 'verified', decisionKey: c.slotKey('2026-10-30', c.RHYTHM_VERSION, 1), createdAt: now - 3 * 3600000, createCount: 3 },
    { id: 'r2', status: 'running', decisionKey: c.slotKey('2026-10-30', c.RHYTHM_VERSION, 2), createdAt: now - 60 * MIN, createCount: 5 },
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
  assert.deepEqual(today.dueSlot, { n: 4, records: 30, decisionKey: 'slot-20261030-r2-s4' }, 'cumulative expected through slot 4 is 60; 8 are saved or reserved; one slice carries at most 30');
});

test('one live batch per slot; a retired slot batch gets the next identity; late slices are capped', () => {
  const now = at('2026-10-30', '10:05');
  assert.equal(todayAt(now, [{ id: 'x', status: 'previewed', decisionKey: c.slotKey('2026-10-30', c.RHYTHM_VERSION, 2), createdAt: now - MIN, createCount: 3 }]).dueSlot, null, 'a prepared slot batch fills the slot');
  assert.equal(todayAt(now, [{ id: 'x', status: 'retired', decisionKey: c.slotKey('2026-10-30', c.RHYTHM_VERSION, 2), createdAt: now - MIN, createCount: 3 }]).dueSlot.decisionKey, 'slot-20261030-r2-s2-b2');
  assert.deepEqual(c.slotOf('slot-20261030-r1-s2-b2'), { day: '2026-10-30', version: 1, n: 2, batch: 2 });
  assert.equal(c.slotOf('free-form-key'), null);
  // At 16:05 with nothing done the cumulative gap is 120, but one slice carries at most twice a slot's share.
  assert.equal(todayAt(at('2026-10-30', '16:05')).dueSlot.records, 30);
  assert.equal(todayAt(at('2026-10-30', '07:59')).dueSlot, null, 'nothing is due before business hours');
  assert.equal(todayAt(at('2026-10-30', '18:30')).dueSlot, null, 'a shortfall is not replayed after hours');
  assert.equal(todayAt(at('2026-11-01', '12:00')).dueSlot, null, 'Sunday has no slices');
  assert.equal(c.isSlice([{ type: 'add-customer' }]), false);assert.equal(c.isSlice([{ type: 'receive-purchase-order' }, { type: 'settled-service-sale' }]), true);
});

test('the daily ceiling is twice the target, counting saved records and reservations', () => {
  const now = at('2026-10-30', '13:10');
  const full = todayAt(now, [{ id: 'r', status: 'verified', decisionKey: 'duty-0001', createdAt: now - MIN, createCount: 300 }], Array.from({ length: 300 }, (_, i) => ({ operationId: 'r', entity: 'payment', logicalKey: 'k' + i })));
  assert.equal(full.ceilingReached, true);assert.equal(full.dueSlot, null);assert.equal(full.remaining, 0);
  const reserved = todayAt(now, [{ id: 'r', status: 'approved', decisionKey: 'duty-0002', createdAt: now - MIN, createCount: 300 }]);
  assert.equal(reserved.ceilingReached, true, 'reserved in-flight work counts toward the ceiling');
});

test('cadence precedence: owner, active execution, recovery, held, catch-up, slice, idle, quiet', () => {
  const now = at('2026-10-30', '11:35'), day = '2026-10-30', today = todayAt(now);
  const decide = (extra = {}) => c.decide({ now, settings, agent, today, state: {}, business: current(day), ...extra });
  assert.deepEqual([decide({ ownerRequested: true, business: current(day, { blockers: [{ code: 'calendar-stopped', title: 'Stopped' }] }) }).kind, decide({ ownerRequested: true }).callModel], ['owner', true]);
  const active = decide({ business: current(day, { currentOperation: { operationId: 'o', status: 'running', agentAuthority: own }, blockers: [{ code: 'current-operation' }] }) });
  assert.deepEqual([active.kind, active.callModel, Date.parse(active.nextReviewAt) - now], ['poll', false, 2 * MIN], 'executing work is polled without a model');
  const retained = decide({ business: current(day, { currentOperation: { operationId: 'o', status: 'blocked', agentAuthority: own }, blockers: [{ code: 'current-operation' }] }) });
  assert.deepEqual([retained.kind, retained.callModel], ['recovery', true], 'retained own work gets a recovery review before anything else');
  const foreign = decide({ business: current(day, { currentOperation: { operationId: 'o', status: 'blocked', agentAuthority: { ...own, grantId: 'z' } }, blockers: [{ code: 'current-operation' }] }) });
  assert.deepEqual([foreign.kind, foreign.callModel], ['held', false]);
  const blocked = decide({ business: current(day, { blockers: [{ code: 'uncertain-write', title: 'A QuickBooks request needs recovery' }] }) });
  assert.deepEqual([blocked.kind, blocked.callModel], ['held', false]);assert.match(blocked.reason, /a QuickBooks request needs recovery/);
  const behind = decide({ business: current(day, { verifiedThrough: '2026-10-27' }) });
  assert.deepEqual([behind.kind, behind.callModel, behind.reason], ['catch-up', true, 'closing Oct 28–Oct 29']);
  const slice = decide();assert.deepEqual([slice.kind, slice.callModel, slice.reason], ['slice', true, 'business hours']);
  // Slots 4 and 5 are filled: nothing is due until slot 6 at 1:30 PM.
  const noon = at(day, '12:40'), slotRun = [4, 5].map(n => ({ id: 'f' + n, status: 'verified', decisionKey: c.slotKey(day, c.RHYTHM_VERSION, n), createdAt: noon - MIN, createCount: 3 }));
  const waiting = todayAt(noon, slotRun);
  const idle = c.decide({ now: noon, settings, agent, today: waiting, state: { day, lastReviewAt: new Date(noon - 10 * MIN).toISOString() }, business: current(day) });
  assert.deepEqual([idle.kind, idle.callModel, idle.nextReviewAt, idle.reason], ['idle', false, waiting.nextSlotAt, 'next activity slot'], 'the 1:30 PM slot comes before the hourly re-check');
  const filled = todayAt(now, slotRun);
  const elapsed = decide({ today: filled, state: { day, lastReviewAt: new Date(now - 61 * MIN).toISOString() } });
  assert.deepEqual([elapsed.kind, elapsed.callModel], ['idle', false], 'nothing actionable never calls the model, however long since the last review');
  const night = c.decide({ now: at(day, '22:00'), settings, agent, today: todayAt(at(day, '22:00')), state: {}, business: current(day) });
  assert.deepEqual([night.kind, night.callModel, night.reason, Date.parse(night.nextReviewAt) - at(day, '22:00')], ['quiet', false, 'after business hours', 60 * MIN], 'overnight with nothing actionable: no model call');
  const late = c.decide({ now: at(day, '23:30'), settings, agent, today: todayAt(at(day, '23:30')), state: {}, business: current(day) });
  assert.equal(late.nextReviewAt, new Date(at('2026-10-31', '00:05')).toISOString(), 'the wake after midnight closes the day just ended');
});

test('quiet hours never suppress the calendar close after midnight', () => {
  const now = at('2026-10-31', '00:05');
  const close = c.decide({ now, settings, agent, today: todayAt(now), state: { day: '2026-10-30', reviews: 60 }, business: current('2026-10-30') });
  assert.deepEqual([close.kind, close.callModel, close.reason], ['catch-up', true, 'closing Oct 30']);
  assert.equal(close.state.reviews, 0, 'the review ceiling resets at Halifax midnight');
  assert.equal(c.decide({ now: at('2026-11-01', '12:00'), settings, agent, today: todayAt(at('2026-11-01', '12:00')), state: {}, business: current('2026-11-01') }).reason, 'closed today');
});

test('catch-up is spaced while it progresses and backs off durably when it does not', () => {
  const day = '2026-10-30', start = at(day, '09:00'), business = current(day, { verifiedThrough: '2026-10-20' });
  const run = (now, state) => c.decide({ now, settings, agent, business, today: todayAt(now), state });
  let state = c.beginReview({}, { now: start, signature: c.progressSignature(business, todayAt(start)), kind: 'catch-up' });
  let next = run(start + MIN, state);
  assert.deepEqual([next.kind, next.callModel, Date.parse(next.nextReviewAt) - start], ['catch-up', false, 5 * MIN], 'no progress: wait 5 minutes');
  assert.match(next.reason, /no progress on the last review, waiting 5 min/);
  const waits = [15, 30, 60, 60];
  for (const wait of waits) {
    const now = Date.parse(next.nextReviewAt);
    assert.equal(run(now, next.state).callModel, true);
    state = c.beginReview(next.state, { now, signature: c.progressSignature(business, todayAt(now)), kind: 'catch-up' });
    next = run(now + MIN, state);
    assert.equal(Date.parse(next.nextReviewAt) - now, wait * MIN);
  }
  // Progress (the cursor moved) resets the backoff to the 2-minute catch-up spacing.
  const now = Date.parse(next.nextReviewAt);
  state = c.beginReview(next.state, { now, signature: c.progressSignature(business, todayAt(now)), kind: 'catch-up' });
  const moved = run(now + MIN, { ...state, reviewSignature: 'something-else' });
  assert.equal(moved.state.misses, 0);
  const advanced = c.decide({ now: now + MIN, settings, agent, business: current(day, { verifiedThrough: '2026-10-21' }), today: todayAt(now + MIN), state });
  assert.deepEqual([advanced.state.misses, Date.parse(advanced.nextReviewAt) - now], [0, 2 * MIN]);
});

test('an execution that stops advancing gets a bounded recovery review', () => {
  const day = '2026-10-30', start = at(day, '09:00'), business = current(day, { currentOperation: { operationId: 'o', status: 'running', agentAuthority: own, completedRecords: 2 }, blockers: [{ code: 'current-operation' }] });
  const first = c.decide({ now: start, settings, agent, business, today: todayAt(start), state: {} });
  assert.equal(first.kind, 'poll');
  const later = c.decide({ now: start + 21 * MIN, settings, agent, business, today: todayAt(start + 21 * MIN), state: first.state });
  assert.deepEqual([later.kind, later.callModel], ['recovery', true]);assert.match(later.reason, /has not advanced/);
});

test('the hard daily review ceiling pauses every automatic review until midnight; the owner can still ask', () => {
  const day = '2026-10-30', now = at(day, '11:35'), state = { day, reviews: 80 };
  const capped = c.decide({ now, settings, agent, business: current(day, { verifiedThrough: '2026-10-25' }), today: todayAt(now), state });
  assert.deepEqual([capped.kind, capped.callModel, capped.nextReviewAt], ['ceiling', false, new Date(at('2026-10-31', '00:00')).toISOString()]);
  assert.match(capped.reason, /limit of 80 reviews/);
  assert.equal(c.decide({ now, settings, agent, business: current(day), today: todayAt(now), state }).kind, 'ceiling', 'slices and idle reviews are capped too');
  const asked = c.decide({ now, settings, agent, business: current(day), today: todayAt(now), state, ownerRequested: true });
  assert.deepEqual([asked.kind, asked.callModel], ['ceiling', false], 'the ceiling is hard: an owner request at the limit is reported, not run');
  assert.match(asked.reason, /^you asked for a review, but today’s limit of 80 reviews is reached/);
  assert.equal(c.decide({ now, settings, agent, business: current(day, { currentOperation: { operationId: 'o', status: 'blocked', agentAuthority: own }, blockers: [{ code: 'current-operation' }] }), today: todayAt(now), state }).kind, 'ceiling', 'recovery is capped too');
  assert.deepEqual(c.specialistAllowed({ now, state }), { allowed: false, nextAt: new Date(at('2026-10-31', '00:00')).toISOString() }, 'specialists cannot bypass the ceiling');
  assert.equal(c.countReview({ day, reviews: 3 }, now).reviews, 4);
  assert.equal(c.countReview({ day: '2026-10-29', reviews: 59 }, now).reviews, 1);
});

test('specialists run only in business hours', () => {
  assert.equal(c.specialistAllowed({ now: at('2026-10-30', '10:00'), state: {} }).allowed, true);
  assert.deepEqual(c.specialistAllowed({ now: at('2026-10-30', '19:00'), state: {} }), { allowed: false, nextAt: new Date(at('2026-10-31', '10:00')).toISOString() }, 'Saturday opens at 10:00');
  assert.equal(c.specialistAllowed({ now: at('2026-10-31', '15:00'), state: {} }).nextAt, new Date(at('2026-11-02', '08:00')).toISOString(), 'Sunday is closed');
});

test('the next calendar close never crosses a month-end and is at most 31 days', () => {
  assert.deepEqual(c.nextClose({ verifiedThrough: '2026-09-20' }, '2026-10-30'), { closedThrough: '2026-09-20', fromDate: '2026-09-21', throughDate: '2026-09-30', behindDays: 39 });
  assert.equal(c.nextClose({ verifiedThrough: '2026-10-28' }, '2026-10-30').throughDate, '2026-10-29');
  assert.equal(c.nextClose({ verifiedThrough: '2026-10-29' }, '2026-10-30'), null);
  assert.equal(c.nextClose({ verifiedThrough: null, openingDate: '2026-10-01' }, '2026-10-30').fromDate, '2026-10-01');
});

// Sol's Phase 1 review (2026-10-30) findings 1, 3 and 5.
test('approved own work that holds no calendar slot is recovered before any calendar close, even overnight', () => {
  const now = at('2026-10-31', '00:05'), approved = { operationId: 'a1', status: 'approved', day: '2026-10-30', agentAuthority: own, executionPending: false };
  const decision = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [approved], state: {} });
  assert.deepEqual([decision.kind, decision.callModel, decision.reason], ['recovery', true, 'finishing approved work that has not started'], 'midnight catch-up must not close Oct 30 while its approved batch is unfinished');
  const queued = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...approved, executionPending: true }], state: {} });
  assert.deepEqual([queued.kind, queued.callModel], ['poll', false], 'queued approved work is polled without a model');
  const foreign = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...approved, agentAuthority: { ...own, grantId: 'other' } }], state: {} });
  assert.equal(foreign.kind, 'catch-up', 'work under another grant is not this lineage’s recovery');
});
test('progress made between reviews, such as queued execution finishing, clears the backoff', () => {
  const day = '2026-10-30', start = at(day, '09:00'), owned = [{ operationId: 'a1', status: 'approved', day, agentAuthority: own, executionPending: true }];
  const business = current(day), noon = todayAt(start);
  let state = c.beginReview({ misses: 3 }, { now: start, signature: c.progressSignature(business, noon, owned), kind: 'recovery' });
  const after = c.decide({ now: start + MIN, settings, agent, business, today: noon, owned, state });
  assert.equal(after.state.misses, 4, 'the review itself queued nothing new');
  // Execution then finishes on its own: the run leaves the unfinished list and today's verified count rises.
  const done = c.summarizeToday({ rhythm: c.dayRhythm(day), now: start + 30 * MIN, runs: [{ id: 'a1', status: 'verified', decisionKey: c.slotKey(day, 1, 1), createdAt: start, createCount: 3 }], receipts: [{ operationId: 'a1', entity: 'invoice', logicalKey: 'k1' }, { operationId: 'a1', entity: 'payment', logicalKey: 'k2' }, { operationId: 'a1', entity: 'deposit', logicalKey: 'k3' }] });
  const later = c.decide({ now: start + 30 * MIN, settings, agent, business, today: done, owned: [], state: after.state });
  assert.equal(later.state.misses, 0, 'later recovery or slices do not inherit a long delay after real progress');
});
test('business hours with nothing actionable re-check saved state without a model call', () => {
  const day = '2026-10-30', now = at(day, '12:40');
  const full = c.summarizeToday({ rhythm: c.dayRhythm(day), now, runs: [{ id: 'r', status: 'verified', decisionKey: 'duty-0001', createdAt: now, createCount: 150 }], receipts: Array.from({ length: 150 }, (_, i) => ({ operationId: 'r', entity: 'payment', logicalKey: 'k' + i })) });
  const short = c.decide({ now, settings: { decisionIntervalMinutes: 5 }, agent, business: current(day), today: full, state: {} });
  assert.deepEqual([short.kind, short.callModel, Date.parse(short.nextReviewAt) - now, short.reason], ['idle', false, 5 * MIN, 'today’s activity is in QuickBooks'], 'a short owner interval is only a cheap re-check');
});

// GPT-6.1 Sol round-2 review (2026-10-30) findings 1 and 4.
test('stranded work with saved effects holds without a model call; unsent work is left to governed retirement', () => {
  const now = at('2026-10-31', '00:05'), base = { operationId: 's1', status: 'stopped', day: '2026-10-30', agentAuthority: own, executionPending: false, holdsSlot: false };
  const stranded = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...base, disposition: 'stranded' }], state: {} });
  assert.deepEqual([stranded.kind, stranded.callModel], ['held', false], 'no recovery loop for work no tool can continue');
  assert.match(stranded.reason, /stopped work with saved records/);
  const unsent = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...base, disposition: 'unsent' }], state: {} });
  assert.equal(unsent.kind, 'catch-up', 'unsent work does not block once the worker retires it');
  const queueable = c.decide({ now, settings, agent, business: current('2026-10-30'), today: todayAt(now), owned: [{ ...base, status: 'approved', disposition: 'continue' }], state: {} });
  assert.equal(queueable.kind, 'recovery');
});
test('due obligations are actionable in business hours, spaced and backed off, and never overnight', () => {
  const day = '2026-10-30', now = at(day, '15:10'), obligations = { count: 3 }, business = current(day);
  const full = c.summarizeToday({ rhythm: c.dayRhythm(day), now, runs: [{ id: 'r', status: 'verified', decisionKey: 'duty-0001', createdAt: now, createCount: 150 }], receipts: Array.from({ length: 150 }, (_, i) => ({ operationId: 'r', entity: 'payment', logicalKey: 'k' + i })) });
  const signature = c.progressSignature(business, full, [], obligations);
  const due = c.decide({ now, settings, agent, business, today: full, obligations, state: {} });
  assert.deepEqual([due.kind, due.callModel, due.reason], ['obligations', true, 'settling 3 due invoices and bills'], 'the calendar is current and today is full, yet due obligations still get a review');
  let clock = now, next = c.decide({ now: now + MIN, settings, agent, business, today: full, obligations, state: c.beginReview(due.state, { now, signature, kind: 'obligations' }) });
  for (const wait of [15, 15, 30, 60]) {
    assert.deepEqual([next.callModel, Date.parse(next.nextReviewAt) - clock], [false, wait * MIN], 'never sooner than the 15-minute spacing; an obligation that cannot be settled backs off');
    clock = Date.parse(next.nextReviewAt);
    const ready = c.decide({ now: clock, settings, agent, business, today: full, obligations, state: next.state });
    assert.equal(ready.callModel, true);
    next = c.decide({ now: clock + MIN, settings, agent, business, today: full, obligations, state: c.beginReview(ready.state, { now: clock, signature, kind: 'obligations' }) });
  }
  const settled = c.decide({ now: Date.parse(next.nextReviewAt), settings, agent, business, today: full, obligations: { count: 2 }, state: next.state });
  assert.equal(settled.state.misses, 0, 'settling one counts as progress');
  const night = c.decide({ now: at(day, '22:00'), settings, agent, business, today: full, obligations, state: {} });
  assert.deepEqual([night.kind, night.callModel], ['quiet', false]);
});

// GPT-6.1 Sol final review (2026-10-30): per-slice allowance and the enforced daily request budget.
test('an oversized prepared slice neither fills its slot nor reserves, so a smaller batch can take the slot', () => {
  const now = at('2026-10-30', '08:40');
  const today = todayAt(now, [{ id: 'big', status: 'previewed', decisionKey: c.slotKey('2026-10-30', c.RHYTHM_VERSION, 1), createdAt: now - MIN, createCount: 60 }]);
  assert.equal(today.sliceCap, 30, 'twice the slot share of 15');
  assert.deepEqual(today.plannedByRun, { big: 60 }, 'planned native creates come from the saved plan');
  assert.equal(today.reserved, 0);
  assert.deepEqual(today.dueSlot, { n: 1, records: 15, decisionKey: 'slot-20261030-r2-s1-b2' });
  assert.equal(c.dayRhythm('2026-10-31').slots.length && todayAt(at('2026-10-31', '10:40')).sliceCap, 16, 'Saturday: twice ceil(30 / 4)');
});
test('the daily QuickBooks request budget stops discretionary slices only, with a visible reason', () => {
  const day = '2026-10-30', now = at(day, '11:35'), spent = c.requestBudget({ today: { total: c.DAILY_REQUEST_BUDGET } });
  assert.deepEqual(spent, { used: 12000, limit: 12000, reached: true, unavailable: false });
  assert.equal(c.requestBudget({ today: { total: 11999 } }).reached, false);
  assert.equal(c.requestBudget(null).reached, true, 'an unreadable count stops new slices (fail closed)');
  const slice = c.decide({ now, settings, agent, business: current(day), today: todayAt(now), requests: spent, state: {} });
  assert.deepEqual([slice.kind, slice.callModel], ['idle', false]);
  assert.match(slice.reason, /QuickBooks request budget of 12,000 is used; new activity resumes after midnight UTC/);
  assert.equal(c.decide({ now, settings, agent, business: current(day, { verifiedThrough: '2026-10-27' }), today: todayAt(now), requests: spent, state: {} }).kind, 'catch-up', 'calendar closes continue');
  assert.equal(c.decide({ now, settings, agent, business: current(day, { currentOperation: { operationId: 'o', status: 'blocked', agentAuthority: own }, blockers: [{ code: 'current-operation' }] }), today: todayAt(now), requests: spent, state: {} }).kind, 'recovery', 'recovery continues');
  assert.equal(c.decide({ now, settings, agent, business: current(day), today: todayAt(now), obligations: { count: 2 }, requests: spent, state: {} }).kind, 'obligations', 'obligations continue');
});
