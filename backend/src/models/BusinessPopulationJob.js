'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  version: { type: Number, required: true, immutable: true, enum: [1] },
  environment: { type: String, required: true, immutable: true }, realmId: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true }, actorId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  authorityHash: { type: String, required: true, immutable: true }, blueprintHash: { type: String, required: true, immutable: true },
  originalOperationId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
  fromDate: { type: String, required: true, immutable: true }, throughDate: { type: String, required: true, immutable: true },
  manifest: { type: [mongoose.Schema.Types.Mixed], required: true, immutable: true }, manifestHash: { type: String, required: true, immutable: true },
  importedHash: { type: String, required: true, immutable: true }, importedCount: { type: Number, required: true, immutable: true },
  status: { type: String, enum: ['prepared','running','stopping','stopped','blocked','populated-with-gaps','populated','adopted'], default: 'prepared' },
  approval: { type: mongoose.Schema.Types.Mixed, default: null },
  revision: { type: Number, default: 0 }, stopRequested: { type: Boolean, default: false },
  leaseToken: { type: String, default: null }, leaseExpiresAt: { type: Date, default: null },
  batch: { type: mongoose.Schema.Types.Mixed, default: null },
  counts: { type: mongoose.Schema.Types.Mixed, default: null },
  createdThrough: { type: String, default: null }, lastError: { type: String, default: null },
  retryAfter: { type: Date, default: null },
  diagnostics: { type: mongoose.Schema.Types.Mixed, default: null },
  metrics: { type: mongoose.Schema.Types.Mixed, default: null },
  verification: { type: mongoose.Schema.Types.Mixed, default: null },
  relationshipPolicyVersion: { type: Number, default: 0, immutable: true },
  // Set when the history was adopted as the business starting point; the job is then closed.
  adoption: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true, autoCreate: false, autoIndex: false, minimize: false });
schema.index({ environment: 1, realmId: 1, createdAt: -1 });
module.exports = mongoose.model('BusinessPopulationJob', schema);
