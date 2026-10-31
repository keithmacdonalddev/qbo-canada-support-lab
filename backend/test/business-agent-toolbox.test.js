'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolbox, toolDisclosure, CORE, META_NAMES, DISCOVERY_NAMES } = require('../src/modules/business-agent-toolbox');
const { createSkillLibrary } = require('../src/modules/business-agent-skills');
const { EXTRA_TOOLS, READ_NAMES } = require('../src/modules/business-agent-tools');
const readTools = require('../src/modules/ai-tools');

const definitions = [...readTools.toolDefinitions.filter(tool => READ_NAMES.includes(tool.name)), ...EXTRA_TOOLS];
function fixture(options = {}) {
  const calls = [];
  const box = createToolbox({ definitions, execute: async (name, input) => { calls.push({ name, input }); return { success: true, data: { ran: name } }; }, skills: createSkillLibrary(), ...options });
  return { box, calls };
}

test('only core and discovery tools are sent; deferred tools stay out of the provider list', () => {
  const { box } = fixture();
  const sent = box.coreDefinitions.map(tool => tool.name);
  for (const name of ['searchTools', 'useTool', 'listSkills', 'loadSkill', 'readSkillReference', 'getBusinessState', 'getBusinessWork', 'prepareBusinessActivity', 'executeBusinessPeriod', 'recordBusinessDecision', 'rememberBusinessContext']) assert.ok(sent.includes(name), name + ' is core');
  for (const name of ['resumeBusinessOperation', 'runReport', 'getTransactionChain', 'recordDailyPlan', 'requestCapability', 'linkReproductionCase', 'inspectBusinessOperation']) assert.ok(!sent.includes(name), name + ' is deferred');
  assert.ok(sent.length < definitions.length);
  for (const tool of box.coreDefinitions) assert.equal(tool.input_schema.type, 'object');
  const described = box.describe();
  assert.deepEqual(new Set([...described.core, ...described.deferred.map(row => row.name)]).size, described.core.length + described.deferred.length);
  assert.ok(described.deferred.every(row => row.category !== 'other'), 'every known tool has a category');
  assert.equal(toolDisclosure('runReport'), 'deferred'); assert.equal(toolDisclosure('getBusinessState'), 'core'); assert.equal(toolDisclosure('searchTools'), 'core');
  assert.match(box.promptBlock(), /resumeBusinessOperation/); assert.match(box.promptBlock(), /useTool/);
});

test('searchTools ranks keyword matches and supports the select form', async () => {
  const { box } = fixture();
  const resume = await box.execute('searchTools', { query: 'resume interrupted operation' });
  assert.equal(resume.success, true); assert.equal(resume.data.tools[0].name, 'resumeBusinessOperation');
  assert.ok(resume.data.tools[0].input_schema.properties.planHash, 'full schema is returned');
  const report = await box.execute('searchTools', { query: 'aged receivables report' });
  assert.equal(report.data.tools[0].name, 'runReport');
  const chain = await box.execute('searchTools', { query: 'linked transactions chain' });
  assert.equal(chain.data.tools[0].name, 'getTransactionChain');
  const select = await box.execute('searchTools', { query: 'select:recordDailyPlan, requestCapability, notATool' });
  assert.deepEqual(select.data.tools.map(tool => tool.name), ['recordDailyPlan', 'requestCapability']); assert.deepEqual(select.data.unknown, ['notATool']);
  const coreSelect = await box.execute('searchTools', { query: 'select:getBusinessState' });
  assert.equal(coreSelect.data.tools[0].core, true);
  const none = await box.execute('searchTools', { query: 'zzzz qqqq' });
  assert.equal(none.data.tools.length, 0); assert.ok(Object.values(none.data.deferredTools).flat().includes('resumeBusinessOperation'));
  const narrowed = await box.execute('searchTools', { query: 'report', category: 'notes' });
  assert.ok(narrowed.data.tools.every(tool => tool.category === 'notes'));
  const required = await box.execute('searchTools', { query: '+case link' });
  assert.deepEqual(required.data.tools.map(tool => tool.name), ['linkReproductionCase']);
  assert.equal((await box.execute('searchTools', { query: 'x', category: 'nope' })).success, false);
  assert.equal((await box.execute('searchTools', { query: 'x', extra: 1 })).success, false);
});

