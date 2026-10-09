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
// An unsupported finish is refused twice with the missing conditions; the third attempt finishes downgraded.
const finish = async (tool, outcome) => {
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await tool('finishCase', { outcome, summary: 'Result', tests: ['Executed test'], limitations: [] });
    if (!result.notFinished) break;
  }
  return result;
};
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

test('a change to a record that existed before the case waits for the owner and is not sent', async () => {
  const f = fixture();
  f.records.set('Bill:501', { Id: '501', SyncToken: '3', DocNumber: '80395456', VendorRef: { value: '77', name: '3252' }, TotalAmt: 120.47, Balance: 120.47, TxnDate: '2026-05-31' });
  const results = [];
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool, ['The duplicate bill is gone']);
    results.push(await tool('deleteRecord', { entityType: 'Bill', id: '501', summary: 'Delete the duplicate of bill 80395456' }));
    results.push(await tool('deleteRecord', { entityType: 'Bill', id: '501', summary: 'Again' }));
    results.push(await tool('updateRecord', { entityType: 'Bill', id: '501', changes: { ProcessBillPayment: true }, summary: 'Pay it' }));
    results.push(await tool('voidTransaction', { entityType: 'Bill', id: '501', summary: 'Void it' }));
    await finish(tool, 'unverified');
  } });
  assert.equal(results[0].approvalRequired, true);
  assert.equal(results[1].stepNumber, results[0].stepNumber, 'a repeated request reuses the waiting one');
  assert.equal(results[2].success, false);
  assert.match(results[3].error, /cannot be voided/);
  assert.ok(f.records.has('Bill:501'), 'nothing reached QuickBooks');
  assert.ok(!f.calls.some(([method]) => ['POST', 'update'].includes(method)));
  assert.equal(f.plan.steps.length, 1);
  const [step] = f.plan.steps;
  assert.equal(step.status, 'pending');
  assert.equal(step.requiresConfirmation, true);
  assert.equal(step.approval.state, 'needed');
  assert.equal(step.approval.syncToken, '3');
  assert.deepEqual(step.approval.record, { docNumber: '80395456', party: '3252', total: 120.47, balance: 120.47, txnDate: '2026-05-31', createdAt: null });
});

test('QBO metadata permits case-owned update, void and delete without entering the outgoing payload', async () => {
  const f = fixture();
  const originalRead = f.qbo.read;
  f.qbo.read = async (...args) => {
    const response = await originalRead(...args);
    for (const record of Object.values(response)) if (record) record.MetaData = { LastModifiedByRef: { value: 'qbo-user' } };
    return response;
  };
  const originalUpdate = f.qbo.update;
  f.qbo.update = async (entity, payload) => {
    assert.equal(payload.MetaData, undefined);
    assert.equal(payload.SyncToken, '0');
    return originalUpdate(entity, payload);
  };
  const originalApi = f.qbo.apiCall;
  f.qbo.apiCall = async (method, path, payload) => {
    assert.equal(payload.MetaData, undefined);
    if (path === 'invoice?operation=void') return { Invoice: { Id: payload.Id, SyncToken: '1' } };
    return originalApi(method, path, payload);
  };
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool);
    const bill = await create(tool, 'Bill', { Line: [line(5)] });
    const updated = await tool('updateRecord', { entityType: 'Bill', id: bill.data.id, changes: { Line: [line(3.5)] }, replaceAllLines: true, summary: 'Reduce hours' });
    assert.equal(updated.success, true);
    assert.equal(updated.savedRecord.Line[0].ItemBasedExpenseLineDetail.Qty, 3.5);
    const invoice = await create(tool, 'Invoice', { Line: [{ Amount: 10 }] });
    assert.equal((await tool('voidTransaction', { entityType: 'Invoice', id: invoice.data.id, summary: 'Void test' })).success, true);
    assert.equal((await tool('deleteRecord', { entityType: 'Bill', id: bill.data.id, summary: 'Delete test' })).success, true);
    await finish(tool, 'unverified');
  } });
  assert.equal(f.plan.steps.length, 5);
  assert.ok(f.plan.steps.every((step) => step.status === 'completed'));
});

test('compound quantity and link checks preserve failure through finishCase', async () => {
  const f = fixture();
  const label = 'Bill has 3.5 hours and retains its PO line';
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool, [label]);
    const po = await create(tool, 'PurchaseOrder', { Line: [line(6)] });
    const bill = await create(tool, 'Bill', { Line: [line(5, po.data.id)] });
    const compare = (path, expected) => tool('checkCase', { label, expected, operator: 'equal', aggregate: 'single',
      sources: [{ entityType: 'Bill', id: bill.data.id, path }] });
    assert.equal((await compare('Line.0.ItemBasedExpenseLineDetail.Qty', 3.5)).passed, false);
    assert.equal((await compare('Line.0.LinkedTxn.0.TxnLineId', '1')).passed, true);
    await finish(tool, 'completed');
  } });
  assert.equal(f.state.checks.length, 2);
  assert.equal(f.state.outcome, 'unverified');
});

