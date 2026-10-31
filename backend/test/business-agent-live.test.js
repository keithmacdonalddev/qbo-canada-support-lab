'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiveFeed, createLiveActivityReader, MAX_ITEMS, FAST_POLL_MS, IDLE_POLL_MS } = require('../src/modules/business-agent-live');
const { stepNote, stepLabel, cleanSteps } = require('../src/modules/business-agent-progress');

const NOW = Date.parse('2026-10-30T18:15:00Z');
const at = seconds => new Date(NOW + seconds * 1000).toISOString();
const settings = { monitoring: true, autonomous: true };
const runId = 'a'.repeat(24), periodId = 'b'.repeat(24);
const pass = { id: 'pass-1', role: 'accountant', startedAt: at(-60) };
const progress = { passId: 'pass-1', role: 'accountant', startedAt: at(-60), steps: [
  { at: at(-55), label: 'Reading unpaid customer invoices', status: 'done', note: '7 found · $4,210.00 open', input: { secret: 'tool input' } },
  { at: at(-40), label: 'Preparing 3 sales and 1 supplier bill for today', status: 'done', note: 'plan saved' },
  { at: at(-20), label: 'Sending an approved plan to QuickBooks', status: 'running' },
] };
const batchRun = { _id: runId, status: 'running', createdAt: new Date(at(-35)), updatedAt: new Date(at(-5)), recordCount: 15, nextOrdinal: 7, activityBatch: { day: '2026-10-30', purpose: 'Afternoon sales\nwith **detail**', activities: [{ type: 'settled-service-sale' }, { type: 'settled-service-sale' }, { type: 'settled-service-sale' }, { type: 'paid-operating-expense' }] }, lastError: 'raw upstream fault text' };
const steps = [
  { _id: 's1', operationId: runId, entity: 'Invoice', state: 'verified', qboId: '901', createdAt: new Date(at(-30)), updatedAt: new Date(at(-25)), compilation: { request: { body: '{"secret":"payload"}' } } },
  { _id: 's2', operationId: runId, entity: 'Payment', state: 'saved', qboId: '902', updatedAt: new Date(at(-15)) },
  { _id: 's3', operationId: runId, entity: 'Bill', state: 'dispatched', updatedAt: new Date(at(-3)) },
  { _id: 's4', operationId: runId, entity: 'Deposit', state: 'rejected', updatedAt: new Date(at(-10)), rejection: { message: 'raw fault' } },
];
const records = [
  { entity: 'Invoice', qboId: '901', summary: { name: '', docNumber: '11063', amountCents: 71250, currency: 'CAD' }, record: { CustomerRef: { name: 'Cedar Ridge Homes' } } },
  { entity: 'Payment', qboId: '902', summary: { name: '', docNumber: '', amountCents: 71250, currency: 'CAD' }, record: { CustomerRef: { name: 'Cedar\nRidge Homes' }, Line: [{ secret: 'line' }] } },
];
const events = [
  { id: 'e1', kind: 'review-completed', role: 'accountant', at: at(-3600), title: 'Main accountant completed a business review', detail: '## Summary\nPosted 12 records.\nMore', toolCalls: 9, passId: 'old' },
  { id: 'e2', kind: 'plan-decision', role: 'accountant', at: at(-34), title: 'Main accountant approved business activity', detail: 'Afternoon sales.', operationId: runId, planHash: 'h'.repeat(64), grantId: 'grant' },
  { id: 'e3', kind: 'unknown-kind', at: at(-2), title: 'should not show' },
  { id: 'e4', kind: 'control', role: 'owner', at: at(-7200), title: 'Owner changed business controls', detail: 'A business review was requested.', requestHash: 'x' },
];

