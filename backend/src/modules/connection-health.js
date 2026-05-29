/**
 * connection-health -- shared helpers for reporting QBO connection/token health.
 *
 * Two distinct tokens drive QBO connectivity and they have very different
 * lifecycles. Conflating them is the root of the misleading dashboard:
 *
 *   - access token  : short-lived (~60 min). Refreshed automatically on demand
 *                     by qbo-client.ensureFreshToken(). An expired access token
 *                     is normal and self-healing -- it does NOT mean the
 *                     connection is broken.
 *   - refresh token : long-lived (~100 days, rolling). When this expires the
 *                     user MUST re-run OAuth. This is the real "is my
 *                     connection alive" signal, surfaced by Intuit as
 *                     x_refresh_token_expires_in on token responses.
 *
 * "Connected"/"usable" is therefore defined by the refresh token, not the
 * access token.
 */

const MS_PER_MIN = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MIN;

/**
 * Derive a connection's health from its STORED token timestamps only (no QBO
 * call). Used by both /qbo/status and /company/health so the header and the
 * dashboard share one definition of "connected".
 *
 * @param {object} connection - Mongoose Connection document
 * @param {Date} [now] - injectable clock for testing
 * @returns {{
 *   effectiveStatus: string,
 *   usable: boolean,
 *   accessTokenValid: boolean,
 *   accessTokenExpiresInMinutes: number|null,
 *   refreshTokenValid: boolean,
 *   refreshTokenExpiresAt: Date|null,
 *   refreshTokenExpiresInDays: number|null,
 * }}
 */
function deriveTokenHealth(connection, now = new Date()) {
  const nowMs = now.getTime();

  const accessExpMs = connection.tokenExpiresAt
    ? connection.tokenExpiresAt.getTime() - nowMs
    : null;
  const accessTokenValid = accessExpMs != null && accessExpMs > 0;
  const accessTokenExpiresInMinutes =
    accessExpMs != null ? Math.round(accessExpMs / MS_PER_MIN) : null;

  const refreshExpMs = connection.refreshTokenExpiresAt
    ? connection.refreshTokenExpiresAt.getTime() - nowMs
    : null;
  // Legacy connections created before refresh-token tracking have no
  // refreshTokenExpiresAt. Treat unknown as valid so we don't falsely report
  // an established connection as expired.
  const refreshTokenValid = refreshExpMs == null ? true : refreshExpMs > 0;
  const refreshTokenExpiresInDays =
    refreshExpMs != null ? Math.floor(refreshExpMs / MS_PER_DAY) : null;

  // A connection is usable only if it is active AND its refresh token is still
  // valid. The access token's expiry is intentionally NOT a factor here.
  let effectiveStatus = connection.status;
  if (effectiveStatus === 'active' && !refreshTokenValid) {
    effectiveStatus = 'expired';
  }
  const usable = effectiveStatus === 'active';

  return {
    effectiveStatus,
    usable,
    accessTokenValid,
    accessTokenExpiresInMinutes,
    refreshTokenValid,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt || null,
    refreshTokenExpiresInDays,
  };
}

/**
 * Compute the refresh-token expiry Date from an Intuit token response's
 * x_refresh_token_expires_in (seconds). Falls back to ~100 days when the field
 * is absent so a connection always has a reasonable expiry estimate.
 *
 * @param {object} tokenData - parsed token response
 * @param {Date} [now]
 * @returns {Date}
 */
function refreshTokenExpiryFrom(tokenData, now = new Date()) {
  const DEFAULT_REFRESH_TTL_SEC = 100 * 24 * 60 * 60; // 100 days
  const ttl = Number(tokenData && tokenData.x_refresh_token_expires_in) || DEFAULT_REFRESH_TTL_SEC;
  return new Date(now.getTime() + ttl * 1000);
}

/**
 * Best-effort classification of a failed live probe: did the refresh token /
 * authorization get rejected (user must re-connect), or was it a transient
 * upstream hiccup (network/5xx/429) we should not treat as disconnected?
 *
 * Conservative on purpose: only returns true when the signal clearly points at
 * an auth/refresh failure. Anything ambiguous is treated as transient so we
 * never falsely tell the user to re-authorize.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isAuthFailure(err) {
  if (!err) return false;
  const status = err.status;
  if (status === 400 || status === 401 || status === 403) return true;

  // Load-bearing fallback: intuit-oauth@4.2.2 throws an expired-refresh-token
  // error with NO err.status (the HTTP 400 is dropped during error wrapping) but
  // with err.error/err.message/err.authResponse.json.error === 'invalid_grant'.
  // Match only unambiguous OAuth refresh-token rejection markers here — do NOT
  // add a bare "unauthorized" substring, which a transient 5xx body could
  // contain and would then falsely force a reconnect.
  const haystack = [
    err.message,
    err.error,
    err.error_description,
    err.originalMessage,
    err.authResponse && err.authResponse.json && err.authResponse.json.error,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /invalid_grant|invalid_token|refresh token/.test(haystack);
}

module.exports = { deriveTokenHealth, refreshTokenExpiryFrom, isAuthFailure };
