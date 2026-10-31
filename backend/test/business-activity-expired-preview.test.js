'use strict';
// A decision key whose preparation was never approved on an earlier business day must
// not hold that decision forever: today's preparation gets its own operation, the
// expired preview can never be approved and is retired unsent without touching the
// calendar slot. A key whose earlier-day work was approved or ran is refused plainly.
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/business-governance-fixture');
const config = require('../src/config'); const previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const DAY = 86400000;
async function calendar(h, throughDate, key) { const p = await h.service.prepare(h.user, { requestKey: key, throughDate }); await h.service.approve(h.user, p.operationId, { planHash: p.planHash }); const result = await h.runtime(p.operationId).execute(); assert.equal(result.complete, true, JSON.stringify(result)); return p; }
const sale = (decisionKey, unitPriceCents = 1000) => ({ decisionKey, purpose: 'Sell a monthly care plan to a returning client today.', activities: [{ type: 'settled-service-sale', customerKey: 'care-client-002', itemKey: 'care-plan-1', quantity: 1, unitPriceCents, purpose: 'Monthly care plan.' }] });

test('an expired activity preview gives way to today’s preparation and is retired unsent', { timeout: 300000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, openingDate: '2026-11-01' }); await h.publish(); await calendar(h, '2026-11-30', 'expired-preview-november');
  const stale = await h.service.prepareActivityBatch(h.user, sale('2026-12-01-held-collections-01'));
  const ran = await h.service.prepareActivityBatch(h.user, sale('2026-12-01-ran-sale-000001'));
  await h.service.approve(h.user, ran.operationId, { planHash: ran.planHash }); assert.equal((await h.runtime(ran.operationId).execute()).complete, true);
  await calendar(h, '2026-12-01', 'expired-preview-close-first');
  h.clock += DAY;
  // Same key, a new day and different work: a fresh day-scoped operation, not a refusal.
  const posts = h.posts, today = await h.service.prepareActivityBatch(h.user, sale('2026-12-01-held-collections-01', 1200));
  assert.notEqual(today.operationId, stale.operationId); assert.equal(today.reused, false);
  assert.equal((await h.service.prepareActivityBatch(h.user, sale('2026-12-01-held-collections-01', 1200))).operationId, today.operationId, 'same-day retries still reuse it');
  // The expired preview can never be approved.
  await assert.rejects(h.service.approve(h.user, stale.operationId, { planHash: stale.planHash }));
  await h.service.approve(h.user, today.operationId, { planHash: today.planHash }); assert.equal((await h.runtime(today.operationId).execute()).complete, true);
  assert.equal(h.posts, posts + 3);
  // A key whose earlier-day work ran is never repeated.
  await assert.rejects(h.service.prepareActivityBatch(h.user, sale('2026-12-01-ran-sale-000001')), /already used by operation .* Choose a new decisionKey/);
  // Governed retirement of the inert preview leaves the calendar slot untouched.
  const before = structuredClone({ calendar: h.data.Calendars[0], writer: h.data.Writers[0] });
  const review = await h.service.reviewRetirement(h.user, stale.operationId, { planHash: stale.planHash });
  assert.equal(review.review.expiredPreview, true); assert.equal(review.qboWrites, 0);
  const result = await h.service.retire(h.user, stale.operationId, { planHash: stale.planHash, reviewHash: review.reviewHash, reason: 'Expired preview from an earlier business day; never approved, nothing sent.' });
  assert.equal(result.retired, true);
  assert.equal(h.data.Runs.find(row => String(row._id) === stale.operationId).status, 'retired');
  assert.deepEqual({ calendar: h.data.Calendars[0], writer: h.data.Writers[0] }, before);
  // Retired keys from earlier days also give way to a fresh preparation today.
  const again = await h.service.prepareActivityBatch(h.user, sale('2026-12-01-held-collections-01', 1200));
  assert.equal(again.operationId, today.operationId);
});
