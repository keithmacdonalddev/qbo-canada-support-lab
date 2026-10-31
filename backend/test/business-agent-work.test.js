'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { businessWork, rightNow, oneLine } = require('../src/modules/business-agent-work');

const POLICY = 'a'.repeat(64), AUTH = 'c'.repeat(64);
const grant = { id: 'g'.repeat(64), authorityHash: AUTH, activityPolicyHash: POLICY };
const running = { settings: { monitoring: true, autonomous: true }, agent: { id: 'agent', grant }, business: { blockers: [], authorityHash: AUTH }, sync: { status: 'current' }, activityPolicyHash: POLICY };
const coverage = { asOf: '2026-10-28', areas: [{ key: 'sales', signals: [
  { key: 'invoices', label: 'Invoices', status: 'ok', fill: 'assistant', entity: 'Invoice' },
  { key: 'estimates', label: 'Estimates', status: 'missing', fill: 'assistant', entity: 'Estimate' },
  { key: 'purchase-orders', label: 'Purchase orders', status: 'stale', fill: 'assistant', entity: 'PurchaseOrder' },
  { key: 'refunds', label: 'Refund receipts', status: 'missing', fill: 'assistant', entity: 'RefundReceipt' },
  { key: 'new-employees', label: 'New employees', status: 'missing', fill: 'assistant', entity: 'Employee' },
  { key: 'bank-rules', label: 'Bank rules', status: 'missing', fill: 'quickbooks', entity: 'BankRule' },
  { key: 'payroll-run', label: 'Payroll run', status: 'manual', fill: 'quickbooks', entity: null },
] }] };
const byKey = (work, key) => work.items.find(item => item.key === key);
const ownerKeys = work => work.items.filter(item => item.owner === 'owner' && item.state === 'needs-owner').map(item => item.key);
const operation = extra => ({ operationId: 'o', status: 'blocked', agentAuthority: { version: 1, agentId: 'agent', grantId: grant.id, authorityHash: AUTH, ownerId: 'x' }, ...extra });

test('a healthy running business needs nothing from the owner and owns only features it can create', () => {
  const work = businessWork({ ...running, coverage });
  assert.equal(work.needsOwner, 0);
  assert.equal(work.headline, 'Nothing needs you. The accountant is running the business; some work waits for capabilities still being built.');
  const features = byKey(work, 'use-features');
  assert.equal(features.state, 'on-duty', 'an enabled duty is not shown as work in progress');
  assert.deepEqual(features.features.map(item => item.key), ['estimates', 'purchase-orders', 'refunds']);
  assert.deepEqual(byKey(work, 'new-workflows').features.map(item => item.key), ['new-employees']);
  assert.equal(byKey(work, 'new-workflows').state, 'blocked');
  const manual = byKey(work, 'manual-features');
  assert.equal(manual.state, 'optional');
  assert.deepEqual(manual.features.map(item => item.key), ['bank-rules']);
  const creatable = { ...coverage, areas: [{ signals: coverage.areas[0].signals.slice(0, 3) }] };
  assert.equal(businessWork({ ...running, coverage: creatable }).headline, 'Nothing needs you. The accountant is running the business.');
});

test('only the one-time grant or a genuine renewal is asked of the owner', () => {
  const ungranted = businessWork({ ...running, settings: { monitoring: true, autonomous: false }, agent: { grant: null }, coverage });
  assert.deepEqual(ownerKeys(ungranted), ['grant-authority']);
  assert.equal(byKey(ungranted, 'use-features').state, 'waiting');
  assert.deepEqual(ownerKeys(businessWork({ ...running, agent: { id: 'agent', grant: { ...grant, activityPolicyHash: 'b'.repeat(64) } }, coverage })), [], 'new accountant workflows do not ask the owner again');
  const republished = { ...running, business: { blockers: [], authorityHash: 'd'.repeat(64) } };
  assert.deepEqual(ownerKeys(businessWork({ ...republished, coverage })), ['renew-authority']);
  assert.deepEqual(ownerKeys(businessWork({ ...republished, settings: { monitoring: true, autonomous: false }, coverage })), ['renew-authority']);
  assert.equal(byKey(businessWork({ ...running, settings: { monitoring: true, autonomous: false }, coverage }), 'resume').title, 'You paused the accountant');
});

test('an unpublished business asks to publish, not to grant authority', () => {
  const work = businessWork({ ...running, agent: { grant: null }, business: { blockers: [{ code: 'not-published' }] }, coverage });
  assert.deepEqual(ownerKeys(work), ['publish-business']);
});

