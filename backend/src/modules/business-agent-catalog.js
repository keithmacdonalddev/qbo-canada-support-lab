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
  inspectBusinessOperation: { group: 'business-read', summary: 'Reads a saved accounting plan and how far it got.' },
  getBusinessActivityChoices: { group: 'business-read', summary: 'Lists the customers, services and suppliers it may use for extra activity (including ones it added earlier), the open imported invoices and bills it may settle, its own open invoices and bills on terms (with balances and due dates) and open estimates, wholly unreceived purchase orders it may receive, and which of its own earlier records it may correct.' },
  getBusinessDecision: { group: 'business-read', summary: 'Reads one earlier decision and the owner’s answer.' },
  prepareBusinessPeriod: { group: 'quickbooks-write', summary: 'Plans the scheduled business activity for past days. Plans only; nothing is saved yet.' },
  executeBusinessPeriod: { group: 'quickbooks-write', summary: 'Saves a planned period to QuickBooks, checking every record after it is saved.' },
  prepareBusinessActivity: { group: 'quickbooks-write', summary: 'Plans extra activity for today: invoices and bills on payment terms left open, later collected or paid in full or in part; estimates sent and later converted to invoices; stock purchase orders; correcting its own earlier records by reversing them, adding customers, suppliers and service items, paid service sales, paid business expenses (by bill or straight from the bank), receiving whole purchase orders into inventory bills, supplier credits, customer credits and refunds, bank transfers, journal entries, and collecting or paying invoices and bills left open by the imported history. The same check-and-save path then records it.' },
  resumeBusinessOperation: { group: 'quickbooks-write', summary: 'Restarts its own interrupted work without sending anything twice.' },
  recordBusinessDecision: { group: 'notes', summary: 'Records a business decision with its evidence, or asks the owner a question.' },
  rememberBusinessContext: { group: 'notes', summary: 'Leaves a handoff note for its next review.' },
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
  { area: 'Sales', entity: 'Estimate', create: ['limited', [CALENDAR, TODAY]], note: 'Today: field-service estimates sent on their own stay open, and are converted on a later day into a time entry and an invoice on terms at the quoted hours and price (whole estimate only).' },
  { area: 'Sales', entity: 'Invoice', create: ['limited', [CALENDAR, TODAY]], note: 'Today: settled same-day sales, and invoices on payment terms (7 to 60 days) left open until the customer pays.' },
  { area: 'Sales', entity: 'Payment', label: 'Customer payment', create: ['limited', [CALENDAR, TODAY]], note: 'For invoices its own workflows created and open invoices from the imported history; its own invoices on terms can be collected in full or in part on any later day, then deposited. Older invoices entered outside the app cannot be collected yet.' },
  { area: 'Sales', entity: 'Deposit', create: ['limited', [CALENDAR, TODAY]] },
  { area: 'Sales', entity: 'SalesReceipt', label: 'Sales receipt', create: ['limited', [CALENDAR]] },
  { area: 'Sales', entity: 'CreditMemo', label: 'Credit memo', create: ['limited', [CALENDAR, TODAY]], note: 'Today: open credits for published services, and full credits that correct its own wholly unpaid service invoices (applied to them at the original tax rate). The scheduled credit-and-application cycle is still held back on the real company.' },
  { area: 'Sales', entity: 'RefundReceipt', label: 'Refund receipt', create: ['limited', [TODAY]], note: 'Refunds for published services, paid from the operating bank, including refunds that correct its own fully collected service sales at the original tax rate.' },
  { area: 'Sales', entity: 'TimeActivity', label: 'Time entry', create: ['limited', [CALENDAR, TODAY]] },
  { area: 'Purchases', entity: 'PurchaseOrder', label: 'Purchase order', create: ['limited', [CALENDAR, TODAY]], note: 'Today: purchase orders for one to five workshop stock items from published stock suppliers. PurchaseOrder → Bill receiving is available for wholly unreceived orders created by its own workflows or adopted import, in full at original cost; partial receipts unavailable.' },
  { area: 'Purchases', entity: 'Bill', create: ['limited', [CALENDAR, TODAY]], note: 'Includes operating bills on payment terms left open until paid, and unpaid inventory receiving bills linked to the original purchase-order lines.' },
  { area: 'Purchases', entity: 'BillPayment', label: 'Bill payment', create: ['limited', [CALENDAR, TODAY]], note: 'For bills its own workflows created and open bills from the imported history; its own bills on terms can be paid in full or in part on any later day. Older bills entered outside the app cannot be paid yet.' },
  { area: 'Purchases', entity: 'Purchase', label: 'Expense / cheque', create: ['limited', [TODAY]], note: 'Operating expenses paid from the operating bank as cash; no cheques or card charges.' },
  { area: 'Purchases', entity: 'VendorCredit', label: 'Supplier credit', create: ['limited', [TODAY]], note: 'Operating-expense credits from published suppliers. A credit is applied to a bill only when it corrects the accountant’s own wholly unpaid operating bill (zero-funds bill payment).' },
  { area: 'Banking', entity: 'Transfer', create: ['limited', [TODAY]], note: 'Between two published bank accounts; the business publishes only one today, so no transfer can be prepared yet.' },
  { area: 'Banking', entity: 'JournalEntry', label: 'Journal entry', create: ['limited', [TODAY]], note: 'Balanced entries on published bank, income and operating-expense accounts; never receivables, payables, undeposited funds or stock. Its own entries can be corrected by an exact reversing entry.' },
  { area: 'Banking', entity: 'BankReconciliation', label: 'Bank reconciliation', create: ['manual'], read: false },
  { area: 'Lists', entity: 'Customer', create: ['limited', [TODAY]], note: 'New customers can be used in a later batch, for service sales.' },
  { area: 'Lists', entity: 'Vendor', label: 'Supplier', create: ['limited', [TODAY]], note: 'New suppliers can be used in a later batch, for paid bills.' },
  { area: 'Lists', entity: 'Item', label: 'Product or service', create: ['limited', [TODAY]], note: 'New service items only; stock quantities change only through purchases and sales.' },
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
function agentToolCatalog(readTools = require('./ai-tools'), skills = null) {
  const { toolDisclosure, metaDefinitions } = require('./business-agent-toolbox');
  const { createSkillLibrary } = require('./business-agent-skills');
  const { accountantReadDefinitions, EXTRA_TOOLS } = require('./business-agent-tools');
  const definitions = [...accountantReadDefinitions(readTools), ...EXTRA_TOOLS];
  const tools = definitions.map(tool => {
    const entry = TOOLS[tool.name];
    if (!entry) throw new Error('The accountant tool ' + tool.name + ' has no owner-facing description.');
    // disclosure: core tools are sent on every review; deferred ones are found with searchTools.
    return { name: tool.name, group: entry.group, summary: entry.summary, instructions: tool.description, changesQuickBooks: entry.group === 'quickbooks-write', disclosure: toolDisclosure(tool.name) };
  });
  const readable = new Set(readTools.VALID_ENTITY_TYPES || []);
  const coverage = COVERAGE.map(row => ({ area: row.area, entity: row.entity, label: row.label || row.entity, read: row.read === false ? false : readable.has(row.entity), create: row.create[0], via: row.create[1] || [], change: row.create[0] === 'manual' ? 'manual' : 'no', note: row.note || null }));
  // How the accountant finds tools and knowledge (business-agent-toolbox.js, business-agent-skills.js).
  const discovery = metaDefinitions({ skills: true }).map(tool => ({ name: tool.name, summary: DISCOVERY[tool.name], instructions: tool.description }));
  const library = skills || createSkillLibrary();
  const skillList = library.list().map(skill => { let references = 0; try { references = library.load(skill.name).references.length; } catch { /* listed skill became unreadable */ } return { ...skill, references }; });
  const counts = { tools: tools.length, changesQuickBooks: tools.filter(tool => tool.changesQuickBooks).length, core: tools.filter(tool => tool.disclosure === 'core').length, deferred: tools.filter(tool => tool.disclosure === 'deferred').length, skills: skillList.length, recordTypes: coverage.length, canCreate: coverage.filter(row => ['yes', 'limited'].includes(row.create)).length, notBuilt: coverage.filter(row => row.create === 'no').length };
  return { version: 1, groups: GROUPS, tools, discovery, skills: skillList, coverage, counts };
}
module.exports = { agentToolCatalog, TOOLS, COVERAGE };
