'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongoose').mongo;
const { previewSetup, applySetup, exactIndex, COLLECTIONS, OPERATIONS_COLLECTIONS, BASELINE_COLLECTIONS, LEGACY_PREREQUISITES, assertBaselineSetupCompleted } = require('../src/modules/business-storage-setup');
const { args } = require('../../scripts/rebuild/prepare-business-storage.cjs');
const target = { environment: 'sandbox', realmId: '123', connectionId: '000000000000000000000001', ownerId: '000000000000000000000002' };
function clone(value) {
  if (value instanceof ObjectId) return new ObjectId(String(value));
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
const nested = (doc, key) => key.split('.').reduce((value, part) => value?.[part], doc);
function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => key === '$or' ? value.some(branch => matches(doc, branch)) : value && typeof value === 'object' && '$exists' in value ? (nested(doc, key) !== undefined) === value.$exists : value && typeof value === 'object' && '$size' in value ? Array.isArray(nested(doc, key)) && nested(doc, key).length === value.$size : String(nested(doc, key)) === String(value));
}
function fixture() {
  const make = docs => ({ docs, indexes: [{ name: '_id_', key: { _id: 1 } }], options: {} });
  let data = {
    users: make([{ _id: new ObjectId(target.ownerId), role: 'agent', connectionSwitchVersion: 0 }]),
    connections: make([{ _id: new ObjectId(target.connectionId), userId: new ObjectId(target.ownerId), realmId: '123', companyName: 'Fixture Company', status: 'active' }]),
    companymemberships: make([{ _id: new ObjectId('000000000000000000000003'), userId: new ObjectId('000000000000000000000004'), realmId: '123', role: 'operator', status: 'active' }]),
    auditlogs: make([]),
  };
  for (const prerequisite of LEGACY_PREREQUISITES) data[prerequisite.name].indexes.push(...clone(prerequisite.indexes));
  const f = { writes: 0, endSessions: 0, failIndex: false, failIntent: false, failComplete: false, beforeTransaction: null, aggregates: [], afterIndex: null };
  const db = { databaseName: 'fixture-db', admin: () => ({ command: async () => ({ setName: 'fixture', hosts: ['fixture:27017'] }) }),
    listCollections: (filter = {}) => ({ toArray: async () => Object.entries(data).filter(([name]) => !filter.name?.$in || filter.name.$in.includes(name)).map(([name, value]) => ({ name, type: 'collection', options: clone(value.options) })) }),
    createCollection: async name => { f.writes++; if (!data[name]) data[name] = make([]); return {}; },
    collection: name => ({
      findOne: async filter => clone((data[name]?.docs || []).find(doc => matches(doc, filter)) || null),
      find: filter => { let maximum = 100; const cursor = { limit(number) { maximum = number; return cursor; }, toArray: async () => clone((data[name]?.docs || []).filter(doc => matches(doc, filter)).slice(0, maximum)) }; return cursor; },
      indexes: async () => clone(data[name].indexes),
      aggregate: pipeline => { f.aggregates.push({ name, pipeline: clone(pipeline) }); return { toArray: async () => f.duplicates ? [{ count: 2 }] : [] }; },
      createIndex: async (key, options) => { f.writes++; if (f.failIndex) { f.failIndex = false; throw new Error('fixture index unavailable'); } data[name].indexes.push({ name: options.name, key: clone(key), ...(options.unique ? { unique: true } : {}), ...(options.partialFilterExpression ? { partialFilterExpression: clone(options.partialFilterExpression) } : {}) }); if (f.afterIndex) f.afterIndex(data, name); },
      insertOne: async document => {
        f.writes++;
        if (name === 'auditlogs' && ((f.failIntent && document.outcome === 'partial') || (f.failComplete && document.outcome === 'success'))) throw new Error('fixture audit unavailable');
        if (data[name].docs.some(doc => String(doc._id) === String(document._id) || (name === 'companymemberships' && String(doc.userId) === String(document.userId) && doc.realmId === document.realmId))) throw Object.assign(new Error('fixture duplicate'), { code: 11000 });
        data[name].docs.push(clone(document)); return { insertedId: document._id };
      },
      updateOne: async (filter, change) => { f.writes++; if (name === 'users' && f.afterSourceRead) f.afterSourceRead(data); const doc = data[name].docs.find(doc => matches(doc, filter)); if (!doc) return { matchedCount: 0 }; for (const [key, amount] of Object.entries(change.$inc || {})) doc[key] = (doc[key] || 0) + amount; return { matchedCount: 1 }; },
    }),
  };
  const client = { startSession: () => ({ withTransaction: async work => { if (f.beforeTransaction) f.beforeTransaction(data); const before = clone(data); try { return await work(); } catch (error) { data = before; throw error; } }, endSession: async () => { f.endSessions++; } }) };
  f.db = db; f.client = client; f.data = () => data; f.preview = profile => previewSetup(db, target, 'sandbox', profile); f.apply = (planHash, profile) => applySetup(db, client, target, 'sandbox', planHash, profile); return f;
}
test('CLI defaults to read-only and never accepts apply without reviewed hash', () => {
  assert.equal(args([]).apply, undefined);
  assert.throws(() => args(['--apply'])); assert.throws(() => args(['--plan-hash', 'x']));
  assert.throws(() => args(['--unknown', 'x'])); assert.throws(() => args(['--apply', '--apply', '--plan-hash', 'x']));
  assert.equal(args(['--apply', '--plan-hash', 'x']).apply, true);
});
test('preview binds actual deployment, owner source and exact permission change without writes', async () => {
  const f = fixture(); const plan = await f.preview();
  assert.equal(f.writes, 0); assert.equal(plan.source.legacyRole, 'agent'); assert.equal(plan.permissionChange.to, 'lab-owner');
  assert.ok(plan.permissionChange.permissions.includes('blueprint.manage')); assert.equal(plan.identity.database, 'fixture-db');
  assert.equal(plan.storage.filter(item => item.create).length, 2); assert.equal(plan.qboWrites, 0);
});
test('environment mismatches and changed ownership stop before writes', async () => {
  const f = fixture(); await assert.rejects(previewSetup(f.db, target, 'production'), /environment/);
  f.data().connections.docs[0].userId = new ObjectId('000000000000000000000005');
  await assert.rejects(f.preview(), /ownership/); assert.equal(f.writes, 0);
});
test('apply creates exact storage and owner access, preserves another member and has atomic completion', async () => {
  const f = fixture(); const plan = await f.preview(); const result = await f.apply(plan.planHash);
  assert.equal(result.status, 'complete'); assert.equal(f.data().companymemberships.docs.length, 2);
  assert.equal(f.data().companymemberships.docs[0].role, 'operator'); assert.equal(f.data().companymemberships.docs[1].role, 'lab-owner');
  assert.equal(f.data().auditlogs.docs.length, 2); assert.equal(f.data().users.docs[0].connectionSwitchVersion, 1);
  assert.equal(f.data().connections.docs[0].businessSetupVersion, 1); assert.equal(f.endSessions, 1);
  const writes = f.writes; assert.equal((await f.apply(plan.planHash)).status, 'already-complete'); assert.equal(f.writes, writes);
});
test('failed DDL leaves an intent and resumes the same exact additive plan', async () => {
  const f = fixture(); const plan = await f.preview(); f.failIndex = true;
  await assert.rejects(f.apply(plan.planHash), /index unavailable/);
  assert.equal(f.data().auditlogs.docs.length, 1); assert.equal(f.data().companymemberships.docs.length, 1);
  assert.equal((await f.preview()).planHash, plan.planHash);
  assert.equal((await f.apply(plan.planHash)).status, 'complete'); assert.equal(f.data().auditlogs.docs.length, 2);
});
test('failure to persist intent prevents all DDL and membership work', async () => {
  const f = fixture(); const plan = await f.preview(); f.failIntent = true;
  await assert.rejects(f.apply(plan.planHash), /audit unavailable/);
  assert.equal(f.data().blueprintversions, undefined); assert.equal(f.data().companymemberships.docs.length, 1);
});
test('completion audit failure rolls back membership and source fences while retaining prepared storage', async () => {
  const f = fixture(); const plan = await f.preview(); f.failComplete = true;
  await assert.rejects(f.apply(plan.planHash), /audit unavailable/);
  assert.equal(f.data().companymemberships.docs.length, 1); assert.equal(f.data().users.docs[0].connectionSwitchVersion, 0);
  assert.equal(f.data().connections.docs[0].businessSetupVersion, undefined); assert.equal(f.data().auditlogs.docs.length, 1); assert.ok(f.data().blueprintversions);
  f.failComplete = false; assert.equal((await f.apply(plan.planHash)).status, 'complete');
});
test('source changes before application or inside transaction cannot grant access', async () => {
  const f = fixture(); const plan = await f.preview(); f.data().users.docs[0].role = 'supervisor';
  await assert.rejects(f.apply(plan.planHash), /changed/); assert.equal(f.writes, 0);
  const g = fixture(); const p = await g.preview(); g.beforeTransaction = data => { data.connections.docs[0].status = 'revoked'; };
  await assert.rejects(g.apply(p.planHash), /ownership/); assert.equal(g.data().companymemberships.docs.length, 1); assert.equal(g.endSessions, 1);
});
test('existing owner roles are never replaced and index conflicts are never weakened', async () => {
  const f = fixture(); f.data().companymemberships.docs[0].userId = new ObjectId(target.ownerId);
  await assert.rejects(f.preview(), /separate review/); assert.equal(f.writes, 0);
  const g = fixture(); g.data().companymemberships.indexes[1].sparse = true;
  await assert.rejects(g.preview(), /uniqueness/); assert.equal(g.writes, 0);
  const desired = { key: { realmId: 1, version: 1 }, unique: true };
  for (const bad of [{ ...desired, sparse: true }, { ...desired, partialFilterExpression: {} }, { ...desired, collation: { locale: 'en' } }, { ...desired, expireAfterSeconds: 0 }, { ...desired, hidden: true }]) assert.equal(exactIndex(bad, desired), false);
});
test('completed receipt is not current proof after membership removal or storage loss', async () => {
  const f = fixture(); const plan = await f.preview(); await f.apply(plan.planHash); f.data().companymemberships.docs.pop();
  await assert.rejects(f.apply(plan.planHash), /access has changed/);
  const g = fixture(); const p = await g.preview(); await g.apply(p.planHash); delete g.data().blueprintsequences;
  await assert.rejects(g.apply(p.planHash), /storage has changed/);
});

