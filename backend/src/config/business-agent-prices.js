'use strict';
// Estimated standard global Claude API USD per million tokens, checked 2026-10-29.
// Source: https://platform.claude.com/docs/en/about-claude/pricing
// Taxes, negotiated discounts, fast mode and other billing adjustments are excluded.
module.exports = Object.freeze({
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
});
