const AuditLog = require('../models/AuditLog');

/**
 * createAuditEntry – writes an append-only AuditLog document.
 *
 * @param {string} userId   - Mongoose ObjectId of the acting user
 * @param {string} realmId  - QBO company realmId
 * @param {string} action   - human-readable action description
 * @param {object} details  - optional fields: actionType, tool, inputParams,
 *                            outcome, beforeState, afterState, aiDriven, error
 */
async function createAuditEntry(userId, realmId, action, details = {}) {
  try {
    const entry = await AuditLog.create({
      userId,
      realmId,
      action,
      actionType: details.actionType,
      tool: details.tool,
      inputParams: details.inputParams,
      outcome: details.outcome || 'success',
      beforeState: details.beforeState,
      afterState: details.afterState,
      aiDriven: details.aiDriven || false,
      approvalEvent: details.approvalEvent,
      error: details.error,
    });
    return entry;
  } catch (err) {
    // Audit failures should never break the main request flow
    console.error('[audit] Failed to create audit entry:', err.message);
    return null;
  }
}

/**
 * auditMiddleware – Express middleware that:
 *  1. Attaches req.audit(action, details) helper for convenient logging.
 *  2. Automatically logs route hits for mutating methods (POST, PUT, DELETE).
 */
function auditMiddleware(req, res, next) {
  // Attach convenience helper (usable even for GET routes that need manual audit)
  req.audit = (action, details) => {
    const userId = req.user ? req.user.id : null;
    const realmId = req.activeRealmId || null;
    return createAuditEntry(userId, realmId, action, details);
  };

  // Auto-log mutating requests after the response is sent
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const originalEnd = res.end;
    res.end = function (...args) {
      // Fire-and-forget audit entry for the route hit
      const userId = req.user ? req.user.id : null;
      const realmId = req.activeRealmId || null;
      createAuditEntry(userId, realmId, `${req.method} ${req.originalUrl}`, {
        actionType: 'manual',
        outcome: res.statusCode < 400 ? 'success' : 'failure',
        inputParams: { body: req.body, query: req.query },
      });
      originalEnd.apply(res, args);
    };
  }

  next();
}

module.exports = { createAuditEntry, auditMiddleware };
