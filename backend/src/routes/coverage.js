const express = require('express');
const Connection = require('../models/Connection');
const { authenticate } = require('../middleware/auth');
const { createQBOClient } = require('../modules/qbo-client');
const { respondQboError } = require('../modules/qbo-error');
const coverage = require('../modules/coverage');

const router = express.Router();

async function getActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
}

/**
 * GET /
 * Which QuickBooks feature areas the connected company actually uses,
 * measured from its records. Read-only. Cached for ten minutes per company;
 * ?refresh=true reads the company again. ?cached=true never calls QuickBooks
 * and returns null when there is no earlier result.
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }
    if (req.query.cached === 'true') {
      return res.json({ data: coverage.getCached(connection.realmId) });
    }
    const qbo = await createQBOClient(connection);
    const result = await coverage.getCoverage(qbo, connection.realmId, { refresh: req.query.refresh === 'true' });
    return res.json({ data: result });
  } catch (err) {
    console.error('[coverage]', err.message);
    if (respondQboError(res, err)) return;
    return res.status(500).json({ error: 'Coverage could not be checked' });
  }
});

module.exports = router;
