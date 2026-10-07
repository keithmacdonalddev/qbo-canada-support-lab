'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessStorageReadiness } = require('../src/modules/business-runtime-storage');
function harness() {
  const h = { clock: 10000, calls: 0, collections: [{ name: 'steps', type: 'collection', options: {} }], indexes: [{ key: { environment: 1, realmId: 1, logicalKey: 1 }, unique: true }, { key: { entity: 1, qboId: 1 }, unique: true, partialFilterExpression: { qboId: { $type: 'string' } } }], hello: { setName: 'fixture' } };
  h.models = { Steps: { collection: { name: 'steps', indexes: async () => structuredClone(h.indexes) }, schema: { indexes: () => [[{ environment: 1, realmId: 1, logicalKey: 1 }, { unique: true }], [{ entity: 1, qboId: 1 }, { unique: true, partialFilterExpression: { qboId: { $type: 'string' } } }]] } } };
  h.connection = { readyState: 1, db: { listCollections: () => ({ toArray: async () => { h.calls++; return h.collections; } }), admin: () => ({ command: async () => h.hello }) } };
  h.ready = createBusinessStorageReadiness({ connection: h.connection, models: h.models, now: () => h.clock }); return h;
}
test('prepared collections, exact index order and transactional deployment pass read-only readiness', async () => {
  const h = harness(); await Promise.all([h.ready(), h.ready()]); assert.equal(h.calls, 1); await h.ready(); assert.equal(h.calls, 1);
  h.clock += 30000; await h.ready(); assert.equal(h.calls, 2);
});
test('missing collections, views, unsupported options and nontransactional deployment fail closed', async () => {
  for (const mutate of [h => { h.collections = []; }, h => { h.collections[0].type = 'view'; }, h => { h.collections[0].options = { capped: true }; }, h => { h.hello = {}; }, h => { h.connection.readyState = 0; }]) { const h = harness(); mutate(h); await assert.rejects(h.ready()); }
});
test('missing, differently ordered or weakened indexes never count as prepared', async () => {
  for (const mutate of [h => { h.indexes.pop(); }, h => { h.indexes[0].key = { realmId: 1, environment: 1, logicalKey: 1 }; }, h => { h.indexes[0].unique = false; }, h => { h.indexes[0].sparse = true; }, h => { h.indexes[0].hidden = true; }, h => { h.indexes[0].expireAfterSeconds = 0; }, h => { h.indexes[0].collation = { locale: 'en' }; }, h => { h.indexes[1].partialFilterExpression = { qboId: { $exists: true } }; }]) { const h = harness(); mutate(h); await assert.rejects(h.ready(), /index protection/); }
});
test('failed readiness retries and database changes invalidate cached inspection', async () => {
  const h = harness(); h.hello = {}; await assert.rejects(h.ready()); h.hello = { setName: 'fixture' }; await h.ready(); assert.equal(h.calls, 2);
  h.connection.db = { ...h.connection.db }; await h.ready(); assert.equal(h.calls, 3);
  h.connection.readyState = 0; await assert.rejects(h.ready()); h.connection.readyState = 1; await h.ready(); assert.equal(h.calls, 4);
});
