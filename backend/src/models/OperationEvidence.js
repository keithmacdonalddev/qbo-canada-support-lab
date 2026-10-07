'use strict';
const mongoose = require('mongoose');
const immutable = type => ({ type, required: true, immutable: true });
const schema = new mongoose.Schema({
  contractVersion: { ...immutable(Number), enum: [1] },
  realmId: immutable(String), environment: { ...immutable(String), enum: ['sandbox', 'production'] },
  connectionId: immutable(mongoose.Schema.Types.ObjectId), operationId: immutable(mongoose.Schema.Types.ObjectId),
  planHash: immutable(String), evidenceRevision: { ...immutable(Number), min: 1 }, evidenceHash: immutable(String),
  proof: immutable(mongoose.Schema.Types.Mixed), sources: immutable(mongoose.Schema.Types.Mixed),
  actorId: immutable(mongoose.Schema.Types.ObjectId), auditId: immutable(String),
}, { timestamps: true, autoIndex: false, autoCreate: false });
schema.index({ environment: 1, realmId: 1, operationId: 1, evidenceRevision: 1 }, { unique: true });
schema.pre('save', function () { if (!this.isNew) throw new Error('Saved period evidence is append-only'); });
schema.pre('deleteOne', { document: true, query: false }, function () { throw new Error('Saved period evidence is append-only'); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) schema.pre(operation, function () { throw new Error('Saved period evidence is append-only'); });
module.exports = mongoose.model('OperationEvidence', schema);
