'use strict';
const mongoose = require('mongoose');
const fixed = type => ({ type, required: true, immutable: true });
const schema = new mongoose.Schema({
  contractVersion: { ...fixed(Number), enum: [1] },
  realmId: fixed(String), environment: { ...fixed(String), enum: ['sandbox', 'production'] },
  connectionId: fixed(mongoose.Schema.Types.ObjectId),
  operationId: fixed(mongoose.Schema.Types.ObjectId), createdBy: fixed(mongoose.Schema.Types.ObjectId),
  requestKey: fixed(String), candidateHash: fixed(String), planHash: fixed(String),
  manifest: fixed(mongoose.Schema.Types.Mixed), auditId: fixed(String),
}, { timestamps: true, autoIndex: false, autoCreate: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, operationId: 1 }, { unique: true });
schema.pre('save', function () { if (!this.isNew) throw new Error('Saved operation intent is append-only'); });
schema.pre('deleteOne', { document: true, query: false }, function () { throw new Error('Saved operation intent is append-only'); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) schema.pre(operation, function () { throw new Error('Saved operation intent is append-only'); });
module.exports = mongoose.model('OperationPlan', schema);
