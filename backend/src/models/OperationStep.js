'use strict';
const mongoose = require('mongoose');
const fixed = type => ({ type, required: true, immutable: true });
const schema = new mongoose.Schema({
  contractVersion: { ...fixed(Number), enum: [1] },
  realmId: fixed(String), environment: { ...fixed(String), enum: ['sandbox', 'production'] },
  connectionId: fixed(mongoose.Schema.Types.ObjectId), operationId: fixed(mongoose.Schema.Types.ObjectId),
  planHash: fixed(String), logicalKey: fixed(String), fingerprint: fixed(String), entity: fixed(String),
  dependencies: { ...fixed([mongoose.Schema.Types.Mixed]), validate: values => values.length <= 20 },
  state: { type: String, enum: ['claimed', 'dispatched', 'unknown', 'saved', 'verified', 'rejected'], required: true },
  revision: { type: Number, min: 1, required: true }, attempts: { type: Number, min: 1, max: 20, required: true },
  leaseToken: String, leaseExpiresAt: Date,
  dispatch: { type: mongoose.Schema.Types.Mixed, default: null },
  compilation: { type: mongoose.Schema.Types.Mixed, default: null },
  receipt: { type: mongoose.Schema.Types.Mixed, default: null },
  verification: { type: mongoose.Schema.Types.Mixed, default: null },
  rejection: { type: mongoose.Schema.Types.Mixed, default: null },
  qboId: String, lastAuditId: String,
}, { timestamps: true, autoIndex: false, autoCreate: false });
schema.index({ environment: 1, realmId: 1, logicalKey: 1 }, { unique: true });
schema.index({ environment: 1, realmId: 1, entity: 1, qboId: 1 }, { unique: true, partialFilterExpression: { qboId: { $type: 'string' } } });
schema.index({ environment: 1, realmId: 1, operationId: 1, state: 1, logicalKey: 1 });
schema.index({ environment: 1, realmId: 1, 'dependencies.logicalKey': 1, state: 1 });
module.exports = mongoose.model('OperationStep', schema);
