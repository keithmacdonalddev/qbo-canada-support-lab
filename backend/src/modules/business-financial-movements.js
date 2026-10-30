'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { rowsOf, money, inspectReport } = require('./book-evidence');
const { unpackReport } = require('./business-report-source');
const { referenceDefinition } = require('./business-reference');
const { validateCompilation } = require('./business-readback');
const { taxExpectation } = require('./business-verification-runtime');
const { MAPPINGS } = require('./blueprint-draft');
const KEYS = Object.freeze(['operatingBank', 'undepositedFunds', 'accountsReceivable', 'accountsPayable']);
const INCOME_KEYS = Object.freeze(['serviceIncome', 'supplyIncome', 'careIncome']);
const EARNINGS_KEYS = Object.freeze([...KEYS, ...INCOME_KEYS, 'operatingExpense']);
const keysFor = expectation => expectation.version === 3 ? EARNINGS_KEYS : KEYS;
const QID = /^\d{1,30}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(Error(message), { status: 409, code: 'BUSINESS_FINANCIAL_MOVEMENTS_UNVERIFIED' }); }
const equal = (a, b) => canonical(a) === canonical(b);
const safe = value => Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
function sum(values) { return values.reduce((a, b) => { if (!safe(a) || !safe(b) || !safe(a + b)) fail('Financial movement exceeds exact-cent capacity.'); return a + b; }, 0); }
function cents(value) { const n = money(value); if (!safe(n) || n < 0) fail('The original request has an unsupported monetary amount.'); return n; }
const zero = (keys = KEYS) => Object.fromEntries(keys.map(key => [key, 0]));
function balances(report, accounts, selected, period) {
  let evidence;
  try { evidence = inspectReport('TrialBalance', report, period, rowsOf(report), true); } catch { fail('The complete trial balance layout is unsupported.'); }
  if (!evidence.scopeMatches || evidence.currency !== 'CAD' || report.Header.StartPeriod !== period.fromDate) fail('The trial balance must confirm this exact CAD accrual period.');
  const headerKeys = new Set(['Time', 'ReportName', 'DateMacro', 'ReportBasis', 'StartPeriod', 'EndPeriod', 'Currency', 'Option', 'SummarizeColumnsBy']);
  if (new Set((Array.isArray(report.Header.Option) ? report.Header.Option : []).map(row => row?.Name)).size !== (report.Header.Option?.length || 0) || Object.keys(report.Header).some(key => !headerKeys.has(key)) || (report.Header.Option !== undefined && !Array.isArray(report.Header.Option)) || (report.Header.Option || []).some(row => !row || !['NoReportData', 'AccountingStandard'].includes(row.Name) || (row.Name === 'NoReportData' && !['true', 'false'].includes(String(row.Value))) || Object.keys(row).some(key => !['Name', 'Value'].includes(key)))) fail('Filtered, grouped or unknown trial balance header options cannot establish complete account balances.');
  if ((report.Header.SummarizeColumnsBy && report.Header.SummarizeColumnsBy !== 'Total') || report.Columns.Column.some(column => column.Columns !== undefined)) fail('Grouped or nested trial balance columns are unsupported.');
  const columns = report.Columns.Column, titles = columns.map(row => row.ColTitle.trim().toLowerCase());
  if (columns.length !== 3 || titles.filter(t => t === 'debit').length !== 1 || titles.filter(t => t === 'credit').length !== 1) fail('A unique debit and credit column is required.');
  const debit = titles.indexOf('debit'), credit = titles.indexOf('credit'), account = [0, 1, 2].find(i => i !== debit && i !== credit);
  if (!['', 'account'].includes(titles[account])) fail('An unambiguous account column is required.');
  if (!Array.isArray(accounts) || !accounts.length || new Set(accounts.map(row => row.Id)).size !== accounts.length || accounts.some(row => !QID.test(row.Id || ''))) fail('Complete unique account definitions are required.');
  const known = new Set(accounts.map(row => row.Id)), selectedIds = new Set(selected.map(row => row.id)), found = new Map(), rows = rowsOf(report);
  const cell = value => value === '' ? 0 : cents(value);
  let debits = 0, credits = 0;
  for (const row of rows) {
    for (const cells of [row.Header?.ColData, row.Summary?.ColData].filter(Boolean)) if (cells.some(v => selectedIds.has(v.id))) fail('A selected account appears only in an ambiguous parent or summary layout.');
    if (!row.ColData || row.Header || row.Summary) continue;
    const cells = row.ColData, id = cells[account]?.id;
    if (!QID.test(id || '') || !known.has(id) || found.has(id)) fail('Trial balance account rows are missing, unknown or duplicated.');
    const d = cell(cells[debit]?.value), c = cell(cells[credit]?.value);
    found.set(id, d - c); debits = sum([debits, d]); credits = sum([credits, c]);
  }
  const explicitEmpty = !found.size && report.Header.Option?.some(row => row.Name === 'NoReportData' && String(row.Value) === 'true') && rows.every(row => [row.ColData, row.Header?.ColData, row.Summary?.ColData].filter(Boolean).every(cells => cells.every((value, index) => index === account || value.value === '' || money(value.value) === 0)));
  if (explicitEmpty) {
    if (selected.some(row => !known.has(row.id))) fail('A selected account definition is missing.');
    return zero(selected.map(row => row.key));
  }
  const totals = rows.filter(row => row.group === 'GrandTotal' && row.Summary?.ColData);
  if (totals.length !== 1 || totals[0].Summary.ColData.length !== 3 || cell(totals[0].Summary.ColData[debit]?.value) !== debits || cell(totals[0].Summary.ColData[credit]?.value) !== credits || debits !== credits) fail('Trial balance detail does not reconcile to its complete debit and credit totals.');
  if (found.size && report.Header.Option?.some(row => row.Name === 'NoReportData' && String(row.Value) === 'true')) fail('The no-data flag contradicts returned account detail.');
  if (!found.size && !explicitEmpty) fail('An empty trial balance needs an explicit no-data confirmation.');
  return Object.fromEntries(selected.map(row => { if (!known.has(row.id)) fail('A selected account definition is missing.'); if (!found.has(row.id) && accounts.some(child => child.ParentRef?.value === row.id)) fail('An omitted parent account cannot be inferred to have a zero balance.'); return [row.key, found.get(row.id) ?? 0]; }));
}
function accountSelection(scope, mappings, accounts, keys = KEYS) {
  return keys.map(key => {
    const rows = accounts.filter(row => row.Id === mappings[key]), role = MAPPINGS[key], row = rows[0];
    if (rows.length !== 1 || !role.types.includes(row.AccountType) || (role.subtypes && !role.subtypes.includes(row.AccountSubType)) || (role.currency && row.CurrencyRef?.value !== role.currency)) fail('The selected ' + role.label.toLowerCase() + ' definition is unavailable.');
    let definition; try { definition = referenceDefinition(scope, 'Account', row); } catch { fail('The selected financial account definition is incomplete.'); }
    return { key, id: row.Id, definitionHash: definition.hash };
  });
}
function earningsWindow(period) {
  try { date(period?.fromDate); date(period?.throughDate); } catch { fail('Choose valid financial-proof dates.'); }
  if (period.fromDate > period.throughDate || period.fromDate.slice(0, 7) !== period.throughDate.slice(0, 7)) fail('Prepare one calendar month at a time for income and expense proof. Stop at month-end, then continue with the next period.');
}
function createFinancialExpectation(scope, period, mappings, observation) {
  scope = scoped(scope);
  const { sourceHash, evaluation, ...source } = observation || {};
  if (![2, 3].includes(source.version) || !equal(source.scope, scope) || !equal(source.period, period) || hash(source) !== sourceHash) fail('The original scoped starting report observation is required.');
  const version = source.version === 3 ? 3 : 1;
  if (version === 3) earningsWindow(period);
  const selected = accountSelection(scope, mappings, source.accounts, version === 3 ? EARNINGS_KEYS : KEYS);
  const retained = structuredClone({ version, ...(version >= 2 ? { reportSourceVersion: 3 } : {}), scope, period, startedAt: source.startedAt, observedAt: source.observedAt, observationHash: sourceHash, report: source.reports.TrialBalance, accounts: source.accounts });
  const value = { version, scope, period, accounts: selected, opening: balances(unpackReport('TrialBalance', retained.report, source.version), retained.accounts, selected, period), source: retained, sourceHash: hash(retained) };
  return validateFinancialExpectation(value, scope, period);
}
function validateFinancialExpectation(value, scope, period, entries) {
  if (value?.version === 3) earningsWindow(period);
  if (![1, 2, 3].includes(value?.version) || !equal(value.scope, scoped(scope)) || !equal(value.period, period) || !equal(value.source?.scope, scope) || !equal(value.source.period, period) || value.source.version !== value.version || (value.version >= 2 && value.source.reportSourceVersion !== 3) || !HASH.test(value.source.observationHash || '') || value.sourceHash !== hash(value.source) || !Number.isFinite(Date.parse(value.source.observedAt)) || !Number.isFinite(Date.parse(value.source.startedAt)) || Date.parse(value.source.startedAt) > Date.parse(value.source.observedAt) || !Array.isArray(value.accounts) || !equal(value.accounts.map(row => row.key), keysFor(value)) || (value.version !== 3 && new Set(value.accounts.map(row => row.id)).size !== KEYS.length)) fail('The original selected-account starting observation changed.');
  const mappings = Object.fromEntries(value.accounts.map(row => [row.key, row.id]));
  if (!equal(accountSelection(scope, mappings, value.source.accounts, keysFor(value)), value.accounts) || !equal(balances(unpackReport('TrialBalance', value.source.report, value.version >= 2 ? 3 : 2), value.source.accounts, value.accounts, period), value.opening)) fail('The starting account balances differ from their retained source.');
  for (const entry of entries || []) for (const ref of entry.step.references.filter(ref => ref.entity === 'Account' && keysFor(value).includes(ref.key))) {
    const expected = value.accounts.find(row => row.key === ref.key);
    if (ref.id !== expected.id || ref.definition?.hash !== expected.definitionHash) fail('A managed activity uses a different approved financial account.');
  }
  if (value.version === 3) for (const selected of value.accounts) {
    const aliases = value.accounts.filter(row => row.id === selected.id);
    if (aliases.some(row => row.definitionHash !== selected.definitionHash) || (aliases.length > 1 && aliases.some(row => !INCOME_KEYS.includes(row.key)))) fail('Shared selected earnings roles require the same original income account definition.');
  }
  return value;
}
// Version3 proves only the selected earnings roles. It does not infer tax or
// inventory cost from cash, nor use today's mutable item price/account routing.
function earningsLines(expectation, step, payload, policy, add) {
  if (expectation.version !== 3 || !['Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt', 'Bill', 'Purchase', 'VendorCredit'].includes(step.entity)) return;
  const planned = step.details?.lines, sales = ['Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt'].includes(step.entity);
  if (payload.GlobalTaxCalculation !== 'TaxExcluded' || policy.tax?.calculation !== 'TaxExcluded' || !Array.isArray(planned) || !planned.length || !Array.isArray(payload.Line) || payload.Line.length !== planned.length || new Set(payload.Line.map(row => row.DetailType)).size !== 1) fail('Selected earnings require complete original pretax line intent.');
  const selected = new Map(expectation.accounts.map(row => [row.key, row]));
  const binding = (entity, key) => {
    const rows = step.references.filter(row => row.entity === entity && row.key === key);
    if (rows.length !== 1 || !QID.test(rows[0].id || '') || !HASH.test(rows[0].definition?.hash || '')) fail('An original earnings reference is missing or ambiguous.');
    return rows[0];
  };
  const account = key => {
    const row = binding('Account', key), expected = selected.get(key);
    if (!expected || row.id !== expected.id || row.definition.hash !== expected.definitionHash) fail('The original earnings account differs from its selected starting definition.');
    return row.id;
  };
  const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && equal(Object.keys(value).sort(), [...keys].sort());
  const taxKey = sales ? 'salesTax' : 'purchaseTax', taxId = binding('TaxCode', taxKey).id;
  if (step.details.taxMapping !== taxKey || policy.tax?.[taxKey] !== taxId) fail('The original earnings tax mapping changed.');
  for (const [index, original] of planned.entries()) {
    const line = payload.Line[index], detail = line?.[line.DetailType];
    if (!Number.isSafeInteger(original.amountCents) || original.amountCents <= 0 || cents(line?.Amount) !== original.amountCents || !exact(line, ['Amount', 'DetailType', line.DetailType, ...(line.LinkedTxn === undefined ? [] : ['LinkedTxn'])])) fail('An original earnings line amount or shape changed.');
    if (sales || line.DetailType === 'ItemBasedExpenseLineDetail') {
      const kind = sales ? 'SalesItemLineDetail' : 'ItemBasedExpenseLineDetail';
      if (line.DetailType !== kind || !exact(detail, ['ItemRef', 'Qty', 'UnitPrice', 'TaxCodeRef']) || detail.ItemRef?.value !== binding('Item', original.itemKey).id || detail.TaxCodeRef?.value !== taxId || detail.Qty !== original.quantity || cents(detail.UnitPrice) !== original.unitPriceCents || !Number.isFinite(original.quantity) || original.quantity <= 0 || Math.abs(original.quantity * original.unitPriceCents - original.amountCents) > 0.00001) fail('The posted earnings line differs from its original item, quantity, price or tax intent.');
      if (sales) {
        if (!INCOME_KEYS.includes(original.accountMapping)) fail('The original item line has no supported selected income role.');
        // Credits and refunds reverse income (a debit).
        account(original.accountMapping); add(original.accountMapping, (['CreditMemo', 'RefundReceipt'].includes(step.entity) ? 1 : -1) * original.amountCents);
      } else if (original.accountMapping !== 'inventoryAsset') fail('A stock purchase cannot be counted as operating expense.');
    } else {
      if (line.DetailType !== 'AccountBasedExpenseLineDetail' || original.accountMapping !== 'operatingExpense' || original.billableStatus !== 'NotBillable' || !exact(detail, ['AccountRef', 'BillableStatus', 'TaxCodeRef']) || detail.AccountRef?.value !== account('operatingExpense') || detail.BillableStatus !== 'NotBillable' || detail.TaxCodeRef?.value !== taxId) fail('The operating expense differs from its original nonbillable account and tax intent.');
      // A supplier credit reverses operating expense.
      add('operatingExpense', (step.entity === 'VendorCredit' ? -1 : 1) * original.amountCents);
    }
  }
}
function movementRow(expectation, step, compiled, policy, origin) {
  const request = validateCompilation(compiled);
  if (!equal(request.scope, expectation.scope) || compiled.intentHash !== hash(step) || compiled.logicalKey !== step.logicalKey || compiled.entity !== step.entity || policy.stepHash !== compiled.intentHash || hash(policy) !== origin.policyHash) fail('Financial basis differs from the original managed intent or dispatch policy.');
  const payload = JSON.parse(request.body), postings = zero(keysFor(expectation)), selected = Object.fromEntries(expectation.accounts.map(row => [row.key, row.id]));
  const ref = (key, value) => { if (value?.value !== selected[key]) fail('A compiled financial account differs from its original selected role.'); return key; };
  const add = (key, amount) => { postings[key] = sum([postings[key], amount]); };
  const net = () => sum((payload.Line || []).map(line => cents(line.Amount)));
  const gross = () => { const tax = taxExpectation(policy, compiled); if (!tax) fail('Original approved tax is required for financial movements.'); return sum([net(), tax.totalTaxCents]); };
  if (payload.CurrencyRef?.value !== 'CAD' && !['TimeActivity', 'Item'].includes(compiled.entity)) fail('Financial basis requires CAD transaction intent.');
  switch (compiled.entity) {
    case 'Invoice': add(ref('accountsReceivable', payload.ARAccountRef), gross()); break;
    case 'CreditMemo':
      // A calendar credit adjustment, or a same-day open customer credit.
      if (!(policy.lifecycle?.mode === 'customer-credit' && step.details.activityBatch !== undefined) && (expectation.version !== 3 || step.details.activityTemplateVersion !== 3 || policy.lifecycle?.mode !== 'credit-adjustment')) fail('A credit movement needs its original selected-earnings lifecycle.');
      add(ref('accountsReceivable', payload.ARAccountRef), -gross()); break;
    case 'RefundReceipt':
      if (policy.lifecycle?.mode !== 'customer-refund') fail('Only the original customer refund from the operating bank is supported.');
      add(ref('operatingBank', payload.DepositToAccountRef), -gross()); break;
    case 'Transfer': {
      const terms = policy.lifecycle?.transfer, tracked = keysFor(expectation), amount = cents(payload.Amount);
      if (policy.lifecycle?.mode !== 'bank-transfer' || !terms || amount !== terms.amountCents || !tracked.includes(terms.fromKey) || !tracked.includes(terms.toKey)) fail('Only the original transfer between two selected bank accounts is supported.');
      add(ref(terms.fromKey, payload.FromAccountRef), -amount); add(ref(terms.toKey, payload.ToAccountRef), amount); break;
    }
    case 'JournalEntry': {
      // Debit minus credit, for each line on an account this expectation tracks.
      const journal = policy.lifecycle?.journal, tracked = keysFor(expectation);
      if (policy.lifecycle?.mode !== 'journal-entry' || !Array.isArray(journal) || !Array.isArray(payload.Line) || payload.Line.length !== journal.length) fail('Only the original balanced journal entry is supported.');
      journal.forEach((line, n) => { const posted = payload.Line[n], detail = posted?.JournalEntryLineDetail; if (posted?.DetailType !== 'JournalEntryLineDetail' || detail?.PostingType !== line.postingType || cents(posted.Amount) !== line.amountCents) fail('A journal line differs from its original intent.'); if (tracked.includes(line.accountMapping)) add(ref(line.accountMapping, detail.AccountRef), (line.postingType === 'Debit' ? 1 : -1) * line.amountCents); });
      break;
    }
    case 'SalesReceipt': add(ref('operatingBank', payload.DepositToAccountRef), gross()); break;
    case 'Bill': add(ref('accountsPayable', payload.APAccountRef), -gross()); break;
    case 'VendorCredit': add(ref('accountsPayable', payload.APAccountRef), gross()); break;
    case 'Purchase':
      if (payload.PaymentType !== 'Cash' || payload.EntityRef?.type !== 'Vendor') fail('Only the original cash expense paid from the operating bank is supported.');
      add(ref('operatingBank', payload.AccountRef), -gross()); break;
    case 'Payment': {
      const amount = cents(payload.TotalAmt);
      if (policy.lifecycle?.mode === 'credit-application') {
        const lines = payload.Line || [], types = lines.map(line => line.LinkedTxn?.[0]?.TxnType).sort();
        if (expectation.version !== 3 || step.details.activityTemplateVersion !== 3 || amount !== 0 || lines.length !== 2 || !equal(types, ['CreditMemo', 'Invoice']) || lines.some(line => line.LinkedTxn?.length !== 1) || cents(lines[0].Amount) <= 0 || cents(lines[0].Amount) !== cents(lines[1].Amount)) fail('The original credit application must have two exact equal links and zero funds.');
        ref('accountsReceivable', payload.ARAccountRef); ref('operatingBank', payload.DepositToAccountRef); break;
      }
      if (net() !== amount || payload.Line.length !== 1 || payload.Line[0].LinkedTxn?.length !== 1 || payload.Line[0].LinkedTxn[0].TxnType !== 'Invoice') fail('Only the original exact invoice settlement is supported.');
      add(ref('accountsReceivable', payload.ARAccountRef), -amount);
      const key = payload.DepositToAccountRef?.value === selected.operatingBank ? 'operatingBank' : 'undepositedFunds';
      add(ref(key, payload.DepositToAccountRef), amount); break;
    }
    case 'BillPayment': {
      const amount = cents(payload.TotalAmt);
      if (net() !== amount || payload.PayType !== 'Check' || payload.Line.length !== 1 || payload.Line[0].LinkedTxn?.length !== 1 || payload.Line[0].LinkedTxn[0].TxnType !== 'Bill') fail('Only the original exact supplier settlement is supported.');
      add(ref('accountsPayable', payload.APAccountRef), amount); add(ref('operatingBank', payload.CheckPayment?.BankAccountRef), -amount); break;
    }
    case 'Deposit': {
      const holding = step.references.filter(row => row.entity === 'Account' && row.key === 'undepositedFunds'), links = payload.Line?.[0]?.LinkedTxn, relationship = compiled.relationships.filter(row => row.entity === 'Payment' && row.logicalKey === step.details.amountSourceKey);
      if (payload.Line?.length !== 1 || links?.length !== 1 || links[0].TxnType !== 'Payment' || relationship.length !== 1 || relationship[0].kind !== 'linked' || relationship[0].qboId !== links[0].TxnId || holding.length !== 1 || holding[0].id !== selected.undepositedFunds || holding[0].definition.hash !== expectation.accounts.find(row => row.key === 'undepositedFunds').definitionHash) fail('The deposit lacks its exact verified undeposited payment origin.');
      const amount = net(); add('undepositedFunds', -amount); add(ref('operatingBank', payload.DepositToAccountRef), amount); break;
    }
    case 'Estimate': case 'PurchaseOrder': case 'TimeActivity': break;
    // Accountant-added customers, suppliers and service items post nothing.
    case 'Customer': case 'Vendor': case 'Item': if (step.details?.listRole === undefined || payload.Line !== undefined || payload.TxnDate !== undefined) fail('An added list record cannot carry postings.'); break;
    default: fail('Unsupported financial record.');
  }
  earningsLines(expectation, step, payload, policy, add);
  return { logicalKey: step.logicalKey, entity: step.entity, fingerprint: hash(step), ...origin, compilationHash: compiled.compilationHash, requestHash: request.requestHash, postings };
}
function compareFinancialMovements(expectation, basis, observation) {
  validateFinancialExpectation(expectation, expectation.scope, expectation.period);
  const keys = keysFor(expectation), deltas = zero(keys);
  for (const row of basis) for (const key of keys) deltas[key] = sum([deltas[key], row.postings[key]]);
  let actual, reason = null;
  try {
    if (!equal(observation.scope, expectation.scope) || !equal(observation.period, expectation.period)) fail('Financial report observation changed company or period.');
    const mappings = Object.fromEntries(expectation.accounts.map(row => [row.key, row.id]));
    if (!equal(accountSelection(expectation.scope, mappings, observation.accounts, keys), expectation.accounts)) fail('Selected financial account definitions changed.');
    actual = balances(unpackReport('TrialBalance', observation.reports.TrialBalance, observation.version), observation.accounts, expectation.accounts, expectation.period);
  } catch (error) { if (error.code !== 'BUSINESS_FINANCIAL_MOVEMENTS_UNVERIFIED') throw error; reason = error.message; }
  const grouped = expectation.version === 3 ? [...new Set(expectation.accounts.map(row => row.id))].map(id => expectation.accounts.filter(row => row.id === id).map(row => row.key)) : KEYS.map(key => [key]);
  const checks = grouped.map(roles => {
    const key = roles[0], changeCents = sum(roles.map(role => deltas[role]));
    const expectedCents = sum([expectation.opening[key], changeCents]), actualCents = actual?.[key] ?? null, differenceCents = actualCents === null ? null : sum([actualCents, -expectedCents]);
    return { key, ...(expectation.version === 3 ? { roles } : {}), label: roles.map(role => MAPPINGS[role].label).join(' / '), accountId: expectation.accounts.find(row => row.key === key).id, openingCents: expectation.opening[key], changeCents, expectedCents, actualCents, differenceCents, status: actualCents === null ? 'unavailable' : differenceCents === 0 ? 'passed' : 'failed' };
  });
  if (expectation.version === 3) return { version: 2, status: reason ? 'unavailable' : checks.every(row => row.status === 'passed') ? 'passed' : 'failed', checks, ...(reason ? { reason } : {}), signConvention: 'debit-minus-credit', limitation: 'Selected cash controls, pretax income and operating expense accounts only. Shared income mappings combine their activity into one account comparison. Tax-control posting, inventory cost, complete general-ledger and cash-flow movement, and bank-statement reconciliation are not established.' };
  return { version: 1, status: reason ? 'unavailable' : checks.every(row => row.status === 'passed') ? 'passed' : 'failed', checks, ...(reason ? { reason } : {}), signConvention: 'debit-minus-credit', limitation: 'Four selected balance-sheet accounts only. Expense/tax posting, inventory cost, general-ledger and cash-flow movement, and bank-statement reconciliation are not established.' };
}
async function loadMovementBasis(models, scope, run, manifest, stepRows, session) {
  validateFinancialExpectation(manifest.financialExpectation, scope, { fromDate: run.fromDate, throughDate: run.throughDate });
  const descriptors = manifest.records.filter(row => row.kind === 'create'), keys = descriptors.map(row => row.logicalKey), rows = [];
  for (let offset = 0; offset < keys.length; offset += 100) rows.push(...await models.Intents.find({ ...scope, planId: run.planId, planHash: run.planHash, logicalKey: { $in: keys.slice(offset, offset + 100) } }, null, { singleBatch: true, batchSize: 101 }).limit(101).session(session).maxTimeMS(3000).lean());
  if (rows.length !== keys.length || new Set(rows.map(row => row.logicalKey)).size !== keys.length) fail('The complete original create intent set is required.');
  const original = new Map(rows.map(row => [row.logicalKey, row])), cache = new Map(), basis = [];
  for (const expected of descriptors) {
    const intent = original.get(expected.logicalKey), step = stepRows.find(row => row.logicalKey === expected.logicalKey), d = step?.dispatch;
    if (!intent || !equal(require('./business-operation-plan-store').validateOperationEntry(intent, scope, run.fromDate, run.throughDate), expected) || !step || String(step.operationId) !== String(run._id) || step.planHash !== run.planHash || step.entity !== expected.entity || step.fingerprint !== expected.fingerprint || !['saved', 'verified'].includes(step.state) || !QID.test(step.qboId || '') || step.receipt?.qboId !== step.qboId || step.receipt?.version !== 1 || step.receipt?.dispatchKey !== d?.key || step.receipt?.requestHash !== d?.requestHash || !HASH.test(step.receipt?.evidenceHash || '') || !HASH.test(d?.key || '') || !['create-response', 'request-correlated-readback', 'owner-attributed-readback'].includes(step.receipt.source) || !HASH.test(d?.policyHash || '') || (d.policyAmendmentHash !== null && !HASH.test(d.policyAmendmentHash || '')) || step.compilation?.compilationHash !== d.compilationHash || step.compilation?.request?.requestHash !== d.requestHash || step.compilation?.evidenceHash !== d.evidenceHash || step.compilation?.intentHash !== expected.fingerprint) fail('The financial basis lost its original accepted dispatch identity.');
    const links = list => list.map(row => ({ logicalKey: row.logicalKey, entity: row.entity, fingerprint: row.fingerprint })).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
    if (!Array.isArray(step.dependencies) || !equal(links(step.compilation.relationships), links(intent.step.dependencies)) || !equal(links(step.dependencies), links(intent.step.dependencies))) fail('Original financial dependency identities changed.');
    await require('./business-owner-attribution').assertOwnerAttribution(models, scope, step, session);
    const policy = await require('./business-policy-amendment').effectiveBusinessPolicy(models, scope, { ...run, policyAmendmentHash: d.policyAmendmentHash }, intent, session, cache);
    basis.push(movementRow(manifest.financialExpectation, intent.step, step.compilation, policy, { operationId: String(run._id), planHash: run.planHash, qboId: step.qboId, receiptSource: step.receipt.source, receiptHash: step.receipt.evidenceHash, dispatchKey: d.key, policyHash: d.policyHash, policyAmendmentHash: d.policyAmendmentHash }));
  }
  return basis.sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
}
// Only compact identities/cents are added to proof. Bound their worst encoded size
// before a create, independent of potentially long shared historical tax policies.
function assertMovementCapacity(manifest, currentSource) {
  if (!manifest.financialExpectation && !currentSource) return;
  const text = n => '9'.repeat(n), h = text(64), amounts = Object.fromEntries((manifest.financialExpectation ? keysFor(manifest.financialExpectation) : KEYS).map(key => [key, -Number.MAX_SAFE_INTEGER]));
  const records = manifest.records.map(row => ({ logicalKey: h, entity: 'PurchaseOrder', fingerprint: h, qboId: text(30), state: 'verified', observedHash: h, syncToken: text(64), observedAt: text(24), auditId: text(100), relationships: row.relationships.map(() => ({ logicalKey: h, entity: 'PurchaseOrder', qboId: text(30), syncToken: text(64) })) }));
  const basis = (manifest.financialExpectation ? manifest.records.filter(row => row.kind === 'create') : []).map(() => ({ logicalKey: h, entity: 'PurchaseOrder', fingerprint: h, operationId: text(24), planHash: h, qboId: text(30), receiptSource: 'owner-attributed-readback', receiptHash: h, dispatchKey: h, policyHash: h, policyAmendmentHash: h, compilationHash: h, requestHash: h, postings: amounts }));
  const budget = Buffer.byteLength(canonical({ records, financialBasis: basis })) + 1000000;
  if (budget > 5500000) fail('This operation cannot retain its complete financial proof within the evidence budget. Prepare a shorter period.');
  if (manifest.stockCostExpectation && budget + 4500000 > 8000000) fail('This operation cannot retain its combined account and stock-cost proof. Prepare a shorter period.');
  if (currentSource) {
    if (manifest.stockCostExpectation && budget + 4500000 + Buffer.byteLength(canonical(currentSource)) > 12000000) fail('The combined report and stock-cost evidence exceeds its JSON storage budget. Prepare a shorter period.');
    // BSON array indices/types cost more than JSON. Reserve the same one-megabyte
    // proof/header allowance before any create, using the fresh opening source.
    const projected = require('mongoose').mongo.BSON.calculateObjectSize({ proof: { records, financialBasis: basis }, sources: currentSource }) + 1000000 + (manifest.stockCostExpectation ? 6500000 : 0);
    if (projected > 15000000) fail('This operation cannot retain its source and complete financial proof within the BSON storage budget. Prepare a shorter period.');
  }
  return budget;
}
module.exports = { KEYS, EARNINGS_KEYS, balances, accountSelection, createFinancialExpectation, validateFinancialExpectation, movementRow, compareFinancialMovements, loadMovementBasis, assertMovementCapacity };
