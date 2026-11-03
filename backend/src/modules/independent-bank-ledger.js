'use strict';
// BANK-2.1: explicit, immutable adoption. No QBO client, clocks, startup or sync.
const C = require('./bank-settlement-contract');
const copy = value => JSON.parse(JSON.stringify(value));
function requireLedger(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { status: 409, code: 'BANKING_LEDGER_INVALID' });
}
function nextMonth(period) {
  const d = new Date(period + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7);
}
function eventMovement(event, convention) {
  C.integer(event.amountMinor);
  requireLedger(['pending', 'posted', 'reversed'].includes(event.state), 'Unknown independent bank event state.');
  requireLedger(event.stateHistory?.length > 0 && event.stateHistory.at(-1)?.state === event.state,
    'Bank event state needs retained history.');
  const states = event.stateHistory.map(item => item.state).join(',');
  requireLedger((event.baseline === true ? ['posted','posted,reversed'] : ['pending', 'pending,posted', 'pending,reversed', 'pending,posted,reversed']).includes(states), 'Invalid bank event state history.');
  for (const item of event.stateHistory) { C.date(item.date); requireLedger(Boolean(item.evidenceRef), 'State evidence is required.'); }
  requireLedger(event.stateHistory.every((item, i, rows) => !i || item.date >= rows[i - 1].date), 'Bank state dates are out of order.');
  // Reversed retains its original amount and posting history, with net zero effect.
  // This contract does not execute reversals or generate counterpart instructions.
  return event.state === 'posted' && event.disposition !== 'excluded' ? C.integer(event.amountMinor * (convention === 'card-amount-owed' ? -1 : 1)) : 0;
}
function balances(ledger) {
  const ids = new Set();
  const movements = ledger.events.map(event => {
    requireLedger(!ids.has(event.eventId), 'Duplicate independent event identity.'); ids.add(event.eventId);
    requireLedger(event.accountId === ledger.account.accountId && event.accountCurrency === ledger.account.accountCurrency, 'Independent event crosses account/currency.');
    return eventMovement(event, ledger.account.balanceConvention);
  });
  const movementMinor = C.sum(movements);
  return { openingMinor: C.integer(ledger.openingMinor), movementMinor,
    balanceMinor: C.sum([ledger.openingMinor, movementMinor]),
    pendingCount: ledger.events.filter(e => e.state === 'pending').length,
    pendingNativeMinor: C.sum(ledger.events.filter(e => e.state === 'pending' && e.disposition !== 'excluded').map(e => e.amountMinor)),
    postedCount: ledger.events.filter(e => e.state === 'posted' && e.disposition !== 'excluded').length,
    reversedCount: ledger.events.filter(e => e.state === 'reversed').length };
}
// Native workflow inspection does not invalidate otherwise proved financial history.
// Every other blocker, including unknown future codes, prevents adoption.
const NATIVE_INSPECTION_CODES = new Set(['existing-reconciled-mark-requires-native-inspection', 'report-only-adjustment-requires-native-inspection']);
function validateFinancialEvidence(snapshot, manifest) {
  requireLedger(Array.isArray(snapshot.blockers) && Array.isArray(manifest.blockers) && Array.isArray(manifest.unresolvedEvents) && manifest.unresolvedEvents.length === 0,
    'Financial evidence is missing or contains unresolved events.');
  requireLedger(snapshot.events.every(event => event.status === 'resolved' && ['match','add','exclude'].includes(event.expectedResolution)),
    'Financial evidence contains unresolved settlement events.');
  const nativeOnly = new Set(snapshot.events.flatMap(event => {
    const codes = event.resolution?.nativeActionBlockers === undefined ? [] : event.resolution.nativeActionBlockers;
    requireLedger(Array.isArray(codes) && codes.every(code => NATIVE_INSPECTION_CODES.has(code)),
      'Unknown or invalid event-level evidence blockers prevent adoption.');
    return codes.map(code => event.eventId + ': ' + code);
  }));
  const blockers = [...new Set([...snapshot.blockers,...manifest.blockers,...nativeOnly])];
  requireLedger(blockers.every(blocker => typeof blocker === 'string' && nativeOnly.has(blocker)),
    'Unresolved financial-evidence blockers prevent independent bank adoption.');
  requireLedger(Array.isArray(snapshot.outstandingItems) && Array.isArray(manifest.outstandingItems) &&
    C.canonical(snapshot.outstandingItems) === C.canonical(manifest.outstandingItems), 'Outstanding financial evidence differs from its retained statement.');
  const outstandingIds = new Set();
  const outstanding = snapshot.outstandingItems.map(item => {
    requireLedger(typeof item.eventId === 'string' && item.eventId.length > 0 && !outstandingIds.has(item.eventId) && !snapshot.events.some(event => event.eventId === item.eventId), 'Outstanding movement identity is missing, duplicated or already settled.');
    outstandingIds.add(item.eventId);
    requireLedger(item.accountId === snapshot.accountId && item.currency === snapshot.accountCurrency && Number.isSafeInteger(item.amountMinor),
      'Outstanding evidence needs exact account-native currency movements.');
    C.date(item.bookDate); C.date(item.expectedPostingDate);
    requireLedger(item.bookDate.slice(0,7) <= snapshot.period && item.expectedPostingDate.slice(0,7) > snapshot.period,
      'Outstanding movement is outside its statement cutoff.');
    return C.integer(item.amountMinor * (snapshot.balanceConvention === 'card-amount-owed' ? -1 : 1));
  });
  const comparison = manifest.balanceCheck;
  requireLedger(comparison && /^[a-f0-9]{64}$/.test(comparison.evidenceHash || '') &&
    ['bookClosingMinor','reconstructedBookClosingMinor','differenceMinor'].every(key => Number.isSafeInteger(comparison[key])),
    'Retained native book-to-statement comparison is required.');
  const reconstructed = C.sum([snapshot.closingMinor,...outstanding]);
  requireLedger(comparison.differenceMinor === 0 && comparison.reconstructedBookClosingMinor === reconstructed && comparison.bookClosingMinor === reconstructed,
    'Retained native book balance does not equal settled balance plus outstanding movements.');
  return { balanceCheck:copy(comparison), nativeWorkBlockers:blockers.sort() };
}
function buildLedgerBaseline({ scope, account, packages, manifests }) {
  C.validateScope(scope);
  requireLedger(packages.length > 0 && packages.length === manifests.length && packages.length <= 2000, 'Exact baseline packages and manifests are required.');
  const ordered = packages.map((pkg, i) => ({ pkg, manifest: manifests[i] })).sort((a,b) => a.pkg.period.localeCompare(b.pkg.period));
  const first = ordered[0].pkg, evidence = ordered[0].manifest.openingEvidence;
  const type = account.AccountType || account.type, currency = account.CurrencyRef?.value || account.currency;
  requireLedger(String(account.Id || account.id) === first.accountId && ['Bank','Credit Card'].includes(type) && currency === first.accountCurrency, 'Baseline account mapping is inconsistent.');
  requireLedger(evidence?.evidenceRef && /^[a-f0-9]{64}$/.test(evidence.evidenceHash || '') && evidence.basis && Number.isSafeInteger(evidence.amountMinor), 'An evidenced opening anchor is required.');
  // Freeze the first retained statement opening. Preserve its original anchor;
  // a carried boundary does not fabricate missing earlier event history.
  requireLedger(/^\d{4}-(0[1-9]|1[0-2])$/.test(evidence.period || '') && evidence.period <= first.period, 'Original opening evidence must precede the bounded baseline.');
  requireLedger(evidence.period !== first.period || evidence.amountMinor === first.snapshot.openingMinor, 'Original opening amount disagrees with its statement.');
  // Original anchor proof is mandatory for both same-month and carried openings.
  const source = evidence.source, crossCheck = evidence.crossCheck;
  requireLedger(evidence.accountId === first.accountId && evidence.accountCurrency === currency &&
    source?.accountId === first.accountId && source?.currency === currency && source.sourceRef === evidence.evidenceRef &&
    source.evidenceHash === evidence.evidenceHash && C.hash((({evidenceHash,...body})=>body)(source)) === evidence.evidenceHash,
    'Opening source identity or content hash is invalid.');
  requireLedger(Number.isSafeInteger(source.storedNativeBookBalanceMinor) &&
    ['anchorMinor','retainedMovementMinor','derivedOpeningMinor'].every(key => Number.isSafeInteger(crossCheck?.[key])),
    'Opening arithmetic requires exact native minor units.');
  requireLedger(crossCheck.derivedOpeningMinor === evidence.amountMinor &&
    crossCheck.anchorMinor === source.storedNativeBookBalanceMinor &&
    C.sum([evidence.amountMinor,crossCheck.retainedMovementMinor]) === crossCheck.anchorMinor,
    'Opening arithmetic contradicts the retained original anchor.');
  const convention = type === 'Credit Card' ? 'card-amount-owed' : 'bank-balance';
  const result = { version: 1, scope: copy(scope), ledgerId: 'bank-ledger-' + C.hash({scope, accountId:first.accountId}),
    basis: 'Historical QBO reconstruction baseline; frozen on explicit adoption, not independent bank confirmation.',
    account: { accountId: first.accountId, accountCurrency: currency, accountType: type, accountName: account.Name || account.name || first.accountId, balanceConvention: convention },
    openingMinor: first.snapshot.openingMinor, openingPeriod: first.period, openingEvidence: { ...copy(evidence), acceptedOpening: { period:first.period, amountMinor:first.snapshot.openingMinor, packageId:first._id, manifestSha256:first.snapshot.files.find(f=>f.kind === 'manifest')?.sha256, basis:evidence.period === first.period ? 'Original evidenced opening' : 'Bounded carried opening from the hash-checked retained statement; earlier activity is not adopted.' } },
    throughPeriod: ordered.at(-1).pkg.period, packages: [], events: [] };
  let previous;
  for (const {pkg, manifest} of ordered) {
    C.assertScope({environment:pkg.environment, realmId:pkg.realmId, connectionId:String(pkg.connectionId)},scope);
    C.assertScope(pkg.snapshot.scope,scope);
    requireLedger(pkg.accountId === first.accountId && pkg.accountCurrency === currency && pkg.snapshot.balanceConvention === convention, 'Baseline package crosses account/currency/convention.');
    requireLedger(!pkg.state.supersededBy && !pkg.state.needsReview, 'Baseline package has unresolved revision review.');
    const financialEvidence = validateFinancialEvidence(pkg.snapshot,manifest);
    requireLedger(!previous || nextMonth(previous.period) === pkg.period && previous.snapshot.closingMinor === pkg.snapshot.openingMinor, 'Baseline needs contiguous evidenced carry-forward.');
    requireLedger(manifest.openingMinor === pkg.snapshot.openingMinor && manifest.closingMinor === pkg.snapshot.closingMinor, 'Manifest balance does not agree with retained package.');
    requireLedger(pkg.snapshot.rows.length === pkg.snapshot.events.length, 'Baseline event crosswalk is incomplete.');
    let movement = 0;
    for (const spec of pkg.snapshot.rows) {
      const event = pkg.snapshot.events.find(e => e.eventId === spec.eventId && e.revision === spec.eventRevision);
      requireLedger(event && event.accountId === first.accountId && event.accountCurrency === currency, 'Baseline event lineage is inconsistent.');
      if (event.scope) C.assertScope(event.scope,scope);
      const postingDate = C.date(event.actualPostingDate || event.expectedPostingDate);
      requireLedger(postingDate.slice(0,7) === pkg.period, 'Baseline posting is outside its statement.');
      const accepted = { eventId:event.eventId, eventRevision:event.revision, accountId:event.accountId, accountCurrency:currency,
        amountMinor:C.integer(event.amountMinor), state:'posted', disposition:event.expectedResolution === 'exclude' ? 'excluded' : 'included',
        stateHistory:[{state:'posted', date:postingDate, evidenceRef:pkg._id}],
        postingDate, postingBasis:event.postingBasis || 'simulated-policy', baseline:true,
        packageId:pkg._id, packageContentHash:pkg.contentHash, row:copy(spec), source:copy(event.source || {}),
        sourceHash:event.sourceHash || event.source?.sourceHash, description:require('./bank-feed-csv').description(event) };
      movement = C.sum([movement,eventMovement(accepted, convention)]); result.events.push(accepted);
    }
    requireLedger(C.sum([pkg.snapshot.openingMinor,movement]) === pkg.snapshot.closingMinor, 'Baseline movements do not equal retained closing.');
    result.packages.push({ id:pkg._id, contentHash:pkg.contentHash, stateVersion:pkg.stateVersion, period:pkg.period, revision:pkg.revision,
      openingMinor:pkg.snapshot.openingMinor, closingMinor:pkg.snapshot.closingMinor, financialEvidence, files:copy(pkg.snapshot.files), openingEvidence:copy(manifest.openingEvidence) });
    previous = pkg;
  }
  requireLedger(result.events.length <= 10000, 'Baseline exceeds bounded ledger capacity.');
  result.balance = balances(result);
  requireLedger(result.balance.balanceMinor === previous.snapshot.closingMinor, 'Independent balance does not tie to the accepted baseline.');
  result.contentHash = C.hash(result);
  requireLedger(Buffer.byteLength(JSON.stringify(result)) <= 12000000, 'Baseline exceeds safe persisted size.');
  return result;
}
function verifyLedger(ledger) {
  const { contentHash, adoption, ...content } = ledger;
  requireLedger(C.hash(content) === contentHash, 'Independent ledger content hash changed.');
  requireLedger(C.canonical(balances(ledger)) === C.canonical(ledger.balance), 'Independent ledger balance changed.');
  return ledger;
}
module.exports = { buildLedgerBaseline, balances, eventMovement, verifyLedger, validateFinancialEvidence };
