'use strict';
const mongoose = require('mongoose');
// Initialization is an explicit owner action. Importing this model never creates storage.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  version: { type: Number, required: true, immutable: true, enum: [1] },
  environment: { type: String, required: true, immutable: true },
  realmId: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  revision: { type: Number, default: 0, min: 0 },
  dispatchRevision: { type: Number, default: 0, min: 0 },
  settings: { type: mongoose.Schema.Types.Mixed, required: true },
  grant: { type: mongoose.Schema.Types.Mixed, default: null },
  status: { type: String, default: 'monitoring' },
  summary: { type: String, default: '' },
  memory: { type: String, default: '' },
  currentWork: { type: String, default: '' },
  activePass: { type: mongoose.Schema.Types.Mixed, default: null },
  // { passId, role, startedAt, steps: [{ at, label, status }] } for the latest review attempt; labels only.
  reviewProgress: { type: mongoose.Schema.Types.Mixed, default: null },
  specialists: { type: mongoose.Schema.Types.Mixed, default: {} },
  sync: { type: mongoose.Schema.Types.Mixed, default: null },
  syncView: { type: mongoose.Schema.Types.Mixed, default: null },
  nextSyncAt: { type: Date, default: null },
  nextDecisionAt: { type: Date, default: null },
  lastDecisionAt: { type: Date, default: null },
  nextWakeAt: { type: Date, default: null },
  leaseToken: { type: String, default: null },
  leaseExpiresAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  codexQuotaClearedAt: { type: Date, default: null },
  codexQuota: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true, autoCreate: false, autoIndex: false, minimize: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1 }, { unique: true });
schema.index({ 'settings.monitoring': 1, nextWakeAt: 1, _id: 1 });
module.exports = mongoose.model('BusinessAgent', schema);
