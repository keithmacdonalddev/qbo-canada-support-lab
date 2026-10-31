const express = require('express');
const Connection = require('../models/Connection');
const { authenticate } = require('../middleware/auth');
const config = require('../config');
const coverage = require('../modules/coverage');

const router = express.Router();

// Read only the private synced copy; no QBO client, token refresh or live fallback.
router.get('/', authenticate, async (req, res) => {
  try {
    const connection = await Connection.findOne({ userId: req.user.id, status: 'active' }).select('_id realmId').sort({ updatedAt: -1 });
    if (!connection) return res.status(404).json({ error: 'No active QBO connection' });
    const scope = { environment: config.qbo.environment, realmId: connection.realmId, connectionId: String(connection._id) };
    if (req.query.cached === 'true') return res.json({ data: coverage.getCached(scope.realmId, { scope }) });
    const result = await coverage.getMirrorCoverage(scope, { refresh: req.query.refresh === 'true' });
    return res.json({ data: result });
  } catch (err) {
    console.error('[coverage]', err.message);
    return res.status(500).json({ error: 'Coverage could not be checked from the synced copy' });
  }
});

module.exports = router;
