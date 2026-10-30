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
const STALE_MS = 240000;
const totals = { _id: null, reviews: { $sum: 1 }, inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' }, cacheReadTokens: { $sum: '$cacheReadTokens' }, cacheWriteTokens: { $sum: '$cacheWriteTokens' }, totalTokens: { $sum: '$totalTokens' }, estimatedCostUsd: { $sum: '$estimatedCostUsd' }, unpricedReviews: { $sum: { $cond: [{ $and: [{ $eq: ['$provider', 'anthropic'] }, { $eq: ['$estimatedCostUsd', null] }, { $or: [{ $ne: ['$outcome', 'running'] }, { $lt: ['$startedAt', { $subtract: ['$$NOW', STALE_MS] }] }] }] }, 1, 0] } }, missingUsageReviews: { $sum: { $cond: [{ $and: ['$usageMissing', { $or: [{ $ne: ['$outcome', 'running'] }, { $lt: ['$startedAt', { $subtract: ['$$NOW', STALE_MS] }] }] }] }, 1, 0] } } };
const legacyRow = { $and: [{ $eq: ['$provider', 'codex'] }, { $ne: [{ $ifNull: ['$cacheSplit', false] }, true] }] };
const legacySums = { legacyReviews: { $sum: { $cond: [legacyRow, 1, 0] } }, legacyInputTokens: { $sum: { $cond: [legacyRow, '$inputTokens', 0] } }, legacyOutputTokens: { $sum: { $cond: [legacyRow, '$outputTokens', 0] } } };
const legacyKeys = Object.keys(legacySums);
const emptyTotals = () => ({ reviews: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, estimatedCostUsd: 0, unpricedReviews: 0, missingUsageReviews: 0 });
function createBusinessAgentUsage({ Usage = require('../models/BusinessAgentUsage'), now = () => Date.now() } = {}) {
  let ready;
  async function setup() {
    if (!ready) ready = (async () => { await Usage.createCollection(); await Usage.createIndexes(); })().catch(error => { ready = null; throw error; });
    await ready;
  }
  async function begin(scope, { provider, model, role, billing }) {
    await setup();
    const record = { _id: randomUUID(), environment: scope.environment, realmId: scope.realmId, connectionId: String(scope.connectionId), provider, model, role, billing: provider==='anthropic'?'estimated API cost':billing==='included in plan'?'included in plan':'billing unverified', startedAt: new Date(now()), outcome: 'running', ...normalizeUsage(provider, null), estimatedCostUsd: null };
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
  return { begin, save, summary };
}
module.exports = { createBusinessAgentUsage, normalizeUsage, estimateCost, apiEquivalent, windows, reviewPause };
