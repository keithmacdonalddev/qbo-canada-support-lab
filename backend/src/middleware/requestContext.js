'use strict'

const { randomUUID } = require('crypto')

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function requestContext(req, res, next) {
  const supplied = req.get('x-request-id')
  const requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID()
  req.context = { ...(req.context || {}), requestId }
  res.set('X-Request-Id', requestId)
  next()
}

module.exports = { requestContext, REQUEST_ID_PATTERN }
