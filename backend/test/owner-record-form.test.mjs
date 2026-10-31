import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { composeRecord, fieldsFor, keepOwnerDraft, readOwnerDraft, draftKey } from '../../frontend/src/lib/owner-records.mjs'
const { entitySchema, ENTITIES } = createRequire(import.meta.url)('../src/modules/qbo-entity-schema')
const sales = { item: '20', quantity: '2', price: '12.35', tax: '3', description: 'Service work' }
test('guided invoice retains terms, date, Canadian line tax and structured email without computed totals', () => {
 const record = composeRecord(entitySchema('Invoice'), { TxnDate: '2026-10-31', CustomerRef: '10', SalesTermRef: '5', DueDate: '2026-11-30', BillEmail: 'fixture@example.test' }, [sales])
 assert.deepEqual(record.BillEmail, { Address: 'fixture@example.test' }); assert.deepEqual(record.CustomerRef, { value: '10' }); assert.equal(record.Line[0].Amount, 24.7); assert.equal(record.Line[0].SalesItemLineDetail.TaxCodeRef.value, '3'); assert.equal(record.GlobalTaxCalculation, 'TaxExcluded'); assert.equal(record.DueDate, '2026-11-30'); assert.ok(!('TotalAmt' in record)); assert.ok(!('TxnTaxDetail' in record))
})
test('partial payments and bill settlements link invoices/bills and subtract credits with selected bank', () => {
 const lines = [{ amount: '75.25', linkId: '101', linkType: 'Invoice' }, { amount: '25', linkId: '102', linkType: 'CreditMemo' }]
 const payment = composeRecord(entitySchema('Payment'), { TxnDate: '2026-10-31', CustomerRef: '10', DepositToAccountRef: '12' }, lines)
 assert.equal(payment.TotalAmt, 50.25); assert.deepEqual(payment.Line[0].LinkedTxn, [{ TxnId: '101', TxnType: 'Invoice' }])
 const bill = composeRecord(entitySchema('BillPayment'), { VendorRef: '9', PayType: 'CreditCard', paymentAccount: '33' }, [{ amount: '20', linkId: '104', linkType: 'Bill' }])
 assert.deepEqual(bill.CreditCardPayment, { CCAccountRef: { value: '33' } }); assert.equal(bill.TotalAmt, 20)
})
test('purchase account lines, journal postings, deposits and attached notes have their native shapes', () => {
 const purchase = composeRecord(entitySchema('Purchase'), { PaymentType: 'Cash', AccountRef: '1', EntityRef: '2' }, [{ mode: 'account', account: '4', amount: '15', tax: '3' }]); assert.equal(purchase.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, '3'); assert.equal(purchase.EntityRef.type, 'Vendor')
 const journal = composeRecord(entitySchema('JournalEntry'), {}, [{ account: '4', amount: '50', posting: 'Debit', party: '10', partyType: 'Customer' }]); assert.deepEqual(journal.Line[0].JournalEntryLineDetail.Entity, { Type: 'Customer', EntityRef: { value: '10' } })
 const deposit = composeRecord(entitySchema('Deposit'), {}, [{ mode: 'item', amount: '50', linkId: '9', linkType: 'Payment' }]); assert.equal(deposit.Line[0].LinkedTxn[0].TxnLineId, '0')
 const note = composeRecord(entitySchema('Attachable'), { attachType: 'Invoice', attachId: '101', Note: 'Fixture owner note' }, []); assert.equal(note.AttachableRef[0].EntityRef.type, 'Invoice')
})
test('catalog creates have guided required fields or explicit line/link controls; no Preferences create', () => {
 const controls = new Set(['Line', 'TotalAmt', 'AttachableRef'])
 for (const [entity, spec] of Object.entries(ENTITIES).filter(([, spec]) => spec.ops.includes('create'))) for (const key of spec.required) assert.ok(fieldsFor(entitySchema(entity)).includes(key) || controls.has(key), entity + '.' + key)
 assert.ok(!ENTITIES.Preferences.ops.includes('create'))
})
test('pending decisions and exact draft survive navigation/reload per company; credentials and saved records are not retained', () => {
 const map = new Map(), storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }, scope = { environment: 'production', realmId: '123', connectionId: 'abc' }
 const draft = { decisionKey: 'same-exact-decision', operations: [{ ref: 'owner-record', op: 'create', entity: 'Invoice', payload: { CustomerRef: { value: '10' } } }] }
 keepOwnerDraft(scope, { draft, uncertain: true, prepared: { runId: 'c'.repeat(24) }, result: { status: 'unknown', records: [{ record: { private: 'saved' } }] } }, storage)
 const restored = readOwnerDraft(scope, storage); assert.deepEqual(restored.draft, draft); assert.equal(restored.uncertain, true); assert.equal(restored.prepared.runId, 'c'.repeat(24)); assert.ok(!map.get(draftKey(scope)).includes('private')); assert.equal(readOwnerDraft({ ...scope, realmId: '999' }, storage), null)
 keepOwnerDraft(scope, null, storage); assert.equal(readOwnerDraft(scope, storage), null)
})