test('evidence overflow cannot turn an unchecked failing comparison into a reproduced outcome', async () => {
  const f = fixture();
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool);
    const bill = await create(tool, 'Bill', { Line: [line(5)] });
    f.state.checks = Array.from({ length: 100 }, (_, i) => ({ label: 'Observed quantity', expected: i, actual: i,
      operator: 'equal', aggregate: 'single', available: true, passed: true, revision: f.state.revision,
      sources: [{ entityType: 'Bill', id: bill.data.id, path: 'Fixture' + i }] }));
    const result = await tool('checkCase', { label: 'Observed quantity', expected: 3.5, operator: 'equal', aggregate: 'single',
      sources: [{ entityType: 'Bill', id: bill.data.id, path: 'Line.0.ItemBasedExpenseLineDetail.Qty' }] });
    assert.equal(result.success, false);
    await finish(tool, 'reproduced');
  } });
  assert.equal(f.state.checks.length, 100, 'existing evidence is never evicted');
  assert.equal(f.state.outcome, 'unverified');
  assert.equal(f.state.status, 'stopped');
  assert.match(f.state.summary, /Evidence budget/);
});

const { providerTimeout } = require('../src/modules/ai-provider-timeout');
test('provider timeout resumes saved invoice without repeating its create', async () => {
  const f = fixture(); let passes = 0; let reconciled = 0;
  await runEngine({ ...f.options, confirmContinuation: async () => { reconciled++; }, runModel: async (messages, tool, _tools, budget) => {
    assert.ok(budget.deadline > Date.now());
    if (++passes === 1) {
      await define(tool, ['Invoice total is 120']);
      await create(tool, 'Invoice', { TotalAmt: 120, Line: [{ Amount: 120 }] });
      await tool('saveProgress', { currentStep: 'Check saved invoice', remainingSteps: ['Read total'] });
      throw providerTimeout('Codex', 300000);
    }
    assert.match(messages.at(-1).content, /Check saved invoice/);
    const id = f.state.ownedRecords[0].id;
    await tool('checkCase', { label: 'Invoice total is 120', sources: [{ entityType: 'Invoice', id, path: 'TotalAmt' }], expected: 120, aggregate: 'single', operator: 'equal' });
    await finish(tool, 'reproduced');
  } });
  assert.equal(passes, 2); assert.equal(reconciled, 1);
  assert.equal(f.calls.filter((c) => c[0] === 'create').length, 1);
  assert.equal(f.state.outcome, 'reproduced');
  assert.equal(f.state.continuationCount, 1);
});
test('only identified model timeouts resume, and repeated idle timeouts stop', async () => {
  for (const error of [Object.assign(new Error('QBO unavailable'), { status: 504 }), new Error('Authentication failed')]) {
    const f = fixture(); let passes = 0;
    await runEngine({ ...f.options, confirmContinuation: async () => assert.fail('must not resume'), runModel: async () => { passes++; throw error; } });
    assert.equal(passes, 1); assert.equal(f.state.status, 'stopped');
  }
  const f = fixture(); let passes = 0;
  await runEngine({ ...f.options, confirmContinuation: async () => {}, runModel: async () => { passes++; throw providerTimeout('Codex', 300000); } });
  assert.equal(passes, 2); assert.match(f.state.summary, /repeatedly/);
});
test('stop, changed scope, unknown writes and missing receipts prevent model continuation', async () => {
  for (const reason of ['Stopped at your request', 'Company disconnected', 'Saved receipts missing']) {
    const f = fixture(); let passes = 0;
    await runEngine({ ...f.options, confirmContinuation: async () => { throw new Error(reason); }, runModel: async () => { passes++; throw providerTimeout('Codex', 300000); } });
    assert.equal(passes, 1); assert.ok(f.state.summary.includes(reason));
  }
  const f = fixture(); let passes = 0;
  f.plan.steps.push({ status: 'executing', result: { outcomeUnknown: true } });
  await runEngine({ ...f.options, confirmContinuation: async () => {}, runModel: async () => { passes++; throw providerTimeout('Codex', 300000); } });
  assert.equal(passes, 1); assert.match(f.state.summary, /reconciliation/);
});
test('verification reserve blocks changes while allowing saved evidence and final result', async () => {
  const f = fixture(); f.state.conditions = ['Observed quantity'];
  f.state.ownedRecords = [{ entityType: 'Bill', id: '20' }];
  f.records.set('Bill:20', { Id: '20', Line: [line(3.5)] });
  await runEngine({ ...f.options, deadline: Date.now() + 60000, runModel: async (_m, tool) => {
    const denied = await create(tool, 'Bill', { Line: [line(5)] });
    assert.equal(denied.verificationOnly, true);
    await tool('checkCase', { label: 'Observed quantity', sources: [{ entityType: 'Bill', id: '20', path: 'Line.*.ItemBasedExpenseLineDetail.Qty' }], expected: 3.5, aggregate: 'sum', operator: 'equal' });
    await finish(tool, 'reproduced');
  } });
  assert.equal(f.calls.filter((c) => c[0] === 'create').length, 0);
  assert.equal(f.state.outcome, 'reproduced');
});
test('transaction batches require evidence before further changes', async () => {
  const f = fixture();
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool);
    const bills = [];
    for (let i = 0; i < 8; i++) bills.push(await create(tool, 'Bill', { Line: [line(5)] }));
    assert.match((await create(tool, 'Bill', { Line: [line(5)] })).error, /Read the affected records/);
    await tool('checkCase', { label: 'Observed quantity', sources: bills.map((b) => ({ entityType: 'Bill', id: b.data.id, path: 'Line.*.ItemBasedExpenseLineDetail.Qty' })), expected: 40, aggregate: 'sum', operator: 'equal' });
    assert.equal((await create(tool, 'Bill', { Line: [line(5)] })).success, true);
    await finish(tool, 'unverified');
  } });
  assert.equal(f.plan.steps.length, 9);
});
test('failed progress persistence stops automatic continuation', async () => {
  const f = fixture(); let passes = 0;
  await assert.rejects(() => runEngine({ ...f.options, persist: async () => { throw new Error('database down'); }, confirmContinuation: async () => assert.fail('must not continue'), runModel: async (_m, tool) => {
    passes++; try { await tool('saveProgress', { currentStep: 'Setup', remainingSteps: [] }); } catch {}
    throw providerTimeout('Codex', 300000);
  } }), /database down/);
  assert.equal(passes, 1);
});

