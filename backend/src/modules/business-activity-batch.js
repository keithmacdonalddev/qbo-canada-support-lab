'use strict';
// Business choices only. This module never accepts a QBO payload or performs I/O.
const { hash, canonical, date, shift } = require('./business-calendar');
const { businessDate } = require('./business-activity-preview');
const POLICY = Object.freeze({ version: 4, key: 'business-activity-v4', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill', 'paid-cash-expense', 'supplier-credit', 'customer-credit', 'customer-refund', 'bank-transfer', 'journal-entry'] });
// Settlements of adopted (imported) obligations name the QuickBooks record and its
// business party; preparation and compilation prove both against the adoption.
const PARTY = /^(field-client-0(?:0[1-9]|1[0-5])|care-client-0(?:0[1-9]|1[0-9]|2[0-5]))$/, SUPPLIER = /^(overhead|stock)-supplier-[1-3]$/, QBO_ID = /^\d{1,30}$/;
const POLICY_HASH = hash(POLICY), HASH = /^[a-f0-9]{64}$/;
// Earlier policies, kept so batches saved under them can still be read and
// verified. New batches always use POLICY.
const POLICY_V1 = Object.freeze({ version: 1, key: 'non-stock-business-activity-v1', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense'] });
const POLICY_V2 = Object.freeze({ version: 2, key: 'business-activity-v2', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill'] });
const POLICY_V3 = Object.freeze({ version: 3, key: 'business-activity-v3', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill', 'paid-cash-expense', 'supplier-credit'] });
const SAVED_POLICIES = new Map([[hash(POLICY_V1), POLICY_V1], [hash(POLICY_V2), POLICY_V2], [hash(POLICY_V3), POLICY_V3], [POLICY_HASH, POLICY]]);
const SERVICES = ['field-service-hour', 'care-plan-1', 'care-plan-2', 'care-plan-3'];
// Journal entries may only touch these mapped roles: no receivables or payables (they
// need a party), no undeposited funds (deposits prove those) and no stock accounts
// (stock cost is proven by its own FIFO evidence).
const JOURNAL_ROLES = Object.freeze(['operatingBank', 'serviceIncome', 'supplyIncome', 'careIncome', 'operatingExpense']);
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
function validateChoices(input) {
  exact(input, ['decisionKey', 'purpose', 'activities']);
  const decisionKey = text(input.decisionKey, 8, 100), purpose = text(input.purpose, 20, 2000);
  if (!/^[a-zA-Z0-9_-]+$/.test(decisionKey) || !Array.isArray(input.activities) || input.activities.length < 1 || input.activities.length > POLICY.maxActivities) fail('Choose one to twelve concrete business activities and retain their decision identifier.');
  let cents = 0; const settled = new Set();
  const activities = input.activities.map(row => {
    if (row?.type === 'settled-service-sale') {
      exact(row, ['type', 'customerKey', 'itemKey', 'quantity', 'unitPriceCents', 'purpose']);
      if (!/^(field-client-0(?:0[1-9]|1[0-5])|care-client-0(?:0[1-9]|1[0-9]|2[0-5]))$/.test(row.customerKey || '') || !['field-service-hour', 'care-plan-1', 'care-plan-2', 'care-plan-3'].includes(row.itemKey)) fail('Choose an observed service and customer role from the published business.');
      const quantity = integer(row.quantity, POLICY.maxQuantity), unitPriceCents = integer(row.unitPriceCents, POLICY.maxUnitPriceCents);
      cents += quantity * unitPriceCents;
      return { type: row.type, customerKey: row.customerKey, itemKey: row.itemKey, quantity, unitPriceCents, purpose: text(row.purpose, 10, 500) };
    }
    // A paid operating expense is a supplier bill paid the same day; a cash expense is
    // paid directly from the bank (Purchase); a supplier credit reduces what is owed.
    if (['paid-operating-expense', 'paid-cash-expense', 'supplier-credit'].includes(row?.type)) {
      exact(row, ['type', 'vendorKey', 'category', 'amountCents', 'purpose']);
      if (!/^overhead-supplier-[1-3]$/.test(row.vendorKey || '') || !['premises', 'utilities', 'software'].includes(row.category)) fail('Choose a published operating supplier and expense category.');
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
    if (row?.type === 'collect-adopted-invoice' || row?.type === 'pay-adopted-bill') {
      const invoice = row.type === 'collect-adopted-invoice', idKey = invoice ? 'invoiceId' : 'billId', partyKey = invoice ? 'customerKey' : 'vendorKey';
      exact(row, ['type', idKey, partyKey, 'amountCents', 'purpose']);
      if (!QBO_ID.test(row[idKey] || '') || !(invoice ? PARTY : SUPPLIER).test(row[partyKey] || '')) fail('Choose an open adopted ' + (invoice ? 'invoice and its customer' : 'bill and its supplier') + ' from the business choices.');
      const target = (invoice ? 'Invoice:' : 'Bill:') + row[idKey]; if (settled.has(target)) fail('Settle each adopted obligation once per activity batch.'); settled.add(target);
      const amountCents = integer(row.amountCents, POLICY.maxSettlementCents); cents += amountCents;
      return { type: row.type, [idKey]: row[idKey], [partyKey]: row[partyKey], amountCents, purpose: text(row.purpose, 10, 500) };
    }
    fail('Only settled service sales, paid non-stock overhead, cash expenses, supplier credits, customer credits and refunds, bank transfers, journal entries and settlements of adopted invoices or bills are supported in these additional activity batches.');
  });
  if (cents > POLICY.maxBatchCents) fail('This activity batch exceeds its exact-cent capacity.');
  return { decisionKey, purpose, activities };
}
function makeActivityBatch({ scope, businessKey, day, choices }) {
  choices = validateChoices(choices); date(day);
  const requestHash = hash(choices), key = hash({ version: 1, scope, businessKey, day, decisionKey: choices.decisionKey });
  return { version: 1, policyHash: POLICY_HASH, key, requestHash, day, ...choices };
}
function buildBatchActivity(batch, scope, businessKey) {
  exact(batch, ['version', 'policyHash', 'key', 'requestHash', 'day', 'decisionKey', 'purpose', 'activities']);
  const saved = SAVED_POLICIES.get(batch.policyHash);
  if (!saved || batch.activities?.some?.(row => !saved.workflows.includes(row?.type))) fail('The exact additional activity decision or policy changed.');
  const expected = { ...makeActivityBatch({ scope, businessKey, day: batch.day, choices: { decisionKey: batch.decisionKey, purpose: batch.purpose, activities: batch.activities } }), policyHash: batch.policyHash };
  if (canonical(batch) !== canonical(expected)) fail('The exact additional activity decision or policy changed.');
  const events = [], byLogicalKey = {};
  for (const [index, choice] of batch.activities.entries()) {
    const ruleKey = 'activity-' + batch.key.slice(0, 20) + '-' + String(index + 1).padStart(3, '0');
    const rows = new Map();
    const add = (stepKey, entity, parents, detail) => {
      const logicalKey = hash({ realmId: scope.realmId, environment: scope.environment, businessKey, ruleKey, occurrence: batch.day, stepKey });
      const event = { logicalKey, ruleKey, occurrence: batch.day, stepKey, entity, txnDate: batch.day, dependsOn: parents.map(key => rows.get(key).logicalKey), intent: { purpose: choice.purpose } };
      event.fingerprint = hash({ version: 1, batchKey: batch.key, requestHash: batch.requestHash, ruleKey, stepKey, entity, txnDate: batch.day });
      const details = { version: 1, currency: 'CAD', policyStatus: 'proposed', references: parents.map(key => ({ logicalKey: rows.get(key).logicalKey, entity: rows.get(key).entity })), baseAmountCents: null, taxStatus: 'not_applicable', lines: [], activityBatch: { key: batch.key, index, stepKey, purpose: choice.purpose }, ...detail };
      rows.set(stepKey, event); events.push(event); byLogicalKey[logicalKey] = { logicalKey, details, detailsHash: hash({ calendarFingerprint: event.fingerprint, details }) };
    };
    if (choice.type === 'settled-service-sale') {
      const field = choice.itemKey === 'field-service-hour', customerKey = choice.customerKey, itemKey = choice.itemKey;
      const line = { key: 'primary', itemKey, quantity: choice.quantity, unit: field ? 'hours' : 'month', unitPriceCents: choice.unitPriceCents, amountCents: choice.quantity * choice.unitPriceCents, accountMapping: field ? 'serviceIncome' : 'careIncome' };
      const sale = { customerKey, lines: [line], baseAmountCents: line.amountCents, taxMapping: 'salesTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax' };
      if (field) { add('estimate', 'Estimate', [], sale); add('time', 'TimeActivity', ['estimate'], { customerKey, itemKey, hours: choice.quantity, billable: true, workerKey: 'field-technician', amountRule: 'time_only' }); }
      add('invoice', 'Invoice', field ? ['estimate', 'time'] : [], { ...sale, dueDate: batch.day });
      add('payment', 'Payment', ['invoice'], { customerKey, bankMapping: null, cashDirection: 'inflow', destination: 'undeposited_funds', amountRule: 'saved_originating_total', amountSourceKey: rows.get('invoice').logicalKey, taxStatus: 'included_in_originating_total' });
      add('deposit', 'Deposit', ['payment'], { customerKey, destination: 'operating_bank', bankMapping: 'operatingBank', cashDirection: 'internal_transfer', amountRule: 'saved_originating_total', amountSourceKey: rows.get('payment').logicalKey, taxStatus: 'included_in_originating_total' });
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
  return { businessKey, planHash: hash(batch), events, prerequisites: [], future: [], detailProposal: { byLogicalKey, fingerprint: hash(byLogicalKey) } };
}
function validateActivityBatch(batch, candidate) {
  if (!HASH.test(batch?.key || '') || candidate.expectedCursor === null || candidate.fromDate !== batch.day || candidate.throughDate !== batch.day || shift(candidate.expectedCursor, 1) !== batch.day) fail('Additional activity requires the next open business day after verified history.');
  const activity = buildBatchActivity(batch, candidate.scope, candidate.businessKey), proposed = candidate.entries || candidate.steps?.map(step => ({ kind: 'create', step }));
  if (!Array.isArray(proposed) || proposed.length !== activity.events.length || proposed.some(entry => entry.kind !== 'create')) fail('Additional activity must contain its exact self-contained new records.');
  const expectedKeys = new Set(activity.events.map(event => event.logicalKey));
  for (const entry of proposed) {
    const event = activity.events.find(row => row.logicalKey === entry.step?.logicalKey), detail = event && activity.detailProposal.byLogicalKey[event.logicalKey].details;
    // Dated tax is independently added from the published authority by preparation.
    const { datedTax, ...actual } = entry.step?.details || {};
    if (!event || entry.step.entity !== event.entity || entry.step.txnDate !== batch.day || entry.step.calendarFingerprint !== event.fingerprint || canonical(actual) !== canonical(detail) || canonical((entry.step.dependencies || []).map(row => row.logicalKey).sort()) !== canonical([...event.dependsOn].sort())) fail('Additional activity differs from the retained business choices.');
    if (entry.step.references?.some(ref => ref.entity === 'Item' && !SERVICES.includes(ref.key))) fail('Additional activity cannot introduce inventory movement.');
    expectedKeys.delete(event.logicalKey);
  }
  if (expectedKeys.size) fail('Additional activity contains duplicate or missing records.');
  return batch;
}
function batchLifecycle(step) {
  const value = step?.details?.activityBatch, d = step?.details;
  exact(value, ['key', 'index', 'stepKey', 'purpose']);
  if (!HASH.test(value.key || '') || !Number.isInteger(value.index) || value.index < 0 || value.index >= POLICY.maxActivities || !['estimate', 'time', 'invoice', 'payment', 'deposit', 'bill', 'bill-payment', 'expense', 'vendor-credit', 'credit', 'refund', 'transfer', 'journal'].includes(value.stepKey)) fail('The additional activity lifecycle is incomplete.');
  text(value.purpose, 10, 500); date(step.txnDate);
  const entity = { estimate: 'Estimate', time: 'TimeActivity', invoice: 'Invoice', payment: 'Payment', deposit: 'Deposit', bill: 'Bill', 'bill-payment': 'BillPayment', expense: 'Purchase', 'vendor-credit': 'VendorCredit', credit: 'CreditMemo', refund: 'RefundReceipt', transfer: 'Transfer', journal: 'JournalEntry' }[value.stepKey];
  if (step.entity !== entity) fail('The additional activity step changed its transaction type.');
  if (d.activityTemplateVersion !== undefined || d.origin !== undefined || d.settlement !== undefined || d.stockQuantityRule !== undefined || d.creditAdjustment !== undefined || d.creditSettlement !== undefined) fail('An additional activity cannot borrow a monthly, stock or credit lifecycle.');
  const contract = { version: 4, activityBatch: structuredClone(value), mode: 'standard' };
  if (d.adoptedSettlement !== undefined) {
    // Settles one adopted obligation; it never depends on a managed record.
    const s = d.adoptedSettlement, payment = step.entity === 'Payment';
    exact(s, ['entity', 'qboId', 'amountCents']);
    if (!['Payment', 'BillPayment'].includes(step.entity) || s.entity !== (payment ? 'Invoice' : 'Bill') || !QBO_ID.test(s.qboId || '') || !Number.isSafeInteger(s.amountCents) || s.amountCents < 1 || s.amountCents > POLICY.maxSettlementCents || d.amountRule !== 'adopted_open_balance' || d.amountSourceKey !== undefined || (step.dependencies || []).length || (payment ? !PARTY.test(d.customerKey || '') || d.destination !== 'undeposited_funds' : !SUPPLIER.test(d.vendorKey || '') || d.fundingSource !== 'operating_bank' || d.bankMapping !== 'operatingBank')) fail('The adopted settlement terms are incomplete.');
    contract.mode = 'adopted-settlement'; contract.adopted = { entity: s.entity, qboId: s.qboId, amountCents: s.amountCents };
  } else if (d.amountRule === 'adopted_open_balance') fail('An adopted settlement must name its exact obligation.');
  if (['Invoice', 'Bill'].includes(step.entity)) { if (d.dueDate !== step.txnDate) fail('These settled activities require immediate terms.'); contract.dueDate = d.dueDate; }
  else if (d.dueDate !== undefined) fail('Only an invoice or bill may carry payment terms.');
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
  if (step.entity === 'Bill') { const line = d.lines?.[0]; if (d.lines.length !== 1 || line.itemKey !== undefined || line.accountMapping !== 'operatingExpense' || line.billableStatus !== 'NotBillable' || line.amountCents !== d.baseAmountCents) fail('The additional bill must remain a non-stock operating expense.'); contract.mode = 'operating-expense'; contract.expense = { category: d.expenseCategory, accountMapping: 'operatingExpense', amountCents: line.amountCents, billableStatus: 'NotBillable' }; }
  return contract;
}
function assertBatchPreparation(active, batch, now) {
  if (active.calendar.verifiedThrough === null || batch.day !== businessDate(new Date(now)) || shift(active.calendar.verifiedThrough, 1) !== batch.day) fail('Verify business history through yesterday before preparing today’s additional activity. Keep today open for further hourly work.');
}
module.exports = { JOURNAL_ROLES, bankRoles, POLICY, POLICY_HASH, validateChoices, makeActivityBatch, buildBatchActivity, validateActivityBatch, batchLifecycle, assertBatchPreparation };
