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
// day or period. Account identities stay distinct, including tax agency accounts.
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
// Keyset paging covers every run; a broken/repeated page fails visibly.
async function readGeneralRuns(Runs, scope) {
  const out = [], size = 500;
  let after = null;
  for (;;) {
    const rows = await Runs.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, contract: 'general-write-v1', ...(after ? { _id: { $gt: after } } : {}) }).select('items plan dirty batches status revision updatedAt day').sort({ _id: 1 }).limit(size).maxTimeMS(3000).lean();
    if (!Array.isArray(rows) || after && rows.some(row => String(row._id) <= after)) fail('General-write enumeration did not advance; close is incomplete.');
    out.push(...rows);
    if (rows.length < size) return out;
    after = String(rows.at(-1)._id);
  }
}
async function generalRecordsFor({ Runs, scope, day, through = day, copy }) {
  const runs = await readGeneralRuns(Runs, scope), candidates = new Map(), dirty = [];
  const inside = date => typeof date === 'string' && date >= day && date <= through;
  for (const run of runs) {
    dirty.push(...(run.dirty || []).map(row => ({ earliestDate: row.date, reason: row.reason, runId: run._id })));
    for (const batch of run.batches || []) if (batch.state !== 'answered' && batch.items.some(item => inside(item.payload?.TxnDate || run.day) || inside(item.before?.TxnDate))) fail('General write ' + run._id + ' has an unsettled batch; recover its original response before close.');
    for (const [ref, item] of Object.entries(run.items || {})) {
      const op = run.plan.operations.find(row => row.ref === ref), id = item.qboId || op?.id;
      const dispatched = [...(run.batches || [])].reverse().find(batch => (!item.attempt || batch.attempt === item.attempt) && batch.items.some(row => row.ref === ref))?.items.find(row => row.ref === ref);
      const before = item.before || dispatched?.before || op?.before || null;
      if (!['saved', 'deleted'].includes(item.outcome)) {
        if (inside(item.record?.TxnDate || run.day) || inside(before?.TxnDate)) fail('General write ' + run._id + ' has an unresolved item; close is incomplete.');
        continue;
      }
      if (!id || !['create', 'update', 'void', 'delete'].includes(item.op)) continue;
      const key = item.entity + ':' + id, previous = candidates.get(key);
      const dates = [...(previous?.dates || []), item.record?.TxnDate, before?.TxnDate].filter(Boolean);
      const request = item.request || dispatched?.payload || op?.payload || {};
      const version = BigInt((item.op === 'delete' ? request.SyncToken : item.record?.SyncToken) ?? op?.targetVersion ?? before?.SyncToken ?? -1);
      // Newest proved version wins regardless of run-id ordering; a successful delete
      // follows the version it consumed and must not be hidden by an earlier create.
      if (!previous || version > previous.version || version === previous.version && item.outcome === 'deleted') candidates.set(key, { item, op, before, id, version, dates, request });
      else previous.dates = dates;
    }
  }
  const records = [];
  for (const { item, op, before, id, dates, request } of candidates.values()) {
    // An exact successful delete is its tombstone; do not turn its expected
    // not-found GET into a close failure. Remaining GL rows still fail proof.
    const current = item.outcome === 'deleted' ? null : await copy.read(scope, item.entity, id);
    if (![...dates, current?.TxnDate].some(inside)) continue;
    const deleted = item.outcome === 'deleted';
    records.push({ entity: item.entity, id, current: current || null, deleted, unavailable: !deleted && !current, before: item.op === 'create' ? null : before,
      evidence: { accountant: { versionHash: hash(item.record || {}), record: item.record || null, deleted, operation: item.op, request } } });
  }
  return { records, dirty, runVersions: runs.map(run => ({ id: String(run._id), revision: run.revision ?? 0, items: run.items || {}, batches: run.batches || [] })) };
}
// The day close for general records: classification, current postings against the
// ledger, movements for the period assertion, and dirty ranges through the cursor.
// Ledger rows of transactions that are not general records belong to the fixed
// workflows' own period proof and are returned for it, never silently accepted.
async function closeGeneralDay({ Runs, scope, day, through = day, copy, ledgerReport, ctx, ownSettlements = new Set(), verifiedThrough, openingDate, gathered = null }) {
  const ledger = parseLedger(ledgerReport, day, through, ctx.accountKey), { records, dirty } = gathered || await generalRecordsFor({ Runs, scope, day, through, copy });
  const evaluation = evaluateDay({ records, ledger: ledger.byRecord, ownSettlements, ctx });
  const general = new Set(records.map(row => row.entity + ':' + row.id));
  const others = Object.keys(ledger.byRecord).filter(key => !general.has(key)).sort();
  if (ledger.unknown.length) evaluation.failures.push({ key: null, reason: ledger.unknown.length + ' General Ledger rows name a transaction type the close cannot attribute.', rows: ledger.unknown });
  return { ok: evaluation.failures.length === 0, day, through, records: evaluation.results, movements: evaluation.movements, failures: evaluation.failures, fixedWorkflowKeys: others, reverify: dirtyRange({ markers: dirty, verifiedThrough, openingDate }) };
}
module.exports = { ledgerEndpoint, parseLedger, generalRecordsFor, readGeneralRuns, closeGeneralDay, LABELS };
