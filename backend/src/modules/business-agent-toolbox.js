'use strict';
// Progressive disclosure for the accountant's tools (owner direction 2026-10-31: set the
// accountant up the way Claude Code is, with a small always-loaded core, tool search and
// skills). Every tool is registered here with a category and search keywords and is either
// core (its schema is sent on every review) or deferred (found with searchTools and called
// through useTool, so the provider's tool list never changes mid-review). Provider neutral:
// the same core list goes to the Codex tool bridge and to the Anthropic Messages loop.
// Pure: no I/O. Tool execution stays with the caller's execute (business-agent-tools.js),
// which re-validates every input against the tool's own schema.

// Always sent: what nearly every review needs. Anything else is one searchTools away.
const CORE = Object.freeze(['getBusinessState', 'getBusinessWork', 'queryCompanyData', 'getBusinessActivityChoices', 'prepareBusinessActivity', 'prepareBusinessPeriod', 'executeBusinessPeriod', 'recordBusinessDecision', 'rememberBusinessContext', 'manageQboRecord']);
const CATEGORIES = Object.freeze({
  'quickbooks-read': 'Live QuickBooks reads: records, links and reports',
  'business-read': 'The app’s own business state, work, obligations, saved plans and the local company copy',
  'quickbooks-write': 'Prepares, approves, resumes or saves accounting work in QuickBooks',
  notes: 'Decisions, plans, handoffs, build requests and case links',
  skills: 'Procedures and reference knowledge loaded on demand',
  discovery: 'Finds and calls deferred tools',
  other: 'Tools without a registered category',
});
// Search metadata for the known tools. A tool missing here still registers (category from
// its catalog group when known, otherwise other) so a newly added tool is never lost.
const INFO = Object.freeze({
  lookupCustomer: { category: 'quickbooks-read', keywords: ['customer', 'balance', 'client', 'find', 'contact'] },
  lookupInvoice: { category: 'quickbooks-read', keywords: ['invoice', 'number', 'receivable', 'open', 'find'] },
  searchEntities: { category: 'quickbooks-read', keywords: ['search', 'query', 'records', 'entity', 'bill', 'item', 'vendor', 'supplier', 'account', 'journal', 'tax', 'preferences', 'list'] },
  getEntityDetail: { category: 'quickbooks-read', keywords: ['record', 'detail', 'read', 'full', 'synctoken', 'lines'] },
  getTransactionChain: { category: 'quickbooks-read', keywords: ['linked', 'linkedtxn', 'chain', 'estimate', 'payment', 'deposit', 'purchase order', 'trace'] },
  runReport: { category: 'quickbooks-read', keywords: ['report', 'profit', 'loss', 'balance sheet', 'aging', 'trial balance', 'cash flow', 'general ledger', 'sales', 'inventory valuation'] },
  getQboEntitySchema: { category: 'quickbooks-read', keywords: ['schema', 'fields', 'payload', 'entity', 'required', 'api'] },
  getBusinessState: { category: 'business-read', keywords: ['state', 'status', 'today', 'target', 'sync', 'usage', 'blockers', 'calendar', 'unfinished'] },
  getBusinessWork: { category: 'business-read', keywords: ['work', 'jobs', 'todo', 'blocked', 'features', 'owner'] },
  queryCompanyData: { category: 'business-read', keywords: ['query', 'search', 'local', 'mirror', 'aggregate', 'sum', 'count', 'group', 'analysis', 'trend', 'aging', 'margin'] },
  getObligations: { category: 'business-read', keywords: ['unpaid', 'open', 'invoices', 'bills', 'receivables', 'payables', 'overdue', 'due', 'collections'] },
  inspectBusinessOperation: { category: 'business-read', keywords: ['operation', 'plan', 'saved', 'inspect', 'verification', 'recovery', 'progress'] },
  getBusinessActivityChoices: { category: 'business-read', keywords: ['choices', 'roles', 'customers', 'suppliers', 'items', 'purchase orders', 'adopted', 'correctable', 'options'] },
  getBusinessDecision: { category: 'business-read', keywords: ['decision', 'owner', 'answer', 'evidence', 'response'] },
  prepareBusinessActivity: { category: 'quickbooks-write', keywords: ['prepare', 'batch', 'sale', 'expense', 'credit', 'refund', 'transfer', 'journal', 'receive', 'customer', 'supplier', 'item', 'correct', 'terms', 'collect', 'pay'] },
  prepareBusinessPeriod: { category: 'quickbooks-write', keywords: ['period', 'calendar', 'close', 'month', 'prepare', 'scheduled'] },
  executeBusinessPeriod: { category: 'quickbooks-write', keywords: ['execute', 'approve', 'save', 'plan', 'queue', 'run'] },
  resumeBusinessOperation: { category: 'quickbooks-write', keywords: ['resume', 'recover', 'continue', 'interrupted', 'stopped', 'unfinished'] },
  manageQboRecord: { category: 'quickbooks-write', keywords: ['create', 'update', 'void', 'delete', 'record', 'write', 'payload', 'general'] },
  recordBusinessDecision: { category: 'notes', keywords: ['decision', 'escalate', 'owner', 'question', 'evidence', 'finding'] },
  rememberBusinessContext: { category: 'notes', keywords: ['memory', 'handoff', 'remember', 'next', 'note'] },
  getManagementReview: { category: 'business-read', keywords: ['management', 'review', 'plan', 'today', 'measures', 'coverage', 'gaps', 'build list', 'capability', 'requests', 'keys', 'responsibilities'] },
  recordDailyPlan: { category: 'notes', keywords: ['daily', 'plan', 'management', 'review', 'findings', 'requirements', 'owner note'] },
  requestCapability: { category: 'notes', keywords: ['capability', 'missing', 'gap', 'build', 'request', 'tool', 'feature'] },
  linkReproductionCase: { category: 'notes', keywords: ['case', 'troubleshooting', 'reproduction', 'support', 'link'] },
});
const CATALOG_GROUP = Object.freeze({ 'quickbooks-read': 'quickbooks-read', 'business-read': 'business-read', 'quickbooks-write': 'quickbooks-write', notes: 'notes' });
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SEARCH_LIMIT = 5, MAX_DISCOVERY = 16;

