const test = require('node:test');
const assert = require('node:assert/strict');
const now = Date.parse('2026-10-06T12:00:00Z');
const result = { checkedAt: new Date(now).toISOString(), asOf: '2026-10-06', evidence: { complete: true }, areas: [{ key: 'sales', signals: [{ key: 'invoice', status: 'ok' }] }] };
async function readiness(args) { const { companyReadiness } = await import('../../frontend/src/lib/company-readiness.mjs'); return companyReadiness({ ready: true, result, state: 'ready', now, ...args }); }
test('all feature checks passing does not claim a complete company', async () => {
  const view = await readiness();
  assert.equal(view.title, 'Activity checks passed; completeness is not verified');
  assert.equal(view.calendarVerified, false);
  assert.equal(view.reportsVerified, false);
  assert.notEqual(view.tone, 'ok');
});
test('failed refresh preserves gaps without presenting them as current', async () => {
  const view = await readiness({ state: 'error', result: { ...result, areas: [{ key: 'sales', signals: [{ key: 'receipt', status: 'stale', last: '2026-06-30' }] }] } });
  assert.equal(view.checkFailed, true);
  assert.equal(view.gaps.length, 1);
});
test('old, future and absent check timestamps are not fresh evidence', async () => {
  for (const checkedAt of [undefined, '2026-10-05T00:00:00Z', '2026-10-07T00:00:00Z']) {
    assert.equal((await readiness({ result: { ...result, checkedAt } })).stale, true);
  }
});
test('disconnected and failed initial reads cannot imply empty books', async () => {
  assert.equal((await readiness({ ready: false })).title, 'Waiting on QuickBooks');
  assert.equal((await readiness({ result: null, state: 'error' })).title, 'Business activity could not be checked');
});
