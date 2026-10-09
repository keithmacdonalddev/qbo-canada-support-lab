'use strict';

// The agent-eval simulated company, exercised through the real AI tool
// handlers. No provider, QuickBooks or database access.

const test = require('node:test');
const assert = require('node:assert/strict');

require('../../scripts/agent-eval/guard').install();
const { createFakeQbo, ACCOUNTS } = require('../../scripts/agent-eval/fake-qbo');
const { toolHandlers: h } = require('../src/modules/ai-tools');

const salesLine = (item, amount, taxCode) => ({ DetailType: 'SalesItemLineDetail', Amount: amount,
  SalesItemLineDetail: { ItemRef: { value: item }, Qty: 1, UnitPrice: amount, TaxCodeRef: { value: taxCode } } });
const rejects = (promise, pattern) => assert.rejects(promise, (err) => err.status === 400 && pattern.test(err.message));

test('seeded company answers the read tools like QuickBooks', async () => {
  const { qbo } = createFakeQbo({ today: '2026-10-08' });
  const ctx = { qbo };
  const banks = await h.searchEntities({ type: 'Account', query: 'Chequing' }, ctx);
  // searchEntities returns compact summaries (id, name, balance, docNumber).
  assert.equal(banks.data.records[0].id, ACCOUNTS.chequing);
  assert.equal(banks.data.records[0].balance, 85000);
  const codes = (await h.searchEntities({ type: 'TaxCode', query: '' }, ctx)).data.records.map((r) => r.name);
  assert.deepEqual(codes.sort(), ['Exempt', 'GST', 'HST ON', 'Out of Scope', 'Zero-rated']);
  const duplicate = (await h.searchEntities({ type: 'Invoice', query: '1003' }, ctx)).data.records;
  assert.deepEqual(duplicate.map((r) => [r.id, r.docNumber]), [['148', '1003']]);
  const invoice = await h.getEntityDetail({ type: 'Invoice', id: '145' }, ctx);
  assert.equal(invoice.data.record.TotalAmt, 1695);
  assert.equal(invoice.data.record.Balance, 695, 'seeded payment is applied');
  assert.equal(invoice.data.record.CustomerRef.name, 'Northwind Traders');
});

test('reads of unknown Ids fail with Object Not Found and are logged as never existing', async () => {
  const { qbo, company } = createFakeQbo();
  await rejects(h.getEntityDetail({ type: 'Invoice', id: '1003' }, { qbo }), /Object Not Found/);
  const call = company.calls.at(-1);
  assert.equal(call.missing, true);
  assert.equal(call.everExisted, false);
});

test('creates assign Ids, SyncToken and MetaData; updates enforce SyncToken', async () => {
  const { qbo, company } = createFakeQbo();
  const ctx = { qbo };
  const customer = await h.createRecord({ entityType: 'Customer', record: { DisplayName: 'REPRO Customer' } }, ctx);
  const saved = company.get('Customer', customer.data.id);
  assert.equal(saved.SyncToken, '0');
  assert.ok(saved.MetaData.CreateTime);
  await rejects(h.createRecord({ entityType: 'Vendor', record: { DisplayName: 'REPRO Customer' } }, ctx), /Duplicate Name/);
  const updated = await h.updateRecord({ entityType: 'Customer', id: customer.data.id, changes: { CompanyName: 'Repro Ltd' } }, ctx);
  assert.equal(updated.success, true);
  assert.equal(company.get('Customer', customer.data.id).SyncToken, '1');
  await rejects(qbo.update('customer', { Id: customer.data.id, SyncToken: '0', sparse: true, Notes: 'stale' }), /Stale Object/);
});

