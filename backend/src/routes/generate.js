const express = require('express');
const Connection = require('../models/Connection');
const GenerationRun = require('../models/GenerationRun');
const { authenticate } = require('../middleware/auth');
const { requireProductionConfirm } = require('../middleware/productionGuard');
const { createGenerationService } = require('../modules/generation-service');
const { generationView } = require('../modules/generation-state');
const service = createGenerationService();

const router = express.Router();

/**
 * Helper — find the user's active Connection.
 */
async function getActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
}

/**
 * POST /start
 * Kicks off historical activity generation asynchronously.
 */
router.post('/start', authenticate, requireProductionConfirm, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const genRun = await service.start(connection, req.user.id, req.body || {});
    return res.json({ genRun });
  } catch (err) {
    console.error('[generate/start]', err.message);
    return res.status([400, 409].includes(err.status) ? err.status : 500).json({ error: [400, 409].includes(err.status) ? err.message : 'Could not start generation. Saved progress has been kept.' });
  }
});

/**
 * GET /status
 * Returns the latest GenerationRun for the user's company.
 */
router.get('/status', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const genRun = await service.current(connection, req.user.id);

    if (!genRun) {
      return res.json({ genRun: null, message: 'No generation runs found' });
    }

    return res.json({ genRun: generationView(genRun) });
  } catch (err) {
    console.error('[generate/status]', err.message);
    return res.status(500).json({ error: 'Failed to fetch generation status' });
  }
});

/**
 * GET /history
 * Returns all GenerationRuns for the user's company.
 */
router.get('/history', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const genRuns = await GenerationRun.find({
      userId: req.user.id,
      ...service.runFilter(connection),
    }).sort({ createdAt: -1 });

    return res.json({ genRuns: genRuns.map(run => generationView(run)) });
  } catch (err) {
    console.error('[generate/history]', err.message);
    return res.status(500).json({ error: 'Failed to fetch generation history' });
  }
});

/**
 * GET /log/:runId
 * Returns the full transaction log for a specific generation run.
 */
router.get('/log/:runId', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) return res.status(404).json({ error: 'No active QBO connection' });
    const genRun = await GenerationRun.findOne({
      _id: req.params.runId, userId: req.user.id, ...service.runFilter(connection),
    });

    if (!genRun) {
      return res.status(404).json({ error: 'Generation run not found' });
    }

    const view = generationView(genRun);
    return res.json({
      ...view, runId: genRun._id, transactions: view.createdTransactions,
      errors: view.generationErrors, totalTransactions: view.counts.created,
    });
  } catch (err) {
    console.error('[generate/log]', err.message);
    return res.status(500).json({ error: 'Failed to fetch transaction log' });
  }
});

module.exports = router;
