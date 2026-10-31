'use strict';
const mongoose = require('mongoose');
const immutable = type => ({ type, required: true, immutable: true });
// Explicit preparation only. Importing this model never creates a collection/index.
const schema = new mongoose.Schema({
  _id: immutable(String), contractVersion: { ...immutable(Number), enum: [1] },
  environment: { ...immutable(String), enum: ['sandbox', 'production'] }, realmId: immutable(String),
  connectionId: immutable(mongoose.Schema.Types.ObjectId), ownerId: immutable(mongoose.Schema.Types.ObjectId),
  period: immutable(String), accountId: immutable(String), checkKey: immutable(String),
  revision: { ...immutable(Number), min: 1 }, requestHash: immutable(String), contentHash: immutable(String),
  payload: immutable(mongoose.Schema.Types.Mixed), auditId: immutable(String),
}, { autoIndex: false, autoCreate: false, minimize: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, ownerId: 1, period: 1, accountId: 1, checkKey: 1, revision: 1 }, { unique: true });
schema.pre('save', function () { if (!this.isNew) throw new Error('Close checklist evidence is append-only'); });
schema.pre('deleteOne', { document: true, query: false }, function () { throw new Error('Close checklist evidence is append-only'); });
for (const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace','deleteOne','deleteMany','findOneAndDelete']) schema.pre(op, function () { throw new Error('Close checklist evidence is append-only'); });
module.exports = mongoose.model('BusinessCloseChecklistEvidence', schema);