test('imported history and its blocked operation become one accountant-owned item', () => {
  const blockers = [{ code: 'population-owned' }, { code: 'current-operation' }, { code: 'history-uncommitted' }];
  const work = businessWork({ ...running, business: { blockers, authorityHash: AUTH, populationStatus: 'populated', recordCount: 10359, recordsThrough: '2026-10-17', currentOperation: { operationId: 'x', status: 'blocked', agentAuthority: null } }, coverage });
  const history = byKey(work, 'adopt-history');
  assert.equal(history.owner, 'accountant');
  assert.equal(history.state, 'blocked');
  assert.match(history.title, /10,359/);
  assert.deepEqual(ownerKeys(work), []);
  assert.equal(byKey(work, 'use-features').state, 'waiting');
  const running2 = businessWork({ ...running, business: { blockers: [{ code: 'population-owned' }], authorityHash: AUTH, populationStatus: 'running' }, coverage });
  assert.equal(byKey(running2, 'settle-operations').state, 'blocked');
});

test('the accountant continues only an operation its current grant can resume', () => {
  const resumable = businessWork({ ...running, business: { blockers: [{ code: 'current-operation' }], authorityHash: AUTH, currentOperation: operation({ status: 'running' }) }, coverage });
  assert.equal(byKey(resumable, 'continue-operation').state, 'working');
  const idle = businessWork({ ...running, business: { blockers: [{ code: 'current-operation' }], authorityHash: AUTH, currentOperation: operation({ status: 'stopped' }) }, coverage });
  assert.equal(byKey(idle, 'continue-operation').state, 'waiting', 'a stopped operation is not being worked on right now');
  assert.match(byKey(idle, 'continue-operation').next, /next review/);
  const stuck = businessWork({ ...running, business: { blockers: [{ code: 'current-operation' }], authorityHash: AUTH, currentOperation: operation() }, coverage });
  assert.equal(byKey(stuck, 'continue-operation').state, 'blocked', 'a blocked operation is not shown as progressing');
  const paused = businessWork({ ...running, settings: { monitoring: true, autonomous: false }, business: { blockers: [{ code: 'current-operation' }], authorityHash: AUTH, currentOperation: operation({ status: 'running' }) }, coverage });
  assert.equal(byKey(paused, 'continue-operation').state, 'waiting');
  for (const changed of [operation({ status: 'previewed' }), operation({ agentAuthority: { ...operation().agentAuthority, grantId: 'old' } })]) {
    const work = businessWork({ ...running, business: { blockers: [{ code: 'current-operation' }], authorityHash: AUTH, currentOperation: changed }, coverage });
    assert.equal(byKey(work, 'continue-operation'), undefined);
    assert.equal(byKey(work, 'settle-operations').state, 'blocked');
  }
});

test('recovery, unknown blockers, sync and missing data stay visible and never crash', () => {
  const blockers = [{ code: 'uncertain-write' }, { code: 'completion-pending' }, { code: 'coordination-paused' }, { code: 'business-state-unavailable', title: 'Business state needs another read', detail: 'Retry.' }];
  const work = businessWork({ ...running, sync: { status: 'catching-up' }, business: { blockers, authorityHash: AUTH }, coverage: null });
  for (const key of ['uncertain-write', 'completion-pending', 'coordination-paused', 'blocker-business-state-unavailable']) assert.equal(byKey(work, key).state, 'blocked');
  assert.equal(byKey(work, 'catch-up').state, 'working');
  assert.equal(byKey(work, 'check-features').owner, 'accountant');
  assert.doesNotThrow(() => businessWork({ settings: null, agent: null, business: null, sync: null }));
});

test('owner-reserved states stay with the owner', () => {
  const work = businessWork({ ...running, business: { blockers: [{ code: 'calendar-stopped' }], authorityHash: AUTH }, agent: { ...running.agent, lastError: 'The model service could not finish this review. Check the AI connection in Settings.' }, coverage });
  assert.deepEqual(ownerKeys(work), ['calendar-stopped', 'ai-connection']);
  assert.equal(work.headline, '2 things need you.');
});

test('the calendar cursor distinguishes adopted import history from verified activity', () => {
  const { calendarCursor } = require('../src/modules/business-calendar');
  assert.deepEqual(calendarCursor(null), { through: null, basis: null, adoptedThrough: null });
  assert.deepEqual(calendarCursor({ verifiedThrough: '2026-10-17', adoption: null }), { through: '2026-10-17', basis: 'verified', adoptedThrough: null });
  const adoption = { kind: 'adopted-history', through: '2026-10-17' };
  assert.deepEqual(calendarCursor({ verifiedThrough: '2026-10-17', adoption }), { through: '2026-10-17', basis: 'adopted', adoptedThrough: '2026-10-17' });
  assert.equal(calendarCursor({ verifiedThrough: '2026-10-27', adoption }).basis, 'verified');
});

