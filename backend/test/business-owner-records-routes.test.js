'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), jwt = require('jsonwebtoken');
const path = require('node:path'), fs = require('node:fs'), Module = require('node:module');
let routes;
if (process.env.OWNER_RECORD_ROUTE_CANDIDATE) {
  const filename = path.resolve(__dirname, '../src/routes/business-agent.js'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(process.env.OWNER_RECORD_ROUTE_CANDIDATE, 'utf8'), filename); routes = mod.exports;
} else routes = require('../src/routes/business-agent');
const config = require('../src/config');
const owner = 'a'.repeat(24), member = 'b'.repeat(24), runId = 'c'.repeat(24), scope = { environment: 'production', realmId: '123456', connectionId: 'd'.repeat(24) };
async function server(work) {
  const events = [], calls = [], saved = { _id: runId, ...scope, ownerId: owner, actorId: owner, agentAuthority: null, contract: 'general-write-v1', status: 'prepared', batches: [], plan: { operations: [{ op: 'create', entity: 'Invoice' }] }, items: {} };
  let missing = false, failAudit = false, failExecute = false;
  const records = {
    resolveContext: async () => ({ environment: scope.environment, connection: { connected: true, ...scope, companyName: 'Fixture business' } }),
    accessFor: identity => ({ authorize: async (actual, action) => { assert.deepEqual(actual, scope); assert.deepEqual(identity, { ownerId: owner, actorId: owner }); calls.push(action); } }),
    policyFor: async () => ({ taxCodes: { sales: ['2'], purchases: ['3'] } }),
    Runs: { findOne(filter) { calls.push({ filter }); return { maxTimeMS() { return this; }, lean: async () => !missing && Object.entries(filter).every(([key, value]) => saved[key] === value) ? structuredClone(saved) : null }; } },
    audit: async entry => { if (failAudit) throw Error('Storage failed with secret-token-value'); events.push(entry); },
    queryFor: bound => ({ run: async input => { assert.deepEqual(bound.scope, scope); calls.push(input); return { data: { rows: [{ entity: 'Invoice', id: '55', Balance: 100 }], nextCursor: 'next' } }; } }),
    generalFor: bound => ({ dispatchEnabled: () => true,
      prepare: async (_bound, input) => { assert.equal(require('../src/modules/actor-context').currentActorId(), owner); assert.equal(bound.ownerId, owner); calls.push({ prepare: input }); if (input.purpose === 'refuse this record') return { status: 'refused', runId: null, problems: [{ ref: 'owner-record', message: 'Tax code not allowed' }] }; return { status: 'prepared', runId, plan: { operations: 1, batches: 1, exposureCents: 10000 } }; },
      execute: async (_bound, id) => { assert.equal(require('../src/modules/actor-context').currentActorId(), owner); assert.equal(events.at(-1).action, 'Owner requested QuickBooks record execution'); calls.push({ execute: id }); if (failExecute) throw Object.assign(Error('Business guard refused'), { code: 'GENERAL_WRITE_REFUSED', status: 409 }); saved.status = 'complete'; saved.items = { 'owner-record': { outcome: 'saved', entity: 'Invoice', qboId: '99', record: { Id: '99', DocNumber: 'INV-99', TotalAmt: 100 } } }; return { status: 'complete', runId, items: { 'owner-record': { outcome: 'saved', entity: 'Invoice', qboId: '99' } } }; } }),
  };
  const app = express(); app.use(express.json()); app.use(require('../src/middleware/companyScope').createCompanyScope({ databaseReady: () => true, hasOwnActiveConnection: async id => id === owner, memberRealms: async () => [scope.realmId], activeConnectionFor: async () => ({ userId: owner }) })); app.use('/agent', routes.createBusinessAgentRouter({ records, service: () => ({}) }));
  const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  async function call(endpoint, body, actor = owner) { const response = await fetch('http://127.0.0.1:' + listener.address().port + '/agent/records' + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: 'Bearer ' + jwt.sign({ id: actor, actorId: actor, role: 'supervisor' }, config.jwtSecret) } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() }; }
  try { await work({ call, events, calls, saved, records, missing: value => { missing = value; }, failAudit: value => { failAudit = value; }, failExecute: value => { failExecute = value; } }); }
  finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
}
const input = { decisionKey: 'owner-create-record-001', purpose: 'Owner recorded a genuine business event.', operations: [{ ref: 'owner-record', op: 'create', entity: 'Invoice', payload: { CustomerRef: { value: '1' }, TxnDate: '2026-10-31', Line: [] } }] };
test('owner catalog and guided choices use server company scope and shared create schemas', () => server(async ({ call, calls }) => {
  const catalog = await call('/options'); assert.equal(catalog.status, 200); assert.equal(catalog.cache, 'no-store'); assert.deepEqual(catalog.body.data.scope, scope); assert.ok(catalog.body.data.schemas.some(row => row.entity === 'Invoice' && row.publishedTaxCodes[0] === '2')); assert.ok(!catalog.body.data.schemas.some(row => row.entity === 'Preferences'));
  const choices = await call('/choices', { entity: 'Invoice', partyId: '1' }); assert.equal(choices.status, 200); assert.equal(choices.body.data.rows[0].Balance, 100); const query = calls.find(row => row.mode === 'find'); assert.ok(query.where.some(row => row.field === 'Balance' && row.op === 'gt')); assert.ok(query.where.some(row => row.field === 'CustomerRef.value' && row.value === '1'));
}));
test('prepare and execute are separate, owner-attributed and audited, with saved QBO result', () => server(async ({ call, events, calls }) => {
  const prepared = await call('/prepare', input); assert.equal(prepared.status, 200); assert.equal(prepared.body.data.runId, runId); assert.ok(!calls.some(row => row.execute)); assert.equal(events[0].aiDriven, false); assert.equal(events[0].actorUserId, owner); assert.equal(events[0].tool, 'manageQboRecord');
  assert.equal((await call('/execute', { runId })).status, 400); assert.ok(!calls.some(row => row.execute)); const result = await call('/execute', { runId, confirmProduction: true }); assert.equal(result.status, 200); assert.equal(result.body.data.records[0].record.Id, '99'); const sends = calls.filter(row => row.execute).length; const recovered = await call('/result/' + runId); assert.equal(recovered.status, 200); assert.equal(recovered.body.data.status, 'complete'); assert.equal(recovered.body.data.records[0].record.Id, '99'); assert.equal(calls.filter(row => row.execute).length, sends, 'recover reads do not send'); assert.ok(calls.includes('operations.execute'));
}));
test('authentication, nonowners, scope overrides and non-create requests fail before general preparation', () => server(async ({ call, calls }) => {
  assert.equal((await call('/options', undefined, null)).status, 401); assert.equal((await call('/options', undefined, member)).status, 403); assert.equal((await call('/options?limit=100')).status, 400);
  for (const body of [{ ...input, ownerId: member }, { ...input, realmId: '987' }, { ...input, operations: [{ ...input.operations[0], op: 'update' }] }, { ...input, operations: [...input.operations, ...input.operations] }]) assert.equal((await call('/prepare', body)).status, 400);
  assert.ok(!calls.some(row => row.prepare)); assert.equal((await call('/choices', { entity: 'Invoice', partyId: { $ne: '1' } })).status, 400);
}));
test('refused guards stay visible; foreign, agent and broader retained runs cannot dispatch', () => server(async ({ call, calls, saved }) => {
  const refused = await call('/prepare', { ...input, purpose: 'refuse this record' }); assert.equal(refused.status, 200); assert.equal(refused.body.data.problems[0].message, 'Tax code not allowed');
  for (const [key, value] of [['connectionId', 'e'.repeat(24)], ['ownerId', member], ['actorId', member], ['agentAuthority', { grantId: 'not-owner' }], ['contract', 'other-contract'], ['plan', { operations: [{ op: 'delete', entity: 'Invoice' }] }]]) { const before = saved[key]; saved[key] = value; assert.equal((await call('/execute', { runId, confirmProduction: true })).status, 404, key); saved[key] = before; }
  assert.ok(!calls.some(row => row.execute));
}));
test('audit failure prevents dispatch and hidden failures are sanitized; general guard errors remain actionable', () => server(async ({ call, calls, failAudit, failExecute }) => {
  failAudit(true); let response = await call('/execute', { runId, confirmProduction: true }); assert.equal(response.status, 500); assert.ok(!JSON.stringify(response.body).includes('secret-token-value')); assert.ok(!calls.some(row => row.execute));
  failAudit(false); failExecute(true); response = await call('/execute', { runId, confirmProduction: true }); assert.equal(response.status, 409); assert.equal(response.body.error, 'Business guard refused');
}));

test('only definitely unsent or definitively rejected create plans can be replaced', () => server(async ({ call, saved }) => {
 saved.status = 'needs-correction'; assert.equal((await call('/result/' + runId)).body.data.safeToReplace, true);
 saved.batches = [{ state: 'lost' }]; assert.equal((await call('/result/' + runId)).body.data.safeToReplace, false);
 saved.batches = [{ state: 'answered' }]; saved.items = { 'owner-record': { outcome: 'rejected', entity: 'Invoice' } }; assert.equal((await call('/result/' + runId)).body.data.safeToReplace, true);
 saved.items['owner-record'].outcome = 'unknown'; assert.equal((await call('/result/' + runId)).body.data.safeToReplace, false);
 saved.status = 'unknown'; assert.equal((await call('/result/' + runId)).body.data.safeToReplace, false);
 assert.equal((await call('/result/' + runId, undefined, member)).status, 403);
}));
