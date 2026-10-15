'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunner } = require('../src/modules/reproduction-runner');
const copy = (value) => JSON.parse(JSON.stringify(value));
const get = (obj, path) => path.split('.').reduce((v, key) => v?.[key], obj);
function set(obj, path, value) {
  const keys = path.split('.');
  let parent = obj;
  for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
  parent[keys.at(-1)] = copy(value);
}
function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((part) => matches(doc, part));
    if (key === '$and') return value.every((part) => matches(doc, part));
    const actual = get(doc, key);
    if (value === null) return actual === null || actual === undefined;
    if (value && typeof value === 'object') {
      if ('$ne' in value) return actual !== value.$ne;
      if ('$in' in value) return value.$in.includes(actual);
      if ('$exists' in value) return (actual !== undefined) === value.$exists;
      if ('$lt' in value) return actual !== undefined && actual !== null && new Date(actual) < new Date(value.$lt);
    }
    return String(actual) === String(value);
  });
}
function memoryModel(kind) {
  const store = new Map();
  let sequence = 0;
  const doc = (data) => data && Object.assign(copy(data), {
    markModified(key) { this.marked = key; },
    isModified(key) { return key === 'messages' || key === 'title'; },
    async save() {
      const plain = Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function'));
      if (kind === 'session') {
        const saved = store.get(this._id);
        saved.messages = copy(this.messages); saved.title = this.title;
        if (this.marked === 'reproduction') saved.reproduction = copy(this.reproduction);
      } else store.set(this._id, copy(plain));
      return this;
    },
  });
  const query = (value) => { const promise = Promise.resolve(doc(value)); promise.select = () => promise; promise.session = () => promise; return promise; };
  const update = (entry, operation) => {
    for (const [key, value] of Object.entries(operation.$set || {})) set(entry, key, value);
    for (const [key, value] of Object.entries(operation.$push || {})) (entry[key] ||= []).push(copy(value));
    for (const [key, value] of Object.entries(operation.$addToSet || {})) {
      if (!(entry[key] ||= []).some((v) => String(v) === String(value))) entry[key].push(copy(value));
    }
  };
  return {
    store, hook: null,
    async create(value) { if (Array.isArray(value)) return Promise.all(value.map(row => this.create(row))); const entry = { _id: kind + '-' + ++sequence, plans: [], messages: [], ...copy(value) }; store.set(entry._id, entry); return doc(entry); },
    findOne(filter) { return query([...store.values()].find((value) => matches(value, filter))); },
    findById(id) { return query(store.get(String(id))); },
    async findOneAndUpdate(filter, operation) {
      const entry = [...store.values()].find((value) => matches(value, filter));
      if (!entry) return null;
      update(entry, operation);
      return doc(entry);
    },
    async updateOne(filter, operation) {
      if (this.hook) await this.hook(filter, operation);
      const entry = [...store.values()].find((value) => matches(value, filter));
      if (!entry) return { matchedCount: 0 };
      update(entry, operation); return { matchedCount: 1 };
    },
    async updateMany(filter, operation) { for (const entry of store.values()) if (matches(entry, filter)) update(entry, operation); },
  };
}
function setup(options = {}) {
  const AISession = memoryModel('session');
  const AIPlan = memoryModel('plan');
  const config = { qbo: { environment: 'production' } };
  const connection = { _id: 'connection-1', userId: 'owner', realmId: 'realm', status: 'active', companyName: 'Fixture company' };
  let membership = options.membership;
  let starts = 0;
  const accounts = new Map();
  const account = id => accounts.has(id) ? accounts.get(id) : { _id:id, email: `${id}@fixture.invalid`, role: 'agent', authVersion:0 };
  const runner = createRunner({
    admitJob: options.admitJob || (async (_connection, _action, work) => work(null)),
    AISession, AIPlan, config, instance: 'test-instance',
    // null selects the runner's default provider check.
    preflight: options.preflight === undefined ? async () => null : options.preflight,
    ...(options.providerDependencies || {}),
    Connection: { findOne: async () => connection, exists: async () => connection.status === 'active' },
    CompanyMembership: { findOne: async () => membership },
    User: { findById: id => { const query = Promise.resolve(account(String(id))); query.select = () => query; query.maxTimeMS = () => query; return query; } },
    createQBOClient: async () => ({}), createAuditEntry: async () => ({ id: 'audit' }),
    runEngine: options.runEngine || (async ({ state, assertActive, persist }) => {
      starts += 1;
      await assertActive();
      state.status = 'completed'; state.summary = 'Fixture complete'; state.outcome = 'unverified';
      await persist();
    }),
  });
  const start = (extra = {}) => runner.startCase({ userId: 'owner', actorId: 'owner', connection,
    message: 'Recreate the customer scenario', requestId: 'request-123456789', ...extra });
  return { runner, start, AISession, AIPlan, config, connection, setAccount: (id, value) => accounts.set(id, value), setMembership: (m) => { membership = m; }, get starts() { return starts; } };
}

