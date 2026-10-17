'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,scope,now,clone}=require('./helpers/business-link-repair-fixture');
const {hash}=require('../src/modules/business-calendar');
const {accountCoverage,endpointFor}=require('../src/modules/business-link-repair-balances');
const {assertReportSources}=require('../src/modules/business-link-repair');
function omitted(){
 const h=fixture(),parent={Id:'9996',SyncToken:'0',Active:true,AccountType:'Income',CurrentBalance:0,CurrentBalanceWithSubAccounts:1000},child={Id:'9997',SyncToken:'0',Active:true,AccountType:'Income',ParentRef:{value:'9996'}};
 for(const s of h.plan.reports){s.accounts.push(clone(parent),clone(child));const{sourceHash,...raw}=s;s.sourceHash=hash(raw);}
 const report={Header:{Time:new Date(now).toISOString(),ReportName:'GeneralLedger',ReportBasis:'Accrual',Currency:'CAD',StartPeriod:'1900-01-01',EndPeriod:h.plan.currentDate,Option:[{Name:'NoReportData',Value:'true'}]},Columns:{Column:['tx_date','txn_type','doc_num','name','memo','split_acc','subt_nat_amount_home_nt','rbal_nat_amount_home_nt'].map((ColType,i)=>({ColTitle:['Date','Transaction Type','#','Name','Memo/Description','Split','Amount','Balance'][i],ColType}))},Rows:{}};
 const raw={version:1,kind:'exact-parent-ledger-no-data',scope,accountId:parent.Id,accountDefinitionHash:hash(parent),endpoint:endpointFor(parent.Id,h.plan.currentDate),reportHash:hash(report),observedAt:new Date(now).toISOString(),report};h.plan.parentLedgers=[{...raw,evidenceHash:hash(raw)}];return h;
}
const resign=p=>{p.reportHash=hash(p.report);const{evidenceHash,...raw}=p;p.evidenceHash=hash(raw);};
test('omitted parent proof covers direct postings explicitly without asserting its child-inclusive balance',()=>{
 const h=omitted(),result=assertReportSources(h.plan,h.plan.reports,h.plan.reports,now,true);
 assert.equal(result[0].accountCount,h.plan.reports[0].accounts.length);assert.equal(result[0].allAccountDeltaCents,0);assert.equal(result[0].parentRollupBalancesAsserted,false);assert.deepEqual(result[0].accountBasis.find(x=>x.id==='9996'),{id:'9996',basis:'exact-parent-ledger-no-data'});
 assert.equal(result[0].omittedParentDirectPostings.before[0].noDirectPostings,true);assert.equal(accountCoverage(h.plan.reports[0],h.plan.parentLedgers,h.plan.currentDate,now).directBalances['9996'],undefined);
});
test('missing, extra, duplicate, wrong-account, scope and stale parent proofs never become zeros',()=>{
 for(const mutate of [h=>h.plan.parentLedgers=[],h=>h.plan.parentLedgers.push(clone(h.plan.parentLedgers[0])),h=>h.plan.parentLedgers[0].accountId='9997',h=>h.plan.parentLedgers[0].scope={...scope,realmId:'456'},h=>h.plan.parentLedgers[0].observedAt=new Date(now-300001).toISOString(),h=>h.plan.parentLedgers[0].endpoint+='&class=1',h=>h.plan.parentLedgers[0].accountDefinitionHash=hash('changed')]){const h=omitted();mutate(h);for(const p of h.plan.parentLedgers)resign(p);assert.throws(()=>assertReportSources(h.plan,h.plan.reports,h.plan.reports,now,true));}
});
test('populated, warning, balance-summary and alternate empty row containers are refused despite NoData flag',()=>{
 for(const mutate of [r=>r.Rows=[],r=>r.Rows='',r=>r.Rows={Row:[]},r=>r.Rows={Row:[{Summary:{ColData:[{value:'0'}]}}]},r=>r.Warning='truncated',r=>r.Header.Option.push({Name:'Truncated',Value:'true'}),r=>r.Header.Option[0].Value=true,r=>r.Header.Option[0].Value='false',r=>r.Header.StartPeriod='2023-01-01',r=>r.Header.EndPeriod='2026-10-05',r=>r.Header.ReportBasis='Cash',r=>r.Header.Currency='USD',r=>r.Columns.Column.pop(),r=>r.Columns.Column[0].ColType='unknown',r=>r.Header.BeginningBalance='0',r=>r.Columns.Warning='truncated',r=>r.Columns.Column[0].ColTitle='Unable to display more data']){const h=omitted();mutate(h.plan.parentLedgers[0].report);resign(h.plan.parentLedgers[0]);assert.throws(()=>assertReportSources(h.plan,h.plan.reports,h.plan.reports,now,true));}
});
test('native reported/leaf validation remains strict and changed complete definitions fail',()=>{
 const h=omitted(),after=clone(h.plan.reports);after[0].accounts[0].SyncToken='99';const{sourceHash,...raw}=after[0];after[0].sourceHash=hash(raw);assert.throws(()=>assertReportSources(h.plan,h.plan.reports,after,now,false,clone(h.plan.parentLedgers)));
});

test('omitted parent adapter reads through original QBOClient with native control contract and exact fenced source',async()=>{
 const h=omitted(),calls=[],fence={scope,operationId:'b'.repeat(24),revision:7,unresolved:null},proof=h.plan.parentLedgers[0];
 h.client.oauthClient.makeApiCall=async opts=>{calls.push(opts);return{status:200,json:clone(proof.report)};};
 const actor={actorId:h.ownerId,ownerId:h.ownerId},access={authorize:async()=>actor,resolveClient:async()=>h.client};
 const reader=require('../src/modules/business-link-repair-balances').createOmittedParentLedgerReader({access,readFence:async()=>clone(fence),now:()=>now});
 const result=await reader(h.plan.reports[1],h.plan.currentDate);assert.equal(result.length,1);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(new URL(calls[0].url).pathname,'/v3/company/123/reports/GeneralLedger');assert.equal(new URL(calls[0].url).searchParams.get('account'),'9996');assert.equal(result[0].accountId,'9996');
});
