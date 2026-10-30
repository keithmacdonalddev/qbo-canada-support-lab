'use strict';
// Standard pay-per-use API prices in USD per million tokens. Taxes, negotiated
// discounts, fast mode, batch and other billing adjustments are excluded.
// Anthropic: standard global Claude API rates, checked 2026-10-29.
//   Source: https://platform.claude.com/docs/en/about-claude/pricing
// Codex (OpenAI API equivalents): base (short-context) input, cached-input and
// output rates, copied from the Alfred app's price tables
// (C:\Projects\alfred server/src/lib/pricing.js and cost-estimator.js), which
// recorded them from the OpenAI pricing page on 2026-09-24. Codex reports usage
// per turn, not per model request, so the long-context tier cannot be assessed.
module.exports = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({ provider: 'anthropic', input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 }),
  'claude-opus-5-5': Object.freeze({ provider: 'anthropic', input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 }),
  'gpt-6.1-sol': Object.freeze({ provider: 'codex', input: 2, output: 10, cacheRead: 0.1 }),
  'gpt-6-sol': Object.freeze({ provider: 'codex', input: 2, output: 10, cacheRead: 0.2 }),
  'gpt-6-luna': Object.freeze({ provider: 'codex', input: 0.1, output: 0.5, cacheRead: 0.01 }),
  'gpt-6-astra': Object.freeze({ provider: 'codex', input: 10, output: 50, cacheRead: 1 }),
});
