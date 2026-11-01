'use strict';
const crypto = require('node:crypto');

// Plain JSON contract shared by feed generation, statements and native UI evidence.
// buildSettlementEvents accepts a scoped mirror and retained account-native rows.
// Resolved means financial meaning is established, not that a native QBO action
// succeeded. resolution.nativeActionBlockers gates existing R-marked records.
// Amounts are signed integer hundredths. Positive amountMinor means money entering
// a bank, or a payment/credit reducing card debt. Card bookAmountMinor has the
// opposite sign. No generated event attests upload, matching or reconciliation.
const CONTRACT_VERSION = 1;
const POLICY_VERSION = 'bank-settlement-v1';
const SETTLEMENT_CONTRACT = Object.freeze({
  version: CONTRACT_VERSION,
  kind: 'bank-settlement-dataset',
  amountScale: 2,
  eventFields: ['eventId','scope','status','accountId','accountCurrency','amountMinor',
    'bookAmountMinor','cardDebtChangeMinor','direction','settlementGroupId',
    'pairedEventId','bookDate','expectedPostingDate','actualPostingDate',
    'statementPeriod','source','resolution','policyVersion','revision',
    'supersededBy','generatedFileReferences'],
  resolutions: ['Match','Add','Exclude','investigate'],
  statuses: ['resolved','unresolved'],
  evidenceTypes: ['bank-or-card-statement','cash-count-or-cashbook'],
});
function fail(message) { throw new TypeError(message); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function hash(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function validateScope(value) {
  if (!value || !['production','sandbox'].includes(value.environment) ||
      !['realmId','connectionId'].every(k => typeof value[k] === 'string' && value[k].length > 0)) fail('A complete company scope is required.');
  return { environment: value.environment, realmId: value.realmId, connectionId: value.connectionId };
}
function assertScope(actual, expected) {
  if (canonical(validateScope(actual)) !== canonical(expected)) fail('Settlement evidence belongs to a different company scope.');
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) fail('A valid YYYY-MM-DD date is required.');
  return value;
}
function minor(value) {
  // No floating point multiplication or implicit rounding of financial values.
  if (!['string','number'].includes(typeof value)) fail('An exact decimal amount is required.');
  const text = String(value), match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) fail('An exact amount with at most two decimal places is required.');
  const result = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2,'0'));
  const signed = (match[1] ? -1n : 1n) * result;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) fail('Amount exceeds the safe integer range.');
  return Number(signed);
}
function integer(value) { if (!Number.isSafeInteger(value)) fail('A safe integer minor-unit amount is required.'); return value; }
function sum(values) { return values.reduce((total, value) => integer(total + integer(value)), 0); }
function stableEventId(scope, entity, id, accountId, leg = 'net') {
  return 'bse1_' + hash({ scope: validateScope(scope), entity, id, accountId, leg }).slice(0,40);
}
function validateEvent(event) {
  validateScope(event.scope);
  if (!event.eventId || !event.accountId || !(event.accountCurrency === null && event.status === 'unresolved' || /^[A-Z]{3}$/.test(event.accountCurrency || '')) ||
      !['resolved','unresolved'].includes(event.status) || !Number.isInteger(event.revision) || event.revision < 1) fail('Invalid settlement event.');
  if (event.amountMinor !== null) integer(event.amountMinor);
  if (event.bookAmountMinor !== null) integer(event.bookAmountMinor);
  if (event.status === 'resolved' && (event.amountMinor === null || event.amountMinor === 0 || !['Match','Add','Exclude'].includes(event.resolution.action))) fail('Resolved settlements require nonzero native money and an explicit banking action.');
  if (event.status === 'unresolved' && (event.resolution.action !== 'investigate' || !event.resolution.reason?.code)) fail('Unresolved settlements require an exact reason.');
  if (event.amountMinor !== null && event.bookAmountMinor !== null) {
    const expected = event.cardDebtChangeMinor === null ? event.amountMinor : -event.amountMinor;
    if (event.bookAmountMinor !== expected || (event.cardDebtChangeMinor !== null && event.cardDebtChangeMinor !== expected)) fail('Settlement import and card debt signs disagree.');
  }
  return event;
}
module.exports = { CONTRACT_VERSION, POLICY_VERSION, SETTLEMENT_CONTRACT, canonical, hash,
  validateScope, assertScope, date, minor, integer, sum, stableEventId, validateEvent };
