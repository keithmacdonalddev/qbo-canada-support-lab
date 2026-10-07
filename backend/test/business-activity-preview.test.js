'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activityDefinition, previewBusinessActivity, businessDate } = require('../src/modules/business-activity-preview');
const { proposalView } = require('../src/modules/blueprint-draft');
function fixture() {
  return { realmId: '123', environment: 'sandbox', connectionId: 'aaaaaaaaaaaaaaaaaaaaaaaa', draft: null, proposal: proposalView() };
}
const request = { connectionId: 'aaaaaaaaaaaaaaaaaaaaaaaa', baseHash: null, fromDate: '2026-09-01', throughDate: '2026-09-30' };
test('activity patterns match the approved nominal targets with the same stable cohorts at both scales', () => {
  const business = fixture().proposal.business;
  const small = activityDefinition({ ...business, volumeProfile: 'development' });
  const full = activityDefinition({ ...business, volumeProfile: 'flagship' });
  assert.equal(small.rules.reduce((sum, rule) => sum + rule.steps.length, 0), 70);
  assert.equal(full.rules.reduce((sum, rule) => sum + rule.steps.length, 0), 260);
  for (const rule of small.rules) assert.deepEqual(rule, full.rules.find(item => item.key === rule.key));
  assert.deepEqual([...new Set(full.rules.map(rule => rule.divisionKey))].sort(), ['care-plans', 'field-advisory', 'supply-workshop']);
});
test('preview retains dependent records across periods without declaring them missing or executable', () => {
  const result = previewBusinessActivity(fixture(), request, '2026-10-06');
  assert.ok(result.events.length > 0); assert.ok(result.future.length > 0); assert.ok(result.prerequisites.length > 0);
  assert.ok(result.events.every(event => event.txnDate >= request.fromDate && event.txnDate <= request.throughDate));
  assert.ok(result.future.every(event => event.txnDate > request.throughDate));
  const keys = new Set([...result.events, ...result.future, ...result.prerequisites].map(event => event.logicalKey));
  for (const event of [...result.events, ...result.future, ...result.prerequisites]) assert.ok(event.dependsOn.every(key => keys.has(key)));
  assert.equal(result.executable, false); assert.equal(result.baselineCompared, false); assert.equal(result.calendarVerified, false);
  assert.equal(result.source.kind, 'proposal');
});
test('repeated previews and adjacent date windows keep identity stable', () => {
  const view = fixture(), all = previewBusinessActivity(view, request, '2026-10-06');
  assert.deepEqual(all, previewBusinessActivity(view, request, '2026-10-06'));
  const first = previewBusinessActivity(view, { ...request, throughDate: '2026-09-15' }, '2026-10-06');
  const second = previewBusinessActivity(view, { ...request, fromDate: '2026-09-16' }, '2026-10-06');
  const ids = rows => rows.map(event => event.logicalKey + ':' + event.fingerprint).sort();
  assert.deepEqual(ids(all.events), ids([...first.events, ...second.events]));
});
test('preview rejects changed company, changed saved version and caller policy overrides', () => {
  for (const changed of [{ ...request, connectionId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, { ...request, baseHash: 'a'.repeat(64) }]) assert.throws(() => previewBusinessActivity(fixture(), changed, '2026-10-06'), error => error.status === 409);
  for (const change of [{ environment: 'production' }, { volumeProfile: 'scale' }, { fromDate: '2026-02-30' }, { throughDate: '2026-11-01' }, { fromDate: '2022-01-01' }, { fromDate: '2024-01-01' }]) assert.throws(() => previewBusinessActivity(fixture(), { ...request, ...change }, '2026-10-06'), error => error.status === 400);
});
test('saved-draft source uses its settings and preserves its hash for later comparisons', () => {
  const view = fixture(); view.draft = { ...view.proposal, version: 3, contentHash: 'a'.repeat(64), business: { ...view.proposal.business, volumeProfile: 'development' } };
  const result = previewBusinessActivity(view, { ...request, baseHash: view.draft.contentHash }, '2026-10-06');
  assert.equal(result.monthlyTarget, 70); assert.equal(result.source.blueprintHash, view.draft.contentHash); assert.equal(result.source.blueprintVersion, 3);
});
test('business date follows Halifax across midnight and daylight saving, not browser timezone', () => {
  assert.equal(businessDate(new Date('2026-10-06T02:00:00Z')), '2026-10-05');
  assert.equal(businessDate(new Date('2026-10-06T03:00:00Z')), '2026-10-06');
  assert.equal(businessDate(new Date('2026-01-06T03:30:00Z')), '2026-01-05');
});
