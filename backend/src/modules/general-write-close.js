'use strict';
// Day-close classification and history invalidation of the general governed write tool
// (general-write-v1, design rev 3, R1-2 and R1-3). Pure.
//
// classifyRecord decides, for one record dated in the day or changed since the last
// close, whether its CURRENT version is accounted for. Historical verification alone
// never clears an externally edited record. dirtyRange turns durable dirty-period markers
// into the closes that must be re-verified, through the current cursor.
const { hash } = require('./business-calendar');
const { businessErrorDetail, definitionDifferences } = require('./business-error-detail');
// Fields an own later settlement may change on a parent: balance, remaining credit,
// backlinks, version metadata and the deposit/billing status those links imply.
const SETTLEMENT_FIELDS = new Set(['Balance', 'HomeBalance', 'RemainingCredit', 'LinkedTxn', 'SyncToken', 'MetaData', 'TxnStatus', 'BillableStatus', 'POStatus', 'UnappliedAmt', 'DepositToAccountRef']);
const versionHash = record => hash(record);
const { sameQboValue } = require('./qbo-semantic-compare');
function sameProvenRecord(entity, proof, current, expectedHash) {
  const version = /^(0|[1-9]\d{0,63})$/;
  if (!proof || !current || typeof proof.SyncToken !== 'string' || typeof current.SyncToken !== 'string' || !version.test(proof.SyncToken || '') || !version.test(current.SyncToken || '') || BigInt(current.SyncToken) < BigInt(proof.SyncToken)) return false;
  return Boolean(hash(proof) === expectedHash && sameQboValue(proof, current, { entity, metadata: true }));
}
function headerLinks(record) { return (record?.LinkedTxn || []).map(link => (link.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link.TxnType) + ':' + String(link.TxnId)); }
// proven: the version last proved; current: the copy's version; ownSettlements: set of
// 'Type:id' of the accountant's own VERIFIED settlements (payments, credits, deposits…).
// Close supplies a Map from each settlement key to its exact parent keys. Pure callers
// may supply a Set when parent ownership has already been established.
// True when current differs from proven only by those settlements' effects.
function explainedByOwnSettlements(proven, current, ownSettlements, entity) {
  if (!proven || !current) return false;
  const strip = record => Object.fromEntries(Object.entries(record).filter(([key]) => !SETTLEMENT_FIELDS.has(key) && key !== 'Line'));
  if (!sameQboValue(strip(proven), strip(current), { entity, metadata: true }) || !sameQboValue({ Line: proven.Line || [] }, { Line: current.Line || [] })) return false;
  const before = new Set(headerLinks(proven)), added = headerLinks(current).filter(key => !before.has(key));
  return added.length > 0 && headerLinks(proven).every(key => headerLinks(current).includes(key)) && added.every(key => ownSettlements.has(key) && (!(ownSettlements instanceof Map) || ownSettlements.get(key).has(entity + ':' + current.Id)));
}
// evidence: { accountant: { versionHash, record } | null, fixed: { observedHash, record } |
// null, adopted: { proofHash, record } | null }. Returns { kind, reason }.
function classifyRecord({ entity, current, deleted = false, evidence = {}, ownSettlements = new Set() }) {
  const now = deleted ? null : versionHash(current);
  for (const [kind, proof, field] of [['accountant', evidence.accountant, 'versionHash'], ['fixed-workflow', evidence.fixed, 'observedHash'], ['adopted', evidence.adopted, 'proofHash']]) {
    if (!proof) continue;
    if (deleted && kind === 'accountant' && proof.deleted === true && proof.operation === 'delete' && !current) return { kind: 'accountant', reason: 'Deletion is proved by the accountant’s successful delete outcome.' };
    if (deleted || proof.deleted) return { kind: 'external-change', reason: entity + ' was deleted outside the accountant’s own work.' };
    if (proof[field] === now || sameProvenRecord(entity, proof.record, current, proof[field])) return { kind, reason: 'Current version is the proved version.' };
    if (explainedByOwnSettlements(proof.record, current, ownSettlements, entity)) return { kind, reason: 'Changed only by the accountant’s own verified settlements.' };
    return { kind: 'external-change', reason: entity + ' changed after it was proved (not by the accountant’s own settlements).' };
  }
  return { kind: 'external-change', reason: deleted ? entity + ' was deleted and has no proof.' : entity + ' has no accountant, workflow or import proof.' };
}
// markers: durable dirty-period markers [{ earliestDate, reason, receiptId }] written
// before dispatch (or from CDC). Everything from the earliest dirty date through the
// current cursor is re-verified; a date before the managed opening invalidates the
// opening baseline.
function dirtyRange({ markers, verifiedThrough, openingDate }) {
  const dates = (markers || []).map(row => row?.earliestDate).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value || '')).sort();
  if (!dates.length || !verifiedThrough || dates[0] > verifiedThrough) return null;
  return { from: openingDate && dates[0] < openingDate ? openingDate : dates[0], through: verifiedThrough, baseline: Boolean(openingDate && dates[0] < openingDate), markers: dates.length };
}
// The earliest date a change can affect: the record's old and new dates (history affects
// every later opening balance).
function earliestAffected(before, after) { return [before?.TxnDate, after?.TxnDate].filter(Boolean).sort()[0] || null; }
// One day's close for general records (pure). records: [{ entity, id, current, deleted,
// evidence, before? }] for every transaction dated in the day or changed since the last
// close; ledger: { 'Entity:id': [{ accountId, cents }] } from the day's General Ledger rows;
// ownSettlements: the accountant's own verified settlements. Returns the classification,
// the current-posting comparison of each accountant record (after-state, R2-1), the
// date-allocated movements to add to the period assertion, and every failure.
function evaluateDay({ records, ledger, ownSettlements = new Set(), ctx, fromDate = null, throughDate = fromDate }) {
  const { postingsOf, compareLedger, movementsOf } = require('./general-write-postings');
  const results = [], movements = [], failures = [];
  for (const row of records) {
    const key = row.entity + ':' + row.id, classified = classifyRecord({ entity: row.entity, current: row.current, deleted: row.deleted, evidence: row.evidence, ownSettlements });
    const result = { key, kind: classified.kind, reason: classified.reason };
    if (classified.kind === 'external-change') failures.push({ key, reason: classified.reason, differences: definitionDifferences(row.evidence?.accountant?.record || {}, row.current || {}) });
    if (row.unavailable) failures.push({ key, reason: 'Its current version is unavailable; a retained response cannot substitute for current evidence.' });
    if (classified.kind === 'accountant') {
      try {
        // QBO may replace the receipt's DepositToAccountRef with the destination bank
        // after an owned Deposit. Its original request still described Undeposited Funds.
        const proof = row.evidence?.accountant, ownDeposit = ['Payment', 'SalesReceipt'].includes(row.entity) && explainedByOwnSettlements(proof?.record, row.current, ownSettlements, row.entity)
          && headerLinks(row.current).some(key => key.startsWith('Deposit:') && ownSettlements.has(key));
        const requestedView = ownDeposit ? { ...row.current, DepositToAccountRef: proof.record.DepositToAccountRef } : row.current;
        if (!row.deleted && !require('./general-write-recovery').matchesRequest(row.evidence?.accountant?.request || {}, requestedView, row.entity)) throw new Error('Its current fields differ from the requested account, item, tax or other values.');
        const inPeriod = !fromDate || row.current?.TxnDate >= fromDate && row.current?.TxnDate <= throughDate;
        const comparison = compareLedger(postingsOf(row.entity, row.deleted || !inPeriod ? null : row.current, { ...ctx, postingSources: proof?.postingSources }), ledger[key] || []);
        result.postings = comparison;
        if (!comparison.ok) failures.push({ key, reason: 'Its General Ledger rows differ from the postings its own lines require.', differences: comparison.differences });
        if (row.before !== undefined) movements.push(...movementsOf(row.entity, row.before, row.deleted ? null : row.current, { ...ctx, postingSources: proof?.postingSources }));
      } catch (error) { failures.push({ key, reason: error.message, errorDetail: businessErrorDetail(error, { entity: row.entity, recordId: row.id }) }); }
    }
    results.push(result);
  }
  return { ok: failures.length === 0, results, movements, failures };
}
module.exports = { classifyRecord, explainedByOwnSettlements, dirtyRange, earliestAffected, versionHash, sameProvenRecord, evaluateDay };
