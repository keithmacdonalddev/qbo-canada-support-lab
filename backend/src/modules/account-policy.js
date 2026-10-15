'use strict';
const RESERVED_EMAIL = 'tester@testdatalab.local';
const PUBLIC_TESTER_PASSWORD = 'test-data-lab';
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isReservedAccount = account => normalizeEmail(account?.email) === RESERVED_EMAIL;
function accountVersion(account) {
  const version = account?.authVersion ?? 0;
  if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER) return null;
  return version;
}
function accountEligible(account, { automation = false } = {}) {
  return Boolean(account && ['agent','supervisor'].includes(account.role) && accountVersion(account) !== null && (!isReservedAccount(account) || (account.accessPolicyVersion === 1 && accountVersion(account) >= 1 && (!automation || account.automationAccessPolicyVersion === 1))));
}
function assertAccountEligible(account, options) {
  if (options?.automation && accountEligible(account) && !accountEligible(account,options)) throw Object.assign(new Error('Retained automation is paused after private credential recovery. Review the saved work in account access settings before enabling it.'), { status:403, code:'ACCOUNT_AUTOMATION_REVIEW_REQUIRED' });
  if (!accountEligible(account, options)) throw Object.assign(new Error('This account is unavailable or needs private credential recovery. Queued work is retained.'), { status:403, code:'ACCOUNT_ACCESS_RECOVERY_REQUIRED' });
  return account;
}
function publicTesterAttempt(email,password) {
  return normalizeEmail(email) === RESERVED_EMAIL && password === PUBLIC_TESTER_PASSWORD;
}
module.exports = { RESERVED_EMAIL, normalizeEmail, isReservedAccount, accountVersion, accountEligible, assertAccountEligible, publicTesterAttempt };
