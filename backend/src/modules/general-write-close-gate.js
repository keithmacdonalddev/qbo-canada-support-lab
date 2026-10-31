'use strict';
// General closes bind every run, current record and posting reference version. Historical
// edits remain unavailable until downstream periods and opening evidence can be re-proved.
const { hash } = require('./business-calendar');
const { closeGeneralDay, ledgerEndpoint, generalRecordsFor } = require('./general-write-day-close');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'GENERAL_DAY_CLOSE_UNVERIFIED' }); }
const TAX_SUBTYPES = ['GlobalTaxPayable', 'GlobalTaxSuspense', 'SalesTaxPayable', 'OtherCurrentLiabilities'];
function createGeneralCloseGate({ models = {}, copy, now = () => Date.now() }) {
  const Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun'), Closes = models.GeneralDayCloses || require('../models/GeneralDayClose'), Records = models.Records || require('../models/CompanySyncRecord');
  const company = scope => ({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId });
  async function pending(scope, { fromDate, throughDate, verifiedThrough }) {
    const gathered = await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy });
    // Include current dates: an external move into this period must not escape close.
    const unresolved = gathered.dirty.filter(row => verifiedThrough && row.earliestDate <= verifiedThrough).map(row => ({ key: String(row.runId) + ':' + row.earliestDate, earliestDate: row.earliestDate }));
    return { hasRecords: gathered.records.length > 0, unresolved, gathered };
  }

  async function contextFor(scope, mappings, records) {
    const items = new Map(), wanted = new Set();
    for (const row of records) for (const record of [row.current, row.before]) for (const line of record?.Line || []) { const id = line?.[line?.DetailType]?.ItemRef?.value; if (id != null) wanted.add(String(id)); }
    for (const id of wanted) { const record = await copy.read(scope, 'Item', id); if (record) items.set(id, record); }
    const accounts = await Records.find({ ...company(scope), entity: 'Account', deleted: false, 'record.AccountSubType': { $in: TAX_SUBTYPES } }).select('qboId record').limit(201).maxTimeMS(3000).lean();
    if (accounts.length > 200) fail('Tax-account enumeration exceeds its proof budget; close is incomplete.');
    const tax = accounts.filter(row => row.record?.AccountSubType !== 'OtherCurrentLiabilities' || /\b(GST|HST|PST|QST|tax)\b/i.test(row.record?.Name || '')).map(row => String(row.qboId));
    const evidence = { mappings, items: [...items], taxAccounts: accounts.map(row => ({ qboId: row.qboId, record: row.record })) };
    return { evidence, get: (entity, id) => entity === 'Item' ? items.get(String(id)) || null : null,
      receivables: mappings.accountsReceivable ? String(mappings.accountsReceivable) : null, payables: mappings.accountsPayable ? String(mappings.accountsPayable) : null, undepositedFunds: mappings.undepositedFunds ? String(mappings.undepositedFunds) : null,
      // Retain real account identities. Multiple agency accounts require an explicit
      // rate-to-account proof; guessing or collapsing them could hide a substitution.
      taxAccount: () => { if (tax.length !== 1) fail('The tax posting account cannot be attributed uniquely; retain a rate-to-account proof before close.'); return tax[0]; }, accountKey: id => String(id) };
  }
  async function verifyRange(scope, { fromDate, throughDate, readLedger, mappings, verifiedThrough, openingDate, gathered }) {
    const preview = gathered || await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy }), ctx = await contextFor(scope, mappings, preview.records);
    const snapshotHash = hash({ fromDate, throughDate, ...preview, context: ctx.evidence });
    const prior = await Closes.findOne({ ...company(scope), fromDate, throughDate, kind: 'period', ok: true, snapshotHash }).sort({ verifiedAt: -1 }).maxTimeMS(3000).lean();
    if (prior?.snapshotHash === snapshotHash) return prior;
    const report = await readLedger(fromDate, throughDate);
    const after = await generalRecordsFor({ Runs, scope, day: fromDate, through: throughDate, copy });
    const afterContext = await contextFor(scope, mappings, after.records);
    if (hash(preview) !== hash(after) || hash(ctx.evidence) !== hash(afterContext.evidence)) fail('General-write records or posting references changed while the ledger was read; close needs fresh evidence.');
    const closed = await closeGeneralDay({ Runs, scope, day: fromDate, through: throughDate, copy, ledgerReport: report, ctx, verifiedThrough, openingDate, gathered: preview });
    const row = { _id: hash({ scope: company(scope), fromDate, throughDate, snapshotHash, at: now(), ledger: hash(report) }).slice(0, 24), contract: 'general-write-v1', ...company(scope), fromDate, throughDate, kind: 'period', ok: closed.ok, snapshotHash, ledgerHash: hash(report), recordCount: closed.records.length, failures: closed.failures.map(row => ({ key: row.key, reason: row.reason })), records: closed.records.map(row => ({ key: row.key, kind: row.kind })), markers: [], verifiedAt: new Date(now()) };
    await Closes.create([row]);
    return row;
  }
  async function assertPeriodReady(scope, { fromDate, throughDate, verifiedThrough, openingDate, mappings, readLedger }) {
    const need = await pending(scope, { fromDate, throughDate, verifiedThrough });
    if (need.unresolved.length) fail('General history edits have unresolved accounting invalidation from ' + need.unresolved.map(row => row.earliestDate).sort()[0] + '. Historical completions, downstream movements' + (openingDate && need.unresolved.some(row => row.earliestDate < openingDate) ? ' and the opening baseline' : '') + ' must be re-proved; record-only ledger checks cannot clear these markers.');
    const results = need.hasRecords ? [await verifyRange(scope, { fromDate, throughDate, readLedger, mappings, verifiedThrough, openingDate, gathered: need.gathered })] : [];
    const failed = results.filter(row => !row.ok);
    if (failed.length) fail('General writes in ' + fromDate + ' to ' + throughDate + ' are not verified: ' + failed.flatMap(row => row.failures.map(item => (item.key ? item.key + ': ' : '') + item.reason)).slice(0, 10).join(' | ') + ' The calendar waits until they are corrected or explained.');
    return { required: results.length > 0, results: results.map(row => ({ fromDate: row.fromDate, throughDate: row.throughDate, kind: row.kind, ok: row.ok, recordCount: row.recordCount })) };
  }
  return { pending, assertPeriodReady, ledgerEndpoint };
}
module.exports = { createGeneralCloseGate };
