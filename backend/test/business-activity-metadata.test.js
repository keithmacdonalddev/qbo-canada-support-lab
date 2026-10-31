'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewMetadata, createBusinessAgentUsage, normalizeUsage } = require('../src/modules/business-agent-usage');
const { buildLiveFeed } = require('../src/modules/business-agent-live');
const { createReviewProgress } = require('../src/modules/business-agent-progress');
const { createBusinessAgentService } = require('../src/modules/business-agent-service');
const { createBusinessAgentTools } = require('../src/modules/business-agent-tools');
const NOW = Date.parse('2026-10-31T20:00:00Z');
const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const scope = { environment: 'production', realmId: '123456789', connectionId: 'a'.repeat(24) };
const iso = offset => new Date(NOW + offset).toISOString();
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, actual + ' != ' + expected);
const row = (extra = {}) => ({ _id: ATTEMPT, passId: 'pass-1', provider: 'codex', model: 'gpt-6.1-sol', billing: 'included in plan', outcome: 'completed', startedAt: iso(-90000), finishedAt: iso(-2000), ...normalizeUsage('codex', { inputTokens: 5000000, cachedInputTokens: 4000000, outputTokens: 100000 }), ...extra });

test('review details use measured duration and charge cached input once', () => {
  const view = reviewMetadata(row(), NOW);
  assert.equal(view.durationMs, 88000);
  assert.equal(view.running, false);
  assert.equal(view.tokens.totalTokens, 5100000);
  assert.equal(view.tokens.inputTokens, 5000000);
  assert.equal(view.tokens.uncachedInputTokens, 1000000);
  assert.equal(view.tokens.cachedInputTokens, 4000000);
  near(view.cost.lowUsd, 3.4); near(view.cost.highUsd, 3.4);
  near(view.cost.components.inputUsd, 2); near(view.cost.components.cachedInputUsd, 0.4); near(view.cost.components.outputUsd, 1);
  assert.equal(view.cost.basis, 'api-equivalent');
});
test('Anthropic costs include both cache-write durations and cache reads', () => {
  const usage = normalizeUsage('anthropic', { input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 2000000, cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_1h_input_tokens: 400000 } });
  const view = reviewMetadata(row({ ...usage, provider: 'anthropic', model: 'claude-sonnet-5-5' }), NOW);
  assert.equal(view.tokens.totalTokens, 4100000);
  near(view.cost.lowUsd, 6.3); near(view.cost.components.cacheWrite5mUsd, 1.5); near(view.cost.components.cacheWrite1hUsd, 1.6);
  assert.equal(view.cost.basis, 'api-estimate');
});
test('legacy input is a range, unknown models stay unpriced, missing usage never becomes free usage', () => {
  const legacy = reviewMetadata(row({ ...normalizeUsage('codex', { inputTokens: 1000000, outputTokens: 100000 }) }), NOW);
  assert.equal(legacy.tokens.cachedInputTokens, null); assert.equal(legacy.tokens.uncachedInputTokens, null);
  near(legacy.cost.lowUsd, 1.1); near(legacy.cost.highUsd, 3);
  assert.equal(reviewMetadata(row({ model: 'unknown' }), NOW).cost, null);
  const missing = reviewMetadata(row({ ...normalizeUsage('codex', null), outcome: 'failed', finishedAt: null }), NOW);
  assert.equal(missing.tokens, null); assert.equal(missing.cost, null); assert.equal(missing.durationMs, null);
  const partial = reviewMetadata(row({ usageMissing: true }), NOW);
  assert.equal(partial.cost.partial, true); assert.equal(partial.tokens.totalTokens, 5100000);
  const running = reviewMetadata(row({ finishedAt: null, outcome: 'running' }), NOW);
  assert.equal(running.running, true); assert.equal(running.durationMs, 90000);
  assert.equal(reviewMetadata(row({ finishedAt: iso(-100000) }), NOW).durationMs, null);
});
test('usage detail lookup is bounded, company scoped, read only and allowlisted', async () => {
  let filter, selected, limit, timeout, queries = 0;
  const Usage = { find(value) { queries++; filter = value; return { select(value) { selected = value; return this; }, sort() { return this; }, limit(value) { limit = value; return this; }, maxTimeMS(value) { timeout = value; return this; }, lean: async () => [row({ prompt: 'PRIVATE_PROMPT', apiKey: 'PRIVATE_KEY', response: 'PRIVATE_RESPONSE' })] }; } };
  const usage = createBusinessAgentUsage({ Usage, now: () => NOW });
  assert.deepEqual(await usage.details(scope, { attemptIds: [{ $ne: null }, '../other'] }), []); assert.equal(queries, 0);
  const [view] = await usage.details(scope, { attemptIds: [ATTEMPT, ATTEMPT], passIds: ['pass-1'] });
  assert.equal(filter.environment, scope.environment); assert.equal(filter.realmId, scope.realmId); assert.equal(filter.connectionId, scope.connectionId);
  assert.deepEqual(filter.$or[0]._id.$in, [ATTEMPT]);
  assert.ok(limit <= 240); assert.ok(timeout <= 2000);
  for (const privateField of ['prompt', 'apiKey', 'response']) assert.ok(!selected.includes(privateField));
  assert.ok(!JSON.stringify(view).includes('PRIVATE_'));
});
test('activity joins exact review IDs, rejects ambiguous passes and never guesses by timestamp', () => {
  const review = reviewMetadata(row(), NOW);
  const events = [{ id: 'finished', kind: 'review-completed', at: iso(-2000), attemptId: ATTEMPT }, { id: 'decision', kind: 'management-decision', at: iso(-3000), passId: 'pass-1' }, { id: 'old', kind: 'plan-decision', at: iso(-3001) }, { id: 'missing', kind: 'review-completed', at: iso(-3002), attemptId: 'missing-attempt', passId: 'pass-1' }];
  const feed = buildLiveFeed({ now: NOW, events, reviews: [review], runs: [{ _id: 'b'.repeat(24), status: 'blocked', createdAt: iso(-10000), updatedAt: iso(-1000) }], steps: [{ _id: 'step', entity: 'Invoice', state: 'verified', createdAt: iso(-6000), updatedAt: iso(-1000) }] });
  const meta = id => feed.items.find(item => item.id === 'event:' + id).metadata;
  assert.equal(meta('finished').review.attemptId, ATTEMPT); assert.equal(meta('finished').attribution, 'review');
  assert.equal(meta('decision').review.attemptId, ATTEMPT); assert.equal(meta('decision').attribution, 'associated-review');
  assert.equal(meta('old').review, null); assert.equal(meta('missing').review, null);
  assert.equal(feed.items.find(item => item.id === 'step:step').metadata.timing.durationMs, 5000);
  assert.equal(feed.items.find(item => item.id.endsWith(':status')).metadata.timing.durationMs, 9000);
  const ambiguous = buildLiveFeed({ now: NOW, events, reviews: [review, { ...review, attemptId: 'another-attempt' }] });
  assert.equal(ambiguous.items.find(item => item.id === 'event:decision').metadata.review, null);
});
function serviceFixture() {
  const state = { denied: false, failed: false, reads: [], row: {}, usageRows: [row()] };
  const store = { models: {}, get: async () => ({ _id: 'agent-fixture', revision: 1, ...scope, settings: { monitoring: true }, ...state.row }), events: async () => [{ id: 'event', kind: 'review-completed', at: iso(-2000), attemptId: ATTEMPT }], liveActivity: async () => ({ runs: [], steps: [], records: [] }), transcripts: { attempts: async () => [{ attemptId: ATTEMPT, startedAt: iso(-90000) }] } };
  const usage = { details: async (selected, refs) => { state.reads.push({ selected, refs }); if (state.failed) throw Error('private database failure'); return state.usageRows.map(value => reviewMetadata(value, NOW)); } };
  const service = createBusinessAgentService({ store, usage, now: () => NOW, engine: {}, execution: {}, createSync: () => ({}), requestMeter: {}, resolveContext: async () => ({ environment: scope.environment, connection: { connected: true, realmId: scope.realmId, connectionId: scope.connectionId } }), accessFor: () => ({ authorize: async () => { if (state.denied) throw Error('denied'); } }) });
  return { service, state };
}
test('live feed and transcript attempts expose retained usage without provider work, and keep activity on metadata failure', async () => {
  const { service, state } = serviceFixture();
  try {
    assert.equal((await service.live({ id: 'c'.repeat(24) })).items[0].metadata.review.tokens.totalTokens, 5100000);
    assert.equal((await service.transcripts({ id: 'c'.repeat(24) })).attempts[0].metadata.review.durationMs, 88000);
    for (const read of state.reads) assert.deepEqual(read.selected, scope);
    state.failed = true;
    const feed = await service.live({ id: 'c'.repeat(24) });
    assert.equal(feed.items.length, 1); assert.equal(feed.items[0].metadata.attribution, 'unavailable');
    assert.ok(!JSON.stringify(feed).includes('private database failure'));
    state.denied = true;
    await assert.rejects(service.live({ id: 'c'.repeat(24) }), /denied/);
  } finally { service.close(); }
});
test('tool timing records success and failure, without retaining tool input', async () => {
  let clock = NOW; const progress = createReviewProgress({ now: () => clock });
  await progress.wrap(async () => { clock += 1250; return { success: true }; })('searchEntities', { secret: 'PRIVATE_INPUT' });
  await assert.rejects(progress.wrap(async () => { clock += 500; throw Error('failure'); })('searchEntities', {}));
  const steps = progress.steps();
  assert.equal(Date.parse(steps[0].finishedAt) - Date.parse(steps[0].at), 1250);
  assert.equal(Date.parse(steps[1].finishedAt) - Date.parse(steps[1].at), 500);
  assert.ok(!JSON.stringify(steps).includes('PRIVATE_INPUT'));
});
test('new decision events retain server review identities without expanding the model tool contract', async () => {
  let data;
  const tools = createBusinessAgentTools({ row: { _id: 'agent', grant: { id: 'grant' } }, scope, passId: 'pass-1', attemptId: ATTEMPT, store: { event: async (_row, _kind, _title, _detail, fields) => { data = fields; return { id: 'event' }; } }, access: {}, user: {}, guard: async () => {}, readTools: { toolDefinitions: [] } });
  await tools.execute('recordBusinessDecision', { issueKey: 'example-decision', title: 'Example', detail: 'Sanitized decision.', area: 'business', requiresOwner: false });
  assert.equal(data.passId, 'pass-1'); assert.equal(data.attemptId, ATTEMPT);
  await assert.rejects(tools.execute('recordBusinessDecision', { issueKey: 'example-decision', title: 'Example', detail: 'Sanitized.', area: 'business', requiresOwner: false, attemptId: 'forged' }), /unsupported field/);
});

