'use strict';

const User = require('../models/User');
const { createContextService } = require('../modules/rebuild-context');

// Route authorization is based on the acting member, never the shared workspace
// owner's JWT role. The legacy bridge intentionally grants read access only.
function createCompanyPermissionGuard(permission, dependencies = {}) {
  const context = dependencies.context || createContextService();
  const findActor = dependencies.findActor || (id => User.findById(id).select('role').lean());
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    try {
      const actor = await findActor(req.user.actorId || req.user.id);
      if (!actor || !['agent', 'supervisor'].includes(actor.role)) {
        return res.status(403).json({ error: 'Your account can no longer perform company actions.', code: 'COMPANY_PERMISSION_REQUIRED' });
      }
      const current = await context.resolve(req.user);
      if (!current.connection?.connected) return res.status(409).json({ error: 'Connect a company before performing this action.' });
      if (!current.membership.permissions.includes(permission)) {
        return res.status(403).json({ error: 'Your current company role cannot perform this action. The company owner can review business access and setup on the Company page.', code: 'COMPANY_PERMISSION_REQUIRED' });
      }
      req.companyContext = current;
      return next();
    } catch {
      return res.status(503).json({ error: 'Company permissions could not be verified. Nothing was changed.' });
    }
  };
}

module.exports = { createCompanyPermissionGuard };
