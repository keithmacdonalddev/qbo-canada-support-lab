const { redactLogSecrets } = require('../modules/log-diagnostic');

function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  const area = /^\/api\/(auth|qbo|company|seed|audit|generate|checkpoint|explore|issuepacks|ai|health|context)(?:\/|\?|$)/.exec(req.originalUrl || '')?.[1] || 'other';
  const requestId = req.context?.requestId || null;
  const safeTypes = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'ValidationError', 'CastError', 'MongoServerSelectionError', 'MongoNetworkError', 'OAuthError']);
  const errorType = safeTypes.has(err.name) ? err.name : 'Error';
  // Always include a stable reference, then the full error text and stack in
  // development. Credential-shaped values remain redacted.
  console.error(`[api/unhandled] area=${area} status=${statusCode} type=${errorType}${requestId ? ` ref=${requestId}` : ''}`);
  if (process.env.NODE_ENV !== 'production') console.error(redactLogSecrets(err.stack || err.message || err));

  const response = {
    status: 'error',
    statusCode,
    message,
    requestId,
  };

  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = errorHandler;
