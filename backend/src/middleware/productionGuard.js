/**
 * Production write guard (defense-in-depth).
 *
 * When the app is connected to a REAL production QuickBooks company
 * (config.qbo.environment === 'production'), mutating actions must carry
 * explicit intent. This middleware requires the request body to include
 * `confirmProduction: true` before any production write is allowed through.
 *
 * The frontend is expected to surface a confirmation step and send that flag;
 * this guard is a server-side backstop so a production write can never happen
 * by accident (e.g. a stray API call, a client bug, or a script) without the
 * caller explicitly acknowledging it targets a live company.
 *
 * In non-production environments (e.g. sandbox) this is a no-op and simply
 * calls next().
 *
 * Responds 412 (Precondition Failed) when confirmation is missing in
 * production.
 */

const config = require('../config');

function requireProductionConfirm(req, res, next) {
  if (config.qbo.environment === 'production' && req.body?.confirmProduction !== true) {
    return res.status(412).json({
      error:
        'This action writes data into a REAL connected QuickBooks company. Explicit confirmation is required.',
      environment: 'production',
      requiresConfirmation: true,
    });
  }
  return next();
}

module.exports = { requireProductionConfirm };
