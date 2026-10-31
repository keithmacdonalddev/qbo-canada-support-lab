'use strict';
// Day-close verification of general governed writes (general-write-v1, design rev 3,
// build step 5). Offline composition of the pure close rules: it gathers the day's
// general records and changed records, reads their postings from ONE General Ledger
// report for the day (requested with explicit debit and credit columns), and evaluates
// them with general-write-close.evaluateDay. It returns the movements to add to the
// existing period assertion and the dirty ranges that must be re-verified. No QuickBooks
// call is made here: the caller supplies the report (one set of reports per day close).
const { hash } = require('./business-calendar');
const { evaluateDay, dirtyRange } = require('./general-write-close');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'GENERAL_DAY_CLOSE_UNVERIFIED' }); }
// General Ledger transaction-type labels (Canadian and US wording) -> entity.
const LABELS = Object.freeze({
  'Invoice': 'Invoice', 'Payment': 'Payment', 'Credit Memo': 'CreditMemo', 'Sales Receipt': 'SalesReceipt', 'Refund': 'RefundReceipt', 'Refund Receipt': 'RefundReceipt',
  'Bill': 'Bill', 'Bill Payment (Cheque)': 'BillPayment', 'Bill Payment (Check)': 'BillPayment', 'Bill Payment (Credit Card)': 'BillPayment', 'Supplier Credit': 'VendorCredit', 'Vendor Credit': 'VendorCredit',
  'Expense': 'Purchase', 'Cheque Expense': 'Purchase', 'Check': 'Purchase', 'Cheque': 'Purchase', 'Cash Expense': 'Purchase', 'Credit Card Expense': 'Purchase', 'Credit Card Credit': 'Purchase',
  'Deposit': 'Deposit', 'Transfer': 'Transfer', 'Journal Entry': 'JournalEntry',
});
const URL_COLUMNS = 'tx_date,txn_type,doc_num,name,memo,split_acc,debt_amt,credit_amt';
// The one General Ledger request a day close needs (explicit debit/credit columns).
function ledgerEndpoint(day, through = day) { if (![day, through].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value || '')) || through < day) fail('A business day or period is required.'); return 'reports/GeneralLedger?' + new URLSearchParams({ start_date: day, end_date: through, accounting_method: 'Accrual', columns: URL_COLUMNS }); }
function money(cell) {
  const value = cell?.value;
  if (value === undefined || value === '') return 0;
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) fail('A General Ledger amount is not exact money.');
  return Math.round(Number(value) * 100);
}
// { 'Entity:id': [{ accountId, cents }] } (debit positive) from a GeneralLedger report of a
// day or period. accountKey maps an account id to the key postings use (tax accounts
// share one 'tax' key, since QuickBooks chooses the agency account).
function parseLedger(report, day, through = day, accountKey = id => id) {
  const header = report?.Header, columns = report?.Columns?.Column;
  if (header?.ReportName !== 'GeneralLedger' || header.ReportBasis !== 'Accrual' || header.StartPeriod !== day || header.EndPeriod !== through || !Array.isArray(columns)) fail('The General Ledger report is not the accrual report for ' + (day === through ? day : day + ' to ' + through) + '.');
  const index = type => { const found = columns.flatMap((column, n) => column.ColType === type ? [n] : []); if (found.length !== 1) fail('The General Ledger report has no single ' + type + ' column.'); return found[0]; };
  const typeAt = index('txn_type'), debitAt = index('debt_amt'), creditAt = index('credit_amt'), dateAt = index('tx_date');
  const out = {}, unknown = [];
  const walk = (rows, account) => {
    for (const row of rows || []) {
      if (row.type === 'Section') { const id = row.Header?.ColData?.[0]?.id; walk(row.Rows?.Row, id || account); continue; }
      if (row.type !== 'Data' || !Array.isArray(row.ColData)) continue;
      const cell = row.ColData[typeAt], entity = LABELS[cell?.value], cents = money(row.ColData[debitAt]) - money(row.ColData[creditAt]);
      if (!account) fail('A General Ledger row has no account section.');
      const dated = row.ColData[dateAt]?.value;
      if (dated && (dated < day || dated > through)) fail('A General Ledger row is dated outside ' + day + (day === through ? '' : ' to ' + through) + '.');
      if (!entity || !/^\d{1,30}$/.test(cell?.id || '')) { if (cents) unknown.push({ label: cell?.value || null, id: cell?.id || null, accountId: account, cents }); continue; }
      (out[entity + ':' + cell.id] ||= []).push({ accountId: String(accountKey(String(account))), cents });
    }
  };
  walk(report.Rows?.Row, null);
  return { byRecord: out, unknown };
}
// The day's general records: every saved or deleted item of general runs whose record is
// dated on the day, plus the current copy version (or deletion) of each.
async function generalRecordsFor({ Runs, scope, day, through = day, copy }) {
  const runs = await Runs.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, contract: 'general-write-v1', status: { $in: ['complete', 'needs-correction', 'unknown', 'sending'] } }).select('items plan dirty').sort({ _id: 1 }).limit(500).maxTimeMS(3000).lean();
  const records = [], seen = new Set(), dirty = [];
  for (const run of runs) {
    dirty.push(...(run.dirty || []).map(row => ({ earliestDate: row.date, reason: row.reason, runId: run._id })));
    for (const [ref, item] of Object.entries(run.items || {})) {
      if (!['saved', 'deleted'].includes(item.outcome) || !['create', 'update', 'void', 'delete'].includes(item.op)) continue;
      const op = run.plan.operations.find(row => row.ref === ref), id = item.qboId || op?.id, before = op?.before || null;
      const inside = date => typeof date === 'string' && date >= day && date <= through;
      if (!id || !(inside(item.record?.TxnDate) || inside(before?.TxnDate)) || seen.has(item.entity + ':' + id)) continue;
      seen.add(item.entity + ':' + id);
      const current = item.outcome === 'deleted' ? null : await copy.read(scope, item.entity, id);
      records.push({ entity: item.entity, id, current: current || item.record || null, deleted: item.outcome === 'deleted', before: item.op === 'create' ? null : before, evidence: { accountant: { versionHash: hash(item.record || {}), record: item.record || null } } });
    }
  }
  return { records, dirty };
}
// The day close for general records: classification, current postings against the
// ledger, movements for the period assertion, and dirty ranges through the cursor.
// Ledger rows of transactions that are not general records belong to the fixed
// workflows' own period proof and are returned for it, never silently accepted.
async function closeGeneralDay({ Runs, scope, day, through = day, copy, ledgerReport, ctx, ownSettlements = new Set(), verifiedThrough, openingDate }) {
  const ledger = parseLedger(ledgerReport, day, through, ctx.accountKey), { records, dirty } = await generalRecordsFor({ Runs, scope, day, through, copy });
  const evaluation = evaluateDay({ records, ledger: ledger.byRecord, ownSettlements, ctx });
  const general = new Set(records.map(row => row.entity + ':' + row.id));
  const others = Object.keys(ledger.byRecord).filter(key => !general.has(key)).sort();
  if (ledger.unknown.length) evaluation.failures.push({ key: null, reason: ledger.unknown.length + ' General Ledger rows name a transaction type the close cannot attribute.', rows: ledger.unknown });
  return { ok: evaluation.failures.length === 0, day, through, records: evaluation.results, movements: evaluation.movements, failures: evaluation.failures, fixedWorkflowKeys: others, reverify: dirtyRange({ markers: dirty, verifiedThrough, openingDate }) };
}
module.exports = { ledgerEndpoint, parseLedger, generalRecordsFor, closeGeneralDay, LABELS };
