'use strict'

function validateBlueprintDefinition(definition) {
  const errors = []
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return { valid: false, errors: [{ path: '/', message: 'Blueprint definition must be an object' }] }
  }

  const identity = definition.publicSafeIdentity
  if (!identity || typeof identity !== 'object') {
    errors.push({ path: '/publicSafeIdentity', message: 'Public-safe identity is required' })
  } else {
    for (const field of ['displayName', 'homeProvince', 'locale', 'baseCurrency']) {
      if (typeof identity[field] !== 'string' || identity[field].trim() === '') {
        errors.push({ path: `/publicSafeIdentity/${field}`, message: `${field} is required` })
      }
    }
    if (identity.locale && identity.locale !== 'CA') {
      errors.push({ path: '/publicSafeIdentity/locale', message: 'The rebuild target locale must remain CA' })
    }
    if (identity.baseCurrency && identity.baseCurrency !== 'CAD') {
      errors.push({ path: '/publicSafeIdentity/baseCurrency', message: 'The rebuild base currency must remain CAD until a separate decision' })
    }
  }

  if (!definition.calendar || !Number.isInteger(definition.calendar.historicalMonths) || definition.calendar.historicalMonths < 1) {
    errors.push({ path: '/calendar/historicalMonths', message: 'historicalMonths must be a positive integer' })
  }
  if (!Array.isArray(definition.divisions) || definition.divisions.length === 0) {
    errors.push({ path: '/divisions', message: 'At least one operating division is required' })
  }
  if (!Array.isArray(definition.realismRules) || definition.realismRules.length === 0) {
    errors.push({ path: '/realismRules', message: 'At least one realism rule is required' })
  }

  return { valid: errors.length === 0, errors }
}

module.exports = { validateBlueprintDefinition }