test('adopted history keeps its open balances as accountant work', () => {
  const work = businessWork({ ...running, business: { blockers: [], authorityHash: AUTH, adoptedThrough: '2026-10-20' }, coverage: null });
  const item = work.items.find(row => row.key === 'inherited-obligations');
  assert.equal(item.owner, 'accountant');
  assert.equal(item.state, 'on-duty', 'daily activity settles them under the approved rules; idle until then');
  const renew = businessWork({ ...running, business: { blockers: [], authorityHash: 'e'.repeat(64), adoptedThrough: '2026-10-20' }, coverage: null });
  assert.equal(byKey(renew, 'inherited-obligations').state, 'waiting');
  assert.match(byKey(renew, 'inherited-obligations').next, /approve/);
  assert.ok(ownerKeys(renew).includes('renew-authority'));
});

const DUTIES = ['receive-purchase-orders', 'correct-own-records', 'inherited-obligations'];
const adopted = { blockers: [], authorityHash: AUTH, adoptedThrough: '2026-10-20' };

test('standing duties are on duty, not spinning, while nothing is happening', () => {
  const work = businessWork({ ...running, business: adopted, coverage });
  for (const key of DUTIES) {
    assert.equal(byKey(work, key).state, 'on-duty', key + ' is enabled but idle');
    assert.equal(byKey(work, key).facts, undefined, 'no facts line without saved facts');
  }
  assert.equal(work.items.filter(item => item.state === 'working').length, 0, 'nothing spins when the accountant is idle');
  assert.equal(byKey(work, 'reviewing'), undefined);
  const paused = businessWork({ ...running, settings: { monitoring: true, autonomous: false }, business: adopted, coverage });
  for (const key of DUTIES) assert.equal(byKey(paused, key).state, 'waiting');
});

test('the spinner appears only while a review or a matching operation is in progress', () => {
  const reviewing = businessWork({ ...running, agent: { ...running.agent, reviewing: true, currentWork: 'Main accountant is reviewing and managing the business' }, business: adopted, coverage });
  assert.equal(byKey(reviewing, 'reviewing'), undefined, 'a review in progress is shown by rightNow, not as a list row');
  for (const key of DUTIES) assert.equal(byKey(reviewing, key).state, 'on-duty', 'a review alone does not mean every duty is in progress');
  const batch = status => ({ ...adopted, currentOperation: { operationId: 'o', status, activityBatch: { day: '2026-10-29', types: ['receive-purchase-order', 'pay-adopted-bill'] } } });
  const sending = businessWork({ ...running, business: batch('running'), coverage });
  assert.equal(byKey(sending, 'receive-purchase-orders').state, 'working');
  assert.match(byKey(sending, 'receive-purchase-orders').next, /Doing this now/);
  assert.equal(byKey(sending, 'inherited-obligations').state, 'working');
  assert.equal(byKey(sending, 'correct-own-records').state, 'on-duty', 'only the duties in the running batch spin');
  const finished = businessWork({ ...running, business: batch('verified'), coverage });
  for (const key of DUTIES) assert.equal(byKey(finished, key).state, 'on-duty');
});

test('each standing duty states what it has done from verified records', () => {
  const empty = businessWork({ ...running, business: adopted, coverage: null, facts: { done: {}, open: null } });
  assert.equal(byKey(empty, 'receive-purchase-orders').facts, 'Nothing received yet');
  assert.equal(byKey(empty, 'correct-own-records').facts, 'No corrections made yet');
  assert.equal(byKey(empty, 'inherited-obligations').facts, 'Nothing collected or paid yet');
  const facts = {
    done: {
      'receive-purchase-order': { count: 3, last: '2026-10-29', cents: 0 },
      'correct-own-record': { count: 1, last: '2026-10-27', cents: 0 },
      'collect-adopted-invoice': { count: 4, last: '2026-10-28', cents: 123456 },
      'pay-adopted-bill': { count: 1, last: '2026-10-29', cents: 5000 },
    },
    open: { invoices: { count: 12, cents: 432100 }, bills: { count: 0, cents: 0 } },
  };
  const work = businessWork({ ...running, business: adopted, coverage: null, facts });
  assert.equal(byKey(work, 'receive-purchase-orders').facts, 'Received 3 purchase orders · last Oct 29');
  assert.equal(byKey(work, 'correct-own-records').facts, 'Corrected 1 record · last Oct 27');
  assert.equal(byKey(work, 'inherited-obligations').facts, 'Collected 4 invoices ($1,234.56) and paid 1 bill ($50.00) · last Oct 29 · Still open: 12 invoices ($4,321.00)');
  const cleared = businessWork({ ...running, business: adopted, coverage: null, facts: { ...facts, open: { invoices: { count: 0, cents: 0 }, bills: { count: 0, cents: 0 } } } });
  assert.match(byKey(cleared, 'inherited-obligations').facts, / · Nothing left open$/);
  const renew = businessWork({ ...running, business: { ...adopted, authorityHash: 'e'.repeat(64) }, coverage: null, facts });
  assert.equal(byKey(renew, 'receive-purchase-orders').state, 'waiting');
  assert.equal(byKey(renew, 'receive-purchase-orders').facts, 'Received 3 purchase orders · last Oct 29', 'facts stay visible while waiting');
});