test('write-budget exhaustion still permits verification', async () => {
  const f = fixture();
  await runEngine({ ...f.options, maxWrites: 1, runModel: async (_m, tool) => {
    await define(tool);
    const bill = await create(tool, 'Bill', { Line: [line(5)] });
    assert.equal((await create(tool, 'Bill', { Line: [line(5)] })).verificationOnly, true);
    await tool('checkCase', { label: 'Observed quantity', sources: [{ entityType: 'Bill', id: bill.data.id, path: 'Line.*.ItemBasedExpenseLineDetail.Qty' }], expected: 5, aggregate: 'sum', operator: 'equal' });
    await finish(tool, 'reproduced');
  } });
  assert.equal(f.state.outcome, 'reproduced'); assert.equal(f.plan.steps.length, 1);
});
test('preflight crossing the reserve does not send the prepared change', async () => {
  const f = fixture(); const now = Date.now; let clock = now();
  Date.now = () => clock;
  try {
    await runEngine({ ...f.options, deadline: clock + 100000, audit: async (action) => {
      if (action.startsWith('Case change started')) clock += 20000;
      return {};
    }, runModel: async (_m, tool) => {
      await define(tool);
      const result = await create(tool, 'Bill', { Line: [line(5)] });
      assert.match(result.error, /No change was sent/);
      await finish(tool, 'unverified');
    } });
  } finally { Date.now = now; }
  assert.equal(f.calls.filter((c) => c[0] === 'create').length, 0);
  assert.equal(f.plan.steps[0].result.outcomeUnknown, false);
});

test('batch verification includes linked parents retained only in the pre-edit record', async () => {
  const f = fixture();
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool);
    const po = await create(tool, 'PurchaseOrder', { Line: [line(6)] });
    const bill = await create(tool, 'Bill', { Line: [line(5, po.data.id)] });
    await tool('getEntityDetail', { type: 'PurchaseOrder', id: po.data.id });
    await tool('checkCase', { label: 'Observed quantity', sources: [{ entityType: 'Bill', id: bill.data.id, path: 'Line.*.ItemBasedExpenseLineDetail.Qty' }], expected: 5, aggregate: 'sum', operator: 'equal' });
    for (let i = 0; i < 8; i++) {
      const updated = await tool('updateRecord', { entityType: 'Bill', id: bill.data.id, changes: { Line: [line(3.5)] }, summary: 'Remove original link and edit quantity' });
      assert.equal(updated.success, true);
    }
    const checkBill = () => tool('checkCase', { label: 'Observed quantity', sources: [{ entityType: 'Bill', id: bill.data.id, path: 'Line.*.ItemBasedExpenseLineDetail.Qty' }], expected: 3.5, aggregate: 'sum', operator: 'equal' });
    await checkBill();
    const blocked = await create(tool, 'Bill', { Line: [line(1)] });
    assert.equal(blocked.success, false);
    assert.deepEqual(blocked.pendingInspections, ['PurchaseOrder:' + po.data.id]);
    await tool('getEntityDetail', { type: 'PurchaseOrder', id: po.data.id });
    await checkBill();
    assert.equal((await create(tool, 'Bill', { Line: [line(1)] })).success, true);
    await finish(tool, 'unverified');
  } });
});

test('screen observations use numeric tolerance and contribute to the final evidence', async () => {
  const f = fixture();
  f.state.conditions = ['Screen quantity']; f.state.revision = 4;
  f.state.ownedRecords = [{ entityType: 'PurchaseOrder', id: '608' }];
  await runEngine({ ...f.options, inspectScreen: async () => ({ kind: 'observed_screen', actual: 0.1 + 0.2, revision: 4 }),
    runModel: async (_messages, tool) => {
      const check = await tool('checkScreen', { label: 'Screen quantity', id: '608', expected: 0.3, operator: 'equal' });
      assert.equal(check.passed, true);
      await finish(tool, 'reproduced');
    } });
  assert.equal(f.state.outcome, 'reproduced');
});
test('missing or stale screen evidence remains unverified', async () => {
  for (const inspectScreen of [undefined, async () => ({ kind: 'observed_screen', actual: 5, revision: 3 })]) {
    const f = fixture(); f.state.conditions = ['Screen quantity']; f.state.revision = 4;
    f.state.ownedRecords = [{ entityType: 'PurchaseOrder', id: '608' }];
    await runEngine({ ...f.options, inspectScreen, runModel: async (_messages, tool) => {
      const check = await tool('checkScreen', { label: 'Screen quantity', id: '608', expected: 5, operator: 'equal' });
      assert.equal(check.available, false);
      await finish(tool, 'reproduced');
    } });
    assert.equal(f.state.outcome, 'unverified');
  }
});
test('screen evidence overflow cannot discard a failure and certify earlier passes', async () => {
  const f = fixture(); f.state.conditions = ['Screen quantity']; f.state.revision = 4;
  f.state.ownedRecords = [{ entityType: 'PurchaseOrder', id: '608' }];
  f.state.checks = Array.from({ length: 100 }, (_, i) => ({ label: 'Screen quantity', expected: 5, operator: 'equal', aggregate: 'single',
    available: true, passed: true, actual: 5, revision: 4, sources: [{ entityType: 'PurchaseOrder', id: String(i), path: 'screen.billedQuantity' }] }));
  await runEngine({ ...f.options, inspectScreen: async () => ({ kind: 'observed_screen', actual: 3.5, revision: 4 }),
    runModel: async (_messages, tool) => {
      const check = await tool('checkScreen', { label: 'Screen quantity', id: '608', expected: 5, operator: 'equal' });
      assert.equal(check.success, false); await finish(tool, 'reproduced');
    } });
  assert.equal(f.state.outcome, 'unverified'); assert.match(f.state.summary, /Evidence budget/);
});

