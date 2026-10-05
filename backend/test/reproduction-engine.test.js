'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runEngine, reproductionTools } = require('../src/modules/reproduction-engine');
const { checkWrite, evaluateCheck, classifyOutcome } = require('../src/modules/reproduction-policy');

function fixture() {
  const records = new Map();
  const calls = [];
  const events = [];
  let nextId = 100;
  const types = new Map(['Customer', 'Vendor', 'Item', 'Invoice', 'Payment', 'Bill', 'PurchaseOrder', 'BillPayment'].map((type) => [type.toLowerCase(), type]));
  const clone = (value) => structuredClone(value);
  const qbo = {
    async create(entity, data) {
      calls.push(['create', entity]);
      const type = types.get(entity);
      const record = { ...clone(data), Id: String(++nextId), SyncToken: '0' };
      if (record.Line) record.Line = record.Line.map((line, i) => ({ ...line, Id: String(i + 1) }));
      records.set(type + ':' + record.Id, record);
      events.push('qbo:' + record.Id);
      return { [type]: clone(record) };
    },
    async read(entity, id) {
      calls.push(['read', entity, id]);
      const type = types.get(entity);
      return { [type]: clone(records.get(type + ':' + id)) };
    },
    async update(entity, data) {
      calls.push(['update', entity, data.Id]);
      const type = types.get(entity);
      const record = { ...records.get(type + ':' + data.Id), ...clone(data), SyncToken: String(Number(data.SyncToken) + 1) };
      records.set(type + ':' + data.Id, record);
      return { [type]: clone(record) };
    },
    async apiCall(method, path, data) {
      calls.push([method, path]);
      const type = types.get(path.split('?')[0]);
      if (!path.endsWith('operation=delete')) throw new Error('Unexpected fake operation');
      records.delete(type + ':' + data.Id);
      return { [type]: { Id: data.Id, status: 'Deleted' } };
    },
    async query() { return { QueryResponse: {} }; },
  };
  const state = { status: 'running' };
  const plan = { steps: [] };
  const options = {
    state, plan, qbo, messages: [],
    persist: async () => { events.push('persist:' + plan.steps.map((s) => s.status).join(',')); },
    assertActive: async () => {},
    audit: async () => { events.push('audit'); return { id: 'receipt' }; },
  };
  return { state, plan, qbo, records, calls, events, options };
}
const define = (tool, conditions = ['Observed quantity']) => tool('defineCase', { title: 'Test case', scenario: 'A supported reproduction', conditions });
const create = (tool, entityType, record) => tool('createRecord', { entityType, record, summary: 'Create ' + entityType });
const finish = (tool, outcome) => tool('finishCase', { outcome, summary: 'Result', tests: ['Executed test'], limitations: [] });
const line = (qty, po) => ({ Amount: qty * 100, DetailType: 'ItemBasedExpenseLineDetail',
  ItemBasedExpenseLineDetail: { Qty: qty, UnitPrice: 100 },
  ...(po ? { LinkedTxn: [{ TxnId: po, TxnType: 'PurchaseOrder', TxnLineId: '1' }] } : {}) });

test('PO scenario executes setup, three bills and quantity edits without approvals, then marks the unavailable display unverified', async () => {
  const f = fixture();
  let originalTotal;
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool, ['PO quantity is 6', 'Linked bills total 3.5', 'QBO displays 5 billed']);
    const vendor = (await create(tool, 'Vendor', { DisplayName: 'REPRO vendor' })).data.id;
    const po = await create(tool, 'PurchaseOrder', { VendorRef: { value: vendor }, Line: [line(6)] });
    assert.equal(po.savedRecord.Line[0].Id, '1', 'saved line ID reaches the agent');
    const bills = [];
    for (const quantities of [[1, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]) {
      bills.push(await create(tool, 'Bill', { VendorRef: { value: vendor }, Line: quantities.map((q) => line(q, po.data.id)) }));
    }
    originalTotal = bills.reduce((sum, bill) => sum + bill.savedRecord.Line.reduce((n, l) => n + l.ItemBasedExpenseLineDetail.Qty, 0), 0);
    for (const [index, quantities] of [[0, [0.5, 0.5, 0.5]], [1, [0.5, 0.25, 0.25]], [2, [0.5, 0.25, 0.25]]]) {
      const result = await tool('updateRecord', { entityType: 'Bill', id: bills[index].data.id,
        changes: { Line: quantities.map((q, i) => ({ ...line(q, po.data.id), Id: String(i + 1) })) }, summary: 'Reduce bill quantity' });
      assert.equal(result.success, true);
    }
    const check = (label, sources, expected, aggregate = 'single') => tool('checkCase', { label, sources, expected, aggregate, operator: 'equal' });
    await check('PO quantity is 6', [{ entityType: 'PurchaseOrder', id: po.data.id, path: 'Line.0.ItemBasedExpenseLineDetail.Qty' }], 6);
    const quantity = await check('Linked bills total 3.5', bills.map((b) => ({ entityType: 'Bill', id: b.data.id, path: 'Line.*.ItemBasedExpenseLineDetail.Qty' })), 3.5, 'sum');
    assert.equal(quantity.actual, 3.5);
    const display = await check('QBO displays 5 billed', [{ entityType: 'PurchaseOrder', id: po.data.id, path: 'UnavailableBilledQuantity' }], 5);
    assert.equal(display.available, false);
    await finish(tool, 'reproduced');
  } });
  assert.equal(originalTotal, 5);
  assert.equal(f.plan.steps.length, 8);
  assert.ok(f.plan.steps.every((s) => s.status === 'completed' && s.requiresConfirmation === false));
  assert.equal(f.state.outcome, 'unverified');
  assert.match(f.state.summary, /could not be verified/);
  const firstWrite = f.events.findIndex((v) => v.startsWith('qbo:'));
  assert.ok(f.events.slice(0, firstWrite).includes('persist:executing'));
  assert.equal(f.state.ownedRecords.length, 5);
});