test('an existing owner membership is fenced against revocation after the source read', async () => {
  const f = fixture(); f.data().companymemberships.docs.push({ _id: new ObjectId('000000000000000000000006'), userId: new ObjectId(target.ownerId), realmId: '123', role: 'lab-owner', status: 'active', permissionOverrides: [] });
  const plan = await f.preview(); assert.equal(plan.permissionChange, null);
  f.afterSourceRead = data => { data.companymemberships.docs[1].status = 'suspended'; };
  await assert.rejects(f.apply(plan.planHash), /membership changed/);
  assert.equal(f.data().auditlogs.docs.some(entry => entry.outcome === 'success'), false);
  f.afterSourceRead = null; assert.equal((await f.apply(plan.planHash)).status, 'complete');
  assert.equal(f.data().companymemberships.docs[1].businessSetupVersion, 1);
});

const operations = 'business-operations';
test('explicit profiles keep the original blueprint contract and reject unknown profiles', async () => {
  const f = fixture(); assert.deepEqual(await f.preview(), await f.preview('blueprint'));
  assert.equal((await f.preview()).version, 1); assert.equal((await f.preview()).profile, undefined);
  assert.equal(args(['--profile', operations]).profile, operations);
  assert.throws(() => args(['--profile', 'everything']), /profile/);
  await assert.rejects(f.preview('everything'), /profile/); assert.equal(f.writes, 0);
});
test('operation preview binds expanded definitions and discloses access changes without writes', async () => {
  const f = fixture(), plan = await f.preview(operations);
  assert.equal(plan.version, 2); assert.equal(plan.profile, operations);
  assert.equal(plan.collectionScope, 'database-wide'); assert.equal(plan.activation, 'none');
  assert.deepEqual(plan.collections, OPERATIONS_COLLECTIONS); assert.deepEqual(plan.prerequisites, LEGACY_PREREQUISITES);
  assert.equal(plan.storage.length, 11); assert.equal(plan.permissionChange.to, 'lab-owner');
  assert.ok(plan.writes.some(value => value.includes('scope fences')));
  assert.equal(plan.qboWrites, 0); assert.equal(plan.schedulingEnabled, false); assert.equal(f.writes, 0);
  assert.notEqual(plan.planHash, (await f.preview()).planHash);
});
test('a reviewed hash and completed receipt cannot authorize another setup profile', async () => {
  const f = fixture(), original = await f.preview(), expanded = await f.preview(operations);
  await assert.rejects(f.apply(original.planHash, operations), /inputs changed/);
  await assert.rejects(f.apply(expanded.planHash), /inputs changed/); assert.equal(f.writes, 0);
  await f.apply(original.planHash);
  const writes = f.writes; await assert.rejects(f.apply(original.planHash, operations), /another setup profile/);
  assert.equal(f.writes, writes); assert.equal(f.data().operationruns, undefined);
});
test('full setup creates exact empty operation storage and never activates business work', async () => {
  const f = fixture(), plan = await f.preview(operations);
  assert.equal((await f.apply(plan.planHash, operations)).status, 'complete');
  for (const definition of OPERATIONS_COLLECTIONS) {
    assert.equal(f.data()[definition.name].docs.length, 0);
    for (const wanted of definition.indexes) assert.ok(f.data()[definition.name].indexes.some(value => exactIndex(value, wanted)));
  }
  const completed = f.data().auditlogs.docs.find(row => row.outcome === 'success');
  assert.equal(completed.afterState.profile, operations); assert.equal(completed.afterState.setupVersion, 2);
  const writes = f.writes; assert.equal((await f.apply(plan.planHash, operations)).status, 'already-complete'); assert.equal(f.writes, writes);
  completed.afterState.definitionHash = '0'.repeat(64);
  await assert.rejects(f.apply(plan.planHash, operations), /definition/);
});
test('legacy runtime prerequisites are checked without creating or repairing them', async () => {
  for (const prerequisite of LEGACY_PREREQUISITES) {
    const f = fixture(); f.data()[prerequisite.name].indexes = [{ name: '_id_', key: { _id: 1 } }];
    await assert.rejects(f.preview(operations), /prerequisite|uniqueness/); assert.equal(f.writes, 0);
  }
  const f = fixture(); f.data().auditlogs.options = { validator: {} };
  await assert.rejects(f.preview(operations), /prerequisite/); assert.equal(f.writes, 0);
});
test('partial uniqueness uses its exact filter and rejects weaker physical indexes', async () => {
  const f = fixture(); f.data().operationsteps = { docs: [], indexes: [], options: {} };
  await f.preview(operations);
  const scan = f.aggregates.find(call => call.name === 'operationsteps' && call.pipeline[0].$match?.qboId);
  assert.deepEqual(scan.pipeline[0], { $match: { qboId: { $type: 'string' } } });
  const wanted = OPERATIONS_COLLECTIONS.find(row => row.name === 'operationsteps').indexes[1];
  assert.equal(exactIndex(clone(wanted), wanted), true);
  for (const partialFilterExpression of [undefined, {}, { qboId: { $exists: true } }]) {
    f.data().operationsteps.indexes = [{ ...clone(wanted), partialFilterExpression }];
    await assert.rejects(f.preview(operations), /conflicts/); assert.equal(f.writes, 0);
  }
});
test('expanded interrupted DDL resumes exact definitions and storage drift invalidates completion', async () => {
  const f = fixture(), plan = await f.preview(operations); f.failIndex = true;
  await assert.rejects(f.apply(plan.planHash, operations), /index unavailable/);
  assert.equal((await f.preview(operations)).planHash, plan.planHash);
  await f.apply(plan.planHash, operations);
  f.data().operationsteps.indexes.find(row => row.partialFilterExpression).partialFilterExpression = {};
  await assert.rejects(f.apply(plan.planHash, operations), /conflicts/);
});
test('reviewed storage definitions cover actual runtime schemas and satisfy readiness after fixture setup', async () => {
  // Models are registered only in this disconnected test process, never by setup preview.
  for (const name of ['User', 'Connection', 'CompanyMembership', 'AuditLog']) require('../src/models/' + name);
  const { loadModels } = require('../src/modules/business-runtime');
  const models = loadModels();
  for (const model of Object.values(models)) {
    const definition = [...OPERATIONS_COLLECTIONS, ...LEGACY_PREREQUISITES].find(row => row.name === model.collection.name);
    assert.ok(definition, model.modelName + ' collection is explicitly defined');
    assert.equal(definition.indexes.length, model.schema.indexes().length, model.modelName);
    for (const [key, options] of model.schema.indexes()) assert.ok(definition.indexes.some(value => exactIndex(value, { key, ...options })), model.modelName + ' exact index');
  }
  for (const name of ['BlueprintVersion', 'BlueprintSequence']) {
    const model = require('../src/models/' + name), definition = COLLECTIONS.find(row => row.name === model.collection.name);
    assert.ok(definition); assert.equal(definition.indexes.length, model.schema.indexes().length);
    for (const [key, options] of model.schema.indexes()) assert.ok(definition.indexes.some(value => exactIndex(value, { key, ...options })));
  }
  const f = fixture(), plan = await f.preview(operations); await f.apply(plan.planHash, operations);
  const mapped = Object.fromEntries(Object.entries(models).map(([key, model]) => [key, { schema: model.schema, collection: { name: model.collection.name, indexes: () => f.db.collection(model.collection.name).indexes() } }]));
  const { createBusinessStorageReadiness } = require('../src/modules/business-runtime-storage');
  await createBusinessStorageReadiness({ connection: { readyState: 1, db: f.db }, models: mapped })();
});