test('only the exact live attempt accrues time; expired reviews and retry setup never borrow prior usage', async () => {
  const { service, state } = serviceFixture();
  state.usageRows = [row({ startedAt: iso(-420000), finishedAt: null, outcome: 'running' })];
  state.row = { leaseToken: 'fixture-lease', leaseExpiresAt: iso(60000), status: 'reviewing', activePass: { id: 'pass-1' }, reviewProgress: { passId: 'pass-1', attemptId: ATTEMPT, startedAt: iso(-420000), steps: [] } };
  try {
    const live = await service.live({ id: 'c'.repeat(24) });
    const current = live.items.find(item => item.kind === 'review').metadata.review;
    assert.equal(current.running, true); assert.equal(current.durationMs, 420000, 'valid long reviews are not cut off by a stale-time heuristic');
    state.row.leaseExpiresAt = iso(-1);
    const abandoned = (await service.transcripts({ id: 'c'.repeat(24) })).attempts[0].metadata.review;
    assert.equal(abandoned.running, false); assert.equal(abandoned.durationMs, null); assert.equal(abandoned.usageMissing, true); assert.equal(abandoned.cost.partial, true);
    state.row.leaseExpiresAt = iso(60000); state.row.reviewProgress.attemptId = '00000000-0000-4000-8000-000000000002';
    const retry = await service.live({ id: 'c'.repeat(24) });
    assert.equal(retry.items.find(item => item.kind === 'review').metadata.review, null, 'new retry without a usage row cannot reuse old pass usage');
    delete state.row.reviewProgress.attemptId;
    assert.equal((await service.live({ id: 'c'.repeat(24) })).items.find(item => item.kind === 'review').metadata.review, null, 'legacy progress has no proven attempt');
  } finally { service.close(); }
});
test('specialist decisions share review totals; only terminal reports represent the full review', () => {
  const review = reviewMetadata(row(), NOW);
  const feed = buildLiveFeed({ now: NOW, reviews: [review], events: [{ id: 'decision', kind: 'specialist-report', attemptId: ATTEMPT, at: iso(-2000) }, { id: 'terminal', kind: 'specialist-report', attemptId: ATTEMPT, outcome: 'completed', at: iso(-1000) }] });
  assert.equal(feed.items.find(item => item.id === 'event:decision').metadata.attribution, 'associated-review');
  assert.equal(feed.items.find(item => item.id === 'event:terminal').metadata.attribution, 'review');
});

