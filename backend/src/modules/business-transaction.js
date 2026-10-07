'use strict';
// Uses the installed MongoDB driver's transaction API. No fallback to independent writes.
// Caller must verify deployment transaction/index readiness before enabling operations.
function createBusinessTransaction(connection) {
  if (!connection || typeof connection.startSession !== 'function') throw new TypeError('A transaction-capable MongoDB connection is required');
  return async work => {
    const session = await connection.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await work(session); }, {
        readPreference: 'primary', readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000, timeoutMS: 15000,
      });
      return result;
    } finally { await session.endSession(); }
  };
}
module.exports = { createBusinessTransaction };
