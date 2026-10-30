'use strict';

// Only native Codex error/turn.failed JSONL records are quota authority.
// Assistant text, stderr, and arbitrary stdout prose never enter this parser.
const MAX_EVENT_BYTES = 20000, MAX_FIELDS = 32, MAX_RESET_AHEAD_MS = 32 * 86400000;
const QUOTA_CODE = 'CODEX_SUBSCRIPTION_LIMIT';
function normalizeQuotaReset(value, now = Date.now()) {
  let at = NaN;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 100000000000) at = value * 1000;
  else if (typeof value === 'string' && /^[0-9]{1,11}$/.test(value)) at = Number(value) * 1000;
  else if (typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) at = Date.parse(value);
  return Number.isSafeInteger(at) && at > now && at <= now + MAX_RESET_AHEAD_MS ? new Date(at).toISOString() : null;
}
function boundedEvent(event) {
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event) || Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) return false;
    let fields = 0;
    const visit = (value, depth = 0) => {
      if (depth > 8 || !value || typeof value !== 'object' || Array.isArray(value)) return depth <= 8;
      for (const child of Object.values(value)) if (++fields > MAX_FIELDS || !visit(child, depth + 1)) return false;
      return true;
    };
    return visit(event);
  } catch { return false; }
}
function codexSubscriptionQuota(events, { now = Date.now() } = {}) {
  if (!Array.isArray(events)) return null;
  let recognized = false, resetAt = null;
  for (const event of events) {
    if (!['error', 'turn.failed'].includes(event?.type) || !boundedEvent(event)) continue;
    // Follow only provider error wrappers, never model/tool/item payload fields.
    const nodes = [event]; let next = event.error;
    for (let depth = 0; depth < 6 && next && typeof next === 'object' && !Array.isArray(next); depth++, next = next.error) nodes.push(next);
    const structured = nodes.some(node => node.code === 'usage_limit_reached');
    const human = nodes.some(node => typeof node.message === 'string'
      && /(?:you(?:'|’)?ve hit your usage limit|you have hit your usage limit|subscription usage limit (?:has been )?reached)/i.test(node.message.slice(0, MAX_EVENT_BYTES)));
    if (!structured && !human) continue;
    recognized = true;
    // Human wording can establish a pause but never establishes a reset time.
    if (structured) for (const node of nodes) for (const key of ['reset_at', 'resets_at']) {
      const candidate = normalizeQuotaReset(node[key], now);
      if (candidate && (!resetAt || candidate > resetAt)) resetAt = candidate;
    }
  }
  return recognized ? { code: QUOTA_CODE, resetAt } : null;
}
module.exports = { codexSubscriptionQuota, normalizeQuotaReset, QUOTA_CODE, MAX_EVENT_BYTES, MAX_FIELDS, MAX_RESET_AHEAD_MS };
