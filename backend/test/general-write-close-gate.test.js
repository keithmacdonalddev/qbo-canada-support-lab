'use strict';
// The calendar gate for general writes: a period with general records needs a passing
// day-close check (one General Ledger read, retained and reused); history edits inside
// verified history are re-verified over their range; failures block with plain reasons.
const test = require('node:test'), assert = require('node:assert/strict');
const { createGeneralCloseGate } = require('../src/modules/general-write-close-gate');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const chain = rows => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean: async () => structuredClone(rows) });
const invoice = (amount, date, extra = {}) => ({ Id: '700', SyncToken: '0', TxnDate: date, CustomerRef: { value: '1' }, Line: [{ Amount: amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: 1, UnitPrice: amount, TaxCodeRef: { value: '7' } } }], TxnTaxDetail: { TotalTax: amount * 0.15, TaxLine: [{ Amount: amount * 0.15, TaxLineDetail: { TaxRateRef: { value: '8' } } }] }, ...extra });
function setup({ run, copyRecord, taxAccounts = null, itemRecord = null }) {
  const closes = [], reads = [];
  const models = {
    GeneralWriteRuns: { find: () => chain([run]) },
    GeneralDayCloses: { find: filter => chain(closes.filter(row => row.kind === filter.kind && row.ok === filter.ok)), findOne: filter => chain(closes.find(row => row.kind === filter.kind && row.ok === filter.ok && row.fromDate === filter.fromDate && row.throughDate === filter.throughDate) || null), create: async ([row]) => { closes.push(structuredClone(row)); } },
    Records: { find: () => chain(taxAccounts || [{ qboId: '210', record: { AccountSubType: 'GlobalTaxPayable', Name: 'GST/HST Payable' } }]) },
  };
  const copy = { read: async (s, entity, id) => entity === 'Item' ? structuredClone(itemRecord || { Id: id, Type: 'Service', IncomeAccountRef: { value: '400' } }) : structuredClone(copyRecord) };
  const columns = ['tx_date', 'txn_type', 'doc_num', 'name', 'memo', 'split_acc', 'debt_amt', 'credit_amt'].map(ColType => ({ ColType }));
  const row = (date, debit, credit) => ({ type: 'Data', ColData: [{ value: date }, { value: 'Invoice', id: '700' }, {}, {}, {}, {}, { value: debit }, { value: credit }] });
  const section = (account, rows) => ({ type: 'Section', Header: { ColData: [{ value: 'A', id: account }] }, Rows: { Row: rows } });
  const readLedger = async (from, through) => { reads.push(from + '..' + through); const date = copyRecord.TxnDate; return { Header: { ReportName: 'GeneralLedger', ReportBasis: 'Accrual', StartPeriod: from, EndPeriod: through }, Columns: { Column: columns }, Rows: { Row: date >= from && date <= through ? [section('120', [row(date, (copyRecord.Line[0].Amount * 1.15).toFixed(2), '')]), section('400', [row(date, '', copyRecord.Line[0].Amount.toFixed(2))]), section('210', [row(date, '', (copyRecord.Line[0].Amount * 0.15).toFixed(2))])] : [] } }; };
  return { gate: createGeneralCloseGate({ models, copy, now: () => Date.parse('2026-12-03T12:00:00Z') }), closes, reads, readLedger };
}
const mappings = { accountsReceivable: '120', accountsPayable: '200', undepositedFunds: '125' };

test('a period with general records is verified once from one ledger read, then reused', async () => {
  const saved = invoice(100, '2026-12-02');
  const run = { _id: 'r1', dirty: [], plan: { operations: [{ ref: 'inv', op: 'create', entity: 'Invoice' }] }, items: { inv: { outcome: 'saved', op: 'create', entity: 'Invoice', qboId: '700', record: saved } } };
  const h = setup({ run, copyRecord: saved });
  const first = await h.gate.assertPeriodReady(scope, { fromDate: '2026-12-02', throughDate: '2026-12-02', verifiedThrough: '2026-12-01', openingDate: '2026-11-01', mappings, readLedger: h.readLedger });
  assert.deepEqual(first.results.map(row => [row.kind, row.ok]), [['period', true]]);
  await h.gate.assertPeriodReady(scope, { fromDate: '2026-12-02', throughDate: '2026-12-02', verifiedThrough: '2026-12-01', openingDate: '2026-11-01', mappings, readLedger: h.readLedger });
  assert.deepEqual(h.reads, ['2026-12-02..2026-12-02'], 'a passing close is reused');
  // A period without general records needs nothing.
  assert.equal((await h.gate.assertPeriodReady(scope, { fromDate: '2026-12-05', throughDate: '2026-12-05', verifiedThrough: '2026-12-04', mappings, readLedger: h.readLedger })).required, false);
});

test('an external edit of a general record blocks the calendar with its reason', async () => {
  const saved = invoice(100, '2026-12-02'), edited = { ...saved, SyncToken: '1', DueDate: '2027-04-01' };
  const run = { _id: 'r1', dirty: [], plan: { operations: [{ ref: 'inv', op: 'create', entity: 'Invoice' }] }, items: { inv: { outcome: 'saved', op: 'create', entity: 'Invoice', qboId: '700', record: saved } } };
  const h = setup({ run, copyRecord: edited });
  await assert.rejects(h.gate.assertPeriodReady(scope, { fromDate: '2026-12-02', throughDate: '2026-12-02', verifiedThrough: '2026-12-01', mappings, readLedger: h.readLedger }), /are not verified: Invoice:700: Invoice changed after it was proved/);
  assert.equal(h.closes[0].ok, false);
});

