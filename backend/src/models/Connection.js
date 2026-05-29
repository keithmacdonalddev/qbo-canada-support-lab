const mongoose = require('mongoose');

const connectionSchema = new mongoose.Schema(
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
    companyName: {
      type: String,
    },
    accessToken: {
      type: String,
      required: true,
    },
    refreshToken: {
      type: String,
      required: true,
    },
    tokenExpiresAt: {
      type: Date,
    },
    refreshTokenExpiresAt: {
      type: Date,
    },
    scope: {
      type: String,
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'revoked', 'error'],
      default: 'active',
    },
    lastRefreshedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: one connection per user + realm pair
connectionSchema.index({ userId: 1, realmId: 1 }, { unique: true });

module.exports = mongoose.model('Connection', connectionSchema);
