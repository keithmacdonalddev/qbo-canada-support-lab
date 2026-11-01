'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sameQboValue,matchesQboRequest}=require('../src/modules/qbo-semantic-compare');
const {sameCanonicalDefinition}=require('../src/modules/business-reference');
const {sameDatedTaxDefinition,verifyBusinessTaxSources}=require('../src/modules/business-tax-policy');
const {classifyRecord,sameProvenRecord}=require('../src/modules/general-write-close');
const {hash}=require('../src/modules/business-calendar');
const line=(amount,id)=>({Amount:amount,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:id},Qty:1,UnitPrice:amount,TaxCodeRef:{value:'16'}}});
test('shared request comparison permits native line/link reorder, display labels and correct computed subtotal, preserves multiplicity and economics',()=>{
 const sent={Line:[line(250,'53'),line(125,'54')],LinkedTxn:[{TxnId:'1',TxnType:'BillPayment'},{TxnId:'2',TxnType:'Invoice'}]};
 const saved=structuredClone(sent);saved.Line.reverse();saved.LinkedTxn.reverse();saved.LinkedTxn[1].TxnType='BillPaymentCheck';saved.LinkedTxn[1].TxnLineId='0';saved.Line[0].SalesItemLineDetail.ItemRef.name='Provider display label';saved.Line.push({Amount:375,DetailType:'SubTotalLineDetail'});
 assert.equal(matchesQboRequest(sent,saved),true);
 for(const mutate of [r=>{r.Line[0].Amount=126},r=>{r.Line[0].SalesItemLineDetail.TaxCodeRef.value='12'},r=>{r.LinkedTxn[0].TxnLineId='4'},r=>{r.Line[2].Amount=376},r=>{r.Line.unshift(r.Line.pop())},r=>{r.Line.push({Amount:375,DetailType:'SubTotalLineDetail'})}]){const r=structuredClone(saved);mutate(r);assert.equal(matchesQboRequest(sent,r),false);}
 assert.equal(matchesQboRequest({Line:[{Amount:1},{Amount:1,Description:'a'}]},{Line:[{Amount:1,Description:'a'},{Amount:1,Description:'b'}]}),true,'overlapping subsets need a one-to-one assignment');
 assert.equal(matchesQboRequest({Line:[{Amount:1},{Amount:2}]},{Line:[{Amount:1},{Amount:1}]}),false);
 assert.equal(matchesQboRequest({Extension:{LinkedTxn:[{TxnId:'1',TxnType:'Invoice'},{TxnId:'2',TxnType:'Invoice'}]}},{Extension:{LinkedTxn:[{TxnId:'2',TxnType:'Invoice'},{TxnId:'1',TxnType:'Invoice'}]}}),false);
 assert.equal(matchesQboRequest({Extension:{Line:[{Amount:1}]}},{Extension:{Line:[{Amount:1},{Amount:1,DetailType:'SubTotalLineDetail'}]}}),false);
 assert.equal(matchesQboRequest({Unknown:[1,2]},{Unknown:[2,1]}),false);
 assert.equal(sameQboValue({Extension:{Line:[1,2]}},{Extension:{Line:[2,1]}}),false);
 assert.equal(sameQboValue({Extension:{LinkedTxn:[{TxnId:'1',TxnType:'BillPayment'}]}},{Extension:{LinkedTxn:[{TxnId:'1',TxnType:'BillPaymentCheck'}]}}),false);
});
test('money stays exact; general fractional unit prices remain supported; known defaults require entity scope',()=>{
 for(const key of ['Amount','TotalAmt','UnitPrice'])assert.equal(matchesQboRequest({[key]:125},{[key]:125.000000001},{transport:false}),false);
 assert.equal(matchesQboRequest({Line:[{Amount:1,SalesItemLineDetail:{UnitPrice:0.333333,Qty:3}}]},{Line:[{Amount:1,SalesItemLineDetail:{UnitPrice:0.333333,Qty:3}}]}),true);
 for(const entity of ['Item','Customer'])for(const value of [undefined,null,false])assert.equal(matchesQboRequest({Taxable:false},{Taxable:value},{entity}),true);
 assert.equal(matchesQboRequest({Taxable:false},{Taxable:true},{entity:'Item'}),false);assert.equal(matchesQboRequest({Unknown:false},{},{entity:'Item'}),false);
});
test('definition equality sorts only native tax lists, binds IDs/rates/orders/unknown fields and accepts validated midnight dates',()=>{
 const a={Id:'16',Active:true,SalesTaxRateList:{TaxRateDetail:[{TaxRateRef:{value:'1'},TaxOrder:0},{TaxRateRef:{value:'2'},TaxOrder:1}]}},b=structuredClone(a);b.SalesTaxRateList.TaxRateDetail.reverse();
 assert.equal(sameCanonicalDefinition('TaxCode',a,b),true);b.SalesTaxRateList.TaxRateDetail[0].TaxOnTaxOrder=0;delete b.SalesTaxRateList.TaxRateDetail[1].TaxOrder;assert.equal(sameCanonicalDefinition('TaxCode',a,b),true);b.SalesTaxRateList.TaxRateDetail[0].TaxOrder=2;assert.equal(sameCanonicalDefinition('TaxCode',a,b),false);
 const rate={EffectiveTaxRate:[{RateValue:14,EffectiveDate:'2025-04-01T00:00:00-07:00'}]};assert.equal(sameCanonicalDefinition('TaxRate',rate,{EffectiveTaxRate:[{RateValue:14,EffectiveDate:'2025-04-01'}]}),true);
 assert.equal(sameCanonicalDefinition('TaxRate',rate,{EffectiveTaxRate:[{RateValue:14,EffectiveDate:'2025-04-01T00:00:00+99:99'}]}),false);
});
test('dated source verification accepts irrelevant future history but refuses wrong in-period rates, unknown settings, expired/inactive and tampered evidence',async()=>{
 const before={Id:'34',SyncToken:'0',Active:true,RateValue:14,EffectiveTaxRate:[{RateValue:14,EffectiveDate:'2025-04-01'}]},current=structuredClone(before);current.SyncToken='1';current.EffectiveTaxRate.push({RateValue:15,EffectiveDate:'2027-01-01'});
 assert.equal(sameDatedTaxDefinition('TaxRate',before,current,'2026-10-31','2026-10-31'),true);
 const policy={fromDate:'2026-10-31',throughDate:'2026-10-31',taxSources:[{entity:'TaxRate',id:'34',record:before,recordHash:hash(before)}]};let live=current;const client={read:async()=>({TaxRate:live})};await verifyBusinessTaxSources(policy,client);
 for(const mutate of [r=>{r.EffectiveTaxRate[0].RateValue=15},r=>{r.EffectiveTaxRate[0].Unknown=true},r=>{r.EffectiveTaxRate[0].EndDate='2026-10-31'},r=>{r.Active=false},r=>{r.SyncToken='-1'}]){live=structuredClone(current);mutate(live);await assert.rejects(verifyBusinessTaxSources(policy,client));}
 live=current;policy.taxSources[0].recordHash=hash('tampered');await assert.rejects(verifyBusinessTaxSources(policy,client));
});
test('close semantic compatibility authenticates retained proof and monotonic string versions, preserves accounts/tax/unknown settings',()=>{
 const before={Id:'7',SyncToken:'1',TxnDate:'2026-10-31',Line:[line(250,'53'),line(125,'54')]},current=structuredClone(before);current.SyncToken='2';current.MetaData={LastUpdatedTime:'later'};current.Line.reverse();current.Line[0].SalesItemLineDetail.ItemRef.name='Display label';
 const evidence={accountant:{versionHash:hash(before),record:before}};assert.equal(classifyRecord({entity:'Estimate',current,evidence}).kind,'accountant');
 for(const mutate of [r=>{r.SyncToken='0'},r=>{r.SyncToken=2},r=>{r.Line[0].Amount=126},r=>{r.Unknown=false}]){const r=structuredClone(current);mutate(r);assert.equal(classifyRecord({entity:'Estimate',current:r,evidence}).kind,'external-change');}
 assert.equal(sameProvenRecord('Estimate',before,current,hash('forged')),false);
});
test('fixed master readback accepts omitted known false defaults but wrong true/price/account remains refused',()=>{
 const {verifyMasterReadback}=require('../src/modules/business-master-preparation-plan');
 const compiled={entity:'Item',payload:{Name:'Service',Active:true,Type:'Service',Taxable:false,UnitPrice:125,IncomeAccountRef:{value:'9'}}};
 const saved={Id:'53',SyncToken:'0',Name:'Service',Active:true,Type:'Service',UnitPrice:125,IncomeAccountRef:{value:'9',name:'Income'}};
 assert.equal(verifyMasterReadback(compiled,saved,'53').qboId,'53');
 for(const extra of [{Taxable:true},{UnitPrice:126},{IncomeAccountRef:{value:'10'}}])assert.throws(()=>verifyMasterReadback(compiled,{...saved,...extra},'53'));
});
