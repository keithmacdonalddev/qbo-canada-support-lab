'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  version: { type: Number, required: true, immutable: true, enum: [1] },
  environment: { type: String, required: true, immutable: true, enum: ['sandbox', 'production'] },
  realmId: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  entity: { type: String, required: true, immutable: true },
  qboId: { type: String, required: true, immutable: true },
  // Private app mirror only: raw company records never enter logs or public status.
  record: { type: mongoose.Schema.Types.Mixed, required: true },
  generation: { type: String, required: true },
  deleted: { type: Boolean, required: true, default: false },
  lastReadStartedAt: { type: Date, required: true },
  lastObservedAt: { type: Date, required: true },
  changedAt: { type: Date, default: null },
  summary: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true, autoCreate: false, autoIndex: false, minimize: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, entity: 1, qboId: 1 }, { unique: true });
schema.index({ environment: 1, realmId: 1, connectionId: 1, deleted: 1, changedAt: -1, _id: 1 });
schema.index({ environment: 1, realmId: 1, connectionId: 1, entity: 1, generation: 1 });
module.exports = mongoose.model('CompanySyncRecord', schema);
