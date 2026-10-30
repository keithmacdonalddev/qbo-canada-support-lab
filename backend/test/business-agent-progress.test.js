'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewProgress, stepLabel, cleanSteps } = require('../src/modules/business-agent-progress');
const { EXTRA_TOOLS, READ_NAMES } = require('../src/modules/business-agent-tools');

const tick = () => new Promise(resolve => setImmediate(resolve));

test('every governed tool has a plain-English label built from allowlisted words only', () => {
  for (const name of [...READ_NAMES, ...EXTRA_TOOLS.map(tool => tool.name)]) {
    const label = stepLabel(name, {});
    assert.ok(label.length > 5 && label.length <= 100, name);
    assert.doesNotMatch(label, /^Using /, name + ' should be in the label table');
  }
  assert.equal(stepLabel('getObligations', { area: 'receivables' }), 'Reading unpaid customer invoices');
  assert.equal(stepLabel('getObligations', { area: 'payables', overdueOnly: true }), 'Reading overdue supplier bills');
  assert.equal(stepLabel('prepareBusinessActivity', { activities: [{}, {}, {}] }), 'Preparing 3 pieces of same-day activity');
  assert.equal(stepLabel('runReport', { report: 'ProfitAndLoss' }), 'Running the Profit and Loss report');
  assert.equal(stepLabel('searchEntities', { type: 'Invoice', query: 'Acme Ltd' }), 'Searching invoices');
  assert.equal(stepLabel('recordBusinessDecision', { requiresOwner: true, title: 'secret title' }), 'Asking you for a decision');
  assert.equal(stepLabel('executeBusinessPeriod', { operationId: 'a'.repeat(24) }), 'Sending an approved plan to QuickBooks');
  // Free-form or unexpected values never reach the label.
  for (const [name, input] of [['searchEntities', { type: 'Acme Ltd customer 555-0100' }], ['runReport', { report: 'sk-ant-secret' }], ['lookupCustomer', { name: 'Jane Doe' }], ['getEntityDetail', { entityType: 'Invoice', entityId: '4566' }]]) {
    const label = stepLabel(name, input);
    for (const value of Object.values(input)) if (!['Invoice'].includes(value)) assert.ok(!label.includes(value), label);
  }
  assert.equal(stepLabel('getFutureThing', {}), 'Using get future thing');
  assert.equal(stepLabel('bad name; drop', {}), 'Using a business tool');
});

test('wrap records running then done or failed, labels and times only, without delaying the tool', async () => {
  const writes = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const progress = createReviewProgress({ now: () => Date.parse('2026-10-30T18:20:00Z'), write: async steps => { writes.push(steps); await blocked; } });
  const execute = progress.wrap(async (name, input) => name === 'lookupCustomer' ? { success: false, error: 'Customer ' + input.name + ' not found' } : name === 'getBusinessState' ? (() => { throw new Error('raw upstream text'); })() : { success: true, data: { secret: input } });
  const ok = await execute('getObligations', { area: 'receivables' });
  assert.equal(ok.success, true, 'the tool result is returned unchanged while its progress write is still pending');
  assert.equal((await execute('lookupCustomer', { name: 'Jane Doe' })).success, false);
  await assert.rejects(execute('getBusinessState', {}), /raw upstream text/, 'tool errors still propagate to the engine');
  release();
  await progress.flush();
  const final = progress.steps();
  assert.deepEqual(final.map(step => [step.label, step.status]), [['Reading unpaid customer invoices', 'done'], ['Looking up a customer', 'failed'], ['Checking the business state', 'failed']]);
  const saved = writes.at(-1);
  assert.deepEqual(saved, final, 'the last write carries the final statuses');
  const text = JSON.stringify(writes);
  for (const leak of ['Jane Doe', 'raw upstream text', 'not found', 'secret']) assert.ok(!text.includes(leak), leak + ' must never be stored');
  assert.ok(writes.length < 6, 'writes coalesce while one is in flight');
  for (const step of saved) assert.deepEqual(Object.keys(step).sort(), ['at', 'label', 'status']);
});

test('the step list is capped and older steps drop off', async () => {
  const writes = [];
  const progress = createReviewProgress({ write: async steps => { writes.push(steps); }, max: 20 });
  const execute = progress.wrap(async () => ({ success: true }));
  for (let index = 0; index < 30; index++) await execute('getBusinessWork', {});
  await progress.flush();
  assert.equal(progress.steps().length, 20);
  assert.ok(writes.every(steps => steps.length <= 20));
  assert.equal(cleanSteps(Array.from({ length: 50 }, () => ({ label: 'x'.repeat(500), status: 'odd', at: 'not a date' }))).length, 20);
  assert.deepEqual(cleanSteps([{ label: 'x'.repeat(500), status: 'odd', at: 'bad' }])[0], { at: null, label: 'x'.repeat(100), status: 'done' });
});

test('failed or hanging progress writes never break the review and flush is bounded', async () => {
  let calls = 0;
  const throwing = createReviewProgress({ write: () => { calls++; throw new Error('storage down'); } });
  const run = throwing.wrap(async () => ({ success: true, value: 7 }));
  assert.equal((await run('getBusinessWork', {})).value, 7);
  await tick(); await tick();
  assert.equal((await run('getBusinessWork', {})).value, 7, 'a synchronous write failure does not stop later writes');
  await throwing.flush();
  assert.ok(calls >= 2);
  assert.ok(throwing.failures() >= 2);

  const hanging = createReviewProgress({ write: () => new Promise(() => {}), flushMs: 50 });
  await hanging.wrap(async () => ({ success: true }))('getBusinessWork', {});
  const started = Date.now();
  await hanging.flush();
  assert.ok(Date.now() - started < 1000, 'flush gives up after its bound');

  const none = createReviewProgress({});
  assert.equal((await none.wrap(async () => ({ success: true, n: 1 }))('getBusinessWork', {})).n, 1, 'no store progress method is fine');
});
