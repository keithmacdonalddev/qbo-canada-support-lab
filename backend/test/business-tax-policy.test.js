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
 h.records.TaxRate.EffectiveTaxRate[0].RateValue=14;await assert.rejects(verifyBusinessTaxSources(policies[0].policy,h.client),/changed after/);
});
test('compound, inactive, missing or unreadable historical tax definitions cannot become approved policies',async()=>{
 for(const change of [h=>{h.records.TaxCode.PurchaseTaxRateList.TaxRateDetail[0].TaxTypeApplicable='TaxOnTax';},h=>{h.records.TaxRate.Active=false;},h=>{h.records.TaxRate.EffectiveTaxRate=[];},h=>{h.records.TaxCode.Active=false;}]){
 const h=fixture();change(h);await assert.rejects(deriveBusinessPolicies(h.assembly,h.client,hash('authority'),h.f.now));
 }
});

test('tax source comparison accepts transport and reference-label differences in both directions, preserving raw integrity', async () => {
  for (const reverse of [false, true]) {
    const h = fixture();
    h.records.TaxCode.PurchaseTaxRateList.TaxRateDetail[0].TaxRateRef.name = 'Displayed tax rate';
    h.records.TaxRate.AgencyRef = { value: '1', name: 'Displayed agency' };
    const live = records => { for (const record of Object.values(records)) { record.MetaData = { LastUpdatedTime: '2026-10-06T11:59:59Z' }; record.domain = 'QBO'; record.sparse = false; record.SyncToken = '2'; } delete records.TaxCode.PurchaseTaxRateList.TaxRateDetail[0].TaxRateRef.name; delete records.TaxRate.AgencyRef.name; };
    if (reverse) live(h.records);
    const [{ policy }] = await deriveBusinessPolicies(h.assembly, h.client, hash('authority'), h.f.now);
    if (reverse) { delete h.records.TaxCode.MetaData; delete h.records.TaxCode.domain; delete h.records.TaxCode.sparse; h.records.TaxCode.PurchaseTaxRateList.TaxRateDetail[0].TaxRateRef.name = 'Renamed rate'; h.records.TaxRate.AgencyRef.name = 'Renamed agency'; }
    else live(h.records);
    await verifyBusinessTaxSources(policy, h.client);
    policy.taxSources[0].record.Description = 'Tampered retained evidence';
    await assert.rejects(verifyBusinessTaxSources(policy, h.client), /evidence changed/);
  }
});
test('canonical tax comparison still refuses rate, history, accounts, applicability, status, partial and version changes', async () => {
  for (const change of [h => { h.records.TaxCode.Active = false; }, h => { h.records.TaxCode.Taxable = false; }, h => { h.records.TaxCode.PurchaseTaxRateList.TaxRateDetail[0].TaxRateRef.value = '951'; }, h => { h.records.TaxCode.PurchaseTaxRateList.TaxRateDetail[0].TaxTypeApplicable = 'TaxOnTax'; }, h => { h.records.TaxRate.EffectiveTaxRate[0].RateValue++; }, h => { h.records.TaxRate.EffectiveTaxRate[0].EffectiveDate = '2026-10-07'; }, h => { h.records.TaxRate.AgencyRef.value = '2'; }, h => { h.records.TaxRate.TaxReturnLineRef.value = '3'; }, h => { h.records.TaxRate.sparse = true; }, h => { h.records.TaxRate.sparse = 'false'; }, h => { h.records.TaxRate.SyncToken = '01'; }, h => { delete h.records.TaxRate.SyncToken; }]) {
    const h = fixture(); h.records.TaxRate.AgencyRef = { value: '1' }; h.records.TaxRate.TaxReturnLineRef = { value: '2' };
    const [{ policy }] = await deriveBusinessPolicies(h.assembly, h.client, hash('authority'), h.f.now); change(h);
    await assert.rejects(verifyBusinessTaxSources(policy, h.client));
  }
  const h = fixture(); h.records.TaxRate.SyncToken = '2'; const [{ policy }] = await deriveBusinessPolicies(h.assembly, h.client, hash('authority'), h.f.now); h.records.TaxRate.SyncToken = '1';
  await verifyBusinessTaxSources(policy, h.client);
});

test('a changed pre-period start with identical effective tax does not invalidate current policy', async () => {
 const h=fixture(); const [{policy}]=await deriveBusinessPolicies(h.assembly,h.client,hash('authority'),h.f.now);
 h.records.TaxRate.EffectiveTaxRate[0].EffectiveDate='2021-01-01'; await verifyBusinessTaxSources(policy,h.client);
});

test('current tax meaning ignores provider extensions and version floors while preserving tax destinations', async () => {
 const h=fixture(); h.records.TaxRate.SyncToken='8'; const [{policy}]=await deriveBusinessPolicies(h.assembly,h.client,hash('authority'),h.f.now);
 h.records.TaxRate.SyncToken='1'; h.records.TaxRate.NewProviderDefault={enabled:false}; h.records.TaxCode.ProviderMetadata={value:12}; await verifyBusinessTaxSources(policy,h.client);
 h.records.TaxRate.AgencyRef={value:'999'}; await assert.rejects(verifyBusinessTaxSources(policy,h.client));
});

test('a purchase does not depend on unused sales components of the same code', async () => {
 const h=fixture(); const [{policy}]=await deriveBusinessPolicies(h.assembly,h.client,hash('authority'),h.f.now);
 h.records.TaxCode.SalesTaxRateList={TaxRateDetail:[{TaxRateRef:{value:'999'},TaxTypeApplicable:'TaxOnTax'}]}; await verifyBusinessTaxSources(policy,h.client);
});

test('malformed tax-order settings do not become ordinary zero-order tax', async () => {
 for(const order of [false,'']) { const h=fixture(); const [{policy}]=await deriveBusinessPolicies(h.assembly,h.client,hash('authority'),h.f.now); h.records.TaxCode.PurchaseTaxRateList.TaxRateDetail[0].TaxOnTaxOrder=order; await assert.rejects(verifyBusinessTaxSources(policy,h.client)); }
});
