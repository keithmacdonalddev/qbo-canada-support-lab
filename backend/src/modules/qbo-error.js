/**
 * QBO upstream error mapping helper.
 *
 * The QBO client (`qbo-client.js`) now THROWS on QBO HTTP errors, attaching:
 *   - err.status      numeric QBO HTTP status (e.g. 400/401/429/5xx)
 *   - err.intuit_tid  Intuit trace id (when present)
 *   - err.message     "QBO API error (HTTP <status>): <Fault message>"
 *
 * Route handlers must surface these as a meaningful, traceable HTTP error
 * instead of a generic 500. They must NOT propagate a QBO-side 401 as an
 * app-level 401: the frontend API client treats ANY 401 as "app session
 * expired" and force-logs-out the user. A bad QBO token is not an app-session
 * failure, so QBO upstream errors are mapped to HTTP 502 (Bad Gateway).
 *
 * The app's OWN auth 401 (from the authenticate middleware) is produced before
 * these handlers run and is never touched here.
 */

/**
 * Detect whether an error originated from the QBO client (an upstream QBO
 * HTTP error or a QBO network failure with a trace id), as opposed to an
 * ordinary application/database error.
 *
 * Signals (any one is sufficient):
 *   - message matches the QBO client's "QBO API error (HTTP <n>)" envelope
 *   - an Intuit trace id is attached (err.intuit_tid)
 *   - a numeric err.status is attached (QBO client sets this on thrown HTTP
 *     errors; ordinary app errors do not attach a numeric status here)
 *
 * @param {*} err
 * @returns {boolean}
 */
function isQboError(err) {
  if (!err) return false;
  if (typeof err.message === 'string' && /^QBO API error \(HTTP \d+\)/.test(err.message)) {
    return true;
  }
  if (err.intuit_tid) return true;
  if (typeof err.status === 'number') return true;
  return false;
}

/**
 * If `err` is a QBO upstream error, write a 502 response and return true.
 * Otherwise return false so the caller can fall back to its existing
 * (non-QBO) error handling.
 *
 * Response body always includes a string `error` field (backward-compatible
 * with the frontend's `err.response?.data?.error`), plus `intuit_tid` and
 * `qboStatus` for support tracing.
 *
 * QBO 429 (rate limit) is passed through as HTTP 429 so callers/clients can
 * distinguish throttling from a generic gateway error; all other QBO upstream
 * statuses (including QBO 401) map to 502.
 *
 * @param {import('express').Response} res
 * @param {*} err
 * @returns {boolean} true if a QBO error response was sent
 */
function respondQboError(res, err) {
  if (!isQboError(err)) return false;

  const httpStatus = err.status === 429 ? 429 : 502;

  res.status(httpStatus).json({
    error: err.message || 'QBO API error',
    intuit_tid: err.intuit_tid || null,
    qboStatus: typeof err.status === 'number' ? err.status : null,
  });
  return true;
}

module.exports = { isQboError, respondQboError };
