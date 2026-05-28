const express = require('express');
const Connection = require('../models/Connection');
const Checkpoint = require('../models/Checkpoint');
const CheckpointEntity = require('../models/CheckpointEntity');
const { authenticate } = require('../middleware/auth');
const { createAuditEntry } = require('../middleware/auditLogger');
const { createQBOClient } = require('../modules/qbo-client');
const { respondQboError } = require('../modules/qbo-error');
const { createCheckpoint, diffCheckpoints } = require('../modules/checkpoint');

const router = express.Router();

async function getActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
}

/**
 * POST /
 * Create a named checkpoint (snapshot all entities from QBO).
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Checkpoint name is required' });
    }

    const qbo = await createQBOClient(connection);
    const checkpoint = await createCheckpoint(qbo, {
      userId: req.user.id,
      realmId: connection.realmId,
      name,
      description,
    });

    await createAuditEntry(req.user.id, connection.realmId, 'Checkpoint created', {
      actionType: 'checkpoint',
      outcome: 'success',
      afterState: { checkpointId: checkpoint._id, name, entityCounts: checkpoint.entityCounts },
    });

    // Return without the full entity data (too large)
    return res.json({
      checkpoint: {
        _id: checkpoint._id,
        name: checkpoint.name,
        description: checkpoint.description,
        entityCounts: checkpoint.entityCounts,
        createdAt: checkpoint.createdAt,
      },
    });
  } catch (err) {
    console.error('[checkpoint/create]', err.message);
    if (respondQboError(res, err)) return;
    return res.status(500).json({ error: 'Failed to create checkpoint' });
  }
});

/**
 * GET /
 * List all checkpoints for this user/realm.
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const checkpoints = await Checkpoint.find(
      { userId: req.user.id, realmId: connection.realmId }
    ).sort({ createdAt: -1 });

    return res.json({ checkpoints });
  } catch (err) {
    console.error('[checkpoint/list]', err.message);
    return res.status(500).json({ error: 'Failed to list checkpoints' });
  }
});

/**
 * GET /:id
 * Get checkpoint detail (metadata + entity counts, no full data).
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const checkpoint = await Checkpoint.findOne(
      { _id: req.params.id, userId: req.user.id }
    );

    if (!checkpoint) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }

    return res.json({ checkpoint });
  } catch (err) {
    console.error('[checkpoint/get]', err.message);
    return res.status(500).json({ error: 'Failed to fetch checkpoint' });
  }
});

/**
 * GET /:id/diff/:compareId
 * Compute diff between two checkpoints.
 */
router.get('/:id/diff/:compareId', authenticate, async (req, res) => {
  try {
    const [cpA, cpB] = await Promise.all([
      Checkpoint.findOne({ _id: req.params.id, userId: req.user.id }),
      Checkpoint.findOne({ _id: req.params.compareId, userId: req.user.id }),
    ]);

    if (!cpA || !cpB) {
      return res.status(404).json({ error: 'One or both checkpoints not found' });
    }

    const diff = await diffCheckpoints(cpA, cpB);

    return res.json({
      diff,
      checkpointA: { _id: cpA._id, name: cpA.name, createdAt: cpA.createdAt },
      checkpointB: { _id: cpB._id, name: cpB.name, createdAt: cpB.createdAt },
    });
  } catch (err) {
    console.error('[checkpoint/diff]', err.message);
    return res.status(500).json({ error: 'Failed to compute diff' });
  }
});

/**
 * DELETE /:id
 * Delete a checkpoint.
 */
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const checkpoint = await Checkpoint.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id,
    });

    if (!checkpoint) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }

    // Clean up entity data in separate collection
    await CheckpointEntity.deleteMany({ checkpointId: checkpoint._id });

    return res.json({ message: 'Checkpoint deleted' });
  } catch (err) {
    console.error('[checkpoint/delete]', err.message);
    return res.status(500).json({ error: 'Failed to delete checkpoint' });
  }
});

module.exports = router;
