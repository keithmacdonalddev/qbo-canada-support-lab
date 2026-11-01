'use strict';
const C = require('./bank-settlement-contract');
const {buildSettlementEvents} = require('./bank-settlement-engine');
const clone = value => JSON.parse(JSON.stringify(value));
function checkedHash(value) {
  const {evidenceHash,...body}=value;
  if (!/^[a-f0-9]{64}$/.test(evidenceHash || '') || C.hash(body)!==evidenceHash) throw new TypeError('Statement evidence hash disagrees with its content.');
  return body;
}
function monthEnd(period) {
  const d=new Date(C.date(period+'-01')+'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth()+1); d.setUTCDate(0); return d.toISOString().slice(0,10);
}
/** Pure historical adapter. A retained account-native balance is an anchor,
 * never a balancing plug. Derive the opening by reversing EVERY retained book
 * movement, including report-only adjustments, and cross-check mirror balances
 * where observed at the same retained cutoff. Future mirror observations are
 * kept as provenance, never mixed into the frozen history.
 * No models, QBO clients, filesystem, clock or persistent writes.
 */
function buildBankStatementEvidence(history, retained) {
  const scope=C.validateScope(history.scope);
  C.assertScope(retained.scope,scope);
  if (retained.version!==1 || retained.asOf!==history.asOf || retained.ledgerRowsHash!==C.hash(history.ledger.rows)) throw new TypeError('Retained balance evidence belongs to a different ledger snapshot.');
  const input=clone(history), openings=[], periodBookBalances=[], decisions=[];
  const accounts=new Map(input.accounts.filter(a=>['Bank','Credit Card'].includes(a.type || a.AccountType)).map(a=>[String(a.id || a.Id),a]));
  const seen=new Set();
  for (const proof of retained.accounts) {
    const body=checkedHash(proof), account=accounts.get(proof.accountId);
    if (!account || seen.has(proof.accountId)) throw new TypeError('Opening evidence has a duplicate or unknown account.');
    seen.add(proof.accountId);
    const currency=account.currency || account.CurrencyRef?.value;
    if (proof.currency!==currency || proof.asOf!==history.asOf || !proof.sourceRef || !/^[a-f0-9]{64}$/.test(proof.sourceSha256 || '')) throw new TypeError('Opening evidence requires native currency, cutoff and source provenance.');
    const rows=input.ledger.rows.filter(r=>r.accountId===proof.accountId);
    if (proof.ledgerRowsHash!==C.hash(rows) || rows.some(r=>r.date>proof.asOf)) throw new TypeError('Opening evidence has incomplete or out-of-cutoff ledger rows.');
    const net=C.sum(rows.map(r=>r.bankAccountAmountCents));
    const amountMinor=C.sum([C.integer(proof.storedNativeBookBalanceMinor),-net]);
    const range=input.provisionalRanges.find(r=>r.accountId===proof.accountId);
    if (!range || rows.some(r=>r.date<range.provisionalStartMonth+'-01')) throw new TypeError('Opening evidence requires the complete first statement range.');
    if (proof.mirror) {
      if (C.hash(proof.mirror)!==proof.mirrorHash || proof.mirror.id!==proof.accountId || proof.mirror.currency!==currency) throw new TypeError('Mirror account evidence is inconsistent.');
      // The retained balance anchor, not a newer asynchronous mirror value,
      // sets the cutoff. Earlier mirror values can only corroborate unchanged
      // accounts: never silently combine a newer balance with older ledger rows.
      const mirrorMinor=C.minor(proof.mirror.currentBalance)*(account.type==='Credit Card' || account.AccountType==='Credit Card' ? -1 : 1);
      if (proof.mirror.openingBalance!==null && proof.mirror.openingBalance!==undefined && proof.mirror.openingBalanceDate===range.provisionalStartMonth+'-01' && C.minor(proof.mirror.openingBalance)!==amountMinor) throw new TypeError('Explicit opening balance disagrees with retained balance reversal.');
      body.mirrorBalanceAgrees=mirrorMinor===proof.storedNativeBookBalanceMinor;
    }
    const firstDate=rows.map(r=>r.date).sort()[0] || null;
    const opening={accountId:proof.accountId,accountCurrency:currency,period:range.provisionalStartMonth,amountMinor,
      evidenceRef:proof.sourceRef,evidenceHash:proof.evidenceHash,
      basis:'Retained native closing balance minus all retained native book movements; first known pre-activity balance carried through quiet months.',
      source:clone(proof),crossCheck:{anchorMinor:proof.storedNativeBookBalanceMinor,retainedMovementMinor:net,derivedOpeningMinor:amountMinor,
        firstLedgerDate:firstDate,firstLedgerRowsHash:C.hash(rows.filter(r=>r.date===firstDate)),
        explicitOpeningPresent:proof.mirror?.openingBalance!==null && proof.mirror?.openingBalance!==undefined,
        openingJournalIds:clone(proof.openingJournalIds || []),mirrorBalanceAgrees:body.mirrorBalanceAgrees ?? null}};
    openings.push(opening);
    let period=range.provisionalStartMonth;
    for (let i=0; i<1200; i++) {
      const throughDate=monthEnd(period), bookClosingMinor=C.sum([amountMinor,...rows.filter(r=>r.date<=throughDate).map(r=>r.bankAccountAmountCents)]);
      periodBookBalances.push({accountId:proof.accountId,accountCurrency:currency,period,bookClosingMinor,evidenceHash:proof.evidenceHash});
      if (period===range.provisionalEndMonth) break;
      if (period>range.provisionalEndMonth || i===1199) throw new TypeError('Invalid statement evidence period range.');
      period=period.slice(5)==='12'?String(+period.slice(0,4)+1)+'-01':period.slice(0,5)+String(+period.slice(5)+1).padStart(2,'0');
    }
  }
  if (seen.size!==accounts.size) throw new TypeError('Every bank/card/cash account needs a retained balance anchor.');
  const adjusted=new Set();
  for (const proof of retained.adjustments || []) {
    checkedHash(proof);
    const identity=[proof.entity,proof.id,proof.accountId].join(':');
    if (proof.entity!=='TaxAdjustment' || proof.decision!=='simulated-bank-line' || adjusted.has(identity) || !proof.reason || !proof.evidenceRef) throw new TypeError('An explicit, unique report-only adjustment decision is required.');
    const row=input.ledger.rows.find(r=>r.type==='Sales Tax Adjustment' && r.transactionId===proof.id && r.accountId===proof.accountId);
    if (!row || proof.rowHash!==C.hash(row) || proof.date!==row.date || proof.amountMinor!==row.bankAccountAmountCents || proof.currency!==(accounts.get(proof.accountId)?.currency || accounts.get(proof.accountId)?.CurrencyRef?.value)) throw new TypeError('Adjustment classification no longer matches the retained posting.');
    if (!proof.counterpartAccountIds?.length && proof.nativeInspectionRequired!==true) throw new TypeError('Missing adjustment counterparts require native inspection.');
    adjusted.add(identity);
    row.economicMeaning={kind:'cash-adjustment',evidenceRef:proof.evidenceRef,evidenceHash:proof.evidenceHash};
    decisions.push(clone(proof));
  }
  const dataset=buildSettlementEvents(input);
  for (const proof of decisions) {
    const event=dataset.events.find(e=>e.source.entity===proof.entity && e.source.id===proof.id && e.accountId===proof.accountId);
    if (!event || event.status!=='resolved' || event.bookAmountMinor!==proof.amountMinor) throw new TypeError('Adjustment did not resolve through the settlement engine.');
    event.source.adjustmentEvidence=clone(proof);
    if (proof.nativeInspectionRequired) {
      event.resolution.nativeInspectionRequired=true;
      event.resolution.nativeActionBlockers=[...new Set([...event.resolution.nativeActionBlockers,'report-only-adjustment-requires-native-inspection'])];
    }
  }
  const body={version:1,scope,sourceSnapshotHash:C.hash(dataset),openingBalances:openings,periodBookBalances,adjustments:decisions,
    evidenceLabel:'Reconstructed simulated statement evidence; no native completion attested.'};
  return {dataset,evidence:{...body,evidenceHash:C.hash(body)}};
}
function validateBankStatementEvidence(dataset,evidence) {
  checkedHash(evidence); C.assertScope(evidence.scope,C.validateScope(dataset.scope));
  if (evidence.version!==1 || evidence.sourceSnapshotHash!==C.hash(dataset)) throw new TypeError('Statement balance evidence belongs to a different settlement snapshot.');
  const accounts=new Map(dataset.accounts.map(a=>[a.id,a])), seen=new Set();
  for (const opening of evidence.openingBalances) {
    const account=accounts.get(opening.accountId);
    if (!account || account.currency!==opening.accountCurrency || seen.has(opening.accountId)) throw new TypeError('Opening evidence account/currency is inconsistent.');
    checkedHash(opening.source); C.integer(opening.amountMinor); seen.add(opening.accountId);
    if (opening.source.evidenceHash!==opening.evidenceHash || opening.amountMinor!==opening.crossCheck.derivedOpeningMinor ||
      C.sum([opening.amountMinor,opening.crossCheck.retainedMovementMinor])!==opening.crossCheck.anchorMinor) throw new TypeError('Opening evidence arithmetic is inconsistent.');
  }
  const periods=new Set();
  for (const balance of evidence.periodBookBalances) {
    const key=balance.accountId+':'+balance.period;
    if (!seen.has(balance.accountId) || accounts.get(balance.accountId).currency!==balance.accountCurrency || periods.has(key)) throw new TypeError('Period balance evidence account/currency is inconsistent.');
    C.integer(balance.bookClosingMinor); monthEnd(balance.period); periods.add(key);
  }
  return evidence;
}
module.exports={buildBankStatementEvidence,validateBankStatementEvidence};
