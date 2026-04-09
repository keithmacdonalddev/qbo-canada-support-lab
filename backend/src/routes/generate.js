const express = require('express');
const Connection = require('../models/Connection');
const CompanyProfile = require('../models/CompanyProfile');
const GenerationRun = require('../models/GenerationRun');
const { authenticate } = require('../middleware/auth');
const { runGenerationJob } = require('../modules/generation-engine');

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
router.post('/start', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const realmId = connection.realmId;

    // Prevent duplicate runs
    const existing = await GenerationRun.findOne({
      userId: req.user.id,
      realmId,
      status: 'in_progress',
    });
    if (existing) {
      return res.json({ genRun: existing, message: 'Generation already in progress' });
    }

    // Accept optional config overrides
    const { monthsBack = 6, txnsPerMonth = 30 } = req.body || {};

    const genRun = await GenerationRun.create({
      userId: req.user.id,
      realmId,
      status: 'pending',
      config: {
        monthsBack: Math.min(monthsBack, 12),
        txnsPerMonth: Math.min(txnsPerMonth, 60),
        arWeight: 0.6,
        apWeight: 0.4,
      },
      progress: { phase: 'starting', detail: 'Initializing...' },
    });

    await CompanyProfile.findOneAndUpdate(
      { userId: req.user.id, realmId },
      { generationStatus: 'in_progress' }
    );

    // Fire and forget
    runGenerationJob(req.user.id, realmId, genRun._id, connection).catch((err) => {
      console.error('[generate/background]', err.message);
    });

    return res.json({ genRun, message: 'Generation started' });
  } catch (err) {
    console.error('[generate/start]', err.message);
    return res.status(500).json({ error: 'Failed to start generation' });
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

    const genRun = await GenerationRun.findOne({
      userId: req.user.id,
      realmId: connection.realmId,
    }).sort({ createdAt: -1 });

    if (!genRun) {
      return res.json({ genRun: null, message: 'No generation runs found' });
    }

    return res.json({ genRun });
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
      realmId: connection.realmId,
    }).sort({ createdAt: -1 });

    return res.json({ genRuns });
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
    const genRun = await GenerationRun.findOne({
      _id: req.params.runId,
      userId: req.user.id,
    });

    if (!genRun) {
      return res.status(404).json({ error: 'Generation run not found' });
    }

    return res.json({
      runId: genRun._id,
      status: genRun.status,
      config: genRun.config,
      txnsSummary: genRun.txnsSummary,
      transactions: genRun.createdTransactions,
      errors: genRun.generationErrors,
      totalTransactions: genRun.createdTransactions.length,
    });
  } catch (err) {
    console.error('[generate/log]', err.message);
    return res.status(500).json({ error: 'Failed to fetch transaction log' });
  }
});

module.exports = router;