test('duplicate submissions share one case and one execution', async () => {
  const f = setup();
  const first = await f.start();
  const second = await f.start();
  await f.runner.waitForIdle(first._id);
  assert.equal(first._id, second._id);
  assert.equal(f.AISession.store.size, 1);
  assert.equal(f.starts, 1);
});

test('continuation cannot rebind case record ownership to another environment or connection', async () => {
  const f = setup();
  const first = await f.start();
  await f.runner.waitForIdle(first._id);
  f.config.qbo.environment = 'sandbox';
  await assert.rejects(() => f.start({ sessionId: first._id, requestId: 'request-123456780' }), /original connection and environment/);
  f.config.qbo.environment = 'production';
  f.connection._id = 'connection-2';
  await assert.rejects(() => f.start({ sessionId: first._id, requestId: 'request-123456781' }), /original connection and environment/);
  assert.equal(f.starts, 1);
});

test('a stop arriving between claim and initialization cannot be overwritten', async () => {
  const f = setup();
  let stopped = false;
  f.AISession.hook = async (filter, update) => {
    if (stopped || !update.$push?.messages) return;
    stopped = true;
    await f.runner.stopCase('owner', filter._id);
  };
  const started = await f.start();
  await f.runner.waitForIdle(started._id);
  const saved = f.AISession.store.get(started._id);
  assert.equal(saved.reproduction.stopRequested, true);
  assert.equal(saved.reproduction.status, 'stopped');
  assert.match(saved.reproduction.summary, /Stopped at your request/);
});

test('review-only membership cannot launch a reproduction; permitted membership is rechecked', async () => {
  const f = setup({ membership: { role: 'reviewer', permissionOverrides: [] } });
  await assert.rejects(() => f.start({ actorId: 'member' }), /cannot run reproductions/);
  assert.equal(f.AISession.store.size, 0);
  f.setMembership({ role: 'support-agent', permissionOverrides: [] });
  const started = await f.start({ actorId: 'member' });
  await f.runner.waitForIdle(started._id);
  assert.equal(f.starts, 1);
  f.setMembership(null);
  await assert.rejects(() => f.start({ sessionId: started._id, actorId: 'member', requestId: 'request-123456782' }), /cannot run reproductions/);
});

test('expired interrupted run with confirmed receipts can continue without repeating a create', async () => {
  const f = setup();
  const first = await f.start();
  await f.runner.waitForIdle(first._id);
  const saved = f.AISession.store.get(first._id);
  const plan = f.AIPlan.store.get(saved.reproduction.planId);
  plan.steps = [{ stepNumber: 1, toolName: 'createRecord', toolInput: { entityType: 'Bill' },
    status: 'completed', result: { data: { id: '123' } } }];
  saved.reproduction.status = 'running'; saved.reproduction.instance = 'previous-server'; saved.reproduction.leaseExpiresAt = '2000-01-01';
  saved.reproduction.ownedRecords = [];
  await f.start({ sessionId: first._id, requestId: 'request-123456783' });
  await f.runner.waitForIdle(first._id);
  assert.deepEqual(f.AISession.store.get(first._id).reproduction.ownedRecords, [{ entityType: 'Bill', id: '123', stepNumber: 1 }]);
  assert.equal(f.AIPlan.store.size, 1);
});

test('interrupted run with an in-flight write cannot be replayed', async () => {
  const f = setup();
  const first = await f.start();
  await f.runner.waitForIdle(first._id);
  const saved = f.AISession.store.get(first._id);
  f.AIPlan.store.get(saved.reproduction.planId).steps = [{ status: 'executing' }];
  saved.reproduction.status = 'running'; saved.reproduction.instance = 'previous-server'; saved.reproduction.leaseExpiresAt = '2000-01-01';
  await assert.rejects(() => f.start({ sessionId: first._id, requestId: 'request-123456784' }), /unresolved external write/);
});

