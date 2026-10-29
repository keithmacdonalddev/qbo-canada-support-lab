'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { bindBusinessReference } = require('../src/modules/business-reference');
const { batchLifecycle } = require('../src/modules/business-activity-batch');
const { createAdoptedSettlementReader } = require('../src/modules/business-adopted-settlement');
const { fixture, scope, now } = require('./helpers/business-transaction-fixtures');

// An adopted settlement compiles from a fresh read of the imported obligation,
// bound to its saved import record; it has no managed dependency.
function adoptedFixture(entity = 'Payment') {
  const invoice = entity === 'Payment', f = fixture(entity), partyKey = invoice ? 'care-client-021' : 'stock-supplier-2', party = invoice ? 'Customer' : 'Vendor';
  const target = invoice ? { Id: '10720', CustomerRef: { value: '10' }, ARAccountRef: { value: '601' }, TotalAmt: 283.86, Balance: 283.86 } : { Id: '10655', VendorRef: { value: '20' }, APAccountRef: { value: '602' }, TotalAmt: 697.68, Balance: 697.68 };
  const record = { ...target, TxnDate: '2026-09-17', CurrencyRef: { value: 'CAD' }, SyncToken: '3' };
  f.parents.length = 0; f.step.dependencies = [];
  const d = f.step.details; d.references = []; delete d.amountSourceKey; d.amountRule = 'adopted_open_balance';
  if (invoice) d.customerKey = partyKey; else d.vendorKey = partyKey;
  d.adoptedSettlement = { entity: invoice ? 'Invoice' : 'Bill', qboId: record.Id, amountCents: invoice ? 28386 : 69768 };
  d.activityBatch = { key: 'e'.repeat(64), index: 0, stepKey: invoice ? 'payment' : 'bill-payment', purpose: 'Settle the adopted obligation in full.' };
  const index = f.step.references.findIndex(ref => ref.entity === party), observed = f.referenceEvidence.find(value => value.entity === party);
  f.step.references[index] = bindBusinessReference({ scope, entity: party, key: partyKey, observed, now });
  f.adopted = { scope, entity: d.adoptedSettlement.entity, record, recordHash: hash(record), observedAt: new Date(now).toISOString(), operationId: f.observationFence.operationId, writerRevision: 4,
    population: { logicalKey: hash('imported ' + record.Id), entity: d.adoptedSettlement.entity, qboId: record.Id, txnDate: '2026-09-17', accountId: invoice ? '601' : '602', partyKey, adoptionId: 'a'.repeat(24) } };
  f.reapprove = () => { f.approve(); f.policy.lifecycle = batchLifecycle(f.step); f.policy.stepHash = hash(f.step); };
  f.touch = () => { f.adopted.recordHash = hash(f.adopted.record); };
  f.reapprove();
  return f;
}

test('an adopted invoice is collected into undeposited funds and an adopted bill is paid from the bank', () => {
  const payment = adoptedFixture('Payment'), compiled = payment.compile(), body = JSON.parse(compiled.request.body);
  assert.deepEqual(compiled.relationships, []);
  assert.equal(body.TotalAmt, 283.86); assert.deepEqual(body.Line, [{ Amount: 283.86, LinkedTxn: [{ TxnId: '10720', TxnType: 'Invoice' }] }]);
  assert.equal(body.ARAccountRef.value, '601'); assert.equal(body.DepositToAccountRef.value, '603'); assert.equal(body.ProcessPayment, false); assert.equal(body.CustomerRef.value, '10');
  const bill = adoptedFixture('BillPayment'), paid = JSON.parse(bill.compile().request.body);
  assert.deepEqual(paid.Line, [{ Amount: 697.68, LinkedTxn: [{ TxnId: '10655', TxnType: 'Bill' }] }]);
  assert.equal(paid.APAccountRef.value, '602'); assert.equal(paid.PayType, 'Check'); assert.equal(paid.CheckPayment.BankAccountRef.value, '600');
});

test('a part payment is allowed; anything above the fresh open balance is refused', () => {
  const part = adoptedFixture(); part.step.details.adoptedSettlement.amountCents = 10000; part.reapprove();
  assert.equal(JSON.parse(part.compile().request.body).TotalAmt, 100);
  const over = adoptedFixture(); over.adopted.record.Balance = 200; over.touch(); assert.throws(over.compile, /open balance/);
  const paid = adoptedFixture('BillPayment'); paid.adopted.record.Balance = 0; paid.touch(); assert.throws(paid.compile, /open balance/);
});

