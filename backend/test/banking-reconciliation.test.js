'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
require('../src/config').qbo.environment='sandbox';
const {fixture}=require('./helpers/period-close-fixture');
const C=require('../src/modules/period-close-contract');
const {hash}=require('../src/modules/business-calendar');
const {validatePeriodDecision}=require('../src/modules/period-close-proof');
const {createBusinessAgentSync,ENTITIES,recordSummary}=require('../src/modules/business-agent-sync');
const {situations}=require('../src/modules/business-weekly-breadth');
const money=c=>(c/100).toFixed(2);
function version2(request,accounts){request.version=2;for(const row of request.bankChecks){const a=accounts.find(a=>a.id===row.accountId);row.currencyEvidence={currency:a.currency,reconciliationType:a.reconciliationType,homeCurrency:'CAD',statementHomeBalance:row.statementBalance,bookHomeBalance:row.bookBalance,homeReference:row.bookReference,confirmNoFxMovement:true,confirmMarksNotCompletion:true};}return request;}
test('account currency, cash counts and home values follow owner-reviewed evidence through service and retained proof',async()=>{
 const h=fixture();h.records.get('account:999').record.CurrencyRef.value='USD';
 h.records.set('account:998',{entity:'Account',record:{Id:'998',SyncToken:'0',Active:true,Name:'Fixture cash AUD',AccountType:'Bank',AccountSubType:'CashOnHand',CurrencyRef:{value:'AUD'}}});
 const request=version2(await h.make(),h.accountView.accounts),cash=request.bankChecks.find(r=>r.accountId==='998');cash.statementBalance=cash.bookBalance='5000.00';cash.currencyEvidence.statementHomeBalance='4365.58';cash.currencyEvidence.bookHomeBalance='4452.42';
 const value=await h.reviewInput(request),review=(await h.service.review(h.user,request)).review;assert.equal(review.readyToApply,true);const r=review.bankResults.find(r=>r.accountId==='998');assert.equal(r.reconciliationType,'cash-count');assert.equal(r.differenceCents,0);assert.equal(r.homeValuationDifferenceCents,8684);assert.equal(r.nativeMarksCountAsCompletion,false);
 const saved=await h.service.apply(h.user,value);assert.equal(h.data.Policies[0].periodControl.reconciledThrough,'2026-09-30');assert.ok(validatePeriodDecision(h.data.Audits.find(a=>String(a._id)===saved.id),require('./helpers/period-close-fixture').scope,require('./helpers/period-close-fixture').ownerId));assert.equal(h.posts,0);
});
test('currency/type spoofing, cash timing items and unconfirmed FX or feature marks cannot advance reconciliation',async()=>{
 const h=fixture(),request=version2(await h.make(),h.accountView.accounts),row=request.bankChecks[0];row.currencyEvidence.currency='USD';await assert.rejects(h.service.review(h.user,request),/currency or reconciliation/);row.currencyEvidence.currency='CAD';
 row.currencyEvidence.homeCurrency='USD';await assert.rejects(h.service.review(h.user,request),/home currency/);row.currencyEvidence.homeCurrency='CAD';
 for(const key of ['confirmNoFxMovement','confirmMarksNotCompletion']){row.currencyEvidence[key]=false;assert.equal((await h.service.review(h.user,request)).review.readyToApply,false);row.currencyEvidence[key]=true;}
 row.currencyEvidence.bookHomeBalance='999.00';await assert.rejects(h.service.review(h.user,request),/same native and home/);row.currencyEvidence.bookHomeBalance=row.bookBalance;
 h.records.get('account:'+row.accountId).record.AccountSubType='CashOnHand';const refreshed=version2(await h.make(),h.accountView.accounts),c=refreshed.bankChecks.find(r=>r.accountId===row.accountId);c.items=[{kind:'receipt',date:'2026-09-30',reference:'Not a physical count',amount:'1.00'}];await assert.rejects(h.service.review(h.user,refreshed),/Cash counts/);
});
function syncFixture(entities,existing={}){
 let state=structuredClone(existing);const rows=new Map(),requests=[];let responses=[];const clock=Date.parse('2026-11-01T04:00:00Z');const scope={environment:'sandbox',realmId:'123456',connectionId:'a'.repeat(24)};
 const Records={bulkWrite:async ops=>{for(const {updateOne:o}of ops)rows.set(o.filter.entity+':'+o.filter.qboId,{...o.update.$setOnInsert,...o.update.$set});},updateMany:async()=>{},aggregate:()=>({option:async()=>entities.map(e=>({_id:e,records:[...rows.values()].filter(r=>r.entity===e&&!r.deleted).length}))}),find:()=>{const q={select:()=>q,sort:()=>q,limit:()=>q,maxTimeMS:()=>q,lean:async()=>[]};return q;}};
 const respond=async(name,control)=>{await control.beforeAttempt();requests.push(name);const r=responses.shift();if(r instanceof Error)throw r;if(!r)throw Error('Missing offline response');return structuredClone(r);};
 const options={scope,Records,entities,homeCurrency:'CAD',now:()=>clock,assertClient:()=>{},authorize:async()=>{},loadState:async()=>structuredClone(state),saveState:async s=>{state=structuredClone(s);},client:{query:(sql,c)=>respond(sql,c),apiCall:(m,ep,b,r,a,c)=>{assert.equal(m,'GET');return respond(ep,c);}}};
 return{rows,requests,setResponses:r=>{responses=r;},state:()=>structuredClone(state),sync:()=>createBusinessAgentSync(options),query:(entity,rs)=>({QueryResponse:{[entity]:rs,startPosition:1,maxResults:rs.length},time:new Date(clock).toISOString()}),cdc:(entity,rs)=>({CDCResponse:[{QueryResponse:[{[entity]:rs,startPosition:1,maxResults:rs.length}]}],time:new Date(clock).toISOString()})};
}
test('new bank source backfill survives a restart, preserves canonical identities, catches up CDC and does not rerun full queries',async()=>{
 assert.ok(ENTITIES.includes('CreditCardPayment'));assert.ok(ENTITIES.includes('TaxPayment'));assert.ok(!ENTITIES.includes('CreditCardCredit'),'native card credits are Purchase.Credit, not another entity');
 const h=syncFixture(['CreditCardPayment']);h.setResponses([h.query('CreditCardPaymentTxn',[{Id:'483',Amount:100,TxnDate:'2026-05-18'}])]);await h.sync().tick({maxRequests:1});assert.equal(h.state().sources.CreditCardPayment.phase,'catchup');assert.equal(h.rows.get('CreditCardPayment:483').summary.amountCents,10000);
 h.setResponses([h.cdc('CreditCardPaymentTxn',[])]);assert.equal((await h.sync().tick({maxRequests:1})).status,'current');h.setResponses([]);await h.sync().tick({maxRequests:1});assert.equal(h.requests.filter(q=>q.startsWith('SELECT')).length,1);
 const t=syncFixture(['TaxPayment']);t.setResponses([t.query('TaxPayment',[{Id:'576',PaymentDate:'2026-09-22',PaymentAmount:0}]),t.cdc('TaxPayment',[])]);assert.equal((await t.sync().tick({maxRequests:2})).status,'current');assert.equal(t.rows.get('TaxPayment:576').summary.txnDate,'2026-09-22');assert.equal(t.rows.get('TaxPayment:576').summary.amountCents,0);
});
test('TaxPayment weekly and retained coverage use PaymentDate, not observation time or an absent TxnDate',()=>{
 const now=new Date('2026-09-23T12:00:00Z'),sources=Object.fromEntries(['TaxPayment','CreditCardPayment'].map(e=>[e,{phase:'incremental',status:'current',lastSuccessAt:now.toISOString()}]));
 const result=situations({sources,records:[{entity:'TaxPayment',qboId:'576',record:{Id:'576',PaymentDate:'2026-09-22',PaymentAmount:0}},{entity:'CreditCardPayment',qboId:'483',record:{Id:'483',TxnDate:'2026-05-18',Amount:100}}]},{now});
 assert.equal(result.rows.find(r=>r.key==='TaxPayment.recorded').recentCount,1);assert.equal(result.rows.find(r=>r.key==='CreditCardPayment.recorded').count,1);
});
test('offline replay of the real retained banking inventory through live service.review and source bootstrap', {skip:!process.env.BK1_REPLAY_FILE},async()=>{
 const real=JSON.parse(fs.readFileSync(process.env.BK1_REPLAY_FILE,'utf8')),a=real.audit,h=fixture();h.clock=Date.parse('2026-11-01T04:00:00Z');h.period={fromDate:'2026-10-01',throughDate:'2026-10-31'};const saveReport=h.manual.save;h.manual.save=(user,request)=>saveReport(user,{...request,observedOn:'2026-11-01'});
 for(const [k,v]of h.records)if(v.entity==='Account')h.records.delete(k);for(const r of real.accounts)h.records.set('account:'+r.Id,{entity:'Account',record:r});
 const request=version2(await h.make(),h.accountView.accounts);for(const row of request.bankChecks){row.observedOn='2026-11-01';const ac=a.accounts.find(r=>r.id===row.accountId);const ledger=a.ledger.filter(r=>r.accountId===row.accountId);row.statementBalance=row.bookBalance=money(ac.nativeBookBalanceCents);row.currencyEvidence.statementHomeBalance=row.currencyEvidence.bookHomeBalance=money(ledger.reduce((s,r)=>s+r.homeAmountCents,0));}
 const review=(await h.service.review(h.user,request)).review;assert.equal(review.bankResults.length,16);assert.equal(review.readyToApply,true);assert.equal(review.bankResults.filter(r=>r.reconciliationType==='cash-count').length,4);assert.ok(review.bankResults.every(r=>r.status==='passed'&&r.nativeMarksCountAsCompletion===false));
 assert.equal(review.bankResults.find(r=>r.accountId==='1150040002').bookCents,3000);const aud=review.bankResults.find(r=>r.accountId==='68');assert.equal(aud.bookCents,500000);assert.equal(aud.bookHomeCents,445242);assert.equal(a.ledger.find(r=>r.accountId==='68'&&r.transactionId==='200').bankAccountAmountCents,0);
 assert.equal(a.ledger.filter(r=>r.status==='R').length,13);assert.equal(a.ledger.filter(r=>r.status==='C').length,20);const before=JSON.stringify(a.ledger);for(const row of request.bankChecks)row.confirmMatched=false;assert.equal((await h.service.review(h.user,request)).review.readyToApply,false);assert.equal(JSON.stringify(a.ledger),before);
 // Exact retained audit projections are wrapped in native response envelopes. Missing
 // source payload metadata is not invented; these prove parser/backfill identity/amounts.
 const cc=a.exceptions.creditCardPayment,hc=syncFixture(['CreditCardPayment'],real.sync);hc.setResponses([hc.query('CreditCardPaymentTxn',[{Id:cc.id,TxnDate:cc.date,Amount:cc.amountCents/100,BankAccountRef:{value:cc.bankId},CreditCardAccountRef:{value:cc.cardId}}]),hc.cdc('CreditCardPaymentTxn',[])]);assert.equal((await hc.sync().tick({maxRequests:2})).status,'current');assert.equal(hc.rows.get('CreditCardPayment:483').record.Amount,100);
 const taxes=a.ledger.filter(r=>r.type==='Sales Tax Payment').map(r=>({Id:r.transactionId,PaymentDate:r.date,PaymentAmount:Math.abs(r.bankAccountAmountCents)/100,Refund:r.bankAccountAmountCents>0}));assert.equal(taxes.length,13);const ht=syncFixture(['TaxPayment'],real.sync);ht.setResponses([ht.query('TaxPayment',taxes),ht.cdc('TaxPayment',[])]);assert.equal((await ht.sync().tick({maxRequests:2})).status,'current');assert.equal(ht.rows.size,13);assert.equal(h.posts,0);
 console.log('BK1 real replay: 130 accounts, 16 bank/card/cash, 3789 retained postings; USD 30, AUD 5000, FX-only CAD 86.84; 13 R / 20 C unchanged. No native completion claimed.');
});

