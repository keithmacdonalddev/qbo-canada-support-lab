const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * authenticate – verifies JWT from Authorization Bearer header.
 * Attaches { id, email, role } to req.user.
 */
function authenticate(req, res, next) {
  // The application current-account guard validates database authority before
  // any protected route. Reuse it on personal routes too, never restore token roles.
  if (req.currentAccount) {
    if (!req.user?.scopeResolved) req.user = { ...req.currentAccount };
    else if (req.user.actorId !== req.currentAccount.id) return res.status(401).json({ error: 'Account scope changed' });
    return next();
  }
  // Standalone route fixtures may verify JWTs without the application guard.
  // Already verified by companyScope, which may have set req.user.id to the
  // shared company's workspace owner. Only server middleware sets req.user.
  if (req.user && req.user.scopeResolved) return next();

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.user = { id: decoded.id, email: decoded.email, role: decoded.role, authVersion: decoded.av ?? 0 };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * requireRole – middleware factory that restricts access to the given roles.
 * Must be used after authenticate.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
