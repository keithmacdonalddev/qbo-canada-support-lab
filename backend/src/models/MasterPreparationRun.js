'use strict';
const mongoose = require('mongoose');
const { assertMasterPlan } = require('../modules/business-master-preparation-plan');
const objectId = mongoose.Schema.Types.ObjectId, mixed = mongoose.Schema.Types.Mixed;
const attempt = new mongoose.Schema({
  number: { type: Number, required: true, min: 1, max: 10 },
  dispatchKey: { type: String, required: true }, requestHash: { type: String, required: true },
  payload: { type: mixed, required: true },
  leaseToken: { type: String, required: true },
  preflight: { type: mixed, required: true },
  retryApproval: { type: mixed, default: null },
  state: { type: String, enum: ['reserved', 'possibly-sent', 'saved', 'verified', 'rejected', 'unknown', 'proved-unsent'], required: true },
  receiptId: { type: String, default: null },
  qboId: { type: String, default: null }, syncToken: { type: String, default: null },
  outcome: { type: mixed, default: null }, readback: { type: mixed, default: null },
  ownerAttribution: { type: mixed, default: null },
  reservedAt: { type: Date, required: true }, observedAt: Date,
}, { _id: false });
const record = new mongoose.Schema({
  ordinal: { type: Number, required: true, min: 0, max: 99 },
  key: { type: String, required: true },
  entity: { type: String, enum: ['Account', 'Customer', 'Vendor', 'Employee', 'Item'], required: true },
  state: { type: String, enum: ['pending', 'reserved', 'possibly-sent', 'saved', 'verified', 'rejected', 'unknown', 'retired'], required: true },
  attempts: { type: [attempt], default: [], validate: value => value.length <= 10 },
  qboId: { type: String, default: null }, readback: { type: mixed, default: null },
}, { _id: false });
const schema = new mongoose.Schema({
  contractVersion: { type: Number, enum: [1], required: true, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  realmId: { type: String, required: true, immutable: true },
  connectionId: { type: objectId, required: true, immutable: true },
  ownerId: { type: objectId, required: true, immutable: true },
  sourceDraftId: { type: objectId, required: true, immutable: true },
  sourceDraftHash: { type: String, required: true, immutable: true },
  planHash: { type: String, required: true, immutable: true },
  plan: { type: mixed, required: true, immutable: true, validate: value => { try { assertMasterPlan(value); return true; } catch { return false; } } },
  // One unresolved role set across all actors, connections and draft versions.
  claim: { type: String, enum: ['open', 'closed'], required: true },
  state: { type: String, enum: ['proposed', 'approved', 'running', 'stopped', 'blocked', 'complete', 'closed'], required: true },
  revision: { type: Number, required: true, min: 0 },
  approval: { type: mixed, default: null },
  stopRequested: { type: Boolean, required: true, default: false },
  leaseToken: { type: String, default: null }, leaseExpiresAt: { type: Date, default: null },
  records: { type: [record], required: true, validate: value => value.length > 0 && value.length <= 100 },
  applied: { type: mixed, default: null }, disposition: { type: mixed, default: null },
  lastAuditId: { type: objectId, required: true },
}, { timestamps: true, autoCreate: false, autoIndex: false });
schema.index({ environment: 1, realmId: 1, claim: 1 }, { unique: true, partialFilterExpression: { claim: 'open' } });
schema.index({ environment: 1, realmId: 1, createdAt: -1 });
schema.index({ environment: 1, realmId: 1, 'records.entity': 1, 'records.qboId': 1 });
module.exports = mongoose.model('MasterPreparationRun', schema);
