'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/modules/business-management-review');
const c = require('../src/modules/business-agent-cadence');
const { createBusinessAgentTools } = require('../src/modules/business-agent-tools');

const at = (day, hhmm) => { const [h, mm] = hhmm.split(':').map(Number); return c.zonedTime(day, h * 60 + mm); };
const current = (day, extra = {}) => ({ verifiedThrough: require('../src/modules/business-calendar').shift(day, -1), openingDate: '2026-01-01', blockers: [], currentOperation: null, ...extra });
const settings = { decisionIntervalMinutes: 60 };
const agent = { id: 'agent', grant: { id: 'g'.repeat(64), authorityHash: 'h'.repeat(64) } };
const todayAt = now => c.summarizeToday({ rhythm: c.dayRhythm(c.localParts(now).date), runs: [], receipts: [], now });
const decide = (now, extra = {}) => c.decide({ now, settings, business: current(c.localParts(now).date), agent, today: todayAt(now), ...extra });

// A small mirrored company: lists, an overdue part-paid mixed-tax invoice, an open bill and a stock-out.
function company(day = '2026-10-31') {
  const rows = [
    { entity: 'Preferences', record: { CurrencyPrefs: { HomeCurrency: { value: 'CAD' } } } },
    { entity: 'Customer', record: { Id: '1', DisplayName: 'North Shore Dental', Active: true, MetaData: { CreateTime: day + 'T09:00:00-07:00' } } },
    { entity: 'Customer', record: { Id: '2', DisplayName: 'Old Client', Active: false } },
    { entity: 'Vendor', record: { Id: '3', DisplayName: 'Atlantic Supply', Active: true } },
    { entity: 'Item', record: { Id: '4', Name: 'Field service hour', Type: 'Service', Active: true } },
    { entity: 'Item', record: { Id: '5', Name: 'Filter cartridge', Type: 'Inventory', Active: true, QtyOnHand: 0 } },
    { entity: 'Invoice', record: { Id: '6', TxnDate: '2026-09-20', DueDate: '2026-10-05', TotalAmt: 226, Balance: 100, Line: [{ SalesItemLineDetail: { TaxCodeRef: { value: '5' } } }, { SalesItemLineDetail: { TaxCodeRef: { value: '9' } } }] }, summary: { txnDate: '2026-10-20', dueDate: '2026-10-05', amountCents: 22600, balanceCents: 10000 } },
    { entity: 'Invoice', record: { Id: '7', TxnDate: '2026-09-15', TotalAmt: 113, Balance: 0 }, summary: { txnDate: '2026-09-15', amountCents: 11300, balanceCents: 0 } },
    { entity: 'Bill', record: { Id: '8', TxnDate: '2026-10-29', DueDate: '2026-11-28', TotalAmt: 500, Balance: 500 }, summary: { txnDate: '2026-10-30', dueDate: '2026-11-28', amountCents: 50000, balanceCents: 50000 } },
  ];
  return rows;
}

test('measures come from mirrored records: parties, aging, month-to-date, volume, stock and support scenarios', () => {
  const x = m.measuresFromRecords(company(), '2026-10-31');
  assert.deepEqual(x.parties, { customers: 1, suppliers: 1, items: 2, serviceItems: 1, stockedItems: 1, employees: 0 });
  assert.equal(x.receivables.overdue, 1);assert.equal(x.receivables.partlyPaid, 1);assert.deepEqual(x.receivables.buckets['1-30'], { count: 1, cents: 10000 });
  assert.equal(x.payables.buckets.current.cents, 50000);
  assert.deepEqual([x.monthToDate.from, x.monthToDate.salesCents, x.monthToDate.expensesCents], ['2026-10-01', 22600, 50000]);
  assert.deepEqual([x.priorMonthToDate.from, x.priorMonthToDate.through, x.priorMonthToDate.salesCents], ['2026-09-01', '2026-09-30', 11300]);
  assert.deepEqual(x.yesterday, { day: '2026-10-30', records: 1, byEntity: { Bill: 1 }, target: 150 });
  assert.deepEqual(x.today.byEntity, { Customer: 1 }, 'a list entry counts on its QuickBooks create date');
  assert.deepEqual([x.stock.outOfStock, x.stock.outOfStockNames[0]], [1, 'Filter cartridge']);
  assert.equal(x.scenarios.mixedTaxSales, 1);assert.equal(x.scenarios.partPaidInvoices, 1);
});