const pass = { id: 'pass-1', role: 'accountant', startedAt: '2026-10-30T18:20:00.000Z' };
const live = { configured: true, settings: { monitoring: true, autonomous: true }, sync: { status: 'current' }, nextDecisionAt: '2026-10-30T19:22:00.000Z', lastDecisionAt: '2026-10-30T18:21:00.000Z' };
const completed = [
  { kind: 'review-completed', at: '2026-10-30T17:21:00.000Z', detail: 'Older review.' },
  { kind: 'plan-decision', at: '2026-10-30T18:22:00.000Z', detail: 'Not a review.' },
  { kind: 'review-completed', at: '2026-10-30T18:21:00.000Z', detail: '## Summary\n**Confirmed** $399 still due; nothing posted.\nMore detail.' },
];

test('rightNow is idle between reviews with the next review time and a one-line result of the last one', () => {
  const view = rightNow({ ...live, events: completed });
  assert.equal(view.state, 'idle');
  assert.equal(view.nextReviewAt, '2026-10-30T19:22:00.000Z');
  assert.equal(view.lastReviewAt, '2026-10-30T18:21:00.000Z');
  assert.equal(view.lastSummary, 'Summary', 'first non-empty line, markdown removed');
  assert.deepEqual(view.steps, []);
  assert.equal(rightNow({ ...live, events: [{ kind: 'review-completed', at: completed[2].at, detail: '\n**Confirmed** $399 still due; nothing posted.\nMore.' }] }).lastSummary, 'Confirmed $399 still due; nothing posted.');
  const none = rightNow({ ...live, events: [] });
  assert.equal(none.lastReviewAt, '2026-10-30T18:21:00.000Z');
  assert.equal(none.lastSummary, '');
  assert.equal(oneLine('x'.repeat(400)).length, 220);
});

