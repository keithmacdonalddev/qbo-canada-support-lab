const mongoose = require('mongoose');

// The built-in unique _id index reserves one current run per environment/company.
// Reservation survives a lost HTTP reply or failure before GenerationRun is created.
const schema = new mongoose.Schema({
  _id: String,
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  runId: { type: mongoose.Schema.Types.ObjectId, required: true },
  previousRunId: mongoose.Schema.Types.ObjectId,
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  realmId: { type: String, required: true },
  environment: { type: String, required: true },
  config: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

module.exports = mongoose.model('GenerationScope', schema);
