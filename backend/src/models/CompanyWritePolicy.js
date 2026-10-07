'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  contractVersion: { type: Number, enum: [1], required: true, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  realmId: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  state: { type: String, enum: ['preparing', 'active'], required: true },
  revision: { type: Number, min: 0, required: true },
  // Separate from CompanyWriter, so a missing writer never restores legacy bypass.
  preparationEvidenceHash: String,
}, { timestamps: true, autoIndex: false, autoCreate: false });
schema.index({ environment: 1, realmId: 1 }, { unique: true });
module.exports = mongoose.model('CompanyWritePolicy', schema);
