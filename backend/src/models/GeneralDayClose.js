'use strict';
// Day-close verification of general governed writes (general-write-v1) for one period:
// the General Ledger evidence hash, the outcome and its plain failures, and the dirty
// history markers it re-verified. The business calendar does not advance past a period
// with general writes until a passing row exists for it (general-write-close-gate.js).
const mongoose = require('mongoose');
const fixed = (type, required = true) => ({ type, required, immutable: true });
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  contract: { ...fixed(String), enum: ['general-write-v1'] },
  environment: { ...fixed(String), enum: ['sandbox', 'production'] }, realmId: fixed(String), connectionId: fixed(mongoose.Schema.Types.ObjectId),
  fromDate: fixed(String), throughDate: fixed(String), kind: { ...fixed(String), enum: ['period', 'reverify'] },
  ok: fixed(Boolean), ledgerHash: fixed(String), recordCount: fixed(Number),
  failures: { type: [mongoose.Schema.Types.Mixed], immutable: true, default: [] },
  records: { type: [mongoose.Schema.Types.Mixed], immutable: true, default: [] },
  // Dirty markers ('runId:date') this verification covered.
  markers: { type: [String], immutable: true, default: [] },
  verifiedAt: fixed(Date),
}, { timestamps: true });
schema.index({ environment: 1, realmId: 1, connectionId: 1, fromDate: 1, throughDate: 1, kind: 1, verifiedAt: -1 });
module.exports = mongoose.model('GeneralDayClose', schema);