test('invoice tax by line code, partial payment and derived balances', async () => {
  const { qbo, company } = createFakeQbo();
  const ctx = { qbo };
  const customer = (await h.createRecord({ entityType: 'Customer', record: { DisplayName: 'REPRO Tax' } }, ctx)).data.id;
  await rejects(h.createRecord({ entityType: 'Invoice', record: { CustomerRef: { value: customer },
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: 10, SalesItemLineDetail: { ItemRef: { value: '1' } } }] } }, ctx), /GST\/HST rate/);
  const invoice = await h.createRecord({ entityType: 'Invoice', record: { CustomerRef: { value: customer }, TxnDate: '2026-07-10',
    Line: [salesLine('1', 1000, '8'), salesLine('3', 200, '3')] } }, ctx);
  assert.equal(invoice.data.totalAmt, 1330);
  assert.equal(invoice.data.docNumber, '1004');
  await h.createRecord({ entityType: 'Payment', record: { CustomerRef: { value: customer }, TotalAmt: 500,
    Line: [{ Amount: 500, LinkedTxn: [{ TxnId: invoice.data.id, TxnType: 'Invoice' }] }] } }, ctx);
  assert.equal(company.get('Invoice', invoice.data.id).Balance, 830);
  assert.equal(company.get('Customer', customer).Balance, 830);
  await rejects(h.createRecord({ entityType: 'Payment', record: { CustomerRef: { value: customer }, TotalAmt: 900,
    Line: [{ Amount: 900, LinkedTxn: [{ TxnId: invoice.data.id, TxnType: 'Invoice' }] }] } }, ctx), /exceeds its open balance/);
});

test('credit memo applied through a zero payment reduces the invoice balance', async () => {
  const { qbo, company } = createFakeQbo();
  const ctx = { qbo };
  const customer = (await h.createRecord({ entityType: 'Customer', record: { DisplayName: 'REPRO Credit' } }, ctx)).data.id;
  const invoice = (await h.createRecord({ entityType: 'Invoice', record: { CustomerRef: { value: customer }, Line: [salesLine('1', 1000, '8')] } }, ctx)).data.id;
  const memo = (await h.createRecord({ entityType: 'CreditMemo', record: { CustomerRef: { value: customer }, Line: [salesLine('1', 300, '8')] } }, ctx)).data.id;
  await h.createRecord({ entityType: 'Payment', record: { CustomerRef: { value: customer }, TotalAmt: 0, Line: [
    { Amount: 339, LinkedTxn: [{ TxnId: invoice, TxnType: 'Invoice' }] }, { Amount: 339, LinkedTxn: [{ TxnId: memo, TxnType: 'CreditMemo' }] }] } }, ctx);
  assert.equal(company.get('Invoice', invoice).Balance, 791);
  assert.equal(company.get('CreditMemo', memo).RemainingCredit, 0);
});

