'use strict';
// One general governed write (manageQboRecord), contract general-write-v1
// (docs/plans/general-governed-write-tool-2026-10-31.md). The plan, every batch's exact
// transport identity (requestid, bIds) and every item outcome are saved here BEFORE and
// AFTER each send, so a lost response replays the same identity and nothing is resent
// under a new one.
const mongoose = require('mongoose');
const fixed = (type, required = true) => ({ type, required, immutable: true });
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  contract: { ...fixed(String), enum: ['general-write-v1'] },
  environment: { ...fixed(String), enum: ['sandbox', 'production'] }, realmId: fixed(String), connectionId: fixed(mongoose.Schema.Types.ObjectId),
  ownerId: fixed(mongoose.Schema.Types.ObjectId), actorId: fixed(mongoose.Schema.Types.ObjectId),
  agentAuthority: { type: mongoose.Schema.Types.Mixed, immutable: true, default: null },
  decisionKey: fixed(String), contentHash: fixed(String), purpose: fixed(String), day: fixed(String),
  // The guard result at preparation: normalized operations, batches, dirty dates.
  plan: fixed(mongoose.Schema.Types.Mixed),
  status: { type: String, required: true, enum: ['prepared', 'sending', 'needs-correction', 'unknown', 'complete', 'held'] },
  // [{ index, attempt, requestId, items: [{ bId, ref }], state: 'sending'|'answered'|'lost', sentAt, answeredAt }]
  batches: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // ref -> { outcome, qboId?, entity, record?, request (exact resolved payload), fault?, next?, attempt }
  items: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Records this run created or changed: [{ key: 'Entity:id', ref, op }] (ownership).
  owned: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Durable dirty-period markers written before a history-changing send.
  dirty: { type: [mongoose.Schema.Types.Mixed], default: [] },
  revision: { type: Number, required: true, default: 0 },
  lastError: { type: String, default: null },
}, { timestamps: true, autoCreate: false, autoIndex: false, minimize: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, decisionKey: 1 }, { unique: true });
schema.index({ environment: 1, realmId: 1, connectionId: 1, status: 1, updatedAt: -1 });
schema.index({ environment: 1, realmId: 1, 'owned.key': 1 });
module.exports = mongoose.model('GeneralWriteRun', schema);
