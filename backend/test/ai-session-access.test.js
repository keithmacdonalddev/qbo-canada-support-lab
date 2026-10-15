'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), http = require('node:http');
const OWNER = 'a'.repeat(24), MEMBER = 'b'.repeat(24), clone = value => JSON.parse(JSON.stringify(value));
async function fixture(t, options = {}) {
  const state = { actor: options.owner ? OWNER : MEMBER, member: true, unavailable: false, accountRevoked: false, reads: [], audits: 0, screens: 0, decisions: 0, afterRead: null, afterAudit: null, ...options };
  const plan = (realm, id = 'plan-' + realm) => ({ _id: id, userId: OWNER, sessionId: 'case-' + realm, realmId: 'realm-' + realm, steps: [], status: 'completed' });
  const sessions = ['a', 'b'].map(realm => ({ _id: 'case-' + realm, userId: OWNER, realmId: 'realm-' + realm, mode: 'reproduce', status: 'completed', messages: [{ role: 'user', content: 'Private company ' + realm }], plans: [plan(realm)], reproduction: { runId: 'run-' + realm, revision: 1, decisionRevision: 0, status: 'completed', outcome: 'unverified', ownedRecords: [], conditions: [], checks: [] } }));
  state.sessions = sessions;
  const query = value => { const q = { then: (yes, no) => Promise.resolve().then(async () => { if (state.afterRead) { const fn = state.afterRead; state.afterRead = null; await fn(); } return clone(value); }).then(yes, no) }; for (const name of ['select', 'populate', 'maxTimeMS', 'lean', 'sort', 'skip', 'limit']) q[name] = () => q; return q; };
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && '$in' in value ? value.$in.includes(row[key]) : String(row[key]) === String(value));
  t.mock.method(require('../src/middleware/currentAccount'), 'loadCurrentAccount', async id => { if (state.unavailable) throw Error('Private storage failure'); return { _id: id, role: (state.accountRevoked && id === state.actor) || (state.ownerRevoked && id === OWNER) ? 'disabled' : 'supervisor', authVersion: 0, email: 'fixture@example.invalid' }; });
  const Memberships = require('../src/models/CompanyMembership');
  const members = () => state.member ? [{ userId: MEMBER, realmId: 'realm-a', status: 'active', role: 'reviewer' }] : [];
  t.mock.method(Memberships, 'findOne', filter => query(members().find(row => matches(row, filter)) || null));
  t.mock.method(Memberships, 'find', filter => query(members().filter(row => matches(row, filter))));
  const Sessions = require('../src/models/AISession');
  t.mock.method(Sessions, 'findOne', filter => { state.reads.push(filter); return query(sessions.find(row => matches(row, filter)) || null); });
  t.mock.method(Sessions, 'find', filter => { state.reads.push(filter); return query(sessions.filter(row => matches(row, filter))); });
  t.mock.method(Sessions, 'countDocuments', async filter => { state.reads.push(filter); await state.afterCount?.(); return sessions.filter(row => matches(row, filter)).length; });
  t.mock.method(require('../src/models/AIPlan'), 'findOne', filter => query(sessions.flatMap(session => session.plans).find(row => matches(row, filter)) || null));
  t.mock.method(require('../src/models/Connection'), 'findOne', () => query(null));
  t.mock.method(require('../src/middleware/auditLogger'), 'createAuditEntry', async () => { state.audits++; await state.afterAudit?.(); return { _id: 'audit' }; });
  t.mock.method(require('../src/middleware/companyPermission'), 'createCompanyPermissionGuard', () => async (req, _res, next) => { req.companyContext = { connection: { realmId: 'realm-a' } }; next(); });
  for (const action of ['approvePlan', 'rejectPlan']) t.mock.method(require('../src/modules/ai-orchestrator'), action, async () => { state.decisions++; return plan('a'); });
  t.mock.method(require('../src/modules/reproduction-screen').screenBroker, 'poll', async () => { state.screens++; await state.afterScreen?.(); return { requestId: 'screen' }; });
  t.mock.method(require('../src/modules/reproduction-screen').screenBroker, 'heartbeat', () => { state.screens++; });
  t.mock.method(require('../src/modules/ai-provider'), 'complete', async () => { throw Error('No provider calls permitted'); });
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.currentAccount = { id: state.actor, authVersion: 0, sessionExpiresAt: Date.now() + 60000 }; req.user = { id: OWNER, actorId: state.actor, scopeResolved: true }; next(); });
  const routeId = require.resolve('../src/routes/ai'), prior = require.cache[routeId]; delete require.cache[routeId];
  try { app.use('/ai', require(routeId).router); } finally { if (prior) require.cache[routeId] = prior; else delete require.cache[routeId]; }
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  state.request = async (path, body, method = body ? 'POST' : 'GET') => { const result = await fetch('http://127.0.0.1:' + server.address().port + '/ai' + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: result.status, body: await result.json() }; };
  return state;
}
test('actual session list and count are restricted to the acting member company before lookup', async t => {
  const f = await fixture(t), result = await f.request('/sessions'); assert.equal(result.status, 200); assert.equal(result.body.data.total, 1); assert.deepEqual(result.body.data.sessions.map(row => row.realmId), ['realm-a']);
  assert.ok(f.reads.every(filter => JSON.stringify(filter.realmId) === JSON.stringify({ $in: ['realm-a'] })));
});
test('actual detail, changes, note and screen routes deny another company within the same owner workspace', async t => {
  const f = await fixture(t);
  for (const [path, body] of [['/sessions/case-b'], ['/sessions/case-b/changes'], ['/sessions/case-b/screen'], ['/sessions/case-b/screen', { type: 'heartbeat', ready: true }], ['/generate-note', { sessionId: 'case-b', format: 'internal' }]]) {
    const result = await f.request(path, body); assert.equal(result.status, 403, path); assert.equal(result.body.code, 'SAVED_SESSION_ACCESS_REQUIRED'); assert.doesNotMatch(JSON.stringify(result.body), /Private company b/);
  }
  assert.equal(f.audits, 0); assert.equal(f.screens, 0);
});
test('authorized reviewer reads its own company and sees only plans from that exact case and company', async t => {
  const f = await fixture(t); f.sessions[0].plans.push(clone(f.sessions[1].plans[0]));
  const result = await f.request('/sessions/case-a'); assert.equal(result.status, 200); assert.deepEqual(result.body.data.session.plans.map(plan => plan._id), ['plan-a']);
  assert.equal((await f.request('/generate-note', { sessionId: 'case-a', format: 'internal' })).status, 200); assert.equal(f.audits, 1);
});
test('owner retains saved case and note access after a company has disconnected', async t => {
  const f = await fixture(t, { owner: true, member: false }); assert.equal((await f.request('/sessions/case-b')).status, 200);
  assert.equal((await f.request('/generate-note', { sessionId: 'case-b', format: 'internal' })).status, 200);
  assert.equal((await f.request('/sessions')).body.data.total, 2);
});
test('revoked membership or account and unavailable permission storage disclose no saved data', async t => {
  const f = await fixture(t); f.member = false; assert.equal((await f.request('/sessions/case-a')).status, 403); assert.equal((await f.request('/sessions')).body.data.total, 0);
  f.member = true; f.accountRevoked = true; assert.equal((await f.request('/sessions/case-a')).status, 403);
  f.accountRevoked = false; f.unavailable = true; const result = await f.request('/sessions/case-a'); assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result.body), /Private storage failure|Private company/);
});
test('membership revoked after an awaited note audit prevents the note response', async t => {
  const f = await fixture(t); f.afterAudit = async () => { f.member = false; };
  const result = await f.request('/generate-note', { sessionId: 'case-a', format: 'internal' }); assert.equal(result.status, 403); assert.equal(result.body.data, undefined);
});
test('same-run recovery changes invalidate a requested note identity before it can be returned', async t => {
  const f = await fixture(t), state = (await f.request('/sessions/case-a')).body.data.session, evidence = require('../src/modules/ai-notes').caseNoteEvidence(state);
  f.afterAudit = async () => { f.sessions[0].reproduction.decisionRevision++; f.sessions[0].reproduction.ownedRecords.push({ entityType: 'Invoice', id: 'recovered' }); };
  const result = await f.request('/generate-note', { sessionId: 'case-a', format: 'internal', evidence }); assert.equal(result.status, 409); assert.equal(result.body.data, undefined);
});
test('legacy plan decisions reject another company before exposing or changing the plan', async t => {
  const f = await fixture(t); for (const action of ['approve', 'reject']) assert.equal((await f.request('/plan/plan-b/' + action, {})).status, 403);
  assert.equal(f.decisions, 0);
  f.actor = OWNER; assert.equal((await f.request('/plan/plan-b/approve', {})).status, 409); assert.equal(f.decisions, 0);
});

