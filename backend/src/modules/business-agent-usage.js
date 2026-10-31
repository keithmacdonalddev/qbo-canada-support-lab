'use strict';
const { randomUUID } = require('node:crypto');
const prices = require('../config/business-agent-prices');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
// Codex/OpenAI input_tokens include cached input. When the cached part is reported, store fresh input
// and cached input separately (cacheSplit) so API-equivalent pricing is exact; totalTokens is unchanged.
function normalizeUsage(provider, usage) {
  const reportedInput = count(provider === 'codex' ? usage?.inputTokens : usage?.input_tokens);
  const codexCacheKnown = provider === 'codex' && Number.isSafeInteger(usage?.cachedInputTokens) && usage.cachedInputTokens >= 0;
  const codexCached = codexCacheKnown ? Math.min(reportedInput, usage.cachedInputTokens) : 0;
  const inputTokens = reportedInput - codexCached;
  const outputTokens = count(provider === 'codex' ? usage?.outputTokens : usage?.output_tokens);
  const cacheReadTokens = provider === 'anthropic' ? count(usage?.cache_read_input_tokens) : codexCached;
  const cacheWriteTokens = provider === 'anthropic' ? count(usage?.cache_creation_input_tokens) : 0;
  const cacheWrite1hTokens = Math.min(cacheWriteTokens, count(usage?.cache_creation?.ephemeral_1h_input_tokens));
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens, cacheSplit: provider === 'anthropic' || codexCacheKnown,
    usageMissing: !usage || !Number.isSafeInteger(provider === 'codex' ? usage.inputTokens : usage.input_tokens) || !Number.isSafeInteger(provider === 'codex' ? usage.outputTokens : usage.output_tokens) };
}
const rateFor = (provider, model) => Object.hasOwn(prices, model) && prices[model].provider === provider ? prices[model] : null;
// Actual API spend estimate: Anthropic API-key reviews only. Monthly API spend caps use this value.
function estimateCost(provider, model, usage) {
  const rate = rateFor(provider, model);
  if (provider !== 'anthropic' || !rate || usage.usageMissing) return null;
  return (usage.inputTokens * rate.input + usage.outputTokens * rate.output + usage.cacheReadTokens * rate.cacheRead
    + (usage.cacheWriteTokens - usage.cacheWrite1hTokens) * rate.cacheWrite5m + usage.cacheWrite1hTokens * rate.cacheWrite1h) / 1e6;
}
// API-equivalent: what the same usage would cost at the provider's pay-per-use API prices, however it was
// actually paid. Input is a summed group for one provider+model. Anthropic reuses the actual API estimate.
// Codex uses base rates (the long-context tier needs per-request sizes, which Codex does not report).
// Legacy Codex rows without a cache split are bounded: low = all their input priced as cached, high = all fresh.
function apiEquivalent(group) {
  const reviews = group.reviews || 0, legacyReviews = group.legacyReviews || 0;
  if (group.provider === 'anthropic') { const usd = group.estimatedCostUsd || 0; return { lowUsd: usd, highUsd: usd, unpricedReviews: group.unpricedReviews || 0, legacyReviews: 0 }; }
  const rate = rateFor(group.provider, group.model);
  if (!rate) return { lowUsd: 0, highUsd: 0, unpricedReviews: reviews, legacyReviews };
  const legacyInput = group.legacyInputTokens || 0, legacyOutput = group.legacyOutputTokens || 0;
  const exact = (((group.inputTokens || 0) - legacyInput) * rate.input + (group.cacheReadTokens || 0) * rate.cacheRead + ((group.outputTokens || 0) - legacyOutput) * rate.output) / 1e6;
  return { lowUsd: exact + (legacyInput * rate.cacheRead + legacyOutput * rate.output) / 1e6, highUsd: exact + (legacyInput * rate.input + legacyOutput * rate.output) / 1e6, unpricedReviews: 0, legacyReviews };
}
function combineEquivalent(items) {
  return items.reduce((sum, item) => ({ lowUsd: sum.lowUsd + item.lowUsd, highUsd: sum.highUsd + item.highUsd, unpricedReviews: sum.unpricedReviews + item.unpricedReviews, legacyReviews: sum.legacyReviews + item.legacyReviews }), { lowUsd: 0, highUsd: 0, unpricedReviews: 0, legacyReviews: 0 });
}
function windows(clock) {
  const day = new Date(clock); day.setUTCHours(0, 0, 0, 0);
  return { today: day, week: new Date(clock - 7 * 86400000), month: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)), nextMonth: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1)) };
}
function reviewPause(usage, settings = {}, quota = null, clock = Date.now(), provider = null) {
  const month = usage?.month || {};
  if (usage?.unavailable) return { code: 'usage-unavailable', title: 'Usage history needs another read', detail: 'Reviews wait until usage can be read so the monthly limits remain enforceable.', resetAt: null };
  const caps = settings.monthlyCaps || {};
  if ((caps.tokens !== null && caps.tokens !== undefined && (month.totalTokens || 0) >= caps.tokens)
    || (caps.apiUsd !== null && caps.apiUsd !== undefined && (month.estimatedCostUsd || 0) >= caps.apiUsd)) return { code: 'monthly-cap', title: 'Monthly AI limit reached', detail: 'New reviews are paused. Raise or clear the monthly limit in AI usage & limits to continue, or wait for the next calendar month (UTC).', resetAt: windows(clock).nextMonth.toISOString() };
  if (caps.apiUsd !== null && caps.apiUsd !== undefined && month.unpricedReviews) return { code: 'unpriced-usage', title: 'API cost estimate is incomplete', detail: 'The API spend limit cannot be enforced until missing usage or model pricing is resolved. Clear the spend limit to continue with a token limit instead.', resetAt: windows(clock).nextMonth.toISOString() };
  if (caps.tokens !== null && caps.tokens !== undefined && month.missingUsageReviews) return { code: 'missing-usage', title: 'Token count is incomplete', detail: 'The monthly token limit cannot be enforced because a review did not report its full usage. Clear the token limit to continue, or wait for the next month.', resetAt: windows(clock).nextMonth.toISOString() };
  if (quota && provider !== 'anthropic' && (!quota.resetAt || Date.parse(quota.resetAt) > clock)) return { code: 'plan-limit', title: 'ChatGPT plan limit reached', detail: quota.resetAt ? 'Codex reviews will resume after the plan resets.' : 'Codex did not supply a reset time. After your plan resets, choose Check plan again.', resetAt: quota.resetAt || null };
  return null;
}
// One terminal outcome per review attempt, shared by the usage row and the review's event so they agree.
const REVIEW_OUTCOMES = Object.freeze(['completed', 'incomplete', 'yielded', 'failed', 'cancelled', 'plan-limit', 'cap-reached']);
function reviewOutcome({ failure = null, result = null, aborted = false } = {}) {
  if (failure) {
    if (REVIEW_OUTCOMES.includes(failure.reviewOutcome)) return failure.reviewOutcome;
    if (failure.code === 'CODEX_SUBSCRIPTION_LIMIT') return 'plan-limit';
    if (failure.code === 'BUSINESS_REVIEW_PAUSED') return 'cap-reached';
    if (failure.code === 'BUSINESS_FRESHNESS_YIELD') return 'yielded';
    return aborted ? 'cancelled' : 'failed';
  }
  return result?.complete ? 'completed' : 'incomplete';
}
const STALE_MS = 240000;
const totals = { _id: null, reviews: { $sum: 1 }, inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' }, cacheReadTokens: { $sum: '$cacheReadTokens' }, cacheWriteTokens: { $sum: '$cacheWriteTokens' }, totalTokens: { $sum: '$totalTokens' }, estimatedCostUsd: { $sum: '$estimatedCostUsd' }, unpricedReviews: { $sum: { $cond: [{ $and: [{ $eq: ['$provider', 'anthropic'] }, { $eq: ['$estimatedCostUsd', null] }, { $or: [{ $ne: ['$outcome', 'running'] }, { $lt: ['$startedAt', { $subtract: ['$$NOW', STALE_MS] }] }] }] }, 1, 0] } }, missingUsageReviews: { $sum: { $cond: [{ $and: ['$usageMissing', { $or: [{ $ne: ['$outcome', 'running'] }, { $lt: ['$startedAt', { $subtract: ['$$NOW', STALE_MS] }] }] }] }, 1, 0] } } };
const legacyRow = { $and: [{ $eq: ['$provider', 'codex'] }, { $ne: [{ $ifNull: ['$cacheSplit', false] }, true] }] };
const legacySums = { legacyReviews: { $sum: { $cond: [legacyRow, 1, 0] } }, legacyInputTokens: { $sum: { $cond: [legacyRow, '$inputTokens', 0] } }, legacyOutputTokens: { $sum: { $cond: [legacyRow, '$outputTokens', 0] } } };
const legacyKeys = Object.keys(legacySums);
const emptyTotals = () => ({ reviews: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, estimatedCostUsd: 0, unpricedReviews: 0, missingUsageReviews: 0 });
// Safe per-review evidence for activity details. No prompts, response text or credentials.
function reviewMetadata(row, clock = Date.now()) {
  const date = value => { const ms = value ? new Date(value).getTime() : NaN; return Number.isFinite(ms) ? ms : null; };
  const start = date(row.startedAt), finish = date(row.finishedAt), running = finish === null && ['running', 'usage-unknown'].includes(row.outcome);
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const split = row.provider === 'anthropic' || row.cacheSplit === true;
  const input = count(row.inputTokens), output = count(row.outputTokens), cached = count(row.cacheReadTokens), writes = count(row.cacheWriteTokens), writes1h = Math.min(writes, count(row.cacheWrite1hTokens));
  const total = input + output + cached + writes;
  const missing = row.usageMissing === true || !validCount(row.inputTokens) || !validCount(row.outputTokens) || !validCount(row.totalTokens) || row.totalTokens !== total;
  const tokens = missing && total === 0 ? null : { inputTokens: input + cached + writes, uncachedInputTokens: split ? input : null, outputTokens: output, cachedInputTokens: split ? cached : null, cacheWriteTokens: writes, cacheWrite1hTokens: writes1h, totalTokens: total };
  const rate = rateFor(row.provider, row.model);
  let cost = null;
  if (rate && tokens) {
    const group = { ...row, reviews: 1, estimatedCostUsd: estimateCost(row.provider, row.model, { inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: writes, cacheWrite1hTokens: writes1h, usageMissing: false }), legacyReviews: split ? 0 : 1, legacyInputTokens: split ? 0 : input, legacyOutputTokens: split ? 0 : output };
    const equivalent = apiEquivalent(group);
    cost = { currency: 'USD', basis: row.provider === 'codex' ? 'api-equivalent' : 'api-estimate', lowUsd: equivalent.lowUsd, highUsd: equivalent.highUsd, partial: missing, cacheSplit: split,
      components: { inputUsd: split ? input * rate.input / 1e6 : null, outputUsd: output * rate.output / 1e6, cachedInputUsd: split ? cached * rate.cacheRead / 1e6 : null, cacheWrite5mUsd: (writes - writes1h) * (rate.cacheWrite5m || 0) / 1e6, cacheWrite1hUsd: writes1h * (rate.cacheWrite1h || 0) / 1e6 } };
  }
  return { attemptId: String(row._id), passId: typeof row.passId === 'string' ? row.passId.slice(0, 64) : null, provider: row.provider, model: String(row.model || '').slice(0, 128), billing: row.billing, outcome: row.outcome,
    startedAt: start === null ? null : new Date(start).toISOString(), finishedAt: finish === null ? null : new Date(finish).toISOString(), durationMs: start === null || (finish === null && !running) || (finish !== null && finish < start) ? null : Math.max(0, (finish ?? (running ? clock : start)) - start), running, usageMissing: missing, tokens, cost };
}

function createBusinessAgentUsage({ Usage = require('../models/BusinessAgentUsage'), now = () => Date.now() } = {}) {
  let ready;
  async function setup() {
    if (!ready) ready = (async () => { await Usage.createCollection(); await Usage.createIndexes(); })().catch(error => { ready = null; throw error; });
    await ready;
  }
  async function begin(scope, { provider, model, role, billing, attemptId, passId }) {
    await setup();
    const id = typeof attemptId === 'string' && /^[0-9a-f-]{36}$/.test(attemptId) ? attemptId : randomUUID();
    const record = { _id: id, passId: typeof passId === 'string' && passId.length <= 64 ? passId : null, environment: scope.environment, realmId: scope.realmId, connectionId: String(scope.connectionId), provider, model, role, billing: provider==='anthropic'?'estimated API cost':billing==='included in plan'?'included in plan':'billing unverified', startedAt: new Date(now()), outcome: 'running', ...normalizeUsage(provider, null), estimatedCostUsd: null };
    await Usage.create(record);
    return record;
  }
  async function save(record, data) {
    // Explicit allowlist: response text, prompts, errors and keys never enter storage.
    const fields = ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','cacheWrite1hTokens','totalTokens','usageMissing','cacheSplit','estimatedCostUsd','model','outcome','finishedAt','resetAt'];
    const changes = Object.fromEntries(fields.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
    const result = await Usage.updateOne({ _id: record._id, environment: record.environment, realmId: record.realmId, connectionId: record.connectionId }, { $set: changes });
    if (result.matchedCount !== 1) throw new Error('Usage evidence could not be retained.');
  }
  async function summary(scope) {
    const ranges = windows(now()), earliest = new Date(Math.min(+ranges.week, +ranges.month));
    const [result = {}] = await Usage.aggregate([{ $match: { environment: scope.environment, realmId: scope.realmId, connectionId: String(scope.connectionId), startedAt: { $gte: earliest } } }, { $facet: {
      ...Object.fromEntries(['today','week','month'].map(key => [key, [{ $match: { startedAt: { $gte: ranges[key] } } }, { $group: totals }]])),
      // Pricing is linear per model, so per-window provider+model token sums are priced in JS (covers historical rows).
      ...Object.fromEntries(['today','week','month'].map(key => [key + 'Pricing', [{ $match: { startedAt: { $gte: ranges[key] } } }, { $group: { ...totals, ...legacySums, _id: { provider: '$provider', model: '$model' } } }, { $limit: 200 }]])),
      models: [{ $match: { startedAt: { $gte: ranges.month } } }, { $group: { ...totals, ...legacySums, _id: { provider: '$provider', model: '$model', role: '$role', billing: '$billing' } } }, { $sort: { reviews: -1 } }, { $limit: 50 }],
      latest: [{ $sort: { startedAt: -1 } }, { $limit: 1 }, { $project: { _id: 0, provider: 1, model: 1, role: 1, startedAt: 1, finishedAt: 1, outcome: 1, resetAt: 1 } }],
    } }]).option({ maxTimeMS: 3000 });
    const quota = await Usage.findOne({ environment: scope.environment, realmId: scope.realmId, connectionId: String(scope.connectionId), outcome: 'plan-limit' }).sort({ startedAt: -1 }).select('resetAt finishedAt').maxTimeMS(3000).lean();
    const clean = value => { const { _id, ...rest } = value || emptyTotals(); for (const key of legacyKeys) delete rest[key]; return rest; };
    const windowTotals = key => ({ ...clean(result[key]?.[0]), apiEquivalent: combineEquivalent((result[key + 'Pricing'] || []).map(group => apiEquivalent({ ...group, ...group._id }))) });
    return { quota: quota ? { resetAt: quota.resetAt ? new Date(quota.resetAt).toISOString() : null, detectedAt: new Date(quota.finishedAt).toISOString() } : null, currency: 'USD', estimated: true, timezone: 'UTC', retentionDays: 180, ...Object.fromEntries(['today','week','month'].map(key => [key, windowTotals(key)])), models: (result.models || []).map(value => ({ ...clean(value), ...value._id, billing: value._id.billing || (value._id.provider === 'codex' ? 'billing unverified' : 'estimated API cost'), apiEquivalent: apiEquivalent({ ...value, ...value._id }) })), latest: result.latest?.[0] || null };
  }
  // Only references supplied by saved activity/transcript records are read, within the selected company.
  async function details(scope, { attemptIds = [], passIds = [] } = {}) {
    const ids = values => [...new Set(values.filter(value => typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value)))].slice(0, 120);
    const attempts = ids(attemptIds), passes = ids(passIds);
    if (!attempts.length && !passes.length) return [];
    const rows = await Usage.find({ environment: scope.environment, realmId: scope.realmId, connectionId: String(scope.connectionId), $or: [...(attempts.length ? [{ _id: { $in: attempts } }] : []), ...(passes.length ? [{ passId: { $in: passes } }] : [])] })
      .select('_id passId provider model billing role startedAt finishedAt outcome inputTokens outputTokens cacheReadTokens cacheWriteTokens cacheWrite1hTokens totalTokens cacheSplit usageMissing')
      .sort({ startedAt: -1 }).limit(240).maxTimeMS(2000).lean();
    return rows.map(row => reviewMetadata(row, now()));
  }
  return { begin, save, summary, details };
}
module.exports = { createBusinessAgentUsage, normalizeUsage, estimateCost, apiEquivalent, reviewMetadata, windows, reviewPause, reviewOutcome, REVIEW_OUTCOMES };
