'use strict';
const mongoose = require('mongoose');
// The accountant's review session as it happened: what was sent to the model, its reasoning and
// messages, each tool call and the result returned to it, usage and the outcome. Append-only,
// redacted before saving (business-agent-transcript.js), bounded per item and per attempt, and
// expired after seven days.
const schema = new mongoose.Schema({
  agentId: { type: String, required: true, immutable: true },
  attemptId: { type: String, required: true, immutable: true },
  passId: { type: String, default: null, immutable: true },
  role: { type: String, required: true, immutable: true },
  environment: { type: String, required: true, immutable: true },
  realmId: { type: String, required: true, immutable: true },
  seq: { type: Number, required: true, min: 1, immutable: true },
  at: { type: Date, required: true, immutable: true },
  kind: { type: String, required: true, enum: ['context', 'reasoning', 'message', 'tool-call', 'tool-result', 'usage', 'outcome'], immutable: true },
  provider: { type: String, default: null, immutable: true },
  name: { type: String, default: null, maxlength: 80, immutable: true },
  callId: { type: String, default: null, maxlength: 80, immutable: true },
  status: { type: String, default: null, maxlength: 20, immutable: true },
  text: { type: String, default: '', maxlength: 70000, immutable: true },
  json: { type: String, default: '', maxlength: 70000, immutable: true },
  truncated: { type: Boolean, default: false, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
}, { autoCreate: false, autoIndex: false, minimize: false, versionKey: false });
schema.index({ agentId: 1, attemptId: 1, seq: 1 }, { unique: true });
schema.index({ agentId: 1, kind: 1, at: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.pre('save', function () { if (!this.isNew) throw new Error('Business agent transcripts are append-only'); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) schema.pre(operation, function () { throw new Error('Business agent transcripts are append-only'); });
module.exports = mongoose.model('BusinessAgentTranscript', schema);
