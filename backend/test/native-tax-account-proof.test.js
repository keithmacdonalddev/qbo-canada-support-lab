'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../src/modules/native-tax-account-proof'),{hash}=require('../src/modules/business-calendar');
const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)},actorId='b'.repeat(24),clock=Date.parse('2026-11-04T11:00:00Z'),day='2026-11-03';
const clone=v=>JSON.parse(JSON.stringify(v));
const sha=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const types={Company:'1111111111',Indirecttaxes_TaxAgency:'2222222222',Accounting_LedgerAccount:'3333333333',Indirecttaxes_TaxRate:'4444444444'};
const node=(type,id,realm=scope.realmId)=>({type,id:Buffer.from('v4.1:'+realm+':'+types[type]).toString('base64')+':'+id});
const chain=v=>({sort(){return this;},session(){return this;},maxTimeMS(){return this;},select(){return this;},limit(){return this;},lean:async()=>clone(v)});
function capture(){return {version:2,scope,nativeOrigin:'https://qbo.intuit.com',operation:'Company__tax_agencies_indirect_tax_ui_qbo',at:new Date(clock-60000).toISOString(),queryHash:'1'.repeat(64),observer:{actor:'codex-cli',identityVerified:true,companyVerified:true,identityHash:'2'.repeat(64),leaseOwnerHash:'3'.repeat(64)},result:{status:200,graphqlNoErrors:true,dataPresent:true,rawResponseSha256:'4'.repeat(64),company:node('Company','123'),agencies:[{...node('Indirecttaxes_TaxAgency','1'),control:node('Accounting_LedgerAccount','75')},{...node('Indirecttaxes_TaxAgency','2'),control:node('Accounting_LedgerAccount','77')}],rates:[{...node('Indirecttaxes_TaxRate','8'),agency:node('Indirecttaxes_TaxAgency','1')},{...node('Indirecttaxes_TaxRate','9'),agency:node('Indirecttaxes_TaxAgency','2')}]}};}
async function fixture(observation=capture()){
 const rows=[],audits=[],records=new Map(),calls=[];
 for(const [id,agency] of [['8','1'],['9','2']])records.set('TaxRate:'+id,{Id:id,SyncToken:'0',Active:true,AgencyRef:{value:agency},RateValue:id==='8'?15:7});
 for(const id of ['1','2'])records.set('TaxAgency:'+id,{Id:id,SyncToken:'0',DisplayName:'Fictional agency '+id,TaxTrackedOnSales:true,TaxTrackedOnPurchases:true});
 for(const id of ['75','77'])records.set('Account:'+id,{Id:id,SyncToken:'0',Active:true,AccountType:'Other Current Liability',AccountSubType:'GlobalTaxPayable',CurrencyRef:{value:'CAD'},CurrentBalance:999});
 const models={Authorities:{findOne:f=>chain(f._id?rows.find(r=>r._id===f._id)||null:rows.at(-1)||null),create:async values=>rows.push(...clone(values))},Audits:{findOne:f=>chain(audits.find(r=>r._id===f._id&&r.realmId===f.realmId)||null),create:async values=>audits.push(...clone(values))}};
 const copy={read:async(s,entity,id)=>{assert.deepEqual(s,scope);calls.push(entity+':'+id);return clone(records.get(entity+':'+id)||null);}};
 const access={authorize:async(s)=>{assert.deepEqual(s,scope);return{actorId,ownerId:actorId};}};
 await P.admitProof({models,access,transaction:work=>work({}),copy,scope,actorId,ownerId:actorId,captureBytes:JSON.stringify(observation),reviewedCaptureSha256:sha(JSON.stringify(observation)),now:()=>clock});
 return{rows,audits,models,records,copy,calls,proof:()=>P.loadProof({...models,scope,now:clock})};
}
test('native capture binds successful complete typed company/agency/control/rate identities',()=>{
 const p=P.parseCapture(capture(),scope,clock);assert.deepEqual(p.agencies,[{agencyId:'1',accountId:'75'},{agencyId:'2',accountId:'77'}]);
 for(const change of [c=>c.result.status=400,c=>c.result.graphqlNoErrors=false,c=>c.result.dataPresent=false,c=>c.result.company=node('Company','999'),c=>c.result.agencies[0].control=node('Accounting_LedgerAccount','75','999'),c=>c.result.agencies[0].control.type='Indirecttaxes_TaxAgency',c=>c.result.agencies.push(clone(c.result.agencies[0])),c=>c.result.agencies[1].control=node('Accounting_LedgerAccount','75'),c=>c.result.rates.push(clone(c.result.rates[0])),c=>c.result.rates[0].agency=node('Indirecttaxes_TaxAgency','999','999'),c=>c.observer.identityVerified=false,c=>c.nativeOrigin='https://example.test',c=>c.scope={...scope,connectionId:'f'.repeat(24)},c=>c.at=new Date(clock-P.MAX_AGE_MS-1).toISOString(),c=>c.at=new Date(clock+120001).toISOString()]){const c=capture();change(c);assert.throws(()=>P.parseCapture(c,scope,clock));}
});
test('local admission and loader retain exact successful audit, owner, capture and configuration bindings',async()=>{
 const f=await fixture(),p=await f.proof();assert.equal(p.associations.length,2);assert.equal(f.audits.length,1);assert.equal(f.rows.length,1);
 const c=await P.contextFor({proof:p,scope,rateIds:['8','9'],copy:f.copy});assert.equal(c.taxAccount('8'),'75');assert.equal(c.taxAccount('9'),'77');assert.equal(c.evidence.rates[0].AgencyRef.value,'1');
 for(const change of [f=>f.audits[0].action='unrelated',f=>f.audits[0].userId='f'.repeat(24),f=>f.audits[0].inputParams.connectionId='f'.repeat(24),f=>f.audits[0].afterState.proofHash='0'.repeat(64),f=>f.rows[0].payload.associations[0].accountId='77',f=>f.rows[0].payload.scope.realmId='999']){const x=await fixture();change(x);await assert.rejects(x.proof());}
});
test('latest malformed or expired proof never falls back to an older valid association',async()=>{
 const f=await fixture();f.rows.push({...clone(f.rows[0]),_id:'c'.repeat(24),contentHash:'0'.repeat(64)});await assert.rejects(f.proof(),/Latest retained/);
 const old=await fixture();await assert.rejects(P.loadProof({...old.models,scope,now:clock+P.MAX_AGE_MS}),/expired/);
});
test('uncovered rate agencies and changed agency/account configuration require fresh native evidence',async()=>{
 for(const change of [f=>f.records.get('TaxRate:8').AgencyRef.value='999',f=>f.records.get('TaxAgency:1').SyncToken='1',f=>f.records.get('Account:75').Active=false,f=>f.records.get('Account:75').AccountSubType='GlobalTaxSuspense',f=>f.records.get('Account:75').CurrencyRef.value='USD',f=>f.records.delete('TaxRate:8')]){const f=await fixture(),p=await f.proof();change(f);await assert.rejects(P.contextFor({proof:p,scope,rateIds:['8'],copy:f.copy}));}
});
async function closeFixture(){
 const f=await fixture(),closes=[];
 const sale=(Id,rate,totalTax,entity='Invoice')=>({Id,SyncToken:'0',TxnDate:day,CurrencyRef:{value:'CAD'},CustomerRef:{value:'20'},TotalAmt:100+totalTax,Balance:100+totalTax,Line:[{Amount:100,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:'40'},Qty:1,UnitPrice:100,TaxCodeRef:{value:'7'}}}],TxnTaxDetail:{TotalTax:totalTax,TaxLine:[{Amount:totalTax,TaxLineDetail:{TaxRateRef:{value:rate}}}]}});
 const invoice=sale('700','8',15),other=sale('701','9',7),credit=sale('702','8',15);
 const bill={Id:'703',SyncToken:'0',TxnDate:day,CurrencyRef:{value:'CAD'},VendorRef:{value:'30'},TotalAmt:115,Balance:115,Line:[{Amount:100,DetailType:'AccountBasedExpenseLineDetail',AccountBasedExpenseLineDetail:{AccountRef:{value:'500'},TaxCodeRef:{value:'7'}}}],TxnTaxDetail:{TotalTax:15,TaxLine:[{Amount:15,TaxLineDetail:{TaxRateRef:{value:'8'}}}]}};
 const originals=[['Invoice',invoice],['Invoice',other],['CreditMemo',credit],['Bill',bill]];
 for(const [entity,r]of originals)f.records.set(entity+':'+r.Id,r);
 f.records.set('Item:40',{Id:'40',Type:'Service',IncomeAccountRef:{value:'400'}});
 const run={_id:'c'.repeat(24),day,dirty:[],batches:[],plan:{operations:originals.map(([entity,r])=>({ref:entity+r.Id,op:'create',entity,payload:clone(r)}))},items:Object.fromEntries(originals.map(([entity,r])=>[entity+r.Id,{outcome:'saved',op:'create',entity,qboId:r.Id,record:clone(r)}]))};
 f.models.GeneralWriteRuns={find:()=>chain([run])};f.models.GeneralDayCloses={findOne:()=>chain(null),create:async values=>closes.push(...clone(values))};f.models.Records={find:()=>chain(['75','77'].map(id=>({qboId:id,record:f.records.get('Account:'+id)})))};
 const columns=['tx_date','txn_type','doc_num','name','memo','split_acc','debt_amt','credit_amt'].map(ColType=>({ColType}));
 const label={Invoice:'Invoice',CreditMemo:'Credit Memo',Bill:'Bill'},postings=[['Invoice','700','120',115],['Invoice','700','400',-100],['Invoice','700','75',-15],['Invoice','701','120',107],['Invoice','701','400',-100],['Invoice','701','77',-7],['CreditMemo','702','120',-115],['CreditMemo','702','400',100],['CreditMemo','702','75',15],['Bill','703','200',-115],['Bill','703','500',100],['Bill','703','75',15]];
 const report={Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',Currency:'CAD',StartPeriod:day,EndPeriod:day},Columns:{Column:columns},Rows:{Row:postings.map(([entity,id,account,cents])=>({type:'Section',Header:{ColData:[{value:'Fictional',id:account}]},Rows:{Row:[{type:'Data',ColData:[{value:day},{value:label[entity],id},{},{},{},{},{value:cents>0?cents.toFixed(2):''},{value:cents<0?(-cents).toFixed(2):''}]}]}}))}};
 const gate=require('../src/modules/general-write-close-gate').createGeneralCloseGate({models:f.models,copy:f.copy,now:()=>clock});
 return{...f,run,gate,closes,report,args:{fromDate:day,throughDate:day,verifiedThrough:'2026-11-02',openingDate:'2023-09-01',mappings:{accountsReceivable:'120',accountsPayable:'200'}}};
}
test('native agency proof closes distinct sales, credit and purchase tax postings without collapsing accounts',async()=>{
 const f=await closeFixture();const result=await f.gate.assertPeriodReady(scope,{...f.args,readLedger:async()=>clone(f.report)});assert.equal(result.results[0].ok,true);assert.equal(result.results[0].recordCount,4);
 const bad=await closeFixture();bad.report.Rows.Row[2].Header.ColData[0].id='77';await assert.rejects(bad.gate.assertPeriodReady(scope,{...bad.args,readLedger:async()=>clone(bad.report)}),/Ledger|postings|not verified/);assert.ok(bad.closes.every(c=>c.ok===false));
});
test('tax configuration or proof change while GL is read cannot reuse or accept the earlier context',async()=>{
 for(const change of [f=>f.records.get('TaxRate:8').AgencyRef.value='2',f=>f.records.get('TaxAgency:1').SyncToken='1',f=>f.records.get('Account:75').Active=false,f=>f.rows[0].contentHash='0'.repeat(64)]){const f=await closeFixture();await assert.rejects(f.gate.assertPeriodReady(scope,{...f.args,readLedger:async()=>{change(f);return clone(f.report);}}));assert.ok(f.closes.every(c=>c.ok===false));}
});

