'use strict';
const mongoose = require('mongoose');
// The generated snapshot never changes. Evidence advances with compare-and-swap.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  environment: { type: String, required: true, immutable: true, enum: ['sandbox', 'production'] },
  realmId: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  accountId: { type: String, required: true, immutable: true },
  accountCurrency: { type: String, required: true, immutable: true },
  period: { type: String, required: true, immutable: true },
  revision: { type: Number, required: true, immutable: true, min: 1 },
  previousPackageId: { type: String, default: null, immutable: true },
  contentHash: { type: String, required: true, immutable: true },
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  stateVersion: { type: Number, required: true, default: 0 },
  state: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true, autoCreate: false, autoIndex: false, minimize: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, accountId: 1, period: 1, revision: 1 }, { unique: true, name: 'banking_package_revision' });
module.exports = mongoose.models.BankingPackage || mongoose.model('BankingPackage', schema);
