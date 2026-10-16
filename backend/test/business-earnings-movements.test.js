'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,scope}=require('./helpers/business-governance-fixture');
const {hash}=require('../src/modules/business-calendar');
const {packReport,unpackReport}=require('../src/modules/business-report-source');
const {freezeWriteRequest}=require('../src/modules/qbo-write-contract');
const {KEYS,EARNINGS_KEYS,createFinancialExpectation,validateFinancialExpectation,compareFinancialMovements,movementRow,assertMovementCapacity}=require('../src/modules/business-financial-movements');
const config=require('../src/config'),originalEnvironment=config.qbo.environment;
const period={fromDate:'2026-10-01',throughDate:'2026-10-31'},zeros=keys=>Object.fromEntries(keys.map(key=>[key,0]));
test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=originalEnvironment;});
function state(values={},shared=false){
 const h=fixture({activityTemplateVersion:2,sharedIncomeAccount:shared}),old=h.reportSources(period),seen=new Set(),rows=[];
 const row=(id,n)=>({type:'Data',ColData:[{id,value:'Account '+id},{value:(Math.max(0,n)/100).toFixed(2)},{value:(Math.max(0,-n)/100).toFixed(2)}]});
 const amounts={...zeros(EARNINGS_KEYS),operatingBank:100000,...values};
 for(const key of EARNINGS_KEYS){const id=h.mappings[key];if(!seen.has(id)){seen.add(id);rows.push(row(id,amounts[key]));}}
 rows.push(row('972',-rows.reduce((sum,r)=>sum+Math.round(Number(r.ColData[1].value)*100)-Math.round(Number(r.ColData[2].value)*100),0)));
 rows.push({group:'GrandTotal',Summary:{ColData:[{value:'TOTAL'},...[1,2].map(i=>({value:(rows.reduce((sum,r)=>sum+Math.round(Number(r.ColData[i].value)*100),0)/100).toFixed(2)}))]}});
 old.reports.TrialBalance.Rows.Row=rows;
 const reports=Object.fromEntries(Object.entries(old.reports).map(([name,value])=>[name,packReport(name,unpackReport(name,value,2),3)]));
 const {sourceHash,...raw}=old,body={...raw,version:3,reports},source={...body,sourceHash:hash(body)};
 return{h,source,expectation:createFinancialExpectation(scope,period,h.mappings,source)};
}
test('original v1/v2 four-account expectations and complete result hashes remain unchanged',()=>{
 const expected=['c6647456dd03540eb9d085f07bc32256d09095d5b0aa2e4f8fbbc1920d04c860','144d448185fc027cc6b4f79999fddd82872e503e1e47acc46462f59e20ec1017'];
 for(const version of [1,2]){
  const saved=require('./fixtures/legacy-financial-expectation-v'+version+'.json');
  assert.equal(hash(saved.expectation),expected[version-1]);assert.equal(saved.expectation.accounts.length,4);
  assert.deepEqual(validateFinancialExpectation(saved.expectation,scope,period),saved.expectation);
  const result=compareFinancialMovements(saved.expectation,[],saved.observation);
  assert.deepEqual(result,saved.comparison);assert.equal(hash(result),'b96ea3494c0027c5986fedf4e0be01edf513ecca6dab0b4fa9c2b6b0e88c0200');assert.equal(result.version,1);
 }
});
test('new eight-role proof detects balanced wrong income or overhead while original four controls still agree',()=>{
 const {source,expectation}=state();assert.equal(expectation.version,3);assert.deepEqual(expectation.accounts.map(row=>row.key),EARNINGS_KEYS);
 const postings={...zeros(EARNINGS_KEYS),serviceIncome:-12500,supplyIncome:-8200,careIncome:-14900,operatingExpense:95000},basis=[{postings}],ending=Object.fromEntries(EARNINGS_KEYS.map(key=>[key,expectation.opening[key]+postings[key]]));
 assert.equal(compareFinancialMovements(expectation,basis,state(ending).source).status,'passed');
 const old=require('./fixtures/legacy-financial-expectation-v2.json');
 for(const key of ['serviceIncome','supplyIncome','careIncome','operatingExpense']){
  const observed=state({...ending,[key]:ending[key]+1}).source,actual=compareFinancialMovements(expectation,basis,observed);
  assert.equal(actual.status,'failed');assert.equal(actual.checks.find(row=>row.key===key).differenceCents,1);
  assert.equal(compareFinancialMovements(old.expectation,[{postings:zeros(KEYS)}],observed).status,'passed','Balanced misclassification must be exposed by the new role proof, not cash or total equality');
 }
 const changed=structuredClone(source);changed.accounts.find(row=>row.Id===expectation.accounts.find(row=>row.key==='careIncome').id).Name='Changed definition';
 assert.equal(compareFinancialMovements(expectation,[],changed).status,'unavailable');
});
test('shared income aliases compare one physical opening balance and the sum of all role changes once',()=>{
 const {expectation}=state({serviceIncome:-70000},true),postings={...zeros(EARNINGS_KEYS),serviceIncome:-10000,supplyIncome:-20000,careIncome:-30000};
 const result=compareFinancialMovements(expectation,[{postings}],state({serviceIncome:-130000},true).source);
 assert.equal(result.status,'passed');assert.equal(result.checks.length,6);
 const income=result.checks.find(row=>row.roles.length===3);assert.deepEqual(income.roles,['serviceIncome','supplyIncome','careIncome']);assert.equal(income.openingCents,-70000);assert.equal(income.changeCents,-60000);assert.equal(income.expectedCents,-130000);
 assert.match(income.label,/Service income.*Supply income.*Care-plan income/);
 const changed=structuredClone(expectation);changed.accounts.find(row=>row.key==='careIncome').definitionHash=hash('conflicting alias');
 assert.throws(()=>validateFinancialExpectation(changed,scope,period));
});
function artifact(entity='Invoice',role='serviceIncome'){
 const {h,expectation}=state(),sales=entity!=='Bill',stock=role==='inventoryAsset',itemKey='original-item';
 const details={amountSourceKey:hash('parent'),taxMapping:sales?'salesTax':'purchaseTax',lines:[sales||stock?{key:'primary',itemKey,quantity:1,unitPriceCents:10000,amountCents:10000,accountMapping:role}:{key:'primary',accountMapping:role,amountCents:10000,billableStatus:'NotBillable'}]};
 const step={logicalKey:hash(entity+role),entity,txnDate:'2026-10-01',details,references:[...expectation.accounts.map(row=>({entity:'Account',key:row.key,id:row.id,definition:{version:1,hash:row.definitionHash}})),{entity:'Item',key:itemKey,id:'600',definition:{version:1,hash:hash('original-item')}},{entity:'TaxCode',key:details.taxMapping,id:h.mappings[details.taxMapping],definition:{version:1,hash:hash('original-tax')}}]};
 const kind=sales?'SalesItemLineDetail':stock?'ItemBasedExpenseLineDetail':'AccountBasedExpenseLineDetail',detail=sales||stock?{ItemRef:{value:'600'},Qty:1,UnitPrice:100,TaxCodeRef:{value:h.mappings[details.taxMapping]}}:{AccountRef:{value:h.mappings.operatingExpense},BillableStatus:'NotBillable',TaxCodeRef:{value:h.mappings.purchaseTax}};
 const payload={TxnDate:step.txnDate,CurrencyRef:{value:'CAD'},GlobalTaxCalculation:'TaxExcluded',...(entity==='Invoice'?{ARAccountRef:{value:h.mappings.accountsReceivable}}:entity==='SalesReceipt'?{DepositToAccountRef:{value:h.mappings.operatingBank}}:{APAccountRef:{value:h.mappings.accountsPayable}}),Line:[{Amount:100,DetailType:kind,[kind]:detail}]};
 const policy={version:1,status:'approved',scope,country:'CA',currency:'CAD',tax:{calculation:'TaxExcluded',salesTax:h.mappings.salesTax,purchaseTax:h.mappings.purchaseTax},readbackTax:{version:1,totalTaxCents:1300,lines:[{rateId:'950',percent:13,taxableCents:10000,amountCents:1300}]}};
 const x={h,expectation,step,payload,policy};
 x.calculate=()=>{
  const approved={...x.policy,stepHash:hash(x.step)},body={version:1,logicalKey:x.step.logicalKey,entity:x.step.entity,intentHash:hash(x.step),request:freezeWriteRequest(scope,'POST',x.step.entity.toLowerCase(),x.payload),evidenceHash:hash('original-observations'),relationships:[]},compiled={...body,compilationHash:hash(body)};
  return movementRow(x.expectation,x.step,compiled,approved,{policyHash:hash(approved)}).postings;
 };
 return x;
}
test('pretax earnings come from exact original item/account/amount intent; stock bills never invent overhead',()=>{
 for(const role of ['serviceIncome','supplyIncome','careIncome']){const x=artifact(role==='supplyIncome'?'SalesReceipt':'Invoice',role),postings=x.calculate();assert.equal(postings[role],-10000);assert.equal(postings.operatingExpense,0);assert.equal(postings[role==='supplyIncome'?'operatingBank':'accountsReceivable'],11300);}
 const expense=artifact('Bill','operatingExpense').calculate();assert.equal(expense.operatingExpense,10000);assert.equal(expense.accountsPayable,-11300);
 assert.equal(artifact('Bill','inventoryAsset').calculate().operatingExpense,0);
 for(const mutate of [
  x=>{x.payload.Line[0].SalesItemLineDetail.ItemRef.value='601';},
  x=>{x.payload.Line[0].Amount=99.99;},
  x=>{x.step.details.lines[0].amountCents=9999;},
  x=>{x.step.references.find(row=>row.key==='serviceIncome').definition.hash=hash('other original definition');},
  x=>{x.step.details.lines[0].accountMapping='unplanned-income';},
  x=>{x.payload.Line[0].SalesItemLineDetail.ClassRef={value:'900'};},
  x=>{x.payload.Line.push({Amount:0,DetailType:'SubTotalLineDetail',SubTotalLineDetail:{}});},
  x=>{x.payload.Line[0].DetailType='DiscountLineDetail';},
  x=>{x.payload.GlobalTaxCalculation='TaxInclusive';}
 ]){const x=artifact();mutate(x);assert.throws(x.calculate);}
});
test('v3 rejects crossing or impossible dates during preparation and retained validation; legacy proofs remain readable',()=>{
 const {h,source,expectation}=state(),cross={fromDate:'2026-10-15',throughDate:'2026-11-10'},raw=structuredClone(source);raw.period=cross;delete raw.sourceHash;raw.sourceHash=hash(raw);
 assert.throws(()=>createFinancialExpectation(scope,cross,h.mappings,raw),/one calendar month/);
 assert.throws(()=>validateFinancialExpectation({...expectation,period:cross},scope,cross),/one calendar month/);
 assert.throws(()=>validateFinancialExpectation({...expectation,period:{fromDate:'2026-02-30',throughDate:'2026-02-30'}},scope,{fromDate:'2026-02-30',throughDate:'2026-02-30'}),/valid financial-proof dates/);
 const old=require('./fixtures/legacy-financial-expectation-v2.json'),legacy=structuredClone(old.expectation);legacy.period=cross;legacy.source.period=cross;const report=unpackReport('TrialBalance',legacy.source.report,3);report.Header.StartPeriod=cross.fromDate;report.Header.EndPeriod=cross.throughDate;legacy.source.report=packReport('TrialBalance',report,3);legacy.sourceHash=hash(legacy.source);
 assert.doesNotThrow(()=>validateFinancialExpectation(legacy,scope,cross));
});
test('explicit empty v3 report keeps all eight roles and capacity includes their larger compact basis',()=>{
 const {h,source}=state(),raw=structuredClone(source),report=unpackReport('TrialBalance',raw.reports.TrialBalance,3);report.Rows.Row=[];report.Header.Option=[{Name:'NoReportData',Value:'true'}];raw.reports.TrialBalance=packReport('TrialBalance',report,3);delete raw.sourceHash;raw.sourceHash=hash(raw);
 const empty=createFinancialExpectation(scope,period,h.mappings,raw);assert.deepEqual(empty.opening,zeros(EARNINGS_KEYS));
 const records=Array.from({length:100},()=>({kind:'create',relationships:[]})),old=require('./fixtures/legacy-financial-expectation-v2.json');
 assert.ok(assertMovementCapacity({financialExpectation:empty,records})>assertMovementCapacity({financialExpectation:old.expectation,records}));
});
async function run(h,throughDate,key){
 const p=await h.service.prepare(h.user,{requestKey:key,throughDate});await h.service.approve(h.user,p.operationId,{planHash:p.planHash});const runtime=h.runtime(p.operationId),result=await runtime.execute();assert.equal(result.complete,true,JSON.stringify(result));return{p,runtime,visible:(await runtime.inspect()).financialMovements};
}
test('installed SDK periods prove original account postings across actual fiscal rollover and late older settlements',{timeout:180000},async()=>{
 for(const [openingDate,fiscal,firstEnd,nextEnd]of [['2026-10-01',11,'2026-10-31','2026-11-15'],['2026-03-01',4,'2026-03-31','2026-04-15']]){
  const h=fixture({openingDate,activityTemplateVersion:2,actualFiscalYearStartMonth:fiscal,copyOnWriteTransactions:true,originalSdkTransport:true});assert.equal(h.client.oauthClient.makeApiCall,require('intuit-oauth').prototype.makeApiCall);await h.publish();
  const first=await run(h,firstEnd,'earnings-before-rollover-'+fiscal),firstProof=structuredClone(first.visible),priorSources=h.reportSources({fromDate:openingDate,throughDate:firstEnd});
  assert.equal(first.visible.checks.length,8);assert.ok(first.visible.checks.filter(row=>['serviceIncome','supplyIncome','careIncome'].includes(row.key)).every(row=>row.changeCents<0));assert.ok(first.visible.checks.find(row=>row.key==='operatingExpense').changeCents>0);
  const second=await run(h,nextEnd,'earnings-after-rollover-'+fiscal),secondPlan=h.data.Plans.find(row=>row.operationId===second.p.operationId).manifest;
  for(const key of ['serviceIncome','supplyIncome','careIncome','operatingExpense'])assert.equal(secondPlan.financialExpectation.opening[key],0,'Only fiscal-year earnings reset; previous balance-sheet opening remains');
  assert.notEqual(secondPlan.financialExpectation.opening.operatingBank,100000);
  const secondProof=h.data.Evidence.at(-1).proof;for(const row of secondProof.financialBasis.filter(row=>['Payment','BillPayment','Deposit'].includes(row.entity)))for(const key of ['serviceIncome','supplyIncome','careIncome','operatingExpense'])assert.equal(row.postings[key],0);
  const posts=h.posts;assert.equal((await second.runtime.execute()).complete,true);assert.equal(h.posts,posts);assert.equal(h.data.Calendars[0].verifiedThrough,nextEnd);assert.deepEqual((await first.runtime.inspect()).financialMovements,firstProof);
  const item=[...h.records.values()].find(row=>row.entity==='Item'&&row.record.Type==='Service').record;item.IncomeAccountRef={value:'971'};
  assert.deepEqual(h.reportSources({fromDate:openingDate,throughDate:firstEnd}).reports.TrialBalance,priorSources.reports.TrialBalance,'Today’s item routing cannot relabel the simulated original accounting posting');
 }
});
test('cross-month preparation leaves no candidate/run or accounting POST, and shared mappings retain one physical comparison',{timeout:120000},async()=>{
 const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true,sharedIncomeAccount:true,originalSdkTransport:true});await h.publish();
 const saved=await run(h,'2026-10-08','earnings-shared-physical-account'),before={posts:h.posts,runs:h.data.Runs.length,candidates:h.data.Candidates.length};
 await assert.rejects(h.service.prepare(h.user,{requestKey:'earnings-cross-month-unsent',throughDate:'2026-11-01'}),/one calendar month/);
 assert.equal(h.posts,before.posts);assert.equal(h.data.Runs.length,before.runs);assert.equal(h.data.Candidates.length,before.candidates);
 assert.equal(saved.visible.checks.length,6);const shared=saved.visible.checks.find(row=>row.roles.length===3);assert.equal(shared.roles.length,3);assert.equal(shared.differenceCents,0);
});

