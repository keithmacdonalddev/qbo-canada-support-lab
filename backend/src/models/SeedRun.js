const mongoose = require('mongoose');

const seedRunSchema = new mongoose.Schema(
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
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'failed'],
      default: 'pending',
    },
    entitiesCreated: {
      customers: { type: Number, default: 0 },
      vendors: { type: Number, default: 0 },
      items: { type: Number, default: 0 },
      accounts: { type: Number, default: 0 },
    },
    entitiesSkipped: {
      customers: { type: Number, default: 0 },
      vendors: { type: Number, default: 0 },
      items: { type: Number, default: 0 },
      accounts: { type: Number, default: 0 },
    },
    seedErrors: [
      {
        entity: { type: String },
        name: { type: String },
        error: { type: String },
      },
    ],
    progress: {
      phase: { type: String },
      detail: { type: String },
      created: { type: Number },
      skipped: { type: Number },
    },
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

module.exports = mongoose.model('SeedRun', seedRunSchema);
