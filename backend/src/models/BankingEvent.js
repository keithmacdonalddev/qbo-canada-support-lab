'use strict';
const mongoose = require('mongoose');
// Append-only event revisions. Source changes do not change eventId.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  environment: { type: String, required: true, immutable: true, enum: ['sandbox', 'production'] },
  realmId: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  eventId: { type: String, required: true, immutable: true },
  kind: { type: String, enum: ['revision', 'reservation', 'account-fence'], default: 'revision', required: true, immutable: true },
  revision: { type: Number, required: true, immutable: true, min: 0, validate: { validator(value) { return Number.isSafeInteger(value) && (this.kind !== 'revision' ? value === 0 : value > 0); }, message: 'Only identity reservations use revision zero' } },
  fenceVersion: { type: Number, min: 0 },
  accountId: { type: String, required: true, immutable: true },
  accountCurrency: { type: String, required: true, immutable: true },
  sourceHash: { type: String, required: true, immutable: true },
  contentHash: { type: String, required: true, immutable: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: true, autoCreate: false, autoIndex: false, minimize: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, eventId: 1, revision: 1 }, { unique: true, name: 'banking_event_revision' });
module.exports = mongoose.models.BankingEvent || mongoose.model('BankingEvent', schema);
