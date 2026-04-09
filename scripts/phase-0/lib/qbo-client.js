const fs = require('fs');
const OAuthClient = require('intuit-oauth');
const config = require('./config');
const logger = require('./logger');

let oauthClient = null;

function getOAuthClient() {
  if (oauthClient) return oauthClient;

  oauthClient = new OAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    environment: config.environment,
    redirectUri: config.redirectUri,
  });

  // Load saved tokens if they exist
  if (fs.existsSync(config.tokensPath)) {
    const tokens = JSON.parse(fs.readFileSync(config.tokensPath, 'utf-8'));
    oauthClient.setToken(tokens);
  }

  return oauthClient;
}

function saveTokens(tokenData) {
  fs.writeFileSync(config.tokensPath, JSON.stringify(tokenData, null, 2));
  logger.info('tokens', 'Tokens saved');
}

async function ensureFreshToken() {
  const client = getOAuthClient();
  if (!client.isAccessTokenValid()) {
    logger.info('auth', 'Access token expired, refreshing...');
    const response = await client.refresh();
    saveTokens(response.getJson());
    logger.info('auth', 'Token refreshed');
  }
  return client;
}

// Rate limit tracking
let requestLog = [];
const WINDOW_MS = 60_000;
let retryAfterUntil = 0;

async function apiCall(method, endpoint, body) {
  const client = await ensureFreshToken();
  const url = `${config.apiBase}/${endpoint}`;

  // Wait if we hit a rate limit
  const now = Date.now();
  if (now < retryAfterUntil) {
    const waitMs = retryAfterUntil - now;
    logger.info('rate-limit', `Waiting ${waitMs}ms before retry`);
    await sleep(waitMs);
  }

  // Track request rate
  requestLog.push(Date.now());
  requestLog = requestLog.filter(t => t > Date.now() - WINDOW_MS);

  const opts = {
    url,
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const start = Date.now();
  let response;
  try {
    response = await client.makeApiCall(opts);
  } catch (err) {
    const status = err.authResponse?.response?.status || err.statusCode || 'unknown';

    // Rate limited
    if (status === 429) {
      const retryAfter = parseInt(err.authResponse?.response?.headers?.['retry-after'] || '30', 10);
      retryAfterUntil = Date.now() + retryAfter * 1000;
      logger.info('rate-limit', `429 received. Waiting ${retryAfter}s then retrying.`);
      await sleep(retryAfter * 1000);
      return apiCall(method, endpoint, body);
    }

    logger.error('api-error', {
      method,
      endpoint,
      status,
      elapsed: Date.now() - start,
      error: err.message || err.authResponse?.body || String(err),
    });
    throw err;
  }

  const elapsed = Date.now() - start;

  // intuit-oauth AuthResponse: try .getJson(), then .json, then parse .body
  let parsed;
  try {
    parsed = typeof response.getJson === 'function' ? response.getJson() : null;
  } catch {}
  if (!parsed) {
    parsed = response.json || JSON.parse(response.body || '{}');
  }

  logger.info('api-call', { method, endpoint, elapsed, requestsInWindow: requestLog.length });

  return parsed;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Convenience methods
const qbo = {
  getOAuthClient,
  saveTokens,

  async create(entity, data) {
    return apiCall('POST', entity, data);
  },

  async read(entity, id) {
    return apiCall('GET', `${entity}/${id}`);
  },

  async query(queryStr) {
    const encoded = encodeURIComponent(queryStr);
    return apiCall('GET', `query?query=${encoded}`);
  },

  async update(entity, data) {
    return apiCall('POST', entity, data);
  },

  getRequestCount() {
    return requestLog.length;
  },
};

module.exports = qbo;
