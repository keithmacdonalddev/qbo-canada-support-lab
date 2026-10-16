'use strict';
const mongoose = require('mongoose');
const { hash } = require('../modules/business-calendar');
const fixed = type => ({ type, required: true, immutable: true });
const schema = new mongoose.Schema({
  contractVersion: { ...fixed(Number), enum: [1, 2] },
  environment: { ...fixed(String), enum: ['sandbox', 'production'] }, realmId: fixed(String), connectionId: fixed(mongoose.Schema.Types.ObjectId),
  contentHash: fixed(String), payload: fixed(mongoose.Schema.Types.Mixed), actorId: fixed(mongoose.Schema.Types.ObjectId), auditId: fixed(String),
}, { timestamps: { createdAt: true, updatedAt: false }, autoCreate: false, autoIndex: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, contentHash: 1 }, { unique: true });
schema.pre('validate', function () { if (hash(this.payload) !== this.contentHash) throw new Error('Retained authority content changed'); });
schema.pre('save', function () { if (!this.isNew) throw new Error('Business authority is append-only'); });
schema.pre('deleteOne', { document: true, query: false }, function () { throw new Error('Business authority is append-only'); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) schema.pre(operation, function () { throw new Error('Business authority is append-only'); });
module.exports = mongoose.model('BusinessAuthority', schema);
