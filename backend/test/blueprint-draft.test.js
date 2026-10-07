'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { validateDraftInput, buildDraftDefinition, proposalView, readDraftSetup } = require('../src/modules/blueprint-draft');
const { createBlueprintDraftService, blueprintStorageReady } = require('../src/modules/blueprint-draft-store');
const BlueprintVersion = require('../src/models/BlueprintVersion');
const clone = value => JSON.parse(JSON.stringify(value));
const user = { id: '000000000000000000000001', actorId: '000000000000000000000001', role: 'supervisor' };
const context = { environment: 'sandbox', connection: { connected: true, connectionId: '000000000000000000000002', realmId: '123', companyName: 'Fixture Company' }, membership: { permissions: ['blueprint.read', 'blueprint.manage'] } };
function input() { const proposal = proposalView(); return { connectionId: context.connection.connectionId, requestKey: '11111111-1111-4111-8111-111111111111', baseHash: null, business: proposal.business, mappings: proposal.mappings }; }
function harness() {
  let data = { versions: [], sequence: null, audits: [] }, queue = Promise.resolve();
  const fixture = { currentContext: clone(context), failAudit: false, transactionCalls: 0 };
  function query(filter) {
    let descending = false;
    const q = { sort() { descending = true; return q; }, session() { return q; }, lean: async () => {
      const records = data.versions.filter(record => Object.entries(filter).every(([key, value]) => String(record[key]) === String(value)));
      if (descending) records.sort((a, b) => b.version - a.version);
      return clone(records[0] || null);
    } }; return q;
  }
  const Versions = { findOne: query, create: async (records, options) => { assert.ok(options.session); data.versions.push(...clone(records)); return clone(records); } };
  const Sequences = {
    updateOne: async (_filter, change, options) => { assert.ok(options.session); data.sequence = { value: Math.max(data.sequence?.value || 0, change.$max.value) }; },
    findOneAndUpdate: (_filter, change, options) => ({ lean: async () => { assert.ok(options.session); data.sequence.value += change.$inc.value; return clone(data.sequence); } }),
  };
  const Audits = { create: async (records, options) => { assert.ok(options.session); if (fixture.failAudit) throw new Error('audit unavailable'); data.audits.push(...clone(records)); } };
  const deps = { Versions, Sequences, Audits, resolve: async () => clone(fixture.currentContext), storageReady: async () => ({ ready: true }), transaction: work => {
    const result = queue.then(async () => { const before = clone(data); fixture.transactionCalls++; try { return await work({ fixtureSession: true }); } catch (error) { data = before; throw error; } });
    queue = result.catch(() => {}); return result;
  } };
  fixture.deps = deps; fixture.service = createBlueprintDraftService(deps); fixture.data = () => data; return fixture;
}
test('strict draft input preserves explicit unassigned mappings and approved divisions', () => {
  const value = input(); const definition = buildDraftDefinition(value);
  assert.equal(definition.calendar.timeZone, 'America/Halifax'); assert.equal(definition.divisions.length, 3);
  assert.equal(definition.mappings.operatingBank, null);
  assert.equal('initialReadyThrough' in definition.calendar, false);
  for (const mutate of [item => { item.realmId = 'other'; }, item => { item.business.openingDate = '2026-02-30'; }, item => { item.business.historicalMonths = 61; }, item => { item.mappings.salesTax = { value: '2' }; }, item => { item.business.volumeProfile = 'scale'; }]) {
    const bad = input(); mutate(bad); assert.throws(() => validateDraftInput(bad), error => error.businessPlanError === true);
  }
});
test('save inserts one immutable draft and one bounded audit; a lost-response retry reuses both', async () => {
  const h = harness(); const result = await h.service.save(user, input());
  const retry = await h.service.save(user, input());
  assert.equal(result.draft.id, retry.draft.id); assert.equal(result.draft.version, 1);
  assert.equal(h.data().versions.length, 1); assert.equal(h.data().audits.length, 1);
  assert.equal('definition' in h.data().audits[0].afterState, false);
  assert.equal(result.draft.status, 'draft'); assert.equal(result.draft.connectionMatches, true);
});
test('concurrent edits from one base cannot silently overwrite each other', async () => {
  const h = harness(); const a = input(), b = input(); b.requestKey = '22222222-2222-4222-8222-222222222222'; b.business.displayName = 'Changed Fixture';
  const results = await Promise.allSettled([h.service.save(user, a), h.service.save(user, b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(h.data().versions.length, 1);
});
test('a new revision uses the latest hash and retains prior version evidence', async () => {
  const h = harness(); const first = await h.service.save(user, input());
  const second = input(); second.requestKey = '22222222-2222-4222-8222-222222222222'; second.baseHash = first.draft.contentHash; second.business.historicalMonths = 6;
  const saved = await h.service.save(user, second);
  assert.equal(saved.draft.version, 2); assert.equal(h.data().versions[0].definition.calendar.historicalMonths, 36);
});
test('an audit failure rolls back the revision and sequence allocation together', async () => {
  const h = harness(); h.failAudit = true;
  await assert.rejects(h.service.save(user, input()), /audit unavailable/);
  assert.equal(h.data().versions.length, 0); assert.equal(h.data().sequence, null);
});
test('readonly membership and unprepared storage cannot save a draft', async () => {
  const h = harness(); h.currentContext.membership.permissions = ['blueprint.read'];
  await assert.rejects(h.service.save(user, input()), error => error.status === 403);
  assert.equal(h.transactionCalls, 0);
  h.currentContext = clone(context); h.deps.storageReady = async () => ({ ready: false, reason: 'Not prepared' });
  await assert.rejects(createBlueprintDraftService(h.deps).save(user, input()), error => error.status === 409);
  assert.equal(h.data().versions.length, 0);
});
test('same request identifier cannot save different content', async () => {
  const h = harness(); await h.service.save(user, input()); const changed = input(); changed.business.displayName = 'Different';
  await assert.rejects(h.service.save(user, changed), error => error.status === 409);
});
test('prior-connection drafts remain visible and are explicitly marked for rebinding', async () => {
  const h = harness(); await h.service.save(user, input()); h.currentContext.connection.connectionId = '000000000000000000000003';
  const view = await h.service.read(user); assert.equal(view.draft.connectionMatches, false); assert.equal(view.activated, false);
});
test('realm version allocation includes existing legacy versions', async () => {
  const h = harness(); h.data().versions.push({ _id: 'legacy', realmId: '123', version: 7, contractVersion: 1 });
  assert.equal((await h.service.save(user, input())).draft.version, 8);
});
test('setup reads are bounded master-data queries and partial reads remain incomplete', async () => {
  const calls = []; const qbo = { query: async query => { calls.push(query); if (query.includes('Account')) return { QueryResponse: { Account: [{ Id: '1', Name: 'Bank', AccountType: 'Bank', SyncToken: '0' }] } }; if (query.includes('TaxCode')) throw new Error('fixture upstream failed'); return { QueryResponse: { Preferences: [{ CurrencyPrefs: { HomeCurrency: { value: 'CAD' } } }] } }; } };
  const result = await readDraftSetup(qbo, { realmId: '123', environment: 'sandbox' });
  assert.equal(calls.length, 3); assert.ok(calls.every(query => query.startsWith('SELECT * FROM ')));
  assert.equal(result.complete, false); assert.equal(result.completeness.taxCodes, false); assert.equal(result.options.accounts[0].id, '1');
  assert.equal(JSON.stringify(result).includes('upstream failed'), false);
});
test('v2 model validates fingerprints and prevents history updates before database execution', async () => {
  const definition = buildDraftDefinition(input());
  const document = new BlueprintVersion({ realmId: '123', version: 1, contractVersion: 2, environment: 'sandbox', connectionId: context.connection.connectionId, createdBy: user.id, auditId: user.id, contentHash: hash(definition), requestHash: hash(input()), requestKey: input().requestKey, definition });
  await document.validate(); document.contentHash = hash('different'); await assert.rejects(document.validate());
  await assert.rejects(BlueprintVersion.updateOne({ realmId: '123' }, { $set: { definition } }), /append-only/);
});

test('a company change between load and save rejects an unsaved proposal before transaction', async () => {
  const h = harness(); const loaded = await h.service.read(user); const body = { ...input(), connectionId: loaded.connectionId };
  h.currentContext.connection = { ...h.currentContext.connection, connectionId: '000000000000000000000003', realmId: '456' };
  await assert.rejects(h.service.save(user, body), error => error.status === 409);
  assert.equal(h.transactionCalls, 0); assert.equal(h.data().versions.length, 0);
});
test('reconnection within one company also rejects the stale loaded form', async () => {
  const h = harness(); h.currentContext.connection.connectionId = '000000000000000000000003';
  await assert.rejects(h.service.save(user, input()), error => error.status === 409);
  assert.equal(h.data().audits.length, 0);
});
test('invalid legacy version and exhausted sequence cannot create a new revision', async () => {
  for (const version of [1.5, Number.MAX_SAFE_INTEGER]) {
    const h = harness(); h.data().versions.push({ _id: 'legacy', realmId: '123', version, contractVersion: 1 });
    await assert.rejects(h.service.save(user, input()), error => error.status === 409);
    assert.equal(h.data().audits.length, 0); assert.equal(h.data().sequence, null);
  }
  const h = harness(); h.data().sequence = { value: Number.MAX_SAFE_INTEGER };
  await assert.rejects(h.service.save(user, input()), error => error.status === 409);
  assert.equal(h.data().versions.length, 0);
});

const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { createBusinessPlanRouter } = require('../src/routes/business-plan');
async function routeFixture(dependencies, work) {
  const app = express(); app.use(express.json()); app.use('/plan', createBusinessPlanRouter(dependencies));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + jwt.sign(user, config.jwtSecret), 'Content-Type': 'application/json' };
  try { await work(async (path = '', options = {}) => fetch(base + '/plan' + path, { headers, ...options })); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
test('plan routes require authentication and reject scope or query overrides before service calls', async () => {
  let called = 0; const service = { read: async () => { called++; return {}; }, save: async () => { called++; return {}; } };
  await routeFixture({ service }, async request => {
    assert.equal((await request('', { headers: {} })).status, 401);
    assert.equal((await request('?realmId=456')).status, 400);
    assert.equal((await request('?unrecognized=1')).status, 400);
    assert.equal((await request('', { method: 'POST', body: JSON.stringify({ ...input(), environment: 'production' }) })).status, 400);
    assert.equal(called, 0);
  });
});
test('draft route domain errors keep their status and unexpected failures are sanitized', async () => {
  for (const [failure, expected] of [[Object.assign(new Error('Role cannot save'), { businessPlanError: true, status: 403 }), 403], [Object.assign(new Error('Reload newer version'), { businessPlanError: true, status: 409 }), 409], [new Error('private database detail'), 500]]) {
    await routeFixture({ service: { save: async () => { throw failure; } } }, async request => {
      const response = await request('', { method: 'POST', body: JSON.stringify(input()) });
      assert.equal(response.status, expected); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); assert.equal(JSON.stringify(body).includes('private database detail'), false);
    });
  }
});
test('setup route derives scope and maps upstream authentication failures without logging out app', async () => {
  const service = { contextFor: async (actor, permission) => { assert.equal(actor.id, user.id); assert.equal(permission, 'blueprint.read'); return context; } };
  for (const status of [401, 429]) await routeFixture({ service, qboFor: async () => { throw Object.assign(new Error('QBO fixture error'), { status, intuit_tid: 'fixture-trace' }); } }, async request => {
    const response = await request('/setup'); assert.equal(response.status, status === 401 ? 502 : 429);
    assert.equal((await response.json()).qboStatus, status);
  });
  await routeFixture({ service, qboFor: async () => ({ fixture: true }), readSetup: async (qbo, scope) => { assert.equal(qbo.fixture, true); return scope; } }, async request => {
    const response = await request('/setup'); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { realmId: '123', environment: 'sandbox', connectionId: context.connection.connectionId });
  });
});

test('storage readiness rejects partial or sparse uniqueness that leaves versions unprotected', async () => {
  const connection = { readyState: 1, db: { listCollections: () => ({ toArray: async () => [{}, {}, {}] }), admin: () => ({ command: async () => ({ setName: 'fixture' }) }) } };
  const base = { unique: true, key: { realmId: 1, version: 1 } };
  for (const index of [{ ...base, partialFilterExpression: { contractVersion: 2 } }, { ...base, sparse: true }]) {
    assert.equal((await blueprintStorageReady(connection, { name: 'blueprintversions', indexes: async () => [index] })).ready, false);
  }
  assert.equal((await blueprintStorageReady(connection, { name: 'blueprintversions', indexes: async () => [base] })).ready, true);
});

test('activity preview reads the plan but never saves or calls QuickBooks', async () => {
  let reads = 0;
  const service = { read: async () => { reads++; return { realmId: '123', environment: 'sandbox', connectionId: context.connection.connectionId, draft: null, proposal: proposalView() }; }, save: async () => { throw new Error('Unexpected write'); } };
  await routeFixture({ service, qboFor: async () => { throw new Error('Unexpected QBO request'); } }, async request => {
    const body = { connectionId: context.connection.connectionId, baseHash: null, fromDate: '2024-01-01', throughDate: '2024-01-31' };
    assert.equal((await request('/activity-preview', { method: 'POST', body: JSON.stringify({ ...body, realmId: 'other' }) })).status, 400); assert.equal(reads, 0);
    const response = await request('/activity-preview', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = (await response.json()).data; assert.equal(result.executable, false); assert.equal(result.source.kind, 'proposal');
    assert.equal(reads, 1);
  });
});


test('mapping check is read-only and rejects saved-plan or company changes during observation', async () => {
  for (const mode of ['normal', 'stale-input', 'change-plan', 'change-company', 'forged-scope']) {
    let reads = 0, qboReads = 0;
    const view = { realmId: '123', environment: 'sandbox', connectionId: context.connection.connectionId, draft: null, proposal: proposalView() };
    const service = { read: async () => { reads++; return reads > 1 && mode === 'change-plan' ? { ...view, draft: { contentHash: 'a'.repeat(64) } } : view; }, contextFor: async () => mode === 'change-company' ? { ...context, connection: { ...context.connection, realmId: '456' } } : context, save: async () => { throw new Error('Unexpected save'); } };
    await routeFixture({ service, qboFor: async () => { qboReads++; return {}; }, readSetup: async (_qbo, scope) => ({ ...scope, completeness: { accounts: true, taxCodes: true, preferences: true }, options: { accounts: [], taxCodes: [] }, observations: { homeCurrency: 'CAD' } }) }, async request => {
      const body = { connectionId: context.connection.connectionId, baseHash: mode === 'stale-input' ? 'b'.repeat(64) : null, ...(mode === 'forged-scope' ? { realmId: 'other' } : {}) };
      const response = await request('/mapping-check', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, mode === 'normal' ? 200 : mode === 'forged-scope' ? 400 : 409);
      if (mode === 'normal') { const result = (await response.json()).data; assert.equal(result.readyToActivate, false); assert.equal(result.unresolvedMappings, 12); }
      if (['stale-input', 'change-company', 'forged-scope'].includes(mode)) assert.equal(qboReads, 0);
    });
  }
});


test('master inspection checks scope and saved version and never saves or binds records automatically', async () => {
  for (const mode of ['normal', 'stale', 'switch']) {
    let reads = 0, calls = 0;
    const view = { realmId: '123', environment: 'sandbox', connectionId: context.connection.connectionId, draft: null, proposal: proposalView() };
    const service = { read: async () => { reads++; return mode === 'stale' && reads > 1 ? { ...view, draft: { contentHash: 'a'.repeat(64) } } : view; }, contextFor: async () => mode === 'switch' ? { ...context, connection: { ...context.connection, realmId: '456' } } : context, save: async () => { throw new Error('Unexpected write'); } };
    await routeFixture({ service, qboFor: async () => ({}), readMasters: async (_qbo, scope) => { calls++; return { ...scope, completeness: { Customer: true, Vendor: true, Item: true, Employee: true }, options: { Customer: [], Vendor: [], Item: [], Employee: [] } }; } }, async request => {
      const response = await request('/masters-check', { method: 'POST', body: JSON.stringify({ connectionId: context.connection.connectionId, baseHash: null }) });
      assert.equal(response.status, mode === 'normal' ? 200 : 409);
      if (mode === 'normal') { const data = (await response.json()).data; assert.equal(data.readyToExecute, false); assert.ok(data.rows.every(row => row.status === 'unassigned')); }
      if (mode === 'switch') assert.equal(calls, 0);
    });
  }
});


test('operation preparation reads bounded sources without writes and rejects stale scope and impossible dates', async () => {
  for (const mode of ['normal', 'new-version', 'scope-change', 'future']) {
    let reads = 0, setupCalls = 0, masterCalls = 0;
    const view = { realmId: '123', environment: 'sandbox', connectionId: context.connection.connectionId, draft: null, proposal: proposalView() };
    const service = { read: async () => { reads++; return mode === 'new-version' && reads > 1 ? { ...view, draft: { ...view.proposal, contentHash: 'a'.repeat(64) } } : view; }, contextFor: async () => mode === 'scope-change' ? { ...context, connection: { ...context.connection, realmId: '456' } } : context, save: async () => { throw new Error('Unexpected save'); } };
    await routeFixture({ service, qboFor: async () => ({}), readSetup: async (_qbo, scope) => { setupCalls++; return { ...scope, observedAt: new Date().toISOString(), sourceHash: hash('setup'), completeness: { accounts: true, taxCodes: true, preferences: true }, options: { accounts: [], taxCodes: [] }, observations: { homeCurrency: 'CAD' } }; }, readMasters: async (_qbo, scope) => { masterCalls++; return { ...scope, observedAt: new Date().toISOString(), sourceHash: hash('masters'), completeness: { Customer: true, Vendor: true, Item: true, Employee: true }, options: { Customer: [], Vendor: [], Item: [], Employee: [] } }; } }, async request => {
      const body = { connectionId: context.connection.connectionId, baseHash: null, fromDate: mode === 'future' ? '2199-01-01' : '2024-01-01', throughDate: mode === 'future' ? '2199-01-06' : '2024-01-06' };
      const response = await request('/operation-preview', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, mode === 'normal' ? 200 : mode === 'future' ? 400 : 409);
      if (mode === 'normal') { const data = (await response.json()).data; assert.equal(data.readyToExecute, false); assert.equal(data.persisted, false); assert.equal(setupCalls, 1); assert.equal(masterCalls, 1); }
      if (['scope-change', 'future'].includes(mode)) { assert.equal(setupCalls, 0); assert.equal(masterCalls, 0); }
    });
  }
});

test('saving older draft choices fills new control accounts as unassigned without replacing existing choices', async () => {
  const h = harness(), value = input(); value.mappings.operatingBank = '55';
  for (const key of ['accountsReceivable', 'accountsPayable', 'undepositedFunds']) delete value.mappings[key];
  const saved = await h.service.save(user, value);
  assert.equal(saved.draft.mappings.operatingBank, '55');
  for (const key of ['accountsReceivable', 'accountsPayable', 'undepositedFunds']) assert.equal(saved.draft.mappings[key], null);
  const next = input(); next.baseHash = saved.draft.contentHash; next.requestKey = '22222222-2222-4222-8222-222222222222';
  next.mappings = { ...saved.draft.mappings, accountsReceivable: '56', accountsPayable: '57', undepositedFunds: '58' };
  const revised = await h.service.save(user, next);
  assert.equal(revised.draft.mappings.accountsReceivable, '56'); assert.equal(revised.draft.mappings.accountsPayable, '57'); assert.equal(revised.draft.mappings.undepositedFunds, '58');
  assert.equal(h.data().versions[0].definition.mappings.accountsReceivable, null);
});