test('coverage is scored from the local copy, and sources the mirror does not keep are unread rather than missing', () => {
  const result = m.coverageFromRecords(company(), '2026-10-31');
  assert.ok(result.areas.length > 10);
  const compact = m.compactCoverage({ ...result, source: 'local-mirror' });
  assert.equal(compact.source, 'local-mirror');assert.ok(compact.gaps.length > 0 && compact.gaps.length <= 30);
  assert.equal(compact.gaps[0].fill, 'accountant', 'gaps the accountant can fill come first');
  assert.ok(compact.unreadSignals > 0, 'budgets, attachments and the like are not mirrored');
  assert.ok(!compact.gaps.some(gap => /budget/i.test(gap.feature)), 'an unmirrored source is never reported as an unused feature');
});

test('the management context carries every measure, the tool map and open requests within a bounded size', () => {
  const rows = company();
  for (let n = 0; n < 3000; n++) rows.push({ entity: 'Invoice', record: { Id: 'i' + n, TxnDate: '2026-10-' + String(1 + (n % 30)).padStart(2, '0'), TotalAmt: 100, Balance: n % 3 ? 0 : 50, DueDate: '2026-10-15' } });
  const snapshot = { asOf: '2026-10-31T05:00:00.000Z', measures: m.measuresFromRecords(rows, '2026-10-31'), coverage: m.coverageFromRecords(rows, '2026-10-31') };
  const events = [
    { kind: 'attention', title: 'Business review needs attention', detail: 'x'.repeat(5000), at: new Date(Date.parse('2026-10-31T04:00:00Z')).toISOString() },
    { kind: 'management-decision', title: 'Legacy corrections remain blocked by unavailable correction tools', detail: '', at: '2026-10-30T20:00:00.000Z' },
  ];
  const requests = Array.from({ length: 30 }, (_, n) => ({ kind: 'capability-request', id: String(n), key: 'gap-' + n, priority: n % 2 ? 'low' : 'high', missing: 'Tool ' + n, requirement: 'R05', status: 'open', at: '2026-10-30T20:00:00.000Z' }));
  const x = m.managementContext({ snapshot, today: { label: 'Sat Oct 31', target: 30, saved: 4, verified: 4, reserved: 0, byEntity: {}, slotCount: 4 }, events, decisions: [{ title: 'Grow the customer base', status: 'accept', response: { detail: 'Yes' } }], requests, nowMs: Date.parse('2026-10-31T05:00:00Z') });
  for (const key of ['measures', 'today', 'coverage', 'problems', 'ownerAnswers', 'responsibilities', 'capabilityRequests']) assert.ok(x[key], key);
  assert.equal(x.problems.last2Days.attention, 1);assert.match(x.problems.recordedLimitations[0], /Legacy corrections/);
  assert.ok(x.problems.recent[0].detail.length <= 200);
  assert.equal(x.capabilityRequests.length, 20);assert.equal(x.capabilityRequests[0].priority, 'high');
  assert.ok(m.RESPONSIBILITIES.every(row => row.tools.length > 0));
  assert.ok(Buffer.byteLength(JSON.stringify(x)) < 24000, 'bounded: ' + Buffer.byteLength(JSON.stringify(x)));
  const unavailable = m.managementContext({ snapshot: null, error: 'read failed' });
  assert.equal(unavailable.unavailable, true);assert.equal(unavailable.measures, null);
});