test('Received evidence does not replace an unavailable Billed measurement', async () => {
  const f = fixture(); f.state.conditions = ['Reported billed discrepancy']; f.state.revision = 4;
  f.state.ownedRecords = [{ entityType: 'PurchaseOrder', id: '608' }];
  await runEngine({ ...f.options, inspectScreen: async ({ field }) => {
    if (field === 'billedQuantity') throw new Error('Billed column not present');
    return { kind: 'observed_screen', field, actual: 3.5, revision: 4 };
  }, runModel: async (_messages, tool) => {
    await tool('checkScreen', { label: 'Reported billed discrepancy', id: '608', expected: 5, operator: 'equal' });
    await tool('checkScreen', { label: 'Reported billed discrepancy', id: '608', field: 'receivedQuantity', expected: 3.5, operator: 'equal' });
    await finish(tool, 'reproduced');
  } });
  assert.equal(f.state.outcome, 'unverified'); assert.equal(f.state.checks.length, 2);
  assert.equal(f.state.checks[0].sources[0].path, 'screen.billedQuantity');
  assert.equal(f.state.checks[1].sources[0].path, 'screen.receivedQuantity');
});

test('new dispatch receipts persist server scope before QBO and ignore supplied scope', async () => {
  const f = fixture(); f.plan.realmId = 'actual-realm'; f.state.environment = 'production'; f.state.connectionId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const snapshots = [];
  f.options.persist = async () => snapshots.push(structuredClone(f.plan.steps));
  await runEngine({ ...f.options, runModel: async (_messages, tool) => {
    await define(tool);
    await tool('createRecord', { entityType: 'Vendor', record: { DisplayName: 'Fixture vendor' }, summary: 'Create fixture',
      executionScope: { realmId: 'other', environment: 'sandbox' } });
    await finish(tool, 'unverified');
  } });
  const scope = { version: 1, realmId: 'actual-realm', environment: 'production', connectionId: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
  assert.deepEqual(snapshots.find(steps => steps[0]?.status === 'executing')[0].executionScope, scope);
  assert.deepEqual(f.plan.steps[0].executionScope, scope);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
});

const { systemPrompt, companyToday, caseStateSnapshot } = require('../src/modules/reproduction-engine');
test('the prompt and tools are general, not tuned to one purchase-order case', () => {
  const prompt = systemPrompt({ companyName: 'Fixture Co', environment: 'production', caseLabel: 'abcd1234' });
  assert.match(prompt, /Fixture Co/); assert.match(prompt, /REPRO-abcd1234/);
  assert.match(prompt, new RegExp('Today: ' + companyToday() + '\\.'));
  // 02:30 UTC on October 9 is still October 8 in Toronto.
  assert.equal(companyToday(new Date('2026-10-09T02:30:00Z')), '2026-10-08');
  assert.match(prompt, /askOperator/); assert.match(prompt, /not moving real money/);
  assert.doesNotMatch(prompt, /PurchaseOrder|purchase-order|TxnLineId|discrepanc|billed quantit|mixed-PO/i);
  const tools = Object.fromEntries(reproductionTools.map((t) => [t.name, t]));
  assert.ok(reproductionTools.every((t) => !/Queued for user approval/.test(t.description)));
  assert.doesNotMatch(tools.defineCase.description + tools.checkCase.description, /discrepanc|billed/i);
  assert.match(tools.checkScreen.description, /only screen value/);
  assert.deepEqual(tools.finishCase.input_schema.properties.outcome.enum, ['completed', 'reproduced', 'not_reproduced', 'unverified']);
  assert.deepEqual(tools.askOperator.input_schema.required, ['question']);
});

test('askOperator ends the run before defineCase and saves the question with options', async () => {
  const f = fixture(); let turns = 0; const results = [];
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    turns += 1;
    results.push(await tool('askOperator', { question: 'x'.repeat(1001) }));
    results.push(await tool('askOperator', { question: 'Which account?', options: Array(9).fill('A') }));
    results.push(await tool('askOperator', { question: ' Which account should the transfer come from? ', options: ['Chequing (1000)', 'Savings (1010)'] }));
    results.push(await tool('createRecord', { entityType: 'Vendor', record: {}, summary: 'after asking' }));
    return 'Waiting for the operator.';
  } });
  assert.equal(turns, 1);
  assert.equal(results[0].success, false); assert.equal(results[1].success, false); assert.equal(results[2].success, true);
  assert.match(results[3].error, /finished/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.outcome, 'needs_input'); assert.equal(f.state.status, 'completed');
  assert.equal(f.state.awaitingOperator.question, 'Which account should the transfer come from?');
  assert.deepEqual(f.state.awaitingOperator.options, ['Chequing (1000)', 'Savings (1010)']);
  assert.equal(f.state.awaitingOperator.source, 'askOperator');
  assert.ok(f.state.awaitingOperator.askedAt instanceof Date);
  assert.equal(f.state.summary, 'Which account should the transfer come from?\n\nOptions:\n1. Chequing (1000)\n2. Savings (1010)');
});