test('revocation, future admission, missing audit and invalid observer cannot be accepted even with matching integrity hashes',async()=>{
 for(const change of [f=>f.rows[0].payload.revoked=true,f=>f.rows[0].payload.observer.identityVerified=false,f=>f.rows[0].payload.admittedAt=new Date(clock+120001).toISOString(),f=>f.audits[0].inputParams.observer='unrelated',f=>f.audits.length=0]){
  const f=await fixture();change(f);f.rows[0].contentHash=hash(f.rows[0].payload);if(f.audits[0])f.audits[0].afterState.proofHash=f.rows[0].contentHash;await assert.rejects(f.proof());
 }
});

test('admission hashes actual capture bytes rather than trusting caller digest claims',async()=>{
 const original=JSON.stringify(capture()),changed=capture();changed.result.agencies[0].control=node('Accounting_LedgerAccount','79');let accessed=false;
 const attempt=bytes=>P.admitProof({models:{},access:{authorize:async()=>{accessed=true;}},transaction:()=>{throw Error('No transaction');},copy:{},scope,actorId,ownerId:actorId,captureBytes:bytes,reviewedCaptureSha256:sha(original),now:()=>clock});
 await assert.rejects(attempt(JSON.stringify(changed)),/bytes differ/);assert.equal(accessed,false);
 await assert.rejects(attempt(capture()),/capture bytes/);assert.equal(accessed,false);
});