test('the management review runs once a day at 00:10, before the first slice, and the first one runs at once', () => {
  const sat = '2026-10-31', sun = '2026-11-01';
  // First ship: no plan was ever saved, so it runs immediately, whatever the hour.
  let d = decide(at(sat, '01:40'), { management: { lastPlanDay: null } });
  assert.deepEqual([d.kind, d.callModel, d.reason], ['management', true, 'the first management review']);
  // Later days wait for 00:10, right after the previous day's close and before the 00:30 slice.
  d = decide(at(sun, '00:07'), { management: { lastPlanDay: sat } });assert.notEqual(d.kind, 'management');
  d = decide(at(sun, '00:40'), { management: { lastPlanDay: sat } });assert.equal(d.kind, 'management', 'it precedes the due slice');
  d = decide(at(sun, '01:30'), { management: { lastPlanDay: sun } });assert.equal(d.kind, 'slice', 'once today’s plan is saved the slice runs');
  assert.equal(new Date(c.managementAt('2026-11-02')).toISOString(), '2026-11-02T04:10:00.000Z', '00:10 Halifax (AST)');
  assert.equal(c.managementMinutes('2026-11-01'), 10, 'every day, Sunday included');
  // The previous day's close comes first.
  d = c.decide({ now: at(sun, '00:15'), settings, business: current(sun, { verifiedThrough: '2026-10-30' }), agent, today: todayAt(at(sun, '00:15')), management: { lastPlanDay: sat } });
  assert.equal(d.kind, 'catch-up');
  // Without the management input (feature unavailable) nothing changes.
  assert.equal(decide(at(sun, '01:30')).kind, 'slice');
});

test('management attempts are capped per day and never count as a review without progress', () => {
  const sat = '2026-10-31', now = at(sat, '10:05');
  const started = c.beginReview({}, { now, signature: 'sig', kind: 'management' });
  assert.deepEqual(started.management, { day: sat, attempts: 1 });assert.equal(started.reviewSignature, null);
  const again = c.beginReview(started, { now: now + 20 * 60000, signature: 'sig', kind: 'management' });
  assert.equal(again.management.attempts, 2);
  const d = decide(now + 40 * 60000, { state: again, management: { lastPlanDay: '2026-10-30' } });
  assert.notEqual(d.kind, 'management', 'two attempts without a plan end it for the day');
  assert.equal(d.state.misses || 0, 0, 'a planning review is not a miss');
});

test('recovery and catch-up come first; the ceiling and the request budget hold; held work still gets its review', () => {
  const sat = '2026-10-31', now = at(sat, '10:05'), management = { lastPlanDay: '2026-10-30' };
  assert.equal(c.decide({ now, settings, business: current(sat, { verifiedThrough: '2026-10-28' }), agent, today: todayAt(now), management }).kind, 'catch-up');
  const op = { operationId: 'op', status: 'stopped', agentAuthority: { version: 1, agentId: 'agent', grantId: agent.grant.id, authorityHash: agent.grant.authorityHash, ownerId: 'o' } };
  assert.equal(c.decide({ now, settings, business: current(sat, { currentOperation: op }), agent, today: todayAt(now), management }).kind, 'recovery');
  assert.equal(decide(now, { management, state: { day: sat, reviews: c.REVIEW_CEILING } }).kind, 'ceiling');
  assert.notEqual(decide(now, { management, requests: { reached: true, scope: 'day', limit: 1, used: 1 } }).kind, 'management');
  const blocked = c.decide({ now, settings, business: current(sat, { blockers: [{ title: 'Imported history needs a decision' }] }), agent, today: todayAt(now), management });
  assert.equal(blocked.kind, 'management', 'a held business still gets its daily review, which plans and files requests');
  const heldAfter = c.decide({ now, settings, business: current(sat, { blockers: [{ title: 'Imported history needs a decision' }] }), agent, today: todayAt(now), management: { lastPlanDay: sat } });
  assert.deepEqual([heldAfter.kind, heldAfter.callModel], ['held', false]);
});

