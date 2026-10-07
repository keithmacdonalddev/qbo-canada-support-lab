'use strict';
const { createBusinessBaselineStore } = require('./business-baseline');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessReportReader } = require('./business-report-evidence');
const { createBusinessInventoryReader } = require('./business-record-inventory');
const { createBusinessInventoryReviewReader } = require('./business-inventory-review');
const { createBusinessStorageReadiness } = require('./business-runtime-storage');
const { createBusinessTransaction } = require('./business-transaction');
const { createContextService } = require('./rebuild-context');
const { scoped } = require('./qbo-write-contract');
const { hash, date } = require('./business-calendar');
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_BASELINE_UNVERIFIED' }); }
// Lazy default composition: importing routes does not prepare storage or run reads.
function createBusinessBaselineService(dependencies = {}) {
  const connection = dependencies.connection || require('mongoose').connection;
  const models = dependencies.models || Object.fromEntries(Object.entries({ Users: 'User', Connections: 'Connection', Memberships: 'CompanyMembership', Audits: 'AuditLog', Versions: 'BlueprintVersion', Baselines: 'BusinessBaseline' }).map(([key, name]) => [key, require('../models/' + name)]));
  const resolveContext = dependencies.resolveContext || createContextService().resolve;
  const assertReady = dependencies.assertReady || createBusinessStorageReadiness({ connection, models });
  const transaction = dependencies.transaction || createBusinessTransaction(connection);
  const accessFor = dependencies.accessFor || createBusinessRuntimeAccess;
  async function bind(user) {
    const actorId = String(user.actorId || user.id), ownerId = String(user.id);
    const context = await resolveContext(user);
    if (!context.connection?.connected) fail('Connect a company before reading baseline observations.');
    const scope = scoped({ environment: context.environment, realmId: context.connection.realmId, connectionId: context.connection.connectionId });
    const access = accessFor({ actorId, ownerId, ...models });
    const readReports = dependencies.readReports || createBusinessReportReader({ access, purpose: 'baseline', ...(dependencies.now ? { now: dependencies.now } : {}) });
    const readInventory = dependencies.readInventory || createBusinessInventoryReader({ access, ...(dependencies.now ? { now: dependencies.now } : {}) });
    const assertCaptureReady = dependencies.assertCaptureReady || (async ({ session } = {}) => {
      try { await require('./business-storage-setup').assertBaselineSetupCompleted(connection.db, { ...scope, ownerId }, session); }
      catch { throw Object.assign(new Error('Complete the reviewed baseline observation storage setup before capturing reports.'), { code: 'BUSINESS_STORAGE_UNPREPARED', status: 409 }); }
    });
    const store = createBusinessBaselineStore({ scope, actorId, ownerId, ...models, access, assertReady, assertCaptureReady, transaction, readReports, readInventory, ...(dependencies.now ? { now: dependencies.now } : {}) });
    const readOrigin = dependencies.readOrigin || (input => require('./record-origin').readRecordOrigin({ ...input, db: connection.db, userId: new (require('mongoose').Types.ObjectId)(input.userId) }));
    const reviewRecord = dependencies.reviewRecord || ((captured, options) => createBusinessInventoryReviewReader({ access, readOrigin, ...(dependencies.now ? { now: dependencies.now } : {}) })(captured, options));
    return { scope, access, store, assertCaptureReady, reviewRecord };
  }
  async function list(user, input) {
    const { scope, access, store, assertCaptureReady } = await bind(user);
    const result = await store.list(input);
    const saved = await models.Versions.findOne({ ...scope, contractVersion: 2, status: 'draft' }).sort({ version: -1 }).maxTimeMS(3000).lean();
    let blueprint = null;
    if (saved) {
      if (hash(saved.definition) !== saved.contentHash || !saved.auditId) fail('The current saved business plan needs review.');
      try { date(saved.definition.calendar.openingDate); } catch { fail('The business opening date needs review.'); }
      blueprint = { id: String(saved._id), contentHash: saved.contentHash, openingDate: saved.definition.calendar.openingDate, version: saved.version };
    }
    let canCapture = false, captureBlockReason = null;
    try { await access.authorize(scope, 'baseline.capture'); await assertCaptureReady(); canCapture = !!blueprint; } catch (error) { if (error.code === 'BUSINESS_STORAGE_UNPREPARED' && error.status === 409) captureBlockReason = error.message; else if (error.code !== 'BUSINESS_ACCESS_DENIED' || error.status !== 403) throw error; }
    await access.authorize(scope, 'baseline.read');
    return { ...result, blueprint, canCapture, captureBlockReason };
  }
  async function review(user, id, entity, recordId, options) {
    const bound = await bind(user);
    const captured = await bound.store.inventoryRecord(id, entity, recordId, options);
    return bound.reviewRecord(captured, options);
  }
  return { list, review, inventory: async (user, id, input, options) => (await bind(user)).store.inventoryPage(id, input, options), capture: async (user, input, options) => (await bind(user)).store.capture(input, options), inspect: async (user, id) => (await bind(user)).store.inspect(id) };
}
module.exports = { createBusinessBaselineService };
