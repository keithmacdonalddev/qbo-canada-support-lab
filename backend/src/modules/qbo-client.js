const OAuthClient = require('intuit-oauth');
const config = require('../config');
const Connection = require('../models/Connection');

/**
 * QBOClient – per-connection wrapper around the Intuit OAuth SDK.
 *
 * Usage:
 *   const client = new QBOClient(connectionDoc);
 *   const result = await client.query("SELECT * FROM Customer MAXRESULTS 10");
 */
class QBOClient {
  /**
   * @param {object} connection - Mongoose Connection document (with tokens, realmId)
   */
  constructor(connection) {
    this.connection = connection;
    this.realmId = connection.realmId;

    this.oauthClient = new OAuthClient({
      clientId: config.qbo.clientId,
      clientSecret: config.qbo.clientSecret,
      environment: config.qbo.environment,
      redirectUri: config.qbo.redirectUri,
    });

    // Hydrate the OAuth client with the stored tokens (include expiry so
    // isAccessTokenValid() works and we don't force-refresh valid tokens)
    const tokenPayload = {
      access_token: connection.accessToken,
      refresh_token: connection.refreshToken,
      token_type: 'bearer',
    };
    if (connection.tokenExpiresAt) {
      const remainingSec = Math.max(
        0,
        Math.floor((connection.tokenExpiresAt.getTime() - Date.now()) / 1000)
      );
      tokenPayload.expires_in = remainingSec;
      tokenPayload.createdAt = Date.now();
    }
    this.oauthClient.setToken(tokenPayload);

    // Rate-limit tracking
    this._requestLog = [];
    this._windowMs = 60000;
    this._retryAfterUntil = 0;
  }

  /**
   * Base URL for the QBO v3 API for this company.
   */
  get apiBase() {
    const host =
      config.qbo.environment === 'production'
        ? 'https://quickbooks.api.intuit.com'
        : 'https://sandbox-quickbooks.api.intuit.com';
    return `${host}/v3/company/${this.realmId}`;
  }

  // ---------- Token management ----------

  /**
   * Ensure the access token is still valid; refresh if not.
   * Persists new tokens back to the Connection document.
   */
  async ensureFreshToken() {
    if (!this.oauthClient.isAccessTokenValid()) {
      const response = await this.oauthClient.refresh();

      // intuit-oauth AuthResponse: try .getJson(), then .json
      let tokenData;
      try {
        tokenData = typeof response.getJson === 'function' ? response.getJson() : null;
      } catch (_) { /* ignore */ }
      if (!tokenData) {
        tokenData = response.json || JSON.parse(response.body || '{}');
      }

      // Update Connection document in the database
      this.connection.accessToken = tokenData.access_token || this.connection.accessToken;
      this.connection.refreshToken = tokenData.refresh_token || this.connection.refreshToken;
      this.connection.tokenExpiresAt = new Date(
        Date.now() + (tokenData.expires_in || 3600) * 1000
      );
      this.connection.lastRefreshedAt = new Date();
      this.connection.status = 'active';
      await this.connection.save();

      // Re-hydrate the SDK client with new tokens
      this.oauthClient.setToken(tokenData);
    }
  }

  // ---------- Low-level API call ----------

  /**
   * Execute an API call against QBO with automatic token refresh,
   * rate-limit tracking, and 429 retry with exponential backoff.
   */
  async apiCall(method, endpoint, body, _retryCount = 0) {
    await this.ensureFreshToken();

    const url = `${this.apiBase}/${endpoint}`;

    // Respect an active rate-limit wait
    const now = Date.now();
    if (now < this._retryAfterUntil) {
      await this._sleep(this._retryAfterUntil - now);
    }

    // Track requests in rolling window
    this._requestLog.push(Date.now());
    this._requestLog = this._requestLog.filter(t => t > Date.now() - this._windowMs);

    const opts = {
      url,
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);

    let response;
    try {
      response = await this.oauthClient.makeApiCall(opts);
    } catch (err) {
      const status =
        err.authResponse?.response?.status || err.statusCode || 'unknown';

      // 429 – rate limited: back off and retry
      if (status === 429) {
        const retryAfter = parseInt(
          err.authResponse?.response?.headers?.['retry-after'] || '30',
          10
        );
        const backoff = retryAfter * 1000 * Math.pow(2, _retryCount);
        this._retryAfterUntil = Date.now() + backoff;
        await this._sleep(backoff);
        return this.apiCall(method, endpoint, body, _retryCount + 1);
      }

      throw err;
    }

    // Parse response — same fallback chain as Phase 0
    let parsed;
    try {
      parsed = typeof response.getJson === 'function' ? response.getJson() : null;
    } catch (_) { /* ignore */ }
    if (!parsed) {
      parsed = response.json || JSON.parse(response.body || '{}');
    }

    return parsed;
  }

  // ---------- Convenience methods ----------

  async create(entity, data) {
    return this.apiCall('POST', entity, data);
  }

  async read(entity, id) {
    return this.apiCall('GET', `${entity}/${id}`);
  }

  async query(queryStr) {
    const encoded = encodeURIComponent(queryStr);
    return this.apiCall('GET', `query?query=${encoded}`);
  }

  async update(entity, data) {
    return this.apiCall('POST', entity, data);
  }

  /**
   * Return the number of requests in the current rolling window.
   */
  getRequestCount() {
    return this._requestLog.length;
  }

  // ---------- Internal helpers ----------

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Factory – create a QBOClient from a Connection id or document.
 */
async function createQBOClient(connectionOrId) {
  let connection = connectionOrId;
  if (typeof connectionOrId === 'string' || connectionOrId.constructor?.name === 'ObjectId') {
    connection = await Connection.findById(connectionOrId);
    if (!connection) throw new Error('Connection not found');
  }
  if (connection.status === 'revoked') {
    throw new Error('Connection has been revoked');
  }
  return new QBOClient(connection);
}

module.exports = { QBOClient, createQBOClient };
