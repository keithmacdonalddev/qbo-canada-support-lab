'use strict'

const config = require('../config')
const Connection = require('../models/Connection')
const CompanyMembership = require('../models/CompanyMembership')
const { resolvePermissionSnapshot } = require('./rebuild-permissions')

async function findActiveConnection(userId) {
  return Connection.findOne({ userId, status: 'active' })
    .sort({ updatedAt: -1 })
    .select('realmId companyName status lastRefreshedAt updatedAt')
    .lean()
}

async function findActiveMembership(userId, realmId) {
  return CompanyMembership.findOne({ userId, realmId, status: 'active' })
    .select('role permissionOverrides status updatedAt')
    .lean()
}

function createContextService(dependencies = {}) {
  const connectionLookup = dependencies.findActiveConnection || findActiveConnection
  const membershipLookup = dependencies.findActiveMembership || findActiveMembership
  const environment = dependencies.environment || config.qbo.environment

  return {
    async resolve(user) {
      const connection = await connectionLookup(user.id)
      const membership = connection
        // A member of a shared company has the owner's connection but its own role.
        ? await membershipLookup(user.actorId || user.id, connection.realmId)
        : null
      const permissionSnapshot = resolvePermissionSnapshot({
        membership,
        legacyRole: user.role,
      })

      return {
        environment,
        connection: connection
          ? {
              connected: true,
              connectionId: connection._id ? String(connection._id) : null,
              realmId: connection.realmId,
              companyName: connection.companyName || null,
              status: connection.status,
              lastRefreshedAt: connection.lastRefreshedAt || null,
              contextUpdatedAt: connection.updatedAt || null,
            }
          : {
              connected: false,
              connectionId: null,
              realmId: null,
              companyName: null,
              status: 'disconnected',
              lastRefreshedAt: null,
              contextUpdatedAt: null,
            },
        membership: {
          role: permissionSnapshot.role,
          permissions: permissionSnapshot.permissions,
          source: permissionSnapshot.source,
        },
      }
    },
  }
}

module.exports = { createContextService }