test('a pass without tool calls hands its reply to the operator instead of looping', async () => {
  const f = fixture(); let turns = 0;
  await runEngine({ ...f.options, runModel: async () => { turns += 1; return 'Which bank account should the $40,000 come from?'; } });
  assert.equal(turns, 1);
  assert.equal(f.state.outcome, 'needs_input'); assert.equal(f.state.status, 'completed');
  assert.equal(f.state.summary, 'Which bank account should the $40,000 come from?');
  assert.equal(f.state.awaitingOperator.source, 'reply');
  assert.equal(f.state.agentReplies.length, 1);
  assert.equal(f.state.agentReplies[0].text, 'Which bank account should the $40,000 come from?');
  assert.equal(f.state.agentReplies[0].toolCalls, 0); assert.equal(f.state.agentReplies[0].pass, 1);

  const silent = fixture();
  await runEngine({ ...silent.options, runModel: async () => ({ text: '', toolsListed: false, toolCalls: 0 }) });
  assert.equal(silent.state.outcome, 'needs_input');
  assert.match(silent.state.summary, /may not have received them/);
  assert.equal(silent.state.awaitingOperator.source, 'no_reply');
  assert.equal(silent.state.agentReplies[0].toolsListed, false);
});

test('model replies and the tool trace are saved, bounded and not looped indefinitely', async () => {
  const f = fixture(); let turns = 0;
  f.state.toolTrace = Array.from({ length: 199 }, (_, i) => ({ tool: 'old' + i, ok: true }));
  await runEngine({ ...f.options, maxPasses: 15, runModel: async (_m, tool) => {
    turns += 1;
    await tool('saveProgress', { currentStep: 'Step ' + turns, remainingSteps: [] });
    if (turns === 1) await tool('checkCase', { label: 'Undefined', sources: [], aggregate: 'single', operator: 'equal', expected: 1 });
    return 'Reply ' + turns + ' ' + 'y'.repeat(5000);
  } });
  assert.equal(turns, 15);
  assert.equal(f.state.agentReplies.length, 12);
  assert.equal(f.state.agentReplies.at(-1).pass, 15);
  assert.ok(f.state.agentReplies.every((r) => r.text.length <= 4000 && r.toolCalls >= 1));
  assert.equal(f.state.toolTrace.length, 200);
  assert.equal(f.state.toolTrace.at(-1).tool, 'saveProgress');
  assert.ok(!f.state.toolTrace.some((t) => t.tool === 'old0'));
  const failed = f.state.toolTrace.find((t) => t.tool === 'checkCase');
  assert.equal(failed.ok, false); assert.match(failed.error, /defined condition/);
  assert.equal(f.state.outcome, 'unverified');
  assert.match(f.state.summary, /stopped before establishing a verified result\. Its last reply: Reply 15/);
});

test('completed requires current passing checks for every condition', async () => {
  const label = 'Transfer of 40000 on 2026-04-21';
  const current = { label, available: true, passed: true, revision: 3, sources: [] };
  assert.equal(classifyOutcome('completed', [label], [current], 3), 'completed');
  assert.equal(classifyOutcome('completed', [label], [current], 4), 'unverified');
  assert.equal(classifyOutcome('completed', [label, 'Account exists'], [current], 3), 'unverified');
  assert.equal(classifyOutcome('completed', [label], [{ ...current, passed: false }], 3), 'unverified');
  assert.equal(classifyOutcome('needs_input', [], [], 0), 'needs_input');
  assert.equal(classifyOutcome('anything', [label], [current], 3), 'unverified');

  const f = fixture();
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool, ['Invoice total is 120']);
    const customer = (await create(tool, 'Customer', { DisplayName: 'REPRO customer' })).data.id;
    const invoice = await create(tool, 'Invoice', { CustomerRef: { value: customer }, TotalAmt: 120 });
    await tool('checkCase', { label: 'Invoice total is 120', sources: [{ entityType: 'Invoice', id: invoice.data.id, path: 'TotalAmt' }], expected: 120, aggregate: 'single', operator: 'equal' });
    await finish(tool, 'completed');
  } });
  assert.equal(f.state.outcome, 'completed');

  const claimed = fixture();
  await runEngine({ ...claimed.options, runModel: async (_m, tool) => { await define(tool); await finish(tool, 'needs_input'); } });
  assert.equal(claimed.state.outcome, 'unverified');
  assert.equal(claimed.state.awaitingOperator, null);
});

test('defineCase can be rewritten before changes and only extended after changes in the same run', async () => {
  const f = fixture(); const results = [];
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool, ['Transfer from Chequing']);
    results.push(await define(tool, ['Transfer from Savings']));
    await create(tool, 'Vendor', { DisplayName: 'REPRO vendor' });
    results.push(await define(tool, ['Something else']));
    results.push(await define(tool, ['Transfer from Savings', 'Memo mentions the case']));
    await finish(tool, 'unverified');
  } });
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false); assert.match(results[1].error, /must be kept/);
  assert.equal(results[2].success, true);
  assert.deepEqual(f.state.conditions, ['Transfer from Savings', 'Memo mentions the case']);
  assert.equal(f.state.definitionHistory.length, 2);
  assert.deepEqual(f.state.definitionHistory[0].conditions, ['Transfer from Chequing']);
});