test('continuation preserves old observations and reconstructs revision from durable writes', async () => {
  let continued;
  const f = setup({ runEngine: async ({ state, persist }) => {
    continued = copy(state);
    state.status = 'completed';
    await persist();
  } });
  const first = await f.start();
  await f.runner.waitForIdle(first._id);
  const saved = f.AISession.store.get(first._id);
  const plan = f.AIPlan.store.get(saved.reproduction.planId);
  plan.steps = [
    { stepNumber: 1, toolName: 'createRecord', toolInput: { entityType: 'Bill' }, status: 'completed', result: { data: { id: '123' } } },
    { stepNumber: 2, toolName: 'updateRecord', toolInput: { entityType: 'Bill', id: '123' }, status: 'completed', result: { data: { id: '123' } } },
  ];
  saved.reproduction.revision = 1;
  saved.reproduction.checks = [{ label: 'Old quantity', revision: 1, available: true, passed: true }];
  await f.start({ sessionId: first._id, requestId: 'request-123456785' });
  await f.runner.waitForIdle(first._id);
  assert.deepEqual(continued.checks, [{ label: 'Old quantity', revision: 1, available: true, passed: true }]);
  assert.equal(continued.revision, 2);
});

test('provider failure after confirmed historical writes does not make their outcome unknown', async () => {
  let runs = 0;
  const f = setup({ runEngine: async ({ state, plan, persist }) => {
    if (++runs === 1) {
      plan.steps.push({ stepNumber: 1, toolName: 'createRecord', toolInput: { entityType: 'Bill' },
        status: 'completed', result: { data: { id: '123' } } });
      await persist();
      throw new Error('Provider unavailable');
    }
    state.status = 'completed';
    await persist();
  } });
  const first = await f.start();
  await f.runner.waitForIdle(first._id);
  const saved = f.AISession.store.get(first._id);
  assert.equal(saved.reproduction.status, 'stopped');
  assert.equal(saved.reproduction.outcomeUnknown, false);
  await f.start({ sessionId: first._id, requestId: 'request-123456786' });
  await f.runner.waitForIdle(first._id);
  assert.equal(runs, 2);
  assert.equal(f.AIPlan.store.get(saved.reproduction.planId).steps.length, 1);
});

test('a case cannot start a run while the owner is deciding a change to an existing record', async () => {
  const f = setup();
  const first = await f.start();
  await f.runner.waitForIdle(first._id);
  f.AISession.store.get(first._id).reproduction.decisionLockUntil = new Date(Date.now() + 60000).toISOString();
  await assert.rejects(() => f.start({ sessionId: first._id, requestId: 'request-123456782' }), /being decided/);
  f.AISession.store.get(first._id).reproduction.decisionLockUntil = new Date(Date.now() - 1000).toISOString();
  const resumed = await f.start({ sessionId: first._id, requestId: 'request-123456783' });
  await f.runner.waitForIdle(resumed._id);
  assert.equal(f.starts, 2);
});

test('provider timeout drains a confirmed write before durable reconciliation and continuation', async () => {
  const { providerTimeout } = require('../src/modules/ai-provider-timeout');
  let drained = false; let modelCalls = 0; let execute;
  const f = setup({ providerDependencies: {
    aiProvider: { resolveProvider: async () => 'codex' },
    createToolSession: (options) => { execute = options.execute; return { bridge: {}, close: async () => { await execute(); drained = true; } }; },
    codexCli: { run: async ({ timeoutMs }) => { assert.ok(timeoutMs > 0 && timeoutMs <= 300000); modelCalls++; throw providerTimeout('Codex', timeoutMs); } },
  }, runEngine: async ({ state, plan, persist, runModel, confirmContinuation }) => {
    await assert.rejects(() => runModel([], async () => {
      plan.steps.push({ stepNumber: 1, status: 'completed', result: { data: { id: '1' } } });
      await persist();
    }, [], { deadline: Date.now() + 50000 }), /did not finish/);
    assert.equal(drained, true);
    await confirmContinuation();
    state.status = 'completed'; state.summary = 'Confirmed after draining';
  } });
  const started = await f.start(); await f.runner.waitForIdle(started._id);
  assert.equal(modelCalls, 1);
  assert.equal(f.AISession.store.get(started._id).reproduction.summary, 'Confirmed after draining');
});
test('continuation rejects missing durable receipts and a stop during provider drain', async () => {
  for (const stop of [false, true]) {
    const f = setup({ runEngine: async ({ state, plan, confirmContinuation }) => {
      if (stop) await f.runner.stopCase('owner', [...f.AISession.store.keys()][0]);
      else plan.steps.push({ stepNumber: 1, status: 'completed', result: { data: { id: 'unsaved' } } });
      await assert.rejects(confirmContinuation, stop ? /Stopped at your request/ : /could not be reconciled/);
      state.status = 'completed'; state.summary = 'Refused unsafe continuation';
    } });
    const started = await f.start(); await f.runner.waitForIdle(started._id);
    assert.equal(f.AISession.store.get(started._id).reproduction.summary, 'Refused unsafe continuation');
  }
});

