const express = require('express');
const Connection = require('../models/Connection');
const AuditLog = require('../models/AuditLog');
const { authenticate } = require('../middleware/auth');
const { createQBOClient } = require('../modules/qbo-client');
const { respondQboError } = require('../modules/qbo-error');

const router = express.Router();

const VALID_ENTITIES = [
  'Customer', 'Invoice', 'Payment', 'CreditMemo',
  'Bill', 'BillPayment', 'VendorCredit', 'Vendor',
  'Item', 'Account', 'JournalEntry', 'Estimate', 'Deposit',
];

async function getActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
}

/**
 * GET /search
 * Search entities by type + optional query string.
 * Query params: type (required), q (optional text search), limit (default 50)
 */
router.get('/search', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const { type, q, limit = 50 } = req.query;
    if (!type || !VALID_ENTITIES.includes(type)) {
      return res.status(400).json({ error: `Invalid entity type. Must be one of: ${VALID_ENTITIES.join(', ')}` });
    }

    const qbo = await createQBOClient(connection);
    let queryStr = `SELECT * FROM ${type}`;

    if (q) {
      // Sanitize: strip single quotes, backslashes, and control chars
      const sanitized = q.replace(/['\\\x00-\x1f]/g, '').trim();
      if (sanitized) {
        const nameField = ['Item', 'Account'].includes(type) ? 'Name' : 'DisplayName';
        if (['Invoice', 'Bill', 'Payment', 'CreditMemo', 'BillPayment', 'VendorCredit', 'Estimate', 'JournalEntry', 'Deposit'].includes(type)) {
          queryStr += ` WHERE DocNumber LIKE '%${sanitized}%'`;
        } else {
          queryStr += ` WHERE ${nameField} LIKE '%${sanitized}%'`;
        }
      }
    }

    queryStr += ` MAXRESULTS ${Math.min(Number(limit), 100)}`;

    const result = await qbo.query(queryStr);
    const records = result.QueryResponse?.[type] || [];

    return res.json({ type, records, count: records.length });
  } catch (err) {
    console.error('[explore/search]', err.message);
    if (respondQboError(res, err)) return;
    return res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /timeline
 * Recent changes from AuditLog, optionally filtered by entity type.
 * Query params: limit (default 50), entityType (optional)
 */
router.get('/timeline', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const { limit = 50, entityType } = req.query;

    const filter = {
      userId: req.user.id,
      realmId: connection.realmId,
    };
    if (entityType) {
      filter.action = new RegExp(entityType, 'i');
    }

    const entries = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit), 200));

    return res.json({ entries });
  } catch (err) {
    console.error('[explore/timeline]', err.message);
    return res.status(500).json({ error: 'Failed to load timeline' });
  }
});

/**
 * GET /:entity/:id
 * Get full entity detail from QBO.
 */
router.get('/:entity/:id', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const { entity, id } = req.params;
    if (!VALID_ENTITIES.map((e) => e.toLowerCase()).includes(entity.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid entity type' });
    }

    const qbo = await createQBOClient(connection);
    const result = await qbo.read(entity.toLowerCase(), id);

    // QBO returns { Invoice: {...} } or { Customer: {...} } etc.
    const entityKey = Object.keys(result).find((k) => k !== 'time');
    const record = entityKey ? result[entityKey] : result;

    return res.json({ entity: entity.toLowerCase(), record });
  } catch (err) {
    console.error('[explore/read]', err.message);
    if (respondQboError(res, err)) return;
    return res.status(500).json({ error: 'Failed to read entity' });
  }
});

/**
 * GET /:entity/:id/chain
 * Trace linked transactions recursively.
 * Returns the full graph as an array of nodes with edges.
 */
router.get('/:entity/:id/chain', authenticate, async (req, res) => {
  try {
    const connection = await getActiveConnection(req.user.id);
    if (!connection) {
      return res.status(404).json({ error: 'No active QBO connection' });
    }

    const { entity, id } = req.params;
    const qbo = await createQBOClient(connection);

    const visited = new Set();
    const nodes = [];
    const edges = [];

    async function trace(entityType, entityId) {
      const key = `${entityType}:${entityId}`;
      if (visited.has(key)) return;
      visited.add(key);

      try {
        const result = await qbo.read(entityType.toLowerCase(), entityId);
        const entityKey = Object.keys(result).find((k) => k !== 'time');
        const record = entityKey ? result[entityKey] : result;

        nodes.push({
          entity: entityType,
          id: entityId,
          data: record,
        });

        // Follow LinkedTxn references
        const linkedTxns = record.LinkedTxn || [];
        for (const link of linkedTxns) {
          edges.push({
            from: key,
            to: `${link.TxnType}:${link.TxnId}`,
            linkType: 'LinkedTxn',
          });
          await trace(link.TxnType, link.TxnId);
        }

        // Follow Line-level LinkedTxn (e.g., Payment lines linking to Invoices)
        const lines = record.Line || [];
        for (const line of lines) {
          const lineLinks = line.LinkedTxn || [];
          for (const link of lineLinks) {
            edges.push({
              from: key,
              to: `${link.TxnType}:${link.TxnId}`,
              linkType: 'LineLinkedTxn',
            });
            await trace(link.TxnType, link.TxnId);
          }
        }
      } catch (err) {
        // Entity might not be readable — skip silently
        nodes.push({
          entity: entityType,
          id: entityId,
          error: err.message,
        });
      }
    }

    await trace(entity, id);

    return res.json({ nodes, edges });
  } catch (err) {
    console.error('[explore/chain]', err.message);
    if (respondQboError(res, err)) return;
    return res.status(500).json({ error: 'Failed to trace chain' });
  }
});

module.exports = router;
