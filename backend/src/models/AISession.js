const mongoose = require('mongoose');

const toolCallSchema = new mongoose.Schema({
  toolName: { type: String, required: true },
  toolUseId: { type: String },
  input: { type: mongoose.Schema.Types.Mixed },
  result: { type: mongoose.Schema.Types.Mixed },
}, { _id: false });

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system', 'tool_result'], required: true },
  content: { type: String },
  toolCalls: [toolCallSchema],
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const aiSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  realmId: { type: String, required: true },
  title: { type: String, default: 'New AI Session' },
  status: { type: String, enum: ['active', 'completed', 'archived'], default: 'active' },
  mode: { type: String, enum: ['suggest', 'investigate', 'generate_note'], default: 'suggest' },
  messages: [messageSchema],
  plans: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AIPlan' }],
  tokenUsage: {
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
  },
  model: { type: String },
}, { timestamps: true });

aiSessionSchema.index({ userId: 1, createdAt: -1 });
aiSessionSchema.index({ userId: 1, realmId: 1, status: 1 });

module.exports = mongoose.model('AISession', aiSessionSchema);