test('useTool validates input against the tool schema before dispatch', async () => {
  const { box, calls } = fixture();
  const bad = await box.execute('useTool', { name: 'resumeBusinessOperation', input: { operationId: 'not-an-id', planHash: 'x', reason: 'r' } });
  assert.equal(bad.success, false); assert.match(bad.error, /select:resumeBusinessOperation/); assert.equal(calls.length, 0);
  const extra = await box.execute('useTool', { name: 'getObligations', input: { area: 'receivables', sneaky: true } });
  assert.equal(extra.success, false); assert.equal(calls.length, 0);
  const ok = await box.execute('useTool', { name: 'getObligations', input: { area: 'payables', overdueOnly: true } });
  assert.deepEqual(ok, { success: true, data: { ran: 'getObligations' } }); assert.deepEqual(calls.at(-1), { name: 'getObligations', input: { area: 'payables', overdueOnly: true } });
  await box.execute('useTool', { name: 'getBusinessWork' });
  assert.deepEqual(calls.at(-1), { name: 'getBusinessWork', input: {} });
  assert.equal((await box.execute('useTool', { name: 'nothingHere', input: {} })).success, false);
  assert.equal((await box.execute('useTool', { name: 'useTool', input: {} })).success, false);
  assert.equal((await box.execute('useTool', { name: 'getBusinessWork', other: 1 })).success, false);
  // A core or loaded tool called directly still reaches the caller's execute.
  await box.execute('runReport', { reportName: 'ProfitAndLoss' });
  assert.equal(calls.at(-1).name, 'runReport');
});

test('a role only reaches its own tools, unknown tools register as deferred, and discovery is bounded', async () => {
  const specialist = createToolbox({ definitions: definitions.filter(tool => !['prepareBusinessActivity', 'executeBusinessPeriod'].includes(tool.name)).concat({ name: 'brandNewTool', description: 'A new reader.', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }), execute: async () => ({ success: true }) });
  assert.ok(!specialist.coreDefinitions.some(tool => ['prepareBusinessActivity', 'executeBusinessPeriod', 'listSkills'].includes(tool.name)));
  assert.equal((await specialist.execute('useTool', { name: 'executeBusinessPeriod', input: {} })).success, false);
  assert.ok(specialist.describe().deferred.some(row => row.name === 'brandNewTool' && row.category === 'other'));
  assert.equal((await specialist.execute('loadSkill', { name: 'qbo-api-records' })).success, false);
  const { box } = fixture({ maxDiscovery: 2 });
  await box.execute('searchTools', { query: 'report' }); await box.execute('listSkills', {});
  assert.match((await box.execute('searchTools', { query: 'report' })).error, /lookups/);
  assert.ok(DISCOVERY_NAMES.every(name => META_NAMES.includes(name)) && !DISCOVERY_NAMES.includes('useTool'));
  assert.ok(CORE.includes('queryCompanyData'));
});

test('loadedDefinitions returns only deferred tools a search loaded', async () => {
  const { box } = fixture();
  const result = await box.execute('searchTools', { query: 'select:runReport,getBusinessState' });
  assert.deepEqual(box.loadedDefinitions(result).map(tool => tool.name), ['runReport']);
  assert.deepEqual(box.loadedDefinitions({ success: false }), []);
});

test('skill tools return the index, a body and one reference', async () => {
  const { box } = fixture();
  const list = await box.execute('listSkills', {});
  assert.ok(list.data.skills.some(skill => skill.name === 'qbo-api-records'));
  const skill = await box.execute('loadSkill', { name: 'qbo-api-records' });
  assert.match(skill.data.instructions, /SyncToken/); assert.ok(skill.data.references.includes('faults.md'));
  const reference = await box.execute('readSkillReference', { name: 'qbo-api-records', file: 'faults.md' });
  assert.match(reference.data.content, /Stale Object/);
  assert.equal((await box.execute('readSkillReference', { name: 'qbo-api-records', file: '../SKILL.md' })).success, false);
  assert.equal((await box.execute('loadSkill', { name: '../qbo-api-records' })).success, false);
  assert.equal((await box.execute('loadSkill', { name: 'missing-skill' })).success, false);
});
