const mongoose = require('mongoose');

const checkpointEntitySchema = new mongoose.Schema(
  {
    checkpointId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Checkpoint',
      required: true,
      index: true,
    },
    entityType: {
      type: String,
      required: true,
    },
    qboId: {
      type: String,
      required: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: false,
  }
);

checkpointEntitySchema.index({ checkpointId: 1, entityType: 1 });

module.exports = mongoose.model('CheckpointEntity', checkpointEntitySchema);
