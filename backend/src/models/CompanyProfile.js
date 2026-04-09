const mongoose = require('mongoose');

const companyProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    connectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Connection',
      required: true,
    },
    realmId: {
      type: String,
      required: true,
    },
    companyName: {
      type: String,
    },
    subscriptionTier: {
      type: String,
    },
    enabledFeatures: {
      type: [String],
      default: [],
    },
    knownLimitations: {
      type: [String],
      default: [],
    },
    seedingStatus: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'failed'],
      default: 'pending',
    },
    lastSeedDate: {
      type: Date,
    },
    lastActivityAt: {
      type: Date,
    },
    freshnessScore: {
      type: Number,
    },
    activeIssuePacks: {
      type: [String],
      default: [],
    },
    checkpointCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('CompanyProfile', companyProfileSchema);
