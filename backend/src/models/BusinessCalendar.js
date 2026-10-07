'use strict';
const mongoose = require('mongoose');
// Not imported at startup. Index creation and initialization are explicit deployment work.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  contractVersion: { type: Number, default: 1, immutable: true, enum: [1] },
  realmId: { type: String, required: true, immutable: true },
  environment: { type: String, required: true, immutable: true, enum: ['sandbox', 'production'] },
  businessKey: { type: String, required: true, immutable: true },
  openingDate: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  blueprintId: { type: mongoose.Schema.Types.ObjectId, required: true },
  blueprintHash: { type: String, required: true },
  baseline: {
    status: { type: String, enum: ['unverified', 'verified', 'drifted'], default: 'unverified' },
    evidenceHash: String,
    observedAt: Date,
  },
  verifiedThrough: { type: String, default: null },
  revision: { type: Number, required: true, default: 0, min: 0 },
  currentOperationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  stopRequested: { type: Boolean, default: false },
  writerRevision: { type: Number, default: 0, min: 0 },
  // This receipt is authoritative until OperationRun and its audit have been repaired.
  // No subsequent operation may reserve this calendar while it is present.
  pendingCommit: { type: mongoose.Schema.Types.Mixed, default: null },
  lastVerifiedOperationId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true, autoIndex: false, autoCreate: false });
schema.index({ environment: 1, realmId: 1 }, { unique: true });
module.exports = mongoose.model('BusinessCalendar', schema);
