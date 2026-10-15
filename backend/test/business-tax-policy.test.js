'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { applicableRate, taxCents, deriveBusinessPolicies, verifyBusinessTaxSources } = require('../src/modules/business-tax-policy');
const { candidateFixture } = require('./helpers/business-operation-candidate-fixture');
const rate = (Id, percent = 13) => ({ Id, SyncToken: '0', Active: true, EffectiveTaxRate: [{ EffectiveDate: '2020-01-01', RateValue: percent }] });
test('tax uses the uniquely effective historical rate and rejects ambiguous boundaries', () => {
 const value = rate('950'); value.EffectiveTaxRate = [{ EffectiveDate: '2020-01-01', EndDate: '2025-04-01', RateValue: 15 }, { EffectiveDate: '2025-04-01', RateValue: 14 }];
 assert.equal(applicableRate(value, '2024-10-01'), 15); assert.equal(applicableRate(value, '2026-10-01'), 14);
 assert.equal(applicableRate(value, '2025-04-01'), 14);
 assert.equal(applicableRate({ ...rate('950'), EffectiveTaxRate: [{ EffectiveDate: '2020-01-01T00:00:00+14:00', RateValue: 5 }] }, '2020-01-01'), 5);
 assert.equal(applicableRate({ ...rate('950'), EffectiveTaxRate: [{ EffectiveDate: '2020-01-01T00:00:00.000-08:00', RateValue: 5 }] }, '2020-01-01'), 5);
 assert.throws(() => applicableRate({ ...rate('950'), EffectiveTaxRate: [{ EffectiveDate: '2020-01-01T12:00:00Z', RateValue: 5 }] }, '2020-01-01'), /midnight/);
 assert.throws(() => applicableRate({ ...value, EffectiveTaxRate: [] }, '2026-10-01'), /history/);
 assert.throws(() => applicableRate({ ...value, EffectiveTaxRate: [{ EffectiveDate: '2020-01-01', RateValue: 5 }, { EffectiveDate: '2020-01-01', RateValue: 8 }] }, '2026-10-01'), /overlapping/);
 assert.equal(taxCents(101, 5), 5); assert.equal(taxCents(10, 5), 1); assert.equal(taxCents(10000, 9.975), 998);
});
function fixture() {
 const f=candidateFixture(), entries=[{kind:'create',step:f.po.step},{kind:'create',step:f.bill.step}];
 const records={TaxCode:{Id:'901',SyncToken:'0',Active:true,Taxable:true,PurchaseTaxRateList:{TaxRateDetail:[{TaxRateRef:{value:'950'},TaxTypeApplicable:'TaxOnAmount'}]}},TaxRate:rate('950')}, calls=[];
 const client={read:async(entity,id)=>{calls.push(entity+':'+id);const key=entity==='taxcode'?'TaxCode':'TaxRate';return{[key]:structuredClone(records[key])};}};
 return{f,records,calls,client,assembly:{candidate:{...f.context,fromDate:'2026-10-06',throughDate:'2026-10-06',entries}}};
}
test('server-derived expectations retain their exact tax definitions and are rechecked before compilation',async()=>{
 const h=fixture(), policies=await deriveBusinessPolicies(h.assembly,h.client,hash('authority'),h.f.now);
 assert.equal(policies.length,2);assert.equal(h.calls.length,2);assert.equal(policies[0].policy.readbackTax.totalTaxCents,3198);assert.equal(policies[0].policy.readbackTax.lines[0].percent,13);
 assert.equal(policies[0].policy.authorityHash,hash('authority'));await verifyBusinessTaxSources(policies[0].policy,h.client);
 h.records.TaxRate.SyncToken='1';await assert.rejects(verifyBusinessTaxSources(policies[0].policy,h.client),/changed after/);
});
test('compound, inactive, missing or unreadable historical tax definitions cannot become approved policies',async()=>{
 for(const change of [h=>{h.records.TaxCode.PurchaseTaxRateList.TaxRateDetail[0].TaxTypeApplicable='TaxOnTax';},h=>{h.records.TaxRate.Active=false;},h=>{h.records.TaxRate.EffectiveTaxRate=[];},h=>{h.records.TaxCode.Active=false;}]){
 const h=fixture();change(h);await assert.rejects(deriveBusinessPolicies(h.assembly,h.client,hash('authority'),h.f.now));
 }
});
