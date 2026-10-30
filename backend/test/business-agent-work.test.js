'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { businessWork } = require('../src/modules/business-agent-work');

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
  const review = byKey(reviewing, 'reviewing');
  assert.equal(review.state, 'working');
  assert.equal(review.detail, 'Main accountant is reviewing and managing the business.');
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
