const mongoose = require('mongoose');

const issuePackRunSchema = new mongoose.Schema(
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
    issuePackId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IssuePack',
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'failed'],
      default: 'pending',
    },
    createdEntities: [
      {
        entity: { type: String },
        qboId: { type: String },
        step: { type: Number },
      },
    ],
    executionLog: [
      {
        step: { type: Number },
        action: { type: String },
        outcome: { type: String },
        detail: { type: String },
        timestamp: { type: Date, default: Date.now },
      },
    ],
    startedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('IssuePackRun', issuePackRunSchema);
