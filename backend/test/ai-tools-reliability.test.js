'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toolHandlers, toolPermissions, toolDefinitions, VALID_ENTITY_TYPES, WRITABLE_ENTITY_TYPES, escapeQueryString } = require('../src/modules/ai-tools');

function queryQbo(rowsFor = () => []) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      const type = sql.split(' ')[3];
      return { QueryResponse: { [type]: rowsFor(sql, type) } };
    },
  };
}

function writeQbo(type, current) {
  const calls = [];
  return {
    calls,
    async read(entity, id) { calls.push(['read', entity, id]); return { [type]: current }; },
    async update(entity, data) { calls.push(['update', entity, data]); return { [type]: { ...current, ...data } }; },
    async create(entity, data) { calls.push(['create', entity, data]); return { [type]: { Id: '501', ...data } }; },
  };
}

test('apostrophes are escaped for QuickBooks, not stripped', async () => {
  assert.equal(escapeQueryString("Domino's"), "Domino\\'s");
  assert.equal(escapeQueryString('a\\b\u0001'), 'a\\\\b');
  const qbo = queryQbo();
  await toolHandlers.searchEntities({ type: 'Vendor', query: "Domino's" }, { qbo });
  assert.equal(qbo.queries[0], "SELECT * FROM Vendor WHERE DisplayName LIKE '%Domino\\'s%' ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 11");
});

test('search filters are built from validated values only', async () => {
  const qbo = queryQbo();
  const ok = await toolHandlers.searchEntities({ type: 'Invoice', filters: { txnDateFrom: '2026-09-01', txnDateTo: '2026-09-30', customerId: '58' }, limit: 5, startPosition: 11 }, { qbo });
  assert.equal(ok.success, true);
  assert.equal(qbo.queries[0], "SELECT * FROM Invoice WHERE TxnDate >= '2026-09-01' AND TxnDate <= '2026-09-30' AND CustomerRef = '58' ORDERBY MetaData.LastUpdatedTime DESC STARTPOSITION 11 MAXRESULTS 6");
  await toolHandlers.searchEntities({ type: 'Account', filters: { accountType: 'Credit Card', active: 'all' } }, { qbo });
  assert.equal(qbo.queries[1], "SELECT * FROM Account WHERE AccountType = 'Credit Card' AND Active IN (true, false) ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 11");
  await toolHandlers.searchEntities({ type: 'Item', query: 'Bolt', filters: { itemType: 'Inventory', active: 'inactive' } }, { qbo });
  assert.equal(qbo.queries[2], "SELECT * FROM Item WHERE Name LIKE '%Bolt%' AND Type = 'Inventory' AND Active = false ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 11");

  for (const filters of [
    { customerId: "1' OR '1'='1" }, { txnDateFrom: '2026-9-1' }, { accountType: 'Bank; DROP' },
    { vendorId: '5' }, { active: 'yes' }, { where: 'Id > 0' }, ['x'],
  ]) {
    const refused = await toolHandlers.searchEntities({ type: 'Invoice', filters }, { qbo });
    assert.equal(refused.success, false, JSON.stringify(filters));
  }
  assert.equal(qbo.queries.length, 3, 'refused filters never reach QuickBooks');
});

test('search returns compact summaries with paging', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    Id: String(10 + i), DocNumber: 'B' + i, TxnDate: '2026-09-0' + (i + 1), TotalAmt: 100 + i, Balance: 0,
    VendorRef: { value: '7', name: "Domino's" }, Line: [{ Id: '1', Amount: 100 }], MetaData: { LastUpdatedTime: '2026-09-30T10:00:00-07:00' },
  }));
  const qbo = queryQbo(() => rows);
  const result = await toolHandlers.searchEntities({ type: 'Bill', limit: 2 }, { qbo });
  assert.equal(result.data.count, 2);
  assert.equal(result.data.nextStartPosition, 3);
  assert.deepEqual(result.data.records[0], {
    id: '10', docNumber: 'B0', txnDate: '2026-09-01', totalAmt: 100, balance: 0,
    party: { id: '7', name: "Domino's" }, updated: '2026-09-30T10:00:00-07:00',
  });
  const last = await toolHandlers.searchEntities({ type: 'Bill', limit: 5 }, { qbo });
  assert.equal(last.data.nextStartPosition, null);
});

