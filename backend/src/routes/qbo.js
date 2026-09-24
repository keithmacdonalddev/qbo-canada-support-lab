const express = require('express');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const OAuthClient = require('intuit-oauth');
const config = require('../config');
const Connection = require('../models/Connection');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { createAuditEntry } = require('../middleware/auditLogger');
const { deriveTokenHealth, refreshTokenExpiryFrom, isAuthFailure, expireRejectedConnection, describeRefreshFailure } = require('../modules/connection-health');
const { redactLogSecrets } = require('../modules/log-diagnostic');
const { createQBOClient } = require('../modules/qbo-client');

// In-memory nonce store (keyed by nonce → { userId, createdAt })
// In production this should be Redis/DB with TTL
const pendingOAuthStates = new Map();

const router = express.Router();

async function preferredConnection(userId, statuses = ['active', 'expired', 'error', 'revoked'], session) {
  for (const status of statuses) {
    let query = Connection.findOne({ userId, status }).sort({ updatedAt: -1 });
    if (session) query = query.session(session);
    const connection = await query;
    if (connection) return connection;
  }
  return null;
}

async function lockUserConnectionScope(userId, session) {
  const guard = await User.updateOne(
    { _id: userId },
    { $inc: { connectionSwitchVersion: 1 } },
    { session },
  );
  if (guard.matchedCount !== 1) throw new Error('Connecting user is no longer available.');
}