test('general invoice scenario reads actual saved values and can establish a reproduced condition', async () => {
  const f = fixture();
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool, ['Invoice total is 120']);
    const customer = (await create(tool, 'Customer', { DisplayName: 'REPRO customer' })).data.id;
    const invoice = await create(tool, 'Invoice', { CustomerRef: { value: customer }, TotalAmt: 120, Line: [{ Amount: 120 }] });
    await tool('checkCase', { label: 'Invoice total is 120', sources: [{ entityType: 'Invoice', id: invoice.data.id, path: 'TotalAmt' }],
      expected: 120, aggregate: 'single', operator: 'equal' });
    await finish(tool, 'reproduced');
  } });
  assert.equal(f.state.outcome, 'reproduced');
});

test('server refuses foreign targets, nested links and live payment processing', () => {
  const owned = [{ entityType: 'Bill', id: '12' }];
  assert.throws(() => checkWrite('updateRecord', { entityType: 'Bill', id: '13', changes: {} }, owned), /Only records/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'BillPayment', record: { Line: [{ LinkedTxn: [{ TxnType: 'Bill', TxnId: '13' }] }] } }, owned), /Transaction links/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'Payment', record: { ProcessPayment: true } }, owned), /real payments/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'Invoice', record: { CustomerRef: { value: '999' } } }, owned), /existing balances/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'Invoice', record: { InvoiceRef: { value: '999' } } }, owned), /Unsupported relationship/);
  assert.ok(!reproductionTools.some((t) => ['runIssuePack', 'createCheckpoint', 'applyPayment'].includes(t.name)));
});

test('deletion only removes a case-owned transaction and preserves its operation receipt', async () => {
  const f = fixture();
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool);
    const bill = await create(tool, 'Bill', { Line: [line(1.5)] });
    const refusal = await tool('deleteRecord', { entityType: 'Bill', id: '999', summary: 'Foreign delete' });
    assert.equal(refusal.success, false);
    const result = await tool('deleteRecord', { entityType: 'Bill', id: bill.data.id, summary: 'Delete test bill' });
    assert.equal(result.data.deleted, true);
    await finish(tool, 'unverified');
  } });
  assert.equal(f.state.ownedRecords[0].deleted, true);
  assert.equal(f.records.size, 0);
  assert.equal(f.plan.steps[1].status, 'completed');
});

test('missing evidence is not zero, partial sums are unavailable, and old checks cannot prove the current state', () => {
  assert.deepEqual(evaluateCheck([{ record: {}, path: 'Qty' }], { aggregate: 'sum', expected: 0 }), { available: false, actual: null, passed: null });
  assert.equal(evaluateCheck([{ record: { Qty: 3.5 }, path: 'Qty' }, { record: {}, path: 'Qty' }], { aggregate: 'sum', expected: 3.5 }).available, false);
  assert.equal(classifyOutcome('reproduced', ['x'], [{ label: 'x', available: true, passed: true, revision: 1 }], 2), 'unverified');
  assert.equal(classifyOutcome('not_reproduced', ['x'], [{ label: 'x', available: true, passed: false, revision: 2 }], 2), 'not_reproduced');
});

test('ambiguous write outcome stops all further writes and never retries the create', async () => {
  const f = fixture();
  let attempts = 0;
  f.qbo.create = async () => { attempts += 1; throw new Error('Network response lost'); };
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool);
    await create(tool, 'Bill', {});
    const next = await create(tool, 'Bill', {});
    assert.match(next.error, /unknown outcome/);
  } });
  assert.equal(attempts, 1);
  assert.equal(f.state.outcome, 'unverified');
  assert.equal(f.state.outcomeUnknown, true);
  assert.equal(f.plan.steps[0].result.outcomeUnknown, true);
});

