'use strict';

// Shared company access.
//
// A company's data in this app (cases, plans, coverage, company profile, audit
// history) belongs to the account that holds its active QuickBooks connection,
// the workspace owner. Another account can work in that company only through
// an active CompanyMembership for its realm. Such a request runs inside the
// owner's workspace: req.user.id becomes the owner, req.user.actorId stays the
// signed-in account, and audit entries record that account as the actor.
//
// An account with its own active connection always works in its own workspace.
// Connecting, reconnecting and disconnecting QuickBooks are never shared; this
// middleware is not mounted on those routes.

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const config = require('../config');
const Connection = require('../models/Connection');
const CompanyMembership = require('../models/CompanyMembership');
const { runAsActor } = require('../modules/actor-context');

const defaultLookups = {
  // Without a database there is nothing to share; routes report that themselves.
  databaseReady: () => mongoose.connection.readyState === 1,
  hasOwnActiveConnection: async (userId) => Boolean(await Connection.exists({ userId, status: 'active' })),
  memberRealms: (userId) => CompanyMembership.find({ userId, status: 'active' }).distinct('realmId'),
  activeConnectionFor: (realmIds) => Connection.findOne({ realmId: { $in: realmIds }, status: 'active' })
    .sort({ updatedAt: -1 })
    .select('userId realmId')
    .lean(),
};

/**
 * The account whose workspace `actorId` works in: itself, unless it has no
 * active connection of its own and is an active member of a company that does.
 */
async function findWorkspaceOwner(actorId, lookups = defaultLookups) {
  const actor = String(actorId);
  if (lookups.databaseReady && !lookups.databaseReady()) return actor;
  if (await lookups.hasOwnActiveConnection(actor)) return actor;
  const realms = await lookups.memberRealms(actor);
  if (!realms.length) return actor;
  const shared = await lookups.activeConnectionFor(realms);
  return shared ? String(shared.userId) : actor;
}

function createCompanyScope(lookups = defaultLookups) {
  return async function companyScope(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return next();
    let decoded;
    try {
      decoded = jwt.verify(header.slice(7), config.jwtSecret);
    } catch {
      // The route's own authenticate answers with the usual 401.
      return next();
    }

    let ownerId;
    try {
      ownerId = await findWorkspaceOwner(decoded.id, lookups);
    } catch (err) {
      return next(err);
    }

    const actorId = String(decoded.id);
    req.user = {
      id: ownerId,
      email: decoded.email,
      role: decoded.role,
      actorId,
      sharedCompany: ownerId !== actorId,
      scopeResolved: true,
    };
    return runAsActor(actorId, next);
  };
}

module.exports = { createCompanyScope, findWorkspaceOwner, companyScope: createCompanyScope() };
