'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongoose').mongo;
const { previewAdditiveStorage, applyAdditiveStorage, previewSetup, applySetup, exactIndex, COLLECTIONS, OPERATIONS_COLLECTIONS, CONTINUAL_COLLECTIONS, BASELINE_COLLECTIONS, LEGACY_PREREQUISITES, GENERAL_WRITE_COLLECTIONS, setupDefinition, assertProfileSetupCompleted, assertBaselineSetupCompleted } = require('../src/modules/business-storage-setup');
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
  const models = { ...loadModels(), GeneralDayCloses: require('../src/models/GeneralDayClose') };
  for (const model of Object.values(models)) {
    const definition = [...CONTINUAL_COLLECTIONS, ...LEGACY_PREREQUISITES, ...GENERAL_WRITE_COLLECTIONS].find(row => row.name === model.collection.name);
    assert.ok(definition, model.modelName + ' collection is explicitly defined');
    assert.equal(definition.indexes.length, model.schema.indexes().length, model.modelName);
    for (const [key, options] of model.schema.indexes()) assert.ok(definition.indexes.some(value => exactIndex(value, { key, ...options })), model.modelName + ' exact index');
  }
  for (const name of ['BlueprintVersion', 'BlueprintSequence']) {
    const model = require('../src/models/' + name), definition = COLLECTIONS.find(row => row.name === model.collection.name);
    assert.ok(definition); assert.equal(definition.indexes.length, model.schema.indexes().length);
    for (const [key, options] of model.schema.indexes()) assert.ok(definition.indexes.some(value => exactIndex(value, { key, ...options })));
  }
  const f = fixture(), plan = await f.preview('continual-business'); await f.apply(plan.planHash, 'continual-business');
  const general = await f.preview('general-writes'); await f.apply(general.planHash, 'general-writes');
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

const continual = 'continual-business';
test('continual setup is a separate v4 approval and preserves existing drafts and observations', async () => {
  const f = fixture(); const legacy = await f.preview(baselineProfile); await f.apply(legacy.planHash, baselineProfile);
  f.data().blueprintversions.docs.push({ _id: 'retained-draft', realmId: '123', version: 1 });
  f.data().businessbaselines.docs.push({ _id: 'retained-observation' });
  const before = clone(f.data().businessbaselines.docs), plan = await f.preview(continual);
  assert.equal(plan.version, 4); assert.equal(plan.activation, 'none'); assert.equal(plan.qboWrites, 0);
  assert.ok(plan.collections.some(row => row.name === 'businessauthorities')); assert.ok(plan.collections.some(row => row.name === 'businesscandidates'));
  await assert.rejects(f.apply(legacy.planHash, continual), /profile or definition/);
  await f.apply(plan.planHash, continual); assert.deepEqual(f.data().businessbaselines.docs, before);
  assert.equal(f.data().blueprintversions.docs[0]._id, 'retained-draft');
  assert.equal(f.data().companywritepolicies.docs.length, 0); assert.equal(f.data().businesscalendars.docs.length, 0);
  await require('../src/modules/business-storage-setup').assertProfileSetupCompleted(f.db, target, continual);
  await assertBaselineSetupCompleted(f.db, target);
});
test('continual initial preparation refuses populated operation or authority storage', async () => {
  for (const name of ['operationruns', 'companywritepolicies', 'businessauthorities', 'businesscandidates']) {
    const f = fixture(); f.data()[name] = { docs: [{ _id: 'existing' }], indexes: [{ name: '_id_', key: { _id: 1 } }], options: {} };
    await assert.rejects(f.preview(continual), /must be empty/); assert.equal(f.writes, 0);
  }
});

test('continual setup explicitly prepares and verifies case submission uniqueness while retaining cases', async () => {
  const f = fixture(); f.data().aisessions = { docs: [{ _id: 'retained-case', userId: target.ownerId, realmId: target.realmId }], indexes: [{ name: '_id_', key: { _id: 1 } }], options: {} };
  const plan = await f.preview(continual); const identity = plan.collections.find(row => row.name === 'aisessions');
  assert.ok(identity.indexes.some(row => row.unique && row.partialFilterExpression?.submissionId?.$type === 'string'));
  await f.apply(plan.planHash, continual); assert.equal(f.data().aisessions.docs[0]._id, 'retained-case');
  const actual = require('../src/models/AISession').schema.indexes(); for (const [key, options] of actual) assert.ok(identity.indexes.some(row => exactIndex(row, { key, ...options })));
});

