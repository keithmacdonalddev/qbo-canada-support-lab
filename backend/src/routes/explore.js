const express = require('express');
const mongoose = require('mongoose');
const { readRecordOrigin } = require('../modules/record-origin');
const Connection = require('../models/Connection');
const AuditLog = require('../models/AuditLog');
const { authenticate } = require('../middleware/auth');
const { createQBOClient } = require('../modules/qbo-client');
const { respondQboError } = require('../modules/qbo-error');

const config = require('../config');
const { searchQuery, pageResult, identity, canonicalType, integer, ENTITIES, invalid } = require('../modules/record-queries');
function createExploreRouter(dependencies = {}) {
const router = express.Router();
const qboFor = dependencies.qboFor || createQBOClient;
const originFor = dependencies.originFor || (input => readRecordOrigin({ ...input, db: mongoose.connection.db, userId: new mongoose.Types.ObjectId(input.userId) }));
const getActiveConnection = dependencies.getActiveConnection || (userId => Connection.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 }));
const scope = connection => ({ realmId: connection.realmId, environment: config.qbo.environment, connectionId: String(connection._id) });
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

/**
 * GET /search
 * Search entities by type + optional query string.
 * Query params: type (required), q (optional text search), limit (default 50)
 */
router.get('/search', authenticate, async (req, res) => {
  try {
    const request = searchQuery(req.query);
    const connection = await getActiveConnection(req.user.id);
    if (!connection) return res.status(404).json({ error: 'No active QBO connection' });
    const qbo = await qboFor(connection);
    const result = pageResult(await qbo.query(request.query), request);
    return res.json({ ...result, scope: scope(connection) });
  } catch (error) {
    if (error.recordInputError) return res.status(400).json({ error: error.message });
    if (respondQboError(res, error)) return;
    return res.status(500).json({ error: 'Records could not be read completely. Try again.' });
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

    const { entityType } = req.query;
    const limit = integer(req.query.limit, 50, 1, 200);
    if (entityType !== undefined && !ENTITIES.includes(entityType)) throw invalid('Choose a supported record type.');

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
    if (err.recordInputError) return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// App receipts are a separate read: an unavailable history must not hide QBO data.
router.get('/:entity/:id/origin', authenticate, async (req, res) => {
  try {
    const { entity, id } = identity(req.params.entity, req.params.id);
    if (Object.keys(req.query).length) throw invalid('Record origin requests do not accept query options.');
    const connection = await getActiveConnection(req.user.id);
    if (!connection) return res.status(404).json({ error: 'No active QBO connection' });
    const origin = await originFor({ userId: req.user.id, realmId: connection.realmId, environment: config.qbo.environment, entity, id });
    return res.json({ ...origin, scope: scope(connection) });
  } catch (error) {
    if (error.recordInputError) return res.status(400).json({ error: error.message });
    return res.status(503).json({ error: 'Creation history could not be checked. QuickBooks records are still available.' });
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

    const { entity, id } = identity(req.params.entity, req.params.id);
    if (Object.keys(req.query).length) throw invalid('Record detail requests do not accept query options.');

    const qbo = await qboFor(connection);
    const result = await qbo.read(entity.toLowerCase(), id);

    // QBO returns { Invoice: {...} } or { Customer: {...} } etc.
    const record = result?.[entity];
    if (!record || String(record.Id) !== id) throw new Error('Invalid record response');

    return res.json({ entity: entity.toLowerCase(), record, scope: scope(connection) });
  } catch (err) {
    if (err.recordInputError) return res.status(400).json({ error: err.message });
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

    const { entity, id } = identity(req.params.entity, req.params.id);
    if (Object.keys(req.query).length) throw invalid('Record chain requests do not accept query options.');
    const qbo = await qboFor(connection);

    // Each record is one QuickBooks read; stop well short of the rate limit.
    const MAX_RECORDS = 40, MAX_EDGES = 1000;
    const deadline = Date.now() + 60000;
    const visited = new Set();
    let truncated = false;
    const nodes = [];
    const edges = [];

    async function trace(entityType, entityId) {
      entityType = canonicalType(entityType) || entityType;
      const key = `${entityType}:${entityId}`;
      if (visited.has(key)) return;
      if (visited.size >= MAX_RECORDS || Date.now() >= deadline) { truncated = true; return; }
      visited.add(key);

      try {
        identity(entityType, String(entityId));
        const result = await qbo.read(entityType.toLowerCase(), entityId);
        const record = result?.[entityType];
        if (!record || String(record.Id) !== String(entityId)) throw new Error('Invalid linked record response');

        nodes.push({
          entity: entityType,
          id: entityId,
          data: record,
        });

        // Follow LinkedTxn references
        const linkedTxns = record.LinkedTxn || [];
        for (const link of linkedTxns) {
          if (edges.length >= MAX_EDGES || Date.now() >= deadline) { truncated = true; return; }
          edges.push({
            from: key,
            to: `${(canonicalType(link.TxnType) || link.TxnType)}:${link.TxnId}`,
            linkType: 'LinkedTxn',
          });
          await trace((canonicalType(link.TxnType) || link.TxnType), link.TxnId);
        }

        // Follow Line-level LinkedTxn (e.g., Payment lines linking to Invoices)
        const lines = record.Line || [];
        for (const line of lines) {
          const lineLinks = line.LinkedTxn || [];
          for (const link of lineLinks) {
            if (edges.length >= MAX_EDGES || Date.now() >= deadline) { truncated = true; return; }
            edges.push({
              from: key,
              to: `${(canonicalType(link.TxnType) || link.TxnType)}:${link.TxnId}`,
              linkType: 'LineLinkedTxn', fromLineId: line.Id == null ? null : String(line.Id), toLineId: link.TxnLineId == null ? null : String(link.TxnLineId),
            });
            await trace((canonicalType(link.TxnType) || link.TxnType), link.TxnId);
          }
        }
      } catch (err) {
        // Preserve an explicit incomplete node rather than implying a full graph.
        nodes.push({
          entity: entityType,
          id: entityId,
          error: 'Linked record could not be read.', intuit_tid: err.intuit_tid || null,
        });
      }
    }

    await trace(entity, id);

    return res.json({ nodes, edges, truncated, complete: !truncated && !nodes.some(node => node.error), scope: scope(connection) });
  } catch (err) {
    if (err.recordInputError) return res.status(400).json({ error: err.message });
    if (respondQboError(res, err)) return;
    return res.status(500).json({ error: 'Failed to trace chain' });
  }
});

return router;
}
module.exports = createExploreRouter();
module.exports.createExploreRouter = createExploreRouter;