test('the daily plan validates its shape and gives the owner a short note', () => {
  const plan = m.dailyPlanEvent({ findings: [{ requirement: 'R01', status: 'gap', finding: 'No partial payments in 30 days.' }, { requirement: 'R02', status: 'attention', finding: 'Yesterday 9 records against 150.' }], changes: [{ area: 'customers', change: 'Add four customers for the service base.', count: 4 }], ownerNote: '  Today: grow customers and steer toward credits.  ' }, '2026-10-31');
  assert.equal(plan.title, 'Today’s plan · Sat Oct 31');assert.equal(plan.detail, 'Today: grow customers and steer toward credits.');
  assert.deepEqual(plan.data.changes, [{ area: 'customers', change: 'Add four customers for the service base.', count: 4 }]);
  assert.throws(() => m.dailyPlanEvent({ findings: [], changes: [], ownerNote: 'x' }, '2026-10-31'), /one to twelve findings/);
  assert.throws(() => m.dailyPlanEvent({ findings: [{ requirement: 'R01', status: 'gap', finding: 'x' }], changes: [], ownerNote: ' ' }, '2026-10-31'), /owner note/);
  assert.throws(() => m.dailyPlanEvent({ findings: [{ requirement: 'R99', status: 'gap', finding: 'x' }], changes: [], ownerNote: 'n' }, '2026-10-31'), /requirement/);
  const long = m.dailyPlanEvent({ findings: [{ requirement: 'R04', status: 'on-track', finding: 'y'.repeat(2000) }], changes: [], ownerNote: 'z'.repeat(5000) }, '2026-10-31');
  assert.equal(long.data.findings[0].finding.length, 400);assert.equal(long.detail.length, 1200);
});

test('today’s plan is carried into later reviews only on its own day', () => {
  const saved = { day: '2026-10-31', at: '2026-10-31T13:05:00.000Z', changes: [{ area: 'sales-mix', change: 'Include one customer credit.' }], findings: [{ requirement: 'R01', status: 'gap', finding: 'No credits this month.' }, { requirement: 'R06', status: 'on-track', finding: 'Instructions applied.' }] };
  assert.deepEqual(m.planContext(saved, '2026-10-31'), { day: '2026-10-31', recordedAt: saved.at, changes: saved.changes, focus: ['R01: No credits this month.'] });
  assert.equal(m.planContext(saved, '2026-11-01'), null);assert.equal(m.planContext(null, '2026-10-31'), null);
});

function tools({ requests = [], plan = null, role = 'accountant' } = {}) {
  const h = { events: [] };
  const row = { _id: 'b'.repeat(24), ownerId: 'a'.repeat(24), grant: { id: 'c'.repeat(64), authorityHash: 'd'.repeat(64) }, settings: {} };
  const store = { models: {}, latestDailyPlan: async () => plan, capabilityRequests: async () => [...requests, ...h.events.filter(e => e.kind === 'capability-request').map(e => ({ kind: e.kind, ...e.data }))],
    event: async (_row, kind, title, detail, data, _session, key) => { h.events.push({ kind, title, detail, data, key }); return { id: 'e'.repeat(24), kind, title, detail, ...data }; } };
  h.tools = createBusinessAgentTools({ row, role, passId: 'pass', scope: { environment: 'production', realmId: '1', connectionId: 'f'.repeat(24) }, store, guard: async () => {}, readTools: { toolDefinitions: [], toolHandlers: {} }, now: () => Date.parse('2026-10-31T14:00:00Z') });
  return h;
}
const request = { key: 'partial-customer-payments', requirement: 'R01', missing: 'Partial customer payments', feature: 'Receive payment (partial) and A/R aging', why: 'Support cases often involve part-paid invoices.', priority: 'high' };