test('safe QBO validation failures can be corrected within the same run', async () => {
  const f = fixture();
  const createOriginal = f.qbo.create;
  let attempts = 0;
  f.qbo.create = async (...args) => {
    if (++attempts === 1) throw Object.assign(new Error('Invalid account'), { status: 400 });
    return createOriginal(...args);
  };
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool);
    assert.equal((await create(tool, 'Bill', {})).success, false);
    assert.equal((await create(tool, 'Bill', { Line: [line(1)] })).success, true);
    await finish(tool, 'unverified');
  } });
  assert.equal(attempts, 2);
  assert.equal(f.state.ownedRecords.length, 1);
});

test('audit failure prevents any external write', async () => {
  const f = fixture();
  await runEngine({ ...f.options, audit: async () => null, runModel: async (_messages, tool) => {
    await define(tool);
    await create(tool, 'Bill', {});
  } });
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.outcome, 'unverified');
});

test('scope loss and stop after a delayed write preserve the receipt and prevent a second change', async () => {
  const f = fixture();
  let stop = false;
  const original = f.qbo.create;
  f.qbo.create = async (...args) => { const result = await original(...args); stop = true; return result; };
  await runEngine({ ...f.options, assertActive: async () => { if (stop) throw new Error('Stopped at your request.'); },
    runModel: async (_messages, tool) => {
      await define(tool);
      assert.equal((await create(tool, 'Bill', {})).success, true);
      assert.equal((await create(tool, 'Bill', {})).success, false);
    } });
  assert.equal(f.plan.steps.length, 1);
  assert.equal(f.plan.steps[0].status, 'completed');
  assert.equal(f.state.status, 'stopped');
});

test('an early model answer receives automatic continuation instead of asking the user to manage setup', async () => {
  const f = fixture();
  let turns = 0;
  await runEngine({ ...f.options, runModel: async (messages, tool) => {
    turns += 1;
    if (turns === 1) { await define(tool); return 'I have prepared the setup.'; }
    assert.ok(messages.some((m) => /Continue the requested case/.test(m.content)));
    assert.match(messages.at(-1).content, /Current saved case state/);
    await finish(tool, 'unverified');
    return 'Finished';
  } });
  assert.equal(turns, 2);
});

test('parent and nested customer relationships cannot escape the case', () => {
  const owned = [{ entityType: 'Customer', id: '1' }, { entityType: 'Vendor', id: '2' }];
  assert.throws(() => checkWrite('createRecord', { entityType: 'Customer', record: { ParentRef: { value: '999' }, BillWithParent: true } }, owned), /Parent records/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'Bill', record: { VendorRef: { value: '2' },
    Line: [{ ItemBasedExpenseLineDetail: { CustomerRef: { value: '999' } } }] } }, owned), /Counterparty/);
});

test('validated SyncToken is used even if a concurrent editor changes the record', async () => {
  const f = fixture();
  const originalRead = f.qbo.read;
  let reads = 0;
  f.qbo.read = async (...args) => {
    reads += 1;
    const result = await originalRead(...args);
    if (args[0] === 'bill' && reads === 2) {
      // Another integration edits just after the validated read returns.
      f.records.get('Bill:' + args[1]).SyncToken = '9';
    }
    return result;
  };
  const originalUpdate = f.qbo.update;
  f.qbo.update = async (entity, data) => {
    assert.equal(data.SyncToken, '0', 'must not silently accept a newer foreign version');
    return originalUpdate(entity, data);
  };
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool);
    const bill = await create(tool, 'Bill', { Line: [line(5)] });
    await tool('updateRecord', { entityType: 'Bill', id: bill.data.id, changes: { Line: [line(3.5)] }, summary: 'Change quantity' });
    await finish(tool, 'unverified');
  } });
});

test('a second provider pass receives the first pass saved record identifiers', async () => {
  const f = fixture();
  let pass = 0; let billId;
  await runEngine({ ...f.options, runModel: async (messages, tool) => {
    if (++pass === 1) {
      await define(tool);
      billId = (await create(tool, 'Bill', { Line: [line(5)] })).data.id;
      return 'Setup is ready.';
    }
    const context = messages.at(-1).content;
    assert.ok(context.includes('"id":"' + billId + '"'));
    const result = await tool('updateRecord', { entityType: 'Bill', id: billId, changes: { Line: [line(3.5)] }, summary: 'Reduce quantity' });
    assert.equal(result.success, true);
    await finish(tool, 'unverified');
  } });
  assert.equal(f.calls.filter(([verb]) => verb === 'create').length, 1);
});

test('update payload cannot hide foreign links behind a harmless create payload', () => {
  const owned = [{ entityType: 'Bill', id: '12' }];
  assert.throws(() => checkWrite('updateRecord', { entityType: 'Bill', id: '12',
    record: {}, changes: { LinkedTxn: [{ TxnType: 'PurchaseOrder', TxnId: '999' }] } }, owned), /accepts changes/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'Bill',
    record: {}, changes: {} }, owned), /accepts a record/);
});
