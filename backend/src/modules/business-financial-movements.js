'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { rowsOf, money, inspectReport } = require('./book-evidence');
const { referenceDefinition } = require('./business-reference');
const { validateCompilation } = require('./business-readback');
const { taxExpectation } = require('./business-verification-runtime');
const { MAPPINGS } = require('./blueprint-draft');
const KEYS = Object.freeze(['operatingBank', 'undepositedFunds', 'accountsReceivable', 'accountsPayable']);
const QID = /^\d{1,30}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(Error(message), { status: 409, code: 'BUSINESS_FINANCIAL_MOVEMENTS_UNVERIFIED' }); }
const equal = (a, b) => canonical(a) === canonical(b);
const safe = value => Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
function sum(values) { return values.reduce((a, b) => { if (!safe(a) || !safe(b) || !safe(a + b)) fail('Financial movement exceeds exact-cent capacity.'); return a + b; }, 0); }
function cents(value) { const n = money(value); if (!safe(n) || n < 0) fail('The original request has an unsupported monetary amount.'); return n; }
const zero = () => Object.fromEntries(KEYS.map(key => [key, 0]));
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
    return zero();
  }
  const totals = rows.filter(row => row.group === 'GrandTotal' && row.Summary?.ColData);
  if (totals.length !== 1 || totals[0].Summary.ColData.length !== 3 || cell(totals[0].Summary.ColData[debit]?.value) !== debits || cell(totals[0].Summary.ColData[credit]?.value) !== credits || debits !== credits) fail('Trial balance detail does not reconcile to its complete debit and credit totals.');
  if (found.size && report.Header.Option?.some(row => row.Name === 'NoReportData' && String(row.Value) === 'true')) fail('The no-data flag contradicts returned account detail.');
  if (!found.size && !explicitEmpty) fail('An empty trial balance needs an explicit no-data confirmation.');
  return Object.fromEntries(selected.map(row => { if (!known.has(row.id)) fail('A selected account definition is missing.'); if (!found.has(row.id) && accounts.some(child => child.ParentRef?.value === row.id)) fail('An omitted parent account cannot be inferred to have a zero balance.'); return [row.key, found.get(row.id) ?? 0]; }));
}
function accountSelection(scope, mappings, accounts) {
  return KEYS.map(key => {
    const rows = accounts.filter(row => row.Id === mappings[key]), role = MAPPINGS[key], row = rows[0];
    if (rows.length !== 1 || !role.types.includes(row.AccountType) || (role.subtypes && !role.subtypes.includes(row.AccountSubType)) || (role.currency && row.CurrencyRef?.value !== role.currency)) fail('The selected ' + role.label.toLowerCase() + ' definition is unavailable.');
    let definition; try { definition = referenceDefinition(scope, 'Account', row); } catch { fail('The selected financial account definition is incomplete.'); }
    return { key, id: row.Id, definitionHash: definition.hash };
  });
}
function createFinancialExpectation(scope, period, mappings, observation) {
  scope = scoped(scope);
  const { sourceHash, evaluation, ...source } = observation || {};
  if (source.version !== 2 || !equal(source.scope, scope) || !equal(source.period, period) || hash(source) !== sourceHash) fail('The original scoped starting report observation is required.');
  const selected = accountSelection(scope, mappings, source.accounts);
  const retained = structuredClone({ version: 1, scope, period, startedAt: source.startedAt, observedAt: source.observedAt, observationHash: sourceHash, report: source.reports.TrialBalance, accounts: source.accounts });
  const value = { version: 1, scope, period, accounts: selected, opening: balances(retained.report, retained.accounts, selected, period), source: retained, sourceHash: hash(retained) };
  return validateFinancialExpectation(value, scope, period);
}
function validateFinancialExpectation(value, scope, period, entries) {
  if (value?.version !== 1 || !equal(value.scope, scoped(scope)) || !equal(value.period, period) || !equal(value.source?.scope, scope) || !equal(value.source.period, period) || value.source.version !== 1 || !HASH.test(value.source.observationHash || '') || value.sourceHash !== hash(value.source) || !Number.isFinite(Date.parse(value.source.observedAt)) || !Number.isFinite(Date.parse(value.source.startedAt)) || Date.parse(value.source.startedAt) > Date.parse(value.source.observedAt) || !Array.isArray(value.accounts) || !equal(value.accounts.map(row => row.key), KEYS) || new Set(value.accounts.map(row => row.id)).size !== KEYS.length) fail('The original selected-account starting observation changed.');
  const mappings = Object.fromEntries(value.accounts.map(row => [row.key, row.id]));
  if (!equal(accountSelection(scope, mappings, value.source.accounts), value.accounts) || !equal(balances(value.source.report, value.source.accounts, value.accounts, period), value.opening)) fail('The starting account balances differ from their retained source.');
  for (const entry of entries || []) for (const ref of entry.step.references.filter(ref => ref.entity === 'Account' && KEYS.includes(ref.key))) {
    const expected = value.accounts.find(row => row.key === ref.key);
    if (ref.id !== expected.id || ref.definition?.hash !== expected.definitionHash) fail('A managed activity uses a different approved financial account.');
  }
  return value;
}
function movementRow(expectation, step, compiled, policy, origin) {
  const request = validateCompilation(compiled);
  if (!equal(request.scope, expectation.scope) || compiled.intentHash !== hash(step) || compiled.logicalKey !== step.logicalKey || compiled.entity !== step.entity || policy.stepHash !== compiled.intentHash || hash(policy) !== origin.policyHash) fail('Financial basis differs from the original managed intent or dispatch policy.');
  const payload = JSON.parse(request.body), postings = zero(), selected = Object.fromEntries(expectation.accounts.map(row => [row.key, row.id]));
  const ref = (key, value) => { if (value?.value !== selected[key]) fail('A compiled financial account differs from its original selected role.'); return key; };
  const add = (key, amount) => { postings[key] = sum([postings[key], amount]); };
  const net = () => sum((payload.Line || []).map(line => cents(line.Amount)));
  const gross = () => { const tax = taxExpectation(policy, compiled); if (!tax) fail('Original approved tax is required for financial movements.'); return sum([net(), tax.totalTaxCents]); };
  if (payload.CurrencyRef?.value !== 'CAD' && compiled.entity !== 'TimeActivity') fail('Financial basis requires CAD transaction intent.');
  switch (compiled.entity) {
    case 'Invoice': add(ref('accountsReceivable', payload.ARAccountRef), gross()); break;
    case 'SalesReceipt': add(ref('operatingBank', payload.DepositToAccountRef), gross()); break;
    case 'Bill': add(ref('accountsPayable', payload.APAccountRef), -gross()); break;
    case 'Payment': {
      const amount = cents(payload.TotalAmt);
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
    default: fail('Unsupported financial record.');
  }
  return { logicalKey: step.logicalKey, entity: step.entity, fingerprint: hash(step), ...origin, compilationHash: compiled.compilationHash, requestHash: request.requestHash, postings };
}
function compareFinancialMovements(expectation, basis, observation) {
  validateFinancialExpectation(expectation, expectation.scope, expectation.period);
  const deltas = zero();
  for (const row of basis) for (const key of KEYS) deltas[key] = sum([deltas[key], row.postings[key]]);
  let actual, reason = null;
  try {
    if (!equal(observation.scope, expectation.scope) || !equal(observation.period, expectation.period)) fail('Financial report observation changed company or period.');
    const mappings = Object.fromEntries(expectation.accounts.map(row => [row.key, row.id]));
    if (!equal(accountSelection(expectation.scope, mappings, observation.accounts), expectation.accounts)) fail('Selected financial account definitions changed.');
    actual = balances(observation.reports.TrialBalance, observation.accounts, expectation.accounts, expectation.period);
  } catch (error) { if (error.code !== 'BUSINESS_FINANCIAL_MOVEMENTS_UNVERIFIED') throw error; reason = error.message; }
  const checks = KEYS.map(key => {
    const expectedCents = sum([expectation.opening[key], deltas[key]]), actualCents = actual?.[key] ?? null, differenceCents = actualCents === null ? null : sum([actualCents, -expectedCents]);
    return { key, label: MAPPINGS[key].label, accountId: expectation.accounts.find(row => row.key === key).id, openingCents: expectation.opening[key], changeCents: deltas[key], expectedCents, actualCents, differenceCents, status: actualCents === null ? 'unavailable' : differenceCents === 0 ? 'passed' : 'failed' };
  });
  return { version: 1, status: reason ? 'unavailable' : checks.every(row => row.status === 'passed') ? 'passed' : 'failed', checks, ...(reason ? { reason } : {}), signConvention: 'debit-minus-credit', limitation: 'Four selected balance-sheet accounts only. Expense/tax posting, inventory cost, general-ledger and cash-flow movement, and bank-statement reconciliation are not established.' };
}
async function loadMovementBasis(models, scope, run, manifest, stepRows, session) {
  validateFinancialExpectation(manifest.financialExpectation, scope, { fromDate: run.fromDate, throughDate: run.throughDate });
  const descriptors = manifest.records.filter(row => row.kind === 'create'), keys = descriptors.map(row => row.logicalKey), rows = [];
  for (let offset = 0; offset < keys.length; offset += 200) rows.push(...await models.Intents.find({ ...scope, planId: run.planId, planHash: run.planHash, logicalKey: { $in: keys.slice(offset, offset + 200) } }).limit(201).session(session).maxTimeMS(3000).lean());
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
function assertMovementCapacity(manifest) {
  if (!manifest.financialExpectation) return;
  const text = n => '9'.repeat(n), h = text(64), amounts = Object.fromEntries(KEYS.map(key => [key, -Number.MAX_SAFE_INTEGER]));
  const records = manifest.records.map(row => ({ logicalKey: h, entity: 'PurchaseOrder', fingerprint: h, qboId: text(30), state: 'verified', observedHash: h, syncToken: text(64), observedAt: text(24), auditId: text(100), relationships: row.relationships.map(() => ({ logicalKey: h, entity: 'PurchaseOrder', qboId: text(30), syncToken: text(64) })) }));
  const basis = manifest.records.filter(row => row.kind === 'create').map(() => ({ logicalKey: h, entity: 'PurchaseOrder', fingerprint: h, operationId: text(24), planHash: h, qboId: text(30), receiptSource: 'owner-attributed-readback', receiptHash: h, dispatchKey: h, policyHash: h, policyAmendmentHash: h, compilationHash: h, requestHash: h, postings: amounts }));
  const budget = Buffer.byteLength(canonical({ records, financialBasis: basis })) + 1000000;
  if (budget > 5500000) fail('This operation cannot retain its complete financial proof within the evidence budget. Prepare a shorter period.');
  return budget;
}
module.exports = { KEYS, balances, createFinancialExpectation, validateFinancialExpectation, movementRow, compareFinancialMovements, loadMovementBasis, assertMovementCapacity };