test('master preparation adds its own profile to populated v4 storage without reinstalling or changing it', async () => {
  const f = fixture(), continual = await f.preview('continual-business'); await f.apply(continual.planHash, 'continual-business');
  f.data().operationruns.docs.push({ _id: 'retained-operation' }); f.data().businessauthorities.docs.push({ _id: 'retained-authority' });
  const before = Object.fromEntries(CONTINUAL_COLLECTIONS.map(item => [item.name, clone(f.data()[item.name])]));
  const writes = f.writes, master = await f.preview('master-preparation'); assert.equal(f.writes, writes); assert.equal(master.version, 5); assert.deepEqual(master.collections.map(row => row.name), ['masterpreparationruns']); assert.equal(master.permissionChange, null); assert.equal(master.qboWrites, 0);
  await f.apply(master.planHash, 'master-preparation');
  for (const [name, value] of Object.entries(before)) assert.deepEqual(f.data()[name], value);
  assert.equal((await f.apply(master.planHash, 'master-preparation')).status, 'already-complete');
});
test('master installation requires a completed v4 receipt and refuses pre-existing master runs', async () => {
  const f = fixture(); await assert.rejects(f.preview('master-preparation')); assert.equal(f.writes, 0);
  const continual = await f.preview('continual-business'); await f.apply(continual.planHash, 'continual-business');
  f.data().masterpreparationruns = { docs: [{ _id: 'unexpected-master' }], indexes: [{ name: '_id_', key: { _id: 1 } }], options: {} };
  const writes = f.writes; await assert.rejects(f.preview('master-preparation'), /empty/); assert.equal(f.writes, writes);
});

test('general-write storage adds exact definitions without changing populated continual-business receipts', async () => {
  const f=fixture(), base=await f.preview('continual-business'); await f.apply(base.planHash,'continual-business');
  f.data().operationruns.docs.push({_id:'retained-operation',realmId:'123'});
  const before=clone(f.data().auditlogs.docs.find(row=>row.outcome==='success')),writes=f.writes;
  const plan=await f.preview('general-writes'); assert.equal(f.writes,writes); assert.equal(plan.version,6); assert.equal(plan.activation,'none'); assert.equal(plan.qboWrites,0);
  assert.equal(args(['--profile','general-writes']).profile,'general-writes');
  assert.deepEqual(plan.collections.map(row=>row.name),['generalwriteruns','generaldaycloses']); assert.equal(plan.permissionChange,null);
  await f.apply(plan.planHash,'general-writes'); await assertProfileSetupCompleted(f.db,target,'continual-business');
  assert.deepEqual(f.data().auditlogs.docs.find(row=>String(row._id)===String(before._id)),before);
  assert.deepEqual(f.data().operationruns.docs,[{_id:'retained-operation',realmId:'123'}]);
  assert.equal((await f.apply(base.planHash,'continual-business')).status,'already-complete'); assert.equal(setupDefinition('continual-business').version,4);
});
test('general-write setup requires the existing owner and reviewed base and refuses populated new storage before writes', async () => {
  const empty=fixture(); await assert.rejects(empty.preview('general-writes'),/Existing owner membership/); assert.equal(empty.writes,0);
  const f=fixture(), base=await f.preview('continual-business'); await f.apply(base.planHash,'continual-business');
  f.data().generalwriteruns={docs:[{_id:'existing-general-run'}],indexes:clone(GENERAL_WRITE_COLLECTIONS[0].indexes),options:{}};
  const writes=f.writes; await assert.rejects(f.preview('general-writes'),/empty/); assert.equal(f.writes,writes);
});