test('a review in progress merges its steps, the sending operation, record steps and events, newest first', () => {
  const feed = buildLiveFeed({ now: NOW, settings, reviewing: true, activePass: pass, progress, cadence: { kind: 'slice', reason: 'business hours' }, events, runs: [batchRun], steps, records });
  assert.equal(feed.state, 'reviewing');
  assert.equal(feed.active, true);
  assert.equal(feed.pollMs, FAST_POLL_MS);
  assert.equal(feed.startedAt, at(-60));
  assert.equal(feed.reason, 'business hours');
  assert.deepEqual(feed.sending, { operationId: runId, done: 7, total: 15, batch: true });
  const times = feed.items.map(item => item.at);
  assert.deepEqual(times, [...times].sort().reverse(), 'items are newest first');
  const text = id => feed.items.find(item => item.id === id);
  assert.equal(text('review:pass-1').text, 'Started a business review · business hours');
  assert.equal(text('review:pass-1').status, 'running');
  assert.equal(text('review:pass-1:0').detail, '7 found · $4,210.00 open');
  assert.equal(text('review:pass-1:2').status, 'running');
  assert.equal(text('run:' + runId + ':planned').text, 'Planned 3 sales and 1 supplier bill for Oct 30 · 15 records');
  assert.equal(text('run:' + runId + ':planned').detail, 'Afternoon sales');
  assert.equal(text('run:' + runId + ':status').text, 'Sending to QuickBooks · 7 of 15 records');
  assert.equal(text('step:s1').text, 'Invoice 11063 · Cedar Ridge Homes · $712.50');
  assert.equal(text('step:s1').outcome, 'Saved · verified');
  assert.deepEqual(text('step:s1').record, { entity: 'Invoice', qboId: '901' });
  assert.equal(text('step:s2').text, 'Customer payment #902 · Cedar Ridge Homes · $712.50');
  assert.equal(text('step:s3').text, 'Bill');
  assert.equal(text('step:s3').status, 'running');
  assert.equal(text('step:s3').record, undefined, 'no link before QuickBooks returns an id');
  assert.equal(text('step:s4').status, 'failed');
  assert.equal(text('event:e2').operationId, runId);
  assert.equal(text('event:e3'), undefined, 'unknown event kinds are not shown');
  assert.equal(text('event:e1').detail, 'Posted 12 records.');
  assert.equal(text('event:e4').by, 'owner');
});

test('the feed never carries prompts, tool inputs, raw errors or record payloads', () => {
  const feed = buildLiveFeed({ now: NOW, settings, reviewing: true, activePass: pass, progress, cadence: { reason: 'business hours' }, events, runs: [{ ...batchRun, status: 'blocked' }], steps, records });
  const json = JSON.stringify(feed);
  for (const leak of ['tool input', 'raw upstream fault text', 'payload', 'raw fault', '"line"', 'planHash', 'grant', 'requestHash', 'toolCalls', '\\n']) assert.ok(!json.includes(leak), leak + ' must not reach the feed');
  for (const item of feed.items) for (const key of Object.keys(item)) assert.ok(['id', 'at', 'kind', 'status', 'text', 'detail', 'outcome', 'record', 'operationId', 'by'].includes(key), key);
  assert.match(feed.items.find(item => item.id === 'run:' + runId + ':status').text, /^Stopped part-way after 7 of 15 records/);
});

test('idle: no spinner, slow polling, and the last few things done stay visible even when old', () => {
  const old = Array.from({ length: 10 }, (_, index) => ({ id: 'old' + index, kind: 'review-completed', at: new Date(NOW - 86400000 * 2 - index * 1000).toISOString(), detail: 'Review ' + index }));
  const verified = { ...batchRun, status: 'verified', nextOrdinal: 15, updatedAt: new Date(at(-600)) };
  const finishedProgress = { ...progress, steps: progress.steps };
  const feed = buildLiveFeed({ now: NOW, settings, reviewing: false, activePass: null, progress: finishedProgress, cadence: { reason: 'next slice' }, events: old, runs: [verified], steps: steps.filter(step => step.state === 'verified'), records });
  assert.equal(feed.state, 'idle');
  assert.equal(feed.active, false);
  assert.equal(feed.pollMs, IDLE_POLL_MS);
  assert.equal(feed.sending, null);
  assert.equal(feed.reason, '', 'the cadence reason belongs to the next review, not to a finished one');
  assert.equal(feed.items.find(item => item.id === 'review:pass-1').status, 'done');
  assert.equal(feed.items.find(item => item.id === 'review:pass-1:2').status, 'failed', 'a step left running by a finished review did not finish');
  assert.equal(feed.items.find(item => item.id === 'run:' + runId + ':status').text, 'Finished: 15 records saved and verified');
  assert.ok(!feed.items.some(item => item.id.startsWith('event:old')), 'two-day-old events drop out when recent work fills the minimum');
  const quiet = buildLiveFeed({ now: NOW, settings, events: old });
  assert.equal(quiet.items.length, 6, 'with nothing recent, the newest six remain');
  assert.equal(quiet.state, 'idle');
});

