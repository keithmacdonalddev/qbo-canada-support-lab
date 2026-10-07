'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { verifyBusinessReference, validateReferenceBinding } = require('./business-reference');
const { businessDate } = require('./business-activity-preview');
const { scoped, freezeWriteRequest } = require('./qbo-write-contract');
const HASH = /^[a-f0-9]{64}$/, QBO_ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
const SUPPORTED = new Set(['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment']);
const SALES = new Set(['Estimate', 'Invoice', 'SalesReceipt']), PURCHASES = new Set(['PurchaseOrder', 'Bill']);
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
function links(record) { return [...(record.LinkedTxn || []), ...(record.Line || []).flatMap(line => line.LinkedTxn || [])]; }
// Pure compiler only. All inputs must come from server-owned approved intent and
// fresh verified company evidence. A compiled request grants no write authority.
function compileBusinessTransaction({ scope, step, policy, referenceEvidence, parents = [], observationFence, now = Date.now() }) {
  scope = scoped(scope);
  if (!observationFence || !sameScope(observationFence.scope, scope) || !/^[a-f0-9]{24}$/.test(observationFence.operationId || '') || !Number.isSafeInteger(observationFence.writerRevision) || observationFence.writerRevision < 0 || observationFence.writerRevision >= Number.MAX_SAFE_INTEGER || !fresh(observationFence.observedAt, now)) fail('A current operation writer observation is required.');
  const currentObservation = value => value?.operationId === observationFence.operationId && value?.writerRevision === observationFence.writerRevision;
  if (!Number.isFinite(now) || !step || !SUPPORTED.has(step.entity) || !HASH.test(step.logicalKey || '') || !HASH.test(step.detailsHash || '') || !HASH.test(step.calendarFingerprint || '') || !Array.isArray(step.references) || step.references.length > 100 || !Array.isArray(step.dependencies) || step.dependencies.length > 20) fail('The saved transaction intent is incomplete.');
  date(step.txnDate);
  const details = step.details;
  if (!details || details.version !== 1 || details.currency !== 'CAD' || hash({ calendarFingerprint: step.calendarFingerprint, details }) !== step.detailsHash || !Array.isArray(details.lines) || details.lines.length > 100) fail('The transaction details changed.');
  if (!policy || policy.version !== 1 || policy.status !== 'approved' || !sameScope(policy.scope, scope) || policy.country !== 'CA' || policy.currency !== 'CAD' || policy.stepHash !== hash(step) || !HASH.test(policy.evidenceHash || '')) fail('An exact approved Canadian transaction policy is required.');
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
    const record = verifyBusinessReference({ scope, binding, observed: observed[0], now }); id(record.Id);
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
    if (!currentObservation(value) || !sameScope(value.scope, scope) || value.state !== 'verified' || value.entity !== dependency.entity || value.fingerprint !== dependency.fingerprint || !fresh(value.observedAt, now) || !record || value.qboId !== record.Id || value.syncToken !== record.SyncToken || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken || '') || value.recordHash !== hash(record)) fail('An originating transaction is stale or differs from its verified intent.');
    id(record.Id); date(record.TxnDate);
    if (record.TxnDate > step.txnDate || (value.entity !== 'TimeActivity' && record.CurrencyRef?.value !== 'CAD')) fail('An originating transaction has an incompatible date or currency.');
    parentMap.set(dependency.logicalKey, value);
  }
  const parent = entity => { const values = [...parentMap.values()].filter(value => value.entity === entity); if (values.length !== 1) fail('Exactly one originating ' + entity + ' is required.'); return values[0]; };
  if (canonical((details.references || []).map(value => ({ logicalKey: value.logicalKey, entity: value.entity })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey))) !== canonical(step.dependencies.map(value => ({ logicalKey: value.logicalKey, entity: value.entity })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)))) fail('Transaction detail dependencies changed.');
  const parentTypes = [...parentMap.values()].map(value => value.entity).sort();
  const expectedParents = step.entity === 'Invoice' ? (details.lines.some(line => line.itemKey === 'field-service-hour') ? ['Estimate', 'TimeActivity'] : []) : ({ TimeActivity: ['Estimate'], Bill: ['PurchaseOrder'], SalesReceipt: ['Bill'], Payment: ['Invoice'], BillPayment: ['Bill'], Deposit: ['Payment'] }[step.entity] || []);
  if (canonical(parentTypes) !== canonical([...expectedParents].sort())) fail('The transaction has unsupported or missing business dependencies.');
  const payload = { TxnDate: step.txnDate, ...(step.entity === 'TimeActivity' ? {} : { CurrencyRef: { value: 'CAD' }, PrivateNote: 'Test Data Lab activity ' + step.logicalKey }) };
  if (details.customerKey) payload.CustomerRef = ref(get('Customer', details.customerKey).Id);
  if (details.vendorKey) payload.VendorRef = ref(get('Vendor', details.vendorKey).Id);
  const relationships = [...parentMap.values()].map(value => ({ logicalKey: value.logicalKey, entity: value.entity, qboId: value.qboId, syncToken: value.syncToken, fingerprint: value.fingerprint, kind: 'prerequisite', links: [] }));
  const relate = (value, path, txnLineId) => {
    const relationship = relationships.find(row => row.logicalKey === value.logicalKey); relationship.kind = 'linked'; relationship.links.push({ path, ...(txnLineId !== undefined ? { txnLineId } : {}) });
    return { TxnId: value.qboId, TxnType: value.entity, ...(txnLineId !== undefined ? { TxnLineId: txnLineId } : {}) };
  };
  if (SALES.has(step.entity) || PURCHASES.has(step.entity)) {
    if (details.amountRule !== 'lines_before_tax' || !details.lines.length || policy.tax?.calculation !== 'TaxExcluded') fail('These item transactions require the approved before-tax line policy.');
    const sales = SALES.has(step.entity), party = sales ? 'CustomerRef' : 'VendorRef';
    if (!payload[party] || (sales && payload.VendorRef) || (!sales && payload.CustomerRef)) fail('The transaction needs its exact party type.');
    const taxKey = sales ? 'salesTax' : 'purchaseTax', tax = get('TaxCode', taxKey);
    if (details.taxMapping !== taxKey || policy.tax[taxKey] !== tax.Id) fail('The approved Canadian tax code does not match the transaction.');
    payload.GlobalTaxCalculation = 'TaxExcluded';
    if (!sales) payload.APAccountRef = ref(account('accountsPayable', 'Accounts Payable', 'AccountsPayable').Id);
    if (step.entity === 'Invoice') payload.ARAccountRef = ref(account('accountsReceivable', 'Accounts Receivable', 'AccountsReceivable').Id);
    if (step.entity === 'SalesReceipt') { payload.DepositToAccountRef = ref(account(details.bankMapping, 'Bank').Id); payload.ProcessPayment = false; }
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
    if (step.entity === 'Bill' || (step.entity === 'Invoice' && parentTypes.length)) {
      const source = parent(step.entity === 'Bill' ? 'PurchaseOrder' : 'Estimate');
      if (source.record[party]?.value !== payload[party].value || source.record.GlobalTaxCalculation !== 'TaxExcluded') fail('The source party or tax calculation changed.');
      if (source.entity === 'PurchaseOrder' && (source.record.POStatus !== 'Open' || links(source.record).some(link => link.TxnType === 'Bill'))) fail('The purchase order is no longer wholly unbilled.');
      if (source.entity === 'Estimate' && (!['Pending', 'Accepted'].includes(source.record.TxnStatus) || links(source.record).some(link => link.TxnType === 'Invoice'))) fail('The estimate is no longer available for this invoice.');
      const detailType = source.entity === 'PurchaseOrder' ? 'ItemBasedExpenseLineDetail' : 'SalesItemLineDetail';
      const sourceLines = sourceItemLines(source.record, detailType), used = new Set();
      if (sourceLines.length !== payload.Line.length) fail('The source item lines do not match the approved complete conversion.');
      payload.LinkedTxn = [relate(source, 'LinkedTxn')];
      payload.Line.forEach((line, index) => {
        const wanted = line[line.DetailType], found = sourceLines.filter(value => value[detailType]?.ItemRef?.value === wanted.ItemRef.value && value[detailType]?.Qty === wanted.Qty && cents(value[detailType]?.UnitPrice) === cents(wanted.UnitPrice) && cents(value.Amount) === cents(line.Amount) && value[detailType]?.TaxCodeRef?.value === wanted.TaxCodeRef.value);
        if (found.length !== 1 || used.has(found[0].Id)) fail('The originating line cannot be matched unambiguously.');
        const sourceLine = found[0]; id(sourceLine.Id); used.add(sourceLine.Id);
        if (source.entity === 'PurchaseOrder' && sourceLine.Received !== 0) fail('The originating purchase-order line is already consumed or its consumed quantity is unknown.');
        line.LinkedTxn = [relate(source, 'Line.' + index + '.LinkedTxn', sourceLine.Id)];
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
      if (stocked.length !== payload.Line.length || payload.Line.some(line => stocked.filter(value => value.ItemBasedExpenseLineDetail?.ItemRef?.value === line.SalesItemLineDetail.ItemRef.value && value.ItemBasedExpenseLineDetail.Qty === line.SalesItemLineDetail.Qty).length !== 1)) fail('Stock sale does not match its verified receipt of stock.');
    }
  } else if (step.entity === 'TimeActivity') {
    const estimate = parent('Estimate');
    if (details.amountRule !== 'time_only' || details.billable !== true || !Number.isInteger(details.hours) || details.hours < 1 || details.hours > 24 || !payload.CustomerRef || estimate.record.CustomerRef?.value !== payload.CustomerRef.value) fail('Billable time requires an exact approved client and whole-hour duration.');
    const item = get('Item', details.itemKey); if (item.Type !== 'Service') fail('Billable time needs a service item.');
    const quoted = sourceItemLines(estimate.record, 'SalesItemLineDetail');
    if (quoted.length !== 1 || quoted[0].SalesItemLineDetail?.ItemRef?.value !== item.Id || quoted[0].SalesItemLineDetail?.Qty !== details.hours) fail('Recorded time does not match the quoted service hours.');
    Object.assign(payload, { NameOf: 'Employee', EmployeeRef: ref(get('Employee', details.workerKey).Id), ItemRef: ref(item.Id), Hours: details.hours, Minutes: 0, BillableStatus: 'Billable', Description: 'Test Data Lab activity ' + step.logicalKey });
  } else {
    if (details.amountRule !== 'saved_originating_total' || details.lines.length) fail('Settlement must use its saved source total.');
    const source = parent({ Payment: 'Invoice', BillPayment: 'Bill', Deposit: 'Payment' }[step.entity]);
    if (details.amountSourceKey !== source.logicalKey) fail('Settlement names another originating transaction.');
    const amount = cents(source.record.TotalAmt); if (!amount) fail('Settlement requires a positive saved total.');
    const party = step.entity === 'BillPayment' ? 'VendorRef' : 'CustomerRef';
    if (!payload[party] || source.record[party]?.value !== payload[party].value) fail('Settlement party differs from the saved source.');
    if (step.entity !== 'Deposit' && cents(source.record.Balance) !== amount) fail('The source is already partly or fully settled.');
    payload.TotalAmt = money(amount); payload.Line = [{ Amount: money(amount), LinkedTxn: [relate(source, 'Line.0.LinkedTxn')] }];
    if (step.entity === 'Payment') {
      const destination = details.destination === 'undeposited_funds' ? account('undepositedFunds', 'Other Current Asset', 'UndepositedFunds') : details.destination === 'operating_bank' ? account(details.bankMapping, 'Bank') : null;
      if (!destination || source.record.ARAccountRef?.value !== account('accountsReceivable', 'Accounts Receivable', 'AccountsReceivable').Id) fail('Payment destination or receivables account is not verified.');
      Object.assign(payload, { DepositToAccountRef: ref(destination.Id), ARAccountRef: ref(source.record.ARAccountRef.value), ProcessPayment: false });
    } else if (step.entity === 'BillPayment') {
      if (details.fundingSource !== 'operating_bank' || source.record.APAccountRef?.value !== account('accountsPayable', 'Accounts Payable', 'AccountsPayable').Id) fail('Bill payment funding or payables account is not verified.');
      Object.assign(payload, { APAccountRef: ref(source.record.APAccountRef.value), PayType: 'Check', CheckPayment: { BankAccountRef: ref(account(details.bankMapping, 'Bank').Id), PrintStatus: 'NotSet' }, ProcessBillPayment: false });
    } else {
      const available = source.availability;
      if (!available || !sameScope(available.scope, scope) || !fresh(available.observedAt, now) || available.kind !== 'undeposited_payment' || available.status !== 'available' || available.recordHash !== source.recordHash || !HASH.test(available.evidenceHash || '') || !currentObservation(available)) fail('Deposit requires current explicit undeposited availability evidence.');
      const holding = account('undepositedFunds', 'Other Current Asset', 'UndepositedFunds');
      if (details.destination !== 'operating_bank' || source.record.DepositToAccountRef?.value !== holding.Id || cents(source.record.UnappliedAmt) !== 0 || links(source.record).some(link => link.TxnType === 'Deposit')) fail('The payment is not an available fully applied undeposited receipt.');
      delete payload.CustomerRef; delete payload.TotalAmt;
      payload.DepositToAccountRef = ref(account(details.bankMapping, 'Bank').Id);
    }
  }
  const request = freezeWriteRequest(scope, 'POST', step.entity.toLowerCase(), payload);
  const evidenceHash = hash({ observationFence, policy: policy.evidenceHash, references: referenceEvidence.map(value => ({ entity: value.entity, id: value.record.Id, recordHash: value.recordHash })).sort((a, b) => (a.entity + a.id).localeCompare(b.entity + b.id)), parents: parents.map(value => ({ logicalKey: value.logicalKey, recordHash: value.recordHash, availabilityHash: value.availability?.evidenceHash || null })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)) });
  const observedAt = [...referenceEvidence, ...parents, ...parents.filter(value => value.availability).map(value => value.availability), observationFence].map(value => value.observedAt).sort()[0];
  const artifact = { version: 1, logicalKey: step.logicalKey, entity: step.entity, intentHash: hash(step), request, evidenceHash, relationships };
  const compilationHash = hash(artifact);
  return { ...artifact, compilationHash, dispatchEvidence: { artifact, compilationHash, scope, operationId: observationFence.operationId, logicalKey: step.logicalKey, intentHash: hash(step), requestHash: request.requestHash, evidenceHash, writerRevision: observationFence.writerRevision, observedAt }, authorized: false };
}
module.exports = { compileBusinessTransaction, SUPPORTED };
