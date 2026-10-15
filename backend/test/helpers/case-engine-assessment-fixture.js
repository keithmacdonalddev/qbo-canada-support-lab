'use strict';
const assert = require('node:assert/strict');
const { runEngine } = require('../../src/modules/reproduction-engine');
const { createToolSession, handleMcpRequest } = require('../../src/modules/ai-tool-bridge');
const { serviceFixture } = require('./case-assessment-fixture');
const clone = value => JSON.parse(JSON.stringify(value));
async function execute(options = {}) {
  const f = await serviceFixture(options);
  delete f.state.requestContract; f.state.checks = []; f.state.revision = 0; f.state.ownedRecords = []; f.state.status = 'running'; f.plan.steps = []; f.state.startedAt = new Date();
  const records = new Map(); let next = 100, creates = 0; const denied = [];
  const typeFor = entity => ({ customer: 'Customer', invoice: 'Invoice', item: 'Item' }[entity]);
  const qbo = { async create(entity, input) { creates++; const type = typeFor(entity), row = { ...clone(input), Id: String(++next), SyncToken: '0' };
    if (type === 'Invoice') { row.TotalAmt = input.Line.reduce((sum, line) => sum + line.Amount, 0); row.Balance = options.balance ?? 20; }
    records.set(type + ':' + row.Id, row); return { [type]: clone(row) }; },
    async read(entity, id) { const type = typeFor(entity); return type === 'Item' ? { Item: { Id: String(id), Type: 'Service' } } : { [type]: clone(records.get(type + ':' + id)) }; },
    async query() { return { QueryResponse: {} }; } };
  await runEngine({ state: f.state, plan: f.plan, qbo, persist: f.persist, assertActive: f.assertActive, audit: f.audit, messages: [], ensureContract: f.api.ensureContract, reviewFinish: f.api.reviewFinish,
    runModel: async (_messages, tool, tools) => {
      const bridge = createToolSession({ tools, execute: tool, maxCalls: 160 }); let request = 0;
      const call = async (name, input) => { const response = await handleMcpRequest(bridge.bridge.token, { jsonrpc: '2.0', id: ++request, method: 'tools/call', params: { name, arguments: input } }); if (response.json?.error) throw Error(response.json.error.message); return JSON.parse(response.json.result.content[0].text); };
      try {
        const definition = await call('defineCase', { title: 'Fixture', scenario: 'Source-backed fixture', conditions: ['Easy replacement condition'] });
        assert.ok(definition.conditions.includes('Invoice total is 120')); assert.ok(definition.conditions.includes('Invoice still has balance 20'));
        const customer = await call('createRecord', { entityType: 'Customer', record: { DisplayName: 'REPRO fixture customer' }, summary: 'Create fixture customer' });
        const invoice = await call('createRecord', { entityType: 'Invoice', record: { CustomerRef: { value: customer.data.id }, TxnDate: '2026-09-01', Line: [{ Amount: 120, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '7' }, Qty: 1, UnitPrice: 120 } }] }, summary: 'Create fixture invoice' });
        await call('checkCase', { label: 'Invoice total is 120', sources: [{ entityType: 'Invoice', id: invoice.data.id, path: 'TotalAmt' }], aggregate: 'single', operator: 'equal', expected: 120 });
        if (!options.omitSymptom) await call('checkCase', { label: 'Invoice still has balance 20', sources: [{ entityType: 'Invoice', id: invoice.data.id, path: 'Balance' }], aggregate: 'single', operator: 'equal', expected: 20 });
        const finish = call('finishCase', { outcome: options.proposedOutcome || 'completed', summary: 'Executor assertion', tests: [], limitations: [] });
        const queued = call('createRecord', { entityType: 'Customer', record: { DisplayName: 'Must not be created' }, summary: 'Queued after finalization' });
        const repeated = call('finishCase', { outcome: 'reproduced', summary: 'Must not restart', tests: [], limitations: [] });
        const results = await Promise.all([finish, queued, repeated]); denied.push(results[1], results[2]);
      } finally { await bridge.close(); }
      return 'Finished fixture.';
    } });
  return { ...f, creates, denied, records };
}
module.exports = { execute };
