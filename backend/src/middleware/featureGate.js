'use strict'

const config = require('../config')

function getFlag(pathName, source = config.features) {
  return pathName.split('.').reduce((value, segment) => value && value[segment], source)
}

function requireFeatureFlag(pathName, options = {}) {
  const source = options.source || config.features
  return (req, res, next) => {
    if (getFlag(pathName, source) === true) return next()
    return res.status(403).json({
      success: false,
      error: {
        code: 'FEATURE_DISABLED',
        message: options.message || 'This experimental feature is disabled by server policy',
      },
      requestId: req.context?.requestId || null,
    })
  }
}

function publicFeatureFlags(source = config.features) {
  return {
    rebuildReadOnly: source.rebuildReadOnly,
    experimental: {
      aiMutations: source.experimental.aiMutations,
      issuePackMutations: source.experimental.issuePackMutations,
    },
  }
}

module.exports = { getFlag, requireFeatureFlag, publicFeatureFlags }
