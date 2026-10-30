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
  { key: 'new-customers', label: 'New customers', status: 'missing', fill: 'assistant', entity: 'Customer' },
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
  assert.equal(features.state, 'working');
  assert.deepEqual(features.features.map(item => item.key), ['estimates', 'purchase-orders', 'refunds']);
  assert.deepEqual(byKey(work, 'new-workflows').features.map(item => item.key), ['new-customers']);
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
  assert.equal(item.state, 'working', 'daily activity settles them under the approved rules');
  const renew = businessWork({ ...running, business: { blockers: [], authorityHash: 'e'.repeat(64), adoptedThrough: '2026-10-20' }, coverage: null });
  assert.equal(byKey(renew, 'inherited-obligations').state, 'waiting');
  assert.match(byKey(renew, 'inherited-obligations').next, /approve/);
  assert.ok(ownerKeys(renew).includes('renew-authority'));
});