test('duration and USD formatting preserve short work and very small nonzero charges', async () => {
  const { durationText, usdText, costText, transcriptMetadata } = await import('../../frontend/src/lib/activity-metadata.mjs');
  assert.equal(durationText(125), '125 ms'); assert.equal(durationText(125000), '2m 5s'); assert.equal(durationText(null), 'Not recorded');
  assert.equal(usdText(0), '$0.0000'); assert.equal(usdText(0.000001), '<$0.0001'); assert.equal(usdText(null), 'Unavailable');
  assert.equal(costText({ lowUsd: 1, highUsd: 2 }), '$1.0000–$2.0000');
})
test('transcript tools pair only within their attempt and share review totals without allocating costs', async () => {
  const { durationText, usdText, costText, transcriptMetadata } = await import('../../frontend/src/lib/activity-metadata.mjs');
  const entries = [{ attemptId: 'attempt-one', callId: 'call-1', kind: 'tool-call', at: '2026-10-31T20:00:00Z' }, { attemptId: 'attempt-two', callId: 'call-1', kind: 'tool-result', at: '2026-10-31T20:00:01Z' }, { attemptId: 'attempt-one', callId: 'call-1', kind: 'tool-result', at: '2026-10-31T20:00:02.250Z' }]
  const review = { durationMs: 20000, cost: { lowUsd: 1, highUsd: 1 } }
  const metadata = transcriptMetadata(entries[0], entries, review)
  assert.equal(metadata.timing.durationMs, 2250); assert.equal(metadata.review, review); assert.equal(metadata.attribution, 'associated-review');
  assert.equal(transcriptMetadata({ kind: 'message' }, entries).timing, null);
  assert.equal(transcriptMetadata(entries[0], entries, null, true).attribution, 'unavailable');
})

test('an unmatched transcript tool needs confirmed active-review evidence before accruing time', async () => {
  const { durationText, usdText, costText, transcriptMetadata } = await import('../../frontend/src/lib/activity-metadata.mjs');
  const entry = { attemptId: 'attempt-one', callId: 'call-1', kind: 'tool-call', at: '2026-10-31T20:00:00Z' }
  assert.equal(transcriptMetadata(entry, [entry]).timing.running, false)
  assert.equal(transcriptMetadata(entry, [entry], null, true).timing.running, false)
  assert.equal(transcriptMetadata(entry, [entry], { running: false }).timing.running, false)
  assert.equal(transcriptMetadata(entry, [entry], { running: true }).timing.running, true)
})
