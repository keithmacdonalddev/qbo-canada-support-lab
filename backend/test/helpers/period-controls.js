'use strict';
const { hash } = require('../../src/modules/business-calendar');
function controls(scope, ownerId, now, closedThrough = null, reconciledThrough = null) {
  const value = { version: 1, status: 'owner-recorded', scope, ownerId, closedThrough, reconciledThrough, evidenceNote: 'Fixture owner reviewed protected accounting dates.', recordedAt: new Date(now).toISOString() };
  return { ...value, contentHash: hash(value) };
}
module.exports = { controls };