test('bounded to the newest items and to the window; stopped and unconfigured states are plain', () => {
  const many = Array.from({ length: 120 }, (_, index) => ({ id: 'e' + index, kind: 'plan-decision', title: 'Approved ' + index, at: at(-index) }));
  const feed = buildLiveFeed({ now: NOW, settings, events: many });
  assert.equal(feed.items.length, MAX_ITEMS);
  assert.equal(feed.items[0].text, 'Approved 0');
  assert.equal(buildLiveFeed({ now: NOW, settings: { monitoring: false } }).state, 'stopped');
  assert.equal(buildLiveFeed({ now: NOW, configured: false }).state, 'not-configured');
  const period = { _id: periodId, status: 'verified', createdAt: new Date(at(-900)), updatedAt: new Date(at(-300)), fromDate: '2026-10-01', throughDate: '2026-10-29', recordCount: 120, nextOrdinal: 120 };
  const closed = buildLiveFeed({ now: NOW, settings, runs: [period] });
  assert.equal(closed.items[0].text, 'Closed the business calendar through Oct 29 · 120 records');
  assert.equal(closed.items[1].text, 'Prepared the business calendar for Oct 1–Oct 29 · 120 records');
  const sendingOnly = buildLiveFeed({ now: NOW, settings, runs: [{ ...period, status: 'awaiting-evidence' }] });
  assert.equal(sendingOnly.state, 'sending');
  assert.equal(sendingOnly.pollMs, FAST_POLL_MS);
});

test('review step notes come only from counts and totals in successful results', () => {
  assert.equal(stepNote('getObligations', {}, { success: true, data: { records: [{ balanceCents: 71250, name: 'Jane Doe' }, { balanceCents: 1000 }], mayHaveMore: true } }), '2+ found · $722.50 open');
  assert.equal(stepNote('getObligations', {}, { success: true, data: { records: [] } }), 'none open');
  assert.equal(stepNote('searchEntities', {}, { success: true, data: { count: 3, records: [{ Name: 'Jane Doe' }] } }), '3 found');
  assert.equal(stepNote('getBusinessActivityChoices', {}, { success: true, data: { customers: [1, 2], services: [1], vendors: [] } }), '2 customers, 1 service');
  assert.equal(stepNote('prepareBusinessActivity', {}, { success: true, data: { reused: false, operationId: 'x' } }), 'plan saved');
  assert.equal(stepNote('getObligations', {}, { success: false, error: 'Jane Doe failed' }), '');
  assert.equal(stepNote('lookupCustomer', {}, { success: true, data: { name: 'Jane Doe' } }), '');
  assert.equal(stepLabel('prepareBusinessActivity', { activities: [{ type: 'settled-service-sale' }, { type: 'paid-operating-expense' }, { type: 'settled-service-sale' }] }), 'Preparing 2 sales and 1 supplier bill for today');
  assert.equal(stepLabel('prepareBusinessActivity', { activities: [{ type: 'Jane Doe' }] }), 'Preparing 1 piece of same-day activity');
  assert.deepEqual(cleanSteps([{ at: at(0), label: 'x', status: 'done', note: 'a\nb'.padEnd(200, 'c') }])[0].note.length, 80);
});

test('the reader runs three bounded, time-limited queries and skips the rest when nothing is recent', async () => {
  const calls = [];
  const query = (name, rows) => ({ find(filter) { const chain = { filter, ops: [] }; calls.push([name, chain]); const self = { select(v) { chain.ops.push(['select', v]); return self; }, sort(v) { chain.ops.push(['sort', v]); return self; }, limit(v) { chain.ops.push(['limit', v]); return self; }, maxTimeMS(v) { chain.ops.push(['maxTimeMS', v]); return self; }, lean: async () => rows }; return self; } });
  const scope = { environment: 'production', realmId: '123', connectionId: 'c'.repeat(24) };
  const read = createLiveActivityReader({ models: { Runs: query('runs', [batchRun]), Steps: query('steps', steps), Records: query('records', records) }, now: () => NOW });
  const value = await read(scope);
  assert.equal(value.runs.length, 1);
  assert.deepEqual(calls.map(([name]) => name), ['runs', 'steps', 'records']);
  for (const [, chain] of calls) {
    assert.ok(chain.ops.some(([op, v]) => op === 'limit' && v <= 60));
    assert.ok(chain.ops.some(([op, v]) => op === 'maxTimeMS' && v <= 2000));
    assert.ok(!/(^|\s)record(\s|$)/.test(chain.ops.find(([op]) => op === 'select')[1]), 'never selects whole records');
  }
  assert.deepEqual(calls[2][1].filter.$or, [{ entity: 'Invoice', qboId: '901' }, { entity: 'Payment', qboId: '902' }]);
  calls.length = 0;
  const empty = createLiveActivityReader({ models: { Runs: query('runs', []), Steps: query('steps', steps), Records: query('records', records) }, now: () => NOW });
  assert.deepEqual(await empty(scope), { runs: [], steps: [], records: [] });
  assert.equal(calls.length, 1);
});