test('non-posting and zero tax lines require no native proof lookup or tax-configuration GET',async()=>{
 const f=await closeFixture(),invoice=f.records.get('Invoice:700');invoice.TotalAmt=100;invoice.Balance=100;invoice.TxnTaxDetail={TotalTax:0,TaxLine:[{Amount:0,TaxLineDetail:{TaxRateRef:{value:'999'}}}]};
 const estimate={...clone(invoice),Id:'704',TxnTaxDetail:{TotalTax:15,TaxLine:[{Amount:15,TaxLineDetail:{TaxRateRef:{value:'999'}}}]}};f.records.set('Estimate:704',estimate);
 f.run.items={inv:{outcome:'saved',op:'create',entity:'Invoice',qboId:'700',record:clone(invoice)},quote:{outcome:'saved',op:'create',entity:'Estimate',qboId:'704',record:clone(estimate)}};
 f.run.plan.operations=[{ref:'inv',op:'create',entity:'Invoice',payload:clone(invoice)},{ref:'quote',op:'create',entity:'Estimate',payload:clone(estimate)}];
 f.models.Authorities.findOne=()=>{throw Error('No tax proof lookup for non-posting/zero tax');};
 f.report.Rows.Row=f.report.Rows.Row.filter(row=>row.Rows.Row[0].ColData[1].id==='700'&&row.Header.ColData[0].id!=='75');f.report.Rows.Row.find(row=>row.Header.ColData[0].id==='120').Rows.Row[0].ColData[6].value='100.00';
 f.calls.length=0;const result=await f.gate.assertPeriodReady(scope,{...f.args,readLedger:async()=>clone(f.report)});assert.equal(result.results[0].ok,true);assert.ok(f.calls.every(call=>!/^TaxRate:|^TaxAgency:|^Account:/.test(call)));
});