test('list and screen responses recheck membership after awaited work', async t => {
  const f = await fixture(t); f.afterCount = async () => { f.member = false; };
  const listed = await f.request('/sessions'); assert.equal(listed.status, 403); assert.equal(listed.body.data, undefined);
  f.member = true; f.afterScreen = async () => { f.member = false; };
  const screen = await f.request('/sessions/case-a/screen'); assert.equal(screen.status, 403); assert.equal(screen.body.data, undefined);
});
test('an unavailable workspace owner denies a member even when its exact membership remains active', async t => {
  const f = await fixture(t, { ownerRevoked: true }); assert.equal((await f.request('/sessions/case-a')).status, 403); assert.equal((await f.request('/sessions')).status, 403);
});

test('legacy chat and investigation reject reproduction sessions without altering the original request', async t => {
  const f = await fixture(t), original = clone(f.sessions[0]);
  for (const path of ['/chat', '/investigate']) {
    const result = await f.request(path, { sessionId: 'case-a', message: 'Untracked amendment', question: 'Untracked amendment', mode: 'investigate' });
    assert.equal(result.status, 409, path); assert.match(result.body.error, /reproduction case endpoint/);
  }
  f.sessions[0].mode = 'investigate';
  assert.equal((await f.request('/investigate', { sessionId: 'case-a', question: 'State marker must also be protected' })).status, 409);
  assert.deepEqual(f.sessions[0].messages, original.messages); assert.deepEqual(f.sessions[0].reproduction, original.reproduction); assert.equal(f.audits, 0);
});
test('orchestrator internal chat, investigation and note entrypoints also reject reproduction state before providers or saves', async t => {
  const f = await fixture(t), orchestrator = require('../src/modules/ai-orchestrator');
  f.sessions[0].status = 'active';
  t.mock.method(require('../src/models/AISession'), 'findById', async () => clone(f.sessions[0]));
  const original = clone(f.sessions[0]);
  for (const mode of ['reproduce', 'investigate']) {
    f.sessions[0].mode = mode;
    await assert.rejects(orchestrator.chat(OWNER, 'realm-a', 'case-a', 'Untracked amendment'), { status: 409 });
    await assert.rejects(orchestrator.investigate(OWNER, 'realm-a', 'case-a', 'Untracked amendment'), { status: 409 });
    await assert.rejects(orchestrator.generateNote('case-a'), { status: 409 });
  }
  assert.deepEqual(f.sessions[0].messages, original.messages); assert.deepEqual(f.sessions[0].reproduction, original.reproduction); assert.equal(f.audits, 0);
});
