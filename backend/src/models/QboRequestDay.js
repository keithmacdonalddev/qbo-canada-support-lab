'use strict';
const mongoose = require('mongoose');
// One row per company per UTC day: QuickBooks API transport attempts made by this app, by category.
// Counts only; no endpoints, queries, bodies or responses are stored.
const count = { type: Number, min: 0, default: 0 };
const categories = () => ({ sync: count, report: count, query: count, read: count, write: count });
const schema = new mongoose.Schema({
  _id: { type: String, required: true, maxlength: 64 },
  environment: { type: String, required: true, immutable: true, enum: ['production', 'sandbox'] },
  realmId: { type: String, required: true, immutable: true, maxlength: 40 },
  connectionId: { type: String, required: true, immutable: true, maxlength: 24 },
  day: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  attempts: categories(),
  succeeded: categories(),
  callers: { type: Map, of: new mongoose.Schema({ attempts: categories(), succeeded: categories() }, { _id: false }), default: {} },
  updatedAt: { type: Date, default: null },
}, { autoCreate: false, autoIndex: false, strict: 'throw', minimize: false });
schema.index({ environment: 1, realmId: 1, connectionId: 1, day: -1 });
schema.index({ updatedAt: 1 }, { expireAfterSeconds: 400 * 86400 });
module.exports = mongoose.model('QboRequestDay', schema);