test('continuation preserves first request timing and clears the prior finish before execution', async () => {
  const starts = [];
  const f = setup({ runEngine: async ({ state, persist }) => {
    starts.push(copy(state)); state.status = 'completed'; state.completedAt = new Date(); await persist();
  } });
  const first = await f.start(); await f.runner.waitForIdle(first._id);
  const original = f.AISession.store.get(first._id).reproduction.firstSubmittedAt;
  assert.ok(original);
  await f.start({ sessionId: first._id, requestId: 'request-timing-12345678' }); await f.runner.waitForIdle(first._id);
  assert.equal(starts.length, 2); assert.equal(starts[1].firstSubmittedAt, original); assert.equal(starts[1].completedAt, null);
  const publicCase = await f.runner.publicState(f.AISession.store.get(first._id));
  assert.equal(publicCase.timing.available, true); assert.equal(publicCase.timing.firstSubmissionSource, 'recorded_request');
});

test('a failed tool-access check stops the run before any model pass or write', async () => {
  let engineRuns = 0; const checks = [];
  const f = setup({ preflight: null, providerDependencies: {
    aiProvider: { resolveProvider: async () => 'codex', chat: async () => assert.fail('no model call') },
    codexCli: { run: async () => assert.fail('no model call'), verifyToolAccess: async (options) => {
      checks.push(options);
      return { ok: false, status: 'failed', reason: 'Codex did not list the case tools.', codexVersion: '0.161.0', model: 'fixture-model', checkedAt: '2026-10-08T00:00:00.000Z' };
    } },
  }, runEngine: async () => { engineRuns += 1; } });
  const started = await f.start(); await f.runner.waitForIdle(started._id);
  const saved = f.AISession.store.get(started._id);
  assert.equal(engineRuns, 0); assert.equal(checks.length, 1);
  assert.equal(saved.reproduction.status, 'stopped'); assert.equal(saved.reproduction.outcome, 'unverified');
  assert.equal(saved.reproduction.summary, 'Codex did not list the case tools.');
  assert.deepEqual(saved.reproduction.toolAccess, { ok: false, status: 'failed', codexVersion: '0.161.0', model: 'fixture-model', checkedAt: '2026-10-08T00:00:00.000Z' });
  assert.deepEqual(saved.messages.at(-1).role + ':' + saved.messages.at(-1).content, 'assistant:Codex did not list the case tools.');
  assert.equal(f.AIPlan.store.get(saved.reproduction.planId).steps.length, 0);
});

test('the tool-access check applies only to Codex and a passing check lets the run start', async () => {
  const anthropic = setup({ preflight: null, providerDependencies: {
    aiProvider: { resolveProvider: async () => 'anthropic' }, codexCli: { verifyToolAccess: async () => assert.fail('not for Anthropic') } } });
  const a = await anthropic.start(); await anthropic.runner.waitForIdle(a._id);
  assert.equal(anthropic.starts, 1);
  const codex = setup({ preflight: null, providerDependencies: {
    aiProvider: { resolveProvider: async () => 'codex' }, codexCli: { verifyToolAccess: async () => ({ ok: true, codexVersion: '0.161.0' }) } } });
  const c = await codex.start(); await codex.runner.waitForIdle(c._id);
  assert.equal(codex.starts, 1);
  assert.equal(codex.AISession.store.get(c._id).reproduction.toolAccess.ok, true);
});

