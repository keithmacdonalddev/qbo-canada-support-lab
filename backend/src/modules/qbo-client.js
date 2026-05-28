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

    // intuit_tid from the most recent successful API call (support tracing)
    this._lastIntuitTid = '';
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
   *
   * IMPORTANT: intuit-oauth@4.2.x is axios-based. makeApiCall() RESOLVES on
   * HTTP error statuses (401/4xx/5xx/429) instead of throwing, returning a
   * plain object { status, statusText, headers, json, body }. Error handling
   * is therefore status-based, not catch-based. A try/catch is still kept for
   * genuine thrown exceptions (network errors; refresh() inside
   * ensureFreshToken can also throw).
   */
  async apiCall(method, endpoint, body, _retryCount = 0) {
    const MAX_RETRIES = 5;

    const url = `${this.apiBase}/${endpoint}`;

    let response;
    try {
      await this.ensureFreshToken();

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

      response = await this.oauthClient.makeApiCall(opts);
    } catch (err) {
      // Genuinely thrown exception: network failure, or refresh() rejecting
      // inside ensureFreshToken(). Extract a tid where one is present, log,
      // and rethrow. Do not log tokens, auth headers, or full bodies.
      const status =
        err.authResponse?.response?.status || err.statusCode || err.status || 'unknown';
      const intuitTid = this._extractIntuitTid(
        err.authResponse?.response?.headers,
        err.intuitTid || err.intuit_tid
      );

      console.error('[qbo-client] API call failed', {
        method,
        endpoint,
        status,
        intuit_tid: intuitTid || 'unknown',
      });

      if (intuitTid && !err.intuit_tid) {
        err.intuit_tid = intuitTid;
      }
      throw err;
    }

    // makeApiCall resolved. Inspect the HTTP status to decide success vs error.
    // axios lowercases header keys, so intuit_tid lives at headers.intuit_tid.
    const headers =
      (typeof response.headers === 'function' ? response.headers() : response.headers) ||
      response.response?.headers;
    const status = response.status;
    const intuitTid = this._extractIntuitTid(headers, response.intuit_tid);

    // ---- 429: rate limited -> existing backoff/retry mechanism ----
    if (status === 429) {
      if (_retryCount >= MAX_RETRIES) {
        const err = new Error(
          `QBO API rate limit exceeded after ${MAX_RETRIES} retries (HTTP 429)`
        );
        err.status = 429;
        if (intuitTid) err.intuit_tid = intuitTid;
        console.error('[qbo-client] API call failed', {
          method,
          endpoint,
          status: 429,
          intuit_tid: intuitTid || 'unknown',
        });
        throw err;
      }

      // Read retry-after case-insensitively (default 30s), apply exponential
      // backoff, set the shared wait window, sleep, and retry.
      const retryAfterRaw =
        (headers &&
          (headers['retry-after'] ||
            headers['Retry-After'] ||
            headers['retry-After'])) ||
        '30';
      const retryAfter = parseInt(retryAfterRaw, 10) || 30;
      const backoff = retryAfter * 1000 * Math.pow(2, _retryCount);
      this._retryAfterUntil = Date.now() + backoff;
      await this._sleep(backoff);
      return this.apiCall(method, endpoint, body, _retryCount + 1);
    }

    // ---- Other 4xx/5xx: throw a meaningful, traceable error ----
    if (typeof status === 'number' && status >= 400) {
      // Parse the body just enough to surface the QBO Fault message(s). Never
      // log or attach the full body (may contain company/customer data).
      const faultMessage = this._extractFaultMessage(response);
      const err = new Error(
        `QBO API error (HTTP ${status})${faultMessage ? `: ${faultMessage}` : ''}`
      );
      err.status = status;
      if (intuitTid) err.intuit_tid = intuitTid;

      console.error('[qbo-client] API call failed', {
        method,
        endpoint,
        status,
        intuit_tid: intuitTid || 'unknown',
      });

      throw err;
    }

    // ---- 2xx (or status absent, defensively): parse and return the body ----
    // Same fallback chain as Phase 0 (prefer .json, then JSON.parse(.body)).
    let parsed;
    try {
      parsed = typeof response.getJson === 'function' ? response.getJson() : null;
    } catch (_) { /* ignore */ }
    if (!parsed) {
      parsed = response.json || JSON.parse(response.body || '{}');
    }

    // Capture the intuit_tid for support tracing. Do NOT log on the success
    // path (avoid spam). Reuse the tid already extracted above.
    let successTid = intuitTid;
    if (!successTid) {
      try {
        successTid =
          (typeof response.getIntuitTid === 'function' ? response.getIntuitTid() : '') ||
          response.intuit_tid ||
          '';
      } catch (_) { /* ignore */ }
    }
    this._lastIntuitTid = successTid || '';

    return parsed;
  }

  /**
   * Pull the QBO Fault error message(s) out of a resolved error response so a
   * failed call surfaces a meaningful reason. Reads defensively (json or body)
   * and joins multiple Fault errors. Returns '' if none found. The full body
   * is never logged or returned — only the human-readable message text.
   * @param {object} response - resolved makeApiCall response object
   * @returns {string}
   */
  _extractFaultMessage(response) {
    let payload = response && response.json;
    if (!payload && response && response.body) {
      try {
        payload = JSON.parse(response.body);
      } catch (_) {
        return '';
      }
    }
    if (!payload || typeof payload !== 'object') return '';

    // QBO error envelope: { Fault: { Error: [{ Message, Detail, code }] } }
    const fault = payload.Fault || payload.fault;
    const errors = fault && (fault.Error || fault.error);
    if (Array.isArray(errors) && errors.length) {
      const msgs = errors
        .map(e => e && (e.Message || e.message || e.Detail || e.detail))
        .filter(Boolean);
      if (msgs.length) return msgs.join('; ');
    }
    return '';
  }

  /**
   * Extract the intuit_tid value from a headers object case-insensitively,
   * falling back to an already-extracted value. Returns '' if not found.
   * @param {object} [headers] - response headers object
   * @param {string} [fallback] - tid already pulled off an error object
   * @returns {string}
   */
  _extractIntuitTid(headers, fallback) {
    if (headers && typeof headers === 'object') {
      const direct =
        headers.intuit_tid ||
        headers.Intuit_Tid ||
        headers.intuit_TID ||
        headers.INTUIT_TID;
      if (direct) return String(direct);

      // Case-insensitive scan as a last resort
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'intuit_tid') {
          return String(headers[key]);
        }
      }
    }
    return fallback ? String(fallback) : '';
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

  /**
   * Return the intuit_tid from the most recent successful API call, or '' if
   * none was captured. Useful for support tracing and troubleshooting logs.
   */
  getLastIntuitTid() {
    return this._lastIntuitTid;
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
