'use strict';
// Day-close classification and history invalidation of the general governed write tool
// (general-write-v1, design rev 3, R1-2 and R1-3). Pure.
//
// classifyRecord decides, for one record dated in the day or changed since the last
// close, whether its CURRENT version is accounted for. Historical verification alone
// never clears an externally edited record. dirtyRange turns durable dirty-period markers
// into the closes that must be re-verified, through the current cursor.
const { hash, canonical } = require('./business-calendar');
// Fields an own later settlement may change on a parent: balance, remaining credit,
// backlinks, version metadata and the deposit/billing status those links imply.
const SETTLEMENT_FIELDS = new Set(['Balance', 'HomeBalance', 'RemainingCredit', 'LinkedTxn', 'SyncToken', 'MetaData', 'TxnStatus', 'BillableStatus', 'POStatus', 'UnappliedAmt', 'DepositToAccountRef']);
const versionHash = record => hash(record);
function headerLinks(record) { return (record?.LinkedTxn || []).map(link => (link.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link.TxnType) + ':' + String(link.TxnId)); }
function lineView(record) { return (record?.Line || []).map(line => { const { LinkedTxn, ...rest } = line || {}; return rest; }); }
// proven: the version last proved; current: the copy's version; ownSettlements: set of
// 'Type:id' of the accountant's own VERIFIED settlements (payments, credits, deposits…).
// True when current differs from proven only by those settlements' effects.
function explainedByOwnSettlements(proven, current, ownSettlements) {
  if (!proven || !current) return false;
  const strip = record => Object.fromEntries(Object.entries(record).filter(([key]) => !SETTLEMENT_FIELDS.has(key) && key !== 'Line'));
  if (canonical(strip(proven)) !== canonical(strip(current)) || canonical(lineView(proven)) !== canonical(lineView(current))) return false;
  const before = new Set(headerLinks(proven)), added = headerLinks(current).filter(key => !before.has(key));
  const lineLinks = record => (record?.Line || []).flatMap(line => (line?.LinkedTxn || []).map(link => link.TxnType + ':' + link.TxnId));
  if (canonical(lineLinks(proven)) !== canonical(lineLinks(current))) return false;
  return headerLinks(proven).every(key => headerLinks(current).includes(key)) && added.every(key => ownSettlements.has(key));
}
// evidence: { accountant: { versionHash, record } | null, fixed: { observedHash, record } |
// null, adopted: { proofHash, record } | null }. Returns { kind, reason }.
function classifyRecord({ entity, current, deleted = false, evidence = {}, ownSettlements = new Set() }) {
  const now = deleted ? null : versionHash(current);
  for (const [kind, proof, field] of [['accountant', evidence.accountant, 'versionHash'], ['fixed-workflow', evidence.fixed, 'observedHash'], ['adopted', evidence.adopted, 'proofHash']]) {
    if (!proof) continue;
    if (deleted) return { kind: 'external-change', reason: entity + ' was deleted outside the accountant’s own work.' };
    if (proof[field] === now) return { kind, reason: 'Current version is the proved version.' };
    if (explainedByOwnSettlements(proof.record, current, ownSettlements)) return { kind, reason: 'Changed only by the accountant’s own verified settlements.' };
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
module.exports = { classifyRecord, explainedByOwnSettlements, dirtyRange, earliestAffected, versionHash };
