'use strict';
// Apply is an explicit local migration only. Read-only setup receipt validation is also used by baseline capture.
const { ObjectId } = require('mongoose').mongo;
const { hash } = require('./business-calendar');
const { ROLE_PERMISSIONS } = require('./rebuild-permissions');
const COLLECTIONS = Object.freeze([
  { name: 'blueprintversions', indexes: [{ name: 'realmId_1_version_1', key: { realmId: 1, version: 1 }, unique: true }, { name: 'realmId_1_status_1', key: { realmId: 1, status: 1 } }] },
  { name: 'blueprintsequences', indexes: [] },
]);
// Static reviewed definitions only: preview never imports/registers app models.
const index = (key, options = {}) => ({ name: Object.entries(key).map(([field, direction]) => field + '_' + direction).join('_'), key, ...options });
const OPERATIONS_COLLECTIONS = Object.freeze([...COLLECTIONS,
  { name: 'companywritepolicies', indexes: [index({ environment: 1, realmId: 1 }, { unique: true })] },
  { name: 'companywriters', indexes: [index({ environment: 1, realmId: 1 }, { unique: true })] },
  { name: 'businesscalendars', indexes: [index({ environment: 1, realmId: 1 }, { unique: true })] },
  { name: 'operationruns', indexes: [index({ environment: 1, realmId: 1, createdAt: -1 }), index({ 'executionRequest.pending': 1, _id: 1 })] },
  { name: 'operationplans', indexes: [index({ environment: 1, realmId: 1, connectionId: 1, operationId: 1 }, { unique: true })] },
  { name: 'operationintents', indexes: [index({ environment: 1, realmId: 1, connectionId: 1, planId: 1, logicalKey: 1 }, { unique: true }), index({ environment: 1, realmId: 1, connectionId: 1, planId: 1, ordinal: 1 }, { unique: true })] },
  { name: 'operationsteps', indexes: [index({ environment: 1, realmId: 1, logicalKey: 1 }, { unique: true }), index({ environment: 1, realmId: 1, entity: 1, qboId: 1 }, { unique: true, partialFilterExpression: { qboId: { $type: 'string' } } }), index({ environment: 1, realmId: 1, operationId: 1, state: 1, logicalKey: 1 }), index({ environment: 1, realmId: 1, 'dependencies.logicalKey': 1, state: 1 })] },
  { name: 'qbowritereceipts', indexes: [index({ environment: 1, realmId: 1, dispatchKey: 1 }, { unique: true }), index({ environment: 1, realmId: 1, state: 1, sentAt: -1 })] },
  { name: 'operationevidences', indexes: [index({ environment: 1, realmId: 1, operationId: 1, evidenceRevision: 1 }, { unique: true })] },
]);
const BASELINE_COLLECTIONS = Object.freeze([...COLLECTIONS, { name: 'businessbaselines', indexes: [index({ environment: 1, realmId: 1, connectionId: 1, ownerId: 1, 'payload.observedAt': -1, _id: -1 })] }]);
const LEGACY_PREREQUISITES = Object.freeze([
  { name: 'users', indexes: [index({ email: 1 }, { unique: true })] },
  { name: 'connections', indexes: [index({ userId: 1, realmId: 1 }, { unique: true })] },
  { name: 'companymemberships', indexes: [index({ userId: 1, realmId: 1 }, { unique: true }), index({ realmId: 1, status: 1 })] },
  { name: 'auditlogs', indexes: [index({ userId: 1, realmId: 1, createdAt: -1 })] },
]);
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
freeze(OPERATIONS_COLLECTIONS); freeze(BASELINE_COLLECTIONS); freeze(LEGACY_PREREQUISITES);
function setupDefinition(profile = 'blueprint') {
  if (!['blueprint', 'business-operations', 'baseline-observations'].includes(profile)) fail('Choose the blueprint, business-operations or baseline-observations setup profile.');
  if (profile === 'baseline-observations') return { version: 3, profile, collections: BASELINE_COLLECTIONS, prerequisites: LEGACY_PREREQUISITES, initialState: 'all-baseline-observations-empty-database-wide' };
  return profile === 'blueprint' ? { version: 1, profile, collections: COLLECTIONS } : { version: 2, profile, collections: OPERATIONS_COLLECTIONS, prerequisites: LEGACY_PREREQUISITES, initialState: 'all-operation-collections-empty-database-wide' };
}
const time = { maxTimeMS: 5000 };
function fail(message) { throw Object.assign(new Error(message), { setupError: true }); }
function validateTarget(target, configuredEnvironment) {
  if (!target || Object.keys(target).sort().join(',') !== 'connectionId,environment,ownerId,realmId') fail('Supply the exact environment, realm, connection and owner IDs.');
  if (!['sandbox', 'production'].includes(target.environment) || target.environment !== configuredEnvironment) fail('The requested environment does not match the local server configuration.');
  if (typeof target.realmId !== 'string' || !/^[0-9]{1,32}$/.test(target.realmId) || ![target.connectionId, target.ownerId].every(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))) fail('Invalid setup target.');
}
function exactIndex(index, desired) {
  return JSON.stringify(index.key) === JSON.stringify(desired.key) && !!index.unique === !!desired.unique && hash(index.partialFilterExpression ?? null) === hash(desired.partialFilterExpression ?? null) && !index.sparse && index.expireAfterSeconds == null && !index.hidden && (!index.collation || index.collation.locale === 'simple');
}
async function deployment(db) {
  const hello = await db.admin().command({ hello: 1, maxTimeMS: 5000 });
  if (!hello.setName || !Array.isArray(hello.hosts) || !hello.hosts.length) fail('This setup requires a verified replica-set database. Other deployments need a separate reviewed migration.');
  return { database: db.databaseName, fingerprint: hash({ database: db.databaseName, replicaSet: hello.setName, hosts: [...hello.hosts].sort() }) };
}
async function source(db, target, session) {
  const options = { ...time, session };
  const owner = await db.collection('users').findOne({ _id: new ObjectId(target.ownerId) }, { ...options, projection: { role: 1, connectionSwitchVersion: 1 } });
  if (!owner || !['agent', 'supervisor'].includes(owner.role)) fail('The selected connection owner no longer has a supported account.');
  const connections = await db.collection('connections').find({ $or: [{ realmId: target.realmId }, { userId: new ObjectId(target.ownerId) }], status: 'active' }, { ...options, projection: { userId: 1, realmId: 1, companyName: 1 } }).limit(3).toArray();
  if (connections.length !== 1 || String(connections[0]._id) !== target.connectionId || String(connections[0].userId) !== target.ownerId || connections[0].realmId !== target.realmId) fail('Active company ownership is ambiguous or changed.');
  const memberships = await db.collection('companymemberships').find({ userId: new ObjectId(target.ownerId), realmId: target.realmId }, { ...options, projection: { role: 1, status: 1, permissionOverrides: 1 } }).limit(2).toArray();
  if (memberships.length > 1) fail('Duplicate owner memberships need review.');
  const membership = memberships[0];
  if (membership && membership.permissionOverrides !== undefined && !Array.isArray(membership.permissionOverrides)) fail('Existing membership permissions need repair.');
  if (membership && (membership.role !== 'lab-owner' || membership.status !== 'active' || (membership.permissionOverrides || []).length)) fail('An existing owner membership needs separate review; this setup never replaces roles.');
  const switchVersion = owner.connectionSwitchVersion ?? 0;
  if (!Number.isSafeInteger(switchVersion) || switchVersion < 0 || switchVersion >= Number.MAX_SAFE_INTEGER) fail('Connection scope version needs repair.');
  return { companyName: connections[0].companyName || null, legacyRole: owner.role, switchVersion,
    membership: membership ? { id: String(membership._id), role: membership.role, status: membership.status, permissionOverrides: [] } : null };
}
async function inspectStorage(db, profile = 'blueprint') {
  const definition = setupDefinition(profile), desiredCollections = definition.collections;
  const names = [...new Set(['auditlogs', 'companymemberships', ...(definition.prerequisites || []).map(item => item.name), ...desiredCollections.map(item => item.name)])];
  const collections = await db.listCollections({ name: { $in: names } }, { ...time, nameOnly: false }).toArray();
  if (!collections.some(item => item.name === 'auditlogs') || !collections.some(item => item.name === 'companymemberships')) fail('Existing audit and membership storage is required.');
  const membershipIndexes = await db.collection('companymemberships').indexes(time);
  if (!membershipIndexes.some(index => exactIndex(index, { key: { userId: 1, realmId: 1 }, unique: true }))) fail('The existing membership uniqueness protection must be repaired separately.');
  for (const prerequisite of definition.prerequisites || []) {
    const collection = collections.find(item => item.name === prerequisite.name);
    if (!collection || collection.type !== 'collection' || Object.keys(collection.options || {}).length) fail('An existing runtime prerequisite collection is missing or incompatible; it must be reviewed separately.');
    const indexes = await db.collection(prerequisite.name).indexes(time);
    for (const wanted of prerequisite.indexes) if (!indexes.some(existing => exactIndex(existing, wanted))) fail('Existing runtime prerequisite indexes must be repaired separately.');
  }
  const steps = [];
  for (const desired of desiredCollections) {
    const collection = collections.find(item => item.name === desired.name);
    if (collection && (collection.type !== 'collection' || Object.keys(collection.options || {}).length)) fail('Existing business storage has unsupported collection options.');
    const indexes = collection ? await db.collection(desired.name).indexes(time) : [];
    const missing = [];
    for (const wanted of desired.indexes) {
      const found = indexes.filter(index => index.name === wanted.name || hash(index.key) === hash(wanted.key));
      if (found.some(existing => !exactIndex(existing, wanted))) fail('A business storage index conflicts with the reviewed definition. No index will be replaced.');
      if (!found.length) {
        if (collection && wanted.unique) {
          const grouped = Object.fromEntries(Object.keys(wanted.key).map(key => [key, '$' + key]));
          const duplicate = await db.collection(desired.name).aggregate([...(wanted.partialFilterExpression ? [{ $match: wanted.partialFilterExpression }] : []), { $group: { _id: grouped, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $limit: 1 }, { $project: { _id: 0, count: 1 } }], time).toArray();
          if (duplicate.length) fail('Duplicate business records prevent index preparation. No records will be changed.');
        }
        missing.push(wanted.name);
      }
    }
    steps.push({ collection: desired.name, create: !collection, missingIndexes: missing });
  }
  return steps;
}
// Initial installation only. This is not a lock for populated-storage upgrades.
// Do not run concurrently with privileged initialization or deployment changes.
async function assertInitialState(db, definition, session) {
  if (definition.version === 1) return;
  for (const collection of definition.collections.slice(COLLECTIONS.length)) {
    const existing = await db.collection(collection.name).findOne({}, { projection: { _id: 1 }, session, ...time });
    if (existing !== null) fail((definition.version === 3 ? 'Baseline observation' : 'Business operation') + ' storage must be empty across this database for initial setup. Populated storage requires a separately reviewed maintenance process.');
  }
}
function receiptMatches(receipt, definition, target, approvedHash) {
  if (!receipt || (receipt.profile || 'blueprint') !== definition.profile || (receipt.setupVersion || 1) !== definition.version || (definition.version > 1 && receipt.definitionHash !== hash(definition))) fail('The completion receipt belongs to another setup profile or definition.');
  if (receipt.planHash !== approvedHash || hash(receipt.target) !== hash(target)) fail('The completion receipt belongs to another target.');
}
async function previewSetup(db, target, configuredEnvironment, profile = 'blueprint') {
  const definition = setupDefinition(profile);
  validateTarget(target, configuredEnvironment);
  const identity = await deployment(db);
  const current = await source(db, target);
  const storage = await inspectStorage(db, profile);
  await assertInitialState(db, definition);
  const contract = { version: definition.version, ...(definition.version > 1 ? { profile, prerequisites: definition.prerequisites, collectionScope: 'database-wide', initialState: definition.initialState, activation: 'none' } : {}), identity, target, source: current, collections: definition.collections,
    permissionChange: current.membership ? null : { from: 'legacy-read-only', to: 'lab-owner', permissions: [...ROLE_PERMISSIONS['lab-owner']] },
    writes: [definition.version === 1 ? 'Add missing blueprint collections and exact indexes' : definition.version === 2 ? 'Add missing business operation and blueprint collections and exact indexes across this database' : 'Add missing baseline observation and blueprint collections and exact indexes across this database', 'Insert owner membership if absent', 'Increment owner, connection and existing membership scope fences', 'Append setup intent and completion audit'],
  };
  return { ...contract, planHash: hash(contract), storage, requiresExplicitApproval: true, qboWrites: 0, schedulingEnabled: false };
}
function ids(planHash) { return { intent: new ObjectId(hash({ setup: planHash, event: 'intent' }).slice(0, 24)), complete: new ObjectId(hash({ setup: planHash, event: 'complete' }).slice(0, 24)), membership: new ObjectId(hash({ setup: planHash, event: 'owner' }).slice(0, 24)) }; }
async function applySetup(db, client, target, configuredEnvironment, approvedHash, profile = 'blueprint') {
  const definition = setupDefinition(profile);
  validateTarget(target, configuredEnvironment);
  if (typeof approvedHash !== 'string' || !/^[a-f0-9]{64}$/.test(approvedHash)) fail('Apply requires the hash of the explicitly approved preview.');
  const keys = ids(approvedHash); const audits = db.collection('auditlogs');
  const completed = await audits.findOne({ _id: keys.complete }, time);
  if (completed) {
    receiptMatches(completed.afterState, definition, target, approvedHash);
    if (completed.afterState.deploymentHash !== (await deployment(db)).fingerprint) fail('The completion receipt belongs to another target.');
    if ((await inspectStorage(db, profile)).some(step => step.create || step.missingIndexes.length)) fail('Previously completed setup storage has changed.');
    const current = await source(db, target);
    if (current.membership?.id !== completed.afterState.membershipId) fail('Previously completed owner access has changed.');
    return { status: 'already-complete', planHash: approvedHash, auditId: String(keys.complete), membershipId: completed.afterState.membershipId };
  }
  const plan = await previewSetup(db, target, configuredEnvironment, profile);
  if (plan.planHash !== approvedHash) fail('Setup inputs changed since the reviewed preview. Read the new preview before applying.');
  const auditBase = { userId: new ObjectId(target.ownerId), realmId: target.realmId, actionType: 'manual', aiDriven: false, approvalEvent: 'explicit-local-setup', createdAt: new Date() };
  const intent = { _id: keys.intent, ...auditBase, action: 'Business plan storage setup requested', outcome: 'partial', afterState: { planHash: approvedHash, target, deploymentHash: plan.identity.fingerprint, ...(definition.version > 1 ? { profile, setupVersion: definition.version, definitionHash: hash(definition) } : {}), reviewedPlan: { ...(definition.version > 1 ? { version: definition.version, profile, prerequisites: definition.prerequisites, collectionScope: 'database-wide', initialState: definition.initialState, activation: 'none' } : {}), identity: plan.identity, source: plan.source, collections: plan.collections, permissionChange: plan.permissionChange, writes: plan.writes } } };
  await assertInitialState(db, definition);
  try { await audits.insertOne(intent, { writeConcern: { w: 'majority' }, ...time }); }
  catch (error) { if (error.code !== 11000) throw error; const prior = await audits.findOne({ _id: keys.intent }, time); if (hash(prior?.afterState) !== hash(intent.afterState)) fail('Existing setup intent does not match.'); }
  // DDL is additive and deliberately outside the grant transaction. Retry only exact definitions.
  for (const desired of definition.collections) {
    const step = (await inspectStorage(db, profile)).find(item => item.collection === desired.name);
    if (step.create) {
      await assertInitialState(db, definition);
      try { await db.createCollection(desired.name, { writeConcern: { w: 'majority' }, ...time }); }
      catch (error) { if (error.code !== 48) throw error; }
    }
    await inspectStorage(db, profile);
    for (const wanted of desired.indexes) {
      const indexes = await db.collection(desired.name).indexes(time);
      if (!indexes.some(index => exactIndex(index, wanted))) {
        await assertInitialState(db, definition);
        await db.collection(desired.name).createIndex(wanted.key, { name: wanted.name, ...(wanted.unique ? { unique: true } : {}), ...(wanted.partialFilterExpression ? { partialFilterExpression: wanted.partialFilterExpression } : {}), ...time, writeConcern: { w: 'majority' } });
      }
    }
  }
  if ((await inspectStorage(db, profile)).some(step => step.create || step.missingIndexes.length)) fail('Storage preparation is incomplete. The intent remains available for retry.');
  await assertInitialState(db, definition);
  const session = client.startSession(); let result;
  try {
    await session.withTransaction(async () => {
      const done = await audits.findOne({ _id: keys.complete }, { session, ...time });
      if (done) {
        receiptMatches(done.afterState, definition, target, approvedHash);
        if (done.afterState.deploymentHash !== plan.identity.fingerprint) fail('The completion receipt belongs to another target.');
        if ((await inspectStorage(db, profile)).some(step => step.create || step.missingIndexes.length)) fail('Previously completed setup storage has changed.');
        const current = await source(db, target, session);
        if (current.membership?.id !== done.afterState.membershipId) fail('Previously completed owner access has changed.');
        result = done.afterState; return;
      }
      await assertInitialState(db, definition, session);
      if ((await deployment(db)).fingerprint !== plan.identity.fingerprint) fail('Database deployment changed during setup.');
      const current = await source(db, target, session);
      if (hash(current) !== hash(plan.source)) fail('Owner authority or connection changed during setup.');
      // Uses the same write fence as QBO connect/disconnect; a concurrent switch retries then fails source comparison.
      const fence = await db.collection('users').updateOne({ _id: new ObjectId(target.ownerId), role: current.legacyRole, ...(current.switchVersion === 0 ? { $or: [{ connectionSwitchVersion: 0 }, { connectionSwitchVersion: { $exists: false } }] } : { connectionSwitchVersion: current.switchVersion }) }, { $inc: { connectionSwitchVersion: 1 } }, { session, ...time });
      if (fence.matchedCount !== 1) fail('Owner authority changed during setup.');
      const connectionFence = await db.collection('connections').updateOne({ _id: new ObjectId(target.connectionId), userId: new ObjectId(target.ownerId), realmId: target.realmId, status: 'active' }, { $inc: { businessSetupVersion: 1 } }, { session, ...time });
      if (connectionFence.matchedCount !== 1) fail('The connection changed during setup.');
      let membershipId = current.membership?.id;
      if (membershipId) {
        const membershipFence = await db.collection('companymemberships').updateOne({ _id: new ObjectId(membershipId), userId: new ObjectId(target.ownerId), realmId: target.realmId, role: 'lab-owner', status: 'active', $or: [{ permissionOverrides: { $exists: false } }, { permissionOverrides: { $size: 0 } }] }, { $inc: { businessSetupVersion: 1 } }, { session, ...time });
        if (membershipFence.matchedCount !== 1) fail('Owner membership changed during setup.');
      } else {
        membershipId = String(keys.membership);
        await db.collection('companymemberships').insertOne({ _id: keys.membership, userId: new ObjectId(target.ownerId), realmId: target.realmId, role: 'lab-owner', permissionOverrides: [], status: 'active', migratedFromLegacyRole: current.legacyRole, createdAt: new Date(), updatedAt: new Date() }, { session, ...time });
      }
      result = { planHash: approvedHash, target, deploymentHash: plan.identity.fingerprint, membershipId, collections: definition.collections.map(item => item.name), ...(definition.version > 1 ? { profile, setupVersion: definition.version, definitionHash: hash(definition) } : {}), qboWrites: 0 };
      await audits.insertOne({ _id: keys.complete, ...auditBase, action: 'Business plan storage setup completed', createdAt: new Date(), outcome: 'success', afterState: result }, { session, ...time });
    }, { readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000, timeoutMS: 15000 });
  } finally { await session.endSession(); }
  return { status: 'complete', planHash: approvedHash, auditId: String(keys.complete), membershipId: result.membershipId };
}
// Collection/index existence must never unlock capture midway through setup.
async function assertBaselineSetupCompleted(db, target, session) {
  const definition = setupDefinition('baseline-observations');
  const receipt = await db.collection('auditlogs').findOne({ 'afterState.profile': definition.profile, 'afterState.setupVersion': definition.version, 'afterState.target.environment': target.environment, 'afterState.target.realmId': target.realmId, 'afterState.target.connectionId': target.connectionId, 'afterState.target.ownerId': target.ownerId, outcome: 'success' }, { ...time, session, sort: { createdAt: -1 } });
  const value = receipt?.afterState;
  if (!value || !/^[a-f0-9]{64}$/.test(value.planHash || '')) fail('Complete the reviewed baseline observation storage setup before capturing reports.');
  receiptMatches(value, definition, target, value.planHash);
  if (String(receipt._id) !== String(ids(value.planHash).complete) || String(receipt.userId) !== target.ownerId || receipt.realmId !== target.realmId || receipt.action !== 'Business plan storage setup completed' || receipt.actionType !== 'manual' || receipt.approvalEvent !== 'explicit-local-setup' || value.deploymentHash !== (await deployment(db)).fingerprint || hash(value.collections) !== hash(definition.collections.map(item => item.name)) || value.qboWrites !== 0) fail('The completed baseline observation setup receipt needs review.');
  return { setupVersion: definition.version, planHash: value.planHash };
}
module.exports = { assertBaselineSetupCompleted, COLLECTIONS, OPERATIONS_COLLECTIONS, BASELINE_COLLECTIONS, LEGACY_PREREQUISITES, setupDefinition, validateTarget, exactIndex, previewSetup, applySetup };