test('capability requests are deduplicated by key and never ask the owner', async () => {
  const h = tools();
  const first = await h.tools.execute('requestCapability', request);
  assert.equal(first.success, true);assert.equal(h.events.length, 1);
  assert.deepEqual([h.events[0].kind, h.events[0].key, h.events[0].title, h.events[0].data.status], ['capability-request', 'capability:partial-customer-payments', 'Build: Partial customer payments', 'open']);
  const second = await h.tools.execute('requestCapability', { ...request, priority: 'low', why: 'Again.' });
  assert.equal(second.data.duplicate, true);assert.equal(h.events.length, 1, 'the same gap stays one build-list entry');
  assert.ok(!h.events.some(e => e.kind === 'decision'));
  await assert.rejects(h.tools.execute('requestCapability', { ...request, key: 'Bad Key' }), /supported bounded text/);
  const specialist = tools({ role: 'inventory' });
  assert.equal(specialist.tools.definitions.some(t => ['requestCapability', 'recordDailyPlan'].includes(t.name)), false);
});

test('the daily plan is recorded once per Halifax day', async () => {
  const input = { findings: [{ requirement: 'R02', status: 'attention', finding: 'Volume is far below target.' }], changes: [{ area: 'customers', change: 'Add customers.' }], ownerNote: 'Growing the customer base today.' };
  const h = tools();
  await h.tools.execute('recordDailyPlan', input);
  assert.deepEqual([h.events[0].kind, h.events[0].key, h.events[0].data.day], ['daily-plan', 'daily-plan:2026-10-31', '2026-10-31']);
  const again = tools({ plan: { id: 'x', day: '2026-10-31', title: 'Today’s plan · Sat Oct 31' } });
  const result = await again.tools.execute('recordDailyPlan', input);
  assert.equal(result.data.alreadyRecorded, true);assert.equal(again.events.length, 0);
});

test('open requests list each key once, highest priority first', () => {
  const rows = m.openRequests([
    { kind: 'capability-request', key: 'b', priority: 'low', status: 'open', at: '2026-10-31T01:00:00Z' },
    { kind: 'capability-request', key: 'a', priority: 'high', status: 'open', at: '2026-10-30T01:00:00Z' },
    { kind: 'capability-request', key: 'a', priority: 'low', status: 'open', at: '2026-10-29T01:00:00Z' },
    { kind: 'daily-plan', key: 'c' },
  ]);
  assert.deepEqual(rows.map(row => [row.key, row.priority]), [['a', 'high'], ['b', 'low']]);
});

test('every new tool has an owner-facing description and a live-step label', () => {
  const { agentToolCatalog } = require('../src/modules/business-agent-catalog');
  const catalog = agentToolCatalog({ toolDefinitions: [], VALID_ENTITY_TYPES: [] });
  assert.ok(catalog.tools.some(tool => tool.name === 'recordDailyPlan'));assert.ok(catalog.tools.some(tool => tool.name === 'requestCapability'));
  const { stepLabel } = require('../src/modules/business-agent-progress');
  assert.equal(stepLabel('requestCapability', {}), 'Adding a missing tool to the build list');
});