test('rightNow states pauses, stops and catch-up plainly instead of a next review', () => {
  assert.equal(rightNow({ ...live, configured: false }).state, 'not-configured');
  assert.equal(rightNow({ ...live, settings: { monitoring: false, autonomous: true } }).state, 'stopped');
  const paused = rightNow({ ...live, settings: { monitoring: true, autonomous: false } });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.nextReviewAt, null);
  const limited = rightNow({ ...live, usage: { pause: { title: 'Monthly cap reached', resetAt: '2026-11-01T00:00:00.000Z', detail: 'x' } } });
  assert.equal(limited.state, 'usage-paused');
  assert.deepEqual(limited.pause, { title: 'Monthly cap reached', resetAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(limited.nextReviewAt, '2026-11-01T00:00:00.000Z');
  assert.equal(rightNow({ ...live, recovering: true }).state, 'recovering');
  assert.equal(rightNow({ ...live, sync: { status: 'catching-up' } }).state, 'catching-up');
});

test('rightNow shows the live review with its latest steps, newest first, only for the active pass', () => {
  const steps = Array.from({ length: 11 }, (_, index) => ({ at: new Date(Date.parse(pass.startedAt) + index * 1000).toISOString(), label: 'Step ' + index, status: index === 10 ? 'running' : 'done', input: { secret: 'never shown' } }));
  const view = rightNow({ ...live, reviewing: true, activePass: pass, progress: { passId: 'pass-1', startedAt: '2026-10-30T18:20:05.000Z', steps }, events: completed });
  assert.equal(view.state, 'reviewing');
  assert.equal(view.role, 'accountant');
  assert.equal(view.startedAt, '2026-10-30T18:20:05.000Z');
  assert.equal(view.steps.length, 8);
  assert.equal(view.steps[0].label, 'Step 10');
  assert.equal(view.steps[0].status, 'running');
  assert.equal(view.earlierSteps, 3);
  assert.deepEqual(Object.keys(view.steps[0]).sort(), ['at', 'label', 'status'], 'labels, status and time only');
  const stale = rightNow({ ...live, reviewing: true, activePass: pass, progress: { passId: 'older-pass', steps } });
  assert.deepEqual(stale.steps, [], 'steps from another pass are never shown');
  assert.equal(stale.startedAt, pass.startedAt);
  assert.equal(rightNow({ ...live, reviewing: true, activePass: pass, settings: { monitoring: true, autonomous: false } }).state, 'reviewing', 'a review already running is shown as running');
});

// Continuous-business Phase 1: today's activity and calendar catch-up are visible accountant work.
const cadenceModule = require('../src/modules/business-agent-cadence');
const friday = cadenceModule.summarizeToday({ rhythm: cadenceModule.dayRhythm('2026-10-30'), now: Date.parse('2026-10-30T17:15:00Z'),
  runs: [{ id: 'r1', status: 'verified', decisionKey: 'slot-20261030-r1-s1', createdAt: 0, createCount: 7 }, { id: 'r2', status: 'running', decisionKey: 'slot-20261030-r1-s2', createdAt: 0, createCount: 5 }],
  receipts: [...Array.from({ length: 7 }, (_, i) => ({ operationId: 'r1', entity: 'invoice', logicalKey: 'a' + i })), { operationId: 'r2', entity: 'invoice', logicalKey: 'b' }] });
test('today’s activity states planned, saved, verified and in-progress counts and the next slot', () => {
  assert.equal(friday.saved, 8);
  const work = businessWork({ ...running, today: friday, cadence: { kind: 'idle', reason: 'next activity slot', nextReviewAt: '2026-10-30T17:30:00.000Z' } });
  const item = byKey(work, 'todays-activity');
  assert.equal(item.owner, 'accountant');assert.equal(item.state, 'on-duty');
  assert.equal(item.facts, 'Today (Fri Oct 30): 150 planned · 8 in QuickBooks (7 verified) · 4 in progress');
  assert.match(item.detail, /Activity slot 6 of 10 is due now: about 30 records of genuine business work/);
  assert.equal(item.next, 'Next review 2:30 PM (next activity slot).');
  assert.equal(work.needsOwner, 0);
  const closed = businessWork({ ...running, today: cadenceModule.summarizeToday({ rhythm: cadenceModule.dayRhythm('2026-11-01'), now: Date.parse('2026-11-01T16:00:00Z') }) });
  assert.match(byKey(closed, 'todays-activity').detail, /closed today/);
});
test('a calendar behind yesterday shows what is closed, what is closing and when it tries next', () => {
  const calendarClose = cadenceModule.nextClose({ verifiedThrough: '2026-10-27' }, '2026-10-30');
  const work = businessWork({ ...running, business: { ...running.business, verifiedThrough: '2026-10-27' }, today: friday, calendarClose, cadence: { kind: 'catch-up', reason: 'closing Oct 28–Oct 29', nextReviewAt: '2026-10-30T17:17:00.000Z' } });
  const item = byKey(work, 'close-calendar');
  assert.equal(item.state, 'on-duty');
  assert.match(item.detail, /^Calendar closed through Oct 27 · closing Oct 28–Oct 29 \(2 days behind\)\./);
  assert.equal(item.next, 'Closing Oct 28–Oct 29 · next try 2:17 PM.');
  assert.match(byKey(work, 'todays-activity').detail, /starts once the calendar is closed through yesterday/);
  const held = businessWork({ ...running, business: { ...running.business, verifiedThrough: '2026-10-27' }, calendarClose, cadence: { kind: 'held', reason: 'held: a QuickBooks request needs recovery' } });
  assert.equal(byKey(held, 'close-calendar').state, 'blocked');
});
test('rightNow carries the Today line, the cadence reason and any calendar lag', () => {
  const view = rightNow({ ...live, today: friday, cadence: { kind: 'idle', reason: 'business hours' } });
  assert.equal(view.today.line, 'Today (Fri Oct 30): 150 planned · 8 in QuickBooks (7 verified) · 4 in progress');
  assert.deepEqual(view.cadence, { kind: 'idle', reason: 'business hours' });assert.equal(view.calendar, null);
  const behind = rightNow({ ...live, calendarClose: cadenceModule.nextClose({ verifiedThrough: '2026-10-28' }, '2026-10-30') });
  assert.deepEqual(behind.calendar, { closedThrough: 'Oct 28', closing: 'Oct 29', behindDays: 1 });
  assert.equal(rightNow({ ...live }).today, null, 'missing data omits the line');
});
