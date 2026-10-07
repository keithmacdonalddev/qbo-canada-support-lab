'use strict';
const mongoose = require('mongoose');
const fixed = type => ({ type, required: true, immutable: true });
const schema = new mongoose.Schema({
  contractVersion: { ...fixed(Number), enum: [1] },
  realmId: fixed(String), environment: { ...fixed(String), enum: ['sandbox', 'production'] },
  connectionId: fixed(mongoose.Schema.Types.ObjectId),
  planId: fixed(mongoose.Schema.Types.ObjectId), planHash: fixed(String), ordinal: { ...fixed(Number), min: 0, max: 999 },
  logicalKey: fixed(String), fingerprint: fixed(String), kind: { ...fixed(String), enum: ['create', 'existing'] },
  step: fixed(mongoose.Schema.Types.Mixed), policy: fixed(mongoose.Schema.Types.Mixed),
}, { timestamps: true, autoIndex: false, autoCreate: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, planId: 1, logicalKey: 1 }, { unique: true });
schema.index({ environment: 1, realmId: 1, connectionId: 1, planId: 1, ordinal: 1 }, { unique: true });
schema.pre('save', function () { if (!this.isNew) throw new Error('Saved operation intent is append-only'); });
schema.pre('deleteOne', { document: true, query: false }, function () { throw new Error('Saved operation intent is append-only'); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) schema.pre(operation, function () { throw new Error('Saved operation intent is append-only'); });
module.exports = mongoose.model('OperationIntent', schema);
