'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true }, version: { type: Number, required: true, immutable: true, enum: [1] },
  environment: { type: String, required: true, immutable: true }, realmId: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  authorityHash: { type: String, required: true, immutable: true },
  logicalKey: { type: String, required: true, immutable: true }, entity: { type: String, required: true, immutable: true }, txnDate: { type: String, required: true, immutable: true },
  step: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true }, fingerprint: { type: String, required: true, immutable: true },
  policy: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true }, intentHash: { type: String, required: true, immutable: true },
  origin: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
  state: { type: String, enum: ['pending','dispatched','saved','rejected','unknown'], default: 'pending' },
  qboId: { type: String }, receipt: { type: mongoose.Schema.Types.Mixed, default: null },
  compilation: { type: mongoose.Schema.Types.Mixed, default: null },
  financialProof: { type: mongoose.Schema.Types.Mixed, default: null }, coverageGaps: { type: [String], default: [] },
  relationshipCheck: { type: mongoose.Schema.Types.Mixed, default: null },
  relationshipProof: { type: mongoose.Schema.Types.Mixed, default: null },
  issueDecisions: { type: mongoose.Schema.Types.Mixed, default: null },
  retryHistory: { type: [mongoose.Schema.Types.Mixed], default: [], validate: values => values.length <= 2 },
  dispatch: { type: mongoose.Schema.Types.Mixed, default: null }, lastError: { type: String, default: null }, revision: { type: Number, default: 0 },
}, { timestamps: true, autoCreate: false, autoIndex: false, minimize: false });
schema.index({ environment: 1, realmId: 1, logicalKey: 1 }, { unique: true });
schema.index({ environment: 1, realmId: 1, entity: 1, qboId: 1 }, { unique: true, partialFilterExpression: { qboId: { $type: 'string' } } });
schema.index({ environment: 1, realmId: 1, authorityHash: 1, txnDate: 1 });
module.exports = mongoose.model('BusinessPopulationRecord', schema);
