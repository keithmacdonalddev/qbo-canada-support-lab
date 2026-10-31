'use strict';
// Business choices only. This module never accepts a QBO payload or performs I/O.
const { hash, canonical, date, shift } = require('./business-calendar');
const { businessDate } = require('./business-activity-preview');
// Policy v8 adds business lifecycles over time: a service invoice or operating bill
// left open on payment terms, and later full or partial collection or payment of the
// accountant's OWN open terms invoices and bills; a field-service estimate sent on its
// own and later converted into time and an invoice on terms; and a stock purchase
// order received later (business-own-settlement.js derives and proves each original).
// v7 added correct-own-record (business-correction.js).
const POLICY = Object.freeze({ version: 8, key: 'business-activity-v8', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill', 'paid-cash-expense', 'supplier-credit', 'customer-credit', 'customer-refund', 'bank-transfer', 'journal-entry', 'receive-purchase-order', 'add-customer', 'add-supplier', 'add-item', 'correct-own-record', 'invoice-on-terms', 'collect-own-invoice', 'bill-on-terms', 'pay-own-bill', 'send-estimate', 'convert-own-estimate', 'order-stock'] });
// Frozen exactly as they were published (hashes unchanged), so v6 and v7 batches rebuild.
const POLICY_V7 = Object.freeze({ version: 7, key: 'business-activity-v7', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill', 'paid-cash-expense', 'supplier-credit', 'customer-credit', 'customer-refund', 'bank-transfer', 'journal-entry', 'receive-purchase-order', 'add-customer', 'add-supplier', 'add-item', 'correct-own-record'] });
const POLICY_V6 = Object.freeze({ version: 6, key: 'business-activity-v6', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill', 'paid-cash-expense', 'supplier-credit', 'customer-credit', 'customer-refund', 'bank-transfer', 'journal-entry', 'receive-purchase-order', 'add-customer', 'add-supplier', 'add-item'] });
const POLICY_V5 = Object.freeze({ version: 5, key: 'business-activity-v5', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill', 'paid-cash-expense', 'supplier-credit', 'customer-credit', 'customer-refund', 'bank-transfer', 'journal-entry', 'receive-purchase-order'] });
// Settlements of adopted (imported) obligations name the QuickBooks record and its
// business party; preparation and compilation prove both against the adoption.
const PARTY = /^(field-client-0(?:0[1-9]|1[0-5])|care-client-0(?:0[1-9]|1[0-9]|2[0-5]))$/, SUPPLIER = /^(overhead|stock)-supplier-[1-3]$/, QBO_ID = /^\d{1,30}$/;
const POLICY_HASH = hash(POLICY), HASH = /^[a-f0-9]{64}$/;
// Earlier policies, kept so batches saved under them can still be read and
// verified. New batches always use POLICY.
const POLICY_V1 = Object.freeze({ version: 1, key: 'non-stock-business-activity-v1', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense'] });
const POLICY_V2 = Object.freeze({ version: 2, key: 'business-activity-v2', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill'] });
const POLICY_V3 = Object.freeze({ version: 3, key: 'business-activity-v3', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill', 'paid-cash-expense', 'supplier-credit'] });
const POLICY_V4 = Object.freeze({ version: 4, key: 'business-activity-v4', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill', 'paid-cash-expense', 'supplier-credit', 'customer-credit', 'customer-refund', 'bank-transfer', 'journal-entry'] });
const SAVED_POLICIES = new Map([[hash(POLICY_V1), POLICY_V1], [hash(POLICY_V2), POLICY_V2], [hash(POLICY_V3), POLICY_V3], [hash(POLICY_V4), POLICY_V4], [hash(POLICY_V5), POLICY_V5], [hash(POLICY_V6), POLICY_V6], [hash(POLICY_V7), POLICY_V7], [POLICY_HASH, POLICY]]);
// Policy v8 payment terms: whole days from the transaction date to the due date.
const TERMS_DAYS = Object.freeze([7, 15, 30, 45, 60]);
// Policy v8 stock purchase orders: whole units per line.
const STOCK_ORDER_QUANTITY = 500;
// Policy v8 settlements of the accountant's own open terms invoices and bills.
const OWN_SETTLEMENT = Object.freeze({ 'collect-own-invoice': { entity: 'Invoice', idKey: 'invoiceId', partyKey: 'customerKey' }, 'pay-own-bill': { entity: 'Bill', idKey: 'billId', partyKey: 'vendorKey' } });
// Every v8 activity that builds on one of the accountant's own earlier records, whose
// `source` the server derives (a settlement, or converting a sent estimate).
const OWN_SOURCED = Object.freeze({ ...OWN_SETTLEMENT, 'convert-own-estimate': { entity: 'Estimate', idKey: 'estimateId', partyKey: 'customerKey' } });
// Policy v7 corrections. Each kind reverses one wholly unpaid or fully collected
// non-stock original, dated today, with its ORIGINAL lines, party and tax. Applications
// are zero-funds settlements linking the original and its reversal. Step keys are
// derived from the original (not the batch), so any second correction of the same
// record collides with the first on the unique step identity.
const CORRECTION = Object.freeze({
  'credit-unpaid-invoice': { targets: ['Invoice'], steps: [['correction-credit', 'CreditMemo', ['original']], ['correction-application', 'Payment', ['original', 'correction-credit']]] },
  'refund-collected-sale': { targets: ['Invoice', 'SalesReceipt'], steps: [['correction-refund', 'RefundReceipt', ['original']]] },
  'credit-unpaid-bill': { targets: ['Bill'], steps: [['correction-vendor-credit', 'VendorCredit', ['original']], ['correction-bill-application', 'BillPayment', ['original', 'correction-vendor-credit']]] },
  'reverse-journal': { targets: ['JournalEntry'], steps: [['correction-journal', 'JournalEntry', ['original']]] },
});
// A correction's credit step also carries the earliest date across the original and its
// source records (estimate, time…): the later zero-funds application links them all, so
// the write gate refuses the credit while any of those dates is protected.
const CREDIT_STEPS = Object.freeze(['correction-credit', 'correction-vendor-credit']);
const CORRECTION_MODES = Object.freeze({ 'correction-credit': 'correction-credit', 'correction-application': 'correction-application', 'correction-refund': 'correction-refund', 'correction-vendor-credit': 'correction-supplier-credit', 'correction-bill-application': 'correction-bill-application', 'correction-journal': 'correction-journal' });
const CORRECTION_TARGETS = Object.freeze(['Invoice', 'SalesReceipt', 'Bill', 'JournalEntry']);
const SOURCE_ENTITIES = new Set(['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment', 'JournalEntry']);
const correctionRuleKey = original => 'correction-' + original.logicalKey.slice(0, 40);
// Policy v6: customers, suppliers and service items the accountant added. Each gets a
// deterministic role key from its creating batch; it becomes usable only in a LATER
// batch, after that batch's operation verified (see business-added-roles.js).
const ADDED = Object.freeze({ customer: /^added-customer-[a-f0-9]{12}$/, supplier: /^added-supplier-[a-f0-9]{12}$/, item: /^added-item-[a-f0-9]{12}$/ });
const ADDED_INCOME = Object.freeze(['serviceIncome', 'careIncome', 'supplyIncome']), ADDED_UNITS = Object.freeze(['hours', 'month', 'each']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9 &.,'()-]{1,79}$/, EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/, PHONE = /^[0-9 +().-]{7,25}$/;
const addedRoleKey = (kind, batchKey, index) => 'added-' + kind + '-' + hash({ addedRole: kind, batchKey, index }).slice(0, 12);
function listName(value) { if (typeof value !== 'string' || value !== value.trim() || !NAME.test(value) || /\s{2}/.test(value)) fail("Use a plain name of 2 to 80 letters, digits, spaces and & . , ' ( ) -."); return value; }
function partyFields(row) {
  const keys = Object.keys(row || {});
  if (!row || Object.getPrototypeOf(row) !== Object.prototype || keys.some(key => !['type', 'name', 'email', 'phone', 'purpose'].includes(key)) || !keys.includes('name') || !keys.includes('purpose')) fail('Add a party with its name, an optional email and phone, and a business purpose.');
  if (row.email !== undefined && (typeof row.email !== 'string' || row.email.length > 100 || !EMAIL.test(row.email))) fail('Use a plain email address.');
  if (row.phone !== undefined && (typeof row.phone !== 'string' || !PHONE.test(row.phone))) fail('Use a plain phone number.');
  return { type: row.type, name: listName(row.name), ...(row.email !== undefined ? { email: row.email } : {}), ...(row.phone !== undefined ? { phone: row.phone } : {}), purpose: text(row.purpose, 10, 500) };
}
const SERVICES = ['field-service-hour', 'care-plan-1', 'care-plan-2', 'care-plan-3'];
// Journal entries may only touch these mapped roles: no receivables or payables (they
// need a party), no undeposited funds (deposits prove those) and no stock accounts
// (stock cost is proven by its own FIFO evidence).
// Reclassifications only: no bank line, so a journal entry can never create
// income, spending or cash without a customer, supplier and tax.
const JOURNAL_ROLES = Object.freeze(['serviceIncome', 'supplyIncome', 'careIncome', 'operatingExpense']);
// Bank roles the business blueprint maps. A transfer needs two of them.
const bankRoles = () => Object.entries(require('./blueprint-draft').MAPPINGS).filter(([, role]) => role.entity === 'Account' && role.types.includes('Bank')).map(([key]) => key);
function journalLines(lines, check) {
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 4) check('A journal entry needs two to four lines.');
  let debit = 0, credit = 0;
  for (const line of lines) {
    if (!JOURNAL_ROLES.includes(line?.accountKey ?? line?.accountMapping) || !['Debit', 'Credit'].includes(line.postingType) || !Number.isSafeInteger(line.amountCents) || line.amountCents < 1 || line.amountCents > POLICY.maxExpenseCents) check('Journal lines use published bank, income or operating-expense roles with a debit or credit within capacity.');
    if (line.postingType === 'Debit') debit += line.amountCents; else credit += line.amountCents;
  }
  if (!debit || debit !== credit) check('A journal entry must balance: total debits equal total credits.');
  return debit;
}
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_ACTIVITY_UNVERIFIED' }); }
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('Use the supported business choices without raw accounting or authority overrides.'); }
function text(value, min, max) { if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u001f]/.test(value)) fail('Retain a concise business purpose and unique decision identifier.'); return value.trim(); }
function integer(value, max) { if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('Business amounts and quantities exceed this activity batch capacity.'); return value; }
// ---- Policy v7 correction terms (all derived by business-correction.js) ----
const CORRECTION_FAIL = 'Use the correction terms derived by the server for one of your own records.';
function correctionDate(value) { try { date(value); } catch { fail(CORRECTION_FAIL); } return value; }
function originalTerms(value) {
  exact(value, ['entity', 'qboId', 'logicalKey', 'fingerprint', 'txnDate', 'policyHash', 'compilationHash']);
  if (!CORRECTION_TARGETS.includes(value.entity) || !QBO_ID.test(value.qboId || '') || ![value.logicalKey, value.fingerprint, value.policyHash, value.compilationHash].every(key => HASH.test(key || ''))) fail(CORRECTION_FAIL);
  correctionDate(value.txnDate);
  return { entity: value.entity, qboId: value.qboId, logicalKey: value.logicalKey, fingerprint: value.fingerprint, txnDate: value.txnDate, policyHash: value.policyHash, compilationHash: value.compilationHash };
}
// The original sale's service lines, unchanged: published services only.
function correctionSaleLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 20) fail(CORRECTION_FAIL);
  const keys = new Set();
  return lines.map(line => {
    exact(line, ['key', 'itemKey', 'quantity', 'unit', 'unitPriceCents', 'amountCents', 'accountMapping']);
    const field = line.itemKey === 'field-service-hour';
    if (typeof line.key !== 'string' || !/^[a-z0-9-]{1,40}$/.test(line.key) || keys.has(line.key) || !SERVICES.includes(line.itemKey) || line.unit !== (field ? 'hours' : 'month') || line.accountMapping !== (field ? 'serviceIncome' : 'careIncome') || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 1000 || !Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 1 || line.unitPriceCents > 10000000 || line.amountCents !== line.quantity * line.unitPriceCents) fail('A correction reverses the original published service lines exactly.');
    keys.add(line.key);
    return { key: line.key, itemKey: line.itemKey, quantity: line.quantity, unit: line.unit, unitPriceCents: line.unitPriceCents, amountCents: line.amountCents, accountMapping: line.accountMapping };
  });
}
function correctionExpenseLines(lines) {
  if (!Array.isArray(lines) || lines.length !== 1) fail(CORRECTION_FAIL);
  const line = lines[0]; exact(line, ['key', 'accountMapping', 'amountCents', 'billableStatus']);
  if (line.key !== 'primary' || line.accountMapping !== 'operatingExpense' || line.billableStatus !== 'NotBillable' || !Number.isSafeInteger(line.amountCents) || line.amountCents < 1 || line.amountCents > POLICY.maxSettlementCents) fail('A supplier correction reverses the original nonbillable operating expense exactly.');
  return [{ key: 'primary', accountMapping: 'operatingExpense', amountCents: line.amountCents, billableStatus: 'NotBillable' }];
}
// A reversing journal entry: the original lines with debit and credit exchanged.
function correctionJournalLines(lines) {
  if (!Array.isArray(lines)) fail(CORRECTION_FAIL);
  for (const [n, line] of lines.entries()) { exact(line, ['key', 'accountMapping', 'postingType', 'amountCents']); if (line.key !== 'line-' + (n + 1)) fail(CORRECTION_FAIL); }
  const total = journalLines(lines, fail);
  return { total, lines: lines.map(line => ({ key: line.key, accountMapping: line.accountMapping, postingType: line.postingType, amountCents: line.amountCents })) };
}
// The ORIGINAL supply's tax (CRA Notice 342: a price reversal is credited at the rate
// that applied to the original supply), exact to the cent and bound to the full base.
function originalTaxTerms(value, base) {
  exact(value, ['codeId', 'totalTaxCents', 'lines']);
  if (!QBO_ID.test(value.codeId || '') || !Number.isSafeInteger(value.totalTaxCents) || value.totalTaxCents < 0 || !Array.isArray(value.lines) || !value.lines.length || value.lines.length > 5) fail('A correction keeps the exact original tax.');
  const ids = new Set(), lines = value.lines.map(line => {
    exact(line, ['rateId', 'percent', 'taxableCents', 'amountCents']);
    if (!QBO_ID.test(line.rateId || '') || ids.has(line.rateId) || typeof line.percent !== 'number' || !Number.isFinite(line.percent) || line.percent < 0 || line.percent > 100 || line.taxableCents !== base || !Number.isSafeInteger(line.amountCents) || line.amountCents < 0) fail('A correction keeps the exact original tax.');
    ids.add(line.rateId); return { rateId: line.rateId, percent: line.percent, taxableCents: line.taxableCents, amountCents: line.amountCents };
  });
  if (lines.reduce((sum, line) => sum + line.amountCents, 0) !== value.totalTaxCents) fail('A correction keeps the exact original tax.');
  return { codeId: value.codeId, totalTaxCents: value.totalTaxCents, lines };
}
// The original and its saved dependency closure (estimate, time…), each already
// verified history; they become the batch's existing prerequisites.
function correctionSources(sources, original) {
  if (!Array.isArray(sources) || !sources.length || sources.length > 10) fail(CORRECTION_FAIL);
  const keys = new Set(sources.map(row => row?.logicalKey));
  const rows = sources.map(row => {
    exact(row, ['logicalKey', 'entity', 'txnDate', 'dependsOn']); correctionDate(row.txnDate);
    if (!HASH.test(row.logicalKey || '') || !SOURCE_ENTITIES.has(row.entity) || row.txnDate > original.txnDate || !Array.isArray(row.dependsOn) || row.dependsOn.length > 20 || row.dependsOn.some(key => !keys.has(key) || key === row.logicalKey) || new Set(row.dependsOn).size !== row.dependsOn.length) fail(CORRECTION_FAIL);
    return { logicalKey: row.logicalKey, entity: row.entity, txnDate: row.txnDate, dependsOn: [...row.dependsOn].sort() };
  });
  if (keys.size !== rows.length || rows.some((row, i) => i && rows[i - 1].logicalKey >= row.logicalKey) || !rows.some(row => row.logicalKey === original.logicalKey && row.entity === original.entity && row.txnDate === original.txnDate)) fail(CORRECTION_FAIL);
  return rows;
}
// Returns the normalized correction and its gross amount for batch capacity.
function correctionChoice(row) {
  const { target, correction: c } = row;
  exact(target, ['entity', 'qboId']);
  if (!CORRECTION_TARGETS.includes(target.entity) || !QBO_ID.test(target.qboId || '')) fail('Choose one of your own invoices, sales receipts, bills or journal entries listed in correctableRecords.');
  if (c === undefined) return { value: { type: row.type, target: { entity: target.entity, qboId: target.qboId }, purpose: text(row.purpose, 10, 500) }, cents: 0 };
  const spec = CORRECTION[c?.kind];
  if (!spec || !spec.targets.includes(target.entity)) fail(CORRECTION_FAIL);
  const sales = ['credit-unpaid-invoice', 'refund-collected-sale'].includes(c.kind), bill = c.kind === 'credit-unpaid-bill';
  exact(c, ['kind', 'original', 'sources', ...(sales ? ['customerKey', 'lines', 'tax'] : bill ? ['vendorKey', 'expenseCategory', 'lines', 'tax'] : ['lines'])]);
  const original = originalTerms(c.original);
  if (original.entity !== target.entity || original.qboId !== target.qboId) fail(CORRECTION_FAIL);
  const value = { kind: c.kind, original, sources: correctionSources(c.sources, original) };
  let gross;
  if (sales) {
    if (!PARTY.test(c.customerKey || '')) fail('Only records for published customers can be corrected.');
    value.customerKey = c.customerKey; value.lines = correctionSaleLines(c.lines);
    const base = value.lines.reduce((sum, line) => sum + line.amountCents, 0); value.tax = originalTaxTerms(c.tax, base); gross = base + value.tax.totalTaxCents;
  } else if (bill) {
    if (!/^overhead-supplier-[1-3]$/.test(c.vendorKey || '') || !['premises', 'utilities', 'software'].includes(c.expenseCategory)) fail('Only operating bills from published suppliers can be corrected.');
    value.vendorKey = c.vendorKey; value.expenseCategory = c.expenseCategory; value.lines = correctionExpenseLines(c.lines);
    value.tax = originalTaxTerms(c.tax, value.lines[0].amountCents); gross = value.lines[0].amountCents + value.tax.totalTaxCents;
  } else { const journal = correctionJournalLines(c.lines); value.lines = journal.lines; gross = journal.total; }
  if (gross < 1 || gross > POLICY.maxSettlementCents) fail('This correction exceeds the per-record correction capacity.');
  return { value: { type: row.type, target: { entity: target.entity, qboId: target.qboId }, purpose: text(row.purpose, 10, 500), correction: value }, cents: gross };
}
// ---- Policy v8 settlements of the accountant's own open terms invoices and bills ----
// The agent names the record, its party and the amount; the server adds `source` (the
// original's identity and its saved dependency closure) from its immutable creation.
function ownSettlementChoice(row) {
  const spec = OWN_SETTLEMENT[row.type];
  exact(row, ['type', spec.idKey, spec.partyKey, 'amountCents', 'purpose', ...(row.source !== undefined ? ['source'] : [])]);
  if (!QBO_ID.test(row[spec.idKey] || '') || !(spec.entity === 'Invoice' ? PARTY : /^overhead-supplier-[1-3]$/).test(row[spec.partyKey] || '')) fail('Choose one of your own open ' + (spec.entity === 'Invoice' ? 'invoices on terms and its customer' : 'bills on terms and its supplier') + ' from the business choices.');
  const value = { type: row.type, [spec.idKey]: row[spec.idKey], [spec.partyKey]: row[spec.partyKey], amountCents: integer(row.amountCents, POLICY.maxSettlementCents), purpose: text(row.purpose, 10, 500) };
  if (row.source !== undefined) value.source = ownSource(row.source, spec.entity);
  return value;
}
function ownSource(source, entity) {
  exact(source, ['logicalKey', 'txnDate', 'sources']);
  if (!HASH.test(source.logicalKey || '')) fail('Use the source derived by the server for one of your own records.');
  const original = { logicalKey: source.logicalKey, entity, txnDate: correctionDate(source.txnDate) };
  return { logicalKey: original.logicalKey, txnDate: original.txnDate, sources: correctionSources(source.sources, original) };
}
// Converting a sent estimate (policy v8): the agent names the estimate, its customer and
// the invoice terms; the server adds `source` and the quoted `quote` from the estimate's
// immutable creation. Only field-service quotes, which bill their recorded time.
function estimateConversionChoice(row) {
  const derived = row.source !== undefined || row.quote !== undefined;
  exact(row, ['type', 'estimateId', 'customerKey', 'termsDays', 'purpose', ...(derived ? ['source', 'quote'] : [])]);
  if (!QBO_ID.test(row.estimateId || '') || !/^field-client-0(?:0[1-9]|1[0-5])$/.test(row.customerKey || '')) fail('Choose one of your own open field-service estimates and its customer from the business choices.');
  if (!TERMS_DAYS.includes(row.termsDays)) fail('Use payment terms of ' + TERMS_DAYS.join(', ') + ' days.');
  const value = { type: row.type, estimateId: row.estimateId, customerKey: row.customerKey, termsDays: row.termsDays, purpose: text(row.purpose, 10, 500) };
  if (derived) {
    exact(row.quote, ['itemKey', 'quantity', 'unitPriceCents']);
    if (row.quote.itemKey !== 'field-service-hour') fail('Only field-service estimates can be converted.');
    value.source = ownSource(row.source, 'Estimate');
    value.quote = { itemKey: row.quote.itemKey, quantity: integer(row.quote.quantity, POLICY.maxQuantity), unitPriceCents: integer(row.quote.unitPriceCents, POLICY.maxUnitPriceCents) };
  }
  return value;
}
function correctionDetail(c, stepKey) {
  const base = c.lines.reduce((sum, line) => sum + (line.postingType === 'Credit' ? 0 : line.amountCents), 0);
  const sale = { customerKey: c.customerKey, lines: structuredClone(c.lines), baseAmountCents: base, taxMapping: 'salesTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax', originalTax: structuredClone(c.tax) };
  switch (stepKey) {
    case 'correction-credit': return sale;
    case 'correction-refund': return { ...sale, bankMapping: 'operatingBank', cashDirection: 'outflow', fundingSource: 'operating_bank' };
    case 'correction-application': return { customerKey: c.customerKey, bankMapping: 'operatingBank', destination: 'operating_bank', cashDirection: 'none', amountRule: 'correction_application', amountSourceKey: c.original.logicalKey, taxStatus: 'included_in_originating_total' };
    case 'correction-vendor-credit': return { vendorKey: c.vendorKey, expenseCategory: c.expenseCategory, lines: structuredClone(c.lines), baseAmountCents: base, taxMapping: 'purchaseTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax', originalTax: structuredClone(c.tax) };
    case 'correction-bill-application': return { vendorKey: c.vendorKey, bankMapping: 'operatingBank', fundingSource: 'operating_bank', cashDirection: 'none', amountRule: 'correction_application', amountSourceKey: c.original.logicalKey, taxStatus: 'included_in_originating_total' };
    case 'correction-journal': return { lines: structuredClone(c.lines), baseAmountCents: base, amountRule: 'balanced_journal' };
    default: return fail(CORRECTION_FAIL);
  }
}
// policy: the version the batch is (or was) saved under. Older versions keep their
// exact original rules; only v6 accepts accountant-added roles and list additions.
function validateChoices(input, policy = POLICY) {
  exact(input, ['decisionKey', 'purpose', 'activities']);
  const v6 = policy.version >= 6, names = new Set();
  const decisionKey = text(input.decisionKey, 8, 100), purpose = text(input.purpose, 20, 2000);
  if (!/^[a-zA-Z0-9_-]+$/.test(decisionKey) || !Array.isArray(input.activities) || input.activities.length < 1 || input.activities.length > POLICY.maxActivities) fail('Choose one to twelve concrete business activities and retain their decision identifier.');
  let cents = 0; const settled = new Set();
  const activities = input.activities.map(row => {
    if (!policy.workflows.includes(row?.type)) fail('This activity is not part of the saved activity policy.');
    if (row?.type === 'settled-service-sale') {
      // An added item carries its retained capabilities; preparation proves them
      // against the verified role, so the sale rebuilds without any company read.
      const addedItem = v6 && ADDED.item.test(row.itemKey || '');
      exact(row, ['type', 'customerKey', 'itemKey', 'quantity', 'unitPriceCents', 'purpose', ...(addedItem ? ['incomeRole', 'unit'] : [])]);
      if (!(/^(field-client-0(?:0[1-9]|1[0-5])|care-client-0(?:0[1-9]|1[0-9]|2[0-5]))$/.test(row.customerKey || '') || (v6 && ADDED.customer.test(row.customerKey || ''))) || !(['field-service-hour', 'care-plan-1', 'care-plan-2', 'care-plan-3'].includes(row.itemKey) || addedItem)) fail('Choose an observed service and customer role from the published business.');
      if (addedItem && (!ADDED_INCOME.includes(row.incomeRole) || !ADDED_UNITS.includes(row.unit))) fail("An added item sale names the item's income role and unit.");
      const quantity = integer(row.quantity, POLICY.maxQuantity), unitPriceCents = integer(row.unitPriceCents, POLICY.maxUnitPriceCents);
      cents += quantity * unitPriceCents;
      return { type: row.type, customerKey: row.customerKey, itemKey: row.itemKey, quantity, unitPriceCents, ...(addedItem ? { incomeRole: row.incomeRole, unit: row.unit } : {}), purpose: text(row.purpose, 10, 500) };
    }
    if (row?.type === 'add-customer' || row?.type === 'add-supplier') {
      const value = partyFields(row), folded = value.name.toLowerCase();
      if (names.has(folded)) fail('Add each name once per batch.'); names.add(folded);
      return value;
    }
    if (row?.type === 'add-item') {
      exact(row, ['type', 'name', 'incomeRole', 'unit', 'unitPriceCents', 'purpose']);
      if (!ADDED_INCOME.includes(row.incomeRole) || !ADDED_UNITS.includes(row.unit)) fail('An added service item uses a published income role and a unit (hours, month or each).');
      const name = listName(row.name), folded = 'item:' + name.toLowerCase();
      if (names.has(folded)) fail('Add each name once per batch.'); names.add(folded);
      return { type: row.type, name, incomeRole: row.incomeRole, unit: row.unit, unitPriceCents: integer(row.unitPriceCents, POLICY.maxUnitPriceCents), purpose: text(row.purpose, 10, 500) };
    }
    // A paid operating expense is a supplier bill paid the same day; a cash expense is
    // paid directly from the bank (Purchase); a supplier credit reduces what is owed.
    if (['paid-operating-expense', 'paid-cash-expense', 'supplier-credit'].includes(row?.type)) {
      exact(row, ['type', 'vendorKey', 'category', 'amountCents', 'purpose']);
      // Added suppliers may receive a same-day paid bill; cash expenses and credits keep published suppliers.
      if (!(/^overhead-supplier-[1-3]$/.test(row.vendorKey || '') || (v6 && row.type === 'paid-operating-expense' && ADDED.supplier.test(row.vendorKey || ''))) || !['premises', 'utilities', 'software'].includes(row.category)) fail('Choose a published operating supplier and expense category.');
      const amountCents = integer(row.amountCents, POLICY.maxExpenseCents); cents += amountCents;
      return { type: row.type, vendorKey: row.vendorKey, category: row.category, amountCents, purpose: text(row.purpose, 10, 500) };
    }
    // A customer credit (open credit memo) or a refund paid from the operating bank for a
    // published service, priced like a sale.
    if (row?.type === 'customer-credit' || row?.type === 'customer-refund') {
      exact(row, ['type', 'customerKey', 'itemKey', 'quantity', 'unitPriceCents', 'purpose']);
      if (!PARTY.test(row.customerKey || '') || !SERVICES.includes(row.itemKey)) fail('Choose an observed service and customer role from the published business.');
      const quantity = integer(row.quantity, POLICY.maxQuantity), unitPriceCents = integer(row.unitPriceCents, POLICY.maxUnitPriceCents);
      cents += quantity * unitPriceCents;
      return { type: row.type, customerKey: row.customerKey, itemKey: row.itemKey, quantity, unitPriceCents, purpose: text(row.purpose, 10, 500) };
    }
    if (row?.type === 'receive-purchase-order') {
      exact(row, ['type', 'purchaseOrderId', 'vendorKey', 'source', 'lines', 'purpose']);
      exact(row.source, ['kind', 'logicalKey', 'txnDate']); date(row.source.txnDate);
      if (!QBO_ID.test(row.purchaseOrderId || '') || !/^stock-supplier-[1-3]$/.test(row.vendorKey || '') || !['managed', 'adopted'].includes(row.source.kind) || !HASH.test(row.source.logicalKey || '') || !Array.isArray(row.lines) || !row.lines.length || row.lines.length > 20) fail('Choose one owned, wholly unreceived purchase order from the receiving choices.');
      if (settled.has('PurchaseOrder:' + row.purchaseOrderId)) fail('Receive each purchase order once per batch.'); settled.add('PurchaseOrder:' + row.purchaseOrderId);
      const seen = new Set(), lines = row.lines.map(line => {
        exact(line, ['lineId', 'itemKey', 'quantity', 'unitPriceCents']);
        if (!QBO_ID.test(line.lineId || '') || seen.has(line.lineId) || !/^workshop-stock-[1-5]$/.test(line.itemKey || '')) fail('Use the exact published purchase-order lines.'); seen.add(line.lineId);
        const quantity = integer(line.quantity, 1000000), unitPriceCents = integer(line.unitPriceCents, POLICY.maxUnitPriceCents); cents += quantity * unitPriceCents;
        return { lineId: line.lineId, itemKey: line.itemKey, quantity, unitPriceCents };
      });
      return { type: row.type, purchaseOrderId: row.purchaseOrderId, vendorKey: row.vendorKey, source: { ...row.source }, lines, purpose: text(row.purpose, 10, 500) };
    }
    if (row?.type === 'bank-transfer') {
      exact(row, ['type', 'fromKey', 'toKey', 'amountCents', 'purpose']);
      const banks = bankRoles();
      if (banks.length < 2) fail('Transfers need two published bank accounts; this business publishes only ' + banks.join(', ') + '.');
      if (!banks.includes(row.fromKey) || !banks.includes(row.toKey) || row.fromKey === row.toKey) fail('Transfer between two different published bank accounts.');
      const amountCents = integer(row.amountCents, POLICY.maxSettlementCents); cents += amountCents;
      return { type: row.type, fromKey: row.fromKey, toKey: row.toKey, amountCents, purpose: text(row.purpose, 10, 500) };
    }
    if (row?.type === 'journal-entry') {
      exact(row, ['type', 'lines', 'purpose']);
      if (Array.isArray(row.lines)) for (const line of row.lines) exact(line, ['accountKey', 'postingType', 'amountCents']);
      cents += journalLines(row.lines, fail);
      return { type: row.type, lines: row.lines.map(line => ({ accountKey: line.accountKey, postingType: line.postingType, amountCents: line.amountCents })), purpose: text(row.purpose, 10, 500) };
    }
    if (row?.type === 'correct-own-record') {
      exact(row, ['type', 'target', 'purpose', ...(row.correction !== undefined ? ['correction'] : [])]);
      const checked = correctionChoice(row), target = 'Correction:' + checked.value.target.entity + ':' + checked.value.target.qboId;
      if (settled.has(target)) fail('Correct each record once per batch.'); settled.add(target);
      for (const source of checked.value.correction?.sources || []) { if (settled.has('Source:' + source.logicalKey)) fail('Corrections in one batch cannot share an original record.'); settled.add('Source:' + source.logicalKey); }
      cents += checked.cents; return checked.value;
    }
    // Policy v8: a published service invoiced on payment terms and left open (with the
    // field quote and time entry, as for a settled sale), or an operating bill on terms.
    if (row?.type === 'invoice-on-terms' || row?.type === 'bill-on-terms') {
      const invoice = row.type === 'invoice-on-terms';
      exact(row, invoice ? ['type', 'customerKey', 'itemKey', 'quantity', 'unitPriceCents', 'termsDays', 'purpose'] : ['type', 'vendorKey', 'category', 'amountCents', 'termsDays', 'purpose']);
      if (!TERMS_DAYS.includes(row.termsDays)) fail('Use payment terms of ' + TERMS_DAYS.join(', ') + ' days.');
      if (invoice) {
        if (!PARTY.test(row.customerKey || '') || !SERVICES.includes(row.itemKey)) fail('Choose an observed service and customer role from the published business.');
        const quantity = integer(row.quantity, POLICY.maxQuantity), unitPriceCents = integer(row.unitPriceCents, POLICY.maxUnitPriceCents); cents += quantity * unitPriceCents;
        return { type: row.type, customerKey: row.customerKey, itemKey: row.itemKey, quantity, unitPriceCents, termsDays: row.termsDays, purpose: text(row.purpose, 10, 500) };
      }
      if (!/^overhead-supplier-[1-3]$/.test(row.vendorKey || '') || !['premises', 'utilities', 'software'].includes(row.category)) fail('Choose a published operating supplier and expense category.');
      const amountCents = integer(row.amountCents, POLICY.maxExpenseCents); cents += amountCents;
      return { type: row.type, vendorKey: row.vendorKey, category: row.category, amountCents, termsDays: row.termsDays, purpose: text(row.purpose, 10, 500) };
    }
    // Policy v8: a field-service estimate sent today (stays open until accepted), or the
    // conversion of an earlier one into today's time entry and an invoice on terms.
    if (row?.type === 'send-estimate') {
      exact(row, ['type', 'customerKey', 'quantity', 'unitPriceCents', 'purpose']);
      if (!/^field-client-0(?:0[1-9]|1[0-5])$/.test(row.customerKey || '')) fail('Estimates are sent to published field-service customers.');
      const quantity = integer(row.quantity, POLICY.maxQuantity), unitPriceCents = integer(row.unitPriceCents, POLICY.maxUnitPriceCents);
      return { type: row.type, customerKey: row.customerKey, quantity, unitPriceCents, purpose: text(row.purpose, 10, 500) };
    }
    if (row?.type === 'convert-own-estimate') {
      const value = estimateConversionChoice(row), target = 'Estimate:' + value.estimateId;
      if (settled.has(target)) fail('Convert each estimate once per activity batch.'); settled.add(target);
      for (const source of value.source?.sources || []) { if (settled.has('Source:' + source.logicalKey)) fail('Activities in one batch cannot share an original record.'); settled.add('Source:' + source.logicalKey); }
      if (value.quote) cents += value.quote.quantity * value.quote.unitPriceCents;
      return value;
    }
    // Policy v8: a purchase order for workshop stock from a published stock supplier. It
    // posts nothing; receive-purchase-order later turns it into the inventory bill.
    if (row?.type === 'order-stock') {
      exact(row, ['type', 'vendorKey', 'lines', 'purpose']);
      if (!/^stock-supplier-[1-3]$/.test(row.vendorKey || '') || !Array.isArray(row.lines) || !row.lines.length || row.lines.length > 5) fail('Order one to five workshop stock items from a published stock supplier.');
      const seen = new Set();
      const lines = row.lines.map(line => {
        exact(line, ['itemKey', 'quantity', 'unitPriceCents']);
        if (!/^workshop-stock-[1-5]$/.test(line.itemKey || '') || seen.has(line.itemKey)) fail('Order each published workshop stock item once per purchase order.'); seen.add(line.itemKey);
        return { itemKey: line.itemKey, quantity: integer(line.quantity, STOCK_ORDER_QUANTITY), unitPriceCents: integer(line.unitPriceCents, POLICY.maxUnitPriceCents) };
      });
      const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
      if (total > POLICY.maxSettlementCents) fail('This purchase order exceeds the per-order capacity.');
      cents += total;
      return { type: row.type, vendorKey: row.vendorKey, lines, purpose: text(row.purpose, 10, 500) };
    }
    if (OWN_SETTLEMENT[row?.type]) {
      const value = ownSettlementChoice(row), spec = OWN_SETTLEMENT[row.type], target = spec.entity + ':' + value[spec.idKey];
      if (settled.has(target)) fail('Settle each of your own ' + spec.entity.toLowerCase() + 's once per activity batch.'); settled.add(target);
      for (const source of value.source?.sources || []) { if (settled.has('Source:' + source.logicalKey)) fail('Activities in one batch cannot share an original record.'); settled.add('Source:' + source.logicalKey); }
      cents += value.amountCents; return value;
    }
    if (row?.type === 'collect-adopted-invoice' || row?.type === 'pay-adopted-bill') {
      const invoice = row.type === 'collect-adopted-invoice', idKey = invoice ? 'invoiceId' : 'billId', partyKey = invoice ? 'customerKey' : 'vendorKey';
      exact(row, ['type', idKey, partyKey, 'amountCents', 'purpose']);
      if (!QBO_ID.test(row[idKey] || '') || !(invoice ? PARTY : SUPPLIER).test(row[partyKey] || '')) fail('Choose an open adopted ' + (invoice ? 'invoice and its customer' : 'bill and its supplier') + ' from the business choices.');
      const target = (invoice ? 'Invoice:' : 'Bill:') + row[idKey]; if (settled.has(target)) fail('Settle each adopted obligation once per activity batch.'); settled.add(target);
      const amountCents = integer(row.amountCents, POLICY.maxSettlementCents); cents += amountCents;
      return { type: row.type, [idKey]: row[idKey], [partyKey]: row[partyKey], amountCents, purpose: text(row.purpose, 10, 500) };
    }
    fail('Only settled service sales, service invoices and operating bills on terms, collections and payments of your own open invoices and bills, paid non-stock overhead, new customers, suppliers and service items, cash expenses, supplier credits, customer credits and refunds, bank transfers, journal entries, settlements of adopted invoices or bills and corrections of your own records are supported in these additional activity batches.');
  });
  if (cents > POLICY.maxBatchCents) fail('This activity batch exceeds its exact-cent capacity.');
  return { decisionKey, purpose, activities };
}
function makeActivityBatch({ scope, businessKey, day, choices, policy = POLICY }) {
  choices = validateChoices(choices, policy); date(day);
  if (choices.activities.some(row => row.type === 'correct-own-record' && row.correction === undefined)) fail('Correction terms are derived by the server from your own original record. Prepare corrections through the accountant activity tool.');
  if (choices.activities.some(row => row.type === 'correct-own-record' && row.correction.original.txnDate >= day)) fail('Correct a record from verified preceding history; a record from today can be corrected tomorrow.');
  if (choices.activities.some(row => OWN_SOURCED[row.type] && row.source === undefined)) fail('The original record is derived by the server from your own earlier work. Prepare collections, payments and estimate conversions through the accountant activity tool.');
  if (choices.activities.some(row => OWN_SOURCED[row.type] && row.source.txnDate >= day)) fail('Use a record from verified preceding history; a record from today can be settled or converted tomorrow.');
  const requestHash = hash(choices), key = hash({ version: 1, scope, businessKey, day, decisionKey: choices.decisionKey });
  return { version: 1, policyHash: hash(policy), key, requestHash, day, ...choices };
}
function buildBatchActivity(batch, scope, businessKey) {
  exact(batch, ['version', 'policyHash', 'key', 'requestHash', 'day', 'decisionKey', 'purpose', 'activities']);
  const saved = SAVED_POLICIES.get(batch.policyHash);
  if (!saved || batch.activities?.some?.(row => !saved.workflows.includes(row?.type))) fail('The exact additional activity decision or policy changed.');
  const expected = makeActivityBatch({ scope, businessKey, day: batch.day, choices: { decisionKey: batch.decisionKey, purpose: batch.purpose, activities: batch.activities }, policy: saved });
  if (canonical(batch) !== canonical(expected)) fail('The exact additional activity decision or policy changed.');
  const events = [], byLogicalKey = {}, prerequisites = [];
  for (const [index, choice] of batch.activities.entries()) {
    const ruleKey = 'activity-' + batch.key.slice(0, 20) + '-' + String(index + 1).padStart(3, '0');
    const rows = new Map();
    // A parent is a step key of this activity, or (policy v8) an existing earlier
    // record { logicalKey, entity } that is one of the batch's prerequisites.
    const parentOf = key => typeof key === 'string' ? rows.get(key) : key;
    const add = (stepKey, entity, parents, detail) => {
      const logicalKey = hash({ realmId: scope.realmId, environment: scope.environment, businessKey, ruleKey, occurrence: batch.day, stepKey });
      const event = { logicalKey, ruleKey, occurrence: batch.day, stepKey, entity, txnDate: batch.day, dependsOn: parents.map(key => parentOf(key).logicalKey), intent: { purpose: choice.purpose } };
      event.fingerprint = hash({ version: 1, batchKey: batch.key, requestHash: batch.requestHash, ruleKey, stepKey, entity, txnDate: batch.day });
      const details = { version: 1, currency: 'CAD', policyStatus: 'proposed', references: parents.map(key => ({ logicalKey: parentOf(key).logicalKey, entity: parentOf(key).entity })), baseAmountCents: null, taxStatus: 'not_applicable', lines: [], activityBatch: { key: batch.key, index, stepKey, purpose: choice.purpose }, ...detail };
      rows.set(stepKey, event); events.push(event); byLogicalKey[logicalKey] = { logicalKey, details, detailsHash: hash({ calendarFingerprint: event.fingerprint, details }) };
    };
    if (choice.type === 'add-customer' || choice.type === 'add-supplier') {
      const kind = choice.type === 'add-customer' ? 'customer' : 'supplier', { type, purpose, ...fields } = choice;
      add(kind, kind === 'customer' ? 'Customer' : 'Vendor', [], { listRole: { kind, roleKey: addedRoleKey(kind, batch.key, index), ...fields } });
    } else if (choice.type === 'add-item') {
      add('item', 'Item', [], { incomeMapping: choice.incomeRole, listRole: { kind: 'item', roleKey: addedRoleKey('item', batch.key, index), name: choice.name, itemType: 'Service', incomeRole: choice.incomeRole, unit: choice.unit, unitPriceCents: choice.unitPriceCents } });
    } else if (choice.type === 'settled-service-sale') {
      const field = choice.itemKey === 'field-service-hour', customerKey = choice.customerKey, itemKey = choice.itemKey, added = choice.incomeRole !== undefined;
      const line = { key: 'primary', itemKey, quantity: choice.quantity, unit: added ? choice.unit : field ? 'hours' : 'month', unitPriceCents: choice.unitPriceCents, amountCents: choice.quantity * choice.unitPriceCents, accountMapping: added ? choice.incomeRole : field ? 'serviceIncome' : 'careIncome' };
      const sale = { customerKey, lines: [line], baseAmountCents: line.amountCents, taxMapping: 'salesTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax' };
      if (field) { add('estimate', 'Estimate', [], sale); add('time', 'TimeActivity', ['estimate'], { customerKey, itemKey, hours: choice.quantity, billable: true, workerKey: 'field-technician', amountRule: 'time_only' }); }
      add('invoice', 'Invoice', field ? ['estimate', 'time'] : [], { ...sale, dueDate: batch.day });
      add('payment', 'Payment', ['invoice'], { customerKey, bankMapping: null, cashDirection: 'inflow', destination: 'undeposited_funds', amountRule: 'saved_originating_total', amountSourceKey: rows.get('invoice').logicalKey, taxStatus: 'included_in_originating_total' });
      add('deposit', 'Deposit', ['payment'], { customerKey, destination: 'operating_bank', bankMapping: 'operatingBank', cashDirection: 'internal_transfer', amountRule: 'saved_originating_total', amountSourceKey: rows.get('payment').logicalKey, taxStatus: 'included_in_originating_total' });
    } else if (choice.type === 'invoice-on-terms') {
      // As a settled sale, but the invoice stays open until its due date: no payment.
      const field = choice.itemKey === 'field-service-hour', customerKey = choice.customerKey;
      const line = { key: 'primary', itemKey: choice.itemKey, quantity: choice.quantity, unit: field ? 'hours' : 'month', unitPriceCents: choice.unitPriceCents, amountCents: choice.quantity * choice.unitPriceCents, accountMapping: field ? 'serviceIncome' : 'careIncome' };
      const sale = { customerKey, lines: [line], baseAmountCents: line.amountCents, taxMapping: 'salesTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax' };
      if (field) { add('estimate', 'Estimate', [], sale); add('time', 'TimeActivity', ['estimate'], { customerKey, itemKey: choice.itemKey, hours: choice.quantity, billable: true, workerKey: 'field-technician', amountRule: 'time_only' }); }
      add('invoice', 'Invoice', field ? ['estimate', 'time'] : [], { ...sale, dueDate: shift(batch.day, choice.termsDays), paymentTerms: { days: choice.termsDays } });
    } else if (choice.type === 'bill-on-terms') {
      add('bill', 'Bill', [], { vendorKey: choice.vendorKey, expenseCategory: choice.category, dueDate: shift(batch.day, choice.termsDays), paymentTerms: { days: choice.termsDays }, lines: [{ key: 'primary', accountMapping: 'operatingExpense', amountCents: choice.amountCents, billableStatus: 'NotBillable' }], baseAmountCents: choice.amountCents, taxMapping: 'purchaseTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax' });
    } else if (choice.type === 'order-stock') {
      const lines = choice.lines.map((line, n) => ({ key: 'line-' + (n + 1), itemKey: line.itemKey, quantity: line.quantity, unit: 'each', unitPriceCents: line.unitPriceCents, amountCents: line.quantity * line.unitPriceCents, accountMapping: 'inventoryAsset' }));
      add('purchase-order', 'PurchaseOrder', [], { vendorKey: choice.vendorKey, lines, baseAmountCents: lines.reduce((sum, line) => sum + line.amountCents, 0), taxMapping: 'purchaseTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax', stockOrder: true });
    } else if (choice.type === 'send-estimate') {
      const line = { key: 'primary', itemKey: 'field-service-hour', quantity: choice.quantity, unit: 'hours', unitPriceCents: choice.unitPriceCents, amountCents: choice.quantity * choice.unitPriceCents, accountMapping: 'serviceIncome' };
      add('estimate', 'Estimate', [], { customerKey: choice.customerKey, lines: [line], baseAmountCents: line.amountCents, taxMapping: 'salesTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax', quoteOnly: true });
    } else if (choice.type === 'convert-own-estimate') {
      // The accepted estimate (an existing prerequisite) is worked today and billed on terms.
      const source = choice.source, quote = choice.quote, estimate = { logicalKey: source.logicalKey, entity: 'Estimate' }, customerKey = choice.customerKey;
      if (source.txnDate >= batch.day) fail('Convert an estimate from verified preceding history.');
      for (const row of source.sources) prerequisites.push({ logicalKey: row.logicalKey, entity: row.entity, txnDate: row.txnDate, dependsOn: [...row.dependsOn] });
      const line = { key: 'primary', itemKey: quote.itemKey, quantity: quote.quantity, unit: 'hours', unitPriceCents: quote.unitPriceCents, amountCents: quote.quantity * quote.unitPriceCents, accountMapping: 'serviceIncome' };
      add('time', 'TimeActivity', [estimate], { customerKey, itemKey: quote.itemKey, hours: quote.quantity, billable: true, workerKey: 'field-technician', amountRule: 'time_only' });
      add('invoice', 'Invoice', [estimate, 'time'], { customerKey, lines: [line], baseAmountCents: line.amountCents, taxMapping: 'salesTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax', dueDate: shift(batch.day, choice.termsDays), paymentTerms: { days: choice.termsDays } });
    } else if (OWN_SETTLEMENT[choice.type]) {
      // The original terms invoice or bill and its saved dependency closure are existing
      // prerequisites; the compiler re-proves its open balance inside the writer fence.
      const spec = OWN_SETTLEMENT[choice.type], source = choice.source, original = { logicalKey: source.logicalKey, entity: spec.entity };
      if (source.txnDate >= batch.day) fail('Settle a record from verified preceding history.');
      for (const row of source.sources) prerequisites.push({ logicalKey: row.logicalKey, entity: row.entity, txnDate: row.txnDate, dependsOn: [...row.dependsOn] });
      const ownSettlement = { entity: spec.entity, qboId: choice[spec.idKey], logicalKey: source.logicalKey, amountCents: choice.amountCents };
      if (spec.entity === 'Invoice') {
        add('payment', 'Payment', [original], { customerKey: choice.customerKey, bankMapping: null, cashDirection: 'inflow', destination: 'undeposited_funds', amountRule: 'own_open_balance', amountSourceKey: source.logicalKey, taxStatus: 'included_in_originating_total', ownSettlement });
        add('deposit', 'Deposit', ['payment'], { customerKey: choice.customerKey, destination: 'operating_bank', bankMapping: 'operatingBank', cashDirection: 'internal_transfer', amountRule: 'saved_originating_total', amountSourceKey: rows.get('payment').logicalKey, taxStatus: 'included_in_originating_total' });
      } else add('bill-payment', 'BillPayment', [original], { vendorKey: choice.vendorKey, bankMapping: 'operatingBank', cashDirection: 'outflow', fundingSource: 'operating_bank', amountRule: 'own_open_balance', amountSourceKey: source.logicalKey, taxStatus: 'included_in_originating_total', ownSettlement });
    } else if (choice.type === 'correct-own-record') {
      // The original and its saved dependency closure are existing prerequisites. The
      // reversal steps take their identity from the ORIGINAL (rule key and occurrence),
      // never from this batch or its decision key: one correction per original, ever.
      const c = choice.correction, original = c.original, correctionKey = correctionRuleKey(original);
      if (original.txnDate >= batch.day) fail('Correct a record from verified preceding history.');
      for (const source of c.sources) prerequisites.push({ logicalKey: source.logicalKey, entity: source.entity, txnDate: source.txnDate, dependsOn: [...source.dependsOn] });
      const parentOf = key => key === 'original' ? { logicalKey: original.logicalKey, entity: original.entity } : { logicalKey: rows.get(key).logicalKey, entity: rows.get(key).entity };
      for (const [stepKey, entity, parents] of CORRECTION[c.kind].steps) {
        const logicalKey = hash({ realmId: scope.realmId, environment: scope.environment, businessKey, ruleKey: correctionKey, occurrence: original.txnDate, stepKey });
        const links = parents.map(parentOf), event = { logicalKey, ruleKey: correctionKey, occurrence: original.txnDate, stepKey, entity, txnDate: batch.day, dependsOn: links.map(row => row.logicalKey), intent: { purpose: choice.purpose } };
        event.fingerprint = hash({ version: 1, batchKey: batch.key, requestHash: batch.requestHash, ruleKey: correctionKey, stepKey, entity, txnDate: batch.day });
        const details = { version: 1, currency: 'CAD', policyStatus: 'proposed', references: links, baseAmountCents: null, taxStatus: 'not_applicable', lines: [], activityBatch: { key: batch.key, index, stepKey, purpose: choice.purpose }, correction: { kind: c.kind, original: { ...original }, ...(CREDIT_STEPS.includes(stepKey) ? { earliestSourceTxnDate: c.sources.map(source => source.txnDate).sort()[0] } : {}) }, ...correctionDetail(c, stepKey) };
        rows.set(stepKey, event); events.push(event); byLogicalKey[logicalKey] = { logicalKey, details, detailsHash: hash({ calendarFingerprint: event.fingerprint, details }) };
      }
    } else if (choice.type === 'receive-purchase-order') {
      if (choice.source.txnDate >= batch.day) fail('Receive a purchase order from verified preceding history.');
      const lines = choice.lines.map(line => ({ key: line.lineId, itemKey: line.itemKey, quantity: line.quantity, unit: 'each', unitPriceCents: line.unitPriceCents, amountCents: line.quantity * line.unitPriceCents, accountMapping: 'inventoryAsset' }));
      add('receive-bill', 'Bill', [], { vendorKey: choice.vendorKey, dueDate: batch.day, lines, baseAmountCents: lines.reduce((sum, line) => sum + line.amountCents, 0), taxMapping: 'purchaseTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax', purchaseOrderReceipt: { purchaseOrderId: choice.purchaseOrderId, source: choice.source } });
      if (choice.source.kind === 'managed') {
        prerequisites.push({ logicalKey: choice.source.logicalKey, entity: 'PurchaseOrder', txnDate: choice.source.txnDate, dependsOn: [] });
        const event = rows.get('receive-bill'), detail = byLogicalKey[event.logicalKey]; event.dependsOn = [choice.source.logicalKey]; detail.details.references = [{ logicalKey: choice.source.logicalKey, entity: 'PurchaseOrder' }]; detail.detailsHash = hash({ calendarFingerprint: event.fingerprint, details: detail.details });
      }
    } else if (choice.type === 'collect-adopted-invoice') {
      add('payment', 'Payment', [], { customerKey: choice.customerKey, bankMapping: null, cashDirection: 'inflow', destination: 'undeposited_funds', amountRule: 'adopted_open_balance', taxStatus: 'included_in_originating_total', adoptedSettlement: { entity: 'Invoice', qboId: choice.invoiceId, amountCents: choice.amountCents } });
      add('deposit', 'Deposit', ['payment'], { customerKey: choice.customerKey, destination: 'operating_bank', bankMapping: 'operatingBank', cashDirection: 'internal_transfer', amountRule: 'saved_originating_total', amountSourceKey: rows.get('payment').logicalKey, taxStatus: 'included_in_originating_total' });
    } else if (choice.type === 'pay-adopted-bill') {
      add('bill-payment', 'BillPayment', [], { vendorKey: choice.vendorKey, bankMapping: 'operatingBank', cashDirection: 'outflow', fundingSource: 'operating_bank', amountRule: 'adopted_open_balance', taxStatus: 'included_in_originating_total', adoptedSettlement: { entity: 'Bill', qboId: choice.billId, amountCents: choice.amountCents } });
    } else if (choice.type === 'customer-credit' || choice.type === 'customer-refund') {
      const field = choice.itemKey === 'field-service-hour';
      const line = { key: 'primary', itemKey: choice.itemKey, quantity: choice.quantity, unit: field ? 'hours' : 'month', unitPriceCents: choice.unitPriceCents, amountCents: choice.quantity * choice.unitPriceCents, accountMapping: field ? 'serviceIncome' : 'careIncome' };
      const credit = { customerKey: choice.customerKey, lines: [line], baseAmountCents: line.amountCents, taxMapping: 'salesTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax' };
      if (choice.type === 'customer-credit') add('credit', 'CreditMemo', [], credit);
      else add('refund', 'RefundReceipt', [], { ...credit, bankMapping: 'operatingBank', cashDirection: 'outflow', fundingSource: 'operating_bank' });
    } else if (choice.type === 'bank-transfer') {
      add('transfer', 'Transfer', [], { bankMapping: choice.fromKey, toBankMapping: choice.toKey, cashDirection: 'internal_transfer', baseAmountCents: choice.amountCents, amountRule: 'transfer_amount' });
    } else if (choice.type === 'journal-entry') {
      const lines = choice.lines.map((line, n) => ({ key: 'line-' + (n + 1), accountMapping: line.accountKey, postingType: line.postingType, amountCents: line.amountCents }));
      add('journal', 'JournalEntry', [], { lines, baseAmountCents: journalLines(lines, fail), amountRule: 'balanced_journal' });
    } else if (choice.type === 'paid-cash-expense' || choice.type === 'supplier-credit') {
      const expense = { vendorKey: choice.vendorKey, expenseCategory: choice.category, lines: [{ key: 'primary', accountMapping: 'operatingExpense', amountCents: choice.amountCents, billableStatus: 'NotBillable' }], baseAmountCents: choice.amountCents, taxMapping: 'purchaseTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax' };
      if (choice.type === 'paid-cash-expense') add('expense', 'Purchase', [], { ...expense, bankMapping: 'operatingBank', cashDirection: 'outflow', fundingSource: 'operating_bank' });
      else add('vendor-credit', 'VendorCredit', [], expense);
    } else {
      add('bill', 'Bill', [], { vendorKey: choice.vendorKey, expenseCategory: choice.category, dueDate: batch.day, lines: [{ key: 'primary', accountMapping: 'operatingExpense', amountCents: choice.amountCents, billableStatus: 'NotBillable' }], baseAmountCents: choice.amountCents, taxMapping: 'purchaseTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax' });
      add('bill-payment', 'BillPayment', ['bill'], { vendorKey: choice.vendorKey, bankMapping: 'operatingBank', cashDirection: 'outflow', fundingSource: 'operating_bank', amountRule: 'saved_originating_total', amountSourceKey: rows.get('bill').logicalKey, taxStatus: 'included_in_originating_total' });
    }
  }
  return { businessKey, planHash: hash(batch), events, prerequisites, future: [], detailProposal: { byLogicalKey, fingerprint: hash(byLogicalKey) } };
}
function validateActivityBatch(batch, candidate) {
  if (!HASH.test(batch?.key || '') || candidate.expectedCursor === null || candidate.fromDate !== batch.day || candidate.throughDate !== batch.day || shift(candidate.expectedCursor, 1) !== batch.day) fail('Additional activity requires the next open business day after verified history.');
  const activity = buildBatchActivity(batch, candidate.scope, candidate.businessKey), entries = candidate.entries || candidate.steps?.map(step => ({ kind: 'create', step })), proposed = entries?.filter(entry => entry.kind === 'create');
  const required = activity.prerequisites;
  if (entries?.some(entry => entry.kind !== 'create' && (entry.kind !== 'existing' || !required.some(row => row.logicalKey === entry.step.logicalKey && row.entity === entry.step.entity && row.txnDate === entry.step.txnDate))) || entries?.filter(entry => entry.kind === 'existing').length !== required.length) fail('Receiving retains only its exact original purchase order.');
  if (!Array.isArray(proposed) || proposed.length !== activity.events.length || proposed.some(entry => entry.kind !== 'create')) fail('Additional activity must contain its exact self-contained new records.');
  const expectedKeys = new Set(activity.events.map(event => event.logicalKey));
  for (const entry of proposed) {
    const event = activity.events.find(row => row.logicalKey === entry.step?.logicalKey), detail = event && activity.detailProposal.byLogicalKey[event.logicalKey].details;
    // Dated tax is independently added from the published authority by preparation.
    const { datedTax, ...actual } = entry.step?.details || {};
    if (!event || entry.step.entity !== event.entity || entry.step.txnDate !== batch.day || entry.step.calendarFingerprint !== event.fingerprint || canonical(actual) !== canonical(detail) || canonical((entry.step.dependencies || []).map(row => row.logicalKey).sort()) !== canonical([...event.dependsOn].sort())) fail('Additional activity differs from the retained business choices.');
    // A stock purchase order (policy v8) references stock items but moves no stock.
    if (!detail.purchaseOrderReceipt && detail.stockOrder !== true && entry.step.references?.some(ref => ref.entity === 'Item' && !SERVICES.includes(ref.key) && !ADDED.item.test(ref.key))) fail('Additional activity cannot introduce inventory movement.');
    expectedKeys.delete(event.logicalKey);
  }
  if (expectedKeys.size) fail('Additional activity contains duplicate or missing records.');
  return batch;
}
function batchLifecycle(step) {
  const value = step?.details?.activityBatch, d = step?.details;
  exact(value, ['key', 'index', 'stepKey', 'purpose']);
  if (!HASH.test(value.key || '') || !Number.isInteger(value.index) || value.index < 0 || value.index >= POLICY.maxActivities || !['estimate', 'time', 'invoice', 'payment', 'deposit', 'bill', 'bill-payment', 'expense', 'vendor-credit', 'credit', 'refund', 'transfer', 'journal', 'receive-bill', 'purchase-order', 'customer', 'supplier', 'item', ...Object.keys(CORRECTION_MODES)].includes(value.stepKey)) fail('The additional activity lifecycle is incomplete.');
  text(value.purpose, 10, 500); date(step.txnDate);
  const entity = { estimate: 'Estimate', time: 'TimeActivity', invoice: 'Invoice', payment: 'Payment', deposit: 'Deposit', bill: 'Bill', 'bill-payment': 'BillPayment', expense: 'Purchase', 'vendor-credit': 'VendorCredit', credit: 'CreditMemo', refund: 'RefundReceipt', transfer: 'Transfer', journal: 'JournalEntry', 'receive-bill': 'Bill', 'purchase-order': 'PurchaseOrder', customer: 'Customer', supplier: 'Vendor', item: 'Item', 'correction-credit': 'CreditMemo', 'correction-application': 'Payment', 'correction-refund': 'RefundReceipt', 'correction-vendor-credit': 'VendorCredit', 'correction-bill-application': 'BillPayment', 'correction-journal': 'JournalEntry' }[value.stepKey];
  if (step.entity !== entity) fail('The additional activity step changed its transaction type.');
  if (d.activityTemplateVersion !== undefined || d.origin !== undefined || d.settlement !== undefined || d.stockQuantityRule !== undefined || d.creditAdjustment !== undefined || d.creditSettlement !== undefined) fail('An additional activity cannot borrow a monthly, stock or credit lifecycle.');
  const contract = { version: 4, activityBatch: structuredClone(value), mode: 'standard' };
  // A correction step carries its own exact contract; nothing else may claim one.
  if (CORRECTION_MODES[value.stepKey] || d.correction !== undefined || d.originalTax !== undefined) return correctionLifecycle(step, value, contract);
  if (['Customer', 'Vendor', 'Item'].includes(step.entity)) {
    // A list record: no date-bearing posting, no dependencies, exact allowlisted fields.
    const role = d.listRole, kind = { Customer: 'customer', Vendor: 'supplier', Item: 'item' }[step.entity];
    if (!role || Object.getPrototypeOf(role) !== Object.prototype || role.kind !== kind || !ADDED[kind].test(role.roleKey || '') || role.roleKey !== addedRoleKey(kind, value.key, value.index) || (step.dependencies || []).length || d.lines?.length || d.taxMapping !== undefined || d.customerKey !== undefined || d.vendorKey !== undefined || d.bankMapping !== undefined || d.baseAmountCents !== null || d.incomeMapping !== (kind === 'item' ? role.incomeRole : undefined)) fail('An added customer, supplier or item keeps its exact role and no postings.');
    const { kind: ignored, roleKey, itemType, ...fields } = role;
    const row = kind === 'item' ? { type: 'add-item', name: fields.name, incomeRole: fields.incomeRole, unit: fields.unit, unitPriceCents: fields.unitPriceCents, purpose: value.purpose } : { type: kind === 'customer' ? 'add-customer' : 'add-supplier', ...fields, purpose: value.purpose };
    const checked = validateChoices({ decisionKey: 'validate-added-role', purpose: 'Validate the exact added list record lifecycle.', activities: [row] }).activities[0];
    if ((kind === 'item' ? itemType !== 'Service' || Object.keys(role).sort().join(',') !== 'incomeRole,itemType,kind,name,roleKey,unit,unitPriceCents' : itemType !== undefined) || canonical({ ...checked, purpose: null }) !== canonical({ ...row, purpose: null })) fail('An added customer, supplier or item keeps its exact allowlisted fields.');
    contract.mode = 'list-record'; contract.listRole = structuredClone(role);
    return contract;
  }
  if (d.listRole !== undefined || d.incomeMapping !== undefined) fail('Only an added customer, supplier or item may carry a list role.');
  // Policy v8: a stock purchase order, exact whole-unit inventory lines, no postings.
  if (step.entity === 'PurchaseOrder' || d.stockOrder !== undefined) {
    const items = new Set((d.lines || []).map(line => line.itemKey));
    if (d.stockOrder !== true || step.entity !== 'PurchaseOrder' || value.stepKey !== 'purchase-order' || (step.dependencies || []).length || !/^stock-supplier-[1-3]$/.test(d.vendorKey || '') || !Array.isArray(d.lines) || !d.lines.length || d.lines.length > 5 || items.size !== d.lines.length || d.lines.some((line, n) => line.key !== 'line-' + (n + 1) || !/^workshop-stock-[1-5]$/.test(line.itemKey || '') || line.unit !== 'each' || line.accountMapping !== 'inventoryAsset' || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > STOCK_ORDER_QUANTITY || !Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 1 || line.unitPriceCents > POLICY.maxUnitPriceCents || line.amountCents !== line.quantity * line.unitPriceCents) || d.baseAmountCents !== d.lines.reduce((sum, line) => sum + line.amountCents, 0) || d.baseAmountCents > POLICY.maxSettlementCents || d.taxMapping !== 'purchaseTax' || d.amountRule !== 'lines_before_tax' || d.customerKey !== undefined || d.bankMapping !== undefined) fail('A stock purchase order keeps its exact supplier and whole-unit stock lines.');
    contract.mode = 'stock-order';
  }
  // Policy v8: an estimate sent on its own stays open until a later conversion.
  if (d.quoteOnly !== undefined) {
    const line = d.lines?.[0];
    if (d.quoteOnly !== true || step.entity !== 'Estimate' || value.stepKey !== 'estimate' || (step.dependencies || []).length || d.lines?.length !== 1 || line.itemKey !== 'field-service-hour' || line.unit !== 'hours' || line.accountMapping !== 'serviceIncome' || line.amountCents !== line.quantity * line.unitPriceCents || d.baseAmountCents !== line.amountCents || !/^field-client-0(?:0[1-9]|1[0-5])$/.test(d.customerKey || '') || d.taxMapping !== 'salesTax') fail('A sent estimate keeps its exact field-service quote.');
    contract.quoteOnly = true;
  }
  if (d.adoptedSettlement !== undefined) {
    // Settles one adopted obligation; it never depends on a managed record.
    const s = d.adoptedSettlement, payment = step.entity === 'Payment';
    exact(s, ['entity', 'qboId', 'amountCents']);
    if (!['Payment', 'BillPayment'].includes(step.entity) || s.entity !== (payment ? 'Invoice' : 'Bill') || !QBO_ID.test(s.qboId || '') || !Number.isSafeInteger(s.amountCents) || s.amountCents < 1 || s.amountCents > POLICY.maxSettlementCents || d.amountRule !== 'adopted_open_balance' || d.amountSourceKey !== undefined || (step.dependencies || []).length || (payment ? !PARTY.test(d.customerKey || '') || d.destination !== 'undeposited_funds' : !SUPPLIER.test(d.vendorKey || '') || d.fundingSource !== 'operating_bank' || d.bankMapping !== 'operatingBank')) fail('The adopted settlement terms are incomplete.');
    contract.mode = 'adopted-settlement'; contract.adopted = { entity: s.entity, qboId: s.qboId, amountCents: s.amountCents };
  } else if (d.amountRule === 'adopted_open_balance') fail('An adopted settlement must name its exact obligation.');
  if (d.ownSettlement !== undefined) {
    // Policy v8: settles one of the accountant's own open terms invoices or bills, which
    // is this step's only dependency (an existing prerequisite of the batch).
    const s = d.ownSettlement, payment = step.entity === 'Payment', links = step.dependencies || [];
    exact(s, ['entity', 'qboId', 'logicalKey', 'amountCents']);
    if (!['Payment', 'BillPayment'].includes(step.entity) || value.stepKey !== (payment ? 'payment' : 'bill-payment') || s.entity !== (payment ? 'Invoice' : 'Bill') || !QBO_ID.test(s.qboId || '') || !HASH.test(s.logicalKey || '') || !Number.isSafeInteger(s.amountCents) || s.amountCents < 1 || s.amountCents > POLICY.maxSettlementCents || d.amountRule !== 'own_open_balance' || d.amountSourceKey !== s.logicalKey || d.adoptedSettlement !== undefined || d.lines?.length || links.length !== 1 || links[0].logicalKey !== s.logicalKey || links[0].entity !== s.entity || (payment ? !PARTY.test(d.customerKey || '') || d.destination !== 'undeposited_funds' || d.bankMapping !== null || d.cashDirection !== 'inflow' : !/^overhead-supplier-[1-3]$/.test(d.vendorKey || '') || d.fundingSource !== 'operating_bank' || d.bankMapping !== 'operatingBank' || d.cashDirection !== 'outflow')) fail('The settlement of your own open record keeps its exact original and amount.');
    contract.mode = payment ? 'own-collection' : 'own-bill-payment'; contract.ownSettlement = { entity: s.entity, qboId: s.qboId, logicalKey: s.logicalKey, amountCents: s.amountCents };
  } else if (d.amountRule === 'own_open_balance') fail('A settlement of your own record must name its exact original.');
  if (['Invoice', 'Bill'].includes(step.entity)) {
    // Policy v8 terms: due a published number of days after the transaction date.
    if (d.paymentTerms !== undefined) {
      exact(d.paymentTerms, ['days']);
      if (!TERMS_DAYS.includes(d.paymentTerms.days) || value.stepKey !== (step.entity === 'Invoice' ? 'invoice' : 'bill') || d.dueDate !== shift(step.txnDate, d.paymentTerms.days)) fail('The approved payment terms changed.');
      contract.paymentTerms = { days: d.paymentTerms.days };
    } else if (d.dueDate !== step.txnDate) fail('These settled activities require immediate terms.');
    contract.dueDate = d.dueDate;
  } else if (d.dueDate !== undefined || d.paymentTerms !== undefined) fail('Only an invoice or bill may carry payment terms.');
  if (['Purchase', 'VendorCredit'].includes(step.entity)) {
    // One nonbillable operating-expense line with purchase tax; a cash expense is paid
    // from the operating bank, a supplier credit reduces accounts payable.
    const line = d.lines?.[0], cash = step.entity === 'Purchase';
    if (d.lines?.length !== 1 || !/^overhead-supplier-[1-3]$/.test(d.vendorKey || '') || !['premises', 'utilities', 'software'].includes(d.expenseCategory) || line.itemKey !== undefined || line.accountMapping !== 'operatingExpense' || line.billableStatus !== 'NotBillable' || !Number.isSafeInteger(line.amountCents) || line.amountCents < 1 || line.amountCents > POLICY.maxExpenseCents || line.amountCents !== d.baseAmountCents || d.taxMapping !== 'purchaseTax' || d.amountRule !== 'lines_before_tax' || d.customerKey !== undefined || (step.dependencies || []).length || (cash ? d.bankMapping !== 'operatingBank' || d.fundingSource !== 'operating_bank' : d.bankMapping !== undefined || d.fundingSource !== undefined)) fail('The ' + (cash ? 'cash expense' : 'supplier credit') + ' must remain one nonbillable operating expense from a published supplier.');
    contract.mode = cash ? 'cash-expense' : 'supplier-credit'; contract.expense = { category: d.expenseCategory, accountMapping: 'operatingExpense', amountCents: line.amountCents, billableStatus: 'NotBillable' };
  }
  if (['CreditMemo', 'RefundReceipt'].includes(step.entity)) {
    // One published service line with sales tax for a published customer. A credit
    // stays open (not applied); a refund is paid from the operating bank.
    const line = d.lines?.[0], refund = step.entity === 'RefundReceipt', field = line?.itemKey === 'field-service-hour';
    if (d.lines?.length !== 1 || !PARTY.test(d.customerKey || '') || d.vendorKey !== undefined || !SERVICES.includes(line.itemKey) || line.key !== 'primary' || line.accountMapping !== (field ? 'serviceIncome' : 'careIncome') || line.unit !== (field ? 'hours' : 'month') || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > POLICY.maxQuantity || !Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 1 || line.unitPriceCents > POLICY.maxUnitPriceCents || line.amountCents !== line.quantity * line.unitPriceCents || d.baseAmountCents !== line.amountCents || d.taxMapping !== 'salesTax' || d.amountRule !== 'lines_before_tax' || (step.dependencies || []).length || (refund ? d.bankMapping !== 'operatingBank' || d.fundingSource !== 'operating_bank' : d.bankMapping !== undefined || d.fundingSource !== undefined)) fail('The ' + (refund ? 'customer refund' : 'customer credit') + ' must remain one taxed published service line for a published customer.');
    contract.mode = refund ? 'customer-refund' : 'customer-credit';
  }
  if (step.entity === 'Transfer') {
    const banks = bankRoles();
    if (!banks.includes(d.bankMapping) || !banks.includes(d.toBankMapping) || d.bankMapping === d.toBankMapping || !Number.isSafeInteger(d.baseAmountCents) || d.baseAmountCents < 1 || d.baseAmountCents > POLICY.maxSettlementCents || d.amountRule !== 'transfer_amount' || d.lines?.length || d.taxMapping !== undefined || d.customerKey !== undefined || d.vendorKey !== undefined || (step.dependencies || []).length) fail('A transfer moves an exact amount between two different published bank accounts.');
    contract.mode = 'bank-transfer'; contract.transfer = { fromKey: d.bankMapping, toKey: d.toBankMapping, amountCents: d.baseAmountCents };
  } else if (d.toBankMapping !== undefined) fail('Only a transfer names a receiving bank account.');
  if (step.entity === 'JournalEntry') {
    const check = message => fail(message);
    if (!Array.isArray(d.lines) || d.lines.some((line, n) => !line || Object.keys(line).sort().join(',') !== 'accountMapping,amountCents,key,postingType' || line.key !== 'line-' + (n + 1)) || journalLines(d.lines, check) !== d.baseAmountCents || d.amountRule !== 'balanced_journal' || d.taxMapping !== undefined || d.bankMapping !== undefined || d.customerKey !== undefined || d.vendorKey !== undefined || (step.dependencies || []).length) fail('A journal entry must keep its exact balanced lines on published roles.');
    contract.mode = 'journal-entry'; contract.journal = d.lines.map(line => ({ accountMapping: line.accountMapping, postingType: line.postingType, amountCents: line.amountCents }));
  }
  if (value.stepKey === 'receive-bill') {
    const receipt = d.purchaseOrderReceipt; exact(receipt, ['purchaseOrderId', 'source']); exact(receipt.source, ['kind', 'logicalKey', 'txnDate']);
    const choice = validateChoices({ decisionKey: 'validate-receipt', purpose: 'Validate the exact stock receipt lifecycle.', activities: [{ type: 'receive-purchase-order', purchaseOrderId: receipt.purchaseOrderId, vendorKey: d.vendorKey, source: receipt.source, lines: d.lines.map(line => ({ lineId: line.key, itemKey: line.itemKey, quantity: line.quantity, unitPriceCents: line.unitPriceCents })), purpose: value.purpose }] }).activities[0];
    if (receipt.source.txnDate >= step.txnDate || d.lines.some(line => line.accountMapping !== 'inventoryAsset' || line.unit !== 'each' || line.amountCents !== line.quantity * line.unitPriceCents) || d.baseAmountCents !== d.lines.reduce((n,line) => n + line.amountCents, 0) || d.taxMapping !== 'purchaseTax' || d.amountRule !== 'lines_before_tax' || d.customerKey !== undefined || d.bankMapping !== undefined || canonical((step.dependencies || []).map(link => ({ logicalKey: link.logicalKey, entity: link.entity }))) !== canonical(choice.source.kind === 'managed' ? [{ logicalKey: choice.source.logicalKey, entity: 'PurchaseOrder' }] : [])) fail('Keep the exact whole stock receipt and originating purchase order.');
    contract.mode = 'purchase-order-receipt'; contract.purchaseOrderReceipt = structuredClone(receipt);
  } else if (d.purchaseOrderReceipt !== undefined) fail('Only a receiving bill may name a purchase-order receipt.');
  if (step.entity === 'Bill' && value.stepKey !== 'receive-bill') { const line = d.lines?.[0]; if (d.lines.length !== 1 || line.itemKey !== undefined || line.accountMapping !== 'operatingExpense' || line.billableStatus !== 'NotBillable' || line.amountCents !== d.baseAmountCents) fail('The additional bill must remain a non-stock operating expense.'); contract.mode = 'operating-expense'; contract.expense = { category: d.expenseCategory, accountMapping: 'operatingExpense', amountCents: line.amountCents, billableStatus: 'NotBillable' }; }
  return contract;
}
// The exact lifecycle of one correction step, checked in isolation from its batch.
// The batch rebuild (validateActivityBatch) separately proves every term equals the
// saved choice; the compiler re-proves the original inside the writer fence.
function correctionLifecycle(step, value, contract) {
  const d = step.details, c = d.correction, mode = CORRECTION_MODES[value.stepKey], wrong = () => fail('A correction keeps its exact derived reversal terms.');
  if (!mode) wrong();
  const credit = CREDIT_STEPS.includes(value.stepKey);
  exact(c, ['kind', 'original', ...(credit ? ['earliestSourceTxnDate'] : [])]);
  const spec = CORRECTION[c.kind], row = spec?.steps.find(entry => entry[0] === value.stepKey), original = originalTerms(c.original);
  if (!row || row[1] !== step.entity || !spec.targets.includes(original.entity) || original.txnDate >= step.txnDate) wrong();
  if (credit && (correctionDate(c.earliestSourceTxnDate) > original.txnDate)) wrong();
  for (const key of ['listRole', 'incomeMapping', 'adoptedSettlement', 'ownSettlement', 'paymentTerms', 'quoteOnly', 'stockOrder', 'purchaseOrderReceipt', 'toBankMapping', 'dueDate', 'expenseCategory', 'originalTax', 'destination', 'fundingSource', 'bankMapping', 'customerKey', 'vendorKey', 'taxMapping', 'amountSourceKey'].filter(key => d[key] !== undefined)) {
    const allowed = { 'correction-credit': ['customerKey', 'taxMapping', 'originalTax'], 'correction-refund': ['customerKey', 'taxMapping', 'originalTax', 'bankMapping', 'fundingSource'], 'correction-application': ['customerKey', 'bankMapping', 'destination', 'amountSourceKey'], 'correction-vendor-credit': ['vendorKey', 'expenseCategory', 'taxMapping', 'originalTax'], 'correction-bill-application': ['vendorKey', 'bankMapping', 'fundingSource', 'amountSourceKey'], 'correction-journal': [] }[value.stepKey];
    if (!allowed.includes(key)) wrong();
  }
  // Dependencies: the original (and, for an application, this correction's reversal).
  const links = (step.dependencies || []).map(link => ({ logicalKey: link.logicalKey, entity: link.entity })), expected = row[2];
  if (links.length !== expected.length || links.filter(link => link.logicalKey === original.logicalKey && link.entity === original.entity).length !== 1 || expected.filter(key => key !== 'original').some(key => links.filter(link => link.logicalKey !== original.logicalKey && link.entity === spec.steps.find(entry => entry[0] === key)[1]).length !== 1)) wrong();
  contract.mode = mode; contract.correction = { kind: c.kind, original, ...(credit ? { earliestSourceTxnDate: c.earliestSourceTxnDate } : {}) };
  if (['correction-credit', 'correction-refund'].includes(value.stepKey)) {
    const lines = correctionSaleLines(d.lines), base = lines.reduce((sum, line) => sum + line.amountCents, 0), refund = value.stepKey === 'correction-refund';
    if (!PARTY.test(d.customerKey || '') || d.baseAmountCents !== base || d.taxMapping !== 'salesTax' || d.amountRule !== 'lines_before_tax' || (refund ? d.bankMapping !== 'operatingBank' || d.fundingSource !== 'operating_bank' || d.cashDirection !== 'outflow' : d.bankMapping !== undefined || d.fundingSource !== undefined)) wrong();
    contract.originalTax = originalTaxTerms(d.originalTax, base);
  } else if (value.stepKey === 'correction-vendor-credit') {
    const [line] = correctionExpenseLines(d.lines);
    if (!/^overhead-supplier-[1-3]$/.test(d.vendorKey || '') || !['premises', 'utilities', 'software'].includes(d.expenseCategory) || d.baseAmountCents !== line.amountCents || d.taxMapping !== 'purchaseTax' || d.amountRule !== 'lines_before_tax') wrong();
    contract.originalTax = originalTaxTerms(d.originalTax, line.amountCents);
    contract.expense = { category: d.expenseCategory, accountMapping: 'operatingExpense', amountCents: line.amountCents, billableStatus: 'NotBillable' };
  } else if (value.stepKey === 'correction-journal') {
    const journal = correctionJournalLines(d.lines);
    if (d.baseAmountCents !== journal.total || d.amountRule !== 'balanced_journal') wrong();
    contract.journal = journal.lines.map(line => ({ accountMapping: line.accountMapping, postingType: line.postingType, amountCents: line.amountCents }));
  } else {
    // A zero-funds application of the reversal to the original: no lines, no money.
    const payment = step.entity === 'Payment';
    if (d.lines?.length || d.baseAmountCents !== null || d.amountRule !== 'correction_application' || d.amountSourceKey !== original.logicalKey || d.cashDirection !== 'none' || d.bankMapping !== 'operatingBank' || (payment ? !PARTY.test(d.customerKey || '') || d.destination !== 'operating_bank' : !/^overhead-supplier-[1-3]$/.test(d.vendorKey || '') || d.fundingSource !== 'operating_bank')) wrong();
  }
  return contract;
}
function assertBatchPreparation(active, batch, now) {
  if (active.calendar.verifiedThrough === null || batch.day !== businessDate(new Date(now)) || shift(active.calendar.verifiedThrough, 1) !== batch.day) fail('Verify business history through yesterday before preparing today’s additional activity. Keep today open for further hourly work.');
}
module.exports = { ADDED, addedRoleKey, SAVED_POLICIES, TERMS_DAYS, OWN_SETTLEMENT, OWN_SOURCED, JOURNAL_ROLES, bankRoles, POLICY, POLICY_HASH, CORRECTION, CORRECTION_MODES, CORRECTION_TARGETS, correctionRuleKey, validateChoices, makeActivityBatch, buildBatchActivity, validateActivityBatch, batchLifecycle, assertBatchPreparation };