test('a new operator turn may rewrite an earlier definition before its first change, but not drop checked conditions', async () => {
  const earlier = () => {
    const f = fixture();
    f.state.conditions = ['Transfer of 40000']; f.state.title = 'Old'; f.state.scenario = 'Old request'; f.state.revision = 1;
    f.state.ownedRecords = [{ entityType: 'Vendor', id: '20', stepNumber: 1 }];
    f.records.set('Vendor:20', { Id: '20', DisplayName: 'REPRO vendor' });
    f.plan.steps.push({ stepNumber: 1, toolName: 'createRecord', toolInput: { entityType: 'Vendor' }, status: 'completed', result: { data: { id: '20' } } });
    return f;
  };
  const rewrite = (tool) => tool('defineCase', { title: 'New', scenario: 'Operator changed the amount', conditions: ['Transfer of 50000'], reason: 'Operator changed the amount' });
  const f = earlier(); let result;
  await runEngine({ ...f.options, runModel: async (_m, tool) => { result = await rewrite(tool); await finish(tool, 'unverified'); } });
  assert.equal(result.success, true);
  assert.deepEqual(f.state.conditions, ['Transfer of 50000']);
  assert.equal(f.state.definitionHistory[0].reason, 'Operator changed the amount');

  const afterWrite = earlier();
  await runEngine({ ...afterWrite.options, runModel: async (_m, tool) => {
    await create(tool, 'Vendor', { DisplayName: 'Another' }); result = await rewrite(tool); await finish(tool, 'unverified');
  } });
  assert.equal(result.success, false);

  const checked = earlier();
  await runEngine({ ...checked.options, runModel: async (_m, tool) => {
    await tool('checkCase', { label: 'Transfer of 40000', sources: [{ entityType: 'Vendor', id: '20', path: 'DisplayName' }], expected: 'REPRO vendor', aggregate: 'single', operator: 'equal' });
    result = await rewrite(tool); await finish(tool, 'unverified');
  } });
  assert.equal(result.success, false);
  assert.deepEqual(checked.state.conditions, ['Transfer of 40000']);
});

test('an operator question whose save fails ends as an unverified stop, not a pending question', async () => {
  const f = fixture(); let saves = 0;
  await runEngine({ ...f.options, persist: async () => { if (++saves === 1) throw new Error('database down'); }, runModel: async (_m, tool) => {
    await tool('askOperator', { question: 'Which account?' }).catch(() => {});
  } });
  assert.equal(f.state.outcome, 'unverified'); assert.equal(f.state.status, 'stopped');
  assert.equal(f.state.awaitingOperator, null);
});

const balanceSheet = {
  Header: { ReportName: 'BalanceSheet', StartPeriod: '2026-01-01', EndPeriod: '2026-04-21', ReportBasis: 'Accrual' },
  Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
  Rows: { Row: [
    { Header: { ColData: [{ value: 'Equity' }, { value: '' }] }, Rows: { Row: [
      { ColData: [{ value: 'Owner Distributions', id: '91' }, { value: '-40,000.00' }] },
      { ColData: [{ value: 'Retained Earnings' }, { value: '' }] },
    ] }, Summary: { ColData: [{ value: 'Total Equity' }, { value: '(40,000.00)' }] } },
    { Header: { ColData: [{ value: 'Bank' }] }, Rows: { Row: [{ ColData: [{ value: 'Chequing' }, { value: '10000' }] }] } },
    { Header: { ColData: [{ value: 'Savings' }] }, Rows: { Row: [{ ColData: [{ value: 'Chequing' }, { value: '5' }] }] } },
  ] },
};
test('checkReport records labelled report values as current evidence', async () => {
  const f = fixture(); const paths = []; const results = {};
  f.qbo.apiCall = async (method, path) => { paths.push([method, path]); return structuredClone(balanceSheet); };
  const conditions = ['Owner Distributions is -40000', 'Total equity is -40000'];
  const report = (tool, extra) => tool('checkReport', { report: 'BalanceSheet', reportDate: '2026-04-21', operator: 'equal', label: conditions[0], ...extra });
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool, conditions);
    results.distributions = await report(tool, { row: 'owner distributions', expected: -40000 });
    results.total = await report(tool, { label: conditions[1], row: 'Total Equity', column: 'Total', expected: -40000 });
    results.empty = await report(tool, { row: 'Retained Earnings', expected: 0 });
    results.ambiguous = await report(tool, { row: 'Chequing', expected: 5 });
    results.section = await report(tool, { row: 'Chequing', section: 'Savings', expected: 5 });
    results.column = await report(tool, { row: 'Chequing', section: 'Savings', column: 'Nope', expected: 5 });
    results.undefinedLabel = await report(tool, { label: 'Not defined', row: 'Chequing', expected: 5 });
    results.badDate = await report(tool, { reportDate: 'April 21', row: 'Chequing', expected: 5 });
    await finish(tool, 'completed');
  } });
  assert.deepEqual(paths[0], ['GET', 'reports/BalanceSheet?report_date=2026-04-21']);
  assert.equal(results.distributions.passed, true); assert.equal(results.distributions.actual, -40000);
  assert.equal(results.total.passed, true);
  assert.equal(results.empty.available, false); assert.match(results.empty.reason, /empty/);
  assert.equal(results.ambiguous.available, false); assert.match(results.ambiguous.reason, /Several/);
  assert.equal(results.section.actual, 5);
  assert.equal(results.column.available, false); assert.deepEqual(results.column.columns, ['Account', 'Total']);
  assert.equal(results.undefinedLabel.success, false);
  assert.match(results.badDate.error, /YYYY-MM-DD/);
  const saved = f.state.checks.find((c) => c.label === conditions[1]);
  assert.deepEqual(saved.sources[0], { entityType: 'Report', id: 'BalanceSheet?reportDate=2026-04-21', path: 'row:Total Equity|column:Total', values: [-40000] });
  assert.equal(saved.evidence.kind, 'report'); assert.equal(saved.evidence.text, '(40,000.00)');
  // Unavailable cells under the first condition keep the result unverified.
  assert.equal(f.state.outcome, 'unverified');
});