test('installed SDK wrong income posting leaves cash and total income passing but blocks the calendar until corrected without reposting',{timeout:120000},async()=>{
 const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true,originalSdkTransport:true});
 assert.equal(h.client.oauthClient.makeApiCall,require('intuit-oauth').prototype.makeApiCall);await h.publish();
 const prepared=await h.service.prepare(h.user,{requestKey:'earnings-wrong-income-0001',throughDate:'2026-10-08'});await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash});
 let misposted=null;h.afterPost=async(opts,record)=>{
  if(misposted||!opts.url.endsWith('/invoice'))return;
  const postings=h.earningsPostings.get(record.Id);if(!postings?.some(row=>row.accountId===h.mappings.serviceIncome))return;
  misposted={id:record.Id,original:structuredClone(postings)};
  h.earningsPostings.set(record.Id,postings.map(row=>row.accountId===h.mappings.serviceIncome?{...row,accountId:'971'}:row));
 };
 const runtime=h.runtime(prepared.operationId),failed=await runtime.execute();assert.ok(misposted);assert.equal(failed.complete,false);assert.equal(failed.state,'awaiting-evidence');assert.equal(h.data.Calendars[0].verifiedThrough,null);assert.equal(h.data.Runs[0].verificationCandidateHash,null);
 const evidence=h.data.Evidence.at(-1),assertions=evidence.proof.assertions,visible=(await runtime.inspect()).financialMovements;
 assert.equal(evidence.proof.complete,false);assert.equal(assertions.find(row=>row.key==='profit-and-loss').status,'passed');
 for(const key of ['trial-balance','balance-sheet','receivables','payables'])assert.equal(assertions.find(row=>row.key===key).status,'passed');
 assert.equal(visible.status,'failed');assert.equal(visible.complete,false);assert.equal(visible.checks.find(row=>row.key==='serviceIncome').differenceCents,misposted.original.filter(row=>row.accountId===h.mappings.serviceIncome).reduce((sum,row)=>sum+row.amountCents,0));
 assert.ok(visible.checks.filter(row=>row.key!=='serviceIncome').every(row=>row.status==='passed'));for(const key of KEYS)assert.equal(visible.checks.find(row=>row.key===key).differenceCents,0);
 const posts=h.posts;h.earningsPostings.set(misposted.id,misposted.original);assert.equal((await runtime.execute()).complete,true);assert.equal(h.posts,posts);assert.equal(h.data.Calendars[0].verifiedThrough,'2026-10-08');assert.equal(h.data.Evidence.length,2);assert.equal(h.data.Evidence[0].proof.complete,false);assert.equal((await runtime.inspect()).financialMovements.status,'passed');
 const saved=h.data.Evidence.at(-1),original=structuredClone(saved),basis=saved.proof.financialBasis.find(row=>row.postings.serviceIncome<0);assert.ok(basis);basis.postings.serviceIncome--;saved.evidenceHash=hash(saved.proof);assert.equal((await runtime.inspect()).financialMovements.status,'integrity-unavailable');Object.keys(saved).forEach(key=>delete saved[key]);Object.assign(saved,original);assert.equal((await runtime.inspect()).financialMovements.status,'passed');
});