test('a type QuickBooks will not sort still answers unsorted', async () => {
  const queries = [];
  const qbo = { async query(sql) {
    queries.push(sql);
    if (sql.includes('ORDERBY')) throw Object.assign(new Error('QBO API error (HTTP 400): bad sort'), { status: 400 });
    return { QueryResponse: { Transfer: [{ Id: '3', Amount: 5, FromAccountRef: { value: '1', name: 'Chequing' }, ToAccountRef: { value: '2', name: 'Savings' } }] } };
  } };
  const result = await toolHandlers.searchEntities({ type: 'Transfer' }, { qbo });
  assert.equal(result.success, true);
  assert.equal(result.data.order, 'as returned by QuickBooks');
  assert.deepEqual(result.data.records[0], { id: '3', totalAmt: 5, from: 'Chequing', to: 'Savings' });
  assert.equal(queries[1], 'SELECT * FROM Transfer MAXRESULTS 11');
});

test('company settings are readable, read-only and never chained', async () => {
  for (const type of ['Preferences', 'CompanyInfo']) {
    assert.ok(VALID_ENTITY_TYPES.includes(type));
    assert.ok(!WRITABLE_ENTITY_TYPES.includes(type));
  }
  const prefs = { Id: '1', AccountingInfoPrefs: { ClassTrackingPerTxnLine: true, TrackDepartments: true }, CurrencyPrefs: { MultiCurrencyEnabled: false } };
  const qbo = queryQbo((sql, type) => (type === 'Preferences' ? [prefs] : [{ Id: '1', CompanyName: 'Test Co', Country: 'CA' }]));
  const detail = await toolHandlers.getEntityDetail({ type: 'Preferences', id: '1' }, { qbo });
  assert.deepEqual(detail.data.record, prefs);
  const info = await toolHandlers.searchEntities({ type: 'CompanyInfo' }, { qbo });
  assert.equal(info.data.records[0].Country, 'CA');
  assert.deepEqual(qbo.queries, ['SELECT * FROM Preferences', 'SELECT * FROM CompanyInfo']);
  assert.equal(toolPermissions.getEntityDetail, 'auto');
  assert.equal(toolPermissions.searchEntities, 'auto');
  assert.equal((await toolHandlers.getTransactionChain({ entityType: 'Preferences', entityId: '1' }, { qbo })).success, false);
});

test('a Line update that would drop existing lines is refused', async () => {
  const current = { Id: '7', SyncToken: '3', Line: [
    { Id: '1', Amount: 10, DetailType: 'SalesItemLineDetail' }, { Id: '2', Amount: 20, DetailType: 'SalesItemLineDetail' },
    { Amount: 30, DetailType: 'SubTotalLineDetail' },
  ] };
  const qbo = writeQbo('Invoice', current);
  const dropped = await toolHandlers.updateRecord({ entityType: 'Invoice', id: '7', changes: { Line: [{ Id: '1', Amount: 15, DetailType: 'SalesItemLineDetail' }] } }, { qbo });
  assert.equal(dropped.success, false);
  assert.match(dropped.error, /remove line Id 2/);
  assert.match(dropped.error, /include every existing line \(with its Id\)/i);
  const unknown = await toolHandlers.updateRecord({ entityType: 'Invoice', id: '7', changes: { Line: [{ Id: '9', Amount: 1 }] }, replaceAllLines: true }, { qbo });
  assert.match(unknown.error, /Line Id 9 is not on Invoice 7/);
  assert.ok(!qbo.calls.some(([kind]) => kind === 'update'));

  const kept = await toolHandlers.updateRecord({ entityType: 'Invoice', id: '7', changes: { Line: [
    { Id: '1', Amount: 15, DetailType: 'SalesItemLineDetail' }, { Id: '2', Amount: 20, DetailType: 'SalesItemLineDetail' }, { Amount: 5, DetailType: 'SalesItemLineDetail' },
  ] } }, { qbo });
  assert.equal(kept.success, true);

  const replaced = await toolHandlers.updateRecord({ entityType: 'Invoice', id: '7', replaceAllLines: true,
    changes: { Line: [{ Id: '1', Amount: 15, DetailType: 'SalesItemLineDetail' }], replaceAllLines: true } }, { qbo });
  assert.equal(replaced.success, true);
  const sent = qbo.calls.filter(([kind]) => kind === 'update').at(-1)[2];
  assert.equal(Object.hasOwn(sent, 'replaceAllLines'), false, 'the flag is never sent to QuickBooks');
  assert.deepEqual(sent, { Line: [{ Id: '1', Amount: 15, DetailType: 'SalesItemLineDetail' }], Id: '7', SyncToken: '3', sparse: true });
});

