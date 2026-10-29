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
  searchEntities: { group: 'quickbooks-read', summary: 'Searches any record type: customers, bills, items, journal entries, settings and more.' },
  getEntityDetail: { group: 'quickbooks-read', summary: 'Reads one record in full.' },
  getTransactionChain: { group: 'quickbooks-read', summary: 'Follows the links between records, such as estimate → invoice → payment → deposit.' },
  runReport: { group: 'quickbooks-read', summary: 'Runs a QuickBooks report, such as profit and loss or aged receivables.' },
  getBusinessState: { group: 'business-read', summary: 'Checks sync status, the published business rules, current work and blockers.' },
  getBusinessWork: { group: 'business-read', summary: 'Reads the work list: its own jobs, what is blocked and why, and what needs the owner.' },
  getObligations: { group: 'business-read', summary: 'Lists unpaid customer invoices or supplier bills.' },
  inspectBusinessOperation: { group: 'business-read', summary: 'Reads a saved accounting plan and how far it got.' },
  getBusinessActivityChoices: { group: 'business-read', summary: 'Lists the customers, services and suppliers it may use for extra activity, and the open imported invoices and bills it may settle.' },
  getBusinessDecision: { group: 'business-read', summary: 'Reads one earlier decision and the owner’s answer.' },
  prepareBusinessPeriod: { group: 'quickbooks-write', summary: 'Plans the scheduled business activity for past days. Plans only; nothing is saved yet.' },
  executeBusinessPeriod: { group: 'quickbooks-write', summary: 'Saves a planned period to QuickBooks, checking every record after it is saved.' },
  prepareBusinessActivity: { group: 'quickbooks-write', summary: 'Plans extra activity for today: paid service sales, paid business expenses (by bill or straight from the bank), supplier credits, customer credits and refunds, bank transfers, journal entries, and collecting or paying invoices and bills left open by the imported history. The same check-and-save path then records it.' },
  resumeBusinessOperation: { group: 'quickbooks-write', summary: 'Restarts its own interrupted work without sending anything twice.' },
  recordBusinessDecision: { group: 'notes', summary: 'Records a business decision with its evidence, or asks the owner a question.' },
  rememberBusinessContext: { group: 'notes', summary: 'Leaves a handoff note for its next review.' },
  linkReproductionCase: { group: 'notes', summary: 'Links a troubleshooting case to its work. Does not run the case.' },
});
// What the accountant can do with each QuickBooks record type.
// yes: an available tool does it. limited: only inside a fixed workflow.
// no: not built yet. manual: QuickBooks does not offer it to apps.
const CALENDAR = 'Scheduled business periods', TODAY = 'Extra activity for today';
const COVERAGE = Object.freeze([
  { area: 'Sales', entity: 'Estimate', create: ['limited', [CALENDAR, TODAY]] },
  { area: 'Sales', entity: 'Invoice', create: ['limited', [CALENDAR, TODAY]] },
  { area: 'Sales', entity: 'Payment', label: 'Customer payment', create: ['limited', [CALENDAR, TODAY]], note: 'For invoices its own workflows created and open invoices from the imported history. Older invoices entered outside the app cannot be collected yet.' },
  { area: 'Sales', entity: 'Deposit', create: ['limited', [CALENDAR, TODAY]] },
  { area: 'Sales', entity: 'SalesReceipt', label: 'Sales receipt', create: ['limited', [CALENDAR]] },
  { area: 'Sales', entity: 'CreditMemo', label: 'Credit memo', create: ['limited', [CALENDAR, TODAY]], note: 'Today: open credits for published services, not applied to invoices. The scheduled credit-and-application cycle is still held back on the real company.' },
  { area: 'Sales', entity: 'RefundReceipt', label: 'Refund receipt', create: ['limited', [TODAY]], note: 'Refunds for published services, paid from the operating bank.' },
  { area: 'Sales', entity: 'TimeActivity', label: 'Time entry', create: ['limited', [CALENDAR, TODAY]] },
  { area: 'Purchases', entity: 'PurchaseOrder', label: 'Purchase order', create: ['limited', [CALENDAR]] },
  { area: 'Purchases', entity: 'Bill', create: ['limited', [CALENDAR, TODAY]] },
  { area: 'Purchases', entity: 'BillPayment', label: 'Bill payment', create: ['limited', [CALENDAR, TODAY]], note: 'For bills its own workflows created and open bills from the imported history. Older bills entered outside the app cannot be paid yet.' },
  { area: 'Purchases', entity: 'Purchase', label: 'Expense / cheque', create: ['limited', [TODAY]], note: 'Operating expenses paid from the operating bank as cash; no cheques or card charges.' },
  { area: 'Purchases', entity: 'VendorCredit', label: 'Supplier credit', create: ['limited', [TODAY]], note: 'Operating-expense credits from published suppliers; applying them to bills is not built yet.' },
  { area: 'Banking', entity: 'Transfer', create: ['limited', [TODAY]], note: 'Between two published bank accounts; the business publishes only one today, so no transfer can be prepared yet.' },
  { area: 'Banking', entity: 'JournalEntry', label: 'Journal entry', create: ['limited', [TODAY]], note: 'Balanced entries on published bank, income and operating-expense accounts; never receivables, payables, undeposited funds or stock.' },
  { area: 'Banking', entity: 'BankReconciliation', label: 'Bank reconciliation', create: ['manual'], read: false },
  { area: 'Lists', entity: 'Customer', create: ['no'] },
  { area: 'Lists', entity: 'Vendor', label: 'Supplier', create: ['no'] },
  { area: 'Lists', entity: 'Item', label: 'Product or service', create: ['no'], note: 'Stock quantities change only through purchases and sales.' },
  { area: 'Lists', entity: 'Employee', create: ['no'] },
  { area: 'Lists', entity: 'Account', create: ['no'] },
  { area: 'Lists', entity: 'Class', create: ['no'] },
  { area: 'Lists', entity: 'Department', label: 'Location', create: ['no'] },
  { area: 'Lists', entity: 'Term', label: 'Payment terms', create: ['no'] },
  { area: 'Settings', entity: 'Preferences', label: 'Company settings', create: ['manual'] },
  { area: 'Settings', entity: 'CompanyInfo', label: 'Company information', create: ['manual'] },
  { area: 'Settings', entity: 'TaxCode', label: 'Sales tax codes and rates', create: ['manual'] },
]);
function agentToolCatalog(readTools = require('./ai-tools')) {
  const { READ_NAMES, EXTRA_TOOLS } = require('./business-agent-tools');
  const definitions = [...readTools.toolDefinitions.filter(tool => READ_NAMES.includes(tool.name)), ...EXTRA_TOOLS];
  const tools = definitions.map(tool => {
    const entry = TOOLS[tool.name];
    if (!entry) throw new Error('The accountant tool ' + tool.name + ' has no owner-facing description.');
    return { name: tool.name, group: entry.group, summary: entry.summary, instructions: tool.description, changesQuickBooks: entry.group === 'quickbooks-write' };
  });
  const readable = new Set(readTools.VALID_ENTITY_TYPES || []);
  const coverage = COVERAGE.map(row => ({ area: row.area, entity: row.entity, label: row.label || row.entity, read: row.read === false ? false : readable.has(row.entity), create: row.create[0], via: row.create[1] || [], change: row.create[0] === 'manual' ? 'manual' : 'no', note: row.note || null }));
  const counts = { tools: tools.length, changesQuickBooks: tools.filter(tool => tool.changesQuickBooks).length, recordTypes: coverage.length, canCreate: coverage.filter(row => ['yes', 'limited'].includes(row.create)).length, notBuilt: coverage.filter(row => row.create === 'no').length };
  return { version: 1, groups: GROUPS, tools, coverage, counts };
}
module.exports = { agentToolCatalog, TOOLS, COVERAGE };
