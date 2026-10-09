'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toolHandlers, toolPermissions, toolDefinitions } = require('../src/modules/ai-tools');
const { resolveStepRefs, checkTargetRef } = require('../src/modules/ai-orchestrator');
const codexCli = require('../src/modules/codex-cli');

function fakeQbo(store = {}) {
  const calls = [];
  return {
    calls,
    async create(entity, data) { calls.push(['create', entity, data]); return { [store.type]: { Id: '501', SyncToken: '0', ...data } }; },
    async read(entity, id) { calls.push(['read', entity, id]); return store.current ? { [store.type]: store.current } : {}; },
    async update(entity, data) { calls.push(['update', entity, data]); return { [store.type]: { ...store.current, ...data } }; },
    async apiCall(method, endpoint, body) { calls.push(['apiCall', method, endpoint, body]); return { [store.type]: { ...store.current, TotalAmt: 0 } }; },
  };
}

test('tool definitions are all real entries with unique names', () => {
  assert.ok(toolDefinitions.every((tool) => tool && typeof tool.name === 'string'));
  assert.equal(new Set(toolDefinitions.map((tool) => tool.name)).size, toolDefinitions.length);
  assert.equal(Object.keys(toolDefinitions).length, toolDefinitions.length);
  for (let i = 0; i < toolDefinitions.length; i += 1) assert.ok(i in toolDefinitions, `empty slot at ${i}`);
});

test('every write tool needs approval', () => {
  for (const name of ['createRecord', 'updateRecord', 'voidTransaction']) {
    assert.equal(toolPermissions[name], 'confirm');
    assert.ok(toolDefinitions.some((tool) => tool.name === name));
  }
});

test('createRecord sends the body and reports the new record', async () => {
  const qbo = fakeQbo({ type: 'Invoice' });
  const result = await toolHandlers.createRecord({ entityType: 'Invoice', record: { TxnDate: '2026-09-22' }, summary: 's' }, { qbo });
  assert.equal(result.success, true);
  assert.equal(result.data.id, '501');
  assert.deepEqual(qbo.calls[0], ['create', 'invoice', { TxnDate: '2026-09-22' }]);
});

test('createRecord refuses unsupported types and non-object bodies without calling QuickBooks', async () => {
  const qbo = fakeQbo({ type: 'Invoice' });
  assert.equal((await toolHandlers.createRecord({ entityType: 'CompanyInfo', record: {} }, { qbo })).success, false);
  assert.equal((await toolHandlers.createRecord({ entityType: 'Invoice', record: [] }, { qbo })).success, false);
  assert.equal((await toolHandlers.createRecord({ entityType: 'Invoice', record: { Id: '7', SyncToken: '1' } }, { qbo })).success, false);
  assert.equal(qbo.calls.length, 0);
});

test('every writable type can be looked up, with the right search field', async () => {
  const { VALID_ENTITY_TYPES, WRITABLE_ENTITY_TYPES } = require('../src/modules/ai-tools');
  for (const type of WRITABLE_ENTITY_TYPES) assert.ok(VALID_ENTITY_TYPES.includes(type), `${type} is not readable`);

  const queries = [];
  const qbo = { async query(sql) { queries.push(sql); return { QueryResponse: {} }; } };
  for (const [type, query] of [['Employee', 'Sam'], ['Term', 'Net'], ['Bill', '80395'], ['TimeActivity', 'x'], ['Term', '']]) {
    assert.equal((await toolHandlers.searchEntities({ type, query }, { qbo })).success, true);
  }
  // One extra row shows whether there is another page; sortable types come newest first.
  assert.deepEqual(queries, [
    "SELECT * FROM Employee WHERE DisplayName LIKE '%Sam%' ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 11",
    "SELECT * FROM Term WHERE Name LIKE '%Net%' MAXRESULTS 11",
    "SELECT * FROM Bill WHERE DocNumber LIKE '%80395%' ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 11",
    'SELECT * FROM TimeActivity ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 11',
    'SELECT * FROM Term MAXRESULTS 11',
  ]);
});

