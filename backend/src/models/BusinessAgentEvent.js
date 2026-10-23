'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, required: true, immutable: true },
  agentId: { type: String, required: true, immutable: true },
  environment: { type: String, required: true, immutable: true },
  realmId: { type: String, required: true, immutable: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  role: { type: String, required: true, immutable: true },
  kind: { type: String, required: true, immutable: true },
  title: { type: String, required: true, immutable: true, maxlength: 160 },
  detail: { type: String, default: '', immutable: true, maxlength: 6000 },
  data: { type: mongoose.Schema.Types.Mixed, immutable: true },
  at: { type: Date, required: true, immutable: true },
}, { autoCreate: false, autoIndex: false, minimize: false });
schema.index({ agentId: 1, at: -1, _id: -1 });
schema.index({ agentId: 1, kind: 1, 'data.decisionId': 1 });
schema.pre('save', function () { if (!this.isNew) throw new Error('Business agent events are append-only'); });
for (const operation of ['updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace','deleteOne','deleteMany','findOneAndDelete']) schema.pre(operation, function () { throw new Error('Business agent events are append-only'); });
module.exports = mongoose.model('BusinessAgentEvent', schema);