test('missing, stale, foreign or changed adopted evidence is refused', () => {
  const changes = [
    f => { f.adopted = null; },
    f => { f.adopted.observedAt = new Date(now - 600000).toISOString(); },
    f => { f.adopted.scope = { ...scope, realmId: '456' }; },
    f => { f.adopted.writerRevision = 5; },
    f => { f.adopted.record.Balance = 999; },
    f => { f.adopted.record.Id = '99'; f.touch(); },
    f => { f.adopted.record.CustomerRef.value = '11'; f.touch(); },
    f => { f.adopted.record.CurrencyRef.value = 'USD'; f.touch(); },
    f => { f.adopted.record.TxnDate = '2026-09-18'; f.touch(); },
    f => { f.adopted.record.ARAccountRef.value = '699'; f.touch(); },
    f => { f.adopted.population.accountId = '699'; },
    f => { f.adopted.population.partyKey = 'care-client-001'; },
    f => { f.adopted.population.qboId = '10721'; },
    f => { f.adopted.population.adoptionId = 'not-an-adoption'; },
    f => { f.adopted.entity = 'Bill'; },
  ];
  for (const change of changes) { const f = adoptedFixture(); change(f); assert.throws(f.compile); }
});

test('adopted evidence cannot attach to an ordinary settlement, and an adopted settlement cannot take a managed parent', () => {
  const ordinary = fixture('Payment'); ordinary.adopted = adoptedFixture().adopted; assert.throws(ordinary.compile, /Adopted obligation evidence/);
  const borrowed = adoptedFixture(), managed = fixture('Payment');
  borrowed.parents.push(managed.parents[0]); borrowed.step.dependencies = [{ logicalKey: managed.parents[0].logicalKey, entity: 'Invoice', fingerprint: managed.parents[0].fingerprint }];
  assert.throws(() => { borrowed.reapprove(); borrowed.compile(); });
});

test('the reader binds the settlement to the adoption and a saved, financially verified import record', async () => {
  const adoption = { kind: 'adopted-history', adoptionId: 'a'.repeat(24), importedThrough: '2026-10-17' };
  const row = { environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, entity: 'Invoice', qboId: '10720', state: 'saved', txnDate: '2026-09-17', logicalKey: hash('imported'), receipt: { qboId: '10720' }, financialProof: { kind: 'population-financial-content' }, step: { details: { customerKey: 'care-client-021' } }, compilation: { request: { body: JSON.stringify({ ARAccountRef: { value: '601' } }) } } };
  const query = value => ({ select: () => query(value), maxTimeMS: () => query(value), lean: async () => value });
  const read = async (s, entity, id) => ({ scope: s, entity, record: { Id: id }, recordHash: hash({ Id: id }), observedAt: new Date(now).toISOString() });
  const reader = (calendar, record) => createAdoptedSettlementReader({ Calendars: { findOne: () => query(calendar) }, PopulationRecords: { findOne: () => query(record) }, readRecord: read });
  const value = await reader({ adoption }, row)(scope, { entity: 'Invoice', qboId: '10720' });
  assert.deepEqual(value.population, { logicalKey: row.logicalKey, entity: 'Invoice', qboId: '10720', txnDate: '2026-09-17', accountId: '601', partyKey: 'care-client-021', adoptionId: adoption.adoptionId });
  for (const [calendar, record] of [[{ adoption: null }, row], [{ adoption }, null], [{ adoption }, { ...row, state: 'pending' }], [{ adoption }, { ...row, financialProof: null }], [{ adoption }, { ...row, connectionId: 'f'.repeat(24) }], [{ adoption }, { ...row, txnDate: '2026-10-18' }], [{ adoption }, { ...row, receipt: { qboId: '1' } }]])
    await assert.rejects(reader(calendar, record)(scope, { entity: 'Invoice', qboId: '10720' }));
  await assert.rejects(reader({ adoption }, row)(scope, { entity: 'Payment', qboId: '10720' }));
});
