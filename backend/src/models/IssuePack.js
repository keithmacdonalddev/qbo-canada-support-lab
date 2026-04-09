const mongoose = require('mongoose');

const issuePackSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      enum: ['ar', 'ap', 'tax', 'data_hygiene'],
      required: true,
    },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high'],
      required: true,
    },
    prerequisites: [
      {
        entity: { type: String },
        condition: { type: String },
      },
    ],
    mutations: [
      {
        step: { type: Number },
        entity: { type: String },
        action: { type: String },
        params: { type: mongoose.Schema.Types.Mixed },
      },
    ],
    expectedSymptoms: {
      type: [String],
      default: [],
    },
    investigationHints: {
      type: [String],
      default: [],
    },
    builtIn: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('IssuePack', issuePackSchema);
