'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessRuntimeAccess, ACTIONS } = require('../src/modules/business-runtime-access');
const actorId = 'a'.repeat(24), ownerId = 'b'.repeat(24), connectionId = 'c'.repeat(24);
const scope = { realmId: '123', environment: 'sandbox', connectionId };
const clone = value => structuredClone(value);
function harness(shared = true) {
  const actor = shared ? actorId : ownerId;
  const h = { reads: [], clients: 0, environment: 'sandbox', data: {
    Users: [{ _id: actorId, role: 'agent' }, { _id: ownerId, role: 'supervisor' }],
    Connections: [{ _id: connectionId, userId: ownerId, realmId: '123', status: 'active', updatedAt: 1, accessToken: 'fixture-access', refreshToken: 'fixture-refresh' }],
    Memberships: [{ _id: 'd'.repeat(24), userId: actor, realmId: '123', status: 'active', role: 'lab-owner', permissionOverrides: [] }],
  } };
  h.models = Object.fromEntries(Object.keys(h.data).map(name => [name, { findOne(filter) {
    let projection, session, sort, timeout;
    const exec = async () => {
      h.reads.push({ name, filter, projection, session, sort, timeout });
      let rows = h.data[name].filter(row => Object.entries(filter).every(([key, value]) => row[key] === value));
      if (sort) rows = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
      let row = clone(rows[0] || null);
      if (row && projection) row = Object.fromEntries(projection.split(' ').filter(key => key in row).map(key => [key, row[key]]));
      if (h.afterRead) h.afterRead(name, projection);
      return row;
    };
    const q = { select(value) { projection = value; return q; }, session(value) { session = value; return q; }, sort(value) { sort = value; return q; }, maxTimeMS(value) { timeout = value; return q; }, lean: exec, then(resolve, reject) { return exec().then(resolve, reject); } }; return q;
  } }]));
  h.createClient = async connection => { h.clients++; if (h.onClient) h.onClient(); return { realmId: connection.realmId, connection, apiBase: 'https://sandbox-quickbooks.api.intuit.com/v3/company/' + connection.realmId }; };
  h.access = createBusinessRuntimeAccess({ actorId: actor, ownerId, ...h.models, environment: () => h.environment, createClient: h.createClient });
  return h;
}
test('explicit company owner membership authorizes each internal execution action', async () => {
  const h = harness(false);
  for (const action of Object.keys(ACTIONS)) { const result = await h.access.authorize(scope, action); assert.equal(result.actorId, ownerId); assert.equal(result.ownerId, ownerId); assert.equal(result.source, 'company-membership'); }
  assert.ok(h.reads.every(read => read.projection && !/Token|password|ApiKey/.test(read.projection) && read.timeout === 3000)); assert.equal(h.clients, 0);
});
test('shared company actor is preserved without borrowing the owner role', async () => {
  const h = harness(); const result = await h.access.authorize(scope, 'operations.execute'); assert.equal(result.actorId, actorId); assert.equal(result.ownerId, ownerId);
  h.data.Memberships[0].role = 'support-agent'; await assert.rejects(h.access.authorize(scope, 'operations.execute'), /permission/);
  assert.equal((await h.access.authorize(scope, 'operations.read')).actorId, actorId);
});
test('operators can preview but cannot execute, settle, verify, recover or stop operations', async () => {
  const h = harness(); h.data.Memberships[0].role = 'operator';
  await h.access.authorize(scope, 'operations.preview');
  for (const action of ['operations.execute', 'operations.record', 'operations.verify', 'operations.recover', 'operations.stop']) await assert.rejects(h.access.authorize(scope, action), /permission/);
});
test('legacy owner role retains read access only and never grants execution', async () => {
  const h = harness(false); h.data.Memberships = [];
  assert.equal((await h.access.authorize(scope, 'operations.read')).source, 'legacy-role-bridge');
  assert.equal((await h.access.authorize(scope, 'baseline.read')).source, 'legacy-role-bridge');
  assert.equal((await h.access.authorize(scope, 'baseline.review')).source, 'legacy-role-bridge');
  for (const action of Object.keys(ACTIONS).filter(action => !['operations.read', 'baseline.read', 'baseline.review'].includes(action))) await assert.rejects(h.access.authorize(scope, action), /permission/);
});
test('suspended or retired memberships cannot fall back to legacy owner access', async () => {
  for (const status of ['suspended', 'retired']) { const h = harness(false); h.data.Memberships[0].status = status; await assert.rejects(h.access.authorize(scope, 'operations.read'), /membership/); }
});
test('removed shared membership, actor or owner blocks access without reading tokens', async () => {
  for (const mutate of [h => { h.data.Memberships = []; }, h => { h.data.Users = h.data.Users.filter(row => row._id !== actorId); }, h => { h.data.Users = h.data.Users.filter(row => row._id !== ownerId); }]) {
    const h = harness(); mutate(h); await assert.rejects(h.access.resolveClient(scope)); assert.equal(h.clients, 0); assert.ok(h.reads.every(read => read.projection));
  }
});
test('reconnection, company change, inactive connection and environment change reject old scope', async () => {
  for (const mutate of [h => { h.data.Connections[0]._id = 'e'.repeat(24); }, h => { h.data.Connections[0].realmId = '456'; }, h => { h.data.Connections[0].status = 'revoked'; }, h => { h.environment = 'production'; }, h => { h.data.Connections.push({ ...h.data.Connections[0], _id: 'e'.repeat(24), realmId: '456', updatedAt: 2 }); }]) {
    const h = harness(); mutate(h); await assert.rejects(h.access.authorize(scope, 'operations.execute')); assert.equal(h.clients, 0);
  }
});
test('shared actor gaining its own company follows the current workspace selection rule', async () => {
  const h = harness(); h.data.Connections.push({ _id: 'e'.repeat(24), userId: actorId, realmId: '456', status: 'active', updatedAt: 2 });
  await assert.rejects(h.access.authorize(scope, 'operations.read'), /own company/);
});
test('permissions are reread, invalid overrides fail closed, absent legacy override arrays stay compatible', async () => {
  const h = harness(); h.data.Memberships[0].role = 'operator';
  h.data.Memberships[0].permissionOverrides = ['operations.execute']; await h.access.authorize(scope, 'operations.execute');
  h.data.Memberships[0].permissionOverrides = []; await assert.rejects(h.access.authorize(scope, 'operations.execute'));
  h.data.Memberships[0].permissionOverrides = ['operations.recover']; await assert.rejects(h.access.authorize(scope, 'operations.read'), /invalid/);
  delete h.data.Memberships[0].permissionOverrides; await h.access.authorize(scope, 'operations.preview');
});
test('caller session is passed to all authorization reads with no writes', async () => {
  const h = harness(), session = { inTransaction: () => true }; await h.access.authorize(scope, 'operations.execute', { session });
  assert.ok(h.reads.length > 3); assert.ok(h.reads.every(read => read.session === session));
});
test('unknown actions cannot widen authority or perform database reads', async () => {
  const h = harness(); for (const action of ['toString', '__proto__', 'operations.delete', null, {}]) await assert.rejects(h.access.authorize(scope, action)); assert.equal(h.reads.length, 0);
});
test('client resolution rereads authority after creation and never returns credentials in authority', async () => {
  const h = harness(); const authority = await h.access.authorize(scope, 'operations.read'); assert.doesNotMatch(JSON.stringify(authority), /fixture-access|fixture-refresh/);
  const client = await h.access.resolveClient(scope); assert.equal(client.connection._id, connectionId); assert.equal(h.clients, 1);
  const changed = harness(); changed.onClient = () => { changed.data.Memberships[0].status = 'suspended'; }; await assert.rejects(changed.access.resolveClient(scope), /membership/);
});
test('changed connection during token-document read cannot produce a usable client', async () => {
  const h = harness(); h.afterRead = (name, projection) => { if (name === 'Connections' && !projection) h.data.Connections[0].status = 'revoked'; };
  await assert.rejects(h.access.resolveClient(scope), /connection/);
});
test('cancellation before access and after a read never returns a client', async () => {
  const h = harness(), before = new AbortController(); before.abort(); await assert.rejects(h.access.resolveClient(scope, { signal: before.signal }), /cancelled/); assert.equal(h.reads.length, 0);
  const g = harness(), after = new AbortController(); g.afterRead = () => after.abort(); await assert.rejects(g.access.resolveClient(scope, { signal: after.signal }), /cancelled/); assert.equal(g.clients, 0);
});

