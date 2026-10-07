'use strict';
const { canonical } = require('./business-calendar');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_STORAGE_UNPREPARED' }); }
// Inspection only. No createCollection, syncIndexes, migration or server startup.
function createBusinessStorageReadiness({ connection, models, now = () => Date.now() }) {
  if (!connection || !models || typeof now !== 'function') throw new TypeError('Business storage needs explicit connection and models');
  let verifiedAt = null, verifiedDatabase = null, pending = null;
  async function inspect() {
    if (connection.readyState !== 1 || !connection.db) fail('Business operation storage is unavailable.');
    const db = connection.db, names = Object.values(models).map(model => model.collection.name);
    if (new Set(names).size !== names.length) fail('Business storage model mapping is ambiguous.');
    const collections = await db.listCollections({ name: { $in: names } }, { nameOnly: false, maxTimeMS: 5000 }).toArray();
    if (collections.length !== names.length || collections.some(row => row.type !== 'collection' || Object.keys(row.options || {}).length)) fail('Business operation collections need explicit preparation.');
    const hello = await db.admin().command({ hello: 1, maxTimeMS: 5000 });
    if (!hello.setName && hello.msg !== 'isdbgrid') fail('Business operations require transactional storage.');
    for (const model of Object.values(models)) {
      const indexes = await model.collection.indexes({ maxTimeMS: 5000 });
      for (const [key, options] of model.schema.indexes()) {
        if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === Boolean(options.unique) && !index.sparse && !index.hidden && index.expireAfterSeconds == null && canonical(index.partialFilterExpression ?? null) === canonical(options.partialFilterExpression ?? null) && (!index.collation || index.collation.locale === 'simple'))) fail('Business operation index protection is not installed.');
      }
    }
    if (connection.readyState !== 1 || connection.db !== db) fail('Business database changed during readiness inspection.');
    verifiedAt = now(); verifiedDatabase = db;
  }
  return async function assertReady() {
    if (connection.readyState !== 1 || !connection.db) { verifiedAt = null; fail('Business operation storage is unavailable.'); }
    // Only static collection/index inspection is cached, never permissions, lease,
    // active company, writer ownership or execution approval.
    if (verifiedDatabase === connection.db && verifiedAt !== null && now() >= verifiedAt && now() - verifiedAt < 30000) return;
    if (!pending) pending = inspect().finally(() => { pending = null; });
    await pending;
  };
}
module.exports = { createBusinessStorageReadiness };
