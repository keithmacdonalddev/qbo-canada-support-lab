'use strict'

const ROLE_PERMISSIONS = Object.freeze({
  'lab-owner': Object.freeze([
    'company.read',
    'blueprint.read',
    'blueprint.manage',
    'coverage.read',
    'coverage.approve',
    'reports.read',
    'reports.validate',
    'qbo_data.read',
    'operations.preview',
    'schedule.read',
    'reconciliation.read',
    'app_data.read',
    'users.read',
    'connections.read',
    'audit.read',
  ]),
  operator: Object.freeze([
    'company.read',
    'blueprint.read',
    'coverage.read',
    'reports.read',
    'qbo_data.read',
    'operations.preview',
    'schedule.read',
    'reconciliation.read',
    'app_data.read',
  ]),
  'support-agent': Object.freeze([
    'company.read',
    'blueprint.read',
    'coverage.read',
    'reports.read',
    'qbo_data.read',
    'schedule.read',
    'reconciliation.read',
    'app_data.read',
  ]),
  reviewer: Object.freeze([
    'company.read',
    'blueprint.read',
    'coverage.read',
    'reports.read',
    'schedule.read',
    'reconciliation.read',
    'app_data.read',
    'audit.read',
  ]),
})

const LEGACY_ROLE_MAP = Object.freeze({
  supervisor: 'lab-owner',
  agent: 'support-agent',
})

const ALL_PERMISSIONS = Object.freeze(
  [...new Set(Object.values(ROLE_PERMISSIONS).flat())].sort()
)

function normalizePermissions(role, overrides = []) {
  const base = ROLE_PERMISSIONS[role] || []
  return [...new Set([...base, ...overrides])].sort()
}

function mapLegacyRole(role) {
  return LEGACY_ROLE_MAP[role] || 'reviewer'
}

function resolvePermissionSnapshot({ membership, legacyRole }) {
  if (membership) {
    return {
      role: membership.role,
      permissions: normalizePermissions(membership.role, membership.permissionOverrides || []),
      source: 'company-membership',
    }
  }

  const role = mapLegacyRole(legacyRole)
  const readOnlyPermissions = normalizePermissions(role).filter((permission) => permission.endsWith('.read'))
  return {
    role,
    permissions: readOnlyPermissions,
    source: 'legacy-role-bridge',
  }
}

module.exports = {
  ROLE_PERMISSIONS,
  ALL_PERMISSIONS,
  mapLegacyRole,
  normalizePermissions,
  resolvePermissionSnapshot,
}