test('checkReport evidence alone can verify a completed report request', async () => {
  const f = fixture();
  f.qbo.apiCall = async () => structuredClone(balanceSheet);
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool, ['Owner Distributions is -40000']);
    await tool('checkReport', { label: 'Owner Distributions is -40000', report: 'BalanceSheet', row: 'Owner Distributions', operator: 'equal', expected: -40000 });
    await finish(tool, 'completed');
  } });
  assert.equal(f.state.outcome, 'completed');
});

test('a write that failed before leaving the server is definite; an unconfirmed receipt is not', async () => {
  for (const [error, unknown] of [
    [Object.assign(new Error('Token refresh failed'), { qboStage: 'refresh' }), false],
    [Object.assign(new Error('Refresh response incomplete'), { qboStage: 'refresh_response', status: 502 }), false],
    [Object.assign(new Error('Tokens not saved'), { qboStage: 'storage_save' }), false],
    [Object.assign(new Error('Receipt not saved'), { qboStage: 'write_receipt', status: 503, outcomeUnknown: true }), true],
    [Object.assign(new Error('Gateway'), { qboStage: 'api', status: 502 }), true],
  ]) {
    const f = fixture(); let attempts = 0;
    const createOriginal = f.qbo.create;
    f.qbo.create = async (...args) => { if (++attempts === 1) throw error; return createOriginal(...args); };
    await runEngine({ ...f.options, runModel: async (_m, tool) => {
      await define(tool);
      await create(tool, 'Vendor', { DisplayName: 'REPRO vendor' });
      await create(tool, 'Vendor', { DisplayName: 'REPRO vendor' });
      await finish(tool, 'unverified');
    } });
    assert.equal(f.plan.steps[0].result.outcomeUnknown, unknown, error.message);
    assert.equal(!!f.state.outcomeUnknown, unknown, error.message);
    assert.equal(attempts, unknown ? 1 : 2, error.message);
  }
});

test('an existing bundle cannot be referenced through GroupItemRef', async () => {
  const f = fixture(); let result;
  f.records.set('Item:7', { Id: '7', Type: 'Group' });
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool);
    result = await create(tool, 'Invoice', { Line: [{ DetailType: 'GroupLineDetail', GroupLineDetail: { GroupItemRef: { value: '7' } } }] });
    await finish(tool, 'unverified');
  } });
  assert.match(result.error, /bundle/);
  assert.equal(f.calls.filter((c) => c[0] === 'create').length, 0);
});

test('the per-pass case state is compact', () => {
  const big = 'x'.repeat(5000);
  const plan = { steps: Array.from({ length: 70 }, (_, i) => ({ stepNumber: i + 1, toolName: 'createRecord', status: 'completed',
    toolInput: { entityType: 'Bill', record: { PrivateNote: big } }, result: { success: true, data: { id: String(i), note: big } } })) };
  const state = { scenario: 's', conditions: ['c'], ownedRecords: plan.steps.map((s) => ({ entityType: 'Bill', id: String(s.stepNumber) })),
    checks: [{ label: 'c', sources: [{ entityType: 'Bill', id: '1', path: 'Line.*.Amount', values: Array(1000).fill(1) }], actual: 1, revision: 1 }] };
  const snapshot = caseStateSnapshot(state, plan);
  assert.equal(snapshot.operations.length, 60); assert.equal(snapshot.earlierOperations, 10);
  assert.equal(snapshot.operations[0].step, 11);
  assert.equal(snapshot.operations[0].input.clipped, true);
  assert.equal(snapshot.ownedRecords.length, 70);
  assert.deepEqual(snapshot.checks[0].sources, [{ entityType: 'Bill', id: '1', path: 'Line.*.Amount' }]);
  assert.ok(JSON.stringify(snapshot).length < 200000);
});

test('evidence tools accept a condition by exact text, loose text or number, and list conditions on a mismatch', async () => {
  const f = fixture(); const results = [];
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool, ['Invoice total is 120', 'Customer exists']);
    const customer = (await create(tool, 'Customer', { DisplayName: 'REPRO customer' })).data.id;
    const invoice = (await create(tool, 'Invoice', { CustomerRef: { value: customer }, TotalAmt: 120 })).data.id;
    const total = (extra) => tool('checkCase', { sources: [{ entityType: 'Invoice', id: invoice, path: 'TotalAmt' }], expected: 120, aggregate: 'single', operator: 'equal', ...extra });
    results.push(await total({ label: '  invoice TOTAL is 120 ' }));
    results.push(await total({ condition: 1 }));
    results.push(await total({ label: 'Something else' }));
    results.push(await total({ condition: 3 }));
    results.push(await tool('checkCase', { condition: 2, sources: [{ entityType: 'Customer', id: customer, path: 'exists' }], expected: true, aggregate: 'single', operator: 'equal' }));
    await finish(tool, 'completed');
  } });
  assert.equal(results[0].passed, true); assert.equal(results[1].passed, true);
  assert.equal(f.state.checks.filter((c) => c.label === 'Invoice total is 120').length, 1, 'the same measurement is refreshed, not duplicated');
  for (const refused of [results[2], results[3]]) {
    assert.equal(refused.success, false);
    assert.match(refused.error, /1\. Invoice total is 120 2\. Customer exists/);
  }
  assert.equal(results[4].passed, true);
  assert.equal(f.state.outcome, 'completed');
});

