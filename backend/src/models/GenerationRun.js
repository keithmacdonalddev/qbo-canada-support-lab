const mongoose = require('mongoose');

const generationRunSchema = new mongoose.Schema(
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
    config: {
      monthsBack: { type: Number, default: 6 },
      txnsPerMonth: { type: Number, default: 30 },
      arWeight: { type: Number, default: 0.6 },
      apWeight: { type: Number, default: 0.4 },
    },
    progress: {
      phase: { type: String },
      detail: { type: String },
      monthsCompleted: { type: Number, default: 0 },
      totalTxns: { type: Number, default: 0 },
    },
    txnsSummary: {
      invoices: { type: Number, default: 0 },
      payments: { type: Number, default: 0 },
      creditMemos: { type: Number, default: 0 },
      bills: { type: Number, default: 0 },
      billPayments: { type: Number, default: 0 },
      vendorCredits: { type: Number, default: 0 },
      journalEntries: { type: Number, default: 0 },
      deposits: { type: Number, default: 0 },
    },
    createdTransactions: [
      {
        entity: { type: String },
        qboId: { type: String },
        docNumber: { type: String },
        amount: { type: Number },
        txnDate: { type: String },
        linkedTo: { type: String },
        customerOrVendor: { type: String },
        chainIndex: { type: Number },
        timestamp: { type: Date, default: Date.now },
      },
    ],
    generationErrors: [
      {
        type: { type: String },
        detail: { type: String },
        txnDate: { type: String },
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

module.exports = mongoose.model('GenerationRun', generationRunSchema);
