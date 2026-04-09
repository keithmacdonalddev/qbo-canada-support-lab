const express = require('express');
const Connection = require('../models/Connection');
const AuditLog = require('../models/AuditLog');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * Helper -- find the user's active Connection.
 */
async function getActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
}

/**
 * GET /
 * Returns audit logs for the user's active company.
 * Query params: limit, offset, actionType, startDate, endDate
 * Supervisors can see all entries for their company.
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const {
      limit = 50,
      offset = 0,
      actionType,
      startDate,
      endDate,
    } = req.query;

    const filter = { realmId: connection.realmId };

    // Agents see only their own entries; supervisors see all for the company
    if (req.user.role !== 'supervisor') {
      filter.userId = req.user.id;
    }

    if (actionType) {
      filter.actionType = actionType;
    }

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(parseInt(offset, 10))
        .limit(parseInt(limit, 10))
        .populate('userId', 'email displayName'),
      AuditLog.countDocuments(filter),
    ]);

    return res.json({
      logs,
      pagination: {
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      },
    });
  } catch (err) {
    console.error('[audit/list]', err.message);
    return res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

/**
 * GET /:id
 * Returns a single audit entry.
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const entry = await AuditLog.findById(req.params.id)
      .populate('userId', 'email displayName');

    if (!entry) {
      return res.status(404).json({ error: 'Audit entry not found' });
    }

    // Access control: agents can only see their own; supervisors can see
    // any entry for a realm they're connected to.
    if (req.user.role !== 'supervisor' && entry.userId._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.json({ entry });
  } catch (err) {
    console.error('[audit/get]', err.message);
    return res.status(500).json({ error: 'Failed to fetch audit entry' });
  }
});

module.exports = router;