test('an operator question ends the run and the reply continues the case with the question in its history', async () => {
  const { runEngine } = require('../src/modules/reproduction-engine');
  const transcripts = []; let call = 0;
  const question = 'Which account should the $40,000 transfer come from?';
  const chat = async (messages) => {
    call += 1;
    transcripts.push(copy(messages));
    if (call === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'askOperator', input: { question, options: ['Chequing', 'Savings'] } }] };
    if (call === 3) return { content: [{ type: 'tool_use', id: 't2', name: 'finishCase', input: { outcome: 'unverified', summary: 'Fixture stop', tests: [], limitations: [] } }] };
    return { content: [{ type: 'text', text: 'Done for now.' }] };
  };
  const complete = async ({ prompt }) => { const sources = JSON.parse(prompt).sources, first = sources.entries[0]; return { text: JSON.stringify({ purpose: 'setup', requirements: [{ id: 'r1', kind: 'setup', timing: 'final', label: 'Transfer amount is 40000', measurement: 'Requested transfer and account choice', channel: 'record', predicate: { operator: 'equal', expected: 40000 }, sources: [{ requestId: first.id, start: 0, end: first.text.length }], after: [] }] }) }; };
  const f = setup({ runEngine, providerDependencies: { aiProvider: { resolveProvider: async () => 'anthropic', chat, complete } } });
  const first = await f.start({ message: 'need to create an owners distributions account and transfer $40000 to it for April 21, 2026' });
  await f.runner.waitForIdle(first._id);
  let saved = f.AISession.store.get(first._id);
  assert.equal(call, 2);
  assert.equal(saved.reproduction.outcome, 'needs_input'); assert.equal(saved.reproduction.status, 'completed');
  assert.equal(saved.reproduction.awaitingOperator.question, question);
  assert.equal(saved.messages.at(-1).role, 'assistant');
  assert.equal(saved.messages.at(-1).content, question + '\n\nOptions:\n1. Chequing\n2. Savings');
  assert.equal((await f.runner.publicState(saved)).reproduction.outcome, 'needs_input');

  await f.start({ sessionId: first._id, requestId: 'request-answer-12345678', message: 'Use Chequing' });
  await f.runner.waitForIdle(first._id);
  saved = f.AISession.store.get(first._id);
  const texts = transcripts[2].filter((m) => typeof m.content === 'string').map((m) => m.role + ':' + m.content);
  const asked = texts.findIndex((t) => t.startsWith('assistant:' + question));
  assert.ok(asked > 0, 'the question is replayed to the model');
  assert.ok(texts.indexOf('user:Use Chequing') > asked, 'the answer follows the question');
  assert.equal(saved.reproduction.awaitingOperator, null);
  assert.equal(saved.reproduction.outcome, 'unverified');
  assert.equal(saved.reproduction.agentReplies.length, 2);
  assert.deepEqual(saved.reproduction.toolTrace.map((t) => t.tool), ['askOperator', 'finishCase']);
});

test('a run left by an earlier backend process can continue at once, unless a write is unresolved', async () => {
  const f = setup();
  const first = await f.start(); await f.runner.waitForIdle(first._id);
  const saved = f.AISession.store.get(first._id);
  saved.reproduction.status = 'running'; saved.reproduction.instance = 'previous-server';
  saved.reproduction.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  assert.equal((await f.runner.publicState(saved)).reproduction.status, 'interrupted');
  const plan = f.AIPlan.store.get(saved.reproduction.planId);
  plan.steps = [{ stepNumber: 1, toolName: 'createRecord', toolInput: { entityType: 'Bill' }, status: 'executing' }];
  await assert.rejects(() => f.start({ sessionId: first._id, requestId: 'request-h1-unresolved-1' }), /unresolved external write/);
  plan.steps = [{ stepNumber: 1, toolName: 'createRecord', toolInput: { entityType: 'Bill' }, status: 'completed', result: { data: { id: '9' } } }];
  await f.start({ sessionId: first._id, requestId: 'request-h1-continue-12' }); await f.runner.waitForIdle(first._id);
  assert.equal(f.starts, 2);
});

