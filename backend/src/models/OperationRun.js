'use strict';
const mongoose = require('mongoose');
const immutable = (type, required = true) => ({ type, required, immutable: true });
const schema = new mongoose.Schema({
  contractVersion: { ...immutable(Number), enum: [1], default: 1 },
  realmId: immutable(String), environment: { ...immutable(String), enum: ['sandbox', 'production'] },
  businessKey: immutable(String), connectionId: immutable(mongoose.Schema.Types.ObjectId),
  blueprintId: immutable(mongoose.Schema.Types.ObjectId), blueprintHash: immutable(String),
  planId: immutable(mongoose.Schema.Types.ObjectId), planHash: immutable(String),
  fromDate: immutable(String), throughDate: immutable(String),
  expectedCursor: { ...immutable(String, false), default: null },
  expectedRevision: { ...immutable(Number), min: 0 },
  baselineHash: immutable(String), expectedRecordSetHash: immutable(String),
  requiredAssertions: { ...immutable([mongoose.Schema.Types.Mixed]), validate: value => value.length > 0 && value.length <= 100 && new Set(value.map(check => check.key)).size === value.length },
  createdBy: immutable(mongoose.Schema.Types.ObjectId),
  status: { type: String, enum: ['previewed', 'approved', 'reserved', 'running', 'blocked', 'stopped', 'awaiting-evidence', 'committing', 'verified'], default: 'previewed' },
  // Steps, planned intents and record receipts belong in separately paginated stores.
  recordCount: { ...immutable(Number), min: 0, max: 10000 },
  approval: { type: mongoose.Schema.Types.Mixed, default: null },
  leaseToken: String, leaseExpiresAt: Date,
  executionRevision: { type: Number, default: 0, min: 0 },
  nextOrdinal: { type: Number, default: 0, min: 0, max: 10000 },
  lastExecutionAuditId: String,
  executionRequest: { type: mongoose.Schema.Types.Mixed, default: null },
  writerRevision: { type: Number, default: 0, min: 0 },
  evidenceRevision: { type: Number, default: 0, min: 0 },
  verificationCandidateHash: String,
  verification: { type: mongoose.Schema.Types.Mixed, default: null },
  lastError: String,
}, { timestamps: true, autoIndex: false, autoCreate: false });
schema.index({ environment: 1, realmId: 1, createdAt: -1 });
schema.index({ 'executionRequest.pending': 1, _id: 1 });
module.exports = mongoose.model('OperationRun', schema);
