'use strict';
// The owner-facing catalog of the accountant's tools and of how much of the
// QuickBooks API they reach. Tool names and model descriptions come from the
// live tool definitions; this file adds plain-English summaries and the
// per-record coverage. A test keeps every live tool described here.
const GROUPS = Object.freeze([
  { key: 'quickbooks-read', label: 'Reads QuickBooks' },
  { key: 'business-read', label: 'Reads the business' },
  { key: 'quickbooks-write', label: 'Changes QuickBooks' },
  { key: 'notes', label: 'Notes and handoffs' },
]);
const TOOLS = Object.freeze({
  getBankMonthlyStatements:{group:'business-read',summary:'Reads monthly bank statements and exact coverage/opening holds; files do not prove QuickBooks reconciliation.'},
  issueDueBankStatements:{group:'notes',summary:'Retains an eligible completed bank month or recovers its exact statement files under accountant authority; no QuickBooks calls, changed balances or automatic revisions.'},
  getCurrentBankFeeds:{group:'business-read',summary:'Reads current retained bank CSVs, disjoint incremental assignments and clearly overlapping cumulative reference windows.'},
  publishCurrentBankFeed:{group:'notes',summary:'Retains the next current incremental bank CSV or verifies an exact retained publication; no QuickBooks call or bank balance change.'},
  publishCumulativeBankFeed:{group:'notes',summary:'Retains an explicitly overlapping reference CSV window; not the next incremental import file.'},
  getBankOriginPolicy: {group:'business-read',summary:'Reads explicit bank fee policy and current counterpart choices; no policy is enabled by default.'},
  configureBankOriginPolicy: {group:'notes',summary:'Records an explicit future bank fee policy under current authority; no QuickBooks write.'},
  processBankOriginDue: {group:'notes',summary:'Posts only due configured bank-origin events once, with a visible bookkeeping obligation; no QuickBooks call.'},
  addBankOriginAdvice: {group:'notes',summary:'Retains exact simulated interest advice or labelled unknown/duplicate situations without inferring missing balances.'},
  bookBankOriginEvent: {group:'quickbooks-write',summary:'Books the original bank event through the governed General path and links its exact counterpart without another bank movement.'},
  getBankingActivity: { group: 'business-read', summary: 'Pages pending and posted activity for one independent bank account, with due dates and retained source lineage.' },
  retryBankInstructions: { group: 'notes', summary: 'Retries delivery of already accepted business activity to the independent bank; never resends a QuickBooks write.' },
  settleBankInstructions: { group: 'notes', summary: 'Schedules independent bank activity and posts only due instructions, with duplicate-safe balances and paired transfers; makes no QuickBooks calls.' },
  repairEstimateConversion: { group: 'quickbooks-write', summary: 'Repairs the Estimate link on an eligible existing Invoice through the governed native workflow, preserving its identity and accounting. Unknown outcomes remain held; no replacement Invoice is created.' },
  getBankingWorkspace: { group: 'business-read', summary: 'Reads bank and card statement months, blockers and retained reconciliation evidence.' },
  getBankingPackage: { group: 'business-read', summary: 'Inspects a saved statement package and its native banking evidence.' },
  prepareBankingPackage: { group: 'notes', summary: 'Registers an existing generated statement package for the banking workspace; does not send or match bank transactions.' },
  getBankingCloseSupport: { group: 'business-read', summary: 'Reads retained banking evidence for the month being closed.' },
  reviewCapability: {group:"notes",summary:"Records build-list status changes, resolutions and regressions with evidence."},
  recordCloseChecklistEvidence: {group:"notes",summary:"Records close evidence and exceptions; manual owner attestations stay manual."},
  getCloseChecklist: {group:"business-read",summary:"Reads month-end checks and evidence."},
  getWeeklyCoverage: {group:"business-read",summary:"Measures seven-day feature, class and location breadth."},
  getCoverageSituations: {group:"business-read",summary:"Measures present and missing situations from the synchronized copy."},
  findBusinessOperation: {group:"business-read",summary:"Finds original operations and retained choices by decision key."},
  lookupCustomer: { group: 'quickbooks-read', summary: 'Finds a customer and their balance.' },
  lookupInvoice: { group: 'quickbooks-read', summary: 'Finds an invoice by number or customer.' },
  searchEntities: { group: 'quickbooks-read', summary: 'Searches any record type: customers, bills, items, journal entries, settings and more. Answers from the synced copy when it is current.' },
  getEntityDetail: { group: 'quickbooks-read', summary: 'Reads one record in full, from the synced copy when it is current.' },
  getTransactionChain: { group: 'quickbooks-read', summary: 'Follows the links between records, such as estimate → invoice → payment → deposit.' },
  runReport: { group: 'quickbooks-read', summary: 'Runs a QuickBooks report, such as profit and loss or aged receivables.' },
  getBusinessState: { group: 'business-read', summary: 'Checks sync status, published business rules, current work, blockers, AI token usage, estimated API cost, owner limits and the ChatGPT plan reset time.' },
  getBusinessWork: { group: 'business-read', summary: 'Reads the work list: its own jobs, what is blocked and why, and what needs the owner.' },
  getObligations: { group: 'business-read', summary: 'Lists unpaid customer invoices or supplier bills.' },
  queryCompanyData: { group: 'business-read', summary: 'Searches and analyses the app’s synced copy of every record (sales by customer or month, aging, items sold, who pays late, linked records) without using any QuickBooks requests.' },
  inspectBlocker: { group: 'business-read', summary: 'Explains blocked work from saved errors and steps, showing changed reference or tax fields and record versions without making QuickBooks requests.' },
  inspectBusinessOperation: { group: 'business-read', summary: 'Reads a saved accounting plan and how far it got.' },
  getBusinessActivityChoices: { group: 'business-read', summary: 'Lists the customers, services and suppliers it may use for extra activity (including ones it added earlier), the open imported invoices and bills it may settle, its own open invoices and bills on terms (with balances and due dates) and open estimates, wholly unreceived purchase orders it may receive, and which of its own earlier records it may correct.' },
  getBusinessDecision: { group: 'business-read', summary: 'Reads one earlier decision and the owner’s answer.' },
  prepareBusinessPeriod: { group: 'quickbooks-write', summary: 'Plans the scheduled business activity for past days. Plans only; nothing is saved yet.' },
  executeBusinessPeriod: { group: 'quickbooks-write', summary: 'Saves a planned period to QuickBooks, checking every record after it is saved.' },
  prepareBusinessActivity: { group: 'quickbooks-write', summary: 'Plans extra activity for today: invoices and bills on payment terms left open, later collected or paid in full or in part; estimates sent and later converted to invoices; stock purchase orders; correcting its own earlier records by reversing them, adding customers, suppliers and service items, paid service sales, paid business expenses (by bill or straight from the bank), receiving whole purchase orders into inventory bills, supplier credits, customer credits and refunds, bank transfers, journal entries, and collecting or paying invoices and bills left open by the imported history. The same check-and-save path then records it.' },
  resumeBusinessOperation: { group: 'quickbooks-write', summary: 'Restarts its own interrupted work without sending anything twice.' },
  recordBusinessDecision: { group: 'notes', summary: 'Records a business decision with its evidence, or asks the owner a question.' },
  rememberBusinessContext: { group: 'notes', summary: 'Leaves a handoff note for its next review.' },
  getQboEntitySchema: { group: 'quickbooks-read', summary: 'Explains how to write one QuickBooks record type: required fields, links, posting and Canadian tax rules.' },
  manageQboRecord: { group: 'quickbooks-write', summary: 'Writes QuickBooks records directly (create, change, void or delete), checked field by field against the company copy and the business rules before anything is sent. Current sending availability and record operations are shown below; company permissions, field checks and accounting proof still gate every write.' },
  linkReproductionCase: { group: 'notes', summary: 'Links a troubleshooting case to its work. Does not run the case.' },
  getManagementReview: { group: 'business-read', summary: 'Reads today’s plan, the business measures and coverage gaps from the local company copy, the tool map and the open build list.' },
  recordDailyPlan: { group: 'notes', summary: 'Records today’s plan from its daily management review: findings against the app’s goals, today’s changes and a short note for you.' },
  requestCapability: { group: 'notes', summary: 'Adds a missing tool or workflow to the build list, with the goal and QuickBooks feature it would cover.' },
});
// What the accountant can do with each QuickBooks record type.
// yes: an available tool does it. limited: only inside a fixed workflow.
// no: not built yet. manual: QuickBooks does not offer it to apps.
const CALENDAR = 'Scheduled business periods', TODAY = 'Extra activity for today';
const COVERAGE = Object.freeze([
  { area: 'Sales', entity: 'Estimate', create: ['limited', [CALENDAR, TODAY]], note: 'Field-service estimates can be sent on their own and remain open. Estimate-linked invoicing depends on the current Progress Invoicing setting; see the native-workflow restriction below.' },
  { area: 'Sales', entity: 'Invoice', create: ['limited', [CALENDAR, TODAY]], note: 'Today: settled same-day sales, and invoices on payment terms (7 to 60 days) left open until the customer pays.' },
  { area: 'Sales', entity: 'Payment', label: 'Customer payment', create: ['limited', [CALENDAR, TODAY]], note: 'For invoices its own workflows created and open invoices from the imported history; its own invoices on terms can be collected in full or in part on any later day, then deposited. With general sending enabled, eligible observed invoices can also be settled, subject to their current customer, currency, balance and link checks.' },
  { area: 'Sales', entity: 'Deposit', create: ['limited', [CALENDAR, TODAY]] },
  { area: 'Sales', entity: 'SalesReceipt', label: 'Sales receipt', create: ['limited', [CALENDAR]] },
  { area: 'Sales', entity: 'CreditMemo', label: 'Credit memo', create: ['limited', [CALENDAR, TODAY]], note: 'Today: open credits for published services, and full credits that correct its own wholly unpaid service invoices (applied to them at the original tax rate). The scheduled credit-and-application cycle is still held back on the real company.' },
  { area: 'Sales', entity: 'RefundReceipt', label: 'Refund receipt', create: ['limited', [TODAY]], note: 'Refunds for published services, paid from the operating bank, including refunds that correct its own fully collected service sales at the original tax rate.' },
  { area: 'Sales', entity: 'TimeActivity', label: 'Time entry', create: ['limited', [CALENDAR, TODAY]] },
  { area: 'Purchases', entity: 'PurchaseOrder', label: 'Purchase order', create: ['limited', [CALENDAR, TODAY]], note: 'Today: purchase orders for one to five workshop stock items from published stock suppliers. PurchaseOrder → Bill receiving is available for wholly unreceived orders created by its own workflows or adopted import, in full at original cost; partial receipts unavailable.' },
  { area: 'Purchases', entity: 'Bill', create: ['limited', [CALENDAR, TODAY]], note: 'Includes operating bills on payment terms left open until paid, and unpaid inventory receiving bills linked to the original purchase-order lines.' },
  { area: 'Purchases', entity: 'BillPayment', label: 'Bill payment', create: ['limited', [CALENDAR, TODAY]], note: 'For bills its own workflows created and open bills from the imported history; its own bills on terms can be paid in full or in part on any later day. With general sending enabled, eligible observed bills can also be paid, subject to current supplier, currency, balance and link checks.' },
  { area: 'Purchases', entity: 'Purchase', label: 'Expense / cheque', create: ['limited', [TODAY]], note: 'Fixed activity batches create cash operating expenses. General Purchase formats depend on the executable schema and current sending switch.' },
  { area: 'Purchases', entity: 'VendorCredit', label: 'Supplier credit', create: ['limited', [TODAY]], note: 'Operating-expense credits from published suppliers. A credit is applied to a bill only when it corrects the accountant’s own wholly unpaid operating bill (zero-funds bill payment).' },
  { area: 'Banking', entity: 'Transfer', create: ['limited', [TODAY]], note: 'Transfers need two different eligible funding accounts; the selected tool checks their types, currencies and current company scope.' },
  { area: 'Banking', entity: 'JournalEntry', label: 'Journal entry', create: ['limited', [TODAY]], note: 'Fixed activity batches reclassify between published income and operating-expense roles. General journals use their checked account and posting contract; direct inventory adjustments remain held.' },
  { area: 'Banking', entity: 'BankReconciliation', label: 'Bank reconciliation', create: ['manual'], read: false },
  { area: 'Lists', entity: 'Customer', create: ['limited', [TODAY]], note: 'New customers can be used in a later batch, for service sales.' },
  { area: 'Lists', entity: 'Vendor', label: 'Supplier', create: ['limited', [TODAY]], note: 'New suppliers can be used in a later batch, for paid bills.' },
  { area: 'Lists', entity: 'Item', label: 'Product or service', create: ['limited', [TODAY]], note: 'Fixed activity batches add service items. General maintenance supports Service and NonInventory items; inventory quantity and start-date edits remain held.' },
  { area: 'Lists', entity: 'Employee', create: ['no'] },
  { area: 'Lists', entity: 'Account', create: ['no'] },
  { area: 'Lists', entity: 'Class', create: ['no'] },
  { area: 'Lists', entity: 'Department', label: 'Location', create: ['no'] },
  { area: 'Lists', entity: 'Term', label: 'Payment terms', create: ['no'] },
  { area: 'Settings', entity: 'Preferences', label: 'Company settings', create: ['manual'] },
  { area: 'Settings', entity: 'CompanyInfo', label: 'Company information', create: ['manual'] },
  { area: 'Settings', entity: 'TaxCode', label: 'Sales tax codes and rates', create: ['manual'] },
]);
// Plain-English summaries of the discovery and skill tools (always loaded).
const DISCOVERY = Object.freeze({
  searchTools: 'Finds tools that are not loaded on every review, by keywords or exact name, and loads their instructions.',
  useTool: 'Calls a tool found by search, after checking its input against that tool’s rules.',
  listSkills: 'Lists its skills: procedures and reference knowledge it can load.',
  loadSkill: 'Loads one skill’s procedure before unfamiliar work.',
  readSkillReference: 'Reads one reference file of a loaded skill, only when needed.',
});
function agentToolCatalog(readTools = require('./ai-tools'), skills = null, features = require('../config').features || {}) {
  const { toolDisclosure, metaDefinitions } = require('./business-agent-toolbox');
  const { createSkillLibrary } = require('./business-agent-skills');
  const { accountantReadDefinitions, EXTRA_TOOLS } = require('./business-agent-tools');
  const definitions = [...accountantReadDefinitions(readTools), ...EXTRA_TOOLS];
  const entitySchemas = require('./qbo-entity-schema'), estimateConversion = require('./estimate-conversion-policy').SUPPORT;
  const generalTool = definitions.find(tool => tool.name === 'manageQboRecord');
  const operationFields = generalTool?.input_schema?.properties?.operations?.items?.properties || {};
  const exposedEntities = new Set(operationFields.entity?.enum || []), exposedOperations = new Set(operationFields.op?.enum || []);
  const dispatchEnabled = features.generalWriteDispatch === true;
  const declaredOperations = entity => exposedEntities.has(entity) ? (entitySchemas.ENTITIES[entity]?.ops || []).filter(op => exposedOperations.has(op)) : [];
  const inventoryEntities = new Set(['Invoice', 'SalesReceipt', 'Bill', 'Purchase', 'PurchaseOrder', 'Estimate', 'CreditMemo', 'RefundReceipt', 'VendorCredit']);
  const generalWrite = { dispatchEnabled, schemaVersion: entitySchemas.VERSION,
    note: dispatchEnabled ? 'General governed writes are enabled. Every operation still needs current company permission, supported fields and links, period controls and accounting proof; unresolved work can hold a request.' : 'General governed writes can be prepared, but sending is disabled on this server. Approved fixed workflows have their own execution checks.',
    estimateConversion, inventoryEnabled: dispatchEnabled && features.generalWriteInventory === true };
  const tools = definitions.map(tool => {
    const entry = TOOLS[tool.name];
    if (!entry) throw new Error('The accountant tool ' + tool.name + ' has no owner-facing description.');
    // disclosure: core tools are sent on every review; deferred ones are found with searchTools.
    return { name: tool.name, group: entry.group, summary: tool.name === 'manageQboRecord' ? entry.summary + ' ' + generalWrite.note : entry.summary, instructions: tool.description, changesQuickBooks: entry.group === 'quickbooks-write', disclosure: toolDisclosure(tool.name) };
  });
  const queryEntities = definitions.find(tool => tool.name === 'queryCompanyData')?.input_schema?.properties?.entities?.items?.enum || [];
  const readable = new Set([...(readTools.VALID_ENTITY_TYPES || []), ...queryEntities]);
  const rows = [...COVERAGE];
  for (const entity of Object.keys(entitySchemas.ENTITIES)) if (!rows.some(row => row.entity === entity)) rows.push({ area: entity === 'CreditCardPayment' ? 'Banking' : 'Lists', entity, label: entity === 'PaymentMethod' ? 'Payment method' : entity === 'Attachable' ? 'Attached note' : entity === 'CreditCardPayment' ? 'Credit card payment' : entity, create: ['no'] });
  const coverage = rows.map(row => {
    const supported = declaredOperations(row.entity), operations = dispatchEnabled ? supported : [], spec = entitySchemas.ENTITIES[row.entity];
    const create = operations.includes('create') ? 'yes' : row.create[0];
    const change = operations.some(op => ['update', 'void'].includes(op)) ? 'yes' : row.create[0] === 'manual' ? 'manual' : 'no';
    const via = [...(row.create[1] || []), ...(operations.includes('create') ? ['General governed writes'] : [])];
    const notes = [row.note];
    if (row.entity === 'Purchase' && supported.length) notes.push(dispatchEnabled ? spec.notes.find(note => note.includes('PaymentType')) : 'Cheque and card formats are supported by the general schema; general sending is currently disabled.');
    if (['Invoice', 'Estimate'].includes(row.entity)) notes.push(estimateConversion.reason + (estimateConversion.automaticNativeRepair ? ' Eligible existing Invoices can use ' + estimateConversion.repairTool + '; this does not create a new native Invoice.' : ' Automatic native repair is unavailable.'));
    if (row.entity === 'Preferences') notes.push('Only the schema’s selected preference fields are writable. Multicurrency, accounting basis, closing dates, automatic credits and tax settings remain held.');
    if (spec && !exposedEntities.has(row.entity)) notes.push('This entity has a general schema but is not exposed by the accountant’s write tool.');
    if (row.entity === 'Attachable') notes.push('Notes linked to an existing record; file uploads use a separate endpoint and are unavailable here.');
    const inventoryAllowed = generalWrite.inventoryEnabled && features.generalWriteInventoryEntities?.[row.entity] === true && supported.includes('create');
    const inventory = inventoryEntities.has(row.entity) ? { enabled: inventoryAllowed, operations: inventoryAllowed ? ['create'] : [] } : null;
    if (inventory) notes.push(inventory.enabled ? 'General inventory creates are enabled for this type, with accepted FIFO opening, current stock and valuation proof. Changes, removals, mixed-cost returns and direct adjustments remain held.' : 'General inventory activity for this type is disabled by the current server switches; non-stock activity follows its normal contract.');
    return { area: row.area, entity: row.entity, label: row.label || row.entity, read: row.read === false ? false : readable.has(row.entity), create, via, change, operations, general: { supportedOperations: supported, dispatchEnabled: dispatchEnabled && supported.length > 0 }, ...(inventory ? { inventory } : {}), note: notes.filter(Boolean).join(' ') || null };
  });
  // How the accountant finds tools and knowledge (business-agent-toolbox.js, business-agent-skills.js).
  const discovery = metaDefinitions({ skills: true }).map(tool => ({ name: tool.name, summary: DISCOVERY[tool.name], instructions: tool.description }));
  const library = skills || createSkillLibrary();
  const skillList = library.list().map(skill => { let references = 0; try { references = library.load(skill.name).references.length; } catch { /* listed skill became unreadable */ } return { ...skill, references }; });
  const counts = { tools: tools.length, changesQuickBooks: tools.filter(tool => tool.changesQuickBooks).length, core: tools.filter(tool => tool.disclosure === 'core').length, deferred: tools.filter(tool => tool.disclosure === 'deferred').length, skills: skillList.length, recordTypes: coverage.length, canCreate: coverage.filter(row => ['yes', 'limited'].includes(row.create)).length, canChange: coverage.filter(row => row.change === 'yes').length, canVoid: coverage.filter(row => row.operations.includes('void')).length, notBuilt: coverage.filter(row => row.create === 'no').length };
  return { version: 2, groups: GROUPS, tools, discovery, skills: skillList, coverage, counts, generalWrite };
}
module.exports = { agentToolCatalog, TOOLS, COVERAGE };
