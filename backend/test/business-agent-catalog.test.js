'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { agentToolCatalog, TOOLS } = require('../src/modules/business-agent-catalog');
const { READ_NAMES, EXTRA_TOOLS } = require('../src/modules/business-agent-tools');

test('every live accountant tool has an owner-facing summary and its exact instructions', () => {
  const catalog = agentToolCatalog(), live = [...READ_NAMES, ...EXTRA_TOOLS.map(tool => tool.name)];
  assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), [...live].sort());
  assert.deepEqual(Object.keys(TOOLS).sort(), [...live].sort(), 'no description is left for a removed tool');
  for (const tool of catalog.tools) { assert.ok(tool.summary.length > 10); assert.ok(tool.instructions.length > 10); }
  assert.equal(catalog.tools.find(tool => tool.name === 'getEntityDetail').changesQuickBooks, false);
  assert.equal(catalog.tools.find(tool => tool.name === 'executeBusinessPeriod').changesQuickBooks, true);
});

test('coverage counts what the accountant can and cannot create', () => {
  const { coverage, counts } = agentToolCatalog();
  assert.equal(counts.recordTypes, coverage.length);
  assert.equal(coverage.find(row => row.entity === 'JournalEntry').create, 'limited');
  assert.equal(coverage.find(row => row.entity === 'Customer').create, 'no');
  assert.equal(coverage.find(row => row.entity === 'Invoice').create, 'limited');
  assert.equal(coverage.find(row => row.entity === 'Invoice').read, true);
  assert.equal(coverage.find(row => row.entity === 'BankReconciliation').read, false);
});
