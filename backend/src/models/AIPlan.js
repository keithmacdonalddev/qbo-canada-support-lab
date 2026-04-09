const mongoose = require('mongoose');

const planStepSchema = new mongoose.Schema({
  stepNumber: { type: Number, required: true },
  description: { type: String, required: true },
  toolName: { type: String, required: true },
  toolInput: { type: mongoose.Schema.Types.Mixed },
  requiresConfirmation: { type: Boolean, default: true },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'executing', 'completed', 'failed', 'skipped'],
    default: 'pending',
  },
  result: { type: mongoose.Schema.Types.Mixed },
  error: { type: String },
  executedAt: { type: Date },
}, { _id: true });

const aiPlanSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AISession', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  realmId: { type: String, required: true },
  status: {
    type: String,
    enum: ['proposed', 'approved', 'partially_approved', 'rejected', 'executing', 'completed', 'failed'],
    default: 'proposed',
  },
  description: { type: String, required: true },
  steps: [planStepSchema],
  approvedAt: { type: Date },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  completedAt: { type: Date },
}, { timestamps: true });

aiPlanSchema.index({ sessionId: 1 });
aiPlanSchema.index({ userId: 1, realmId: 1, createdAt: -1 });

module.exports = mongoose.model('AIPlan', aiPlanSchema);
