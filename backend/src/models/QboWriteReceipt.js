'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  contractVersion: { type: Number, enum: [1], required: true, immutable: true },
  realmId: { type: String, required: true, immutable: true }, environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true }, actorId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  kind: { type: String, enum: ['business', 'legacy', 'master-preparation', 'business-link-repair', 'business-population', 'population-link-repair'], required: true, immutable: true },
  operationId: { type: mongoose.Schema.Types.ObjectId, immutable: true }, logicalKey: { type: String, immutable: true },
  dispatchKey: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true },
  entity: { type: String, required: true, immutable: true }, operation: { type: String, required: true, immutable: true },
  state: { type: String, enum: ['possibly-sent', 'saved', 'rejected', 'unknown'], required: true },
  workflow: { type: mongoose.Schema.Types.Mixed, immutable: true },
  population: { type: mongoose.Schema.Types.Mixed, immutable: true },
  periodProof: { type: mongoose.Schema.Types.Mixed, immutable: true },
  reconciliation: { type: mongoose.Schema.Types.Mixed, default: null },
  terminal: { type: mongoose.Schema.Types.Mixed, default: null },
  ownerRecovery: { type: mongoose.Schema.Types.Mixed, default: null },
  // Private full successful create/update envelope, never copied into audits or API results.
  savedResponse: { type: mongoose.Schema.Types.Mixed, default: null, select: false },
  observed: { type: mongoose.Schema.Types.Mixed, default: null },
  sentAt: { type: Date, required: true, immutable: true }, observedAt: Date,
  startAuditId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true }, resultAuditId: mongoose.Schema.Types.ObjectId,
}, { timestamps: false, autoIndex: false, autoCreate: false, minimize: false });
schema.index({ environment: 1, realmId: 1, dispatchKey: 1 }, { unique: true });
schema.index({ environment: 1, realmId: 1, state: 1, sentAt: -1 });
module.exports = mongoose.model('QboWriteReceipt', schema);