test('baseline capture needs explicit report and blueprint authority without operation execution', async () => {
  const h = harness(); h.data.Memberships[0].role = 'reviewer';
  await h.access.authorize(scope, 'baseline.read');
  await assert.rejects(h.access.authorize(scope, 'baseline.capture'), /permission/);
  h.data.Memberships[0].permissionOverrides = ['reports.validate', 'blueprint.manage', 'qbo_data.read'];
  await h.access.authorize(scope, 'baseline.capture');
  await assert.rejects(h.access.authorize(scope, 'operations.verify'), /permission/);
  await assert.rejects(h.access.authorize(scope, 'operations.execute'), /permission/);
  for (const permission of ['reports.validate', 'blueprint.manage', 'qbo_data.read']) {
    h.data.Memberships[0].permissionOverrides = ['reports.validate', 'blueprint.manage', 'qbo_data.read'].filter(value => value !== permission);
    await assert.rejects(h.access.authorize(scope, 'baseline.capture'), /permission/);
  }
});

test('inventory review needs QBO data read without granting capture or execution', async () => {
  const h = harness(); h.data.Memberships[0].role = 'reviewer';
  await h.access.authorize(scope, 'baseline.read'); await assert.rejects(h.access.authorize(scope, 'baseline.review'), /permission/);
  h.data.Memberships[0].permissionOverrides = ['qbo_data.read']; await h.access.authorize(scope, 'baseline.review');
  await assert.rejects(h.access.authorize(scope, 'baseline.capture'), /permission/); await assert.rejects(h.access.authorize(scope, 'operations.execute'), /permission/);
});