function localAppOrigin(req) {
  for (const candidate of [req.get('origin'), req.get('referer')]) {
    try {
      const origin = new URL(candidate).origin;
      if (['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin)) return origin;
    } catch (_) { /* try the next browser header */ }
  }
  return 'http://localhost:5173';
}

function popupResult(type, message, origin) {
  const data = JSON.stringify({ type, ...(message ? { error: message } : {}) }).replace(/</g, '\\u003c');
  const target = JSON.stringify(origin).replace(/</g, '\\u003c');
  const visible = type === 'qbo_connected'
    ? 'Connected! This window should close automatically.'
    : 'Connection was not completed. Close this window and try again.';
  return `<html><body><script>if (window.opener) window.opener.postMessage(${data}, ${target}); window.close();</script><p>${visible}</p></body></html>`;
}

/**
 * Build a fresh OAuthClient instance (stateless -- tokens set per request).
 */
function buildOAuthClient() {
  return new OAuthClient({
    clientId: config.qbo.clientId,
    clientSecret: config.qbo.clientSecret,
    environment: config.qbo.environment,
    redirectUri: config.qbo.redirectUri,
  });
}

/**
 * GET /connect
 * Generates the Intuit OAuth authorization URL.
 */
router.get('/connect', authenticate, (req, res) => {
  try {
    const nonce = crypto.randomBytes(32).toString('hex');
    pendingOAuthStates.set(nonce, { userId: req.user.id, createdAt: Date.now(), frontendOrigin: localAppOrigin(req) });

    // Clean up stale nonces older than 10 minutes
    const TEN_MIN = 10 * 60 * 1000;
    for (const [key, val] of pendingOAuthStates) {
      if (Date.now() - val.createdAt > TEN_MIN) pendingOAuthStates.delete(key);
    }

    const oauthClient = buildOAuthClient();
    const authUri = oauthClient.authorizeUri({
      scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
      state: nonce,
    });
    return res.json({ authUri, callbackOrigin: new URL(config.qbo.redirectUri).origin });
  } catch (err) {
    console.error('[qbo/connect]', err.message);
    return res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

/**
 * GET /callback
 * Handles the OAuth redirect from Intuit.
 * Exchanges code for tokens, upserts Connection, creates audit entry.
 */
router.get('/callback', async (req, res) => {
  let frontendOrigin = 'http://localhost:5173';
  try {
    const nonce = req.query.state;
    const pending = typeof nonce === 'string' ? pendingOAuthStates.get(nonce) : null;
    if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      return res.status(403).send('<html><body><p>Authorization expired. Close this window and connect again.</p></body></html>');
    }
    pendingOAuthStates.delete(nonce);
    frontendOrigin = pending.frontendOrigin;
    if (req.query.error) {
      return res.send(popupResult('qbo_error', 'QuickBooks authorization was cancelled or declined. Try connecting again.', frontendOrigin));
    }
    const realmId = req.query.realmId;
    if (typeof realmId !== 'string' || !/^\d+$/.test(realmId) || !req.query.code) {
      return res.send(popupResult('qbo_error', 'QuickBooks returned an incomplete authorization. Try connecting again.', frontendOrigin));
    }

    const oauthClient = buildOAuthClient();

    // Exchange authorization code for tokens
    const authResponse = await oauthClient.createToken(req.url);

    let tokenData;
    try {
      tokenData = typeof authResponse.getJson === 'function'
        ? authResponse.getJson()
        : null;
    } catch (_) { /* ignore */ }
    if (!tokenData) {
      tokenData = authResponse.json || JSON.parse(authResponse.body || '{}');
    }

    const userId = pending.userId;
    if (!tokenData.access_token || !tokenData.refresh_token) {
      throw new Error('QuickBooks returned an incomplete authorization token response.');
    }
    const audit = await createAuditEntry(userId, realmId, 'QBO authorization granted', {
      actionType: 'connection', outcome: 'success',
    });
    if (!audit) throw new Error('Could not record QuickBooks authorization.');

    // Switch company scope in one transaction. A failed old-realm revocation
    // must roll back the new active realm too.
    const session = await mongoose.startSession();
    let connection;
    try {
      await session.withTransaction(async () => {
        // Every company switch for this user writes the same guard document.
        // Concurrent callbacks for different realms then conflict and retry
        // against the latest committed active realm instead of both staying active.
        await lockUserConnectionScope(userId, session);
        connection = await Connection.findOneAndUpdate(
          { userId, realmId },
          {
            userId,
            realmId,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            tokenExpiresAt: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000),
            refreshTokenExpiresAt: refreshTokenExpiryFrom(tokenData),
            scope: tokenData.scope || '',
            status: 'active',
            lastRefreshedAt: new Date(),
          },
          { upsert: true, new: true, setDefaultsOnInsert: true, session },
        );
        await Connection.updateMany(
          { userId, status: 'active', _id: { $ne: connection._id } },
          { status: 'revoked' },
          { session },
        );
        await AuditLog.create([{
          userId, realmId, action: 'QBO OAuth connected',
          actionType: 'connection', outcome: 'success',
          afterState: { connectionId: connection._id, status: 'active' },
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    // Close the popup and signal the parent window
    return res.send(popupResult('qbo_connected', null, frontendOrigin));
  } catch (err) {
    console.error('[qbo/callback] failed', redactLogSecrets(err.stack || err.message));
    return res.send(popupResult('qbo_error', 'QuickBooks connection failed. Check the app log, then try again.', frontendOrigin));
  }
});

/**
 * POST /refresh
 * Refreshes tokens for the user's active connection.
 */
router.post('/refresh', authenticate, async (req, res) => {
  let connection;
  let qbo;
  try {
    try {
      connection = await preferredConnection(req.user.id, ['active', 'expired']);
    } catch (error) {
      error.qboStage = 'storage_read';
      throw error;
    }

    if (!connection) {
      return res.status(404).json({ error: 'No active connection found' });
    }

    // Audit user intent before changing provider or stored tokens. Automatic
    // requests use the same single-flight refresh path in QBOClient.
    const audit = await createAuditEntry(req.user.id, connection.realmId, 'QBO token refresh requested', {
      actionType: 'connection', outcome: 'success',
      beforeState: { status: connection.status },
    });
    if (!audit) {
      return res.status(503).json({ error: 'Could not record the refresh attempt. Try again.', code: 'QBO_AUDIT_UNAVAILABLE' });
    }
    qbo = await createQBOClient(connection);
    await qbo.ensureFreshToken({ force: true });
    const refreshedAudit = await createAuditEntry(req.user.id, connection.realmId, 'QBO token refreshed', {
      actionType: 'connection', outcome: 'success',
      afterState: { status: 'active' },
    });
    if (!refreshedAudit) {
      return res.status(503).json({
        error: 'QuickBooks authorization was saved, but its audit record failed. Check the app log.',
        code: 'QBO_AUDIT_UNAVAILABLE', status: 'active',
      });
    }

    return res.json({
      message: 'QuickBooks connection verified and saved',
      status: 'active',
      tokenExpiresAt: qbo.connection.tokenExpiresAt,
    });
  } catch (err) {
    if (qbo?.connection) connection = qbo.connection;
    const reconnectRequired = isAuthFailure(err);
    const failure = describeRefreshFailure(err);
    const trace = { qboStatus: failure.qboStatus, intuit_tid: failure.intuit_tid };
    console.error('[qbo/refresh] failed', {
      stage: err.qboStage || 'unknown',
      code: typeof err.code === 'string' ? redactLogSecrets(err.code) : 'unknown',
      qboStatus: failure.qboStatus || 'unknown',
      oauthError: redactLogSecrets(err.error),
      providerDescription: redactLogSecrets(err.description || err.error_description),
      originalMessage: redactLogSecrets(err.originalMessage),
      message: redactLogSecrets(err.message),
      stack: redactLogSecrets(err.stack || ''),
      intuit_tid: failure.intuit_tid || 'unknown',
      category: reconnectRequired ? 'QBO_RECONNECT_REQUIRED' : failure.code,
      reconnectRequired,
    });
    if (connection) {
      await createAuditEntry(req.user.id, connection.realmId, 'QBO token refresh failed', {
        actionType: 'connection', outcome: 'failure',
        beforeState: { status: connection.status }, error: reconnectRequired ? 'QBO_RECONNECT_REQUIRED' : failure.code,
      });
    }
    if (reconnectRequired && connection?.status === 'active') {
      try {
        const expired = await expireRejectedConnection(connection, err, req.user.id, createAuditEntry);
        if (!expired) {
          return res.status(409).json({
            error: 'Saved QuickBooks authorization changed during verification. Reload the connection status.',
            code: 'QBO_CONNECTION_CHANGED',
            ...trace,
          });
        }
      } catch (saveError) {
        console.error('[qbo/refresh] status update failed', redactLogSecrets(saveError.message));
        return res.status(503).json({ error: 'QuickBooks rejected the saved token, but the connection status could not be updated. Try again.', code: 'QBO_STATUS_UPDATE_FAILED', ...trace });
      }
    }
    if (reconnectRequired) {
      return res.status(409).json({ error: 'QuickBooks rejected the saved authorization. Reconnect your company.', code: 'QBO_RECONNECT_REQUIRED', ...trace });
    }
    return res.status(failure.httpStatus).json({
      error: failure.message,
      code: failure.code,
      ...trace,
    });
  }
});

/**
 * GET /status
 * Returns connection status for the current user.
 */
router.get('/status', authenticate, async (req, res) => {
  try {
    const connection = await preferredConnection(req.user.id);

    if (!connection) {
      return res.json({ connected: false, status: 'none', environment: config.qbo.environment });
    }

    // "Connected" tracks the refresh token, not the access token: the access
    // token is short-lived and auto-refreshes, so its expiry must not flip the
    // connection to "disconnected". deriveTokenHealth encodes that rule, shared
    // with /company/health so the header and dashboard agree.
    const health = deriveTokenHealth(connection);

    return res.json({
      connected: health.usable,
      status: health.effectiveStatus,
      environment: config.qbo.environment,
      realmId: connection.realmId,
      companyName: connection.companyName,
      tokenExpiresAt: connection.tokenExpiresAt,
      refreshTokenExpiresAt: health.refreshTokenExpiresAt,
      refreshTokenExpiresInDays: health.refreshTokenExpiresInDays,
      lastRefreshedAt: connection.lastRefreshedAt,
    });
  } catch (err) {
    console.error('[qbo/status]', err.message);
    return res.status(500).json({ error: 'Failed to check connection status' });
  }
});

/**
 * POST /disconnect
 * Marks the user's active connection as revoked.
 */
router.post('/disconnect', authenticate, async (req, res) => {
  try {
    const session = await mongoose.startSession();
    let disconnected;
    try {
      await session.withTransaction(async () => {
        disconnected = null;
        await lockUserConnectionScope(req.user.id, session);
        const connection = await preferredConnection(req.user.id, ['active', 'expired'], session);
        if (!connection) return;
        disconnected = await Connection.findOneAndUpdate(
          { _id: connection._id, userId: req.user.id, status: connection.status, refreshToken: connection.refreshToken },
          { $set: { status: 'revoked' } },
          { new: true, session },
        );
        if (!disconnected) {
          const error = new Error('Saved QuickBooks connection changed during disconnect.');
          error.qboStage = 'conflict';
          throw error;
        }
        await AuditLog.create([{
          userId: req.user.id, realmId: connection.realmId,
          action: 'QBO disconnected', actionType: 'connection', outcome: 'success',
          beforeState: { status: connection.status }, afterState: { status: 'revoked' },
        }], { session });
      });
    } finally {
      await session.endSession();
    }
    if (!disconnected) return res.status(404).json({ error: 'No active connection to disconnect' });
    return res.json({ message: 'Connection revoked', realmId: disconnected.realmId });
  } catch (err) {
    console.error('[qbo/disconnect]', redactLogSecrets(err.stack || err.message));
    if (err.qboStage === 'conflict') {
      return res.status(409).json({ error: 'The QuickBooks connection changed during disconnect. Reload its status and try again.', code: 'QBO_CONNECTION_CHANGED' });
    }
    return res.status(503).json({ error: 'Could not safely disconnect the QuickBooks company. Its saved status was kept.', code: 'QBO_DISCONNECT_UNAVAILABLE' });
  }
});

module.exports = router;
