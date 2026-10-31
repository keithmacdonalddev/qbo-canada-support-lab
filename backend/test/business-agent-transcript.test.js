'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const T = require('../src/modules/business-agent-transcript');
const { createBusinessAgentEngine } = require('../src/modules/business-agent-engine');
const { createBusinessAgentService } = require('../src/modules/business-agent-service');

const NOW = Date.parse('2026-10-30T18:15:00Z');
const ATTEMPT = '11111111-2222-4333-8444-555555555555';
const scope = { environment: 'production', realmId: '123456789', connectionId: 'd'.repeat(24) };
const tick = () => new Promise(resolve => setImmediate(resolve));
function recorder(extra = {}) {
  const saved = [], published = [];
  const value = T.createTranscriptRecorder({ agentId: 'agent-1', attemptId: ATTEMPT, passId: 'pass-1', scope, now: () => NOW, write: async rows => { saved.push(...rows); }, publish: (agentId, entry) => published.push([agentId, entry]), ...extra });
  return { value, saved, published };
}

test('Codex exec JSONL events become reasoning, messages, usage and failures', () => {
  const events = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: '**Checking receivables** before planning sales.' } },
    { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'business', tool: 'getObligations', arguments: { area: 'receivables' }, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'business', tool: 'getObligations', arguments: { area: 'receivables' }, result: { content: [{ type: 'text', text: '{}' }] }, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'todo_list', items: [{ text: 'Collect invoices', completed: true }, { text: 'Plan sales', completed: false }] } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Planned 3 sales.' } },
    { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 } },
    { type: 'turn.failed', error: { message: 'stream ended' } },
  ];
  const entries = events.flatMap(T.codexEntries);
  assert.deepEqual(entries.map(([kind]) => kind), ['reasoning', 'reasoning', 'message', 'usage', 'outcome']);
  assert.equal(entries[0][1].text, '**Checking receivables** before planning sales.');
  assert.equal(entries[1][1].text, 'Plan:\n[x] Collect invoices\n[ ] Plan sales');
  assert.deepEqual(entries[3][1].data, { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 90 });
  assert.match(entries[4][1].text, /failed turn: stream ended/);
  assert.deepEqual(T.codexEntries(null), []);
});

test('Anthropic responses become thinking, text and usage in block order', () => {
  const entries = T.anthropicEntries({ stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'Cash first.' }, { type: 'text', text: 'Reading invoices.' }, { type: 'tool_use', id: 'tu1', name: 'getObligations', input: { area: 'receivables' } }, { type: 'redacted_thinking', data: 'opaque' }], usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 300 } });
  assert.deepEqual(entries.map(([kind]) => kind), ['reasoning', 'message', 'reasoning', 'usage']);
  assert.equal(entries[2][1].text, '(reasoning withheld by the provider)');
  assert.equal(entries[3][1].data.stopReason, 'tool_use');
  assert.equal(entries[3][1].data.cacheReadTokens, 300);
});