test('initial setup refuses every populated runtime collection across companies before writes', async () => {
  for (const definition of OPERATIONS_COLLECTIONS.slice(COLLECTIONS.length)) {
    const f = fixture(), plan = await f.preview(operations);
    f.data()[definition.name] = { docs: [{ _id: 'other-company', realmId: '999', state: 'active', executionRequest: { pending: true } }], indexes: clone(definition.indexes), options: {} };
    await assert.rejects(f.apply(plan.planHash, operations), /must be empty/); assert.equal(f.writes, 0);
  }
});
test('runtime rows appearing during DDL or before completion stop further setup', async () => {
  for (const phase of ['index', 'transaction']) {
    const f = fixture(), plan = await f.preview(operations);
    const insert = data => { data.companywritepolicies = { docs: [{ _id: 'unexpected', state: 'active' }], indexes: clone(OPERATIONS_COLLECTIONS.find(row => row.name === 'companywritepolicies').indexes), options: {} }; };
    if (phase === 'index') f.afterIndex = insert; else f.beforeTransaction = insert;
    await assert.rejects(f.apply(plan.planHash, operations), /must be empty/);
    assert.equal(f.data().auditlogs.docs.some(row => row.outcome === 'success'), false);
    assert.equal(f.data().companymemberships.docs.length, 1);
    if (phase === 'index') assert.equal(f.data().blueprintsequences, undefined);
  }
});
test('completed setup remains a read-only receipt check after separately initialized work', async () => {
  const f = fixture(), plan = await f.preview(operations); await f.apply(plan.planHash, operations);
  f.data().operationruns.docs.push({ _id: 'later-authorized-work' });
  const writes = f.writes;
  assert.equal((await f.apply(plan.planHash, operations)).status, 'already-complete'); assert.equal(f.writes, writes);
  await assert.rejects(f.preview(operations), /must be empty/);
});

