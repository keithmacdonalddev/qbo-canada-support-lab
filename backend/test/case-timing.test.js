'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { firstRequest, caseTiming } = require('../src/modules/case-timing');
const now = Date.parse('2026-10-06T04:00:00Z');
function session() { return { createdAt: '2026-10-05T17:22:59Z', messages: [{ role: 'user', timestamp: '2026-10-05T17:23:00Z' }], reproduction: {
  startedAt: '2026-10-06T03:30:00Z', completedAt: '2026-10-06T03:43:00Z', status: 'completed', outcome: 'not_reproduced',
} }; }
test('full request-to-result duration includes continuation gaps and separately measures latest run', () => {
  const timing = caseTiming(session(), now);
  assert.equal(timing.elapsedMs, (10 * 60 + 20) * 60000); assert.equal(timing.latestRunMs, 13 * 60000);
  assert.equal(timing.verifiedResult, true); assert.equal(timing.firstSubmissionSource, 'earliest_saved_message');
});
test('saved first submission survives later continuation messages and run start changes', () => {
  const value = session(); value.reproduction.firstSubmittedAt = '2026-10-05T17:22:58Z'; value.reproduction.firstSubmissionSource = 'recorded_request';
  value.messages.push({ role: 'user', timestamp: '2026-10-06T03:30:00Z' });
  assert.equal(firstRequest(value, now).firstSubmittedAt, '2026-10-05T17:22:58.000Z');
});
test('running duration uses now and ignores stale completed timestamps', () => {
  const value = session(); value.reproduction.status = 'running'; value.reproduction.completedAt = '2026-10-05T18:00:00Z';
  const timing = caseTiming(value, now); assert.equal(timing.running, true); assert.equal(timing.latestRunMs, 30 * 60000); assert.equal(timing.verifiedResult, false);
});
test('missing or impossible finish times do not become a measured result', () => {
  for (const completedAt of [undefined, 'invalid', '2026-10-05T18:00:00Z', '2026-10-07T00:00:00Z']) {
    const value = session(); value.reproduction.completedAt = completedAt;
    assert.equal(caseTiming(value, now).available, false);
  }
  assert.equal(caseTiming({ reproduction: { status: 'running' } }, now).available, false);
  assert.equal(caseTiming({ reproduction: { status: 'running', firstSubmittedAt: '2027-01-01' } }, now).available, false);
});
test('older session-created timestamps are explicitly estimates and inconclusive result stays inconclusive', () => {
  const value = session(); value.messages = []; value.reproduction.outcome = 'unverified';
  const timing = caseTiming(value, now); assert.equal(timing.firstSubmissionSource, 'session_created_estimate'); assert.equal(timing.verifiedResult, false);
});
