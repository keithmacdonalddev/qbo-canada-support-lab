'use strict';
const mongoose = require('mongoose');
const count = { type: Number, min: 0, default: 0 };
const schema = new mongoose.Schema({
  _id: { type: String, required: true, maxlength: 64 },
  environment: { type: String, required: true, immutable: true, enum: ['production', 'sandbox'] },
  realmId: { type: String, required: true, immutable: true, maxlength: 40 },
  connectionId: { type: String, required: true, immutable: true, maxlength: 24 },
  provider: { type: String, required: true, enum: ['anthropic', 'codex'] },
  model: { type: String, required: true, maxlength: 128 },
  billing: { type: String, enum: ['included in plan', 'billing unverified', 'estimated API cost'], required: true },
  role: { type: String, required: true, enum: ['accountant', 'receivables', 'payables', 'inventory'] },
  inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count,
  cacheWrite1hTokens: count, totalTokens: count,
  usageMissing: { type: Boolean, default: false },
  // true: inputTokens is fresh input and cacheReadTokens the cached part (exact API-equivalent pricing).
  // Codex rows recorded before 2026-10-30 lack it; their inputTokens include cached input.
  cacheSplit: { type: Boolean, default: false },
  estimatedCostUsd: { type: Number, min: 0, default: null },
  startedAt: { type: Date, required: true, immutable: true },
  finishedAt: { type: Date, default: null },
  outcome: { type: String, required: true, enum: ['running', 'usage-unknown', 'completed', 'incomplete', 'failed', 'cancelled', 'plan-limit', 'cap-reached'] },
  resetAt: { type: Date, default: null },
}, { autoCreate: false, autoIndex: false, strict: 'throw' });
schema.index({ environment: 1, realmId: 1, connectionId: 1, startedAt: -1 });
schema.index({ startedAt: 1 }, { expireAfterSeconds: 180 * 86400 });
module.exports = mongoose.model('BusinessAgentUsage', schema);
