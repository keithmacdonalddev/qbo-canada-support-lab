const express = require('express');
const crypto = require('node:crypto');
const OAuthClient = require('intuit-oauth');
const config = require('../config');
const Connection = require('../models/Connection');
const { authenticate } = require('../middleware/auth');
const { createAuditEntry } = require('../middleware/auditLogger');

// In-memory nonce store (keyed by nonce → { userId, createdAt })
// In production this should be Redis/DB with TTL
const pendingOAuthStates = new Map();

const router = express.Router();

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
    pendingOAuthStates.set(nonce, { userId: req.user.id, createdAt: Date.now() });

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
    return res.json({ authUri });
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
  try {
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

    const realmId = req.query.realmId;
    const nonce = req.query.state;

    if (!realmId || !nonce) {
      return res.status(400).json({ error: 'Missing realmId or state' });
    }

    // Validate and consume the nonce
    const pending = pendingOAuthStates.get(nonce);
    if (!pending) {
      return res.status(403).send('<html><body><p>Invalid or expired OAuth state. Please try connecting again.</p></body></html>');
    }
    pendingOAuthStates.delete(nonce);

    const userId = pending.userId;

    // Revoke any existing active connections for this user (one company per user)
    await Connection.updateMany(
      { userId, status: 'active' },
      { status: 'revoked' }
    );

    // Create or update Connection document for this realm
    const connection = await Connection.findOneAndUpdate(
      { userId, realmId },
      {
        userId,
        realmId,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenExpiresAt: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000),
        scope: tokenData.scope || '',
        status: 'active',
        lastRefreshedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Audit the connection event
    await createAuditEntry(userId, realmId, 'QBO OAuth connected', {
      actionType: 'connection',
      outcome: 'success',
      afterState: { connectionId: connection._id, status: 'active' },
    });

    // Close the popup and signal the parent window
    return res.send(`
      <html><body>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'qbo_connected', realmId: '${realmId}' }, 'http://localhost:5173');
          }
          window.close();
        </script>
        <p>Connected! This window should close automatically. If not, close it manually.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[qbo/callback]', err.message);
    return res.send(`
      <html><body>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'qbo_error', error: '${err.message.replace(/'/g, "\\'")}' }, 'http://localhost:5173');
          }
          window.close();
        </script>
        <p>Connection failed. Close this window and try again.</p>
      </body></html>
    `);
  }
});

/**
 * POST /refresh
 * Refreshes tokens for the user's active connection.
 */
router.post('/refresh', authenticate, async (req, res) => {
  try {
    const connection = await Connection.findOne({
      userId: req.user.id,
      status: { $in: ['active', 'expired'] },
    }).sort({ updatedAt: -1 });

    if (!connection) {
      return res.status(404).json({ error: 'No active connection found' });
    }

    const oauthClient = buildOAuthClient();
    oauthClient.setToken({
      access_token: connection.accessToken,
      refresh_token: connection.refreshToken,
      token_type: 'bearer',
    });

    const response = await oauthClient.refresh();

    let tokenData;
    try {
      tokenData = typeof response.getJson === 'function' ? response.getJson() : null;
    } catch (_) { /* ignore */ }
    if (!tokenData) {
      tokenData = response.json || JSON.parse(response.body || '{}');
    }

    connection.accessToken = tokenData.access_token || connection.accessToken;
    connection.refreshToken = tokenData.refresh_token || connection.refreshToken;
    connection.tokenExpiresAt = new Date(
      Date.now() + (tokenData.expires_in || 3600) * 1000
    );
    connection.lastRefreshedAt = new Date();
    connection.status = 'active';
    await connection.save();

    return res.json({
      message: 'Tokens refreshed',
      tokenExpiresAt: connection.tokenExpiresAt,
    });
  } catch (err) {
    console.error('[qbo/refresh]', err.message);
    // Mark connection as expired on refresh failure
    try {
      await Connection.findOneAndUpdate(
        { userId: req.user.id, status: 'active' },
        { status: 'expired' }
      );
    } catch (_) { /* ignore */ }
    return res.status(500).json({ error: 'Token refresh failed' });
  }
});

/**
 * GET /status
 * Returns connection status for the current user.
 */
router.get('/status', authenticate, async (req, res) => {
  try {
    const connection = await Connection.findOne({ userId: req.user.id })
      .sort({ updatedAt: -1 });

    if (!connection) {
      return res.json({ connected: false, status: 'none' });
    }

    // Determine effective status
    let effectiveStatus = connection.status;
    if (
      effectiveStatus === 'active' &&
      connection.tokenExpiresAt &&
      new Date() > connection.tokenExpiresAt
    ) {
      effectiveStatus = 'expired';
    }

    return res.json({
      connected: effectiveStatus === 'active',
      status: effectiveStatus,
      realmId: connection.realmId,
      companyName: connection.companyName,
      tokenExpiresAt: connection.tokenExpiresAt,
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
    const connection = await Connection.findOne({
      userId: req.user.id,
      status: { $in: ['active', 'expired'] },
    }).sort({ updatedAt: -1 });

    if (!connection) {
      return res.status(404).json({ error: 'No active connection to disconnect' });
    }

    const beforeStatus = connection.status;
    connection.status = 'revoked';
    await connection.save();

    await createAuditEntry(req.user.id, connection.realmId, 'QBO disconnected', {
      actionType: 'connection',
      outcome: 'success',
      beforeState: { status: beforeStatus },
      afterState: { status: 'revoked' },
    });

    return res.json({ message: 'Connection revoked', realmId: connection.realmId });
  } catch (err) {
    console.error('[qbo/disconnect]', err.message);
    return res.status(500).json({ error: 'Failed to disconnect' });
  }
});

module.exports = router;