test('update, void and chain lookups refuse non-numeric Ids', async () => {
  const qbo = fakeQbo({ type: 'Invoice', current: { Id: '7', SyncToken: '3' } });
  assert.equal((await toolHandlers.updateRecord({ entityType: 'Invoice', id: '7?x=1', changes: {} }, { qbo })).success, false);
  assert.equal((await toolHandlers.voidTransaction({ entityType: 'Invoice', id: '../7' }, { qbo })).success, false);
  assert.equal((await toolHandlers.getTransactionChain({ entityType: 'Invoice', entityId: '7/../preferences' }, { qbo })).success, false);
  assert.equal(qbo.calls.length, 0);
});

test('updateRecord is a sparse update with the current SyncToken', async () => {
  const qbo = fakeQbo({ type: 'Invoice', current: { Id: '7', SyncToken: '3', TotalAmt: 10 } });
  await toolHandlers.updateRecord({ entityType: 'Invoice', id: '7', changes: { PrivateNote: 'x' }, summary: 's' }, { qbo });
  assert.deepEqual(qbo.calls[1], ['update', 'invoice', { PrivateNote: 'x', Id: '7', SyncToken: '3', sparse: true }]);
});

test('voidTransaction uses the QBO void operation and only for voidable types', async () => {
  const qbo = fakeQbo({ type: 'Invoice', current: { Id: '7', SyncToken: '3' } });
  await toolHandlers.voidTransaction({ entityType: 'Invoice', id: '7', summary: 's' }, { qbo });
  assert.deepEqual(qbo.calls[1], ['apiCall', 'POST', 'invoice?operation=void', { Id: '7', SyncToken: '3' }]);
  const bp = fakeQbo({ type: 'BillPayment', current: { Id: '9', SyncToken: '1' } });
  await toolHandlers.voidTransaction({ entityType: 'BillPayment', id: '9', summary: 's' }, { qbo: bp });
  assert.deepEqual(bp.calls[1], ['apiCall', 'POST', 'billpayment?operation=update&include=void', { Id: '9', SyncToken: '1', sparse: true }]);
  const refused = await toolHandlers.voidTransaction({ entityType: 'Bill', id: '1', summary: 's' }, { qbo: fakeQbo({ type: 'Bill' }) });
  assert.equal(refused.success, false);
});

test('plan steps can use values from earlier steps', () => {
  const results = new Map([[1, { success: true, data: { id: '145', docNumber: '1043' } }]]);
  const input = { record: { Line: [{ LinkedTxn: [{ TxnId: '{{step1.id}}', TxnType: 'Invoice' }] }], PrivateNote: 'For {{ step1.docNumber }}' } };
  assert.deepEqual(resolveStepRefs(input, results), {
    record: { Line: [{ LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }], PrivateNote: 'For 1043' },
  });
  assert.throws(() => resolveStepRefs('{{step2.id}}', results), /Step 2/);
});

test('a step placeholder can only target the record type it produced', () => {
  const results = new Map([[1, { success: true, data: { entityType: 'Customer', id: '58' } }]]);
  assert.throws(() => checkTargetRef({ entityType: 'Invoice', id: '{{step1.id}}' }, results), /Customer/);
  assert.doesNotThrow(() => checkTargetRef({ entityType: 'Customer', id: '{{step1.id}}' }, results));
  assert.doesNotThrow(() => checkTargetRef({ entityType: 'Invoice', id: '58' }, results));
});

test('Codex runs get no backend secrets and only conversational event types', () => {
  const previous = { secret: process.env.JWT_SECRET, qbo: process.env.QBO_CLIENT_SECRET };
  process.env.JWT_SECRET = 'should-not-pass';
  process.env.QBO_CLIENT_SECRET = 'should-not-pass';
  try {
    const env = codexCli.childEnv();
    assert.equal(env.JWT_SECRET, undefined);
    assert.equal(env.QBO_CLIENT_SECRET, undefined);
  } finally {
    if (previous.secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous.secret;
    if (previous.qbo === undefined) delete process.env.QBO_CLIENT_SECRET; else process.env.QBO_CLIENT_SECRET = previous.qbo;
  }
  assert.ok(!codexCli.ALLOWED_ITEM_TYPES.has('command_execution'));
  assert.ok(!codexCli.ALLOWED_ITEM_TYPES.has('file_change'));
  assert.ok(codexCli.ISOLATION_ARGS.includes('shell_tool'));
});
