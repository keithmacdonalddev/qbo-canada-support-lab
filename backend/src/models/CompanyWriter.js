'use strict';
const mongoose = require('mongoose');
// Explicit preparation only. Missing state must never be created by a writer claim.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  contractVersion: { type: Number, enum: [1], required: true, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  realmId: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  revision: { type: Number, min: 0, required: true },
  operationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  planHash: { type: String, default: null },
  // No expiration. An uncertain external request cannot release company ownership.
  unresolved: { type: mongoose.Schema.Types.Mixed, default: null },
  lastReleasedOperationId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true, autoIndex: false, autoCreate: false });
schema.index({ environment: 1, realmId: 1 }, { unique: true });
module.exports = mongoose.model('CompanyWriter', schema);