test('an Anthropic reply cut off at the output limit never runs its partial tool call', async () => {
  const replies = [
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Creating the transfer' }, { type: 'tool_use', id: 'cut', name: 'createRecord', input: { entityType: 'Tra' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Resent in smaller steps.' }] },
  ];
  const f = setup({ providerDependencies: { aiProvider: { resolveProvider: async () => 'anthropic', chat: async () => replies.shift() } } });
  const executed = []; const messages = [{ role: 'user', content: 'Build it' }];
  const text = await f.runner.runProvider(messages, 'system', async (...call) => { executed.push(call); return { success: true }; }, [], undefined, { deadline: Date.now() + 60000 });
  assert.equal(text, 'Resent in smaller steps.');
  assert.deepEqual(executed, []);
  assert.deepEqual(messages[1].content, [{ type: 'text', text: 'Creating the transfer' }]);
  assert.match(messages[2].content, /output limit/);

  const cut = { stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 'cut', name: 'createRecord', input: {} }] };
  const g = setup({ providerDependencies: { aiProvider: { resolveProvider: async () => 'anthropic', chat: async () => cut } } });
  const repeated = await g.runner.runProvider([{ role: 'user', content: 'Build it' }], 'system', async () => assert.fail('never run'), [], undefined, { deadline: Date.now() + 60000 });
  assert.match(repeated, /repeatedly cut off/);
});

test('denied company admission leaves no empty case and the same submission can run after setup', async () => {
  let enabled = false;
  const f = setup({ admitJob: async (_connection, _action, work) => { if (!enabled) throw new Error('Company preparation required'); return work(null); } });
  await assert.rejects(f.start(), /preparation/); assert.equal(f.AISession.store.size, 0); assert.equal(f.starts, 0);
  enabled = true; const accepted = await f.start(); await f.runner.waitForIdle(accepted._id);
  const retried = await f.start(); assert.equal(retried._id, accepted._id); assert.equal(f.starts, 1); assert.equal(f.AISession.store.size, 1);
});
test('an older empty rejected submission can be claimed without changing its request identity', async () => {
  const f = setup(); const draft = await f.AISession.create({ userId: 'owner', realmId: 'realm', submissionId: 'request-123456789', mode: 'reproduce', messages: [], plans: [] });
  const accepted = await f.start(); await f.runner.waitForIdle(accepted._id); assert.equal(accepted._id, draft._id); assert.equal(f.starts, 1);
});

test('submission identity is re-read inside policy admission before a competing create', async () => {
  let f;
  f = setup({ admitJob: async (_connection, _action, work) => {
    await f.AISession.create({ userId: 'owner', realmId: 'realm', submissionId: 'request-123456789', mode: 'reproduce', messages: [], plans: [], reproduction: { requestId: 'request-123456789', status: 'completed', summary: 'Other admission completed' } });
    return work(null);
  } });
  const accepted = await f.start(); assert.equal(accepted.reproduction.summary, 'Other admission completed'); assert.equal(f.AISession.store.size, 1); assert.equal(f.AIPlan.store.size, 0); assert.equal(f.starts, 0);
});

test('reserved unrecovered or paused accounts cannot start cases, including shared workspace owners',async()=>{
  for(const recovered of [false,true]){
    const f=setup();f.setAccount('owner',{_id:'owner',email:'tester@testdatalab.local',role:'supervisor',authVersion:recovered?1:0,accessPolicyVersion:recovered?1:0,automationAccessPolicyVersion:0});
    await assert.rejects(f.start(),/recovery|automation is paused/);assert.equal(f.AISession.store.size,0);assert.equal(f.starts,0);
  }
});
test('credential revocation during a case stops before the next model call',async()=>{
  let calls=0,f;
  f=setup({providerDependencies:{aiProvider:{resolveProvider:async()=> 'anthropic',chat:async()=>{calls++;return{content:[]};}}},runEngine:async({runModel,state})=>{
    f.setAccount('owner',{_id:'owner',email:'tester@testdatalab.local',role:'supervisor',authVersion:1,accessPolicyVersion:1,automationAccessPolicyVersion:0});
    await runModel([],async()=>{},[],{deadline:Date.now()+60000});state.status='completed';
  }});
  const started=await f.start();await f.runner.waitForIdle(started._id);assert.equal(calls,0);assert.equal(f.AISession.store.get(started._id).reproduction.status,'stopped');assert.match(f.AISession.store.get(started._id).reproduction.summary,/automation is paused/);
});

