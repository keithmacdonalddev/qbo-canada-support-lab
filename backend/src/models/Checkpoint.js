const mongoose = require('mongoose');

const checkpointSchema = new mongoose.Schema(
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
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    entityCounts: {
      customers: { type: Number, default: 0 },
      invoices: { type: Number, default: 0 },
      payments: { type: Number, default: 0 },
      creditMemos: { type: Number, default: 0 },
      bills: { type: Number, default: 0 },
      billPayments: { type: Number, default: 0 },
      vendorCredits: { type: Number, default: 0 },
      items: { type: Number, default: 0 },
      accounts: { type: Number, default: 0 },
      journalEntries: { type: Number, default: 0 },
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('Checkpoint', checkpointSchema);