test('redaction removes keys, tokens, headers, JWTs and environment secrets by name and by shape', () => {
  const saved = process.env.TEST_TRANSCRIPT_CLIENT_SECRET;
  process.env.TEST_TRANSCRIPT_CLIENT_SECRET = 'envsecretvalue-123456';
  try {
    // The environment cache is filled on first use; this process may already have filled it.
    const leaks = ['sk-ant-api03-abcdefghijklmnop', 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl', 'AB11712345678901234567890123456789012345', 'mongodb+srv://user:pw@cluster.example/db', 'bearer-value-123456', 'refresh-abc-123456', 'passw0rd-value', 'envsecretvalue-123456'];
    const data = { apiKey: 'plain-key-value', anthropicApiKey: 'x', headers: { Authorization: 'Bearer bearer-value-123456' }, oauth: { access_token: 'a', refreshToken: 'refresh-abc-123456' }, client_secret: 'c', password: 'passw0rd-value', record: { SyncToken: '3', DocNumber: '11063', CustomerRef: { name: 'Cedar Ridge Homes' } }, usage: { inputTokens: 5, outputTokens: 2, maxTokens: 9 }, memo: 'configured value envsecretvalue-123456', note: 'key sk-ant-api03-abcdefghijklmnop and jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl and AB11712345678901234567890123456789012345 at mongodb+srv://user:pw@cluster.example/db with sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX' };
    const entry = T.makeEntry('tool-result', { name: 'getEntityDetail', data, text: 'Authorization: Bearer bearer-value-123456 refresh_token=refresh-abc-123456' }, ['per-attempt-bridge-token-1234']);
    const all = entry.text + entry.json;
    for (const leak of leaks) assert.ok(!all.includes(leak), leak + ' leaked');
    for (const kept of ['Cedar Ridge Homes', '11063', '"SyncToken": "3"', '"inputTokens": 5', '"maxTokens": 9']) assert.ok(all.includes(kept), kept + ' should be kept');
    assert.ok(T.scrubText('bridge per-attempt-bridge-token-1234 used', ['per-attempt-bridge-token-1234']).includes(T.REDACTED));
    assert.equal(T.redact({ nested: { privateKey: { pem: 'x' } } }).nested.privateKey, T.REDACTED);
  } finally { if (saved === undefined) delete process.env.TEST_TRANSCRIPT_CLIENT_SECRET; else process.env.TEST_TRANSCRIPT_CLIENT_SECRET = saved; }
});

test('the recorder bounds items and attempts, sets a seven-day expiry, publishes live and writes in batches', async () => {
  const { value, saved, published } = recorder();
  value.add('context', { text: 'x'.repeat(200000), provider: 'anthropic' });
  value.add('tool-result', { name: 'runReport', data: { rows: 'y'.repeat(50000) } });
  value.add('not-a-kind', { text: 'ignored' });
  await value.flush();
  assert.equal(saved.length, 2);
  assert.ok(Buffer.byteLength(saved[0].text) <= T.MAX_CONTEXT_BYTES + 40 && saved[0].truncated);
  assert.ok(Buffer.byteLength(saved[1].json) <= T.MAX_ITEM_BYTES + 40 && saved[1].truncated);
  assert.deepEqual(saved.map(row => row.seq), [1, 2]);
  assert.equal(saved[0].expiresAt.getTime() - saved[0].at.getTime(), T.TTL_MS);
  assert.deepEqual(published.map(([agent, entry]) => [agent, entry.seq, entry.kind]), [['agent-1', 1, 'context'], ['agent-1', 2, 'tool-result']]);
  assert.ok(!('expiresAt' in published[0][1]) && !('agentId' in published[0][1]), 'the page gets public fields only');
  // Past the attempt budget a single notice is kept and later items are dropped.
  for (let index = 0; index < 200; index++) value.add('message', { text: 'z'.repeat(8000) });
  await value.flush();
  assert.equal(saved.filter(row => row.status === 'truncated').length, 1);
  assert.ok(saved.reduce((total, row) => total + Buffer.byteLength(row.text) + Buffer.byteLength(row.json), 0) <= T.MAX_ATTEMPT_BYTES);
  assert.equal(value.add('message', { text: 'after' }), null);
});

test('failed or hanging writes never break the review; flush is bounded', async () => {
  const failing = T.createTranscriptRecorder({ agentId: 'a', attemptId: ATTEMPT, write: async () => { throw new Error('storage down'); }, publish: () => { throw new Error('listener down'); } });
  assert.ok(failing.add('message', { text: 'hello' }));
  await failing.flush();
  assert.ok(failing.failures() >= 1);
  const hanging = T.createTranscriptRecorder({ agentId: 'a', attemptId: ATTEMPT, write: () => new Promise(() => {}), publish: () => {}, flushMs: 50 });
  hanging.add('message', { text: 'hello' });
  const started = Date.now();
  await hanging.flush();
  assert.ok(Date.now() - started < 1000);
});

test('the engine records context, tool calls with arguments and results, model output and usage for Anthropic', async () => {
  const { value, saved } = recorder();
  let round = 0;
  const provider = { resolveProvider: async () => 'anthropic', MODELS: { FAST: 'claude-fixture' }, chat: async () => (++round === 1
    ? { model: 'claude-fixture', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Checking invoices.' }, { type: 'tool_use', id: 'tu1', name: 'getObligations', input: { area: 'receivables' } }], usage: { input_tokens: 10, output_tokens: 5 } }
    : { model: 'claude-fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All collected.' }], usage: { input_tokens: 12, output_tokens: 4 } }) };
  const engine = createBusinessAgentEngine({ provider, now: () => NOW });
  const result = await engine.run({ role: 'accountant', context: { ownerInstructions: 'Keep cash healthy', memory: '' }, tools: [{ name: 'getObligations' }], execute: async () => ({ success: true, data: { records: [{ balanceCents: 100 }] } }), userApiKey: 'sk-ant-api03-userkey-abcdefgh', transcript: value });
  assert.equal(result.summary, 'All collected.');
  await value.flush();
  assert.deepEqual(saved.map(row => row.kind), ['context', 'message', 'usage', 'tool-call', 'tool-result', 'message', 'usage']);
  assert.match(saved[0].text, /^System instructions\n/);
  assert.match(saved[0].text, /Keep cash healthy/);
  assert.equal(JSON.parse(saved[3].json).area, 'receivables');
  assert.equal(saved[4].status, 'ok');
  assert.equal(JSON.parse(saved[4].json).data.records[0].balanceCents, 100);
  assert.ok(!JSON.stringify(saved).includes('userkey-abcdefgh'));
});