test('fresh legacy closes are rejected while exact retained v1 decisions remain readable and recoverable',async()=>{
 const h=fixture(),request=await h.make();const legacy=structuredClone(request);legacy.version=1;for(const row of legacy.bankChecks)delete row.currencyEvidence;const reads=h.events.length;await assert.rejects(h.service.review(h.user,legacy),/version 2/);assert.equal(h.events.length,reads);
 const saved=await h.service.apply(h.user,await h.reviewInput(request)),event=h.data.Audits.find(r=>String(r._id)===saved.id),p=event.afterState.payload,s=p.observations;
 s.version=1;s.accounts=s.accounts.map(({subtype,reconciliationType,...a})=>a);delete s.preferences.homeCurrency;s.accountInventoryHash=hash(s.accounts);const {sourceHash,...source}=s;s.sourceHash=hash(source);
 p.input.request.version=1;for(const row of p.input.request.bankChecks)delete row.currencyEvidence;p.input.request.accountInventoryHash=s.accountInventoryHash;p.review.requestHash=hash(p.input.request);p.review.qbo.accountInventoryHash=s.accountInventoryHash;p.review.bankResults=C.bankResults(p.input.request,s.accounts.filter(a=>['Bank','Credit Card'].includes(a.type)));p.input.reviewHash=hash(p.review);p.requestHash=hash(p.input);event.afterState.decisionHash=hash(p);
 assert.ok((await h.service.detail(h.user,saved.id)).decision);const before=h.events.length;const repeated=await h.service.apply(h.user,structuredClone(p.input));assert.equal(repeated.id,saved.id);assert.equal(repeated.reused,true);assert.equal(h.events.length,before);
});
test('legacy AI coverage reader accepts the native card-payment response alias and rejects double identities',async()=>{
 const {readSource}=require('../src/modules/coverage');const result=await readSource({query:async()=>({QueryResponse:{CreditCardPaymentTxn:[{Id:'483',TxnDate:'2026-05-18',Amount:100}]}})},'CreditCardPayment','2026-01-01');assert.equal(result.records.length,1);assert.equal(result.records[0].Id,'483');
 const duplicate=await readSource({query:async()=>({QueryResponse:{CreditCardPaymentTxn:[{Id:'483'}],CreditCardPayment:[{Id:'483'}]}})},'CreditCardPayment','2026-01-01');assert.ok(duplicate.error);
});
