'use strict';
const { hash } = require('../../src/modules/business-calendar');
const { freezeWriteRequest } = require('../../src/modules/qbo-write-contract');
module.exports = function dispatchFixture(scope, intent, marker, recordFor) {
  const request = freezeWriteRequest(scope, 'POST', intent.entity.toLowerCase(), { PrivateNote: marker });
  const artifact = { version: 1, logicalKey: intent.logicalKey, entity: intent.entity, intentHash: intent.fingerprint, request, evidenceHash: hash('fresh observations'), relationships: intent.dependencies.map(link => { const row = recordFor(link.logicalKey); return { ...link, qboId: row?.qboId || '100', syncToken: row?.verification?.syncToken || '0', kind: 'prerequisite', links: [] }; }) };
  return { artifact, compilationHash: hash(artifact), requestHash: request.requestHash, intentHash: artifact.intentHash, evidenceHash: artifact.evidenceHash };
};
