'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { runEngine } = require('../src/modules/reproduction-engine');
const { execute } = require('./helpers/case-engine-assessment-fixture');
test('actual engine and MCP path derive reproduced despite the opposite executor proposal', async () => {
  const f = await execute({ proposedOutcome: 'not_reproduced' });
  assert.equal(f.state.outcome, 'reproduced', JSON.stringify({ summary: f.state.summary, replies: f.state.agentReplies })); assert.equal(f.creates, 2); assert.equal(f.calls.length, 2);
  assert.ok(f.denied.every(result => result.success === false)); assert.equal(f.state.assessmentResult.setupComplete, true);
});
test('successful setup with missing symptom stays unverified and does not replay writes', async () => {
  const f = await execute({ omitSymptom: true }); assert.equal(f.state.outcome, 'unverified'); assert.equal(f.creates, 2); assert.equal(f.state.assessmentResult.setupComplete, true);
});
test('opposite actual symptom evidence yields not reproduced, independent of requested direction', async () => {
  const f = await execute({ balance: 0, proposedOutcome: 'reproduced' }); assert.equal(f.state.outcome, 'not_reproduced', JSON.stringify({ summary: f.state.summary, replies: f.state.agentReplies })); assert.equal(f.creates, 2);
});
test('final assessment audit failure cannot reopen writes or call a second reviewer', async () => {
  const f = await execute({ failAudit: 'Case evidence independently assessed' });
  assert.equal(f.state.outcome, 'unverified'); assert.equal(f.creates, 2); assert.equal(f.calls.length, 2); assert.ok(f.denied.every(result => result.success === false)); assert.equal(f.state.assessment, null);
});
test('version2 without its independent adapters cannot call the model or write', async () => {
  let calls = 0; const state = { caseContractVersion: 2 };
  await runEngine({ state, plan: { steps: [] }, qbo: {}, messages: [], persist: async () => {}, assertActive: async () => {}, audit: async () => ({}), runModel: async () => { calls++; } });
  assert.equal(state.outcome, 'unverified'); assert.equal(calls, 0);
});