test('finishCase names unsupported conditions twice before finishing downgraded', async () => {
  const f = fixture(); const attempts = [];
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool, ['Invoice total is 120', 'Invoice date is 2026-04-21']);
    const customer = (await create(tool, 'Customer', { DisplayName: 'REPRO customer' })).data.id;
    const invoice = (await create(tool, 'Invoice', { CustomerRef: { value: customer }, TotalAmt: 120, TxnDate: '2026-04-20' })).data.id;
    await tool('checkCase', { condition: 1, sources: [{ entityType: 'Invoice', id: invoice, path: 'TotalAmt' }], expected: 120, aggregate: 'single', operator: 'equal' });
    attempts.push(await tool('finishCase', { outcome: 'completed', summary: 'Built', tests: [], limitations: [] }));
    await tool('checkCase', { condition: 2, sources: [{ entityType: 'Invoice', id: invoice, path: 'TxnDate' }], expected: '2026-04-21', aggregate: 'single', operator: 'equal' });
    attempts.push(await tool('finishCase', { outcome: 'completed', summary: 'Built', tests: [], limitations: [] }));
    attempts.push(await tool('finishCase', { outcome: 'completed', summary: 'Built', tests: [], limitations: [] }));
  } });
  assert.equal(attempts[0].success, false); assert.match(attempts[0].error, /2\. Invoice date is 2026-04-21: not checked/);
  assert.doesNotMatch(attempts[0].error, /1\. Invoice total/);
  assert.match(attempts[1].error, /2\. Invoice date is 2026-04-21: a check did not pass/);
  assert.equal(attempts[2].success, true); assert.equal(attempts[2].outcome, 'unverified');
  assert.equal(f.state.outcome, 'unverified'); assert.equal(f.state.status, 'completed');
});

test('not_reproduced is accepted when every condition has current evidence, even if all checks passed', async () => {
  const f = fixture();
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool, ['Credit memo reduces the balance to 0']);
    const customer = (await create(tool, 'Customer', { DisplayName: 'REPRO customer' })).data.id;
    const invoice = (await create(tool, 'Invoice', { CustomerRef: { value: customer }, Balance: 0 })).data.id;
    await tool('checkCase', { condition: 1, sources: [{ entityType: 'Invoice', id: invoice, path: 'Balance' }], expected: 0, aggregate: 'single', operator: 'equal' });
    await finish(tool, 'not_reproduced');
  } });
  assert.equal(f.state.outcome, 'not_reproduced');
});

test('a historical check survives later changes and a deleted case record reads as absent', async () => {
  const f = fixture(); let absent;
  await runEngine({ ...f.options, runModel: async (_m, tool) => {
    await define(tool, ['Before deletion the bill total is 150', 'The bill is gone afterwards']);
    const bill = (await create(tool, 'Bill', { TotalAmt: 150, Line: [line(1.5)] })).data.id;
    await tool('checkCase', { condition: 1, historical: true, sources: [{ entityType: 'Bill', id: bill, path: 'TotalAmt' }], expected: 150, aggregate: 'single', operator: 'equal' });
    await tool('deleteRecord', { entityType: 'Bill', id: bill, summary: 'Delete test bill' });
    const refused = await tool('checkCase', { condition: 1, sources: [{ entityType: 'Bill', id: bill, path: 'TotalAmt' }], expected: 150, aggregate: 'single', operator: 'equal' });
    assert.match(refused.error, /path exists/);
    absent = await tool('checkCase', { condition: 2, sources: [{ entityType: 'Bill', id: bill, path: 'exists' }], expected: false, aggregate: 'single', operator: 'equal' });
    await finish(tool, 'completed');
  } });
  assert.equal(absent.passed, true); assert.equal(absent.actual, false);
  assert.equal(f.state.checks[0].historical, true);
  assert.equal(f.state.outcome, 'completed');
});

test('a record QuickBooks no longer finds reads as absent; other read errors stay errors', async () => {
  for (const [error, expected] of [[Object.assign(new Error('QBO API error (HTTP 400): Object Not Found'), { status: 400 }), { passed: true }], [Object.assign(new Error('QBO API error (HTTP 500)'), { status: 500 }), { success: false }]]) {
    const f = fixture(); let result;
    await runEngine({ ...f.options, runModel: async (_m, tool) => {
      await define(tool, ['The vendor is gone']);
      const vendor = (await create(tool, 'Vendor', { DisplayName: 'REPRO vendor' })).data.id;
      f.qbo.read = async () => { throw error; };
      result = await tool('checkCase', { condition: 1, sources: [{ entityType: 'Vendor', id: vendor, path: 'exists' }], expected: false, aggregate: 'single', operator: 'equal' });
      await finish(tool, 'unverified');
    } });
    for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, error.message);
  }
});
