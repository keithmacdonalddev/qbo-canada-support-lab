'use strict';

// Only a positively identified model-service timeout may resume a case.
// QBO timeouts, authorization errors and arbitrary HTTP 504s are not resumable.
function providerTimeout(provider, timeoutMs) {
  return Object.assign(new Error(provider + ' did not finish within ' + Math.round(timeoutMs / 1000) + ' seconds.'), {
    aiProvider: true, code: 'AI_PROVIDER_TIMEOUT', status: 504,
  });
}
function isProviderTimeout(error) {
  return error?.aiProvider === true && error?.code === 'AI_PROVIDER_TIMEOUT';
}
module.exports = { providerTimeout, isProviderTimeout };