test('any review can read today’s plan and the open build-request keys, and the full review through a deferred tool', async () => {
  const plan = { id: 'p', day: '2026-10-31', at: '2026-10-31T05:41:00.000Z', changes: [{ area: 'customers', change: 'Add customers.' }], findings: [{ requirement: 'R05', status: 'gap', finding: 'Partial payments missing.' }] };
  const requests = [{ kind: 'capability-request', id: '1', key: 'partial-customer-payments', priority: 'high', requirement: 'R01', missing: 'Partial customer payments', status: 'open', at: '2026-10-31T05:41:00.000Z' }];
  const row = { _id: 'b'.repeat(24), ownerId: 'a'.repeat(24), grant: null, settings: {} };
  const store = { models: {}, business: async () => ({ blockers: [] }), decisions: async () => [], latestDailyPlan: async () => plan, capabilityRequests: async () => requests };
  let asked = 0;
  const tools = createBusinessAgentTools({ row, scope: { environment: 'production', realmId: '1', connectionId: 'f'.repeat(24) }, store, guard: async () => {}, readTools: { toolDefinitions: [], toolHandlers: {} }, now: () => Date.parse('2026-10-31T14:00:00Z'), managementFor: async () => { asked++; return { todaysPlan: m.planContext(plan, '2026-10-31'), measures: { parties: { customers: 97 } } }; } });
  const state = await tools.execute('getBusinessState', {});
  assert.deepEqual(state.data.management.todaysPlan.changes, plan.changes);
  assert.deepEqual(state.data.management.openRequests, [{ key: 'partial-customer-payments', priority: 'high', requirement: 'R01', missing: 'Partial customer payments' }]);
  const review = await tools.execute('getManagementReview', {});
  assert.equal(review.data.measures.parties.customers, 97);assert.equal(asked, 1);
  const without = createBusinessAgentTools({ row, scope: { environment: 'production', realmId: '1', connectionId: 'f'.repeat(24) }, store, guard: async () => {}, readTools: { toolDefinitions: [], toolHandlers: {} } });
  assert.equal((await without.execute('getManagementReview', {})).success, false);
  const { CORE, INFO } = require('../src/modules/business-agent-toolbox');
  assert.equal(CORE.includes('getManagementReview'), false, 'deferred: found with searchTools');assert.ok(INFO.getManagementReview);
});

test('getBusinessDecision reads owner questions and the accountant’s own decisions; other ids say what they are', async () => {
  const { createBusinessAgentStore } = require('../src/modules/business-agent-store');
  const agentId = 'b'.repeat(24), rows = [
    { _id: '1'.repeat(24), agentId, kind: 'management-decision', role: 'accountant', title: 'October 30 close queued', detail: 'Due settlements follow verification.', data: { area: 'business' }, at: new Date('2026-10-31T03:06:16Z') },
    { _id: '2'.repeat(24), agentId, kind: 'daily-plan', role: 'accountant', title: 'Today’s plan', detail: '', data: {}, at: new Date('2026-10-31T05:41:00Z') },
    { _id: '3'.repeat(24), agentId: 'other-agent', kind: 'management-decision', role: 'accountant', title: 'Another company', detail: '', data: {}, at: new Date() },
  ];
  const chain = value => ({ select() { return this; }, maxTimeMS() { return this; }, lean: async () => value });
  const matches = (row, q) => row._id === q._id && row.agentId === q.agentId && (!q.kind || (q.kind.$in ? q.kind.$in.includes(row.kind) : row.kind === q.kind));
  const Events = { findOne: q => chain(rows.find(row => q._id ? matches(row, q) : row.agentId === q.agentId && row.kind === q.kind && row.data?.decisionId === q['data.decisionId']) || null) };
  const Runs = { exists: q => ({ maxTimeMS: async () => (q._id === '4'.repeat(24) ? { _id: q._id } : null) }) };
  const store = createBusinessAgentStore({ models: { Agents: {}, Events, Runs }, connection: {}, transaction: async () => {} });
  const row = { _id: agentId, environment: 'production', realmId: '1', connectionId: 'f'.repeat(24) };
  const own = await store.decision(row, '1'.repeat(24));
  assert.deepEqual([own.kind, own.status, own.ownerQuestion, own.title], ['management-decision', 'recorded', false, 'October 30 close queued']);
  await assert.rejects(store.decision(row, '2'.repeat(24)), /That id is today’s plan; read it with getManagementReview/);
  await assert.rejects(store.decision(row, '3'.repeat(24)), /No decision with this id belongs to the selected business/, 'another agent’s decision is never readable');
  await assert.rejects(store.decision(row, '4'.repeat(24)), /saved accounting operation, not a decision; read it with inspectBusinessOperation/);
});
