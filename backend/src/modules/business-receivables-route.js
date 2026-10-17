'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { verifyBusinessReference } = require('./business-reference');
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/, QBO_ID = /^\d{1,30}$/;
const sameScope = (a, b) => ['environment', 'realmId', 'connectionId'].every(key => a?.[key] === b?.[key]);
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_RECEIVABLES_UNVERIFIED' }); }
function fresh(stamp, now) { const value = typeof stamp === 'string' ? Date.parse(stamp) : NaN; return Number.isFinite(now) && Number.isFinite(value) && new Date(value).toISOString() === stamp && value <= now && now - value <= 300000; }
function money(value) { if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) fail('The receivables ledger amount is not exact money.'); const amount = Number(value) * 100, cents = Math.round(amount); if (!Number.isSafeInteger(cents) || Math.abs(amount - cents) > 0.00001) fail('The receivables ledger amount exceeds its budget.'); return cents; }
function endpointFor(record, accountId) { date(record.TxnDate); if (!QBO_ID.test(accountId || '')) fail('The approved receivables account is unavailable.'); return 'reports/GeneralLedger?start_date=' + record.TxnDate + '&end_date=' + record.TxnDate + '&account=' + accountId + '&accounting_method=Accrual'; }
// A separate, replayable source proof. Never enrich or rewrite the raw invoice.
function invoiceReceivablesEvidence(input) {
  const { compiled, receipt, observed, accountBinding, accountObserved, report, reportObservedAt, beforeFence, afterFence, now = Date.now() } = input;
  // Lazy to avoid the compiler/read-back module initialization cycle.
  const request = require('./business-readback').validateCompilation(compiled), scope = scoped(request.scope), record = observed?.record, payload = JSON.parse(request.body);
  if (compiled.entity !== 'Invoice' || !record || record.ARAccountRef !== undefined || observed.entity !== 'Invoice' || !sameScope(observed.scope, scope) || observed.recordHash !== hash(record) || !fresh(observed.observedAt, now) || record.CurrencyRef?.value !== 'CAD' || record.TxnDate !== payload.TxnDate || typeof record.SyncToken !== 'string' || !/^(0|[1-9]\d{0,63})$/.test(record.SyncToken) || !QBO_ID.test(record.Id || '')) fail('Only an unchanged complete invoice with an omitted receivables field can use ledger evidence.');
  if (!receipt || receipt.version !== 1 || !sameScope(receipt.scope, scope) || receipt.entity !== 'Invoice' || receipt.logicalKey !== compiled.logicalKey || receipt.qboId !== record.Id || receipt.requestHash !== request.requestHash || !HASH.test(receipt.evidenceHash || '') || !HASH.test(receipt.dispatchKey || '') || !['create-response', 'request-correlated-readback', 'owner-attributed-readback'].includes(receipt.source)) fail('The invoice ledger evidence requires its exact saved receipt.');
  if (!beforeFence || !sameScope(beforeFence.scope, scope) || !ID.test(beforeFence.operationId || '') || !Number.isSafeInteger(beforeFence.revision) || beforeFence.revision < 0 || beforeFence.unresolved !== null || canonical(beforeFence) !== canonical(afterFence)) fail('Company activity changed during receivables verification.');
  if (accountBinding?.key !== 'accountsReceivable' || accountBinding.entity !== 'Account' || accountBinding.id !== payload.ARAccountRef?.value) fail('The original approved receivables binding is required.');
  const account = verifyBusinessReference({ scope, binding: accountBinding, observed: accountObserved, now });
  if (account.AccountType !== 'Accounts Receivable' || account.AccountSubType !== 'AccountsReceivable' || account.CurrencyRef?.value !== 'CAD') fail('The approved receivables definition changed.');
  if (!fresh(reportObservedAt, now) || !report || Buffer.byteLength(canonical(report)) > 2000000 || Object.keys(report).some(key => !['Header', 'Columns', 'Rows'].includes(key))) fail('A complete fresh bounded receivables report is required.');
  const header = report.Header, columns = report.Columns?.Column;
  if (header?.ReportName !== 'GeneralLedger' || header.ReportBasis !== 'Accrual' || header.Currency !== 'CAD' || header.StartPeriod !== record.TxnDate || header.EndPeriod !== record.TxnDate || !Array.isArray(header.Option) || header.Option.length !== 1 || header.Option[0].Name !== 'NoReportData' || header.Option[0].Value !== 'false' || !Array.isArray(columns) || columns.length > 32) fail('The receivables report has a different or incomplete scope.');
  const index = type => { const found = columns.flatMap((column, i) => column.ColType === type ? [i] : []); if (found.length !== 1) fail('The receivables report columns are ambiguous.'); return found[0]; };
  const dateIndex = index('tx_date'), typeIndex = index('txn_type'), amountIndex = index('subt_nat_amount_home_nt');
  const sections = report.Rows?.Row;
  if (!Array.isArray(sections) || sections.length !== 1 || sections[0].type !== 'Section' || sections[0].Header?.ColData?.[0]?.id !== account.Id || !Array.isArray(sections[0].Rows?.Row)) fail('The report must identify exactly the approved receivables account.');
  const rows = sections[0].Rows.Row;
  if (rows.length > 1000 || Object.keys(sections[0]).some(key => !['type', 'Header', 'Rows', 'Summary'].includes(key))) fail('The receivables report exceeds its record budget or has unsupported sections.');
  try { require('./book-evidence').inspectReport('GeneralLedger', report, { fromDate: record.TxnDate, throughDate: record.TxnDate }, undefined, true); }
  catch { fail('The receivables report is truncated or has incomplete detail cells.'); }
  const matches = [];
  for (const row of rows) {
    if (row.type !== 'Data' || Object.keys(row).some(key => !['ColData', 'type'].includes(key)) || !Array.isArray(row.ColData) || row.ColData.length !== columns.length) fail('The receivables report contains incomplete detail rows.');
    const cell = row.ColData[typeIndex];
    if (cell.id === record.Id) {
      if (cell.value !== 'Invoice' || row.ColData[dateIndex].value !== record.TxnDate) fail('The ledger identity names a different transaction.');
      matches.push(money(row.ColData[amountIndex].value));
    }
  }
  const total = record.TotalAmt * 100;
  if (typeof record.TotalAmt !== 'number' || !Number.isSafeInteger(Math.round(total)) || total <= 0 || Math.abs(total - Math.round(total)) > 0.00001 || matches.length !== 1 || matches[0] !== Math.round(total)) fail('The exact invoice gross posting is missing, duplicated or different.');
  const source = { compiled, receipt, accountBinding, accountObserved, report, reportObservedAt, beforeFence, afterFence };
  const proof = { version: 1, kind: 'invoice-receivables-ledger', scope, entity: 'Invoice', logicalKey: compiled.logicalKey, fingerprint: compiled.intentHash, qboId: record.Id, syncToken: record.SyncToken, recordHash: observed.recordHash, compilationHash: compiled.compilationHash, requestHash: request.requestHash, receiptHash: receipt.evidenceHash, accountId: account.Id, accountDefinitionHash: accountBinding.definition.hash, operationId: beforeFence.operationId, writerRevision: beforeFence.revision, endpoint: endpointFor(record, account.Id), observedAt: [observed.observedAt, accountObserved.observedAt, reportObservedAt].sort()[0], source };
  return { ...proof, evidenceHash: hash(proof) };
}
function verifyInvoiceReceivables({ observed, compiled, receipt, operationId, writerRevision, now = Date.now() }) {
  const evidence = observed?.accountRouting;
  if (!evidence || evidence.kind !== 'invoice-receivables-ledger' || evidence.version !== 1 || !HASH.test(evidence.evidenceHash || '')) fail('Independent receivables posting evidence is required.');
  const regenerated = invoiceReceivablesEvidence({ ...evidence.source, observed, now });
  if (canonical(regenerated) !== canonical(evidence) || (compiled && (evidence.compilationHash !== compiled.compilationHash || evidence.requestHash !== compiled.request.requestHash || evidence.fingerprint !== compiled.intentHash)) || (receipt && (evidence.receiptHash !== receipt.evidenceHash || evidence.source.receipt.dispatchKey !== receipt.dispatchKey)) || (operationId !== undefined && evidence.operationId !== operationId) || (writerRevision !== undefined && evidence.writerRevision !== writerRevision)) fail('The receivables posting proof changed or belongs to a different invoice or writer.');
  return evidence.accountId;
}
module.exports = { invoiceReceivablesEvidence, verifyInvoiceReceivables, endpointFor };