// Discovery and skill tools. They are always core and never count as accounting work.
function metaDefinitions({ skills }) {
  const tools = [
    { name: 'searchTools', description: 'Find deferred tools and load their full schemas. query is either "select:NameA,NameB" for exact tools, or keywords describing the job (for example "resume interrupted operation", "linked transactions", "aged receivables report"). Optional category narrows the search (' + Object.keys(CATEGORIES).filter(key => !['skills', 'discovery', 'other'].includes(key)).join(', ') + '). Then call a returned tool with useTool.', input_schema: object({ query: { type: 'string', minLength: 1, maxLength: 300 }, category: { type: 'string', enum: Object.keys(CATEGORIES) } }, ['query']) },
    { name: 'useTool', description: 'Call any registered tool by name, including deferred tools found with searchTools. input must match that tool’s schema exactly; it is validated before the tool runs, and the same rules and limits apply as for a direct call.', input_schema: object({ name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]{1,63}$' }, input: { type: 'object', description: 'The tool’s own arguments.' } }, ['name']) },
  ];
  if (skills) tools.push(
    { name: 'listSkills', description: 'List your skills (name and description). The same list is in your instructions.', input_schema: object() },
    { name: 'loadSkill', description: 'Load one skill’s full procedure before unfamiliar or specialised work. The result names its optional reference files.', input_schema: object({ name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' } }, ['name']) },
    { name: 'readSkillReference', description: 'Read one reference file named by a loaded skill, only when the skill says you need it.', input_schema: object({ name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }, file: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}\\.md$' } }, ['name', 'file']) },
  );
  return tools;
}
const META_NAMES = Object.freeze(['searchTools', 'useTool', 'listSkills', 'loadSkill', 'readSkillReference']);
// Calls that only discover tools or knowledge; they never count toward the accounting tool allowance.
const DISCOVERY_NAMES = Object.freeze(['searchTools', 'listSkills', 'loadSkill', 'readSkillReference']);

const words = value => String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1);
const schemaOf = tool => tool.input_schema || { type: 'object', properties: {} };
function register(definitions, core) {
  const { TOOLS } = require('./business-agent-catalog');
  const entries = new Map();
  for (const tool of definitions) {
    if (!tool?.name || META_NAMES.includes(tool.name) || entries.has(tool.name)) continue;
    const info = INFO[tool.name] || { category: CATALOG_GROUP[TOOLS[tool.name]?.group] || 'other', keywords: [] };
    entries.set(tool.name, { tool, name: tool.name, category: info.category, keywords: info.keywords, core: core.includes(tool.name), nameWords: words(tool.name), descriptionWords: new Set(words(tool.description)) });
  }
  return entries;
}
function score(entry, terms, phrase) {
  let total = 0;
  if (entry.name.toLowerCase() === phrase.replace(/\s+/g, '')) total += 20;
  for (const term of terms) {
    if (entry.nameWords.includes(term)) total += 6; else if (entry.name.toLowerCase().includes(term)) total += 3;
    if (entry.keywords.some(keyword => keyword === term || keyword.split(' ').includes(term))) total += 4;
    if (entry.descriptionWords.has(term)) total += 1;
  }
  for (const keyword of entry.keywords) if (keyword.includes(' ') && phrase.includes(keyword)) total += 4;
  return total;
}
const view = entry => ({ name: entry.name, description: entry.tool.description || '', input_schema: schemaOf(entry.tool), category: entry.category, core: entry.core });

/**
 * @param {Object} options
 * @param {Array} options.definitions - every tool this role may use (Anthropic format)
 * @param {(name: string, input: Object) => Promise<Object>} options.execute - runs a registered tool
 * @param {Object} [options.skills] - createSkillLibrary() result; omit for no skill tools
 * @param {(input: Object, schema: Object) => void} [options.validate] - schema check (throws)
 */
function createToolbox({ definitions = [], execute, skills = null, core = CORE, validate = null, maxDiscovery = MAX_DISCOVERY } = {}) {
  const entries = register(definitions, core), meta = metaDefinitions({ skills });
  const check = validate || ((input, schema) => require('./business-agent-tools').validateArguments(input, schema));
  let discovery = 0;
  const coreDefinitions = [...meta, ...[...entries.values()].filter(entry => entry.core).map(entry => entry.tool)];
  const deferred = () => [...entries.values()].filter(entry => !entry.core);

  function searchTools({ query, category } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 300) return { success: false, error: 'Give searchTools a query: "select:ToolName" or a few keywords.' };
    if (category !== undefined && !Object.hasOwn(CATEGORIES, category)) return { success: false, error: 'Unknown category. Use one of: ' + Object.keys(CATEGORIES).join(', ') + '.' };
    const text = query.trim();
    let found;
    if (/^select:/i.test(text)) {
      const names = text.slice(7).split(',').map(name => name.trim()).filter(Boolean).slice(0, 10);
      found = names.map(name => entries.get(name)).filter(Boolean);
      const missing = names.filter(name => !entries.has(name) && !META_NAMES.includes(name));
      if (!found.length) return { success: false, error: 'No registered tool has ' + (names.length === 1 ? 'that name' : 'those names') + (missing.length ? ' (' + missing.join(', ').slice(0, 200) + ')' : '') + '. Search by keywords instead.', deferredTools: deferred().map(entry => entry.name) };
      return { success: true, data: { tools: found.map(view), ...(missing.length ? { unknown: missing } : {}), howToCall: 'Call a deferred tool with useTool({ name, input }).' } };
    }
    const phrase = text.toLowerCase(), terms = [...new Set(words(text))];
    const required = [...text.matchAll(/(?:^|\s)\+([A-Za-z0-9]+)/g)].map(match => match[1].toLowerCase());
    found = deferred().filter(entry => !category || entry.category === category).filter(entry => required.every(term => entry.name.toLowerCase().includes(term)))
      .map(entry => ({ entry, points: score(entry, terms, phrase) })).filter(row => row.points > 0)
      .sort((a, b) => b.points - a.points || a.entry.name.localeCompare(b.entry.name)).slice(0, SEARCH_LIMIT).map(row => row.entry);
    if (!found.length) return { success: true, data: { tools: [], note: 'No deferred tool matched. Core tools are already in your tool list. Deferred tools by category:', deferredTools: Object.fromEntries(Object.keys(CATEGORIES).map(key => [key, deferred().filter(entry => entry.category === key).map(entry => entry.name)]).filter(([, names]) => names.length)) } };
    return { success: true, data: { tools: found.map(view), howToCall: 'Call a deferred tool with useTool({ name, input }).' } };
  }
  async function useTool({ name, input } = {}) {
    if (typeof name !== 'string' || META_NAMES.includes(name)) return { success: false, error: 'useTool calls one registered business tool by name; discovery and skill tools are called directly.' };
    const entry = entries.get(name);
    if (!entry) return { success: false, error: 'No tool named "' + name.slice(0, 80) + '" is available to this role. Find tools with searchTools.' };
    const args = input === undefined ? {} : input;
    try { check(args, schemaOf(entry.tool)); }
    catch (error) { return { success: false, error: String(error.message || 'The input does not match this tool’s schema.') + ' Use searchTools("select:' + name + '") to read its schema.' }; }
    return execute(name, args);
  }
  function skillCall(name, input) {
    if (name === 'listSkills') return { success: true, data: { skills: skills.list() } };
    if (name === 'loadSkill') return { success: true, data: skills.load(input.name) };
    return { success: true, data: skills.reference(input.name, input.file) };
  }
  // Runs a meta tool here, or hands any registered tool to the caller's execute. A deferred
  // tool called directly (after the Anthropic loop added its loaded schema) also runs.
  async function run(name, input = {}) {
    if (DISCOVERY_NAMES.includes(name)) {
      if (name !== 'searchTools' && !skills) return { success: false, error: 'Skills are not available in this review.' };
      if (++discovery > maxDiscovery) return { success: false, error: 'This review used its ' + maxDiscovery + ' tool and skill lookups. Continue with the tools and skills already loaded.' };
      try { check(input, schemaOf(meta.find(tool => tool.name === name))); } catch (error) { return { success: false, error: String(error.message || 'Unsupported input.') }; }
      if (name === 'searchTools') return searchTools(input);
      try { return skillCall(name, input); } catch (error) { if (error.code === 'BUSINESS_SKILL_UNAVAILABLE') return { success: false, error: error.message }; throw error; }
    }
    if (name === 'useTool') {
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !['name', 'input'].includes(key))) return { success: false, error: 'useTool takes { name, input }.' };
      return useTool(input);
    }
    return execute(name, input);
  }
  // Tool definitions a searchTools result loaded, for providers that can add tools natively.
  function loadedDefinitions(result) {
    const names = Array.isArray(result?.data?.tools) ? result.data.tools.map(tool => tool?.name) : [];
    return names.map(name => entries.get(name)).filter(entry => entry && !entry.core).map(entry => entry.tool);
  }
  function describe() {
    return { core: coreDefinitions.map(tool => tool.name), deferred: deferred().map(entry => ({ name: entry.name, category: entry.category })), categories: CATEGORIES };
  }
  function promptBlock() {
    const groups = Object.keys(CATEGORIES).map(key => [key, deferred().filter(entry => entry.category === key).map(entry => entry.name)]).filter(([, names]) => names.length);
    if (!groups.length) return '';
    return 'Tools: your tool list holds the core tools. Further tools are deferred: find one with searchTools (keywords, or "select:Name" for an exact tool, which also returns its schema), then call it with useTool({ name, input }). Never guess a deferred tool’s input; load its schema first. Deferred tools: ' + groups.map(([key, names]) => key + ': ' + names.join(', ')).join('; ') + '.';
  }
  return { coreDefinitions, limits: { discovery: maxDiscovery }, execute: run, searchTools, useTool, loadedDefinitions, describe, promptBlock, stats: () => ({ discovery }), has: name => entries.has(name) || meta.some(tool => tool.name === name) };
}

// Owner-facing split for the in-app tool list (business-agent-catalog.js).
function toolDisclosure(name) {
  if (META_NAMES.includes(name)) return 'core';
  return CORE.includes(name) ? 'core' : 'deferred';
}

module.exports = { createToolbox, toolDisclosure, metaDefinitions, CORE, CATEGORIES, INFO, META_NAMES, DISCOVERY_NAMES };