const baselineProfile = 'baseline-observations';
test('baseline setup uses its own three-collection definition and cannot expand old approvals', async () => {
  const f = fixture(), original = await f.preview(), operationsPlan = await f.preview(operations), plan = await f.preview(baselineProfile);
  assert.equal(plan.version, 3); assert.equal(plan.profile, baselineProfile); assert.equal(plan.collections.length, 3); assert.equal(plan.storage.filter(row => row.create).length, 3); assert.notEqual(plan.planHash, original.planHash); assert.notEqual(plan.planHash, operationsPlan.planHash);
  await assert.rejects(f.apply(original.planHash, baselineProfile), /changed/); await assert.rejects(f.apply(operationsPlan.planHash, baselineProfile), /changed/); assert.equal(f.writes, 0);
  await f.apply(plan.planHash, baselineProfile); assert.equal(f.data().operationruns, undefined); assert.equal(f.data().businessbaselines.docs.length, 0);
  const Model = require('../src/models/BusinessBaseline'), definition = BASELINE_COLLECTIONS.find(row => row.name === Model.collection.name);
  assert.ok(definition); assert.equal(definition.indexes.length, Model.schema.indexes().length);
  for (const [key, options] of Model.schema.indexes()) assert.ok(definition.indexes.some(value => exactIndex(value, { key, ...options })));
  const writes = f.writes; await assertBaselineSetupCompleted(f.db, target); assert.equal(f.writes, writes);
});
test('index creation never satisfies baseline completion gate and interrupted setup remains retryable', async () => {
  const f = fixture(), plan = await f.preview(baselineProfile); f.failComplete = true;
  await assert.rejects(f.apply(plan.planHash, baselineProfile), /audit unavailable/); assert.ok(f.data().businessbaselines);
  await assert.rejects(assertBaselineSetupCompleted(f.db, target), /Complete/);
  f.failComplete = false; await f.apply(plan.planHash, baselineProfile); await assertBaselineSetupCompleted(f.db, target);
});
test('baseline initial install rejects existing observations but accepts completed read-only checks later', async () => {
  const f = fixture(), plan = await f.preview(baselineProfile); await f.apply(plan.planHash, baselineProfile);
  f.data().businessbaselines.docs.push({ _id: 'later-observation' }); const writes = f.writes;
  await assertBaselineSetupCompleted(f.db, target); assert.equal((await f.apply(plan.planHash, baselineProfile)).status, 'already-complete'); assert.equal(f.writes, writes);
  await assert.rejects(f.preview(baselineProfile), /must be empty/);
});
test('baseline completion gate rejects changed target, deployment or receipt integrity', async () => {
  const edits = [row => { row._id = new ObjectId(); }, row => { row.afterState.definitionHash = 'f'.repeat(64); }, row => { row.afterState.deploymentHash = 'f'.repeat(64); }, row => { row.afterState.collections.push('operationruns'); }, row => { row.afterState.qboWrites = 1; }, row => { row.approvalEvent = 'inferred'; }];
  for (const edit of edits) { const f = fixture(), plan = await f.preview(baselineProfile); await f.apply(plan.planHash, baselineProfile); edit(f.data().auditlogs.docs.find(row => row.outcome === 'success')); await assert.rejects(assertBaselineSetupCompleted(f.db, target)); }
  const f = fixture(), plan = await f.preview(baselineProfile); await f.apply(plan.planHash, baselineProfile); await assert.rejects(assertBaselineSetupCompleted(f.db, { ...target, realmId: '456' }));
});
