'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true }, version: { type: Number, required: true },
  evidenceId: { type: String, required: true },
  environment: { type: String, enum: ['production', 'sandbox'], required: true },
  realmId: { type: String, required: true }, connectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  operationIds: [String], boundary: String, capturedAt: { type: Date, required: true },
  body: { type: Buffer, required: true }, bodyHash: String, rawBytes: Number,
}, { autoCreate: false, autoIndex: false, bufferCommands: false });
schema.index({ capturedAt: 1 }, { expireAfterSeconds: 2592000 });
schema.index({ environment: 1, realmId: 1, connectionId: 1, operationIds: 1, capturedAt: -1 });
module.exports = mongoose.model('BusinessReplayEvidence', schema);
