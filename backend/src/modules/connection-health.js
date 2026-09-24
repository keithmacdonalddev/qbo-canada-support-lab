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
 *   - refresh token : provider-limited authorization. Its reported remaining
 *                     lifetime is surfaced by Intuit as
 *                     x_refresh_token_expires_in on token responses. The user
 *                     may need to reconnect when that expires or is revoked.
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
 * Compute the reported refresh-token expiry. Missing or invalid provider data
 * is unknown, not a made-up deadline that could falsely force a reconnect.
 *
 * @param {object} tokenData - parsed token response
 * @param {Date} [now]
 * @returns {Date|null}
 */
function refreshTokenExpiryFrom(tokenData, now = new Date()) {
  const ttl = Number(tokenData?.x_refresh_token_expires_in);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
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
  // API 400/401/403 can describe query permission or a temporary upstream
  // problem. Only an explicit rejection during the refresh step proves that
  // the saved authorization needs replacing.
  if (err.qboStage !== 'refresh') return false;

  // Load-bearing fallback: intuit-oauth@4.2.2 throws an expired-refresh-token
  // error with NO err.status (the HTTP 400 is dropped during error wrapping) but
  // with err.error/err.message/err.authResponse.json.error === 'invalid_grant'.
  // Match only unambiguous refresh-token rejection markers here — do NOT
  // add a bare "unauthorized" substring, which a transient 5xx body could
  // contain and would then falsely force a reconnect.
  const haystack = [
    err.message,
    err.error,
    err.error_description,
    err.description,
    err.originalMessage,
    err.authResponse && err.authResponse.json && err.authResponse.json.error,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /invalid_grant|refresh token (?:is )?(?:expired|revoked|invalid)/.test(haystack);
}

async function expireRejectedConnection(connection, err, userId, createAuditEntry) {
  if (!isAuthFailure(err) || connection.status !== 'active') return false;
  // The audit helper returns null on failure. Record the observed rejection
  // first so a failed audit cannot leave an unaudited status mutation.
  const audit = await createAuditEntry(userId, connection.realmId, 'QBO authorization rejected', {
    actionType: 'connection', outcome: 'failure',
    beforeState: { status: 'active' },
  });
  if (!audit) throw new Error('Could not audit QBO authorization rejection');
  const Connection = require('../models/Connection');
  // A newer OAuth grant or concurrent refresh may have replaced this token.
  // Do not expire the replacement because an older attempt was rejected.
  const changed = await Connection.findOneAndUpdate(
    { _id: connection._id, userId, status: 'active', refreshToken: connection.refreshToken },
    { $set: { status: 'expired' } },
    { new: true },
  );
  if (!changed) return false;
  connection.status = 'expired';
  return true;
}

function describeProbeFailure(err) {
  const status = Number(err?.status ?? err?.authResponse?.response?.status ?? err?.code);
  let code = 'QBO_VERIFICATION_FAILED';
  let message = 'QuickBooks could not verify the saved connection. Retry the check.';
  if (isAuthFailure(err)) {
    code = 'QBO_RECONNECT_REQUIRED';
    message = 'QuickBooks rejected the saved authorization. Reconnect your company.';
  } else if (status === 429) {
    code = 'QBO_RATE_LIMITED';
    message = 'QuickBooks is limiting requests. Retry in a few minutes.';
  } else if (err?.qboStage === 'storage_save') {
    code = 'QBO_TOKEN_SAVE_FAILED';
    message = 'QuickBooks token storage failed. Retry while the app stays open.';
  } else if (err?.qboStage === 'storage_read') {
    code = 'QBO_STORAGE_UNAVAILABLE';
    message = 'The app could not read the saved QuickBooks connection. Check the database connection and retry.';
  } else if (err?.qboStage === 'conflict') {
    code = 'QBO_CONNECTION_CHANGED';
    message = 'The saved QuickBooks connection changed during verification. Check again.';
  } else if (err?.qboStage === 'refresh' || err?.qboStage === 'refresh_response') {
    code = 'QBO_REFRESH_UNAVAILABLE';
    message = 'QuickBooks could not refresh the saved connection. Retry the check.';
  } else if (status === 401 || status === 403) {
    code = 'QBO_PERMISSION_ERROR';
    message = 'QuickBooks rejected the verification request. Retry; reconnect if it continues.';
  } else if (status >= 500) {
    code = 'QBO_UNAVAILABLE';
    message = 'QuickBooks is unavailable. Your saved connection has been kept.';
  }
  const traceId = err?.intuit_tid || err?.intuitTid;
  const intuitTid = typeof traceId === 'string' && /^[a-z0-9._-]{1,128}$/i.test(traceId)
    ? traceId : null;
  return { code, message, qboStatus: Number.isInteger(status) && status >= 100 ? status : null, intuit_tid: intuitTid };
}

function describeRefreshFailure(err) {
  const status = Number(err?.status ?? err?.authResponse?.response?.status ?? err?.code);
  const qboStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const traceId = err?.intuit_tid || err?.intuitTid;
  const intuitTid = typeof traceId === 'string' && /^[a-z0-9._-]{1,128}$/i.test(traceId)
    ? traceId : null;
  let httpStatus = 502;
  let code = 'QBO_REFRESH_UNAVAILABLE';
  let message = 'QuickBooks could not refresh the saved connection. Check the local API log, then retry.';
  if (err?.qboStage === 'storage_save') {
    httpStatus = 503;
    code = 'QBO_TOKEN_SAVE_FAILED';
    message = 'QuickBooks issued new tokens, but the app could not save them. Keep the API running and try again.';
  } else if (err?.qboStage === 'storage_read') {
    httpStatus = 503;
    code = 'QBO_STORAGE_UNAVAILABLE';
    message = 'The app could not read the saved QuickBooks connection. No refresh request was sent. Check the database connection and retry.';
  } else if (err?.qboStage === 'conflict') {
    httpStatus = 409;
    code = 'QBO_CONNECTION_CHANGED';
    message = 'The saved QuickBooks connection changed during refresh. Reload its status before trying again.';
  } else if (qboStatus === 429) {
    httpStatus = 429;
    code = 'QBO_RATE_LIMITED';
    message = 'QuickBooks is limiting token requests. Wait a few minutes, then try again.';
  } else if (qboStatus === 400) {
    code = 'QBO_REFRESH_REJECTED';
    message = 'QuickBooks rejected the refresh request (HTTP 400). The saved connection was kept; check the local API log for the reason.';
  } else if (qboStatus === 401 || qboStatus === 403) {
    code = 'QBO_REFRESH_DENIED';
    message = `QuickBooks denied the refresh request (HTTP ${qboStatus}). The saved connection was kept; check the local API log.`;
  } else if (qboStatus && qboStatus >= 500) {
    code = 'QBO_UNAVAILABLE';
    message = `QuickBooks returned HTTP ${qboStatus}. The saved connection was kept; retry later.`;
  } else if (/\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network error)\b|timeout of \d+ms exceeded/i.test(
    [err?.code, err?.originalMessage].filter(Boolean).join(' '),
  )) {
    code = 'QBO_NETWORK_ERROR';
    message = 'The app could not reach QuickBooks. Check the network and try again.';
  } else if (err?.qboStage === 'refresh_response') {
    code = 'QBO_REFRESH_RESPONSE_INVALID';
    message = 'QuickBooks returned an incomplete refresh response. Check the local API log before retrying.';
  }
  return { httpStatus, code, message, qboStatus, intuit_tid: intuitTid };
}

module.exports = {
  deriveTokenHealth, refreshTokenExpiryFrom, isAuthFailure,
  expireRejectedConnection, describeProbeFailure, describeRefreshFailure,
};