test('a Line update on lines without Ids needs replaceAllLines', async () => {
  const qbo = writeQbo('Payment', { Id: '8', SyncToken: '1', Line: [{ Amount: 10, LinkedTxn: [{ TxnId: '5', TxnType: 'Invoice' }] }] });
  const refused = await toolHandlers.updateRecord({ entityType: 'Payment', id: '8', changes: { Line: [{ Amount: 5, LinkedTxn: [{ TxnId: '5', TxnType: 'Invoice' }] }] } }, { qbo });
  assert.match(refused.error, /replaceAllLines: true/);
  const ok = await toolHandlers.updateRecord({ entityType: 'Payment', id: '8', replaceAllLines: true, changes: { Line: [{ Amount: 5, LinkedTxn: [{ TxnId: '5', TxnType: 'Invoice' }] }] } }, { qbo });
  assert.equal(ok.success, true);
  const plain = await toolHandlers.updateRecord({ entityType: 'Payment', id: '8', changes: { PrivateNote: 'x' } }, { qbo });
  assert.equal(plain.success, true);
});

test('a record wrapped in its type name is unwrapped before sending', async () => {
  const qbo = writeQbo('Account', {});
  const result = await toolHandlers.createRecord({ entityType: 'Account', record: { Account: { Name: 'REPRO Bank', AccountType: 'Bank' } }, summary: 's' }, { qbo });
  assert.equal(result.success, true);
  assert.deepEqual(qbo.calls[0], ['create', 'account', { Name: 'REPRO Bank', AccountType: 'Bank' }]);
});

test('write tool descriptions carry the generic rules a model cannot infer', () => {
  const create = toolDefinitions.find((t) => t.name === 'createRecord').description;
  assert.match(create, /TaxCodeRef/);
  assert.match(create, /created in the case/);
  assert.match(create, /InvStartDate/);
  const update = toolDefinitions.find((t) => t.name === 'updateRecord');
  assert.match(update.description, /include every existing line \(with its Id\)/);
  assert.equal(update.input_schema.properties.replaceAllLines.type, 'boolean');
});

test('runReport passes Id filters and pages long reports', async () => {
  const calls = [];
  const rows = Array.from({ length: 400 }, (_, i) => ({ ColData: [{ value: 'Row ' + i }, { value: String(i) }] }));
  const qbo = { async apiCall(method, endpoint) { calls.push(endpoint); return { Header: { ReportName: 'GeneralLedger' }, Rows: { Row: rows } }; } };
  const first = await toolHandlers.runReport({ report: 'GeneralLedger', startDate: '2026-09-01', endDate: '2026-09-30', account: '35, 36', class: '4' }, { qbo });
  assert.equal(calls[0], 'reports/GeneralLedger?start_date=2026-09-01&end_date=2026-09-30&account=35%2C36&class=4');
  assert.equal(first.data.lines.length, 150);
  assert.equal(first.data.totalLines, 400);
  assert.equal(first.data.nextOffset, 150);
  assert.equal(first.data.truncated, true);
  const last = await toolHandlers.runReport({ report: 'GeneralLedger', rowOffset: 300, rowLimit: 500 }, { qbo });
  assert.equal(last.data.lines.length, 100);
  assert.equal(last.data.lines[0], 'Row 300 | 300');
  assert.equal(last.data.nextOffset, null);
  assert.equal(last.data.truncated, false);
  const bad = await toolHandlers.runReport({ report: 'ProfitAndLoss', customer: '5&x=1' }, { qbo });
  assert.equal(bad.success, false);
  assert.equal(calls.length, 2);
  assert.ok(toolDefinitions.find((t) => t.name === 'runReport').input_schema.properties.report.enum.includes('TransactionList'));
});