async function populatedGeneralStorage() {
  const f = fixture(), base = await f.preview('continual-business'); await f.apply(base.planHash, 'continual-business');
  f.data().operationruns.docs.push({ _id: 'retained-operation' });
  f.data().businessauthorities.docs.push({ _id: 'retained-authority' });
  f.data().generalwriteruns = { docs: [{ _id: 'retained-general-run', status: 'complete' }], indexes: [{ name: '_id_', key: { _id: 1 } }, ...clone(GENERAL_WRITE_COLLECTIONS[0].indexes)], options: {} };
  f.additivePreview = () => previewAdditiveStorage(f.db, target, 'sandbox', 'general-writes');
  f.additiveApply = hash => applyAdditiveStorage(f.db, target, 'sandbox', hash, 'general-writes');
  return f;
}
const businessDocuments = f => Object.fromEntries(Object.entries(f.data()).filter(([name]) => name !== 'auditlogs').map(([name, value]) => [name, clone(value.docs)]));
test('additive preview reports exact missing v6 DDL on populated storage without writing', async () => {
  const f = await populatedGeneralStorage(), writes = f.writes, before = clone(f.data()), plan = await f.additivePreview();
  assert.equal(f.writes, writes); assert.deepEqual(f.data(), before);
  assert.equal(plan.setupVersion, 6); assert.equal(plan.collectionScope, 'database-wide'); assert.equal(plan.permissionChange, null); assert.equal(plan.activation, 'none');
  assert.deepEqual(plan.changes, [{ collection: 'generaldaycloses', create: true, indexes: clone(GENERAL_WRITE_COLLECTIONS[1].indexes) }]);
  assert.deepEqual(plan.changes[0].indexes[0].key, { environment: 1, realmId: 1, connectionId: 1, fromDate: 1, throughDate: 1, kind: 1, verifiedAt: -1 });
});
test('additive apply preserves populated documents and existing indexes, audits and is idempotent', async () => {
  const f = await populatedGeneralStorage(), before = businessDocuments(f), existing = clone(f.data().generalwriteruns), audits = clone(f.data().auditlogs.docs), plan = await f.additivePreview();
  const result = await f.additiveApply(plan.planHash); assert.equal(result.status, 'complete');
  assert.deepEqual(businessDocuments(f), { ...before, generaldaycloses: [] }); assert.deepEqual(f.data().generalwriteruns, existing);
  assert.deepEqual(f.data().auditlogs.docs.slice(0, audits.length), audits); assert.equal(f.data().auditlogs.docs.length, audits.length + 2);
  const intent = f.data().auditlogs.docs[audits.length], completed = f.data().auditlogs.docs[audits.length + 1];
  assert.equal(intent.approvalEvent, 'explicit-additive-storage-preparation'); assert.deepEqual(intent.afterState.reviewedPlan.changes, plan.changes); assert.equal(completed.outcome, 'success');
  const writes = f.writes; assert.equal((await f.additiveApply(plan.planHash)).status, 'already-complete'); assert.equal(f.writes, writes);
  await assertProfileSetupCompleted(f.db, target, 'continual-business');
  const fresh = await f.additivePreview(); assert.deepEqual(fresh.changes, []);
  await f.additiveApply(fresh.planHash); assert.equal(f.writes, writes + 2); assert.equal((await f.additiveApply(fresh.planHash)).status, 'already-complete');
});
test('additive preparation adds missing indexes to populated existing collections only', async () => {
  const f = await populatedGeneralStorage();
  f.data().generaldaycloses = { docs: [{ _id: 'retained-close', kind: 'business-day' }], indexes: [{ name: '_id_', key: { _id: 1 } }, { name: 'extra-index', key: { kind: 1 } }], options: {} };
  f.data().generalwriteruns.indexes.pop(); const before = businessDocuments(f), plan = await f.additivePreview();
  assert.equal(plan.changes.length, 2); assert.ok(plan.changes.every(step => !step.create && step.indexes.length === 1));
  const writes = f.writes; await f.additiveApply(plan.planHash); assert.equal(f.writes, writes + 4);
  assert.deepEqual(businessDocuments(f), before); assert.ok(f.data().generaldaycloses.indexes.some(index => index.name === 'extra-index'));
});
test('equivalent index with a different name is already satisfied and never rebuilt', async () => {
  const f = await populatedGeneralStorage();
  f.data().generaldaycloses = { docs: [{ _id: 'retained-close' }], indexes: clone(GENERAL_WRITE_COLLECTIONS[1].indexes), options: {} };
  f.data().generaldaycloses.indexes[0].name = 'existing-equivalent-name';
  const before = clone(f.data().generaldaycloses), plan = await f.additivePreview(), writes = f.writes;
  assert.deepEqual(plan.changes, []); await f.additiveApply(plan.planHash); assert.equal(f.writes, writes + 2); assert.deepEqual(f.data().generaldaycloses, before);
});
test('partial additive DDL resumes the saved exact plan with populated records still present', async () => {
  const f = await populatedGeneralStorage(), before = businessDocuments(f), plan = await f.additivePreview(); f.failIndex = true;
  await assert.rejects(f.additiveApply(plan.planHash), /index unavailable/); assert.ok(f.data().generaldaycloses);
  assert.notEqual((await f.additivePreview()).planHash, plan.planHash);
  assert.equal((await f.additiveApply(plan.planHash)).status, 'complete');
  assert.deepEqual(businessDocuments(f), { ...before, generaldaycloses: [] });
  const writes = f.writes; await f.additiveApply(plan.planHash); assert.equal(f.writes, writes);
});
test('partial retries and stale previews never expand to newly missing or conflicting indexes', async () => {
  const f = await populatedGeneralStorage(), plan = await f.additivePreview(); f.failIndex = true;
  await assert.rejects(f.additiveApply(plan.planHash), /index unavailable/);
  f.data().generalwriteruns.indexes.pop(); const writes = f.writes;
  await assert.rejects(f.additiveApply(plan.planHash), /beyond the reviewed/); assert.equal(f.writes, writes);
  const g = await populatedGeneralStorage(), stale = await g.additivePreview(); g.data().generalwriteruns.indexes.pop(); const before = g.writes;
  await assert.rejects(g.additiveApply(stale.planHash), /changed/); assert.equal(g.writes, before);
});
test('audit failure blocks DDL; completion failure retains recoverable DDL without editing documents', async () => {
  const f = await populatedGeneralStorage(), plan = await f.additivePreview(); f.failIntent = true;
  await assert.rejects(f.additiveApply(plan.planHash), /audit unavailable/); assert.equal(f.data().generaldaycloses, undefined);
  f.failIntent = false; f.failComplete = true; const before = businessDocuments(f);
  await assert.rejects(f.additiveApply(plan.planHash), /audit unavailable/); assert.deepEqual(businessDocuments(f), { ...before, generaldaycloses: [] });
  f.failComplete = false; assert.equal((await f.additiveApply(plan.planHash)).status, 'complete');
});
test('conflicting indexes, duplicate keys, missing prerequisites and collection options stop without writes', async () => {
  for (const edit of [
    f => { f.data().generalwriteruns.indexes[1].sparse = true; },
    f => { f.data().generalwriteruns.indexes[1].key = { wrong: 1 }; },
    f => { f.data().generalwriteruns.indexes.splice(1, 1); f.duplicates = true; },
    f => { delete f.data().auditlogs; },
    f => { delete f.data().companywriters; },
    f => { f.data().generalwriteruns.options = { validator: {} }; },
  ]) {
    const f = await populatedGeneralStorage(); edit(f); const writes = f.writes;
    await assert.rejects(f.additivePreview()); assert.equal(f.writes, writes);
  }
});
test('only the reviewed profile, target, owner authority and deployment can apply or retry', async () => {
  const f = await populatedGeneralStorage(), plan = await f.additivePreview(), writes = f.writes;
  await assert.rejects(previewAdditiveStorage(f.db, target, 'sandbox', 'continual-business'), /only/);
  await assert.rejects(applyAdditiveStorage(f.db, { ...target, realmId: '456' }, 'sandbox', plan.planHash, 'general-writes'));
  await assert.rejects(applyAdditiveStorage(f.db, target, 'production', plan.planHash, 'general-writes'), /environment/);
  await assert.rejects(f.additiveApply('bad-hash'), /hash/); assert.equal(f.writes, writes);
  await f.additiveApply(plan.planHash); const after = f.writes;
  f.db.admin = () => ({ command: async () => ({ setName: 'other-deployment', hosts: ['other:27017'] }) });
  await assert.rejects(f.additiveApply(plan.planHash)); assert.equal(f.writes, after);
  const g = await populatedGeneralStorage(), gp = await g.additivePreview(); await g.additiveApply(gp.planHash);
  g.data().users.docs[0].connectionSwitchVersion++; const gw = g.writes;
  await assert.rejects(g.additiveApply(gp.planHash), /changed/); assert.equal(g.writes, gw);
});
test('authority is checked again after partial DDL and completed receipts cannot authorize repairs', async () => {
  const f = await populatedGeneralStorage(), plan = await f.additivePreview();
  f.afterIndex = data => { data.connections.docs[0].status = 'revoked'; };
  await assert.rejects(f.additiveApply(plan.planHash), /ownership/);
  assert.equal(f.data().auditlogs.docs.filter(row => row.action === 'Additive business storage preparation completed').length, 0);
  const g = await populatedGeneralStorage(), gp = await g.additivePreview(); await g.additiveApply(gp.planHash);
  g.data().generaldaycloses.indexes.pop(); const writes = g.writes;
  await assert.rejects(g.additiveApply(gp.planHash), /completed additive/); assert.equal(g.writes, writes);
});
