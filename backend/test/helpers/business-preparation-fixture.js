'use strict';
const { prepareBusinessOperation } = require('../../src/modules/business-operation-preview');
const { proposalView, MAPPINGS } = require('../../src/modules/blueprint-draft');
const { masterRequirements } = require('../../src/modules/business-master-data');
const { hash } = require('../../src/modules/business-calendar');
const now = new Date('2026-10-06T12:00:00Z');
function fixture() {
  const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) }, proposal = proposalView();
  const draft = { ...proposal, id: 'e'.repeat(24), contentHash: 'b'.repeat(64), connectionMatches: true, masterBindings: {} };
  draft.mappings = Object.fromEntries(Object.keys(MAPPINGS).map((key, index) => [key, String(index + 1)]));
  const setup = { ...scope, observedAt: now.toISOString(), sourceHash: hash('setup'), completeness: { accounts: true, taxCodes: true, preferences: true }, observations: { homeCurrency: 'CAD' }, options: {
    accounts: Object.entries(MAPPINGS).filter(([, value]) => value.entity === 'Account').map(([key, value]) => ({ id: draft.mappings[key], active: true, type: value.types[0], subtype: value.subtypes?.[0] || null, currency: 'CAD', syncToken: '0' })),
    taxCodes: ['salesTax', 'purchaseTax'].map(key => ({ id: draft.mappings[key], active: true, sales: true, purchases: true, syncToken: '0' })),
  } };
  const masters = { ...scope, observedAt: now.toISOString(), sourceHash: hash('masters'), completeness: { Customer: true, Vendor: true, Item: true, Employee: true }, options: { Customer: [], Vendor: [], Item: [], Employee: [] } };
  for (const [index, role] of masterRequirements(proposal.business).entries()) {
    const id = String(index + 100); draft.masterBindings[role.key] = id;
    masters.options[role.entity].push({ id, active: true, currency: 'CAD', project: false, itemType: role.itemType || null, syncToken: '0', accountRefs: Object.fromEntries(Object.entries(role.accountMappings || {}).map(([reference, key]) => [reference, draft.mappings[key]])) });
  }
  const view = { ...scope, draft, proposal };
  const input = { connectionId: scope.connectionId, baseHash: draft.contentHash, fromDate: '2026-10-01', throughDate: '2026-10-06' };
  return { view, input, setup, masters, prepare() { return prepareBusinessOperation(view, input, setup, masters, now); } };
}

module.exports = { fixture, now };
