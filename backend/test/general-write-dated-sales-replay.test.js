'use strict';
// Sanitized shape of the stored October 31 three-estimate refusal. The actual private
// proposal and publication also replay offline; no live QBO or database is used here.
const test = require('node:test'), assert = require('node:assert/strict');
const { createGeneralWriteContext, createGeneralWriteService } = require('../src/modules/general-write-service');
const { checkGeneralWrite } = require('../src/modules/general-write-guards');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const DAY = '2026-10-31';
const query = value => ({ select() { return this; }, sort() { return this; }, maxTimeMS() { return this; }, session() { return this; }, lean: async () => value });
test('stored three-estimate refusal shape prepares with published code16 and dated14%, never code12', async t => {
 const view = { mappings: { salesTax: '12', purchaseTax: '12' }, business: { openingDate: '2023-09-01', activityTemplateVersion: 2, datedTax: { version: 1, regime: 'CA-NS-2025-postpaid', salesTax: '16', purchaseTax: '16' } } };
 t.mock.method(require('../src/modules/business-authority'), 'readPublishedBusiness', async () => ({ view }));
 const records = new Map([['Account:50', { Id: '50', Active: true, AccountType: 'Bank' }]]);
 for (const id of ['1', '2', '3']) records.set('Customer:' + id, { Id: id, Active: true, DisplayName: 'Example customer ' + id, CurrencyRef: { value: 'CAD' } });
 records.set('Item:40', { Id: '40', Active: true, Type: 'Service', Name: 'Assessment hour' });
 for (const [code, rate, percent, effective] of [['12', '26', 15, '1970-01-01T00:00:00-08:00'], ['16', '34', 14, '2025-04-01T00:00:00-07:00']]) {
  const detail = { TaxRateRef: { value: rate }, TaxTypeApplicable: 'TaxOnAmount', TaxOrder: 0 };
  records.set('TaxCode:' + code, { Id: code, SyncToken: '0', Active: true, Taxable: true, SalesTaxRateList: { TaxRateDetail: [detail] }, PurchaseTaxRateList: { TaxRateDetail: [detail] } });
  records.set('TaxRate:' + rate, { Id: rate, SyncToken: '0', Active: true, RateValue: percent, EffectiveTaxRate: [{ RateValue: percent, EffectiveDate: effective }] });
 }
 const saved = [], models = { Calendars: { findOne: () => query({ verifiedThrough: '2026-10-30' }) }, Policies: { findOne: () => query({ periodControl: {} }) }, GeneralWriteRuns: { findOne: () => query(null), create: async rows => saved.push(...rows) }, Steps: { findOne: () => query(null) } };
 const now = () => Date.parse(DAY + 'T20:00:24.570Z');
 const contextFor = createGeneralWriteContext({ models, now });
 const local = { map: records, get: (entity, id) => records.get(entity + ':' + id) || null, owned: () => false };
 const context = await contextFor(scope, local);
 assert.deepEqual(context.taxCodes, { sales: ['16'], purchases: ['16'] }); assert.equal(context.taxPercent['16'], 14);
 const operations = [2, 3, 4].map((qty, index) => ({ ref: 'quote-' + index, op: 'create', entity: 'Estimate', payload: { CustomerRef: { value: String(index + 1) }, TxnDate: DAY, ExpirationDate: '2026-11-30', TxnStatus: 'Pending', GlobalTaxCalculation: 'TaxExcluded', PrivateNote: 'Independent assessment quote, pending acceptance.', Line: [{ Amount: qty * 125, DetailType: 'SalesItemLineDetail', Description: 'Remote assessment', SalesItemLineDetail: { ItemRef: { value: '40' }, Qty: qty, UnitPrice: 125, TaxCodeRef: { value: '16' } } }] } }));
 const check = ops => checkGeneralWrite({ proposal: { operations: ops }, local, context });
 assert.equal(check(operations).ok, true);
 let sends = 0;
 const api = createGeneralWriteService({ models, now, contextFor, copy: { read: async (scope, entity, id) => local.get(entity, id) }, transport: { sendBatch: async () => { sends++; throw new Error('Preparation cannot send.'); } }, dispatchEnabled: () => false });
 const result = await api.prepare({ scope, ownerId: 'b'.repeat(24), actorId: 'b'.repeat(24) }, { decisionKey: 'regional-client-assessment-quotes-01', purpose: 'Prepare three independent regional assessment quotes.', operations });
 assert.equal(result.status, 'prepared'); assert.equal(saved.length, 1); assert.equal(sends, 0);
 for (const entity of ['Invoice', 'SalesReceipt', 'CreditMemo', 'RefundReceipt']) {
  const op = structuredClone(operations[0]); op.entity = entity; delete op.payload.ExpirationDate; delete op.payload.TxnStatus;
  if (['SalesReceipt', 'RefundReceipt'].includes(entity)) op.payload.DepositToAccountRef = { value: '50' };
  assert.equal(check([op]).ok, true, entity + ': ' + JSON.stringify(check([op]).problems));
 }
 const old = structuredClone(operations); for (const op of old) op.payload.Line[0].SalesItemLineDetail.TaxCodeRef.value = '12';
 assert.ok(check(old).problems.some(p => /tax code 12.*policy.*16/.test(p.message)));
 const rate = records.get('TaxRate:34');
 rate.EffectiveTaxRate[0].RateValue = 15; await assert.rejects(contextFor(scope, local), /differs from its approved policy/);
 rate.EffectiveTaxRate = []; await assert.rejects(contextFor(scope, local), /history/);
 rate.EffectiveTaxRate = [{ RateValue: 14, EffectiveDate: '2027-01-01T00:00:00-07:00' }]; await assert.rejects(contextFor(scope, local), /effective tax rate/);
});
