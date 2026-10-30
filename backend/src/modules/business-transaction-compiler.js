'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { verifyBusinessReference, validateReferenceBinding } = require('./business-reference');
const { businessDate } = require('./business-activity-preview');
const { verifyInvoiceReceivables } = require('./business-receivables-route');
const { verifyUnreceivedProof } = require('./business-purchase-order-consumption');
const { assertAccountingOnlyRequest } = require('./business-accounting-only');
const { scoped, freezeWriteRequest } = require('./qbo-write-contract');
const { validateLifecyclePolicy, installmentCents } = require('./business-lifecycle-policy');
const HASH = /^[a-f0-9]{64}$/, QBO_ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const SUPPORTED = new Set(['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment', 'CreditMemo', 'Purchase', 'VendorCredit', 'RefundReceipt', 'Transfer', 'JournalEntry', 'Customer', 'Vendor', 'Item']);
const LISTS = new Set(['Customer', 'Vendor', 'Item']);
const SALES = new Set(['Estimate', 'Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt']), PURCHASES = new Set(['PurchaseOrder', 'Bill']);
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_TRANSACTION_UNVERIFIED' }); }
function sameScope(a, b) { return ['realmId', 'environment', 'connectionId'].every(key => a?.[key] === b?.[key]); }
function fresh(stamp, now) { const value = typeof stamp === 'string' ? Date.parse(stamp) : NaN; return Number.isFinite(value) && new Date(value).toISOString() === stamp && value <= now && now - value <= 300000; }
function id(value) { if (typeof value !== 'string' || !QBO_ID.test(value)) fail('A current QuickBooks record ID is required.'); return value; }
function cents(value) { if (typeof value !== 'number' || !Number.isFinite(value)) fail('A saved money amount is missing.'); const result = Math.round(value * 100); if (!Number.isSafeInteger(result) || result < 0 || result > 1000000000000 || Math.abs(value * 100 - result) > 0.00001) fail('Money must have an exact non-negative cent value.'); return result; }
function money(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 1000000000000) fail('A planned cent amount is invalid.'); return value / 100; }
function ref(value) { return { value: id(value) }; }
function sourceItemLines(record, detailType) {
  if (!Array.isArray(record.Line) || !record.Line.length || record.Line.length > 101) fail('The source lines are unavailable.');
  const items = record.Line.filter(line => line.DetailType === detailType), others = record.Line.filter(line => line.DetailType !== detailType);
  const subtotal = items.reduce((sum, line) => sum + cents(line.Amount), 0);
  if (others.length > 1 || others.some(line => line.DetailType !== 'SubTotalLineDetail' || cents(line.Amount) !== subtotal || record.Line.at(-1) !== line)) fail('The source contains unsupported monetary or other line shapes.');
  return items;
}
function canonicalTxnType(type) { return type === 'BillPaymentCheck' ? 'BillPayment' : type; }
function links(record) { return [...(record.LinkedTxn || []), ...(record.Line || []).flatMap(line => line.LinkedTxn || [])].map(link => ({ ...link, TxnType: canonicalTxnType(link.TxnType) })); }
// Pure compiler only. All inputs must come from server-owned approved intent and
// fresh verified company evidence. A compiled request grants no write authority.
function compileBusinessTransaction({ scope, step, policy, referenceEvidence, parents = [], adopted = null, purchaseOrder = null, observationFence, now = Date.now() }) {
  scope = scoped(scope);
  if (!observationFence || !sameScope(observationFence.scope, scope) || !/^[a-f0-9]{24}$/.test(observationFence.operationId || '') || !Number.isSafeInteger(observationFence.writerRevision) || observationFence.writerRevision < 0 || observationFence.writerRevision >= Number.MAX_SAFE_INTEGER || !fresh(observationFence.observedAt, now)) fail('A current operation writer observation is required.');
  const currentObservation = value => value?.operationId === observationFence.operationId && value?.writerRevision === observationFence.writerRevision;
  if (!Number.isFinite(now) || !step || !SUPPORTED.has(step.entity) || !HASH.test(step.logicalKey || '') || !HASH.test(step.detailsHash || '') || !HASH.test(step.calendarFingerprint || '') || !Array.isArray(step.references) || step.references.length > 100 || !Array.isArray(step.dependencies) || step.dependencies.length > 20) fail('The saved transaction intent is incomplete.');
  date(step.txnDate);
  const details = step.details;
  if (!details || details.version !== 1 || details.currency !== 'CAD' || hash({ calendarFingerprint: step.calendarFingerprint, details }) !== step.detailsHash || !Array.isArray(details.lines) || details.lines.length > 100) fail('The transaction details changed.');
  if (!policy || policy.version !== 1 || policy.status !== 'approved' || !sameScope(policy.scope, scope) || policy.country !== 'CA' || policy.currency !== 'CAD' || policy.stepHash !== hash(step) || !HASH.test(policy.evidenceHash || '')) fail('An exact approved Canadian transaction policy is required.');
  const lifecycle = validateLifecyclePolicy(step, policy);
  if ((lifecycle?.mode === 'adopted-settlement') !== (adopted !== null)) fail('Adopted obligation evidence belongs only to an adopted settlement.');
  if ((lifecycle?.mode === 'purchase-order-receipt' && details.purchaseOrderReceipt.source.kind === 'adopted') !== (purchaseOrder !== null)) fail('Imported purchase-order evidence belongs only to its receiving bill.');
  require('./business-dated-tax').assertDatedTaxPolicy(step, policy);
  date(policy.fromDate); date(policy.throughDate);
  if (step.txnDate < policy.fromDate || step.txnDate > policy.throughDate || step.txnDate > businessDate(new Date(now))) fail('The transaction is outside its approved elapsed period.');
  if (!Array.isArray(referenceEvidence) || referenceEvidence.length > 100 || !Array.isArray(parents) || parents.length !== step.dependencies.length) fail('Complete current reference and dependency evidence is required.');
  const refs = new Map(), physical = new Set();
  for (const binding of step.references) {
    const key = binding.entity + ':' + binding.key;
    validateReferenceBinding(binding);
    if (refs.has(key)) fail('Every record choice needs one unique approved definition.');
    const observed = referenceEvidence.filter(value => value.entity === binding.entity && value.record?.Id === binding.id);
    if (observed.length !== 1 || !currentObservation(observed[0]) || !sameScope(observed[0].scope, scope) || !fresh(observed[0].observedAt, now) || observed[0].record.Active !== true || observed[0].recordHash !== hash(observed[0].record)) fail('A chosen company record changed or is not freshly verified.');
    let approvedBinding = binding;
    if (binding.entity === 'TaxCode' && policy.taxReferenceDefinitions) {
      const choices = policy.taxReferenceDefinitions.filter(choice => choice.key === binding.key && choice.id === binding.id && choice.originalDefinitionHash === binding.definition.hash);
      if (choices.length !== 1 || !HASH.test(choices[0].definition?.hash || '') || choices[0].definition.version !== 1) fail('The owner-reviewed tax-code definition is unavailable.');
      approvedBinding = { ...binding, definition: choices[0].definition };
    }
    const record = verifyBusinessReference({ scope, binding: approvedBinding, observed: observed[0], now }); id(record.Id);
    if (['Customer', 'Vendor'].includes(binding.entity) && record.CurrencyRef?.value !== 'CAD') fail('The transaction party must use CAD.');
    if (binding.entity === 'Customer' && record.IsProject === true) fail('A customer identity cannot silently become a project.');
    refs.set(key, record); physical.add(binding.entity + ':' + record.Id);
  }
  if (referenceEvidence.length !== physical.size) fail('Reference evidence contains unrelated or duplicate records.');
  const get = (entity, key) => { const value = refs.get(entity + ':' + key); if (!value) fail('Missing ' + entity + ' choice for ' + key + '.'); return value; };
  const account = (key, type, subtype) => { const value = get('Account', key); if (value.AccountType !== type || (subtype && value.AccountSubType !== subtype) || ((type === 'Bank' || ['Accounts Receivable', 'Accounts Payable'].includes(type)) && value.CurrencyRef?.value !== 'CAD')) fail('The ' + key + ' account does not fit this transaction.'); return value; };
  const parentMap = new Map();
  for (const dependency of step.dependencies) {
    if (parentMap.has(dependency.logicalKey) || !HASH.test(dependency.fingerprint || '')) fail('Dependency intent must be exact and unique.');
    const found = parents.filter(value => value.logicalKey === dependency.logicalKey);
    if (found.length !== 1) fail('An originating transaction is missing or duplicated.');
    const value = found[0], record = value.record;
    if (!currentObservation(value) || !sameScope(value.scope, scope) || !['verified', 'financially-verified'].includes(value.state) || value.entity !== dependency.entity || value.fingerprint !== dependency.fingerprint || !fresh(value.observedAt, now) || !record || value.qboId !== record.Id || value.syncToken !== record.SyncToken || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken || '') || value.recordHash !== hash(record)) fail('An originating transaction is stale or differs from its verified intent.');
    if (value.state === 'financially-verified') require('./business-readback').verifyPopulationFinancialParent(value, now);
    id(record.Id); date(record.TxnDate);
    if (record.TxnDate > step.txnDate || (value.entity !== 'TimeActivity' && record.CurrencyRef?.value !== 'CAD')) fail('An originating transaction has an incompatible date or currency.');
    parentMap.set(dependency.logicalKey, value);
  }
  const receivables = (value, expectedId) => {
    if (value.record.ARAccountRef !== undefined) return value.record.ARAccountRef?.value;
    if (value.entity !== 'Invoice') fail('Only invoices can use independent receivables ledger evidence.');
    if (value.state === 'financially-verified') { require('./business-readback').verifyPopulationFinancialParent(value, now); return verifyInvoiceReceivables({ observed: value, operationId: observationFence.operationId, writerRevision: observationFence.writerRevision, now }); }
    const accountId = verifyInvoiceReceivables({ observed: value, operationId: observationFence.operationId, writerRevision: observationFence.writerRevision, now }), proof = value.verification;
    if (!proof || proof.version !== 1 || proof.kind !== 'business-readback' || proof.observedHash !== value.recordHash || proof.syncToken !== value.record.SyncToken || !fresh(proof.observedAt, now) || !HASH.test(proof.evidenceHash || '') || proof.compilationHash !== value.accountRouting.compilationHash) fail('The invoice route lacks current persisted verification.');
    const savedAccount = verifyInvoiceReceivables({ observed: { ...value, accountRouting: proof.accountRouting }, now });
    if (accountId !== expectedId || savedAccount !== accountId || proof.accountRouting.receiptHash !== value.accountRouting.receiptHash || proof.accountRouting.requestHash !== value.accountRouting.requestHash || proof.accountRouting.accountDefinitionHash !== value.accountRouting.accountDefinitionHash || value.accountRouting.logicalKey !== value.logicalKey || value.accountRouting.fingerprint !== value.fingerprint) fail('The invoice route differs from its original saved verification.');
    return accountId;
  };
  const priorReceivables = (value, expectedId) => {
    if(value.record.ARAccountRef !== undefined)return value.record.ARAccountRef?.value;
    if(value.entity !== 'Payment' || value.state !== 'financially-verified')return undefined;
    require('./business-readback').verifyPopulationFinancialParent(value,now);
    const actual=require('./business-receivables-route').verifyAccountPosting({observed:value,operationId:observationFence.operationId,writerRevision:observationFence.writerRevision,now});
    return actual===expectedId?actual:undefined;
  };
  const parent = entity => { const values = [...parentMap.values()].filter(value => value.entity === entity); if (values.length !== 1) fail('Exactly one originating ' + entity + ' is required.'); return values[0]; };
  if (canonical((details.references || []).map(value => ({ logicalKey: value.logicalKey, entity: value.entity })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey))) !== canonical(step.dependencies.map(value => ({ logicalKey: value.logicalKey, entity: value.entity })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)))) fail('Transaction detail dependencies changed.');
  const parentTypes = [...parentMap.values()].map(value => value.entity).sort();
  const expectedParents = step.entity === 'Invoice' ? (details.lines.some(line => line.itemKey === 'field-service-hour') ? ['Estimate', 'TimeActivity'] : []) : ({ TimeActivity: ['Estimate'], Bill: lifecycle?.mode === 'operating-expense' || (lifecycle?.mode === 'purchase-order-receipt' && purchaseOrder) ? [] : ['PurchaseOrder'], SalesReceipt: ['Bill'], Payment: lifecycle?.mode === 'adopted-settlement' ? [] : lifecycle?.mode === 'credit-application' ? ['Invoice', 'CreditMemo'] : lifecycle?.mode === 'credit-remainder' ? ['Invoice', 'CreditMemo', 'Payment'] : lifecycle?.settlement?.stage === 'remainder' ? ['Invoice', 'Payment'] : ['Invoice'], CreditMemo: lifecycle?.mode === 'customer-credit' ? [] : ['Invoice'], BillPayment: lifecycle?.mode === 'adopted-settlement' ? [] : ['Bill'], Deposit: ['Payment'] }[step.entity] || []);
  if (step.entity === 'CreditMemo' && !['credit-adjustment', 'customer-credit'].includes(lifecycle?.mode)) fail('Credit memos require the explicit approved service-credit lifecycle.');
  if (step.entity === 'RefundReceipt' && lifecycle?.mode !== 'customer-refund') fail('Refunds require the explicit approved customer-refund lifecycle.');
  if (['Transfer', 'JournalEntry'].includes(step.entity) && lifecycle?.mode !== (step.entity === 'Transfer' ? 'bank-transfer' : 'journal-entry')) fail('Transfers and journal entries require their explicit approved lifecycle.');
  if (canonical(parentTypes) !== canonical([...expectedParents].sort())) fail('The transaction has unsupported or missing business dependencies.');
  if (LISTS.has(step.entity) !== (lifecycle?.mode === 'list-record')) fail('Customers, suppliers and items are created only through their exact list lifecycle.');
  if (LISTS.has(step.entity)) {
    // List records carry no date or posting. Only allowlisted definition fields are sent;
    // no opening balance, parent, project, quantity or arbitrary account/tax ID.
    const role = lifecycle.listRole, list = {};
    // An item description can print on customer invoice lines, so it carries the
    // business purpose (bounded); traceability stays in the step, compilation and receipt.
    const itemDescription = value => { const text = String(value?.activityBatch?.purpose || '').trim().slice(0, 500); if (text.length < 10) fail('An added service item needs its retained business purpose.'); return text; };
    if (step.entity === 'Item') {
      const income = get('Account', role.incomeRole);
      if (income.AccountType !== 'Income' || refs.size !== 1) fail('An added service item needs its exact published income account only.');
      Object.assign(list, { Name: role.name, Type: 'Service', IncomeAccountRef: ref(income.Id), UnitPrice: money(role.unitPriceCents), Description: itemDescription(lifecycle) });
    } else {
      if (refs.size) fail('An added customer or supplier references no other record.');
      Object.assign(list, { DisplayName: role.name, CurrencyRef: { value: 'CAD' }, ...(step.entity === 'Customer' ? { Notes: 'Test Data Lab activity ' + step.logicalKey } : {}), ...(role.email ? { PrimaryEmailAddr: { Address: role.email } } : {}), ...(role.phone ? { PrimaryPhone: { FreeFormNumber: role.phone } } : {}) });
    }
    assertAccountingOnlyRequest(step.entity, list);
    const request = freezeWriteRequest(scope, 'POST', step.entity.toLowerCase(), list);
    const evidenceHash = hash({ observationFence, policy: policy.evidenceHash, references: referenceEvidence.map(value => ({ entity: value.entity, id: value.record.Id, recordHash: value.recordHash })) });
    const observedAt = [...referenceEvidence, observationFence].map(value => value.observedAt).sort()[0];
    const artifact = { version: 1, logicalKey: step.logicalKey, entity: step.entity, intentHash: hash(step), request, evidenceHash, relationships: [] };
    const compilationHash = hash(artifact);
    return { ...artifact, compilationHash, dispatchEvidence: { artifact, compilationHash, scope, operationId: observationFence.operationId, logicalKey: step.logicalKey, intentHash: hash(step), requestHash: request.requestHash, evidenceHash, writerRevision: observationFence.writerRevision, observedAt }, authorized: false };
  }
  const payload = { TxnDate: step.txnDate, ...(step.entity === 'TimeActivity' ? {} : { CurrencyRef: { value: 'CAD' }, PrivateNote: 'Test Data Lab activity ' + step.logicalKey }) };
  if (lifecycle?.dueDate) payload.DueDate = lifecycle.dueDate;
  if (details.customerKey) payload.CustomerRef = ref(get('Customer', details.customerKey).Id);
  if (details.vendorKey) payload.VendorRef = ref(get('Vendor', details.vendorKey).Id);
  const relationships = [...parentMap.values()].map(value => ({ logicalKey: value.logicalKey, entity: value.entity, qboId: value.qboId, syncToken: value.syncToken, fingerprint: value.fingerprint, kind: 'prerequisite', links: [] }));
  const relate = (value, path, txnLineId) => {
    const relationship = relationships.find(row => row.logicalKey === value.logicalKey); relationship.kind = 'linked'; relationship.links.push({ path, ...(txnLineId !== undefined ? { txnLineId } : {}) });
    return { TxnId: value.qboId, TxnType: value.entity, ...(txnLineId !== undefined ? { TxnLineId: txnLineId } : {}) };
  };
  if (lifecycle?.mode === 'operating-expense') {
    const tax = get('TaxCode', 'purchaseTax');
    if (step.entity !== 'Bill' || !payload.VendorRef || payload.CustomerRef || policy.tax?.calculation !== 'TaxExcluded' || policy.tax.purchaseTax !== tax.Id) fail('Operating expense requires its exact supplier and purchase-tax policy.');
    payload.GlobalTaxCalculation = 'TaxExcluded';
    payload.APAccountRef = ref(account('accountsPayable', 'Accounts Payable', 'AccountsPayable').Id);
    payload.Line = [{ Amount: money(lifecycle.expense.amountCents), DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: ref(account(lifecycle.expense.accountMapping, 'Expense').Id), BillableStatus: 'NotBillable', TaxCodeRef: ref(tax.Id) } }];
  } else if (lifecycle?.mode === 'cash-expense' || lifecycle?.mode === 'supplier-credit') {
    // One nonbillable operating-expense line with purchase tax. A cash expense is paid
    // straight from the operating bank; a supplier credit reduces accounts payable.
    const tax = get('TaxCode', 'purchaseTax'), cash = lifecycle.mode === 'cash-expense', expense = lifecycle.expense;
    if (step.entity !== (cash ? 'Purchase' : 'VendorCredit') || !payload.VendorRef || payload.CustomerRef || details.taxMapping !== 'purchaseTax' || policy.tax?.calculation !== 'TaxExcluded' || policy.tax.purchaseTax !== tax.Id || details.lines.length !== 1 || details.lines[0].amountCents !== expense.amountCents || details.baseAmountCents !== expense.amountCents) fail('This expense requires its exact supplier, amount and purchase-tax policy.');
    payload.GlobalTaxCalculation = 'TaxExcluded';
    payload.Line = [{ Amount: money(expense.amountCents), DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: ref(account(expense.accountMapping, 'Expense').Id), BillableStatus: 'NotBillable', TaxCodeRef: ref(tax.Id) } }];
    if (cash) {
      if (details.bankMapping !== 'operatingBank' || details.fundingSource !== 'operating_bank') fail('A cash expense must be paid from the operating bank.');
      const vendor = payload.VendorRef.value; delete payload.VendorRef;
      Object.assign(payload, { PaymentType: 'Cash', AccountRef: ref(account(details.bankMapping, 'Bank').Id), EntityRef: { value: vendor, type: 'Vendor' } });
    } else payload.APAccountRef = ref(account('accountsPayable', 'Accounts Payable', 'AccountsPayable').Id);
  } else if (lifecycle?.mode === 'bank-transfer') {
    // Moves an exact amount between two published bank accounts. No party, no tax.
    const terms = lifecycle.transfer;
    if (payload.CustomerRef || payload.VendorRef || details.taxMapping !== undefined || details.lines.length || terms.fromKey === terms.toKey || details.bankMapping !== terms.fromKey || details.toBankMapping !== terms.toKey || details.baseAmountCents !== terms.amountCents) fail('A transfer needs its exact two bank accounts and amount.');
    Object.assign(payload, { FromAccountRef: ref(account(terms.fromKey, 'Bank').Id), ToAccountRef: ref(account(terms.toKey, 'Bank').Id), Amount: money(terms.amountCents) });
  } else if (lifecycle?.mode === 'journal-entry') {
    // Balanced lines on published roles only; each role keeps its approved account type.
    const { MAPPINGS } = require('./blueprint-draft');
    if (payload.CustomerRef || payload.VendorRef || details.taxMapping !== undefined || canonical(lifecycle.journal) !== canonical(details.lines.map(line => ({ accountMapping: line.accountMapping, postingType: line.postingType, amountCents: line.amountCents })))) fail('A journal entry needs its exact approved balanced lines.');
    payload.Line = lifecycle.journal.map(line => { const role = MAPPINGS[line.accountMapping]; if (!role || role.entity !== 'Account' || !require('./business-activity-batch').JOURNAL_ROLES.includes(line.accountMapping)) fail('A journal line names an unpublished account role.'); return { Amount: money(line.amountCents), DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: line.postingType, AccountRef: ref(account(line.accountMapping, role.types[0], role.subtypes?.[0]).Id) } }; });
  } else if (SALES.has(step.entity) || PURCHASES.has(step.entity)) {
    if (details.amountRule !== 'lines_before_tax' || !details.lines.length || policy.tax?.calculation !== 'TaxExcluded') fail('These item transactions require the approved before-tax line policy.');
    const sales = SALES.has(step.entity), party = sales ? 'CustomerRef' : 'VendorRef';
    if (!payload[party] || (sales && payload.VendorRef) || (!sales && payload.CustomerRef)) fail('The transaction needs its exact party type.');
    const taxKey = sales ? 'salesTax' : 'purchaseTax', tax = get('TaxCode', taxKey);
    if (details.taxMapping !== taxKey || policy.tax[taxKey] !== tax.Id) fail('The approved Canadian tax code does not match the transaction.');
    payload.GlobalTaxCalculation = 'TaxExcluded';
    if (!sales) payload.APAccountRef = ref(account('accountsPayable', 'Accounts Payable', 'AccountsPayable').Id);
    if (['Invoice', 'CreditMemo'].includes(step.entity)) payload.ARAccountRef = ref(account('accountsReceivable', 'Accounts Receivable', 'AccountsReceivable').Id);
    if (step.entity === 'SalesReceipt') payload.DepositToAccountRef = ref(account(details.bankMapping, 'Bank').Id);
    // QuickBooks names the account a refund is paid from DepositToAccountRef.
    if (step.entity === 'RefundReceipt') { if (details.bankMapping !== 'operatingBank' || details.fundingSource !== 'operating_bank') fail('A refund must be paid from the operating bank.'); payload.DepositToAccountRef = ref(account(details.bankMapping, 'Bank').Id); }
    const lineKeys = new Set(), stockRequired = new Map();
    payload.Line = details.lines.map(line => {
      if (!line.key || lineKeys.has(line.key) || typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 1000000 || !Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents <= 0) fail('A planned item line has invalid quantity, rate or identity.');
      lineKeys.add(line.key);
      if (Math.abs(line.quantity * line.unitPriceCents - line.amountCents) > 0.00001) fail('The planned line amount does not equal quantity times rate.');
      const item = get('Item', line.itemKey), stock = !sales || step.entity === 'SalesReceipt';
      if (item.Type !== (stock ? 'Inventory' : 'Service')) fail('The chosen product type changed.');
      if (stock) {
        stockRequired.set(item.Id, (stockRequired.get(item.Id) || 0) + line.quantity);
        if (step.entity === 'SalesReceipt' && (typeof item.QtyOnHand !== 'number' || !Number.isFinite(item.QtyOnHand) || item.QtyOnHand < stockRequired.get(item.Id))) fail('Fresh stock availability does not cover the sale.');
        if (item.AssetAccountRef?.value !== account('inventoryAsset', 'Other Current Asset', 'Inventory').Id || item.ExpenseAccountRef?.value !== account('costOfGoods', 'Cost of Goods Sold').Id || item.IncomeAccountRef?.value !== account('supplyIncome', 'Income').Id) fail('Inventory product accounts changed.');
      } else if (item.IncomeAccountRef?.value !== account(line.accountMapping, 'Income').Id) fail('Service product income account changed.');
      const detailType = sales ? 'SalesItemLineDetail' : 'ItemBasedExpenseLineDetail';
      return { Amount: money(line.amountCents), DetailType: detailType, [detailType]: { ItemRef: ref(item.Id), Qty: line.quantity, UnitPrice: money(line.unitPriceCents), TaxCodeRef: ref(tax.Id) } };
    });
    if (details.baseAmountCents !== details.lines.reduce((sum, line) => sum + line.amountCents, 0)) fail('The planned transaction subtotal changed.');
    if (step.entity === 'CreditMemo' && lifecycle.mode === 'credit-adjustment') {
      const source = parent('Invoice'), invoice = source.record, original = sourceItemLines(invoice, 'SalesItemLineDetail'), issued = payload.Line[0], originalLine = original[0], taxLines = invoice.TxnTaxDetail?.TaxLine || [], expectedTax = policy.readbackTax;
      if (source.logicalKey !== lifecycle.credit.invoiceKey || invoice.TxnDate !== details.origin.occurrence || invoice.CustomerRef?.value !== payload.CustomerRef.value || receivables(source, payload.ARAccountRef.value) !== payload.ARAccountRef.value || invoice.GlobalTaxCalculation !== 'TaxExcluded' || original.length !== 1 || payload.Line.length !== 1 || originalLine.SalesItemLineDetail?.ItemRef?.value !== issued.SalesItemLineDetail.ItemRef.value || originalLine.SalesItemLineDetail?.Qty !== 1 || originalLine.SalesItemLineDetail?.TaxCodeRef?.value !== issued.SalesItemLineDetail.TaxCodeRef.value || cents(originalLine.Amount) !== cents(originalLine.SalesItemLineDetail.UnitPrice) || cents(originalLine.Amount) !== cents(issued.Amount) * 10 || cents(invoice.Balance) !== cents(invoice.TotalAmt) || links(invoice).length) fail('The original care invoice changed or is no longer wholly unsettled.');
      if (!expectedTax || !Array.isArray(taxLines) || taxLines.length !== expectedTax.lines?.length || taxLines.some(line => line.DetailType !== 'TaxLineDetail') || expectedTax.lines.some(line => taxLines.filter(originalTax => originalTax.TaxLineDetail?.TaxRateRef?.value === line.rateId && originalTax.TaxLineDetail?.TaxPercent === line.percent && originalTax.TaxLineDetail?.PercentBased === true).length !== 1)) fail('The original invoice and credit require the same exact tax-rate identities and percentages.');
      const relationship = relationships.find(row => row.logicalKey === source.logicalKey); relationship.sourceTxnDate = invoice.TxnDate;
    }
    if (step.entity === 'Bill' || (step.entity === 'Invoice' && parentTypes.length)) {
      const source = purchaseOrder || parent(step.entity === 'Bill' ? 'PurchaseOrder' : 'Estimate');
      if (lifecycle?.mode === 'purchase-order-receipt') {
        const selected = details.purchaseOrderReceipt;
        if (source.qboId !== selected.purchaseOrderId || source.logicalKey !== selected.source.logicalKey || source.record.TxnDate !== selected.source.txnDate || source.entity !== 'PurchaseOrder') fail('The receiving bill changed its original purchase order.');
        if (purchaseOrder) {
          if (!currentObservation(source) || !sameScope(source.scope, scope) || !fresh(source.observedAt, now) || source.recordHash !== hash(source.record)) fail('The imported purchase order is not freshly observed inside this writer fence.');
          require('./business-readback').verifyPopulationFinancialParent(source, now);
        }
        require('./business-purchase-order-receipt').unreceived(source.record);
      }
      if (source.record[party]?.value !== payload[party].value || source.record.GlobalTaxCalculation !== 'TaxExcluded') fail('The source party or tax calculation changed.');
      if (source.entity === 'PurchaseOrder' && (source.record.POStatus !== 'Open' || links(source.record).some(link => link.TxnType === 'Bill'))) fail('The purchase order is no longer wholly unbilled.');
      if (source.entity === 'Estimate' && (!['Pending', 'Accepted'].includes(source.record.TxnStatus) || links(source.record).some(link => link.TxnType === 'Invoice'))) fail('The estimate is no longer available for this invoice.');
      const detailType = source.entity === 'PurchaseOrder' ? 'ItemBasedExpenseLineDetail' : 'SalesItemLineDetail';
      const sourceLines = sourceItemLines(source.record, detailType), used = new Set();
      if (sourceLines.length !== payload.Line.length) fail('The source item lines do not match the approved complete conversion.');
      payload.LinkedTxn = [purchaseOrder ? { TxnId: source.qboId, TxnType: 'PurchaseOrder' } : relate(source, 'LinkedTxn')];
      payload.Line.forEach((line, index) => {
        const wanted = line[line.DetailType], found = sourceLines.filter(value => value[detailType]?.ItemRef?.value === wanted.ItemRef.value && value[detailType]?.Qty === wanted.Qty && cents(value[detailType]?.UnitPrice) === cents(wanted.UnitPrice) && cents(value.Amount) === cents(line.Amount) && (value[detailType]?.TaxCodeRef?.value === wanted.TaxCodeRef.value || require('./business-dated-tax').permitsDatedConversion(step, policy, source, value[detailType]?.TaxCodeRef?.value, wanted.TaxCodeRef.value)));
        if (found.length !== 1 || used.has(found[0].Id)) fail('The originating line cannot be matched unambiguously.');
        const sourceLine = found[0]; id(sourceLine.Id); used.add(sourceLine.Id);
        if (lifecycle?.mode === 'purchase-order-receipt' && sourceLine.Id !== details.lines[index].key) fail('The receiving bill changed its exact purchase-order line.');
        if (source.entity === 'PurchaseOrder' && sourceLine.Received !== 0 && !(sourceLine.Received === undefined && (source.state === 'financially-verified' ? require('./business-population-proof').assertUnreceivedParent(source, now) : verifyUnreceivedProof(source, now)))) fail('The originating purchase-order line is already consumed or its consumed quantity is unknown.');
        if (source.entity === 'PurchaseOrder') line.LinkedTxn = [purchaseOrder ? { TxnId: source.qboId, TxnType: 'PurchaseOrder', TxnLineId: sourceLine.Id } : relate(source, 'Line.' + index + '.LinkedTxn', sourceLine.Id)];
        else {
          // A complete Estimate converts at document level; retain its exact
          // sole source line internally without requesting a progress line.
          const relationship = relationships.find(row => row.logicalKey === source.logicalKey);
          relationship.representation = 'whole-estimate-header';
          relationship.sourceLineId = sourceLine.Id;
        }
      });
      if (step.entity === 'Invoice') {
        const time = parent('TimeActivity');
        if (time.record.CustomerRef?.value !== payload.CustomerRef.value || time.record.BillableStatus !== 'Billable' || time.record.ItemRef?.value !== payload.Line[0].SalesItemLineDetail.ItemRef.value) fail('Time does not match this billable client service.');
        if (payload.Line.length !== 1 || !Number.isInteger(time.record.Hours) || !Number.isInteger(time.record.Minutes) || time.record.Minutes < 0 || time.record.Minutes > 59 || Math.abs(time.record.Hours + time.record.Minutes / 60 - payload.Line[0].SalesItemLineDetail.Qty) > 0.000001) fail('The invoiced hours do not match the saved work.');
        payload.LinkedTxn.push(relate(time, 'LinkedTxn'));
      }
    }
    if (step.entity === 'SalesReceipt') {
      const source = parent('Bill'), stocked = sourceItemLines(source.record, 'ItemBasedExpenseLineDetail');
      if (stocked.length !== payload.Line.length || payload.Line.some(line => stocked.filter(value => value.ItemBasedExpenseLineDetail?.ItemRef?.value === line.SalesItemLineDetail.ItemRef.value && value.ItemBasedExpenseLineDetail.Qty === (lifecycle?.stock?.purchasedQuantity ?? line.SalesItemLineDetail.Qty)).length !== 1)) fail('Stock sale does not match its verified receipt of stock.');
    }
  } else if (step.entity === 'TimeActivity') {
    const estimate = parent('Estimate');
    if (details.amountRule !== 'time_only' || details.billable !== true || !Number.isInteger(details.hours) || details.hours < 1 || details.hours > 24 || !payload.CustomerRef || estimate.record.CustomerRef?.value !== payload.CustomerRef.value) fail('Billable time requires an exact approved client and whole-hour duration.');
    const item = get('Item', details.itemKey); if (item.Type !== 'Service') fail('Billable time needs a service item.');
    const quoted = sourceItemLines(estimate.record, 'SalesItemLineDetail');
    if (quoted.length !== 1 || quoted[0].SalesItemLineDetail?.ItemRef?.value !== item.Id || quoted[0].SalesItemLineDetail?.Qty !== details.hours) fail('Recorded time does not match the quoted service hours.');
    Object.assign(payload, { NameOf: 'Employee', EmployeeRef: ref(get('Employee', details.workerKey).Id), ItemRef: ref(item.Id), Hours: details.hours, Minutes: 0, BillableStatus: 'Billable', Description: 'Test Data Lab activity ' + step.logicalKey });
  } else if (lifecycle?.mode === 'adopted-settlement') {
    // Settles an obligation from the adopted import. The obligation is not a managed
    // dependency: it is freshly read, bound to its saved import record and the
    // adoption, and may only be reduced, never overpaid.
    const terms = lifecycle.adopted, invoice = terms.entity === 'Invoice', record = adopted?.record, origin = adopted?.population;
    if (!adopted || !currentObservation(adopted) || !sameScope(adopted.scope, scope) || !fresh(adopted.observedAt, now) || adopted.entity !== terms.entity || !record || record.Id !== terms.qboId || adopted.recordHash !== hash(record) || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken) || record.status === 'Deleted' || !origin || origin.entity !== terms.entity || origin.qboId !== terms.qboId || !HASH.test(origin.logicalKey || '') || !/^[a-f0-9]{24}$/.test(origin.adoptionId || '') || origin.txnDate > step.txnDate || record.TxnDate !== origin.txnDate) fail('The adopted obligation is not freshly bound to its imported record.');
    if (details.lines.length || details.amountRule !== 'adopted_open_balance' || (invoice ? origin.partyKey !== details.customerKey : origin.partyKey !== details.vendorKey)) fail('The adopted settlement names another party or amount rule.');
    const party = invoice ? 'CustomerRef' : 'VendorRef', amount = terms.amountCents, balance = cents(record.Balance);
    if (!payload[party] || record[party]?.value !== payload[party].value || record.CurrencyRef?.value !== 'CAD' || !Number.isSafeInteger(balance) || amount < 1 || amount > balance || amount > cents(record.TotalAmt)) fail('The adopted obligation party changed or its open balance does not cover this settlement.');
    const control = invoice ? account('accountsReceivable', 'Accounts Receivable', 'AccountsReceivable').Id : account('accountsPayable', 'Accounts Payable', 'AccountsPayable').Id, posted = invoice ? record.ARAccountRef : record.APAccountRef;
    if (origin.accountId !== control || (posted !== undefined && posted?.value !== control)) fail('The adopted obligation posted to another control account.');
    payload.TotalAmt = money(amount); payload.Line = [{ Amount: money(amount), LinkedTxn: [{ TxnId: record.Id, TxnType: terms.entity }] }];
    if (invoice) Object.assign(payload, { DepositToAccountRef: ref(account('undepositedFunds', 'Other Current Asset', 'UndepositedFunds').Id), ARAccountRef: ref(control), ProcessPayment: false });
    else Object.assign(payload, { APAccountRef: ref(control), PayType: 'Check', CheckPayment: { BankAccountRef: ref(account(details.bankMapping, 'Bank').Id), PrintStatus: 'NotSet' } });
  } else {
    if ((!lifecycle?.settlement && !['credit-application', 'credit-remainder'].includes(lifecycle?.mode) && details.amountRule !== 'saved_originating_total') || details.lines.length) fail('Settlement must use its saved source total.');
    const source = parent({ Payment: 'Invoice', BillPayment: 'Bill', Deposit: 'Payment' }[step.entity]);
    if (details.amountSourceKey !== source.logicalKey) fail('Settlement names another originating transaction.');
    const original = cents(source.record.TotalAmt); let amount = original; if (!amount) fail('Settlement requires a positive saved total.');
    const party = step.entity === 'BillPayment' ? 'VendorRef' : 'CustomerRef';
    if (!payload[party] || source.record[party]?.value !== payload[party].value) fail('Settlement party differs from the saved source.');
    if (['credit-application', 'credit-remainder'].includes(lifecycle?.mode)) {
      const credit = parent('CreditMemo'), cm = credit.record, credited = cents(cm.TotalAmt), ar = account('accountsReceivable', 'Accounts Receivable', 'AccountsReceivable').Id;
      if (step.entity !== 'Payment' || source.logicalKey !== lifecycle.credit.invoiceKey || credit.logicalKey !== lifecycle.credit.creditMemoKey || source.record.CustomerRef?.value !== payload.CustomerRef.value || cm.CustomerRef?.value !== payload.CustomerRef.value || cm.ARAccountRef?.value !== ar || receivables(source, ar) !== ar || credited <= 0 || credited >= original) fail('The exact invoice and managed credit do not form this customer settlement.');
      if (lifecycle.mode === 'credit-application') {
        if (cents(source.record.Balance) !== original || cents(cm.RemainingCredit) !== credited || links(source.record).length || links(cm).length) fail('The managed invoice or credit has already been consumed.');
        amount = 0;
      } else {
        const prior = parent('Payment'), record = prior.record, invoiceLinks = links(source.record), creditLinks = links(cm), lines = record.Line || [];
        const matched = (type, id) => lines.filter(line => cents(line.Amount) === credited && line.LinkedTxn?.length === 1 && line.LinkedTxn[0].TxnType === type && line.LinkedTxn[0].TxnId === id && [undefined, '0'].includes(line.LinkedTxn[0].TxnLineId)).length === 1;
        if (prior.logicalKey !== lifecycle.credit.applicationKey || record.CustomerRef?.value !== payload.CustomerRef.value || record.ARAccountRef?.value !== ar || record.DepositToAccountRef?.value !== account('operatingBank', 'Bank').Id || record.ProcessPayment === true || cents(record.TotalAmt) !== 0 || cents(record.UnappliedAmt) !== 0 || lines.length !== 2 || !matched('Invoice', source.qboId) || !matched('CreditMemo', credit.qboId) || cents(cm.RemainingCredit) !== 0 || cents(source.record.Balance) !== original - credited || invoiceLinks.length !== 1 || invoiceLinks[0].TxnType !== 'Payment' || invoiceLinks[0].TxnId !== prior.qboId || creditLinks.length !== 1 || creditLinks[0].TxnType !== 'Payment' || creditLinks[0].TxnId !== prior.qboId) fail('The original zero-funds application and exact remaining balances changed.');
        amount = original - credited;
      }
    } else if (lifecycle?.settlement) {
      if (step.entity !== 'Payment') fail('Installments can only settle the original managed invoice.');
      const first = installmentCents(original);
      if (first <= 0 || first >= original) fail('The accepted total cannot be split into two positive installments.');
      if (lifecycle.settlement.stage === 'first') {
        if (cents(source.record.Balance) !== original || links(source.record).some(link => ['Payment', 'CreditMemo'].includes(link.TxnType))) fail('The installment source was already settled.');
        amount = first;
      } else {
        const prior = parent('Payment');
        const invoiceLinks = links(source.record).filter(link => ['Payment', 'CreditMemo'].includes(link.TxnType));
        if (prior.logicalKey !== lifecycle.settlement.priorPaymentKey || prior.record.CustomerRef?.value !== payload.CustomerRef?.value || priorReceivables(prior,account('accountsReceivable','Accounts Receivable','AccountsReceivable').Id) !== receivables(source, account('accountsReceivable', 'Accounts Receivable', 'AccountsReceivable').Id) || prior.record.DepositToAccountRef?.value !== account('undepositedFunds', 'Other Current Asset', 'UndepositedFunds').Id || cents(prior.record.UnappliedAmt) !== 0 || cents(prior.record.TotalAmt) !== first || prior.record.Line?.length !== 1 || cents(prior.record.Line[0].Amount) !== first || (!Array.isArray(prior.record.Line[0].LinkedTxn) || prior.record.Line[0].LinkedTxn.length !== 1 || prior.record.Line[0].LinkedTxn[0].TxnId !== source.qboId || prior.record.Line[0].LinkedTxn[0].TxnType !== 'Invoice' || ![undefined, '0'].includes(prior.record.Line[0].LinkedTxn[0].TxnLineId)) || invoiceLinks.length !== 1 || invoiceLinks[0].TxnType !== 'Payment' || invoiceLinks[0].TxnId !== prior.qboId || cents(source.record.Balance) !== original - first) fail('The prior managed installment and exact remaining invoice balance no longer agree.');
        amount = original - first;
      }
    } else if (step.entity !== 'Deposit' && cents(source.record.Balance) !== amount) fail('The source is already partly or fully settled.');
    payload.TotalAmt = money(amount); payload.Line = [{ Amount: money(amount), LinkedTxn: [relate(source, 'Line.0.LinkedTxn')] }];
    if (lifecycle?.mode === 'credit-application') {
      const credit = parent('CreditMemo'), amount = cents(credit.record.TotalAmt);
      payload.Line = [{ Amount: money(amount), LinkedTxn: payload.Line[0].LinkedTxn }, { Amount: money(amount), LinkedTxn: [relate(credit, 'Line.1.LinkedTxn')] }];
    }
    if (step.entity === 'Payment') {
      const destination = details.destination === 'undeposited_funds' ? account('undepositedFunds', 'Other Current Asset', 'UndepositedFunds') : details.destination === 'operating_bank' ? account(details.bankMapping, 'Bank') : null;
      const ar = account('accountsReceivable', 'Accounts Receivable', 'AccountsReceivable').Id;
      if (!destination || receivables(source, ar) !== ar) fail('Payment destination or receivables account is not verified.');
      Object.assign(payload, { DepositToAccountRef: ref(destination.Id), ARAccountRef: ref(ar), ProcessPayment: false });
    } else if (step.entity === 'BillPayment') {
      if (details.fundingSource !== 'operating_bank' || source.record.APAccountRef?.value !== account('accountsPayable', 'Accounts Payable', 'AccountsPayable').Id) fail('Bill payment funding or payables account is not verified.');
      Object.assign(payload, { APAccountRef: ref(source.record.APAccountRef.value), PayType: 'Check', CheckPayment: { BankAccountRef: ref(account(details.bankMapping, 'Bank').Id), PrintStatus: 'NotSet' } });
    } else {
      const available = source.availability;
      if (!available || !sameScope(available.scope, scope) || !fresh(available.observedAt, now) || available.kind !== 'undeposited_payment' || available.status !== 'available' || available.recordHash !== source.recordHash || !HASH.test(available.evidenceHash || '') || !currentObservation(available)) fail('Deposit requires current explicit undeposited availability evidence.');
      const holding = account('undepositedFunds', 'Other Current Asset', 'UndepositedFunds');
      if (details.destination !== 'operating_bank' || source.record.DepositToAccountRef?.value !== holding.Id || cents(source.record.UnappliedAmt) !== 0 || links(source.record).some(link => link.TxnType === 'Deposit')) fail('The payment is not an available fully applied undeposited receipt.');
      delete payload.CustomerRef; delete payload.TotalAmt;
      payload.DepositToAccountRef = ref(account(details.bankMapping, 'Bank').Id);
      payload.GlobalTaxCalculation = 'NotApplicable';
      for(const line of payload.Line)for(const link of line.LinkedTxn)link.TxnLineId='0';
    }
  }
  assertAccountingOnlyRequest(step.entity, payload);
  const request = freezeWriteRequest(scope, 'POST', step.entity.toLowerCase(), payload);
  const evidenceHash = hash({ observationFence, policy: policy.evidenceHash, ...(purchaseOrder ? { purchaseOrder: { recordHash: purchaseOrder.recordHash, logicalKey: purchaseOrder.logicalKey, proofHash: purchaseOrder.financialProof.evidenceHash } } : {}), ...(adopted ? { adopted: { entity: adopted.entity, id: adopted.record.Id, recordHash: adopted.recordHash, logicalKey: adopted.population.logicalKey, adoptionId: adopted.population.adoptionId } } : {}), references: referenceEvidence.map(value => ({ entity: value.entity, id: value.record.Id, recordHash: value.recordHash })).sort((a, b) => (a.entity + a.id).localeCompare(b.entity + b.id)), parents: parents.map(value => ({ logicalKey: value.logicalKey, recordHash: value.recordHash, availabilityHash: value.availability?.evidenceHash || null, ...(value.verification?.purchaseOrderConsumption ? { purchaseOrderConsumptionHash: value.verification.purchaseOrderConsumption.evidenceHash, purchaseOrderVerificationHash: value.verification.evidenceHash } : {}), ...(value.accountRouting ? { accountRoutingHash: value.accountRouting.evidenceHash, verificationHash: value.verification?.evidenceHash || null } : {}) })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)) });
  const observedAt = [...referenceEvidence, ...parents, ...(purchaseOrder ? [purchaseOrder] : []), ...(adopted ? [adopted] : []), ...parents.filter(value => value.availability).map(value => value.availability), ...parents.filter(value => value.accountRouting).map(value => value.accountRouting), ...parents.filter(value => value.verification?.purchaseOrderConsumption).map(value => value.verification), observationFence].map(value => value.observedAt).sort()[0];
  const artifact = { version: 1, logicalKey: step.logicalKey, entity: step.entity, intentHash: hash(step), request, evidenceHash, relationships };
  const compilationHash = hash(artifact);
  return { ...artifact, compilationHash, dispatchEvidence: { artifact, compilationHash, scope, operationId: observationFence.operationId, logicalKey: step.logicalKey, intentHash: hash(step), requestHash: request.requestHash, evidenceHash, writerRevision: observationFence.writerRevision, observedAt }, authorized: false };
}
module.exports = { compileBusinessTransaction, SUPPORTED, LISTS, canonicalTxnType };