test('the engine records Codex events and tool calls made through the bridge', async () => {
  const { value, saved } = recorder();
  const codex = { getStatus: async () => ({ method: 'chatgpt' }), run: async ({ onEvent, bridge }) => {
    onEvent({ type: 'item.completed', item: { type: 'reasoning', text: 'Look at bills.' } });
    await bridge.execute('getObligations', { area: 'payables' });
    onEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'Bills are current.' } });
    onEvent({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } });
    return { text: 'Bills are current.', usage: { inputTokens: 3, outputTokens: 1 } };
  } };
  const engine = createBusinessAgentEngine({ provider: { resolveProvider: async () => 'codex' }, codex, createBridge: ({ execute }) => ({ bridge: { token: 'bridge-private-token-123', execute }, close: async () => {} }), now: () => NOW });
  await engine.run({ role: 'accountant', context: {}, tools: [{ name: 'getObligations' }], execute: async () => ({ success: false, error: 'No bills' }), transcript: value });
  await value.flush();
  assert.deepEqual(saved.map(row => [row.kind, row.provider || null]), [['context', 'codex'], ['reasoning', 'codex'], ['tool-call', null], ['tool-result', null], ['message', 'codex'], ['usage', 'codex']]);
  assert.equal(saved[3].status, 'failed');
});

// state.selected: the company the user has selected now; state.denied(scope): access lost for that scope.
function streamService(entries, state = { selected: scope, denied: () => false }) {
  const live = [];
  const store = {
    models: {}, get: async target => ({ _id: target.realmId === scope.realmId ? 'agent-1' : 'agent-2', ...target, revision: 3, settings: { monitoring: true } }),
    transcripts: { latest: async () => ATTEMPT, entries: async (agentId, attemptId, after) => entries.filter(entry => entry.seq > after), attempts: async () => [], save: async () => {}, prune: async () => {} },
  };
  const service = createBusinessAgentService({ store, now: () => NOW, usage: { summary: async () => ({}) }, engine: {}, execution: {}, requestMeter: { summary: async () => ({}) }, createSync: () => ({}), coverageFor: () => null,
    resolveContext: async () => ({ environment: state.selected.environment, connection: { connected: true, realmId: state.selected.realmId, connectionId: state.selected.connectionId, companyName: 'Fixture' } }),
    accessFor: () => ({ authorize: async target => { if (state.denied(target)) throw Object.assign(new Error('denied'), { status: 403 }); } }) });
  return { service, live, state };
}
function fakeResponse() {
  const res = { chunks: [], headers: null, ended: false, writableEnded: false, headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, write(text) { this.chunks.push(text); return true; }, end() { this.ended = this.writableEnded = true; } };
  return res;
}
const frames = res => res.chunks.join('').split('\n\n').filter(frame => frame.includes('event: entry')).map(frame => JSON.parse(frame.split('\ndata: ')[1]));

