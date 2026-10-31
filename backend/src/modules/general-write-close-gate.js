'use strict';
// The calendar gate for general governed writes (general-write-v1, design rev 3, step 5).
// A scheduled period is prepared only when (1) every general write dated in it passes the
// day-close check (closeGeneralDay: current version accounted for, General Ledger rows
// equal the postings its own lines require), and (2) every history edit's durable dirty
// marker inside verified history has been re-verified the same way over the affected
// range through the cursor. Each check reads ONE General Ledger report for its range and
// is retained as a GeneralDayClose row; a passing row is reused, a failing one blocks the
// calendar with its plain reasons. Same-day general writes are already inside the
// period's opening trial balance, so the existing movement proof stays unchanged.
const { hash } = require('./business-calendar');
const { closeGeneralDay, ledgerEndpoint } = require('./general-write-day-close');
const { dirtyRange } = require('./general-write-close');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'GENERAL_DAY_CLOSE_UNVERIFIED' }); }
const STATUSES = ['complete', 'needs-correction', 'unknown', 'sending'];
const TAX_SUBTYPES = ['GlobalTaxPayable', 'GlobalTaxSuspense', 'SalesTaxPayable', 'OtherCurrentLiabilities'];
function createGeneralCloseGate({ models = {}, copy, now = () => Date.now() }) {
  const Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun'), Closes = models.GeneralDayCloses || require('../models/GeneralDayClose'), Records = models.Records || require('../models/CompanySyncRecord');
  const company = scope => ({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId });
  async function runsOf(scope) { return Runs.find({ ...company(scope), contract: 'general-write-v1', status: { $in: STATUSES } }).select('items plan dirty').sort({ _id: 1 }).limit(500).maxTimeMS(3000).lean(); }
  // What this period needs: general records dated in it, and unresolved history markers.
  async function pending(scope, { fromDate, throughDate, verifiedThrough }) {
    const runs = await runsOf(scope), inside = date => typeof date === 'string' && date >= fromDate && date <= throughDate;
    const hasRecords = runs.some(run => Object.entries(run.items || {}).some(([ref, item]) => ['saved', 'deleted'].includes(item.outcome) && (inside(item.record?.TxnDate) || inside(run.plan?.operations?.find(op => op.ref === ref)?.before?.TxnDate))));
    const markers = runs.flatMap(run => (run.dirty || []).filter(row => verifiedThrough && row.date <= verifiedThrough).map(row => ({ key: String(run._id) + ':' + row.date, earliestDate: row.date })));
    const resolved = new Set((await Closes.find({ ...company(scope), kind: 'reverify', ok: true }).select('markers').limit(1000).maxTimeMS(3000).lean()).flatMap(row => row.markers || []));
    return { hasRecords, unresolved: markers.filter(row => !resolved.has(row.key)) };
  }
  // The posting context: published control accounts, items from the copy, tax accounts.
  async function contextFor(scope, mappings, records) {
    const items = new Map(), wanted = new Set();
    for (const row of records) for (const record of [row.current, row.before]) for (const line of record?.Line || []) { const id = line?.[line?.DetailType]?.ItemRef?.value; if (id != null) wanted.add(String(id)); }
    for (const id of wanted) { const record = await copy.read(scope, 'Item', id); if (record) items.set(id, record); }
    const tax = new Set((await Records.find({ ...company(scope), entity: 'Account', deleted: false, 'record.AccountSubType': { $in: TAX_SUBTYPES } }).select('qboId record.AccountSubType record.Name').limit(200).maxTimeMS(3000).lean()).filter(row => row.record?.AccountSubType !== 'OtherCurrentLiabilities' || /\b(GST|HST|PST|QST|tax)\b/i.test(row.record?.Name || '')).map(row => String(row.qboId)));
    return { get: (entity, id) => entity === 'Item' ? items.get(String(id)) || null : null, receivables: mappings.accountsReceivable ? String(mappings.accountsReceivable) : null, payables: mappings.accountsPayable ? String(mappings.accountsPayable) : null, undepositedFunds: mappings.undepositedFunds ? String(mappings.undepositedFunds) : null, taxAccount: () => 'tax', accountKey: id => tax.has(String(id)) ? 'tax' : String(id) };
  }
  async function verifyRange(scope, { fromDate, throughDate, kind, markers = [], readLedger, mappings, verifiedThrough, openingDate }) {
    const report = await readLedger(fromDate, throughDate);
    const preview = await require('./general-write-day-close').generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy });
    const ctx = await contextFor(scope, mappings, preview.records);
    const closed = await closeGeneralDay({ Runs, scope, day: fromDate, through: throughDate, copy, ledgerReport: report, ctx, verifiedThrough, openingDate });
    const row = { _id: hash({ scope: company(scope), fromDate, throughDate, kind, at: now(), ledger: hash(report) }).slice(0, 24), contract: 'general-write-v1', ...company(scope), fromDate, throughDate, kind, ok: closed.ok, ledgerHash: hash(report), recordCount: closed.records.length, failures: closed.failures.map(row => ({ key: row.key, reason: row.reason })), records: closed.records.map(row => ({ key: row.key, kind: row.kind })), markers: closed.ok ? markers : [], verifiedAt: new Date(now()) };
    await Closes.create([row]);
    return row;
  }
  // Before a scheduled period is prepared. readLedger(from, through) reads one GL report.
  async function assertPeriodReady(scope, { fromDate, throughDate, verifiedThrough, openingDate, mappings, readLedger }) {
    const need = await pending(scope, { fromDate, throughDate, verifiedThrough }), results = [];
    if (need.unresolved.length) {
      const range = dirtyRange({ markers: need.unresolved, verifiedThrough, openingDate });
      if (range) results.push(await verifyRange(scope, { fromDate: range.from, throughDate: range.through, kind: 'reverify', markers: need.unresolved.map(row => row.key), readLedger, mappings, verifiedThrough, openingDate }));
    }
    if (need.hasRecords) {
      const prior = await Closes.findOne({ ...company(scope), fromDate, throughDate, kind: 'period', ok: true }).sort({ verifiedAt: -1 }).maxTimeMS(3000).lean();
      results.push(prior || await verifyRange(scope, { fromDate, throughDate, kind: 'period', readLedger, mappings, verifiedThrough, openingDate }));
    }
    const failed = results.filter(row => !row.ok);
    if (failed.length) fail('General writes in ' + failed.map(row => row.fromDate === row.throughDate ? row.fromDate : row.fromDate + ' to ' + row.throughDate).join(', ') + ' are not verified: ' + failed.flatMap(row => row.failures.map(item => (item.key ? item.key + ': ' : '') + item.reason)).slice(0, 10).join(' | ') + ' The calendar waits until they are corrected or explained.');
    return { required: results.length > 0, results: results.map(row => ({ fromDate: row.fromDate, throughDate: row.throughDate, kind: row.kind, ok: row.ok, recordCount: row.recordCount })) };
  }
  return { pending, assertPeriodReady, ledgerEndpoint };
}
module.exports = { createGeneralCloseGate };
