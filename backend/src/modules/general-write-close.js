'use strict';
// Day-close classification and history invalidation of the general governed write tool
// (general-write-v1, design rev 3, R1-2 and R1-3). Pure.
//
// classifyRecord decides, for one record dated in the day or changed since the last
// close, whether its CURRENT version is accounted for. Historical verification alone
// never clears an externally edited record. dirtyRange turns durable dirty-period markers
// into the closes that must be re-verified, through the current cursor.
const { hash } = require('./business-calendar');
const { accountingView, NON_POSTING } = require('./general-write-postings');
const accountingRecord = (entity, record) => NON_POSTING.has(entity) && entity !== 'TimeActivity' ? record : accountingView(record);
const { businessErrorDetail, definitionDifferences } = require('./business-error-detail');
// Fields an own later settlement may change on a parent: balance, remaining credit,
// backlinks, version metadata and the deposit/billing status those links imply.
const SETTLEMENT_FIELDS = new Set(['Balance', 'HomeBalance', 'RemainingCredit', 'LinkedTxn', 'SyncToken', 'MetaData', 'TxnStatus', 'BillableStatus', 'POStatus', 'UnappliedAmt', 'DepositToAccountRef']);
const versionHash = record => hash(record);
const { sameQboValue } = require('./qbo-semantic-compare');
function sameProvenRecord(entity, proof, current, expectedHash) {
  const version = /^(0|[1-9]\d{0,63})$/;
  if (!proof || !current || typeof proof.SyncToken !== 'string' || typeof current.SyncToken !== 'string' || !version.test(proof.SyncToken || '') || !version.test(current.SyncToken || '') || BigInt(current.SyncToken) < BigInt(proof.SyncToken)) return false;
  return Boolean(hash(proof) === expectedHash && sameQboValue(accountingRecord(entity, proof), accountingRecord(entity, current), { entity, metadata: true }));
}
function headerLinks(record) { return (record?.LinkedTxn || []).map(link => (link.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link.TxnType) + ':' + String(link.TxnId)); }
// proven: the version last proved; current: the copy's version; ownSettlements: set of
// 'Type:id' of the accountant's own VERIFIED settlements (payments, credits, deposits…).
// Close supplies a Map from each settlement key to its exact parent keys. Pure callers
// may supply a Set when parent ownership has already been established.
// True when current differs from proven only by those settlements' effects.
function settlementTargets(value) { return value instanceof Set ? value : new Set(value?.targets || []); }
function allocation(record, entity, id) {
  let total = 0;
  for (const line of record?.Line || []) {
    const links = line.LinkedTxn || [];
    if (!links.some(link => (link.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link.TxnType) === entity && String(link.TxnId) === String(id))) continue;
    // A split line cannot establish how much belongs to each source.
    const amount = Math.round(line.Amount * 100);
    if (links.length !== 1 || typeof line.Amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 || Math.abs(line.Amount * 100 - amount) > 0.00001) return null;
    total += amount; if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}
function explainedByOwnSettlements(proven, current, ownSettlements, entity) {
  if (!proven || !current || String(proven.Id) !== String(current.Id)) return false;
  const version = /^(0|[1-9]\d{0,63})$/;
  if (!version.test(proven.SyncToken || '') || !version.test(current.SyncToken || '') || BigInt(current.SyncToken) < BigInt(proven.SyncToken)) return false;
  const strip = record => Object.fromEntries(Object.entries(accountingView(record)).filter(([key]) => !SETTLEMENT_FIELDS.has(key)));
  if (!sameQboValue(strip(proven), strip(current), { entity, metadata: true })) return false;
  const before = new Set(headerLinks(proven)), links = headerLinks(current), added = links.filter(key => !before.has(key));
  if (new Set(links).size !== links.length || ![...before].every(key => links.includes(key))) return false;
  const target = entity + ':' + current.Id;
  if (!added.every(key => ownSettlements.has(key) && (!(ownSettlements instanceof Map) || settlementTargets(ownSettlements.get(key)).has(target)))) return false;
  // Legacy pure Set callers have already established the target graph. Runtime
  // callers supply bodies so ownership alone cannot explain an arbitrary balance.
  if (!(ownSettlements instanceof Map)) return added.length > 0;
  const cents = value => typeof value === 'number' && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001 ? Math.round(value * 100) : null;
  let applied = 0;
  const completeGraph = typeof current.TotalAmt === 'number' && ['Invoice','Bill','CreditMemo','VendorCredit'].includes(entity);
  const applicationType = ['Bill','VendorCredit'].includes(entity) ? 'BillPayment:' : 'Payment:';
  const applications = completeGraph ? links.filter(key => key.startsWith(applicationType)) : added;
  if (added.some(key => !key.startsWith(applicationType) && !key.startsWith('Deposit:'))) return false;
  if (!applications.length) return false;
  for (const key of applications) {
    if (!ownSettlements.has(key) || !settlementTargets(ownSettlements.get(key)).has(target)) return false;
    const body = ownSettlements.get(key)?.record;
    if (!body || body.status === 'Voided' || body.PrivateNote?.startsWith?.('Voided')) return false;
    const amount = allocation(body, entity, current.Id);
    if (amount === null || amount <= 0) return false;
    const party = entity === 'Bill' || entity === 'VendorCredit' ? 'VendorRef' : 'CustomerRef';
    if (proven[party]?.value && body[party]?.value && proven[party].value !== body[party].value) return false;
    if (key.startsWith('Deposit:')) {
      const gross = cents(proven.TotalAmt) ?? (proven.Line || []).reduce((n, line) => n + (cents(line.Amount) || 0), 0);
      if (!['Payment','SalesReceipt'].includes(entity) || amount !== gross || !body.DepositToAccountRef?.value || (!sameQboValue(proven.DepositToAccountRef || null, current.DepositToAccountRef || null) && current.DepositToAccountRef?.value !== body.DepositToAccountRef.value)) return false;
    } else {
      const expected = ['Bill','VendorCredit'].includes(entity) ? 'BillPayment:' : 'Payment:';
      if (!key.startsWith(expected)) return false;
      applied += amount;
    }
  }
  const openField = entity === 'CreditMemo' && (proven.RemainingCredit !== undefined || current.RemainingCredit !== undefined) ? 'RemainingCredit' : ['Invoice','Bill','VendorCredit','CreditMemo'].includes(entity) ? 'Balance' : null;
  for (const field of ['Balance','RemainingCredit','UnappliedAmt']) {
    if (field !== openField && !sameQboValue(proven[field] ?? null, current[field] ?? null)) return false;
    if (field !== openField) continue;
    if (proven[field] === undefined && current[field] === undefined) continue;
    const old = cents(proven[field]), next = cents(current[field]);
    if (old === null || next === null || next < 0 || (completeGraph ? cents(current.TotalAmt) : old) - applied !== next) return false;
  }
  // Foreign home allocations require their original conversion proof, never a
  // guessed proportional exchange rate from today's remaining balance.
  if (proven.HomeBalance !== current.HomeBalance) return false;
  if (!added.some(key => key.startsWith('Deposit:')) && !sameQboValue(proven.DepositToAccountRef || null, current.DepositToAccountRef || null)) return false;
  return true;
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
        const apProof=proof?.apOmission,apView=apProof?require('./general-billpayment-recovery').accountingView(row.current,apProof):null;if(apProof&&!apView)throw Error('The proved omitted payable account no longer matches this payment');
        const accountingCurrent=apView||row.current;
        let requestedView = ownDeposit ? { ...row.current, DepositToAccountRef: proof.record.DepositToAccountRef } : accountingCurrent;
        if(proof.nativeTimeEstimate){const view=require('./general-time-estimate-source').requestView(row.current,proof.nativeTimeEstimate);if(!view)throw Error('The native time/estimate link proof is unavailable or changed');requestedView=view;}
        if(row.entity==='Estimate'&&proof.estimateConversion) requestedView={...requestedView,TxnStatus:proof.estimateConversion.originalStatus};
        if(row.entity==='TimeActivity'&&proof.timeBilling){
          const billed=require('./general-time-billing').requestView(row.current,proof.timeBilling);
          if(!billed)throw Error('The owned time-billing proof is unavailable or changed');
          requestedView=billed;
        }
        if (!row.deleted && !require('./qbo-semantic-compare').matchesQboRequest(accountingRecord(row.entity, row.evidence?.accountant?.request || {}), accountingRecord(row.entity, requestedView), { entity: row.entity })) throw new Error('Its current fields differ from the requested account, item, tax or other values.');
        const inPeriod = !fromDate || row.current?.TxnDate >= fromDate && row.current?.TxnDate <= throughDate;
        const comparison = compareLedger(postingsOf(row.entity, row.deleted || !inPeriod ? null : accountingCurrent, { ...ctx, postingSources: proof?.postingSources }), ledger[key] || []);
        if(apView&&inPeriod&&!require('./general-billpayment-recovery').exactRows(accountingCurrent,ledger[key]||[])){comparison.ok=false;comparison.differences.push({field:'BillPayment ledger rows',reason:'Expected exactly the proved payable debit and bank credit'});}
        result.postings = comparison;
        if (!comparison.ok) failures.push({ key, reason: 'Its General Ledger rows differ from the postings its own lines require.', differences: comparison.differences });
        if (row.before !== undefined) movements.push(...movementsOf(row.entity, row.before, row.deleted ? null : accountingCurrent, { ...ctx, postingSources: proof?.postingSources }));
      } catch (error) { failures.push({ key, reason: error.message, errorDetail: businessErrorDetail(error, { entity: row.entity, recordId: row.id }) }); }
    }
    results.push(result);
  }
  return { ok: failures.length === 0, results, movements, failures };
}
module.exports = { accountingRecord, classifyRecord, explainedByOwnSettlements, dirtyRange, earliestAffected, versionHash, sameProvenRecord, allocation, evaluateDay };
