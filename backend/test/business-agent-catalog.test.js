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

test('the catalog shows the core/deferred split, the discovery tools and the skills', () => {
  const catalog = agentToolCatalog();
  assert.equal(catalog.tools.find(tool => tool.name === 'getBusinessState').disclosure, 'core');
  assert.equal(catalog.tools.find(tool => tool.name === 'resumeBusinessOperation').disclosure, 'deferred');
  assert.equal(catalog.counts.core + catalog.counts.deferred, catalog.counts.tools);
  assert.deepEqual(catalog.discovery.map(tool => tool.name), ['searchTools', 'useTool', 'listSkills', 'loadSkill', 'readSkillReference']);
  for (const tool of catalog.discovery) { assert.ok(tool.summary.length > 10); assert.ok(tool.instructions.length > 10); }
  assert.equal(catalog.counts.skills, catalog.skills.length);
  assert.ok(catalog.skills.find(skill => skill.name === 'qbo-api-records').references >= 5);
});

test('coverage counts what the accountant can and cannot create', () => {
  const { coverage, counts } = agentToolCatalog();
  assert.equal(counts.recordTypes, coverage.length);
  assert.equal(coverage.find(row => row.entity === 'JournalEntry').create, 'limited');
  assert.equal(coverage.find(row => row.entity === 'Customer').create, 'limited');
  assert.equal(coverage.find(row => row.entity === 'Employee').create, 'no');
  assert.equal(coverage.find(row => row.entity === 'Invoice').create, 'limited');
  assert.equal(coverage.find(row => row.entity === 'Invoice').read, true);
  assert.equal(coverage.find(row => row.entity === 'BankReconciliation').read, false);
});
