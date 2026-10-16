'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { businessDate } = require('./business-activity-preview');
const { exact, text } = require('./report-evidence-contract');
const KIND = 'accounting-period-decision-v1', ACTION = 'Accounting period decision retained';
const MAX_DECISION_BYTES = 512000;
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/, QID = /^\d{1,30}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CHECKLIST = Object.freeze(['opening', 'transactions', 'taxes', 'exceptions']);
const same = (a, b) => canonical(a) === canonical(b);
function fail(message, status = 409) { throw Object.assign(Error(message), { status, code: 'PERIOD_CLOSE_REQUIRED' }); }
function bounded(value, limit = MAX_DECISION_BYTES) {
  let source;
  try { source = canonical(value); } catch { fail('Use a plain bounded accounting-period request.', 400); }
  if (typeof source !== 'string' || Buffer.byteLength(source) > limit) fail('Accounting-period evidence exceeds its retained size budget.', 400);
  return value;
}
function cents(value, signed = true) {
  if (typeof value !== 'string' || !(signed ? /^-?(0|[1-9]\d{0,11})(\.\d{1,2})?$/ : /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/).test(value)) fail('Use exact amounts with up to two decimal places.', 400);
  const negative = value.startsWith('-'), parts = value.replace('-', '').split('.');
  const result = BigInt(parts[0]) * 100n + BigInt((parts[1] || '').padEnd(2, '0'));
  const signedValue = negative ? -result : result;
  if (signedValue > 100000000000000n || signedValue < -100000000000000n) fail('The amount exceeds exact-cent capacity.', 400);
  return Number(signedValue);
}
function sum(values) {
  return values.reduce((total, value) => {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) fail('The reconciliation exceeds exact-cent capacity.');
    return total + value;
  }, 0);
}
function period(value, now) {
  try { date(value?.fromDate); date(value?.throughDate); } catch { fail('Choose valid statement and report dates.', 400); }
  if (!exact(value, ['fromDate', 'throughDate']) || value.fromDate > value.throughDate || value.throughDate > businessDate(new Date(now)) || date(value.throughDate) - date(value.fromDate) > 366 * 86400000) fail('Choose an elapsed accounting period of at most one year.', 400);
}
function validateRequest(input, scope, now) {
  bounded(input, 96000);
  if (!input || !UUID.test(input.requestKey || '') || input.version !== 1 || input.scopeHash !== hash(scope) || !text(input.reason, 30, 2000)) fail('Use the exact company decision and a concrete reason of at least thirty characters.', 400);
  if (input.mode === 'reopen') {
    if (!exact(input, ['version','requestKey','scopeHash','mode','previousControlHash','closedThrough','reconciledThrough','reason','evidenceReference','correctionPlan','confirmReopen']) || !HASH.test(input.previousControlHash || '') || !text(input.evidenceReference, 3, 1000) || !text(input.correctionPlan, 30, 2000) || input.confirmReopen !== true) fail('Review both original app cutoffs and explain the reopening and correction plan.', 400);
    for (const key of ['closedThrough', 'reconciledThrough']) if (input[key] !== null) {
      try { date(input[key]); } catch { fail('Use a valid replacement app cutoff or no cutoff.', 400); }
      if (input[key] > businessDate(new Date(now))) fail('App protection dates must be elapsed.', 400);
    }
    return input;
  }
  if (!['record','close'].includes(input.mode) || !exact(input, ['version','requestKey','scopeHash','mode','period','accountInventoryHash','bankChecks','reportChecks','checklist','advanceReconciled','reason','confirmManual']) || !HASH.test(input.accountInventoryHash || '') || input.confirmManual !== true || typeof input.advanceReconciled !== 'boolean' || (input.mode === 'record' && input.advanceReconciled)) fail('Review the exact manual evidence and its intended effect on app protection.', 400);
  period(input.period, now);
  if (!Array.isArray(input.bankChecks) || input.bankChecks.length > 64 || new Set(input.bankChecks.map(row => row?.accountId)).size !== input.bankChecks.length) fail('Each current bank or card account needs its own unique entry.', 400);
  let itemCount = 0;
  for (const row of input.bankChecks) {
    if (!exact(row, ['accountId','status','statementBalance','bookBalance','statementReference','bookReference','observedOn','items','note','confirmMatched','confirmPosted']) || !QID.test(row.accountId || '') || !['checked','excluded','not-checked'].includes(row.status) || !text(row.note, row.status === 'not-checked' ? 0 : 20, 1000) || typeof row.confirmMatched !== 'boolean' || typeof row.confirmPosted !== 'boolean' || !Array.isArray(row.items) || row.items.length > 128) fail('Use a complete, separately explained account observation.', 400);
    for (const key of ['statementBalance','bookBalance','statementReference','bookReference','observedOn']) if (typeof row[key] !== 'string') fail('Bank evidence fields must be explicit text.', 400);
    if (row.status === 'checked') {
      cents(row.statementBalance); cents(row.bookBalance);
      if (!text(row.statementReference, 3, 1000) || !text(row.bookReference, 3, 1000)) fail('Keep both the statement and dated book-balance source references.', 400);
      try { date(row.observedOn); } catch { fail('Keep a valid account observation date.', 400); }
      if (row.observedOn < input.period.throughDate || row.observedOn > businessDate(new Date(now))) fail('Account evidence must be observed on or after this period and no later than today.', 400);
    } else if (row.items.length || row.statementBalance || row.bookBalance || row.confirmMatched || row.confirmPosted) fail('Unchecked or excluded accounts cannot carry a reconciliation result.', 400);
    for (const item of row.items) {
      itemCount++;
      if (!exact(item, ['kind','date','reference','amount']) || !['receipt','payment'].includes(item.kind) || !text(item.reference, 3, 300) || cents(item.amount, false) <= 0) fail('Each outstanding item needs its actual positive amount and source reference.', 400);
      try { date(item.date); } catch { fail('Keep a valid outstanding-item date.', 400); }
      if (item.date > input.period.throughDate) fail('An outstanding item cannot post after the statement ending date.', 400);
    }
  }
  if (itemCount > 128 || !Array.isArray(input.reportChecks) || input.reportChecks.length > 48 || new Set(input.reportChecks.map(row => row?.key)).size !== input.reportChecks.length || input.reportChecks.some(row => !exact(row, ['key','id','evidenceHash']) || typeof row.key !== 'string' || !/^report\.[a-z0-9-]{1,100}$/.test(row.key) || !ID.test(row.id || '') || !HASH.test(row.evidenceHash || ''))) fail('Use unique retained report sources and bounded itemized evidence.', 400);
  if (!exact(input.checklist, CHECKLIST) || CHECKLIST.some(key => !text(input.checklist[key], input.mode === 'close' ? 20 : 0, 1000))) fail('Explain opening balances, posting completeness, taxes and remaining exceptions.', 400);
  if (input.mode === 'record' && !input.bankChecks.some(row => row.status !== 'not-checked') && !input.reportChecks.length) fail('Record at least one actual observation or explicit exclusion.', 400);
  return input;
}
function bankResults(input, accounts) {
  if (!same(input.bankChecks.map(row => row.accountId).sort(), accounts.map(row => row.id).sort())) fail('Review every account from the complete current bank/card inventory.');
  return accounts.map(account => {
    const row = input.bankChecks.find(value => value.accountId === account.id), card = account.type === 'Credit Card';
    if (row.status !== 'checked') return { accountId: account.id, name: account.name, currency: account.currency, type: account.type, status: row.status, differenceCents: null, orientation: card ? 'positive-amount-owed' : 'positive-bank-asset' };
    const receipts = sum(row.items.filter(item => item.kind === 'receipt').map(item => cents(item.amount, false)));
    const payments = sum(row.items.filter(item => item.kind === 'payment').map(item => cents(item.amount, false)));
    const statementCents = cents(row.statementBalance), bookCents = cents(row.bookBalance);
    const expectedCents = sum([statementCents, receipts, -payments]), differenceCents = sum([bookCents, -expectedCents]);
    return { accountId: account.id, name: account.name, currency: account.currency, type: account.type, status: account.currency !== 'CAD' ? 'unsupported-currency' : !row.confirmMatched || !row.confirmPosted ? 'incomplete' : differenceCents === 0 ? 'passed' : 'failed', orientation: card ? 'positive-amount-owed' : 'positive-bank-asset', statementCents, bookCents, outstandingIncreaseCents: receipts, outstandingDecreaseCents: payments, expectedCents, differenceCents };
  });
}
function decisionId(scope, ownerId, key) { return hash({ kind: KIND, scope, ownerId, key: key.toLowerCase() }).slice(0,24); }
function validateDecisionEnvelope(row, scope, ownerId) {
  const a = row?.afterState, p = a?.payload;
  if (!row || String(row.userId) !== ownerId || row.realmId !== scope.realmId || (row.actorUserId != null && String(row.actorUserId) !== ownerId) || row.action !== ACTION || row.actionType !== 'manual' || row.outcome !== 'success' || row.aiDriven !== false || row.approvalEvent !== 'owner-accounting-period-decision' || !exact(a, ['kind','decisionHash','payload']) || a.kind !== KIND || !p || p.version !== 1 || p.kind !== KIND || !same(p.scope, scope) || p.ownerId !== ownerId || a.decisionHash !== hash(p) || !['applied','cancelled'].includes(p.status) || !exact(p.input, ['request','reviewHash']) || !HASH.test(p.input.reviewHash || '') || p.requestHash !== hash(p.input) || String(row._id) !== decisionId(scope, ownerId, p.input.request.requestKey) || new Date(row.createdAt).toISOString() !== p.recordedAt) fail('The retained accounting-period decision changed or is unavailable.');
  if (!exact(p, ['version','kind','scope','ownerId','requestHash','input','status','recordedAt','review','observations','resultingControl','cancellationReason']) || typeof p.recordedAt !== 'string' || !Number.isFinite(Date.parse(p.recordedAt)) || new Date(p.recordedAt).toISOString() !== p.recordedAt) fail('The retained accounting-period envelope changed.');
  bounded(a); validateRequest(p.input.request, scope, Date.parse(p.recordedAt));
  if (p.status === 'applied' && (!p.review || hash(p.review) !== p.input.reviewHash || !p.observations || !same(p.review.scope, scope))) fail('The original accounting-period review is unavailable.');
  if (p.status === 'cancelled' && (!text(p.cancellationReason, 20, 2000) || p.review !== null || p.observations !== null || p.resultingControl !== null)) fail('The original accounting-period cancellation is unavailable.');
  return p;
}
function isPeriodEvent(row) { return row?.action === ACTION || row?.afterState?.kind === KIND; }
module.exports = { KIND, ACTION, MAX_DECISION_BYTES, HASH, ID, QID, CHECKLIST, same, exact, text, fail, bounded, cents, sum, period, validateRequest, bankResults, decisionId, validateDecisionEnvelope, isPeriodEvent };