test('typed Continue retains the exact original source and records no synthetic user amendment', async () => {
  const f = setup(), first = await f.start(); await f.runner.waitForIdle(first._id);
  const original = copy(f.AISession.store.get(first._id).reproduction.requestSources);
  await f.start({ sessionId: first._id, requestId: 'continue-saved-12345678', message: undefined, continueSaved: true }); await f.runner.waitForIdle(first._id);
  const saved = f.AISession.store.get(first._id);
  assert.deepEqual(saved.reproduction.requestSources, original); assert.equal(saved.messages.filter(row => row.role === 'user').length, 1);
  assert.ok(saved.messages.some(row => row.role === 'system')); assert.equal(saved.reproduction.caseRunHistory.length, 1);
  await assert.rejects(f.start({ sessionId: first._id, requestId: 'continue-bad-12345678', message: 'Replace the request', continueSaved: true }), /without adding/);
});
test('optional assessment plan-read failure preserves running progress and Stop without assurance', async () => {
  let release, started; const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = setup({ runEngine: async ({ state, persist, assertActive }) => { state.assessment = { payload: {} }; await persist(); started(); await gate; await assertActive(); } });
  const first = await f.start(); await ready;
  const originalFind = f.AIPlan.findOne; f.AIPlan.findOne = async () => { throw new Error('isolated optional lookup failure'); };
  try {
    const view = await f.runner.publicState(f.AISession.store.get(first._id));
    assert.equal(view.reproduction.status, 'running'); assert.equal(view.reproduction.outcome, 'unverified'); assert.equal(view.reproduction.assessmentTrust, 'assessment-unavailable');
    const stopped = await f.runner.stopCase('owner', first._id), visible = await f.runner.publicState(stopped);
    assert.equal(visible.reproduction.stopRequested, true); assert.equal(visible.reproduction.assessmentTrust, 'assessment-unavailable');
  } finally { f.AIPlan.findOne = originalFind; release(); await f.runner.waitForIdle(first._id); }
});
test('legacy public results retain their meaning and are labelled executor-assessed without provider reads', async () => {
  const f = setup(), first = await f.start(); await f.runner.waitForIdle(first._id);
  const saved = f.AISession.store.get(first._id); delete saved.reproduction.caseContractVersion;
  Object.assign(saved.reproduction, { status: 'completed', outcome: 'completed', revision: 1, conditions: ['Saved invoice'], checks: [{ label: 'Saved invoice', available: true, passed: true, revision: 1 }] });
  f.AIPlan.findOne = async () => { throw new Error('Legacy inspection must not load assessment receipts'); };
  const view = await f.runner.publicState(saved); assert.equal(view.reproduction.outcome, 'completed'); assert.equal(view.reproduction.assessmentTrust, 'executor-assessed');
});

test('a paused legacy note provider cannot race a conversion into a source-bound reproduction case', async t => {
  const f = setup(), legacy = await f.AISession.create({ userId: 'owner', realmId: 'realm', mode: 'investigate', status: 'active', messages: [{ role: 'user', content: 'Original legacy investigation' }], tokenUsage: { inputTokens: 0, outputTokens: 0 } });
  t.mock.method(require('../src/models/AISession'), 'findById', id => f.AISession.findById(id));
  t.mock.method(require('../src/models/User'), 'findById', () => ({ select: async () => ({}) }));
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.mock.method(require('../src/modules/ai-provider'), 'complete', async () => { entered(); await gate; return { text: 'Synthetic legacy note', usage: { inputTokens: 0, outputTokens: 0 } }; });
  const pending = require('../src/modules/ai-orchestrator').generateNote(legacy._id);
  try {
    await started;
    await assert.rejects(f.start({ sessionId: legacy._id, requestId: 'request-legacy-race-1', message: 'Convert the in-flight investigation' }), /cannot be converted/);
    assert.equal(f.AIPlan.store.size, 0); assert.equal(f.starts, 0); assert.equal(f.AISession.store.get(legacy._id).reproduction, undefined);
  } finally { release(); await pending; }
  assert.deepEqual(f.AISession.store.get(legacy._id).messages, [{ role: 'user', content: 'Original legacy investigation' }]);
  assert.equal(f.AISession.store.get(legacy._id).reproduction, undefined);
});
