'use strict';
const mongoose = require('mongoose');
const { validateBaselineObservation } = require('../modules/business-baseline');
const immutable = type => ({ type, required: true, immutable: true });
const schema = new mongoose.Schema({
  contractVersion: { ...immutable(Number), enum: [1, 2] },
  environment: { ...immutable(String), enum: ['sandbox', 'production'] }, realmId: immutable(String), connectionId: immutable(mongoose.Schema.Types.ObjectId),
  actorId: immutable(mongoose.Schema.Types.ObjectId), ownerId: immutable(mongoose.Schema.Types.ObjectId),
  status: { ...immutable(String), enum: ['captured'] }, request: immutable(mongoose.Schema.Types.Mixed), requestHash: immutable(String),
  inventorySources: { type: mongoose.Schema.Types.Mixed, immutable: true, required: function () { return this.contractVersion === 2; } },
  payload: immutable(mongoose.Schema.Types.Mixed), sources: immutable(mongoose.Schema.Types.Mixed), evidenceHash: immutable(String), auditId: immutable(mongoose.Schema.Types.ObjectId),
}, { timestamps: { createdAt: true, updatedAt: false }, autoCreate: false, autoIndex: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, ownerId: 1, 'payload.observedAt': -1, _id: -1 });
schema.pre('validate', function () { validateBaselineObservation(this.toObject()); });
schema.pre('save', function () { if (!this.isNew) throw new Error('Baseline observations are append-only'); });
schema.pre('deleteOne', { document: true, query: false }, function () { throw new Error('Baseline observations are append-only'); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) schema.pre(operation, function () { throw new Error('Baseline observations are append-only'); });
module.exports = mongoose.model('BusinessBaseline', schema);