test('transfer, journal entry and account validation return QBO-style errors', async () => {
  const { qbo, company } = createFakeQbo();
  const ctx = { qbo };
  await rejects(h.createRecord({ entityType: 'Account', record: { Name: 'Bad', AccountType: 'Piggy Bank' } }, ctx), /not a valid AccountType/);
  await rejects(h.createRecord({ entityType: 'Account', record: { Name: 'Chequing', AccountType: 'Bank' } }, ctx), /Duplicate Name/);
  const equity = (await h.createRecord({ entityType: 'Account', record: { Name: "Owner's Distributions", AccountType: 'Equity' } }, ctx)).data.id;
  await rejects(h.createRecord({ entityType: 'Transfer', record: { FromAccountRef: { value: '1' }, ToAccountRef: { value: '1' }, Amount: 5 } }, ctx), /can't be the same/);
  await rejects(h.createRecord({ entityType: 'Transfer', record: { FromAccountRef: { value: '1' }, ToAccountRef: { value: ACCOUNTS.officeSupplies }, Amount: 5 } }, ctx), /balance sheet/);
  await rejects(h.createRecord({ entityType: 'Transfer', record: { FromAccountRef: { value: '999' }, ToAccountRef: { value: equity }, Amount: 5 } }, ctx), /Invalid Reference Id/);
  assert.equal(company.calls.at(-1).missingRefs[0].everExisted, false);
  await h.createRecord({ entityType: 'Transfer', record: { FromAccountRef: { value: '1' }, ToAccountRef: { value: equity }, Amount: 40000, TxnDate: '2026-04-21' } }, ctx);
  assert.equal(company.get('Account', '1').CurrentBalance, 45000);
  const jeLine = (PostingType, account, Amount) => ({ DetailType: 'JournalEntryLineDetail', Amount, JournalEntryLineDetail: { PostingType, AccountRef: { value: account } } });
  await rejects(h.createRecord({ entityType: 'JournalEntry', record: { Line: [jeLine('Debit', '16', 10), jeLine('Credit', '20', 9)] } }, ctx), /balance debits/);
  await rejects(h.createRecord({ entityType: 'JournalEntry', record: { Line: [jeLine('Debit', ACCOUNTS.ar, 10), jeLine('Credit', '13', 10)] } }, ctx), /Accounts Receivable/);
});

test('void and delete follow the tool contracts and leave receipts', async () => {
  const { qbo, company } = createFakeQbo();
  const ctx = { qbo };
  const customer = (await h.createRecord({ entityType: 'Customer', record: { DisplayName: 'REPRO Void' } }, ctx)).data.id;
  const invoice = (await h.createRecord({ entityType: 'Invoice', record: { CustomerRef: { value: customer }, Line: [salesLine('1', 100, '8')] } }, ctx)).data.id;
  const payment = (await h.createRecord({ entityType: 'Payment', record: { CustomerRef: { value: customer }, TotalAmt: 113,
    Line: [{ Amount: 113, LinkedTxn: [{ TxnId: invoice, TxnType: 'Invoice' }] }] } }, ctx)).data.id;
  assert.equal(company.get('Invoice', invoice).Balance, 0);
  const voided = await h.voidTransaction({ entityType: 'Payment', id: payment }, ctx);
  assert.equal(voided.data.totalAmt, 0);
  assert.equal(company.get('Invoice', invoice).Balance, 113);
  const current = company.get('Invoice', invoice);
  const receipt = await qbo.apiCall('POST', 'invoice?operation=delete', { Id: invoice, SyncToken: current.SyncToken });
  assert.deepEqual(receipt.Invoice, { Id: invoice, status: 'Deleted', domain: 'QBO' });
  assert.equal(company.isDeleted('Invoice', invoice), true);
  await rejects(qbo.read('invoice', invoice), /Object Not Found/);
  assert.equal(company.calls.at(-1).everExisted, true, 'a deleted record is not an invented Id');
  assert.deepEqual(company.mutations().map((c) => c.kind), ['create', 'create', 'create', 'void', 'delete']);
});

test('inventory quantity follows purchases and sales; reports balance', async () => {
  const { qbo, company } = createFakeQbo({ today: '2026-10-08' });
  const ctx = { qbo };
  const item = (await h.createRecord({ entityType: 'Item', record: { Name: 'Trail Lamp', Type: 'Inventory', TrackQtyOnHand: true, QtyOnHand: 0, InvStartDate: '2026-01-01',
    PurchaseCost: 40, UnitPrice: 95, IncomeAccountRef: { value: '12' }, ExpenseAccountRef: { value: '14' }, AssetAccountRef: { value: '7' } } }, ctx)).data.id;
  const vendor = (await h.createRecord({ entityType: 'Vendor', record: { DisplayName: 'REPRO Lamps' } }, ctx)).data.id;
  await h.createRecord({ entityType: 'Bill', record: { VendorRef: { value: vendor }, TxnDate: '2026-02-01', Line: [{ DetailType: 'ItemBasedExpenseLineDetail', Amount: 400,
    ItemBasedExpenseLineDetail: { ItemRef: { value: item }, Qty: 10, UnitPrice: 40, TaxCodeRef: { value: '8' } } }] } }, ctx);
  const customer = (await h.createRecord({ entityType: 'Customer', record: { DisplayName: 'REPRO Lamp Buyer' } }, ctx)).data.id;
  await h.createRecord({ entityType: 'Invoice', record: { CustomerRef: { value: customer }, TxnDate: '2026-02-10', Line: [{ DetailType: 'SalesItemLineDetail', Amount: 380,
    SalesItemLineDetail: { ItemRef: { value: item }, Qty: 4, UnitPrice: 95, TaxCodeRef: { value: '8' } } }] } }, ctx);
  assert.equal(company.qtyOnHand(item), 6);
  assert.equal(company.get('Item', item).QtyOnHand, 6);
  const sheet = await h.runReport({ report: 'BalanceSheet', reportDate: '2026-10-08' }, ctx);
  assert.equal(sheet.success, true);
  const total = (label) => Number(sheet.data.lines.find((l) => l.trim().startsWith(label)).split('|')[1]);
  assert.equal(total('Total Assets'), total('Total Liabilities and Equity'));
  const pl = await h.runReport({ report: 'ProfitAndLoss', startDate: '2026-01-01', endDate: '2026-12-31' }, ctx);
  assert.ok(pl.data.lines.some((l) => l.includes('Cost of Goods Sold | 160.00')));
});

test('saved sales lines, singletons, sub-records, apostrophes and sparse line replacement', async () => {
  const { qbo, company } = createFakeQbo();
  const ctx = { qbo };
  assert.equal((await qbo.read('companyinfo', 'eval-simulated-realm')).CompanyInfo.Country, 'CA');
  assert.equal((await qbo.query('SELECT * FROM Preferences')).QueryResponse.Preferences[0].TaxPrefs.UsingSalesTax, true);
  const parent = (await h.createRecord({ entityType: 'Customer', record: { DisplayName: "Domino's Pizza" } }, ctx)).data.id;
  assert.equal((await qbo.query("SELECT * FROM Customer WHERE DisplayName = 'Domino\'s Pizza'")).QueryResponse.Customer[0].Id, parent);
  const job = (await h.createRecord({ entityType: 'Customer', record: { DisplayName: 'Kitchen Renovation', ParentRef: { value: parent } } }, ctx)).data.id;
  assert.equal(company.get('Customer', job).FullyQualifiedName, "Domino's Pizza:Kitchen Renovation");
  const sub = (await h.createRecord({ entityType: 'Account', record: { Name: 'Payroll Float', AccountType: 'Bank', ParentRef: { value: '1' } } }, ctx)).data.id;
  assert.equal(company.get('Account', sub).SubAccount, true);
  await rejects(h.createRecord({ entityType: 'Account', record: { Name: 'Wrong Type', AccountType: 'Expense', ParentRef: { value: '1' } } }, ctx), /same type/);
  const invoice = (await h.createRecord({ entityType: 'Invoice', record: { CustomerRef: { value: job }, Line: [salesLine('1', 300, '8'), salesLine('2', 850, '8')] } }, ctx)).data.id;
  const saved = company.get('Invoice', invoice);
  assert.deepEqual(saved.Line[0].SalesItemLineDetail.ItemAccountRef, { value: '13', name: 'Services' });
  assert.equal(saved.TxnTaxDetail.TxnTaxCodeRef.value, '8');
  await qbo.update('invoice', { Id: invoice, SyncToken: saved.SyncToken, sparse: true,
    Line: [{ ...saved.Line[0], Amount: 750, SalesItemLineDetail: { ...saved.Line[0].SalesItemLineDetail, Qty: 5, UnitPrice: 150 } }] });
  assert.equal(company.get('Invoice', invoice).Line.filter((l) => l.DetailType === 'SalesItemLineDetail').length, 1, 'a sparse Line array replaces every line, as in QBO');
});
