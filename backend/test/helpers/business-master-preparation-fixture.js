'use strict';
const { hash } = require('../../src/modules/business-calendar');
const { proposalView, buildDraftDefinition, draftView } = require('../../src/modules/blueprint-draft');
const scope = { realmId: '123', environment: 'production', connectionId: '000000000000000000000001' }, ownerId = '000000000000000000000002', now = Date.parse('2026-10-15T12:00:00.000Z'), stamp = new Date(now).toISOString();
function fixture(options = {}) {
  const initial = proposalView(), input = { requestKey: '00000000-0000-0000-0000-000000000001', connectionId: scope.connectionId, baseHash: null, business: { ...initial.business, displayName: 'Harbour Pine Services', openingDate: '2023-10-01', volumeProfile: 'development', activityTemplateVersion: options.activityTemplateVersion ?? 1, ...(options.stockCosting ? {stockCosting:options.stockCosting}:{}), ...(options.openingDate ? {openingDate:options.openingDate}:{}) }, mappings: { ...initial.mappings, accountsReceivable: '1', accountsPayable: '2', undepositedFunds: '3', salesTax: '4', purchaseTax: '4' }, masterBindings: {} };
  const definition = buildDraftDefinition(input), view = { ...scope, draft: draftView({ _id: '000000000000000000000003', version: 1, contentHash: hash(definition), definition, connectionId: scope.connectionId }, scope.connectionId) };
  const setup = { ...scope, observedAt: stamp, complete: true, completeness: { accounts: true, taxCodes: true, preferences: true }, options: { accounts: [
    { id: '1', name: 'Receivables', active: true, type: 'Accounts Receivable', subtype: 'AccountsReceivable', currency: 'CAD' },
    { id: '2', name: 'Payables', active: true, type: 'Accounts Payable', subtype: 'AccountsPayable', currency: 'CAD' },
    { id: '3', name: 'Undeposited', active: true, type: 'Other Current Asset', subtype: 'UndepositedFunds', currency: 'CAD' },
  ], taxCodes: [{ id: '4', name: 'Fixture tax', active: true, sales: true, purchases: true }] }, observations: { homeCurrency: 'CAD', closedThrough: null, closingDateVerified: true, inventoryTracking: true }, sourceHash: hash('setup') };
  const masters = { ...scope, observedAt: stamp, options: { Customer: [], Vendor: [], Item: [], Employee: [] }, completeness: { Customer: true, Vendor: true, Item: true, Employee: true }, sourceHash: hash('masters') };
  const control = { version: 1, scope, status: 'owner-recorded', ownerId, closedThrough: null, reconciledThrough: null, evidenceNote: 'Fixture owner verified protected accounting periods.', recordedAt: stamp };
  const f = { view, setup, masters, country: { version: 1, scope, country: 'CA', companyInfoId: '1', recordHash: hash('country'), observedAt: stamp }, periodControl: { ...control, contentHash: hash(control) }, ownerId, input: { connectionId: scope.connectionId, baseHash: view.draft.contentHash, inventoryStartDate: '2023-10-01' }, now };
  f.blueprint = { _id: view.draft.id, ...scope, contractVersion: 2, version: 1, definition, contentHash: view.draft.contentHash };
  return f;
}

module.exports = { fixture, scope, ownerId, now, stamp };