test('history markers block stale completions and downstream movement even after an old record-only reverify', async () => {
  const before = invoice(100, '2026-11-20'), after = invoice(150, '2026-11-20', { SyncToken: '1' });
  const run = { _id: 'r2', dirty: [{ date: '2026-11-20' }], plan: { operations: [{ ref: 'edit', op: 'update', entity: 'Invoice', id: '700', before }] }, items: { edit: { outcome: 'saved', op: 'update', entity: 'Invoice', qboId: '700', record: after } } };
  const h = setup({ run, copyRecord: after });
  h.closes.push({kind:'reverify',ok:true,markers:['r2:2026-11-20']});
  await assert.rejects(h.gate.assertPeriodReady(scope, { fromDate: '2026-12-02', throughDate: '2026-12-02', verifiedThrough: '2026-12-01', openingDate: '2026-11-01', mappings, readLedger: h.readLedger }), /Historical completions, downstream movements must be re-proved/);
  assert.equal(h.reads.length, 0, 'a record-only proof cannot resolve historical invalidation');
});

test('a changed record cannot reuse a passing close without another ledger proof',async()=>{
  const saved=invoice(100,'2026-12-02'),current=structuredClone(saved);
  const run={_id:'r1',dirty:[],plan:{operations:[{ref:'inv',op:'create',entity:'Invoice'}]},items:{inv:{outcome:'saved',op:'create',entity:'Invoice',qboId:'700',record:saved}}};
  const h=setup({run,copyRecord:current}),args={fromDate:'2026-12-02',throughDate:'2026-12-02',verifiedThrough:'2026-12-01',mappings,readLedger:h.readLedger};
  await h.gate.assertPeriodReady(scope,args);
  current.SyncToken='1';current.DueDate='2027-03-01';
  await assert.rejects(h.gate.assertPeriodReady(scope,args),/changed after it was proved/);
  assert.equal(h.reads.length,2);assert.equal(h.closes.at(-1).ok,false);
});

test('pre-opening markers cannot resolve while the old opening baseline remains verified',async()=>{
  const run={_id:'history',dirty:[{date:'2026-10-15'}],plan:{operations:[]},items:{}};
  const h=setup({run,copyRecord:null});h.closes.push({kind:'reverify',ok:true,markers:['history:2026-10-15']});
  await assert.rejects(h.gate.assertPeriodReady(scope,{fromDate:'2026-12-02',throughDate:'2026-12-02',verifiedThrough:'2026-12-01',openingDate:'2026-11-01',mappings,readLedger:h.readLedger}),/opening baseline.*must be re-proved/);
  assert.equal(h.reads.length,0);assert.equal(h.closes.length,1);
});

test('multiple tax accounts retain distinct identities and cannot hide a tax-account substitution',async()=>{
  const saved=invoice(100,'2026-12-02');const run={_id:'tax',dirty:[],plan:{operations:[{ref:'inv',op:'create',entity:'Invoice'}]},items:{inv:{outcome:'saved',op:'create',entity:'Invoice',qboId:'700',record:saved}}};
  const h=setup({run,copyRecord:saved,taxAccounts:[{qboId:'210',record:{AccountSubType:'GlobalTaxPayable'}},{qboId:'211',record:{AccountSubType:'GlobalTaxPayable'}}]});
  await assert.rejects(h.gate.assertPeriodReady(scope,{fromDate:'2026-12-02',throughDate:'2026-12-02',verifiedThrough:'2026-12-01',mappings,readLedger:h.readLedger}),/tax posting account cannot be attributed uniquely/);
});

test('posting-reference changes during the ledger read cannot produce a passing close',async()=>{
  const saved=invoice(100,'2026-12-02'),item={Id:'40',Type:'Service',IncomeAccountRef:{value:'400'}};
  const run={_id:'race',dirty:[],plan:{operations:[{ref:'inv',op:'create',entity:'Invoice'}]},items:{inv:{outcome:'saved',op:'create',entity:'Invoice',qboId:'700',record:saved}}};
  const h=setup({run,copyRecord:saved,itemRecord:item});
  await assert.rejects(h.gate.assertPeriodReady(scope,{fromDate:'2026-12-02',throughDate:'2026-12-02',verifiedThrough:'2026-12-01',mappings,readLedger:async(...args)=>{const report=await h.readLedger(...args);item.IncomeAccountRef.value='999';return report;}}),/posting references changed/);
  assert.equal(h.closes.length,0);
});

test('an external move from a closed day into the closing period cannot escape enumeration', async () => {
  const saved = invoice(100, '2026-12-01'), current = { ...saved, SyncToken: '1', TxnDate: '2026-12-02' };
  const run = { _id: 'moved', dirty: [], plan: { operations: [{ ref: 'inv', op: 'create', entity: 'Invoice', payload: { TxnDate: '2026-12-01' } }] }, items: { inv: { outcome: 'saved', op: 'create', entity: 'Invoice', qboId: '700', record: saved } } };
  const h = setup({ run, copyRecord: current });
  await assert.rejects(h.gate.assertPeriodReady(scope, { fromDate: '2026-12-02', throughDate: '2026-12-02', verifiedThrough: '2026-12-01', mappings, readLedger: h.readLedger }), /changed after it was proved/);
  assert.equal(h.reads.length, 1);
});