test('the live stream replays after the Last-Event-ID cursor, then sends new entries once, in order', async () => {
  const stored = [1, 2, 3].map(seq => ({ attemptId: ATTEMPT, seq, kind: 'message', text: 'm' + seq, at: new Date(NOW).toISOString() }));
  const { service } = streamService(stored);
  const req = new EventEmitter(), res = fakeResponse();
  const close = await service.transcriptStream({ id: 'a'.repeat(24) }, { cursor: T.parseCursor(ATTEMPT + ':1') }, req, res, { heartbeatMs: 100000, recheckMs: 100000 });
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.deepEqual(frames(res).map(entry => entry.seq), [2, 3], 'resumes after the cursor');
  assert.ok(res.chunks.join('').includes('id: ' + ATTEMPT + ':3'));
  T.publish('agent-1', { attemptId: ATTEMPT, seq: 3, kind: 'message', text: 'duplicate' });
  T.publish('agent-1', { attemptId: ATTEMPT, seq: 4, kind: 'reasoning', text: 'new' });
  await tick();
  assert.deepEqual(frames(res).map(entry => entry.seq), [2, 3, 4], 'live entries arrive once');
  req.emit('close');
  assert.equal(res.ended, true);
  T.publish('agent-1', { attemptId: ATTEMPT, seq: 5, kind: 'message', text: 'after close' });
  assert.equal(frames(res).length, 3, 'a closed stream receives nothing');
  close();
  service.close();
  // A cursor for an older attempt replays the latest attempt from the start; malformed cursors are ignored.
  assert.equal(T.parseCursor('../etc:1'), null);
  assert.equal(T.parseCursor(ATTEMPT + ':x'), null);
  const second = streamService(stored), res2 = fakeResponse();
  const close2 = await second.service.transcriptStream({ id: 'a'.repeat(24) }, { cursor: T.parseCursor('99999999-0000-4000-8000-000000000000:7') }, new EventEmitter(), res2, { heartbeatMs: 100000, recheckMs: 100000 });
  assert.deepEqual(frames(res2).map(entry => entry.seq), [1, 2, 3]);
  close2(); second.service.close();
});

test('saved transcripts prune to the newest attempts and read bounded pages', async () => {
  const calls = [];
  const chain = rows => { const self = { sort: v => (calls.push(['sort', v]), self), skip: v => (calls.push(['skip', v]), self), limit: v => (calls.push(['limit', v]), self), select: () => self, maxTimeMS: v => (calls.push(['maxTimeMS', v]), self), lean: async () => rows }; return self; };
  const Transcripts = { createIndexes: async () => {}, insertMany: async rows => calls.push(['insert', rows.length]), find: filter => (calls.push(['find', filter]), chain(filter.kind === 'context' ? [{ at: new Date(NOW - 1000), attemptId: ATTEMPT }] : [])), findOne: () => chain({ attemptId: ATTEMPT }), deleteMany: filter => (calls.push(['delete', filter]), { maxTimeMS: async () => ({}) }) };
  const saved = T.createTranscriptStore({ Transcripts });
  await saved.prune('agent-1');
  assert.ok(calls.some(([op, value]) => op === 'skip' && value === T.KEEP_ATTEMPTS));
  assert.deepEqual(calls.find(([op]) => op === 'delete')[1], { agentId: 'agent-1', at: { $lte: new Date(NOW - 1000) } });
  await saved.save([{ seq: 1 }]);
  assert.ok(calls.some(([op, value]) => op === 'insert' && value === 1));
  assert.equal(await saved.latest('agent-1'), ATTEMPT);
  calls.length = 0;
  await saved.entries('agent-1', ATTEMPT, 4);
  assert.deepEqual(calls[0][1], { agentId: 'agent-1', attemptId: ATTEMPT, seq: { $gt: 4 } });
  assert.ok(calls.some(([op, value]) => op === 'limit' && value <= 500));
});

test('a stream stays pinned to the company it was opened for and closes on a switch or lost access', async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const open = async state => { const made = streamService([], state), req = new EventEmitter(), res = fakeResponse(); const close = await made.service.transcriptStream({ id: 'a'.repeat(24) }, {}, req, res, { heartbeatMs: 100000, recheckMs: 15 }); return { ...made, res, close }; };
  // Unchanged company and access: the stream stays open across rechecks.
  const steady = await open({ selected: scope, denied: () => false });
  await wait(60);
  assert.equal(steady.res.ended, false);
  steady.close(); steady.service.close();
  // The user switches to company B: the stream for company A closes and B's entries never reach it.
  const other = { environment: 'production', realmId: '987654321', connectionId: 'e'.repeat(24) };
  const switched = await open({ selected: scope, denied: () => false });
  switched.state.selected = other;
  await wait(60);
  assert.equal(switched.res.ended, true, 'a company switch closes the stream');
  T.publish('agent-2', { attemptId: ATTEMPT, seq: 9, kind: 'message', text: 'company B' });
  T.publish('agent-1', { attemptId: ATTEMPT, seq: 9, kind: 'message', text: 'company A after close' });
  assert.equal(frames(switched.res).length, 0);
  switched.close(); switched.service.close();
  // Access to the original company is withdrawn while it is still selected: the stream closes.
  const revoked = await open({ selected: scope, denied: () => false });
  revoked.state.denied = target => target.realmId === scope.realmId;
  await wait(60);
  assert.equal(revoked.res.ended, true, 'lost access to the opened company closes the stream');
  revoked.close(); revoked.service.close();
});