test('observer evidence retains only identity verification hashes and named actor',()=>{
 const c=capture();c.observer.unrelated='sensitive-metadata-fixture';const parsed=P.parseCapture(c,scope,clock);assert.equal(parsed.observer.unrelated,undefined);assert.deepEqual(Object.keys(parsed.observer).sort(),['actor','companyVerified','identityHash','identityVerified','leaseOwnerHash'].sort());
});

test('native evidence preserves uncovered agencies without granting a control account',async()=>{
 const c=capture();c.result.rates.push({...node('Indirecttaxes_TaxRate','22'),agency:node('Indirecttaxes_TaxAgency','3')});
 const f=await fixture(c),p=await f.proof();assert.deepEqual(p.uncoveredAgencyIds,['3']);assert.equal(p.associations.length,2);assert.equal((await P.contextFor({proof:p,scope,rateIds:['8'],copy:f.copy})).taxAccount('8'),'75');
 f.records.set('TaxRate:22',{Id:'22',AgencyRef:{value:'3'}});await assert.rejects(P.contextFor({proof:p,scope,rateIds:['22'],copy:f.copy}),/no retained native/);
 p.uncoveredAgencyIds.push('1');f.rows[0].payload.uncoveredAgencyIds=p.uncoveredAgencyIds;f.rows[0].contentHash=hash(f.rows[0].payload);f.audits[0].afterState.proofHash=f.rows[0].contentHash;await assert.rejects(f.proof(),/uncovered native agencies/);
});

test('ordinary Account balance timestamps do not invalidate retained native control identity or either ledger window',async()=>{
 const f=await closeFixture(),old='2026-11-04T02:34:29-08:00',next='2026-11-04T03:15:33-08:00';
 // Authenticated legacy admissions retained this timestamp. Keep their original payload and audit hashes.
 for(const a of f.rows[0].payload.associations){a.account.configurationUpdatedAt=old;f.records.get('Account:'+a.accountId).MetaData={LastUpdatedTime:old};}
 f.rows[0].contentHash=hash(f.rows[0].payload);f.audits[0].afterState.proofHash=f.rows[0].contentHash;
 const originalProof=clone(f.rows[0]),originalAudit=clone(f.audits[0]);
 const result=await f.gate.assertPeriodReady(scope,{...f.args,readLedger:async()=>{f.records.get('Account:75').MetaData.LastUpdatedTime=next;f.records.get('Account:75').CurrentBalance+=427.50;return clone(f.report);}});
 assert.equal(result.results[0].ok,true);assert.deepEqual(f.rows[0],originalProof);assert.deepEqual(f.audits[0],originalAudit);
 assert.equal(P.configuration('Account',f.records.get('Account:75'),'75').configurationUpdatedAt,undefined);
 assert.equal(P.configuration('TaxAgency',{...f.records.get('TaxAgency:1'),MetaData:{LastUpdatedTime:next}},'1').configurationUpdatedAt,next);
});
