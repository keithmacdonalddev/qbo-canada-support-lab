const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    realmId: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      required: true,
    },
    actionType: {
      type: String,
      enum: ['seed', 'generate', 'inject', 'manual', 'ai_executed', 'connection', 'auth'],
    },
    tool: {
      type: String,
    },
    inputParams: {
      type: mongoose.Schema.Types.Mixed,
    },
    outcome: {
      type: String,
      enum: ['success', 'failure', 'partial'],
      default: 'success',
    },
    beforeState: {
      type: mongoose.Schema.Types.Mixed,
    },
    afterState: {
      type: mongoose.Schema.Types.Mixed,
    },
    aiDriven: {
      type: Boolean,
      default: false,
    },
    approvalEvent: {
      type: String,
    },
    error: {
      type: String,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    // Append-only: no updatedAt
    timestamps: false,
  }
);

// Efficient querying index for user + realm + time-range lookups
auditLogSchema.index({ userId: 1, realmId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
